/**
 * Fixed execution budgets for all public SPICE tool paths.
 *
 * These limits bound provider-owned staging and reduced-result handling. They
 * do not alter ngspice physics, select an analysis, or interpret a result.
 */

import { SpiceToolError } from "./tool-error.ts";

/** Exact UTF-8 netlist bytes accepted through either source mode. */
export const NETLIST_MAX_BYTES = 1_048_576;

/** Maximum requested nodes or voltage-source currents per analysis. */
export const MAX_OBSERVABLES_PER_KIND = 32;

/** Maximum private transient wrdata file bytes read by the provider. */
export const MAX_TRANSIENT_WRDATA_BYTES = 8 * 1_048_576;

/** Maximum reduced transient samples parsed by the provider. */
export const MAX_TRANSIENT_POINTS = 50_000;

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_SECONDS = 1;
export const MAX_TIMEOUT_SECONDS = 300;

export function timeoutMsFromArgs(
  raw: unknown,
  toolName: string,
): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  if (
    typeof raw !== "number" || !Number.isFinite(raw) ||
    raw < MIN_TIMEOUT_SECONDS || raw > MAX_TIMEOUT_SECONDS
  ) {
    throw new SpiceToolError(
      "invalid_timeout_s",
      {
        toolName,
        timeout_s: raw,
        minSeconds: MIN_TIMEOUT_SECONDS,
        maxSeconds: MAX_TIMEOUT_SECONDS,
      },
      `Pass timeout_s as a finite number from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS} seconds, or omit it for the ${
        DEFAULT_TIMEOUT_MS / 1000
      }-second default.`,
    );
  }
  return raw * 1000;
}
