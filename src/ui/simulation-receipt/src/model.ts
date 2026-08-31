/**
 * Schema adapter for spice_simulation_receipt_get. The receipt stays a
 * documentary provider record: execution_state is copied literally.
 */

import {
  errorMessage,
  exactRecord,
  finiteNumber,
  isRecord,
  literal,
  nonEmptyString,
  record,
  sha256,
  stringArray,
} from "../../shared/closed-json.ts";

export type AnalysisKind = "op" | "tran" | "dc";
export type ReceiptExecutionState = "succeeded" | "failed";

export interface RuntimeIdentity {
  readonly mcp_spice_version: string;
  readonly execution_budgets: string;
  readonly deno_version: string;
  readonly os: string;
  readonly arch: string;
  readonly ngspice_version: string;
  readonly ngspice_version_sha256: string;
}

export type NormalizedRequest =
  | {
    readonly kind: "op";
    readonly nodes: readonly string[];
    readonly branch_sources: readonly string[];
    readonly timeout_s: number;
  }
  | {
    readonly kind: "tran";
    readonly tstep_s: number;
    readonly tstop_s: number;
    readonly nodes: readonly string[];
    readonly branch_sources: readonly string[];
    readonly timeout_s: number;
  }
  | {
    readonly kind: "dc";
    readonly sweep_source: string;
    readonly start_v: number;
    readonly stop_v: number;
    readonly step_v: number;
    readonly nodes: readonly string[];
    readonly branch_sources: readonly string[];
    readonly timeout_s: number;
  };

export interface SimulationReceipt {
  readonly type: "spice-simulation-receipt/1.0";
  readonly request_sha256: string;
  readonly dispatch_sha256: string;
  readonly analysis_kind: AnalysisKind;
  readonly netlist_sha256: string;
  readonly normalized_request: NormalizedRequest;
  readonly runtime_identity: RuntimeIdentity;
  readonly outcome_sha256: string;
  readonly execution_state: ReceiptExecutionState;
}

export interface ReceiptViewData {
  readonly kind: "simulation-receipt";
  readonly receipt_sha256: string;
  readonly receipt: SimulationReceipt;
}

export type ReceiptDisplayState =
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "result"; readonly result: ReceiptViewData };

export function parseReceiptViewData(value: unknown): ReceiptViewData {
  const root = exactRecord(
    value,
    ["receipt_sha256", "receipt"],
    "spice_simulation_receipt_get structuredContent",
  );
  const receipt_sha256 = sha256(root.receipt_sha256, "receipt_sha256");
  const receipt = parseReceipt(root.receipt);
  return { kind: "simulation-receipt", receipt_sha256, receipt };
}

export function displayStateFromReceiptToolResult(
  value: unknown,
): ReceiptDisplayState {
  const result = record(value, "tool result");
  if (result.isError === true) {
    return { kind: "error", message: toolErrorMessage(result) };
  }
  const structured = result.structuredContent !== undefined
    ? (isRecord(result.structuredContent) ? result.structuredContent : undefined)
    : jsonTextFallback(result.content);
  if (structured === undefined) return { kind: "empty" };
  try {
    return { kind: "result", result: parseReceiptViewData(structured) };
  } catch (error) {
    return { kind: "error", message: errorMessage(error) };
  }
}

export function toolErrorMessage(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return "The receipt readback reported an error.";
  }
  const text = value.content.find((item) => isRecord(item) && item.type === "text")
    ?.text;
  return typeof text === "string" && text.trim()
    ? text
    : "The receipt readback reported an error.";
}

function parseReceipt(value: unknown): SimulationReceipt {
  const root = exactRecord(value, [
    "type",
    "request_sha256",
    "dispatch_sha256",
    "analysis_kind",
    "netlist_sha256",
    "normalized_request",
    "runtime_identity",
    "outcome_sha256",
    "execution_state",
  ], "receipt");
  const analysis_kind = parseAnalysisKind(root.analysis_kind);
  return {
    type: literal(root.type, "spice-simulation-receipt/1.0", "receipt.type"),
    request_sha256: sha256(root.request_sha256, "receipt.request_sha256"),
    dispatch_sha256: sha256(root.dispatch_sha256, "receipt.dispatch_sha256"),
    analysis_kind,
    netlist_sha256: sha256(root.netlist_sha256, "receipt.netlist_sha256"),
    normalized_request: parseNormalizedRequest(
      root.normalized_request,
      analysis_kind,
    ),
    runtime_identity: parseRuntimeIdentity(root.runtime_identity),
    outcome_sha256: sha256(root.outcome_sha256, "receipt.outcome_sha256"),
    execution_state: parseExecutionState(root.execution_state),
  };
}

