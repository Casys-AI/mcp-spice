/**
 * spice_simulate_tran — transient simulation, reduced statistics output.
 *
 * The caller supplies a SPICE netlist (circuit only, no .control block),
 * transient parameters (tstep_s, tstop_s), and a list of node names.  The
 * server writes the .control block with a `tran` command and `wrdata` directed
 * at a server-controlled temp file; the time-series is never returned to the
 * caller.  Instead, per-node statistics (min, max, final) are computed from
 * the wrdata output and returned as a compact structured result.
 *
 * Security: same netlist validation as spice_simulate_op.
 *
 * The tool does NOT interpret results or declare specification compliance.
 */

import { snapshotNetlistArtifact } from "../api/netlist-artifact.ts";
import { validateNetlistSecurity } from "../api/netlist-security.ts";
import { runNgspiceTran } from "../api/ngspice.ts";
import type { SpiceTool } from "./types.ts";

const TOOL_NAME = "spice_simulate_tran";

const NOT_CHECKED = [
  "Temperature: simulation runs at TNOM=27°C unless the netlist overrides .TEMP or .OPTIONS TNOM.",
  "Adaptive time step: ngspice uses internal step control; the actual n_points is not tstop_s / tstep_s.",
  "Initial conditions: ngspice computes a DC operating point as initial condition unless the netlist specifies .IC or UIC.",
  "Monte Carlo / worst-case analysis is not performed.",
  "Non-linear component models require .model definitions embedded in the netlist; no model library is provided by this server.",
  "Branch currents are not returned; only node voltages are extracted.",
  "The complete time series is never returned; only min/max/final per node.",
];

const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["netlist_path", "netlist_sha256", "tstep_s", "tstop_s", "nodes"],
  properties: {
    netlist_path: {
      type: "string",
      description: "Absolute path to the SPICE netlist (.cir / .sp / .spi). " +
        "The netlist must contain only circuit elements and a .tran directive. " +
        "Do NOT include a .control block — the server writes it. " +
        "Forbidden: .control, .include, .lib, .shell, absolute paths.",
    },
    netlist_sha256: {
      type: "string",
      description: "64-char hex SHA-256 of the netlist file. " +
        "Raises NetlistArtifactError if the snapshot digest differs.",
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
      items: { type: "string" },
      description:
        'Node names whose transient statistics are requested (e.g. ["out", "vdd"]). ' +
        "Use bare names without the v() wrapper.",
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
    "node_stats",
    "measurements",
    "simulation",
    "not_checked",
    "input_artifact",
  ],
  properties: {
    node_stats: {
      type: "object",
      description: "Node name → {min_v, max_v, final_v} in volts, " +
        "computed over the full transient window.",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["min_v", "max_v", "final_v"],
        properties: {
          min_v: { type: "number" },
          max_v: { type: "number" },
          final_v: { type: "number" },
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
  },
};

export const tranTool: SpiceTool = {
  name: TOOL_NAME,
  description: "Run an ngspice transient (.tran) simulation on a caller-supplied " +
    "circuit netlist (no .control block) and return per-node statistics " +
    "(min, max, final voltage) over the full transient window. " +
    "The full time series is never returned — only reduced statistics. " +
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
    const netlistPath = args["netlist_path"];
    if (typeof netlistPath !== "string" || !netlistPath.trim()) {
      throw new TypeError(`[${TOOL_NAME}] netlist_path must be a non-empty string.`);
    }

    const netlistSha256 = args["netlist_sha256"];
    if (typeof netlistSha256 !== "string" || !netlistSha256.trim()) {
      throw new TypeError(
        `[${TOOL_NAME}] netlist_sha256 must be a non-empty 64-char hex string.`,
      );
    }

    const tstep_s = args["tstep_s"];
    if (typeof tstep_s !== "number" || !isFinite(tstep_s) || tstep_s <= 0) {
      throw new TypeError(`[${TOOL_NAME}] tstep_s must be a positive finite number.`);
    }

    const tstop_s = args["tstop_s"];
    if (typeof tstop_s !== "number" || !isFinite(tstop_s) || tstop_s <= 0) {
      throw new TypeError(`[${TOOL_NAME}] tstop_s must be a positive finite number.`);
    }

    if (tstep_s >= tstop_s) {
      throw new TypeError(
        `[${TOOL_NAME}] tstep_s (${tstep_s}) must be less than tstop_s (${tstop_s}).`,
      );
    }

    const nodesRaw = args["nodes"];
    if (!Array.isArray(nodesRaw) || nodesRaw.length === 0) {
      throw new TypeError(
        `[${TOOL_NAME}] nodes must be a non-empty array of node names.`,
      );
    }
    const nodes = nodesRaw.map((n) => {
      if (typeof n !== "string") {
        throw new TypeError(`[${TOOL_NAME}] Each node name must be a string.`);
      }
      return n;
    });

    const rawTimeout = args["timeout_s"];
    const timeoutMs = typeof rawTimeout === "number"
      ? Math.min(Math.max(rawTimeout, 1), 300) * 1000
      : 30_000;

    // 1. Snapshot.
    const snapshot = await snapshotNetlistArtifact(
      TOOL_NAME,
      netlistPath,
      netlistSha256,
    );

    try {
      // 2. Read and validate security.
      const circuitContent = await Deno.readTextFile(snapshot.artifact.path);
      validateNetlistSecurity(circuitContent, TOOL_NAME);

      // 3. Run the simulation.
      const result = await runNgspiceTran(
        circuitContent,
        tstep_s,
        tstop_s,
        nodes,
        timeoutMs,
      );

      // 4. Build cross-tool measurements alias (final_v per node).
      const measurements: Record<string, { value: number }> = {};
      for (const [node, stats] of Object.entries(result.nodeStats)) {
        measurements[node] = { value: stats.final_v };
      }

      const summary = nodes
        .map((n) => {
          const s = result.nodeStats[n];
          return s
            ? `${n}=[${s.min_v.toExponential(3)},${s.max_v.toExponential(3)}] final=${
              s.final_v.toExponential(3)
            } V`
            : `${n}=missing`;
        })
        .join(", ");

      return {
        content: `[${TOOL_NAME}] sha256:${snapshot.artifact.sha256}: ${summary}`,
        structuredContent: {
          node_stats: result.nodeStats,
          measurements,
          simulation: {
            n_points: result.nPoints,
            tstop_s,
          },
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
