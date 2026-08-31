/**
 * Schema adapters for SPICE simulation MCP Apps.
 *
 * The adapters copy documented field contracts. They do not infer units,
 * invent waveform samples, or promote `succeeded` into a requirement verdict.
 */

import { COMPACT_READING_LIMIT } from "../../constants.ts";
import {
  errorMessage,
  exactRecord,
  finiteNumber,
  isRecord,
  literal,
  measurementMap,
  nonEmptyString,
  nonNegativeInteger,
  numberMap,
  record,
  sha256,
  stringArray,
} from "../../shared/closed-json.ts";

export type SimulationViewKind =
  | "operating-point"
  | "dc-sweep"
  | "transient-result"
  | "failed-outcome";

export type SimulationViewSource = "live" | "durable";

export interface DocumentaryReceiptRef {
  readonly request_sha256: string;
  readonly dispatch_sha256: string;
  readonly receipt_sha256: string;
  readonly outcome_sha256: string;
  readonly execution_state: "succeeded";
  readonly documentary_only: true;
}

export interface InputArtifact {
  readonly sha256: string;
  readonly bytes: number;
  readonly source_path?: string;
}

export interface NodeVoltageStats {
  readonly min_v: number;
  readonly max_v: number;
  readonly final_v: number;
  readonly min_at_s?: number;
  readonly max_at_s?: number;
  readonly final_at_s?: number;
  readonly min_at_source_v?: number;
  readonly max_at_source_v?: number;
  readonly final_at_source_v?: number;
}

export interface BranchCurrentStats {
  readonly min_a: number;
  readonly max_a: number;
  readonly final_a: number;
  readonly min_at_s?: number;
  readonly max_at_s?: number;
  readonly final_at_s?: number;
  readonly min_at_source_v?: number;
  readonly max_at_source_v?: number;
  readonly final_at_source_v?: number;
}

export interface SweepFacts {
  readonly source: string;
  readonly start_v: number;
  readonly stop_v: number;
  readonly step_v: number;
  readonly n_points: number;
  readonly max_points: number;
}

export interface TransientFacts {
  readonly n_points: number;
  readonly tstop_s: number;
}

interface SimulationBase {
  readonly source: SimulationViewSource;
  readonly input_artifact: InputArtifact;
  readonly measurements: Record<string, { value: number }>;
  readonly not_checked: readonly string[];
  readonly documentary_receipt?: DocumentaryReceiptRef;
  readonly outcome_sha256?: string;
  readonly input_artifact_source_path?: string;
}

export interface OperatingPointView extends SimulationBase {
  readonly kind: "operating-point";
  readonly node_voltages: Record<string, number>;
  readonly branch_currents_a: Record<string, number>;
}

export interface DcSweepView extends SimulationBase {
  readonly kind: "dc-sweep";
  readonly node_stats: Record<string, NodeVoltageStats>;
  readonly branch_current_stats_a: Record<string, BranchCurrentStats>;
  readonly sweep: SweepFacts;
}

export interface TransientView extends SimulationBase {
  readonly kind: "transient-result";
  readonly node_stats: Record<string, NodeVoltageStats>;
  readonly branch_current_stats_a: Record<string, BranchCurrentStats>;
  readonly simulation: TransientFacts;
}

export interface FailedOutcomeView {
  readonly kind: "failed-outcome";
  readonly source: "durable";
  readonly code: string;
  readonly context: Record<string, unknown>;
  readonly recovery: string;
  readonly outcome_sha256?: string;
  readonly input_artifact_source_path?: string;
}

export type SimulationViewData =
  | OperatingPointView
  | DcSweepView
  | TransientView
  | FailedOutcomeView;

export type DisplayState =
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "result"; readonly result: SimulationViewData };

export interface CompactReading {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly unit: "V" | "A";
}

/** Parse one live simulation result or one durable result_get envelope. */
export function parseSimulationViewData(value: unknown): SimulationViewData {
  const root = record(value, "structuredContent");
  if (typeof root.outcome_sha256 === "string") {
    return parseDurableEnvelope(root);
  }
  return parseSimulationBody(root, "live", {});
}

export function displayStateFromToolResult(value: unknown): DisplayState {
  const result = record(value, "tool result");
  if (result.isError === true) {
    return { kind: "error", message: toolErrorMessage(result) };
  }
  const structured = result.structuredContent !== undefined
    ? (isRecord(result.structuredContent) ? result.structuredContent : undefined)
    : jsonTextFallback(result.content);
  if (structured === undefined) return { kind: "empty" };
  try {
    return { kind: "result", result: parseSimulationViewData(structured) };
  } catch (error) {
    return { kind: "error", message: errorMessage(error) };
  }
}

