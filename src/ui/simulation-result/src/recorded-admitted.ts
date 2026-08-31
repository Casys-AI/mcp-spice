/**
 * Provider-owned adapter for exact admitted-SPICE artifacts recorded by a
 * Digital Thread. These are not mcp-spice tool results and are never rewritten
 * into one: their literal versioned schema remains part of the view model.
 */

import {
  exactRecord,
  finiteNumber,
  literal,
  nonEmptyString,
  nonNegativeInteger,
  record,
  sha256,
} from "../../shared/closed-json.ts";

export const SPICE_ADMITTED_OPERATING_POINT_RESULT_SCHEMA =
  "spice-operating-point-result/1.0" as const;
export const SPICE_ADMITTED_EXECUTION_CAPTURE_SCHEMA =
  "spice-admitted-execution-capture/1.0" as const;

export type RecordedAdmittedSpiceSchema =
  | typeof SPICE_ADMITTED_OPERATING_POINT_RESULT_SCHEMA
  | typeof SPICE_ADMITTED_EXECUTION_CAPTURE_SCHEMA;

export interface RecordedSpiceArtifactBasis {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly subjectId: string;
  readonly thread: { readonly id: string; readonly revision: number };
  readonly artifact: { readonly id: string; readonly fingerprint: string };
  readonly projectionFingerprint: string;
}

export interface AdmittedSpiceObservable {
  readonly nativeName: string;
  readonly kind: "node-voltage" | "branch-current";
  readonly sourceSymbol: string;
  readonly value: number;
  readonly unit: "V" | "A";
}

export interface RecordedAdmittedOperatingPointView {
  readonly kind: "recorded-admitted-operating-point";
  readonly source: "recorded-admitted";
  readonly sourceSchema: RecordedAdmittedSpiceSchema;
  readonly analysisKind: "operating-point";
  readonly observables: readonly AdmittedSpiceObservable[];
  readonly signConvention?: {
    readonly kind: "ngspice-native";
    readonly voltageSourceBranchCurrent: "positive-into-positive-terminal";
    readonly passiveCurrent: "positive-from-first-named-node-to-second";
  };
  readonly execution?: {
    readonly agentRunId: string;
    readonly executionRunId: string;
    readonly engine: { readonly name: "ngspice"; readonly version: string };
    readonly sourceSha256: string;
    readonly receiptFingerprint: string;
    readonly evidenceSha256: string;
    readonly resultSha256: string;
    readonly termination: "exited:0";
    readonly counts: {
      readonly sourceBytes: number;
      readonly observableCount: number;
      readonly nodeVoltageCount: number;
      readonly branchCurrentCount: number;
    };
    readonly limitations: readonly [
      "documentary-operating-point-only",
      "not-a-requirement-verdict",
      "not-l4",
      "not-safety-claim",
    ];
  };
  readonly recorded: RecordedSpiceArtifactBasis;
}

interface ParsedAdmittedContent {
  readonly sourceSchema: RecordedAdmittedSpiceSchema;
  readonly analysisKind: "operating-point";
  readonly observables: readonly AdmittedSpiceObservable[];
  readonly signConvention?: RecordedAdmittedOperatingPointView["signConvention"];
  readonly projectId?: string;
  readonly execution?: RecordedAdmittedOperatingPointView["execution"];
}

export function isRecordedAdmittedSpiceContent(
  schema: string,
  value: unknown,
): boolean {
  try {
    parseRecordedAdmittedContent(schema, value);
    return true;
  } catch {
    return false;
  }
}

export function parseRecordedAdmittedSpiceView(
  schema: string,
  value: unknown,
  recorded: RecordedSpiceArtifactBasis,
): RecordedAdmittedOperatingPointView {
  const parsed = parseRecordedAdmittedContent(schema, value);
  if (parsed.projectId !== undefined && parsed.projectId !== recorded.projectId) {
    throw new TypeError(
      "The admitted SPICE capture project does not match the recorded session basis.",
    );
  }
  return {
    kind: "recorded-admitted-operating-point",
    source: "recorded-admitted",
    sourceSchema: parsed.sourceSchema,
    analysisKind: parsed.analysisKind,
    observables: parsed.observables,
    ...(parsed.signConvention ? { signConvention: parsed.signConvention } : {}),
    ...(parsed.execution ? { execution: parsed.execution } : {}),
    recorded,
  };
}

