/**
 * spice_simulate_op — DC operating-point simulation.
 *
 * The caller supplies a SPICE netlist (circuit only, no .control block) and a
 * list of node names whose voltages are requested.  The server writes the
 * .control block, runs ngspice in batch mode, and returns the voltages.
 *
 * Security: the netlist is validated for forbidden directives before the
 * subprocess launches (see src/api/netlist-security.ts).  The SHA-256 of the
 * private snapshot is always returned and may optionally be asserted by the
 * caller upfront.
 *
 * The tool does NOT declare whether the voltages satisfy a specification;
 * that verdict belongs to the oracle (SysON constraint evaluation).
 */

import { snapshotNetlistArtifact } from "../api/netlist-artifact.ts";
import { validateNetlistSecurity } from "../api/netlist-security.ts";
import { runNgspiceOp } from "../api/ngspice.ts";
import type { SpiceTool } from "./types.ts";

const TOOL_NAME = "spice_simulate_op";

const NOT_CHECKED = [
  "Temperature: simulation runs at TNOM=27°C unless the netlist overrides .TEMP or .OPTIONS TNOM.",
  "Convergence: ngspice uses default DC tolerances (ABSTOL=1e-12, RELTOL=1e-3); divergent circuits raise SpiceError.",
  "Sweep: this tool returns a single .op point; use spice_simulate_dc for source sweeps.",
  "Monte Carlo / worst-case analysis is not performed.",
  "Non-linear component models require .model definitions embedded in the netlist; no model library is provided by this server.",
  "Branch currents are not returned; only node voltages are extracted.",
];

const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["netlist_path", "netlist_sha256", "nodes"],
  properties: {
    netlist_path: {
      type: "string",
      description: "Absolute path to the SPICE netlist (.cir / .sp / .spi). " +
        "The netlist must contain only circuit elements and a .op directive. " +
        "Do NOT include a .control block — the server writes it. " +
        "Forbidden: .control, .include, .lib, .shell, absolute paths.",
    },
    netlist_sha256: {
      type: "string",
      description: "64-char hex SHA-256 of the netlist file. " +
        "The server computes the digest of its private snapshot and raises " +
        "NetlistArtifactError if it differs from this value.",
    },
    nodes: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
      description:
        'Node names whose DC voltages are requested (e.g. ["out", "vdd"]). ' +
        "Use bare names as they appear in the netlist, without the v() wrapper. " +
        'The ground node is "0".',
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
  required: ["node_voltages", "measurements", "not_checked", "input_artifact"],
  properties: {
    node_voltages: {
      type: "object",
      description:
        "Node name → voltage in volts, for each node in the `nodes` input array.",
      additionalProperties: { type: "number" },
    },
    measurements: {
      type: "object",
      description:
        "Alias of node_voltages; present for cross-tool schema uniformity. " +
        "Contains the same key/value pairs wrapped in {value: number}.",
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

export const opTool: SpiceTool = {
  name: TOOL_NAME,
  description:
    "Run an ngspice DC operating-point (.op) simulation on a caller-supplied " +
    "circuit netlist (no .control block) and return requested node voltages. " +
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

    // 1. Snapshot (copies file, checks digest).
    const snapshot = await snapshotNetlistArtifact(
      TOOL_NAME,
      netlistPath,
      netlistSha256,
    );

    try {
      // 2. Read and validate security BEFORE subprocess launch.
      const circuitContent = await Deno.readTextFile(snapshot.artifact.path);
      validateNetlistSecurity(circuitContent, TOOL_NAME);

      // 3. Run the simulation (server builds .control block).
      const result = await runNgspiceOp(circuitContent, nodes, timeoutMs);

      // 4. Build structured output.
      const node_voltages = result.nodeVoltages;
      // measurements mirror for schema uniformity (cross-tool callers)
      const measurements: Record<string, { value: number }> = {};
      for (const [k, v] of Object.entries(node_voltages)) {
        measurements[k] = { value: v };
      }

      const summary = nodes
        .map((n) => `${n}=${(node_voltages[n] ?? NaN).toExponential(4)} V`)
        .join(", ");

      return {
        content: `[${TOOL_NAME}] sha256:${snapshot.artifact.sha256}: ${summary}`,
        structuredContent: {
          node_voltages,
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
