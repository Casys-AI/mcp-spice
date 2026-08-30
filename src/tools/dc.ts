/**
 * spice_simulate_dc — bounded one-dimensional DC source sweep.
 *
 * The caller supplies a circuit-only netlist, one independent voltage source
 * to sweep, explicit voltage bounds, and requested node and/or source-current
 * observables. The server owns the `dc` and `wrdata` commands. It returns
 * reduced extrema/final values only: the full transfer curve stays private and
 * is deleted with the server-controlled temporary directory.
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
import {
  estimateDcSweepPoints,
  MAX_DC_SWEEP_POINTS,
  runNgspiceDc,
} from "../api/ngspice.ts";
import { SpiceToolError } from "../api/tool-error.ts";
import type { SpiceTool } from "./types.ts";

const TOOL_NAME = "spice_simulate_dc";

const NOT_CHECKED = [
  "This is a single, server-owned DC sweep over one explicitly named independent voltage source; it is not an AC, noise, Monte Carlo, or worst-case analysis.",
  "The full DC transfer curve is not returned. Only reduced min/max/final summaries and their swept-source positions are returned.",
  "For min/max ties, the first sampled source position is returned.",
  "Branch currents are extracted only for voltage sources explicitly named in branch_sources; raw ngspice i(Vsource) is positive into the source positive terminal.",
  "Non-linear component models require inline .model definitions in the netlist; no model library is provided by this server.",
];

const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "netlist_sha256",
    "sweep_source",
    "start_v",
    "stop_v",
    "step_v",
  ],
  anyOf: [
    { required: ["nodes"] },
    { required: ["branch_sources"] },
  ],
  properties: {
    netlist_path: {
      type: "string",
      description: "Legacy absolute path to a circuit-only SPICE netlist. " +
        "Optional when using an admitted netlist_sha256 (and optional netlist_uri). " +
        "Do not pass .control, .include, .lib, .shell, or absolute paths inside the netlist.",
    },
    netlist_uri: {
      type: "string",
      description:
        "Content-addressed URI returned by ngspice_netlist_submit, exclusive with netlist_path.",
    },
    netlist_sha256: {
      type: "string",
      description:
        "64-character SHA-256 of the admitted or legacy snapshot netlist bytes.",
    },
    sweep_source: {
      type: "string",
      description:
        "Name of the independent voltage source driven by the server-owned DC command (for example, Vin).",
    },
    start_v: {
      type: "number",
      description: "Sweep start voltage in volts.",
    },
    stop_v: {
      type: "number",
      description: "Sweep stop voltage in volts. step_v must move toward this value.",
    },
    step_v: {
      type: "number",
      description:
        `Non-zero voltage increment in volts. The resulting sweep is capped at ${MAX_DC_SWEEP_POINTS} internal points.`,
    },
    nodes: {
      type: "array",
      minItems: 1,
      maxItems: MAX_OBSERVABLES_PER_KIND,
      items: { type: "string" },
      description:
        "Optional bare node names whose voltage summaries are requested. Pass at least one of nodes or branch_sources.",
    },
    branch_sources: {
      type: "array",
      minItems: 1,
      maxItems: MAX_OBSERVABLES_PER_KIND,
      items: { type: "string" },
      description:
        "Optional voltage-source names whose raw i(Vsource) current summaries are requested in amperes. Pass at least one of nodes or branch_sources.",
    },
    timeout_s: {
      type: "number",
      minimum: MIN_TIMEOUT_SECONDS,
      maximum: MAX_TIMEOUT_SECONDS,
      description: "Simulation timeout in seconds (default 30, max 300).",
    },
  },
};

export const DC_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "node_stats",
    "branch_current_stats_a",
    "measurements",
    "sweep",
    "not_checked",
    "input_artifact",
    "documentary_receipt",
  ],
  properties: {
    node_stats: {
      type: "object",
      description:
        "Node name → reduced voltage statistics across the DC sweep. Positions are swept-source voltage in volts.",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: [
          "min_v",
          "max_v",
          "final_v",
          "min_at_source_v",
          "max_at_source_v",
          "final_at_source_v",
        ],
        properties: {
          min_v: { type: "number", description: "Minimum voltage in volts." },
          max_v: { type: "number", description: "Maximum voltage in volts." },
          final_v: { type: "number", description: "Final sampled voltage in volts." },
          min_at_source_v: {
            type: "number",
            description: "First sampled source voltage at the minimum, in volts.",
          },
          max_at_source_v: {
            type: "number",
            description: "First sampled source voltage at the maximum, in volts.",
          },
          final_at_source_v: {
            type: "number",
            description: "Source voltage at the final sample, in volts.",
          },
        },
      },
    },
    branch_current_stats_a: {
      type: "object",
      description:
        "Voltage-source name → reduced raw i(Vsource) current statistics in amperes. Positive is into the source positive terminal; a delivering source normally appears negative.",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: [
          "min_a",
          "max_a",
          "final_a",
          "min_at_source_v",
          "max_at_source_v",
          "final_at_source_v",
        ],
        properties: {
          min_a: { type: "number", description: "Minimum current in amperes." },
          max_a: { type: "number", description: "Maximum current in amperes." },
          final_a: { type: "number", description: "Final sampled current in amperes." },
          min_at_source_v: {
            type: "number",
            description: "First sampled source voltage at the minimum, in volts.",
          },
          max_at_source_v: {
            type: "number",
            description: "First sampled source voltage at the maximum, in volts.",
          },
          final_at_source_v: {
            type: "number",
            description: "Source voltage at the final sample, in volts.",
          },
        },
      },
    },
    measurements: {
      type: "object",
      description:
        "Voltage-only alias of each node's final_v. Branch currents are intentionally kept separate by units.",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: {
          value: { type: "number" },
        },
      },
    },
    sweep: {
      type: "object",
      additionalProperties: false,
      required: ["source", "start_v", "stop_v", "step_v", "n_points", "max_points"],
      properties: {
        source: { type: "string", description: "Swept voltage-source name." },
        start_v: { type: "number", description: "Requested start voltage in volts." },
        stop_v: { type: "number", description: "Requested stop voltage in volts." },
        step_v: { type: "number", description: "Requested source increment in volts." },
        n_points: {
          type: "number",
          description: "Actual ngspice sweep points used for the reduced result.",
        },
        max_points: {
          type: "number",
          description: "Server-enforced upper bound on internal sweep points.",
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

export const dcTool: SpiceTool = {
  name: TOOL_NAME,
  description:
    "Run a bounded ngspice DC sweep over one named independent voltage source and return reduced voltage/current extrema and final values. The server owns the DC command and never returns a raw transfer curve. Pass at least one of nodes or branch_sources. The tool measures; it does not declare circuit compliance.",
  category: "simulation",
  inputSchema: INPUT_SCHEMA,
  outputSchema: DC_OUTPUT_SCHEMA,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args: Record<string, unknown>) => {
    const sweepSource = requireSource(args["sweep_source"]);
    const start_v = requireFinite(args["start_v"], "start_v");
    const stop_v = requireFinite(args["stop_v"], "stop_v");
    const step_v = requireFinite(args["step_v"], "step_v");
    validateDcSweep(start_v, stop_v, step_v);

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
    const snapshot = await resolveSimulationNetlist(TOOL_NAME, args);

    try {
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
        analysis_kind: "dc",
        netlist_sha256: admitted.sha256,
        normalized_request: {
          sweep_source: sweepSource,
          start_v,
          stop_v,
          step_v,
          nodes: normalizeSelectors(nodes),
          branch_sources: normalizeSelectors(branchSources),
          timeout_s: timeoutMs / 1000,
        },
        execute: async () => {
          // The acknowledgement is durable before this subprocess starts.
          const result = await runNgspiceDc(
            circuitContent,
            sweepSource,
            start_v,
            stop_v,
            step_v,
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
            sweep: {
              source: sweepSource,
              start_v,
              stop_v,
              step_v,
              n_points: result.nPoints,
              max_points: MAX_DC_SWEEP_POINTS,
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
          `[${TOOL_NAME}] sha256:${snapshot.artifact.sha256}: reduced DC sweep summaries; full transfer curve not returned`,
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

function requireSource(raw: unknown): string {
  if (
    typeof raw !== "string" || !raw.trim() ||
    raw[0]?.toLowerCase() !== "v"
  ) {
    throw new SpiceToolError(
      "invalid_sweep_source",
      { toolName: TOOL_NAME, sweep_source: raw },
      "Pass the name of one independent voltage source (a SPICE element name beginning with V) in sweep_source.",
    );
  }
  validateSourceName(raw, TOOL_NAME);
  return raw;
}

function requireFinite(
  raw: unknown,
  field: "start_v" | "stop_v" | "step_v",
): number {
  if (typeof raw !== "number" || !isFinite(raw)) {
    throw new SpiceToolError(
      `invalid_${field}`,
      { toolName: TOOL_NAME, [field]: raw },
      `Pass ${field} as a finite number of volts.`,
    );
  }
  return raw;
}

function validateDcSweep(start_v: number, stop_v: number, step_v: number): void {
  try {
    estimateDcSweepPoints(start_v, stop_v, step_v);
  } catch {
    const code = step_v === 0 || Math.sign(step_v) !== Math.sign(stop_v - start_v)
      ? "invalid_dc_sweep_direction"
      : "dc_sweep_too_large";
    throw new SpiceToolError(
      code,
      { toolName: TOOL_NAME, start_v, stop_v, step_v, maxPoints: MAX_DC_SWEEP_POINTS },
      `Pass a non-zero step_v toward stop_v and keep the sweep within ${MAX_DC_SWEEP_POINTS} points.`,
    );
  }
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
