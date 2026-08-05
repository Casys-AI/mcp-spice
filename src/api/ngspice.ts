/**
 * ngspice 44.2 subprocess bridge.
 *
 * The server owns the .control block; the caller supplies only the circuit
 * definition.  Two entry points:
 *
 *   runNgspiceOp   — DC operating point (.op): returns one voltage per node.
 *   runNgspiceTran — Transient (.tran): returns min/max/final per node via
 *                    wrdata written to a server-controlled temp file.
 *
 * LESSON (mirrors mcp-dfm gmsh and mcp-calculix ccx lessons):
 *   - ngspice may exit 0 and write nothing useful; check output explicitly.
 *   - wrdata may silently not be written when the circuit fails to converge;
 *     check for the file separately after a successful exit.
 *   - exit 0 does not mean the simulation converged; scan the log for "Error:"
 *     even after a zero exit code.
 *
 * wrdata column layout (ngspice 44.2 batch mode, N requested nodes):
 *   Columns = 2 × N, interleaved time+value pairs:
 *     col 2i   = time axis for node i  (all identical in transient)
 *     col 2i+1 = v(nodes[i]) value at that time step
 */

import { validateNodeName } from "./netlist-security.ts";

/** Raised when ngspice is absent from PATH. */
export class NgspiceNotFoundError extends Error {
  constructor() {
    super(
      "The ngspice executable was not found on PATH. " +
        "Install it first: `apt install ngspice` (Debian/Ubuntu) or " +
        "`brew install ngspice` (macOS).",
    );
    this.name = "NgspiceNotFoundError";
  }
}

/** Raised on simulation errors (exit non-zero, error in log, or missing output). */
export class SpiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpiceError";
  }
}

/** DC operating-point result: one voltage per requested node. */
export interface OpResult {
  /** Node name (as supplied by the caller) → voltage in volts. */
  nodeVoltages: Record<string, number>;
  /** Last 800 chars of ngspice stdout+stderr for traceability. */
  logTail: string;
}

/** Per-node statistics from a transient simulation. */
export interface NodeStats {
  min_v: number;
  max_v: number;
  final_v: number;
}

