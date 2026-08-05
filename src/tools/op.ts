/**
 * spice_simulate_op — DC operating-point simulation.
 *
 * The caller supplies a complete SPICE netlist (as a file path) that includes
 * a `.op` directive and a `.control` block with `print` or `.meas` lines
 * specifying which scalar results to return. The tool runs ngspice in batch
 * mode and returns the named measurements extracted from the output.
 *
 * The tool does NOT interpret results or declare compliance. Measurements are
 * raw ngspice output. The oracle (SysON constraint evaluation) decides if the
 * values satisfy a requirement.
 */

import { snapshotNetlistArtifact } from "../api/netlist-artifact.ts";
import { runNgspice } from "../api/ngspice.ts";
import type { SpiceTool } from "./types.ts";

const TOOL_NAME = "spice_simulate_op";

const NOT_CHECKED = [
  "Temperature effects: simulation runs at TNOM=27°C unless the netlist overrides .TEMP or .OPTIONS TNOM.",
  "Convergence: ngspice uses default DC convergence tolerances (ABSTOL=1e-12, RELTOL=1e-3); divergent circuits raise SpiceError.",
  "Parameter sweep: this tool runs a single .op point; use spice_simulate_dc for source sweeps.",
  "Monte Carlo / worst-case analysis is not performed.",
  "Non-linear component models require the model definitions embedded in the netlist; no model library is provided by this server.",
];

const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["netlist_path"],
  properties: {
    netlist_path: {
      type: "string",
      description: "Absolute path to the SPICE netlist (.cir / .sp / .spi). " +
        "The netlist must include a .op directive and a .control block with " +
        "`run`, one or more `print <var>` lines, and `quit`.",
    },
    expected_netlist_sha256: {
      type: "string",
      description: "Optional 64-char hex SHA-256 of the netlist file. " +
        "When supplied, the server raises an error if the computed digest differs.",
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
    "measurements",
    "not_checked",
    "input_artifact",
  ],
  properties: {
    measurements: {
      type: "object",
      description: "Named scalar results extracted from ngspice print/meas output. " +
        "Keys are lower-cased ngspice variable names (e.g. `v(out)`, `i(vin)`, `vmax`). " +
        "Values carry `value` (number) and optional `at` (time or frequency of the extremum).",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: {
          value: { type: "number" },
          at: { type: "number" },
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

export const opTool: SpiceTool = {
  name: TOOL_NAME,
  description:
    "Run an ngspice DC operating-point (.op) simulation on a caller-supplied " +
    "SPICE netlist and return named scalar measurements (node voltages, branch " +
    "currents, .meas results). The tool measures; it does not declare whether " +
    "the circuit meets a specification — that verdict belongs to the oracle.",
  category: "simulation",
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
  annotations: {
    readOnlyHint: false, // writes to a temp dir during simulation
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args: Record<string, unknown>) => {
    const netlistPath = args["netlist_path"];
    if (typeof netlistPath !== "string" || !netlistPath.trim()) {
      throw new TypeError(`[${TOOL_NAME}] netlist_path must be a non-empty string.`);
    }

    const expectedSha256 = typeof args["expected_netlist_sha256"] === "string"
      ? args["expected_netlist_sha256"]
      : undefined;

    const rawTimeout = args["timeout_s"];
    const timeoutMs = typeof rawTimeout === "number"
      ? Math.min(Math.max(rawTimeout, 1), 300) * 1000
      : 30_000;

    const snapshot = await snapshotNetlistArtifact(
      TOOL_NAME,
      netlistPath,
      expectedSha256,
    );

    try {
      const result = await runNgspice(snapshot.artifact.path, timeoutMs);

      const summary = Object.entries(result.measurements)
        .map(([k, v]) => `${k}=${v.value.toExponential(4)}`)
        .join(", ");

      return {
        content: `[${TOOL_NAME}] sha256:${snapshot.artifact.sha256}: ${summary}`,
        structuredContent: {
          measurements: result.measurements,
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
