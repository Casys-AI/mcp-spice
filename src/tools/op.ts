/**
 * spice_simulate_op — DC operating-point simulation.
 *
 * The caller supplies a SPICE netlist (circuit only, no .control block) and
 * at least one observable: node voltages (`nodes`) and/or voltage-source
 * branch currents (`branch_sources`). The server writes the .control block,
 * runs ngspice in batch mode, and returns the requested scalars.
 *
 * Security: the netlist is validated for forbidden directives before the
 * subprocess launches (see src/api/netlist-security.ts).  The SHA-256 of the
 * private snapshot is always returned and may optionally be asserted by the
 * caller upfront.
 *
 * The tool does NOT declare whether the voltages satisfy a specification;
 * that verdict belongs to the oracle (SysON constraint evaluation).
 */

import { resolveSimulationNetlist } from "../api/netlist-resolve.ts";
import {
  executeDocumentedSimulation,
  normalizeSelectors,
} from "../api/documented-simulation.ts";
import {
  MAX_OBSERVABLES_PER_KIND,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  timeoutMsFromArgs,
} from "../api/execution-budgets.ts";
import {
  validateNetlistSecurity,
  validateNodeName,
  validateSourceName,
} from "../api/netlist-security.ts";
import { getNetlistPath, putNetlistBytes } from "../api/netlist-store.ts";
import { runNgspiceOp } from "../api/ngspice.ts";
import { SpiceToolError } from "../api/tool-error.ts";
import { SPICE_OPERATING_POINT_URI } from "../ui/constants.ts";
import type { SpiceTool } from "./types.ts";

const TOOL_NAME = "spice_simulate_op";

const NOT_CHECKED = [
  "Temperature: simulation runs at TNOM=27°C unless the netlist overrides .TEMP or .OPTIONS TNOM.",
  "Convergence: ngspice uses default DC tolerances (ABSTOL=1e-12, RELTOL=1e-3); divergent circuits raise SpiceError.",
  "Sweep: this tool returns one .op point; use spice_simulate_dc for the separate bounded one-dimensional DC sweep.",
  "Monte Carlo / worst-case analysis is not performed.",
  "Non-linear component models require .model definitions embedded in the netlist; no model library is provided by this server.",
  "Unrequested branches are not extracted; only sources listed in branch_sources are returned as raw ngspice i(Vsource).",
  "ngspice current sign: i(Vsource) is positive into the voltage source positive terminal; a delivering source normally appears negative.",
];

const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["netlist_sha256"],
  anyOf: [
    { required: ["nodes"] },
    { required: ["branch_sources"] },
  ],
  properties: {
    netlist_path: {
      type: "string",
      description: "Absolute path to the SPICE netlist (.cir / .sp / .spi). " +
        "Optional when the netlist was admitted by ngspice_netlist_submit: " +
        "omit the path and pass the returned sha256 (and optionally uri). " +
        "Supply circuit and inline model definitions. A .op directive may be " +
        "present but is not required and does not select the server operation. " +
        "Do NOT include a .control block — the server writes it. " +
        "Forbidden: .control, .include, .lib, .shell, absolute paths.",
    },
    netlist_uri: {
      type: "string",
      description: "Content-addressed URI from ngspice_netlist_submit " +
        "(`spice-netlist:sha256:<hex>`). Exclusive with netlist_path.",
    },
    netlist_sha256: {
      type: "string",
      description: "64-char hex SHA-256 of the netlist bytes. " +
        "With netlist_path, the server snapshots the file and checks the digest. " +
        "Without netlist_path, the server loads the stored object at this hash.",
    },
    nodes: {
      type: "array",
      minItems: 1,
      maxItems: MAX_OBSERVABLES_PER_KIND,
      items: { type: "string" },
      description:
        'Node names whose DC voltages are requested (e.g. ["out", "vdd"]). ' +
        "Use bare names as they appear in the netlist, without the v() wrapper. " +
        'The ground node is "0". Omit when only branch_sources is requested.',
    },
    branch_sources: {
      type: "array",
      minItems: 1,
      maxItems: MAX_OBSERVABLES_PER_KIND,
      items: { type: "string" },
      description:
        'Voltage-source names whose DC branch currents are requested (e.g. ["Vin"]). ' +
        "Use bare names as they appear in the netlist, without the i() wrapper. " +
        "Returned values are raw ngspice i(Vsource) in amperes: positive into " +
        "the voltage source positive terminal; a delivering source normally " +
        "appears negative.",
    },
    timeout_s: {
      type: "number",
      minimum: MIN_TIMEOUT_SECONDS,
      maximum: MAX_TIMEOUT_SECONDS,
      description: "Simulation timeout in seconds (default 30, max 300).",
    },
  },
};