export function toolErrorMessage(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return "The simulation reported an error.";
  }
  const text = value.content.find((item) => isRecord(item) && item.type === "text")
    ?.text;
  return typeof text === "string" && text.trim()
    ? text
    : "The simulation reported an error.";
}

export function isSimulationViewData(
  value: unknown,
): value is SimulationViewData {
  try {
    parseSimulationViewData(value);
    return true;
  } catch {
    return false;
  }
}

function parseDurableEnvelope(
  root: Record<string, unknown>,
): SimulationViewData {
  const keys = ["outcome_sha256", "result"];
  if (root.input_artifact_source_path !== undefined) {
    keys.push("input_artifact_source_path");
  }
  exactRecord(root, keys, "spice_simulation_result_get structuredContent");
  const outcome_sha256 = sha256(root.outcome_sha256, "outcome_sha256");
  const input_artifact_source_path = root.input_artifact_source_path === undefined
    ? undefined
    : nonEmptyString(
      root.input_artifact_source_path,
      "input_artifact_source_path",
    );
  return parseSimulationBody(record(root.result, "result"), "durable", {
    outcome_sha256,
    input_artifact_source_path,
  });
}

function parseSimulationBody(
  root: Record<string, unknown>,
  source: SimulationViewSource,
  durable: {
    outcome_sha256?: string;
    input_artifact_source_path?: string;
  },
): SimulationViewData {
  if (typeof root.code === "string") {
    if (source !== "durable") {
      throw new TypeError(
        "A typed failure envelope is only valid as a durable simulation outcome.",
      );
    }
    return parseFailedOutcome(root, durable);
  }
  if ("node_voltages" in root) {
    return parseOperatingPoint(root, source, durable);
  }
  if ("sweep" in root) return parseDcSweep(root, source, durable);
  if ("simulation" in root) return parseTransient(root, source, durable);
  throw new TypeError(
    "Expected an operating-point, reduced DC sweep, reduced transient, or typed failure outcome.",
  );
}

function parseOperatingPoint(
  root: Record<string, unknown>,
  source: SimulationViewSource,
  durable: {
    outcome_sha256?: string;
    input_artifact_source_path?: string;
  },
): OperatingPointView {
  const fields = [
    "node_voltages",
    "branch_currents_a",
    "measurements",
    "not_checked",
    "input_artifact",
  ];
  if (source === "live") fields.push("documentary_receipt");
  exactRecord(root, fields, "operating-point result");
  return {
    kind: "operating-point",
    source,
    node_voltages: numberMap(root.node_voltages, "node_voltages"),
    branch_currents_a: numberMap(
      root.branch_currents_a,
      "branch_currents_a",
    ),
    measurements: measurementMap(root.measurements, "measurements"),
    not_checked: stringArray(root.not_checked, "not_checked"),
    input_artifact: parseInputArtifact(root.input_artifact, source),
    ...liveOrDurable(root, source, durable),
  };
}

function parseDcSweep(
  root: Record<string, unknown>,
  source: SimulationViewSource,
  durable: {
    outcome_sha256?: string;
    input_artifact_source_path?: string;
  },
): DcSweepView {
  const fields = [
    "node_stats",
    "branch_current_stats_a",
    "measurements",
    "sweep",
    "not_checked",
    "input_artifact",
  ];
  if (source === "live") fields.push("documentary_receipt");
  exactRecord(root, fields, "dc-sweep result");
  return {
    kind: "dc-sweep",
    source,
    node_stats: voltageStatsMap(root.node_stats, "source"),
    branch_current_stats_a: currentStatsMap(
      root.branch_current_stats_a,
      "source",
    ),
    measurements: measurementMap(root.measurements, "measurements"),
    sweep: parseSweep(root.sweep),
    not_checked: stringArray(root.not_checked, "not_checked"),
    input_artifact: parseInputArtifact(root.input_artifact, source),
    ...liveOrDurable(root, source, durable),
  };
}

function parseTransient(
  root: Record<string, unknown>,
  source: SimulationViewSource,
  durable: {
    outcome_sha256?: string;
    input_artifact_source_path?: string;
  },
): TransientView {
  const fields = [
    "node_stats",
    "branch_current_stats_a",
    "measurements",
    "simulation",
    "not_checked",
    "input_artifact",
  ];
  if (source === "live") fields.push("documentary_receipt");
  exactRecord(root, fields, "transient result");
  return {
    kind: "transient-result",
    source,
    node_stats: voltageStatsMap(root.node_stats, "time"),
    branch_current_stats_a: currentStatsMap(
      root.branch_current_stats_a,
      "time",
    ),
    measurements: measurementMap(root.measurements, "measurements"),
    simulation: parseTransientFacts(root.simulation),
    not_checked: stringArray(root.not_checked, "not_checked"),
    input_artifact: parseInputArtifact(root.input_artifact, source),
    ...liveOrDurable(root, source, durable),
  };
}