function parseRecordedAdmittedContent(
  schema: string,
  value: unknown,
): ParsedAdmittedContent {
  if (schema === SPICE_ADMITTED_OPERATING_POINT_RESULT_SCHEMA) {
    return parseOperatingPointResult(value);
  }
  if (schema === SPICE_ADMITTED_EXECUTION_CAPTURE_SCHEMA) {
    return parseExecutionCapture(value);
  }
  throw new TypeError("Unsupported recorded admitted SPICE schema.");
}

function parseOperatingPointResult(value: unknown): ParsedAdmittedContent {
  const root = exactRecord(value, [
    "schemaVersion",
    "analysisKind",
    "signConvention",
    "observables",
  ], "admitted SPICE operating-point result");
  literal(
    root.schemaVersion,
    SPICE_ADMITTED_OPERATING_POINT_RESULT_SCHEMA,
    "result.schemaVersion",
  );
  literal(root.analysisKind, "operating-point", "result.analysisKind");
  const sign = exactRecord(root.signConvention, [
    "kind",
    "voltageSourceBranchCurrent",
    "passiveCurrent",
  ], "result.signConvention");
  return {
    sourceSchema: SPICE_ADMITTED_OPERATING_POINT_RESULT_SCHEMA,
    analysisKind: "operating-point",
    signConvention: {
      kind: literal(sign.kind, "ngspice-native", "signConvention.kind"),
      voltageSourceBranchCurrent: literal(
        sign.voltageSourceBranchCurrent,
        "positive-into-positive-terminal",
        "signConvention.voltageSourceBranchCurrent",
      ),
      passiveCurrent: literal(
        sign.passiveCurrent,
        "positive-from-first-named-node-to-second",
        "signConvention.passiveCurrent",
      ),
    },
    observables: parseObservables(root.observables),
  };
}

function parseExecutionCapture(value: unknown): ParsedAdmittedContent {
  const root = exactRecord(value, [
    "schemaVersion",
    "operation",
    "projectId",
    "agentRunId",
    "executionRunId",
    "admission",
    "sourceSha256",
    "receipt",
    "analysisKind",
    "engine",
    "observables",
    "counts",
    "limitations",
  ], "admitted SPICE execution capture");
  literal(
    root.schemaVersion,
    SPICE_ADMITTED_EXECUTION_CAPTURE_SCHEMA,
    "capture.schemaVersion",
  );
  const operation = exactRecord(
    root.operation,
    ["id", "version"],
    "capture.operation",
  );
  literal(operation.id, "simulate.run-admitted-spice", "capture.operation.id");
  literal(operation.version, "1", "capture.operation.version");
  const projectId = nonEmptyString(root.projectId, "capture.projectId");
  const agentRunId = nonEmptyString(root.agentRunId, "capture.agentRunId");
  const executionRunId = nonEmptyString(
    root.executionRunId,
    "capture.executionRunId",
  );
  parseAdmission(root.admission);
  const sourceSha256 = sha256(root.sourceSha256, "capture.sourceSha256");
  literal(root.analysisKind, "operating-point", "capture.analysisKind");
  const engine = exactRecord(root.engine, ["name", "version"], "capture.engine");
  literal(engine.name, "ngspice", "capture.engine.name");
  const engineVersion = nonEmptyString(engine.version, "capture.engine.version");
  if (!/^[0-9]{1,8}$/.test(engineVersion)) {
    throw new TypeError("capture.engine.version must be an ngspice major version.");
  }
  const observables = parseObservables(root.observables);
  const counts = parseCounts(root.counts, observables);
  const limitations = parseLimitations(root.limitations);
  const receipt = parseReceipt(root.receipt, executionRunId, sourceSha256);
  return {
    sourceSchema: SPICE_ADMITTED_EXECUTION_CAPTURE_SCHEMA,
    analysisKind: "operating-point",
    projectId,
    observables,
    execution: {
      agentRunId,
      executionRunId,
      engine: { name: "ngspice", version: engineVersion },
      sourceSha256,
      receiptFingerprint: receipt.fingerprint,
      evidenceSha256: receipt.evidenceSha256,
      resultSha256: receipt.resultSha256,
      termination: "exited:0",
      counts,
      limitations,
    },
  };
}