export const OP_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "node_voltages",
    "branch_currents_a",
    "measurements",
    "not_checked",
    "input_artifact",
    "documentary_receipt",
  ],
  properties: {
    node_voltages: {
      type: "object",
      description:
        "Node name → voltage in volts, for each node in the `nodes` input array. " +
        "Empty object when nodes is omitted.",
      additionalProperties: { type: "number" },
    },
    branch_currents_a: {
      type: "object",
      description:
        "Voltage-source name (caller spelling) → DC branch current in amperes. " +
        "Raw ngspice i(Vsource): positive into the voltage source positive " +
        "terminal; a delivering source normally appears negative. " +
        "Empty object when branch_sources is omitted.",
      additionalProperties: { type: "number" },
    },
    measurements: {
      type: "object",
      description:
        "Voltage-only alias of node_voltages; present for cross-tool schema " +
        "uniformity. Contains the same key/value pairs wrapped in {value: number}. " +
        "Does not include branch currents.",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: {
          value: { type: "number" },
        },
      },
    },
    not_checked: {
      type: "array",
      items: { type: "string" },
      description:
        "Known limits of this simulation — the oracle must account for them.",
    },
    input_artifact: {
      type: "object",
      additionalProperties: false,
      required: ["sha256", "bytes", "source_path"],
      properties: {
        sha256: { type: "string" },
        bytes: { type: "number" },
        source_path: { type: "string" },
      },
    },
    documentary_receipt: {
      type: "object",
      description:
        "Documentary provider receipt reference. It is not Digital Thread product evidence or a requirement verdict.",
      additionalProperties: false,
      required: [
        "request_sha256",
        "dispatch_sha256",
        "receipt_sha256",
        "outcome_sha256",
        "execution_state",
        "documentary_only",
      ],
      properties: {
        request_sha256: { type: "string" },
        dispatch_sha256: { type: "string" },
        receipt_sha256: { type: "string" },
        outcome_sha256: { type: "string" },
        execution_state: { const: "succeeded" },
        documentary_only: { const: true },
      },
    },
  },
};

function readNameList(
  raw: unknown,
  field: "nodes" | "branch_sources",
  itemLabel: string,
): string[] {
  if (raw === undefined || raw === null) return [];
  if (
    !Array.isArray(raw) || raw.length === 0 ||
    raw.length > MAX_OBSERVABLES_PER_KIND
  ) {
    throw new SpiceToolError(
      `invalid_${field}`,
      { toolName: TOOL_NAME, [field]: raw, maxItems: MAX_OBSERVABLES_PER_KIND },
      `Pass ${field} as a non-empty array of at most ${MAX_OBSERVABLES_PER_KIND} ${itemLabel} names.`,
    );
  }
  return raw.map((item) => {
    if (typeof item !== "string") {
      throw new SpiceToolError(
        `invalid_${field}`,
        { toolName: TOOL_NAME, [field]: raw },
        `Pass ${field} as an array of ${itemLabel} name strings.`,
      );
    }
    return item;
  });
}