function parseFailedOutcome(
  root: Record<string, unknown>,
  durable: {
    outcome_sha256?: string;
    input_artifact_source_path?: string;
  },
): FailedOutcomeView {
  exactRecord(root, ["code", "context", "recovery"], "typed failure outcome");
  return {
    kind: "failed-outcome",
    source: "durable",
    code: nonEmptyString(root.code, "code"),
    context: record(root.context, "context"),
    recovery: nonEmptyString(root.recovery, "recovery"),
    ...durable,
  };
}

function liveOrDurable(
  root: Record<string, unknown>,
  source: SimulationViewSource,
  durable: {
    outcome_sha256?: string;
    input_artifact_source_path?: string;
  },
): Pick<
  SimulationBase,
  "documentary_receipt" | "outcome_sha256" | "input_artifact_source_path"
> {
  if (source === "live") {
    return {
      documentary_receipt: parseDocumentaryReceipt(root.documentary_receipt),
    };
  }
  return durable;
}

function parseDocumentaryReceipt(value: unknown): DocumentaryReceiptRef {
  const root = exactRecord(value, [
    "request_sha256",
    "dispatch_sha256",
    "receipt_sha256",
    "outcome_sha256",
    "execution_state",
    "documentary_only",
  ], "documentary_receipt");
  return {
    request_sha256: sha256(root.request_sha256, "documentary_receipt.request_sha256"),
    dispatch_sha256: sha256(
      root.dispatch_sha256,
      "documentary_receipt.dispatch_sha256",
    ),
    receipt_sha256: sha256(root.receipt_sha256, "documentary_receipt.receipt_sha256"),
    outcome_sha256: sha256(root.outcome_sha256, "documentary_receipt.outcome_sha256"),
    execution_state: literal(
      root.execution_state,
      "succeeded",
      "documentary_receipt.execution_state",
    ),
    documentary_only: literal(
      root.documentary_only,
      true,
      "documentary_receipt.documentary_only",
    ),
  };
}

function parseInputArtifact(
  value: unknown,
  source: SimulationViewSource,
): InputArtifact {
  const keys = source === "live"
    ? ["sha256", "bytes", "source_path"]
    : ["sha256", "bytes"];
  const root = exactRecord(value, keys, "input_artifact");
  const bytes = nonNegativeInteger(root.bytes, "input_artifact.bytes");
  if (bytes < 1) {
    throw new TypeError("input_artifact.bytes must be a positive integer.");
  }
  return {
    sha256: sha256(root.sha256, "input_artifact.sha256"),
    bytes,
    ...(source === "live"
      ? {
        source_path: nonEmptyString(
          root.source_path,
          "input_artifact.source_path",
        ),
      }
      : {}),
  };
}

function parseSweep(value: unknown): SweepFacts {
  const root = exactRecord(value, [
    "source",
    "start_v",
    "stop_v",
    "step_v",
    "n_points",
    "max_points",
  ], "sweep");
  return {
    source: nonEmptyString(root.source, "sweep.source"),
    start_v: finiteNumber(root.start_v, "sweep.start_v"),
    stop_v: finiteNumber(root.stop_v, "sweep.stop_v"),
    step_v: finiteNumber(root.step_v, "sweep.step_v"),
    n_points: nonNegativeInteger(root.n_points, "sweep.n_points"),
    max_points: nonNegativeInteger(root.max_points, "sweep.max_points"),
  };
}

function parseTransientFacts(value: unknown): TransientFacts {
  const root = exactRecord(value, ["n_points", "tstop_s"], "simulation");
  return {
    n_points: nonNegativeInteger(root.n_points, "simulation.n_points"),
    tstop_s: finiteNumber(root.tstop_s, "simulation.tstop_s"),
  };
}

function voltageStatsMap(
  value: unknown,
  axis: "time" | "source",
): Record<string, NodeVoltageStats> {
  const input = record(value, "node_stats");
  return Object.fromEntries(
    Object.entries(input).map(([key, item]) => [
      key,
      parseVoltageStats(item, `node_stats.${key}`, axis),
    ]),
  );
}

