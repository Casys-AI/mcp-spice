/**
 * ngspice 44.2 subprocess bridge.
 *
 * The server owns the .control block; the caller supplies only the circuit
 * definition.  Two entry points:
 *
 *   runNgspiceOp   — DC operating point (.op): returns requested node
 *                    voltages and optional voltage-source branch currents.
 *   runNgspiceTran — Transient (.tran): returns reduced voltage and requested
 *                    voltage-source-current statistics via wrdata written to
 *                    a server-controlled temp file.
 *   runNgspiceDc   — DC source sweep: returns reduced voltage and requested
 *                    voltage-source-current statistics without a curve dump.
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

import {
  DEFAULT_TIMEOUT_MS,
  MAX_NGSPICE_LOG_BYTES,
  MAX_TRANSIENT_POINTS,
  MAX_WRDATA_BYTES,
} from "./execution-budgets.ts";
import { validateNodeName, validateSourceName } from "./netlist-security.ts";
import type { MachineReadableErrorFields } from "./tool-error.ts";

/** Raised when ngspice is absent from PATH. */
export class NgspiceNotFoundError extends Error implements MachineReadableErrorFields {
  readonly code = "ngspice_unavailable";
  readonly context: Record<string, unknown>;
  readonly recovery: string;

  constructor(
    options: {
      context?: Record<string, unknown>;
      recovery?: string;
    } = {},
  ) {
    super(
      "The ngspice executable was not found on PATH. " +
        "Install it first: `apt install ngspice` (Debian/Ubuntu) or " +
        "`brew install ngspice` (macOS).",
    );
    this.name = "NgspiceNotFoundError";
    this.context = options.context ?? { executable: "ngspice" };
    this.recovery = options.recovery ??
      "Install ngspice on PATH, then retry the simulation. The published container image already includes the tested ngspice baseline.";
  }
}

/** Raised on simulation errors (exit non-zero, error in log, or missing output). */
export class SpiceError extends Error implements MachineReadableErrorFields {
  readonly code: string;
  readonly context: Record<string, unknown>;
  readonly recovery: string;

  constructor(
    message: string,
    options: {
      code?: string;
      context?: Record<string, unknown>;
      recovery?: string;
    } = {},
  ) {
    super(message);
    this.name = "SpiceError";
    this.code = options.code ?? "ngspice_simulation_failed";
    this.context = options.context ?? {};
    this.recovery = options.recovery ??
      "Check the circuit and requested observables, then retry. Do not infer a result from a failed ngspice run.";
  }
}

/** DC operating-point result: requested node voltages and branch currents. */
export interface OpResult {
  /** Node name (as supplied by the caller) → voltage in volts. */
  nodeVoltages: Record<string, number>;
  /**
   * Voltage-source name (caller spelling) → branch current in amperes.
   * Raw ngspice `i(Vsource)`: positive into the source positive terminal.
   */
  branchCurrents: Record<string, number>;
  /** Last 800 chars of ngspice stdout+stderr for traceability. */
  logTail: string;
}

/** Per-node statistics from a transient simulation. */
export interface NodeStats {
  min_v: number;
  max_v: number;
  final_v: number;
  /** Earliest simulation time at which min_v occurred, in seconds. */
  min_at_s: number;
  /** Earliest simulation time at which max_v occurred, in seconds. */
  max_at_s: number;
  /** Time of the final parsed transient sample, in seconds. */
  final_at_s: number;
}

/** Requested voltage-source branch-current statistics from a transient run. */
export interface BranchCurrentStats {
  min_a: number;
  max_a: number;
  final_a: number;
  /** Earliest simulation time at which min_a occurred, in seconds. */
  min_at_s: number;
  /** Earliest simulation time at which max_a occurred, in seconds. */
  max_at_s: number;
  /** Time of the final parsed transient sample, in seconds. */
  final_at_s: number;
}

/** Reduced statistics over an independent DC source sweep, keyed by volts. */
export interface DcNodeStats {
  min_v: number;
  max_v: number;
  final_v: number;
  /** First sampled source position at which min_v occurred, in volts. */
  min_at_source_v: number;
  /** First sampled source position at which max_v occurred, in volts. */
  max_at_source_v: number;
  /** Swept source value at the final parsed sample, in volts. */
  final_at_source_v: number;
}

/** Requested branch-current statistics over an independent DC source sweep. */
export interface DcBranchCurrentStats {
  min_a: number;
  max_a: number;
  final_a: number;
  /** First sampled source position at which min_a occurred, in volts. */
  min_at_source_v: number;
  /** First sampled source position at which max_a occurred, in volts. */
  max_at_source_v: number;
  /** Swept source value at the final parsed sample, in volts. */
  final_at_source_v: number;
}