export const opTool: SpiceTool = {
  name: TOOL_NAME,
  description:
    "Run an ngspice DC operating-point (.op) simulation on a caller-supplied " +
    "circuit netlist (no .control block) and return requested node voltages " +
    "and optional voltage-source branch currents. " +
    "Pass at least one of nodes or branch_sources. " +
    "Branch currents are raw i(Vsource) in amperes, positive into the source " +
    "positive terminal; a delivering source normally appears negative. " +
    "The server writes the .control block and validates the netlist for " +
    "forbidden directives before running. " +
    "The tool measures; it does not declare whether the circuit meets a " +
    "specification — that verdict belongs to the oracle.",
  category: "simulation",
  inputSchema: INPUT_SCHEMA,
  outputSchema: OP_OUTPUT_SCHEMA,
  annotations: {
    readOnlyHint: false, // writes to a server-controlled temp dir during simulation
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: { ui: { resourceUri: SPICE_OPERATING_POINT_URI } },
  handler: async (args: Record<string, unknown>) => {
    const nodes = readNameList(args["nodes"], "nodes", "node");
    const branchSources = readNameList(
      args["branch_sources"],
      "branch_sources",
      "source",
    );
    if (nodes.length === 0 && branchSources.length === 0) {
      throw new SpiceToolError(
        "missing_observables",
        { toolName: TOOL_NAME },
        "Pass at least one node in nodes or voltage-source name in branch_sources.",
      );
    }
    for (const n of nodes) validateNodeName(n, TOOL_NAME);
    for (const s of branchSources) validateSourceName(s, TOOL_NAME);

    const timeoutMs = timeoutMsFromArgs(args["timeout_s"], TOOL_NAME);

    // 1. Snapshot from path (legacy) or content-addressed store (submit).
    const snapshot = await resolveSimulationNetlist(TOOL_NAME, args);

    try {
      // 2. Read and validate security BEFORE subprocess launch.
      const circuitContent = await Deno.readTextFile(snapshot.artifact.path);
      validateNetlistSecurity(circuitContent, TOOL_NAME);
      // A legacy path becomes durable content-addressed input before ACK.
      const admitted = await putNetlistBytes(
        new TextEncoder().encode(circuitContent),
        TOOL_NAME,
      );
      if (admitted.sha256 !== snapshot.artifact.sha256) {
        throw new SpiceToolError(
          "simulation_netlist_identity_mismatch",
          {
            snapshot_sha256: snapshot.artifact.sha256,
            admitted_sha256: admitted.sha256,
          },
          "Do not dispatch. The durable netlist copy does not match the private snapshot.",
        );
      }
      const durableSourcePath = await getNetlistPath(admitted.sha256, TOOL_NAME);

      const documented = await executeDocumentedSimulation({
        analysis_kind: "op",
        netlist_sha256: admitted.sha256,
        normalized_request: {
          nodes: normalizeSelectors(nodes),
          branch_sources: normalizeSelectors(branchSources),
          timeout_s: timeoutMs / 1000,
        },
        execute: async () => {
          // The acknowledgement is durable before this subprocess starts.
          const result = await runNgspiceOp(
            circuitContent,
            nodes,
            timeoutMs,
            branchSources,
          );
          const measurements: Record<string, { value: number }> = {};
          for (const [key, value] of Object.entries(result.nodeVoltages)) {
            measurements[key] = { value };
          }
          return {
            node_voltages: result.nodeVoltages,
            branch_currents_a: result.branchCurrents,
            measurements,
            not_checked: NOT_CHECKED,
            input_artifact: {
              sha256: admitted.sha256,
              bytes: admitted.bytes,
            },
          };
        },
      });

      const node_voltages = documented.result.node_voltages;
      const branch_currents_a = documented.result.branch_currents_a;

      const summaryParts = [
        ...nodes.map((n) => `${n}=${(node_voltages[n] ?? NaN).toExponential(4)} V`),
        ...branchSources.map((s) =>
          `${s}=${(branch_currents_a[s] ?? NaN).toExponential(4)} A`
        ),
      ];

      return {
        content: `[${TOOL_NAME}] sha256:${snapshot.artifact.sha256}: ${
          summaryParts.join(", ")
        }`,
        structuredContent: {
          ...documented.result,
          input_artifact: {
            ...documented.result.input_artifact,
            source_path: durableSourcePath,
          },
          documentary_receipt: documented.documentary_receipt,
        },
      };
    } finally {
      await snapshot.cleanup();
    }
  },
};
