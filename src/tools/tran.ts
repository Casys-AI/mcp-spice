/**
 * spice_simulate_tran — transient simulation, reduced statistics output.
 *
 * The caller supplies a SPICE netlist (circuit only, no .control block),
 * transient parameters (tstep_s, tstop_s), and requested node and/or
 * voltage-source branch observables. The server writes the .control block with
 * a `tran` command and `wrdata` directed at a server-controlled temp file; the
 * time-series is never returned to the caller. Instead, reduced extrema and
 * final summaries are computed from the private output.
 *
 * Security: same netlist validation as spice_simulate_op.
 *
 * The tool does NOT interpret results or declare specification compliance.
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
import { runNgspiceTran } from "../api/ngspice.ts";
import { SpiceToolError } from "../api/tool-error.ts";
import type { SpiceTool } from "./types.ts";

const TOOL_NAME = "spice_simulate_tran";

const NOT_CHECKED = [
  "Temperature: simulation runs at TNOM=27°C unless the netlist overrides .TEMP or .OPTIONS TNOM.",
  "Adaptive time step: ngspice uses internal step control; the actual n_points is not tstop_s / tstep_s.",
  "Initial conditions: the server-owned transient command does not expose UIC; ngspice computes a DC operating point before the transient.",
  "Monte Carlo / worst-case analysis is not performed.",
  "Non-linear component models require .model definitions embedded in the netlist; no model library is provided by this server.",
  "Branch currents are extracted only for voltage sources explicitly named in branch_sources; raw ngspice i(Vsource) is positive into the source positive terminal.",
  "For min/max ties, the earliest sampled time is returned. The complete time series is never returned; only reduced statistics are returned.",
];

const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["netlist_sha256", "tstep_s", "tstop_s"],
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
        "Supply circuit and inline model definitions. A .tran directive may be " +
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
    tstep_s: {
      type: "number",
      description: "Suggested time step in seconds (e.g. 1e-5 for 10 µs). " +
        "ngspice uses this as a hint; the actual step is adaptive.",
    },
    tstop_s: {
      type: "number",
      description: "Stop time in seconds (e.g. 6e-3 for 6 ms).",
    },
    nodes: {
      type: "array",
      minItems: 1,
      maxItems: MAX_OBSERVABLES_PER_KIND,
      items: { type: "string" },
      description:
        'Optional node names whose transient statistics are requested (e.g. ["out", "vdd"]). ' +
        "Use bare names without the v() wrapper. Pass at least one of nodes or branch_sources.",
    },
    branch_sources: {
      type: "array",
      minItems: 1,
      maxItems: MAX_OBSERVABLES_PER_KIND,
      items: { type: "string" },
      description:
        'Optional voltage-source names whose raw i(Vsource) transient summaries are requested (e.g. ["Vin"]). ' +
        "Positive current is into the source positive terminal. Pass at least one of nodes or branch_sources.",
    },
    timeout_s: {
      type: "number",
      minimum: MIN_TIMEOUT_SECONDS,
      maximum: MAX_TIMEOUT_SECONDS,
      description: "Simulation timeout in seconds (default 30, max 300).",
    },
  },
};

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "node_stats",
    "branch_current_stats_a",
    "measurements",
    "simulation",
    "not_checked",
    "input_artifact",
  ],
  properties: {
    node_stats: {
      type: "object",
      description:
        "Node name → reduced voltage statistics over the full transient window. " +
        "Extrema timestamps use seconds and resolve equal values to the earliest sample.",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: [
          "min_v",
          "max_v",
          "final_v",
          "min_at_s",
          "max_at_s",
          "final_at_s",
        ],
        properties: {
          min_v: { type: "number", description: "Minimum voltage in volts." },
          max_v: { type: "number", description: "Maximum voltage in volts." },
          final_v: { type: "number", description: "Final sampled voltage in volts." },
          min_at_s: {
            type: "number",
            description: "Earliest minimum time in seconds.",
          },
          max_at_s: {
            type: "number",
            description: "Earliest maximum time in seconds.",
          },
          final_at_s: { type: "number", description: "Final sample time in seconds." },
        },
      },
    },
    branch_current_stats_a: {
      type: "object",
      description:
        "Voltage-source name → reduced raw ngspice i(Vsource) current statistics in amperes. " +
        "Positive current is into the source positive terminal; a delivering source normally appears negative. " +
        "Empty when branch_sources is omitted.",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: [
          "min_a",
          "max_a",
          "final_a",
          "min_at_s",
          "max_at_s",
          "final_at_s",
        ],
        properties: {
          min_a: { type: "number", description: "Minimum current in amperes." },
          max_a: { type: "number", description: "Maximum current in amperes." },
          final_a: { type: "number", description: "Final sampled current in amperes." },
          min_at_s: {
            type: "number",
            description: "Earliest minimum time in seconds.",
          },
          max_at_s: {
            type: "number",
            description: "Earliest maximum time in seconds.",
          },
          final_at_s: { type: "number", description: "Final sample time in seconds." },
        },
      },
    },
    measurements: {
      type: "object",
      description:
        "Cross-tool alias: each key maps to {value: final_v} for the node. " +
        "Use node_stats for full min/max/final detail.",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: {
          value: { type: "number" },
        },
      },
    },
    simulation: {
      type: "object",
      additionalProperties: false,
      required: ["n_points", "tstop_s"],
      description: "Simulation metadata.",
      properties: {
        n_points: {
          type: "number",
          description: "Total number of time-domain data points written by ngspice " +
            "(adaptive step; typically more than tstop_s / tstep_s).",
        },
        tstop_s: {
          type: "number",
          description: "Stop time as supplied to the tool (seconds).",
        },
      },
    },
    not_checked: {
      type: "array",
      items: { type: "string" },
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

export const tranTool: SpiceTool = {
  name: TOOL_NAME,
  description: "Run an ngspice transient (.tran) simulation on a caller-supplied " +
    "circuit netlist (no .control block) and return requested node-voltage and " +
    "voltage-source-current statistics (min, max, final plus timestamps) over " +
    "the full transient window. The full time series is never returned — only " +
    "reduced statistics. " +
    "The server writes the .control block and validates the netlist for " +
    "forbidden directives before running. " +
    "The tool measures; it does not declare circuit compliance.",
  category: "simulation",
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
  annotations: {
    readOnlyHint: false, // writes to a server-controlled temp dir
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args: Record<string, unknown>) => {
    const tstep_s = requirePositiveFinite(args["tstep_s"], "tstep_s");
    const tstop_s = requirePositiveFinite(args["tstop_s"], "tstop_s");
    if (tstep_s >= tstop_s) {
      throw new SpiceToolError(
        "invalid_transient_window",
        { toolName: TOOL_NAME, tstep_s, tstop_s },
        "Pass tstep_s smaller than tstop_s, both in seconds.",
      );
    }

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
    for (const node of nodes) validateNodeName(node, TOOL_NAME);
    for (const source of branchSources) validateSourceName(source, TOOL_NAME);

    const timeoutMs = timeoutMsFromArgs(args["timeout_s"], TOOL_NAME);

    // 1. Snapshot from path (legacy) or content-addressed store (submit).
    const snapshot = await resolveSimulationNetlist(TOOL_NAME, args);

    try {
      // 2. Read and validate security.
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
        analysis_kind: "tran",
        netlist_sha256: admitted.sha256,
        normalized_request: {
          tstep_s,
          tstop_s,
          nodes: normalizeSelectors(nodes),
          branch_sources: normalizeSelectors(branchSources),
          timeout_s: timeoutMs / 1000,
        },
        execute: async () => {
          // The acknowledgement is durable before this subprocess starts.
          const result = await runNgspiceTran(
            circuitContent,
            tstep_s,
            tstop_s,
            nodes,
            timeoutMs,
            branchSources,
          );
          const measurements: Record<string, { value: number }> = {};
          for (const [node, stats] of Object.entries(result.nodeStats)) {
            measurements[node] = { value: stats.final_v };
          }
          return {
            node_stats: result.nodeStats,
            branch_current_stats_a: result.branchCurrentStats,
            measurements,
            simulation: {
              n_points: result.nPoints,
              tstop_s,
            },
            not_checked: NOT_CHECKED,
            input_artifact: {
              sha256: admitted.sha256,
              bytes: admitted.bytes,
            },
          };
        },
      });

      return {
        content:
          `[${TOOL_NAME}] sha256:${snapshot.artifact.sha256}: reduced transient summaries; full time series not returned`,
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

function requirePositiveFinite(raw: unknown, field: "tstep_s" | "tstop_s"): number {
  if (typeof raw !== "number" || !isFinite(raw) || raw <= 0) {
    throw new SpiceToolError(
      `invalid_${field}`,
      { toolName: TOOL_NAME, [field]: raw },
      `Pass ${field} as a positive finite number of seconds.`,
    );
  }
  return raw;
}

function readNameList(
  raw: unknown,
  field: "nodes" | "branch_sources",
  itemLabel: "node" | "source",
): string[] {
  if (raw === undefined || raw === null) return [];
  if (
    !Array.isArray(raw) || raw.length === 0 || raw.length > MAX_OBSERVABLES_PER_KIND
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