/** Transient simulation result. */
export interface TranResult {
  /** Node name → {min_v, max_v, final_v} in volts. */
  nodeStats: Record<string, NodeStats>;
  /** Requested source name → current statistics in amperes. */
  branchCurrentStats: Record<string, BranchCurrentStats>;
  /** Total number of time points written by ngspice (adaptive step). */
  nPoints: number;
  /** Last 800 chars of ngspice stdout+stderr for traceability. */
  logTail: string;
}

/** DC source-sweep result, deliberately reduced rather than a full curve. */
export interface DcResult {
  /** Node name → voltage statistics over the sweep. */
  nodeStats: Record<string, DcNodeStats>;
  /** Requested source name → current statistics over the sweep. */
  branchCurrentStats: Record<string, DcBranchCurrentStats>;
  /** Total number of sweep points actually written by ngspice. */
  nPoints: number;
  /** Last 800 chars of ngspice stdout+stderr for traceability. */
  logTail: string;
}

/** Hard cap on an internal DC sweep before its reduced result is returned. */
export const MAX_DC_SWEEP_POINTS = 512;

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
 * Cleans up the temp directory on errors; the successful caller releases it
 * after parsing the relevant output.
 */
async function runNgspiceRaw(
  netlist: string,
  timeoutMs: number,
): Promise<{ log: string; workDir: string }> {
  const workDir = await Deno.makeTempDir({ prefix: "spice-run-" });
  const cirPath = `${workDir}/circuit.cir`;
  try {
    await Deno.writeTextFile(cirPath, netlist);
    const log = await runNgspiceBatch(cirPath, timeoutMs);
    return { log, workDir };
  } catch (error) {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
    throw error;
  }
}

/** Run one provider-owned batch process with a typed wall-clock timeout. */
async function runNgspiceBatch(
  cirPath: string,
  timeoutMs: number,
): Promise<string> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("ngspice", {
      args: ["-b", cirPath],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) throw new NgspiceNotFoundError();
    throw error;
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }, timeoutMs);

  // Read both pipes concurrently: waiting for one before the other can block a
  // subprocess that fills the unread pipe.  `ChildProcess.output()` buffers
  // both streams without a ceiling, so it cannot be used on an OP path.
  const statusPromise = child.status;
  const stdoutPromise = readNgspiceOutputWithinLimit(child.stdout, "stdout", () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  });
  const stderrPromise = readNgspiceOutputWithinLimit(child.stderr, "stderr", () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  });
  const [statusResult, stdoutResult, stderrResult] = await Promise.allSettled([
    statusPromise,
    stdoutPromise,
    stderrPromise,
  ]).finally(() => clearTimeout(timer));

  // Preserve the explicit output-limit diagnosis over the killed process's
  // expected non-zero exit. This applies to OP diagnostics as well as the
  // transient and DC paths that subsequently read private wrdata files.
  for (const outputResult of [stdoutResult, stderrResult]) {
    if (
      outputResult.status === "rejected" &&
      outputResult.reason instanceof SpiceError &&
      outputResult.reason.code === "ngspice_output_limit_exceeded"
    ) {
      throw outputResult.reason;
    }
  }
  if (stdoutResult.status === "rejected") throw stdoutResult.reason;
  if (stderrResult.status === "rejected") throw stderrResult.reason;
  if (statusResult.status === "rejected") throw statusResult.reason;

  const result = statusResult.value;
  const log = new TextDecoder().decode(stdoutResult.value) +
    new TextDecoder().decode(stderrResult.value);

  if (!result.success) {
    throw new SpiceError(
      timedOut
        ? `ngspice exceeded the ${timeoutMs} ms execution budget: ${log.slice(-800)}`
        : `ngspice exited with a non-zero status: ${log.slice(-800)}`,
      {
        code: timedOut ? "ngspice_timeout" : "ngspice_process_failed",
        context: { timeoutMs },
        recovery: timedOut
          ? "Reduce circuit complexity or request fewer observables, then retry within the fixed timeout budget."
          : "Check the circuit and requested observables, then retry. Do not infer a result from a failed ngspice run.",
      },
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
    throw new SpiceError(
      "ngspice reported an error (exit 0 but error in log): " +
        (errorLines || log.slice(-800)),
      {
        code: "ngspice_reported_error",
        context: { stage: "ngspice_log" },
        recovery:
          "Check the circuit and requested observables, then retry. Do not infer a result from a failed ngspice run.",
      },
    );
  }

  return log;
}

