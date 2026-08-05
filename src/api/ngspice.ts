/**
 * ngspice subprocess bridge.
 *
 * Accepts an inline SPICE netlist string (already snapshotted by the caller),
 * runs ngspice -b in batch mode, and returns a map of named scalar measurements
 * extracted from the control-block `print` and `.meas` output.
 *
 * The caller is responsible for embedding a `.control` block with:
 *   - `run`
 *   - `print <var1> <var2> …`   — for OP/DC/AC/TRAN node voltages & currents
 *   - `.meas` directives         — for derived metrics (rise time, bandwidth…)
 *   - `quit`
 *
 * Parsing extracts lines of the form:
 *   v(out) = 2.000000e+00
 *   vmax   =  5.382215e-01  at=  1.500001e-03
 *   f3db   =  1.587800e+02
 *
 * The `at=` trailer is captured separately in `measAt` when present.
 *
 * LESSON (mirrors mcp-dfm gmsh lesson): ngspice may exit 0 and write nothing
 * useful. We therefore always check that `measurements` is non-empty after a
 * successful exit, and raise `SpiceError` if it is.
 */

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

/** Raised on simulation errors, with ngspice's own output attached. */
export class SpiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpiceError";
  }
}

export interface SpiceMeasurement {
  /** The numeric value extracted from print/meas output. */
  value: number;
  /** The `at=` time/frequency if this measurement came from a .meas directive. */
  at?: number;
}

export interface NgspiceResult {
  /** Named scalar results from `print` and `.meas` lines. */
  measurements: Record<string, SpiceMeasurement>;
  /** Raw stdout + stderr tail (last 800 chars) for traceability. */
  logTail: string;
}

/** Timeout for a single ngspice run. Override via `timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run ngspice in batch mode on `netlistPath` (already read-only snapshotted).
 *
 * @param netlistPath - Absolute path to the .cir snapshot (read-only).
 * @param timeoutMs   - Kill timeout in milliseconds (default 30 s).
 */
export async function runNgspice(
  netlistPath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<NgspiceResult> {
  let child;
  try {
    child = new Deno.Command("ngspice", {
      args: ["-b", netlistPath],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (e) {
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

  const log = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
  const logTail = log.slice(-800);

  if (!success) {
    throw new SpiceError(
      `ngspice failed (non-zero exit or killed after ${timeoutMs} ms): ${logTail}`,
    );
  }

  // LESSON: ngspice may exit 0 with an error message in stdout (e.g. "Error: …").
  // Check for common error indicators even after a zero exit code.
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
      `ngspice reported an error (exit 0 but error in output): ${
        errorLines || logTail
      }`,
    );
  }

  const measurements = parseMeasurements(log);

  // LESSON: exit 0 does not guarantee useful output. If no measurements were
  // extracted, the netlist likely lacked a .control/print block or .meas.
  if (Object.keys(measurements).length === 0) {
    throw new SpiceError(
      "ngspice finished with exit 0 but produced no parseable measurements. " +
        "Ensure the netlist includes a .control block with `print` or `.meas` directives. " +
        `Log tail: ${logTail}`,
    );
  }

  return { measurements, logTail };
}

/**
 * Parse ngspice control-mode print and .meas output lines.
 *
 * Matches lines of the form (case-insensitive):
 *   v(out) = 2.000000e+00
 *   vmax   =  5.382215e-01  at=  1.500001e-03
 *   f3db   =  1.587800e+02
 *   i(vin) = -1.00000e-03
 *
 * Lines starting with "Index" (table headers from `print all`) are ignored.
 */
export function parseMeasurements(
  log: string,
): Record<string, SpiceMeasurement> {
  const results: Record<string, SpiceMeasurement> = {};
  // Matches: <name> = <number> [at= <number>]
  // Name: word chars, parens, #, dots (e.g. v(out), i(vin), vin#branch, vmax)
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