function currentStatsMap(
  value: unknown,
  axis: "time" | "source",
): Record<string, BranchCurrentStats> {
  const input = record(value, "branch_current_stats_a");
  return Object.fromEntries(
    Object.entries(input).map(([key, item]) => [
      key,
      parseCurrentStats(item, `branch_current_stats_a.${key}`, axis),
    ]),
  );
}

function parseVoltageStats(
  value: unknown,
  name: string,
  axis: "time" | "source",
): NodeVoltageStats {
  const keys = axis === "time"
    ? ["min_v", "max_v", "final_v", "min_at_s", "max_at_s", "final_at_s"]
    : [
      "min_v",
      "max_v",
      "final_v",
      "min_at_source_v",
      "max_at_source_v",
      "final_at_source_v",
    ];
  const root = exactRecord(value, keys, name);
  return {
    min_v: finiteNumber(root.min_v, `${name}.min_v`),
    max_v: finiteNumber(root.max_v, `${name}.max_v`),
    final_v: finiteNumber(root.final_v, `${name}.final_v`),
    ...(axis === "time"
      ? {
        min_at_s: finiteNumber(root.min_at_s, `${name}.min_at_s`),
        max_at_s: finiteNumber(root.max_at_s, `${name}.max_at_s`),
        final_at_s: finiteNumber(root.final_at_s, `${name}.final_at_s`),
      }
      : {
        min_at_source_v: finiteNumber(
          root.min_at_source_v,
          `${name}.min_at_source_v`,
        ),
        max_at_source_v: finiteNumber(
          root.max_at_source_v,
          `${name}.max_at_source_v`,
        ),
        final_at_source_v: finiteNumber(
          root.final_at_source_v,
          `${name}.final_at_source_v`,
        ),
      }),
  };
}

function parseCurrentStats(
  value: unknown,
  name: string,
  axis: "time" | "source",
): BranchCurrentStats {
  const keys = axis === "time"
    ? ["min_a", "max_a", "final_a", "min_at_s", "max_at_s", "final_at_s"]
    : [
      "min_a",
      "max_a",
      "final_a",
      "min_at_source_v",
      "max_at_source_v",
      "final_at_source_v",
    ];
  const root = exactRecord(value, keys, name);
  return {
    min_a: finiteNumber(root.min_a, `${name}.min_a`),
    max_a: finiteNumber(root.max_a, `${name}.max_a`),
    final_a: finiteNumber(root.final_a, `${name}.final_a`),
    ...(axis === "time"
      ? {
        min_at_s: finiteNumber(root.min_at_s, `${name}.min_at_s`),
        max_at_s: finiteNumber(root.max_at_s, `${name}.max_at_s`),
        final_at_s: finiteNumber(root.final_at_s, `${name}.final_at_s`),
      }
      : {
        min_at_source_v: finiteNumber(
          root.min_at_source_v,
          `${name}.min_at_source_v`,
        ),
        max_at_source_v: finiteNumber(
          root.max_at_source_v,
          `${name}.max_at_source_v`,
        ),
        final_at_source_v: finiteNumber(
          root.final_at_source_v,
          `${name}.final_at_source_v`,
        ),
      }),
  };
}

function jsonTextFallback(
  content: unknown,
): Record<string, unknown> | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (
      !isRecord(item) || item.type !== "text" || typeof item.text !== "string"
    ) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(item.text);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Human-readable summaries remain valid text blocks.
    }
  }
  return undefined;
}

export function sortedEntries<T>(
  value: Readonly<Record<string, T>>,
): readonly (readonly [string, T])[] {
  return (Object.entries(value) as [string, T][]).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

export function compactVoltageReadings(
  voltages: Readonly<Record<string, number>>,
): { readonly entries: readonly CompactReading[]; readonly omitted: number } {
  const all = sortedEntries(voltages).map(([id, value]) => ({
    id,
    label: id,
    value,
    unit: "V" as const,
  }));
  return {
    entries: all.slice(0, COMPACT_READING_LIMIT),
    omitted: Math.max(0, all.length - COMPACT_READING_LIMIT),
  };
}

export function compactCurrentReadings(
  currents: Readonly<Record<string, number>>,
): { readonly entries: readonly CompactReading[]; readonly omitted: number } {
  const all = sortedEntries(currents).map(([id, value]) => ({
    id,
    label: id,
    value,
    unit: "A" as const,
  }));
  return {
    entries: all.slice(0, COMPACT_READING_LIMIT),
    omitted: Math.max(0, all.length - COMPACT_READING_LIMIT),
  };
}