/**
 * Consume one ngspice diagnostic stream under a fixed byte limit. Exported
 * from this source module for adversarial parser-boundary tests; not
 * root-exported.
 */
export async function readNgspiceOutputWithinLimit(
  stream: ReadableStream<Uint8Array>,
  streamName: "stdout" | "stderr",
  onLimitExceeded: () => void = () => {},
  maxBytes: number = MAX_NGSPICE_LOG_BYTES,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      byteCount += value.byteLength;
      if (byteCount > maxBytes) {
        onLimitExceeded();
        await reader.cancel().catch(() => {});
        throw new SpiceError(
          `ngspice ${streamName} exceeded the ${maxBytes}-byte output budget.`,
          {
            code: "ngspice_output_limit_exceeded",
            context: {
              stage: "ngspice_log",
              stream: streamName,
              limit: "bytes",
              byteCount,
              maxBytes,
            },
            recovery:
              "Reduce circuit complexity or requested observables, then retry. No partial simulation result was returned.",
          },
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
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
 *   print v(node1) … i(source1) …
 *   quit
 *   .endc
 *
 * @param circuitContent - Caller's netlist (no .control block).
 * @param nodes          - Node names (e.g. ["out", "in"]). May be empty when
 *                         `branchSources` is non-empty.
 * @param timeoutMs      - Kill timeout (default 30 s).
 * @param branchSources  - Voltage-source names for `i(source)` (e.g. ["Vin"]).
 */
export async function runNgspiceOp(
  circuitContent: string,
  nodes: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  branchSources: string[] = [],
): Promise<OpResult> {
  if (nodes.length === 0 && branchSources.length === 0) {
    throw new TypeError(
      "At least one of nodes or branchSources must be a non-empty array.",
    );
  }
  for (const n of nodes) {
    validateNodeName(n, "spice_simulate_op");
  }
  for (const s of branchSources) {
    validateSourceName(s, "spice_simulate_op");
  }

  const printArgs = [
    ...nodes.map((n) => `v(${n})`),
    ...branchSources.map((s) => `i(${s})`),
  ].join(" ");
  const controlBlock = `.control\nop\nprint ${printArgs}\nquit\n.endc`;
  const netlist = assembleNetlist(circuitContent, controlBlock);

  const { log, workDir } = await runNgspiceRaw(netlist, timeoutMs);
  await Deno.remove(workDir, { recursive: true }).catch(() => {});

  const logTail = log.slice(-800);
  const rawMeasurements = parseMeasurements(log);

  const nodeVoltages: Record<string, number> = {};
  for (const node of nodes) {
    nodeVoltages[node] = requirePrintedScalar(
      rawMeasurements,
      `v(${node.toLowerCase()})`,
      `Node "${node}"`,
      logTail,
    );
  }

  const branchCurrents: Record<string, number> = {};
  for (const source of branchSources) {
    branchCurrents[source] = requirePrintedScalar(
      rawMeasurements,
      `i(${source.toLowerCase()})`,
      `Branch source "${source}"`,
      logTail,
    );
  }

  return { nodeVoltages, branchCurrents, logTail };
}

function requirePrintedScalar(
  raw: Record<string, SpiceMeasurement>,
  key: string,
  label: string,
  logTail: string,
): number {
  const entry = raw[key];
  if (entry === undefined) {
    throw new SpiceError(
      `[spice_simulate_op] ${label} not found in ngspice output. ` +
        `Available keys: ${Object.keys(raw).join(", ")}. ` +
        `Log tail: ${logTail}`,
    );
  }
  return entry.value;
}

// ---------------------------------------------------------------------------
// Public API — Transient simulation
// ---------------------------------------------------------------------------

/**
 * Run a transient simulation and return reduced node-voltage and optional
 * voltage-source branch-current statistics.
 *
 * The server writes:
 *   .control
 *   tran {tstep_s} {tstop_s}
 *   wrdata {server_temp_path} v(node1) ... i(source1) ...
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
 * @param nodes          - Node names (e.g. ["out", "in"]). May be empty
 *                         when `branchSources` is non-empty.
 * @param timeoutMs      - Kill timeout (default 30 s).
 * @param branchSources  - Voltage-source names for `i(source)` (e.g. ["Vin"]).
 */
export async function runNgspiceTran(
  circuitContent: string,
  tstep_s: number,
  tstop_s: number,
  nodes: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  branchSources: string[] = [],
): Promise<TranResult> {
  if (nodes.length === 0 && branchSources.length === 0) {
    throw new TypeError(
      "At least one of nodes or branchSources must be a non-empty array.",
    );
  }
  for (const n of nodes) {
    validateNodeName(n, "spice_simulate_tran");
  }
  for (const s of branchSources) {
    validateSourceName(s, "spice_simulate_tran");
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

  const printArgs = [
    ...nodes.map((n) => `v(${n})`),
    ...branchSources.map((s) => `i(${s})`),
  ].join(" ");
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

  try {
    await Deno.writeTextFile(cirPath, netlist);
    const log = await runNgspiceBatch(cirPath, timeoutMs);
    const logTail = log.slice(-800);

    // LESSON: exit 0 does not guarantee wrdata was written (e.g. convergence
    // failure may produce empty output without a detectable error in the log).
    const wrdataContent = await readTransientWrdataWithinLimit(wrdataPath);

    const { seriesStats, nPoints } = parseWrdataSeries(
      wrdataContent,
      nodes.length + branchSources.length,
      MAX_TRANSIENT_POINTS,
    );
    const nodeStats: Record<string, NodeStats> = {};
    const branchCurrentStats: Record<string, BranchCurrentStats> = {};
    let seriesIndex = 0;
    for (const node of nodes) {
      nodeStats[node] = toNodeStats(seriesStats[seriesIndex++]);
    }
    for (const source of branchSources) {
      branchCurrentStats[source] = toBranchCurrentStats(seriesStats[seriesIndex++]);
    }
    return { nodeStats, branchCurrentStats, nPoints, logTail };
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Public API — bounded DC source sweep
// ---------------------------------------------------------------------------

/**
 * Return a conservative upper bound on the points a one-dimensional ngspice
 * `dc` command can emit. A sweep that would exceed the server cap is refused
 * before the subprocess starts.
 */
export function estimateDcSweepPoints(
  start_v: number,
  stop_v: number,
  step_v: number,
): number {
  if (!isFinite(start_v) || !isFinite(stop_v) || !isFinite(step_v)) {
    throw new TypeError("start_v, stop_v, and step_v must be finite numbers.");
  }
  if (step_v === 0) {
    throw new TypeError("step_v must not be zero.");
  }
  if (start_v === stop_v) return 1;

  const span = stop_v - start_v;
  if (Math.sign(step_v) !== Math.sign(span)) {
    throw new TypeError(
      "step_v must move from start_v toward stop_v (matching sign).",
    );
  }

  const points = Math.ceil(Math.abs(span / step_v)) + 1;
  if (!Number.isSafeInteger(points) || points > MAX_DC_SWEEP_POINTS) {
    throw new TypeError(
      `DC sweep would exceed the ${MAX_DC_SWEEP_POINTS}-point server limit.`,
    );
  }
  return points;
}

/**
 * Number of positions ngspice should emit for this requested grid. This is
 * intentionally distinct from estimateDcSweepPoints(): the estimate uses
 * ceil() as a conservative admission bound, while a non-dividing step stops
 * at the last in-range position and therefore has floor(span / step) + 1
 * observed points.
 */
function expectedDcSweepPointCount(
  start_v: number,
  stop_v: number,
  step_v: number,
): number {
  if (start_v === stop_v) return 1;
  const intervals = Math.abs((stop_v - start_v) / step_v);
  const nearestInteger = Math.round(intervals);
  const completedIntervals = Math.abs(intervals - nearestInteger) <=
      WRDATA_AXIS_RELATIVE_TOLERANCE * Math.max(1, intervals)
    ? nearestInteger
    : Math.floor(intervals);
  return completedIntervals + 1;
}

function invalidDcGridError(
  reason: string,
  context: Record<string, unknown> = {},
): SpiceError {
  return new SpiceError(
    `[spice_simulate_dc] ngspice produced a sweep grid that does not match the server-owned request: ${reason}.`,
    {
      code: "ngspice_dc_grid_invalid",
      context: { stage: "dc_wrdata", reason, ...context },
      recovery:
        "Check the circuit and retry the same bounded sweep. No reduced DC result was returned because the observed grid could not be verified.",
    },
  );
}

/**
 * Verify the private wrdata axis before any DC statistic leaves the provider.
 * A request can be admitted using a conservative ceil-based bound, but the
 * observed grid must still be the requested start + k*step sequence, stay in
 * range, and end at the reachable endpoint (or last in-range point when the
 * stop is not divisible by step).
 */
/** @internal Exported from this source module for deterministic grid tests; not root-exported. */
export function validateDcObservedSweep(
  axisPositions: readonly number[],
  start_v: number,
  stop_v: number,
  step_v: number,
): void {
  const admittedUpperBound = estimateDcSweepPoints(start_v, stop_v, step_v);
  const expectedPoints = expectedDcSweepPointCount(start_v, stop_v, step_v);
  if (axisPositions.length > MAX_DC_SWEEP_POINTS) {
    throw invalidDcGridError("point count exceeds the server limit", {
      actualPoints: axisPositions.length,
      maxPoints: MAX_DC_SWEEP_POINTS,
    });
  }
  if (axisPositions.length !== expectedPoints) {
    throw invalidDcGridError("point count differs from the requested grid", {
      actualPoints: axisPositions.length,
      expectedPoints,
      admittedUpperBound,
    });
  }
  if (!axesAreConsistent(axisPositions[0], start_v)) {
    throw invalidDcGridError("first axis value is not the requested start", {
      actualStart: axisPositions[0],
      requestedStart: start_v,
    });
  }

  const lower = Math.min(start_v, stop_v);
  const upper = Math.max(start_v, stop_v);
  for (let index = 0; index < axisPositions.length; index++) {
    const actual = axisPositions[index];
    const expected = start_v + index * step_v;
    const rangeTolerance = axisTolerance(actual, expected);
    if (!axesAreConsistent(actual, expected)) {
      throw invalidDcGridError("axis position does not match the requested step", {
        index,
        actual,
        expected,
        requestedStep: step_v,
      });
    }
    if (actual < lower - rangeTolerance || actual > upper + rangeTolerance) {
      throw invalidDcGridError("axis position is outside the requested bounds", {
        index,
        actual,
        lower,
        upper,
      });
    }
    if (index > 0) {
      const delta = actual - axisPositions[index - 1];
      if (
        Math.sign(delta) !== Math.sign(step_v) ||
        !axesAreConsistent(delta, step_v)
      ) {
        throw invalidDcGridError("axis direction or increment diverges", {
          index,
          actualStep: delta,
          requestedStep: step_v,
        });
      }
    }
  }

  const expectedFinal = start_v + (expectedPoints - 1) * step_v;
  const actualFinal = axisPositions[axisPositions.length - 1];
  if (!axesAreConsistent(actualFinal, expectedFinal)) {
    throw invalidDcGridError("final axis value is not the reachable endpoint", {
      actualFinal,
      expectedFinal,
      requestedStop: stop_v,
    });
  }

  // For a non-dividing step, the final in-range point remains before/after
  // stop in the requested direction; it must never overshoot it. For a
  // dividing step, expectedFinal is stop and the equality above proves it.
  const remaining = stop_v - actualFinal;
  if (
    !axesAreConsistent(actualFinal, stop_v) &&
    (Math.sign(remaining) !== Math.sign(step_v) ||
      Math.abs(remaining) >= Math.abs(step_v) + axisTolerance(remaining, step_v))
  ) {
    throw invalidDcGridError("final axis value is incompatible with stop", {
      actualFinal,
      requestedStop: stop_v,
      requestedStep: step_v,
    });
  }
}

/**
 * Run a server-owned, one-dimensional DC sweep over an independent voltage
 * source. The server returns reduced extrema/final summaries only; full curves
 * remain private and are deleted with the temporary work directory.
 */
export async function runNgspiceDc(
  circuitContent: string,
  sweepSource: string,
  start_v: number,
  stop_v: number,
  step_v: number,
  nodes: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  branchSources: string[] = [],
): Promise<DcResult> {
  if (nodes.length === 0 && branchSources.length === 0) {
    throw new TypeError(
      "At least one of nodes or branchSources must be a non-empty array.",
    );
  }
  validateSourceName(sweepSource, "spice_simulate_dc");
  if (sweepSource[0]?.toLowerCase() !== "v") {
    throw new TypeError(
      "sweepSource must name an independent voltage source (a SPICE element name beginning with V).",
    );
  }
  for (const node of nodes) validateNodeName(node, "spice_simulate_dc");
  for (const source of branchSources) {
    validateSourceName(source, "spice_simulate_dc");
  }
  estimateDcSweepPoints(start_v, stop_v, step_v);

  const printArgs = [
    ...nodes.map((node) => `v(${node})`),
    ...branchSources.map((source) => `i(${source})`),
  ].join(" ");
  const workDir = await Deno.makeTempDir({ prefix: "spice-dc-" });
  const wrdataPath = `${workDir}/dc_out.dat`;
  const cirPath = `${workDir}/circuit.cir`;
  const controlBlock =
    `.control\ndc ${sweepSource} ${start_v.toExponential(12)} ${
      stop_v.toExponential(12)
    } ${step_v.toExponential(12)}\n` +
    `wrdata ${wrdataPath} ${printArgs}\nquit\n.endc`;
  const netlist = assembleNetlist(circuitContent, controlBlock);

  try {
    await Deno.writeTextFile(cirPath, netlist);
    const log = await runNgspiceBatch(cirPath, timeoutMs);
    const logTail = log.slice(-800);
    const wrdataContent = await readDcWrdataWithinLimit(wrdataPath);

    const { seriesStats, nPoints, axisPositions } = parseDcWrdataSeries(
      wrdataContent,
      nodes.length + branchSources.length,
    );
    validateDcObservedSweep(axisPositions, start_v, stop_v, step_v);
    const nodeStats: Record<string, DcNodeStats> = {};
    const branchCurrentStats: Record<string, DcBranchCurrentStats> = {};
    let seriesIndex = 0;
    for (const node of nodes) {
      nodeStats[node] = toDcNodeStats(seriesStats[seriesIndex++]);
    }
    for (const source of branchSources) {
      branchCurrentStats[source] = toDcBranchCurrentStats(seriesStats[seriesIndex++]);
    }
    return { nodeStats, branchCurrentStats, nPoints, logTail };
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
}

/**
 * Read a provider-owned `wrdata` file only after validating its byte budget.
 * The shared ceiling applies before a DC or transient file is decoded; callers
 * never receive the raw series.
 */
type WrdataAnalysis = "transient" | "dc";

function wrdataStage(analysis: WrdataAnalysis): "wrdata" | "dc_wrdata" {
  return analysis === "dc" ? "dc_wrdata" : "wrdata";
}

function wrdataLabel(analysis: WrdataAnalysis): string {
  return analysis === "dc" ? "DC" : "transient";
}

function wrdataRecovery(analysis: WrdataAnalysis): string {
  return analysis === "dc"
    ? "Reduce the DC sweep span, step count, or requested observables, then retry. No partial DC result was returned."
    : "Reduce transient duration or requested observables, then retry. No partial transient result was returned.";
}

async function readWrdataWithinLimit(
  path: string,
  analysis: WrdataAnalysis,
  maxBytes: number = MAX_WRDATA_BYTES,
): Promise<string> {
  const stage = wrdataStage(analysis);
  const label = wrdataLabel(analysis);
  const recovery = wrdataRecovery(analysis);
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch {
    throw new SpiceError(
      `ngspice finished but wrote no ${label} wrdata file. The circuit may have failed to converge.`,
      {
        code: "ngspice_output_missing",
        context: { stage },
        recovery:
          "Check circuit convergence and retry. No partial simulation result was returned.",
      },
    );
  }
  if (!info.isFile) {
    throw new SpiceError(
      `ngspice ${label} wrdata output is not a regular file.`,
      {
        code: "ngspice_output_invalid",
        context: { stage, reason: "not_regular_file" },
        recovery:
          "Check the circuit and ngspice output, then retry. No partial simulation result was returned.",
      },
    );
  }
  if (info.size > maxBytes) {
    throw new SpiceError(
      `ngspice ${label} wrdata exceeded the ${maxBytes}-byte output budget.`,
      {
        code: "ngspice_output_limit_exceeded",
        context: {
          stage,
          limit: "bytes",
          byteCount: info.size,
          maxBytes,
        },
        recovery,
      },
    );
  }
  return await Deno.readTextFile(path);
}

/**
 * Read transient `wrdata` within the shared private-output byte budget.
 *
 * Exported from this source module for deterministic boundary tests; not
 * root-exported.
 */
export async function readTransientWrdataWithinLimit(
  path: string,
  maxBytes: number = MAX_WRDATA_BYTES,
): Promise<string> {
  return await readWrdataWithinLimit(path, "transient", maxBytes);
}

/** Read DC `wrdata` within the same private-output byte budget. */
export async function readDcWrdataWithinLimit(
  path: string,
  maxBytes: number = MAX_WRDATA_BYTES,
): Promise<string> {
  return await readWrdataWithinLimit(path, "dc", maxBytes);
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
 *   v(out-1) = 1.250000e+00
 *   vmax   =  5.382215e-01  at=  1.500001e-03
 *   i(vin) = -1.00000e-03
 *   i(v-in) = -2.50000e-03
 *
 * Selector names use the same alphabet as validateNodeName / validateSourceName
 * (letters, digits, underscore, dot, hyphen, #, plus the v()/i() wrappers).
 *
 * Lines starting with "Index" (table headers from `print all`) are skipped.
 */
export function parseMeasurements(
  log: string,
): Record<string, SpiceMeasurement> {
  const results: Record<string, SpiceMeasurement> = {};
  const lineRe =
    /^([\w()#.\-]+)\s*=\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(?:\s+at=\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))?/;

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

/** Reduced statistics for one `wrdata` observable. `at` is time for transient
 * runs and swept-source voltage for DC runs. */
export interface WrdataSeriesStats {
  min: number;
  max: number;
  final: number;
  minAt: number;
  maxAt: number;
  finalAt: number;
}

interface ParsedWrdataSeries {
  seriesStats: WrdataSeriesStats[];
  nPoints: number;
  /** One shared independent-axis position per validated row. */
  axisPositions: number[];
}

/*
 * ngspice writes the same independent axis once per requested expression.
 * Exact equality is normal; 1e-8 relative tolerance admits independently
 * rounded text representations at ngspice's practical decimal precision,
 * while still refusing a materially divergent grid. The ULP term covers the
 * zero-scale case without an arbitrary physical-unit epsilon.
 */
const WRDATA_AXIS_RELATIVE_TOLERANCE = 1e-8;
const WRDATA_AXIS_ULP_MULTIPLIER = 64;
const WRDATA_NUMBER = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;

function axisTolerance(left: number, right: number): number {
  const scale = Math.max(Math.abs(left), Math.abs(right), Number.MIN_VALUE);
  return Math.max(
    WRDATA_AXIS_RELATIVE_TOLERANCE * scale,
    WRDATA_AXIS_ULP_MULTIPLIER * Number.EPSILON * scale,
    Number.MIN_VALUE,
  );
}

function axesAreConsistent(left: number, right: number): boolean {
  return Math.abs(left - right) <= axisTolerance(left, right);
}

function malformedWrdataError(
  lineNumber: number,
  reason: string,
  context: Record<string, unknown> = {},
): SpiceError {
  return new SpiceError(
    `wrdata output is malformed at line ${lineNumber}: ${reason}.`,
    {
      code: "ngspice_output_invalid",
      context: { stage: "wrdata", lineNumber, reason, ...context },
      recovery:
        "Retry only after checking the circuit and ngspice output. No partial simulation result was returned.",
    },
  );
}

function parseWrdataSeriesWithAxis(
  content: string,
  observableCount: number,
  maxPoints?: number,
  analysis: WrdataAnalysis = "transient",
): ParsedWrdataSeries {
  if (!Number.isSafeInteger(observableCount) || observableCount < 1) {
    throw new TypeError("observableCount must be a positive integer.");
  }
  if (
    maxPoints !== undefined &&
    (!Number.isSafeInteger(maxPoints) || maxPoints < 1)
  ) {
    throw new TypeError("maxPoints must be a positive integer when supplied.");
  }

  const expectedCols = 2 * observableCount;
  let nPoints = 0;
  const seriesStats: WrdataSeriesStats[] = [];
  const axisPositions: number[] = [];

  for (const [index, rawLine] of content.split("\n").entries()) {
    const line = rawLine.trim();
    if (!line) continue;

    if (maxPoints !== undefined && nPoints >= maxPoints) {
      throw new SpiceError(
        `ngspice ${
          wrdataLabel(analysis)
        } wrdata exceeded the ${maxPoints}-point output budget.`,
        {
          code: "ngspice_output_limit_exceeded",
          context: {
            stage: wrdataStage(analysis),
            limit: "points",
            pointCount: nPoints + 1,
            maxPoints,
          },
          recovery: wrdataRecovery(analysis),
        },
      );
    }

    // The server directs ngspice `wrdata` to a dedicated temp file. Its batch
    // format has no header, so a non-blank row is data. Refusing every malformed
    // row prevents a later bad row from being silently skipped after a partial
    // summary has already been accumulated.
    const tokens = line.split(/\s+/);
    if (tokens.length !== expectedCols) {
      throw malformedWrdataError(index + 1, "unexpected column count", {
        expectedColumns: expectedCols,
        actualColumns: tokens.length,
      });
    }
    if (!tokens.every((token) => WRDATA_NUMBER.test(token))) {
      throw malformedWrdataError(index + 1, "non-finite or non-numeric token");
    }
    const values = tokens.map(Number);
    if (!values.every(Number.isFinite)) {
      throw malformedWrdataError(index + 1, "non-finite numeric value");
    }

    const sharedAxis = values[0];
    for (let i = 1; i < observableCount; i++) {
      const axis = values[2 * i];
      if (!axesAreConsistent(sharedAxis, axis)) {
        throw malformedWrdataError(index + 1, "interleaved axes diverge", {
          expectedAxis: sharedAxis,
          observedAxis: axis,
          observableIndex: i,
          relativeTolerance: WRDATA_AXIS_RELATIVE_TOLERANCE,
        });
      }
    }

    for (let i = 0; i < observableCount; i++) {
      const value = values[2 * i + 1];
      const current = seriesStats[i];
      if (current === undefined) {
        seriesStats[i] = {
          min: value,
          max: value,
          final: value,
          minAt: sharedAxis,
          maxAt: sharedAxis,
          finalAt: sharedAxis,
        };
        continue;
      }
      if (value < current.min) {
        current.min = value;
        current.minAt = sharedAxis;
      }
      if (value > current.max) {
        current.max = value;
        current.maxAt = sharedAxis;
      }
      current.final = value;
      current.finalAt = sharedAxis;
    }
    axisPositions.push(sharedAxis);
    nPoints++;
  }

  if (nPoints === 0 || seriesStats.length !== observableCount) {
    throw new SpiceError(
      "wrdata output contained no parseable numeric rows. " +
        "The simulation may have produced no time steps.",
      {
        code: "ngspice_output_invalid",
        context: { stage: "wrdata", expectedColumns: expectedCols },
        recovery:
          "Check the circuit convergence and ngspice output, then retry. No partial simulation result was returned.",
      },
    );
  }

  return { seriesStats, nPoints, axisPositions };
}

/**
 * Parse `wrdata` rows without assigning a physical interpretation to the
 * first column of each pair. For transient runs it is time in seconds; for a
 * DC sweep it is the swept source value in volts.
 *
 * ngspice 44.2 batch `wrdata` has no header. For N server-selected
 * expressions, each row contains `2N` columns: the independent axis followed
 * by the value for expression 0, then the axis and value for expression 1,
 * and so on. The first sampled axis position wins ties for minima and maxima
 * so the reduced result is deterministic.
 */
export function parseWrdataSeries(
  content: string,
  observableCount: number,
  maxPoints?: number,
): { seriesStats: WrdataSeriesStats[]; nPoints: number } {
  const { seriesStats, nPoints } = parseWrdataSeriesWithAxis(
    content,
    observableCount,
    maxPoints,
  );
  return { seriesStats, nPoints };
}

/**
 * Parse a DC wrdata file under the server's hard sweep-point limit. Exported
 * from this source module for adversarial boundary tests; not root-exported.
 */
export function parseDcWrdataSeries(
  content: string,
  observableCount: number,
): ParsedWrdataSeries {
  return parseWrdataSeriesWithAxis(
    content,
    observableCount,
    MAX_DC_SWEEP_POINTS,
    "dc",
  );
}

function toNodeStats(stats: WrdataSeriesStats): NodeStats {
  return {
    min_v: stats.min,
    max_v: stats.max,
    final_v: stats.final,
    min_at_s: stats.minAt,
    max_at_s: stats.maxAt,
    final_at_s: stats.finalAt,
  };
}

function toBranchCurrentStats(stats: WrdataSeriesStats): BranchCurrentStats {
  return {
    min_a: stats.min,
    max_a: stats.max,
    final_a: stats.final,
    min_at_s: stats.minAt,
    max_at_s: stats.maxAt,
    final_at_s: stats.finalAt,
  };
}

function toDcNodeStats(stats: WrdataSeriesStats): DcNodeStats {
  return {
    min_v: stats.min,
    max_v: stats.max,
    final_v: stats.final,
    min_at_source_v: stats.minAt,
    max_at_source_v: stats.maxAt,
    final_at_source_v: stats.finalAt,
  };
}

function toDcBranchCurrentStats(stats: WrdataSeriesStats): DcBranchCurrentStats {
  return {
    min_a: stats.min,
    max_a: stats.max,
    final_a: stats.final,
    min_at_source_v: stats.minAt,
    max_at_source_v: stats.maxAt,
    final_at_source_v: stats.finalAt,
  };
}

/**
 * Parse a transient `wrdata` output file into per-node voltage statistics.
 * This retained public helper is node-only; `runNgspiceTran` also uses the
 * generic parser above for requested source currents.
 */
export function parseWrdata(
  content: string,
  nodes: string[],
): { nodeStats: Record<string, NodeStats>; nPoints: number } {
  const { seriesStats, nPoints } = parseWrdataSeries(content, nodes.length);
  const nodeStats: Record<string, NodeStats> = {};
  for (let i = 0; i < nodes.length; i++) {
    nodeStats[nodes[i]] = toNodeStats(seriesStats[i]);
  }
  return { nodeStats, nPoints };
}