/** Transient simulation result. */
export interface TranResult {
  /** Node name → {min_v, max_v, final_v} in volts. */
  nodeStats: Record<string, NodeStats>;
  /** Total number of time points written by ngspice (adaptive step). */
  nPoints: number;
  /** Last 800 chars of ngspice stdout+stderr for traceability. */
  logTail: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Netlist assembly
// ---------------------------------------------------------------------------

/**
 * Combine the caller's circuit content with a server-authored .control block.
 *
 * Strips any trailing `.end` line (case-insensitive) from the circuit content
 * and appends the control block followed by `.end`.
 */
function assembleNetlist(circuitContent: string, controlBlock: string): string {
  // Remove the last .end directive if present (case-insensitive, whole line).
  const stripped = circuitContent
    .split("\n")
    .filter((line) => line.trim().toLowerCase() !== ".end")
    .join("\n")
    .trimEnd();

  return `${stripped}\n${controlBlock}\n.end\n`;
}

// ---------------------------------------------------------------------------
// Core subprocess runner
// ---------------------------------------------------------------------------

/**
 * Write `netlist` to a temp file, run `ngspice -b`, return stdout+stderr.
 *
 * Cleans up the temp directory in both success and error paths.
 */
async function runNgspiceRaw(
  netlist: string,
  timeoutMs: number,
): Promise<{ log: string; workDir: string }> {
  const workDir = await Deno.makeTempDir({ prefix: "spice-run-" });
  const cirPath = `${workDir}/circuit.cir`;
  await Deno.writeTextFile(cirPath, netlist);

  let child;
  try {
    child = new Deno.Command("ngspice", {
      args: ["-b", cirPath],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (e) {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
    if (e instanceof Deno.errors.NotFound) throw new NgspiceNotFoundError();
    throw e;
  }

  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }, timeoutMs);

  const { success, stdout, stderr } = await child.output();
  clearTimeout(timer);

  const log = new TextDecoder().decode(stdout) +
    new TextDecoder().decode(stderr);

  if (!success) {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
    throw new SpiceError(
      `ngspice failed (non-zero exit or killed after ${timeoutMs} ms): ` +
        log.slice(-800),
    );
  }

  // LESSON: ngspice may exit 0 and still report errors in the log.
  const lowerLog = log.toLowerCase();
  if (
    lowerLog.includes("error:") ||
    lowerLog.includes("fatal:") ||
    lowerLog.includes("aborted")
  ) {
    const errorLines = log
      .split("\n")
      .filter(
        (l) =>
          l.toLowerCase().includes("error:") ||
          l.toLowerCase().includes("fatal:"),
      )
      .join("\n");
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
    throw new SpiceError(
      "ngspice reported an error (exit 0 but error in log): " +
        (errorLines || log.slice(-800)),
    );
  }

  return { log, workDir };
}

// ---------------------------------------------------------------------------
// Public API — DC operating point
// ---------------------------------------------------------------------------

/**
 * Run a DC operating-point simulation on a circuit.
 *
 * The server writes:
 *   .control
 *   op
 *   print v(node1) v(node2) ...
 *   quit
 *   .endc
 *
 * @param circuitContent - Caller's netlist (no .control block).
 * @param nodes          - Node names (e.g. ["out", "in"]).
 * @param timeoutMs      - Kill timeout (default 30 s).
 */
export async function runNgspiceOp(
  circuitContent: string,
  nodes: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<OpResult> {
  if (nodes.length === 0) {
    throw new TypeError("nodes must contain at least one node name.");
  }
  for (const n of nodes) {
    validateNodeName(n, "spice_simulate_op");
  }

  const printArgs = nodes.map((n) => `v(${n})`).join(" ");
  const controlBlock = `.control\nop\nprint ${printArgs}\nquit\n.endc`;
  const netlist = assembleNetlist(circuitContent, controlBlock);

  const { log, workDir } = await runNgspiceRaw(netlist, timeoutMs);
  await Deno.remove(workDir, { recursive: true }).catch(() => {});

  const logTail = log.slice(-800);
  const rawMeasurements = parseMeasurements(log);

  // Validate that every requested node was returned and map to plain name.
  const nodeVoltages: Record<string, number> = {};
  for (const node of nodes) {
    const key = `v(${node.toLowerCase()})`;
    const entry = rawMeasurements[key];
    if (entry === undefined) {
      throw new SpiceError(
        `[spice_simulate_op] Node "${node}" not found in ngspice output. ` +
          `Available keys: ${Object.keys(rawMeasurements).join(", ")}. ` +
          `Log tail: ${logTail}`,
      );
    }
    nodeVoltages[node] = entry.value;
  }

  return { nodeVoltages, logTail };
}

// ---------------------------------------------------------------------------
// Public API — Transient simulation
// ---------------------------------------------------------------------------

/**
 * Run a transient simulation and return per-node statistics (min/max/final).
 *
 * The server writes:
 *   .control
 *   tran {tstep_s} {tstop_s}
 *   wrdata {server_temp_path} v(node1) v(node2) ...
 *   quit
 *   .endc
 *
 * wrdata writes 2N columns: for node i, col 2i = time, col 2i+1 = value.
 * The file is read from the server's own temp directory; no path is ever
 * accepted from or returned to the caller.
 *
 * @param circuitContent - Caller's netlist (no .control block).
 * @param tstep_s        - Time step in seconds (e.g. 10e-6 for 10 µs).
 * @param tstop_s        - Stop time in seconds (e.g. 6e-3 for 6 ms).
 * @param nodes          - Node names (e.g. ["out", "in"]).
 * @param timeoutMs      - Kill timeout (default 30 s).
 */
export async function runNgspiceTran(
  circuitContent: string,
  tstep_s: number,
  tstop_s: number,
  nodes: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<TranResult> {
  if (nodes.length === 0) {
    throw new TypeError("nodes must contain at least one node name.");
  }
  for (const n of nodes) {
    validateNodeName(n, "spice_simulate_tran");
  }
  if (!isFinite(tstep_s) || tstep_s <= 0) {
    throw new TypeError(`tstep_s must be a positive finite number, got ${tstep_s}.`);
  }
  if (!isFinite(tstop_s) || tstop_s <= 0) {
    throw new TypeError(`tstop_s must be a positive finite number, got ${tstop_s}.`);
  }
  if (tstep_s >= tstop_s) {
    throw new TypeError(
      `tstep_s (${tstep_s}) must be less than tstop_s (${tstop_s}).`,
    );
  }

  const printArgs = nodes.map((n) => `v(${n})`).join(" ");
  const tstepStr = tstep_s.toExponential(6);
  const tstopStr = tstop_s.toExponential(6);

  // Build temp dir path up-front so we can use its absolute path in the
  // server-generated .control block.  The caller's circuit never contains this
  // path — it is injected only in the server-side control block.
  const workDir = await Deno.makeTempDir({ prefix: "spice-tran-" });
  const wrdataPath = `${workDir}/tran_out.dat`;
  const cirPath = `${workDir}/circuit.cir`;

  // Using the absolute wrdataPath avoids any dependency on the Deno process
  // cwd; ngspice resolves relative paths from its launch directory, not from
  // the netlist location.
  const controlBlock =
    `.control\ntran ${tstepStr} ${tstopStr}\nwrdata ${wrdataPath} ${printArgs}\nquit\n.endc`;
  const netlist = assembleNetlist(circuitContent, controlBlock);

  await Deno.writeTextFile(cirPath, netlist);

  let child;
  try {
    child = new Deno.Command("ngspice", {
      args: ["-b", cirPath],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (e) {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
    if (e instanceof Deno.errors.NotFound) throw new NgspiceNotFoundError();
    throw e;
  }

  const timerT = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
  }, timeoutMs);

  const { success, stdout, stderr } = await child.output();
  clearTimeout(timerT);

  const log = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);

  if (!success) {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
    throw new SpiceError(
      `ngspice failed (non-zero exit or killed after ${timeoutMs} ms): ` +
        log.slice(-800),
    );
  }

  const lowerLogT = log.toLowerCase();
  if (
    lowerLogT.includes("error:") ||
    lowerLogT.includes("fatal:") ||
    lowerLogT.includes("aborted")
  ) {
    const errorLines = log
      .split("\n")
      .filter(
        (l) =>
          l.toLowerCase().includes("error:") ||
          l.toLowerCase().includes("fatal:"),
      )
      .join("\n");
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
    throw new SpiceError(
      "ngspice reported an error (exit 0 but error in log): " +
        (errorLines || log.slice(-800)),
    );
  }

  try {
    const logTail = log.slice(-800);

    // LESSON: exit 0 does not guarantee wrdata was written (e.g. convergence
    // failure may produce empty output without a detectable error in the log).
    let wrdataContent: string;
    try {
      wrdataContent = await Deno.readTextFile(wrdataPath);
    } catch {
      throw new SpiceError(
        "[spice_simulate_tran] ngspice finished but wrote no wrdata file. " +
          "The circuit may have failed to converge. " +
          `Log tail: ${logTail}`,
      );
    }

    const { nodeStats, nPoints } = parseWrdata(wrdataContent, nodes);
    return { nodeStats, nPoints, logTail };
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Parsers (exported for unit testing)
// ---------------------------------------------------------------------------

export interface SpiceMeasurement {
  value: number;
  /** Time or frequency of the extremum, from `.meas` `at=` trailers. */
  at?: number;
}

/**
 * Parse ngspice control-mode `print` and `.meas` scalar output lines.
 *
 * Matches lines of the form (case-insensitive):
 *   v(out) = 2.000000e+00
 *   vmax   =  5.382215e-01  at=  1.500001e-03
 *   i(vin) = -1.00000e-03
 *
 * Lines starting with "Index" (table headers from `print all`) are skipped.
 */
export function parseMeasurements(
  log: string,
): Record<string, SpiceMeasurement> {
  const results: Record<string, SpiceMeasurement> = {};
  const lineRe =
    /^([\w()#.]+)\s*=\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(?:\s+at=\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))?/;

  for (const rawLine of log.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("Index") || line.startsWith("Note:")) {
      continue;
    }
    const m = lineRe.exec(line);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const value = parseFloat(m[2]);
    const at = m[3] !== undefined ? parseFloat(m[3]) : undefined;
    results[name] = at !== undefined ? { value, at } : { value };
  }

  return results;
}

/**
 * Parse a wrdata output file into per-node statistics.
 *
 * ngspice wrdata format (44.2, batch): no header line.  For N requested
 * nodes the file contains 2N space-separated columns per row:
 *   col 2i   = simulation time for node i  (identical across all nodes)
 *   col 2i+1 = v(nodes[i]) at that time step
 *
 * @param content - Raw content of the wrdata file.
 * @param nodes   - Node names in the same order as the wrdata command.
 * @throws {SpiceError} When no numeric rows are found.
 */
export function parseWrdata(
  content: string,
  nodes: string[],
): { nodeStats: Record<string, NodeStats>; nPoints: number } {
  const expectedCols = 2 * nodes.length;

  // Data lines start with an optional space then a digit or sign.
  const rows: number[][] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || !/^[-+\d]/.test(line)) continue;
    const vals = line.split(/\s+/).map(Number);
    if (vals.length === expectedCols && vals.every(isFinite)) {
      rows.push(vals);
    }
  }

  if (rows.length === 0) {
    throw new SpiceError(
      "wrdata output contained no parseable numeric rows. " +
        "The simulation may have produced no time steps.",
    );
  }

  const nodeStats: Record<string, NodeStats> = {};
  for (let i = 0; i < nodes.length; i++) {
    const valueCol = 2 * i + 1;
    const values = rows.map((r) => r[valueCol]);
    nodeStats[nodes[i]] = {
      min_v: Math.min(...values),
      max_v: Math.max(...values),
      final_v: values[values.length - 1],
    };
  }

  return { nodeStats, nPoints: rows.length };
}