function parseAdmission(value: unknown): void {
  const admission = exactRecord(value, [
    "schemaVersion",
    "admissionArtifact",
    "compilation",
    "execution",
    "status",
  ], "capture.admission");
  literal(
    admission.schemaVersion,
    "spice-admitted-run-admission/2.0",
    "capture.admission.schemaVersion",
  );
  literal(
    admission.status,
    "ready-for-execution-review",
    "capture.admission.status",
  );
  assertJsonValue(admission.admissionArtifact, "capture.admission.admissionArtifact");
  assertJsonValue(admission.compilation, "capture.admission.compilation");
  assertJsonValue(admission.execution, "capture.admission.execution");
}

function parseReceipt(
  value: unknown,
  executionRunId: string,
  sourceSha256: string,
): { fingerprint: string; evidenceSha256: string; resultSha256: string } {
  const receipt = exactRecord(value, [
    "schemaVersion",
    "receiptSchemaVersion",
    "runId",
    "producerGeneration",
    "profile",
    "sourceSha256",
    "policy",
    "runtime",
    "termination",
    "logs",
    "outputs",
    "destruction",
    "publication",
    "fingerprint",
  ], "capture.receipt");
  literal(
    receipt.schemaVersion,
    "isolated-code-execution-receipt-record/1.0",
    "capture.receipt.schemaVersion",
  );
  literal(
    receipt.receiptSchemaVersion,
    "isolated-code-execution-receipt/1.0",
    "capture.receipt.receiptSchemaVersion",
  );
  if (receipt.runId !== executionRunId) {
    throw new TypeError("capture.receipt.runId must match executionRunId.");
  }
  if (receipt.producerGeneration !== 0 && receipt.producerGeneration !== 1) {
    throw new TypeError("capture.receipt.producerGeneration must be 0 or 1.");
  }
  if (sha256(receipt.sourceSha256, "capture.receipt.sourceSha256") !== sourceSha256) {
    throw new TypeError(
      "capture.receipt.sourceSha256 must match capture.sourceSha256.",
    );
  }
  const termination = exactRecord(
    receipt.termination,
    ["kind", "exitCode", "signal"],
    "capture.receipt.termination",
  );
  literal(termination.kind, "exited", "capture.receipt.termination.kind");
  if (termination.exitCode !== 0 || termination.signal !== null) {
    throw new TypeError("capture.receipt.termination must be exited with code 0.");
  }
  for (
    const key of [
      "profile",
      "policy",
      "runtime",
      "logs",
      "destruction",
      "publication",
    ]
  ) {
    assertJsonValue(receipt[key], `capture.receipt.${key}`);
  }
  if (!Array.isArray(receipt.outputs) || receipt.outputs.length !== 2) {
    throw new TypeError("capture.receipt.outputs must contain evidence and result.");
  }
  const outputs = receipt.outputs.map((output, index) =>
    parseOutput(output, `capture.receipt.outputs[${index}]`)
  );
  const evidence = outputs.find((output) => output.role === "evidence");
  const result = outputs.find((output) => output.role === "result");
  if (!evidence || !result) {
    throw new TypeError("capture.receipt.outputs must contain evidence and result.");
  }
  return {
    fingerprint: parseFingerprint(receipt.fingerprint, "capture.receipt.fingerprint"),
    evidenceSha256: evidence.sha256,
    resultSha256: result.sha256,
  };
}

function parseOutput(
  value: unknown,
  path: string,
): { role: string; sha256: string } {
  const output = exactRecord(value, [
    "role",
    "basename",
    "mediaType",
    "format",
    "byteCount",
    "sha256",
    "casUri",
    "validation",
    "persistence",
  ], path);
  const role = nonEmptyString(output.role, `${path}.role`);
  if (role !== "evidence" && role !== "result") {
    throw new TypeError(`${path}.role must be evidence or result.`);
  }
  nonEmptyString(output.basename, `${path}.basename`);
  literal(output.mediaType, "application/json", `${path}.mediaType`);
  nonEmptyString(output.format, `${path}.format`);
  nonNegativeInteger(output.byteCount, `${path}.byteCount`);
  const digest = sha256(output.sha256, `${path}.sha256`);
  if (output.casUri !== `casys://isolated-output/sha256/${digest}`) {
    throw new TypeError(`${path}.casUri must match its SHA-256.`);
  }
  literal(output.validation, "accepted", `${path}.validation`);
  literal(
    output.persistence,
    "staged-reread-atomic-commit",
    `${path}.persistence`,
  );
  return { role, sha256: digest };
}

