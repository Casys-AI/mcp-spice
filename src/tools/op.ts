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
  validateNetlistSecurity,
  validateNodeName,
  validateSourceName,
} from "../api/netlist-security.ts";
import { runNgspiceOp } from "../api/ngspice.ts";
import type { SpiceTool } from "./types.ts";

const TOOL_NAME = "spice_simulate_op";

const NOT_CHECKED = [
  "Temperature: simulation runs at TNOM=27°C unless the netlist overrides .TEMP or .OPTIONS TNOM.",
  "Convergence: ngspice uses default DC tolerances (ABSTOL=1e-12, RELTOL=1e-3); divergent circuits raise SpiceError.",
  "Sweep: this tool returns a single .op point; DC source sweeps are not exposed by this server.",
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
      items: { type: "string" },
      description:
        'Node names whose DC voltages are requested (e.g. ["out", "vdd"]). ' +
        "Use bare names as they appear in the netlist, without the v() wrapper. " +
        'The ground node is "0". Omit when only branch_sources is requested.',
    },
    branch_sources: {
      type: "array",
      minItems: 1,
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
      description: "Simulation timeout in seconds (default 30, max 300).",
    },
  },
};

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "node_voltages",
    "branch_currents_a",
    "measurements",
    "not_checked",
    "input_artifact",
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
  },
};

function readNameList(
  raw: unknown,
  field: "nodes" | "branch_sources",
  itemLabel: string,
): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new TypeError(
      `[${TOOL_NAME}] ${field} must be an array of ${itemLabel} names.`,
    );
  }
  return raw.map((item) => {
    if (typeof item !== "string") {
      throw new TypeError(
        `[${TOOL_NAME}] Each ${itemLabel} name must be a string.`,
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
  outputSchema: OUTPUT_SCHEMA,
  annotations: {
    readOnlyHint: false, // writes to a server-controlled temp dir during simulation
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args: Record<string, unknown>) => {
    const nodes = readNameList(args["nodes"], "nodes", "node");
    const branchSources = readNameList(
      args["branch_sources"],
      "branch_sources",
      "source",
    );
    if (nodes.length === 0 && branchSources.length === 0) {
      throw new TypeError(
        `[${TOOL_NAME}] At least one of nodes or branch_sources must be a ` +
          "non-empty array.",
      );
    }
    for (const n of nodes) validateNodeName(n, TOOL_NAME);
    for (const s of branchSources) validateSourceName(s, TOOL_NAME);

    const rawTimeout = args["timeout_s"];
    const timeoutMs = typeof rawTimeout === "number"
      ? Math.min(Math.max(rawTimeout, 1), 300) * 1000
      : 30_000;

    // 1. Snapshot from path (legacy) or content-addressed store (submit).
    const snapshot = await resolveSimulationNetlist(TOOL_NAME, args);

    try {
      // 2. Read and validate security BEFORE subprocess launch.
      const circuitContent = await Deno.readTextFile(snapshot.artifact.path);
      validateNetlistSecurity(circuitContent, TOOL_NAME);

      // 3. Run the simulation (server builds .control block).
      const result = await runNgspiceOp(
        circuitContent,
        nodes,
        timeoutMs,
        branchSources,
      );

      // 4. Build structured output. measurements stay voltage-only.
      const node_voltages = result.nodeVoltages;
      const branch_currents_a = result.branchCurrents;
      const measurements: Record<string, { value: number }> = {};
      for (const [k, v] of Object.entries(node_voltages)) {
        measurements[k] = { value: v };
      }

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
          node_voltages,
          branch_currents_a,
          measurements,
          not_checked: NOT_CHECKED,
          input_artifact: {
            sha256: snapshot.artifact.sha256,
            bytes: snapshot.artifact.bytes,
            source_path: snapshot.artifact.sourcePath,
          },
        },
      };
    } finally {
      await snapshot.cleanup();
    }
  },
};