function parseAnalysisKind(value: unknown): AnalysisKind {
  if (value === "op" || value === "tran" || value === "dc") return value;
  throw new TypeError("receipt.analysis_kind must be op, tran, or dc.");
}

function parseExecutionState(value: unknown): ReceiptExecutionState {
  if (value === "succeeded" || value === "failed") return value;
  throw new TypeError(
    "receipt.execution_state must be succeeded or failed.",
  );
}

function parseRuntimeIdentity(value: unknown): RuntimeIdentity {
  const root = exactRecord(value, [
    "mcp_spice_version",
    "execution_budgets",
    "deno_version",
    "os",
    "arch",
    "ngspice_version",
    "ngspice_version_sha256",
  ], "runtime_identity");
  return {
    mcp_spice_version: nonEmptyString(
      root.mcp_spice_version,
      "runtime_identity.mcp_spice_version",
    ),
    execution_budgets: nonEmptyString(
      root.execution_budgets,
      "runtime_identity.execution_budgets",
    ),
    deno_version: nonEmptyString(
      root.deno_version,
      "runtime_identity.deno_version",
    ),
    os: nonEmptyString(root.os, "runtime_identity.os"),
    arch: nonEmptyString(root.arch, "runtime_identity.arch"),
    ngspice_version: nonEmptyString(
      root.ngspice_version,
      "runtime_identity.ngspice_version",
    ),
    ngspice_version_sha256: sha256(
      root.ngspice_version_sha256,
      "runtime_identity.ngspice_version_sha256",
    ),
  };
}

function parseNormalizedRequest(
  value: unknown,
  analysisKind: AnalysisKind,
): NormalizedRequest {
  const root = record(value, "normalized_request");
  if (analysisKind === "op") {
    exactRecord(
      root,
      ["nodes", "branch_sources", "timeout_s"],
      "normalized_request",
    );
    return {
      kind: "op",
      nodes: stringArray(root.nodes, "normalized_request.nodes"),
      branch_sources: stringArray(
        root.branch_sources,
        "normalized_request.branch_sources",
      ),
      timeout_s: finiteNumber(root.timeout_s, "normalized_request.timeout_s"),
    };
  }
  if (analysisKind === "tran") {
    exactRecord(root, [
      "tstep_s",
      "tstop_s",
      "nodes",
      "branch_sources",
      "timeout_s",
    ], "normalized_request");
    return {
      kind: "tran",
      tstep_s: finiteNumber(root.tstep_s, "normalized_request.tstep_s"),
      tstop_s: finiteNumber(root.tstop_s, "normalized_request.tstop_s"),
      nodes: stringArray(root.nodes, "normalized_request.nodes"),
      branch_sources: stringArray(
        root.branch_sources,
        "normalized_request.branch_sources",
      ),
      timeout_s: finiteNumber(root.timeout_s, "normalized_request.timeout_s"),
    };
  }
  exactRecord(root, [
    "sweep_source",
    "start_v",
    "stop_v",
    "step_v",
    "nodes",
    "branch_sources",
    "timeout_s",
  ], "normalized_request");
  return {
    kind: "dc",
    sweep_source: nonEmptyString(
      root.sweep_source,
      "normalized_request.sweep_source",
    ),
    start_v: finiteNumber(root.start_v, "normalized_request.start_v"),
    stop_v: finiteNumber(root.stop_v, "normalized_request.stop_v"),
    step_v: finiteNumber(root.step_v, "normalized_request.step_v"),
    nodes: stringArray(root.nodes, "normalized_request.nodes"),
    branch_sources: stringArray(
      root.branch_sources,
      "normalized_request.branch_sources",
    ),
    timeout_s: finiteNumber(root.timeout_s, "normalized_request.timeout_s"),
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