function parseCounts(
  value: unknown,
  observables: readonly AdmittedSpiceObservable[],
): NonNullable<RecordedAdmittedOperatingPointView["execution"]>["counts"] {
  const counts = exactRecord(value, [
    "sourceBytes",
    "observableCount",
    "nodeVoltageCount",
    "branchCurrentCount",
  ], "capture.counts");
  const parsed = {
    sourceBytes: nonNegativeInteger(counts.sourceBytes, "capture.counts.sourceBytes"),
    observableCount: nonNegativeInteger(
      counts.observableCount,
      "capture.counts.observableCount",
    ),
    nodeVoltageCount: nonNegativeInteger(
      counts.nodeVoltageCount,
      "capture.counts.nodeVoltageCount",
    ),
    branchCurrentCount: nonNegativeInteger(
      counts.branchCurrentCount,
      "capture.counts.branchCurrentCount",
    ),
  };
  if (
    parsed.observableCount !== observables.length ||
    parsed.nodeVoltageCount !==
      observables.filter((item) => item.kind === "node-voltage").length ||
    parsed.branchCurrentCount !==
      observables.filter((item) => item.kind === "branch-current").length
  ) {
    throw new TypeError("capture.counts must match the exact observables.");
  }
  return parsed;
}

function parseLimitations(
  value: unknown,
): NonNullable<RecordedAdmittedOperatingPointView["execution"]>["limitations"] {
  const expected = [
    "documentary-operating-point-only",
    "not-a-requirement-verdict",
    "not-l4",
    "not-safety-claim",
  ] as const;
  if (
    !Array.isArray(value) || value.length !== expected.length ||
    value.some((item, index) => item !== expected[index])
  ) {
    throw new TypeError("capture.limitations must match the admitted contract.");
  }
  return expected;
}

function parseObservables(value: unknown): readonly AdmittedSpiceObservable[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2_048) {
    throw new TypeError("observables must contain 1 to 2048 entries.");
  }
  const observables = value.map((item, index) => {
    const path = `observables[${index}]`;
    const observable = exactRecord(item, [
      "nativeName",
      "kind",
      "sourceSymbol",
      "value",
      "unit",
    ], path);
    const nativeName = nonEmptyString(observable.nativeName, `${path}.nativeName`);
    if (
      !/^(?:v\([a-z0-9_]{1,64}\)|i\([a-z0-9_]{1,64}\)|@[a-z][a-z0-9_]{0,63}\[[a-z]{1,16}\])$/
        .test(nativeName)
    ) {
      throw new TypeError(`${path}.nativeName is unsupported.`);
    }
    const kind = observable.kind;
    if (kind !== "node-voltage" && kind !== "branch-current") {
      throw new TypeError(`${path}.kind is unsupported.`);
    }
    const unit = observable.unit;
    if (
      (kind === "node-voltage" && unit !== "V") ||
      (kind === "branch-current" && unit !== "A")
    ) {
      throw new TypeError(`${path}.unit does not match its observable kind.`);
    }
    return {
      nativeName,
      kind,
      sourceSymbol: nonEmptyString(observable.sourceSymbol, `${path}.sourceSymbol`),
      value: finiteNumber(observable.value, `${path}.value`),
      unit,
    } as AdmittedSpiceObservable;
  });
  for (let index = 1; index < observables.length; index += 1) {
    if (observables[index - 1]!.nativeName >= observables[index]!.nativeName) {
      throw new TypeError("observables must be strictly ordered by nativeName.");
    }
  }
  return observables;
}

function parseFingerprint(value: unknown, path: string): string {
  const fingerprint = exactRecord(value, ["algorithm", "digest"], path);
  literal(fingerprint.algorithm, "sha256", `${path}.algorithm`);
  return `sha256:${sha256(fingerprint.digest, `${path}.digest`)}`;
}

function assertJsonValue(value: unknown, path: string): void {
  if (
    value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  const object = record(value, path);
  for (const [key, item] of Object.entries(object)) {
    if (item === undefined) throw new TypeError(`${path}.${key} is not JSON.`);
    assertJsonValue(item, `${path}.${key}`);
  }
}
