/** Strict read-only envelope accepted from a recording host. */

import {
  SPICE_RECORDED_OPERATING_POINT_SOURCE_SCHEMA_IDS,
  SPICE_VIEW_CONTRACTS,
  type SpiceViewKey,
} from "../view-app-manifest.ts";
import {
  isSimulationViewDataForView,
  type SimulationResultViewKey,
} from "../simulation-result/src/model.ts";
import { isReceiptViewData } from "../simulation-receipt/src/model.ts";
import {
  isRecordedAdmittedSpiceContent,
  SPICE_ADMITTED_EXECUTION_CAPTURE_SCHEMA,
  SPICE_ADMITTED_OPERATING_POINT_RESULT_SCHEMA,
} from "../simulation-result/src/recorded-admitted.ts";

export interface SpiceRecordedViewSession {
  readonly schemaVersion: (typeof SPICE_VIEW_CONTRACTS)[SpiceViewKey][
    "sessionSchema"
  ];
  readonly resourceUri: (typeof SPICE_VIEW_CONTRACTS)[SpiceViewKey]["uri"];
  readonly resultSchema: string;
  readonly readOnly: true;
  readonly basis: {
    readonly projectId: string;
    readonly projectRevision: number;
    readonly subjectId: string;
    readonly thread: { readonly id: string; readonly revision: number };
    readonly artifact: { readonly id: string; readonly fingerprint: string };
  };
  readonly projectionFingerprint: string;
  readonly structuredContent: unknown;
}

/** Synchronous structural gate installed before the App connects to its host. */
export function isSpiceRecordedViewSession(
  view: SpiceViewKey,
  value: unknown,
): value is SpiceRecordedViewSession {
  const contract = SPICE_VIEW_CONTRACTS[view];
  return isExactRecord(value, [
    "schemaVersion",
    "resourceUri",
    "resultSchema",
    "readOnly",
    "basis",
    "projectionFingerprint",
    "structuredContent",
  ]) &&
    value.schemaVersion === contract.sessionSchema &&
    value.resourceUri === contract.uri &&
    isResultSchemaForView(view, value.resultSchema) &&
    value.readOnly === true &&
    isSha256Fingerprint(value.projectionFingerprint) &&
    isRecordedBasis(value.basis) &&
    isStructuredContentForView(
      view,
      value.resultSchema,
      value.structuredContent,
    );
}

/** Verify the full projection digest before exposing recorded structured data. */
export async function parseSpiceRecordedViewSession(
  view: SpiceViewKey,
  value: unknown,
): Promise<SpiceRecordedViewSession | undefined> {
  if (!isSpiceRecordedViewSession(view, value)) return undefined;
  let projectionFingerprint: string;
  try {
    projectionFingerprint = await fingerprintSpiceRecordedProjection({
      schemaVersion: value.schemaVersion,
      resourceUri: value.resourceUri,
      resultSchema: value.resultSchema,
      readOnly: true,
      basis: value.basis,
      structuredContent: value.structuredContent,
    });
  } catch {
    return undefined;
  }
  if (projectionFingerprint !== value.projectionFingerprint) return undefined;
  if (isAdmittedArtifactSchema(value.resultSchema)) {
    const artifactFingerprint = await fingerprintJsonValue(
      value.structuredContent,
    );
    if (artifactFingerprint !== value.basis.artifact.fingerprint) {
      return undefined;
    }
    const prefix = value.resultSchema === SPICE_ADMITTED_EXECUTION_CAPTURE_SCHEMA
      ? "spice-admitted-capture-"
      : "spice-admitted-result-";
    if (
      value.basis.artifact.id !==
        `${prefix}${artifactFingerprint.slice("sha256:".length)}`
    ) return undefined;
  }
  return deepFreeze(structuredClone(value));
}

/** Digest the complete read model, excluding only its own digest field. */
export async function fingerprintSpiceRecordedProjection(
  value: Omit<SpiceRecordedViewSession, "projectionFingerprint">,
): Promise<`sha256:${string}`> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
}

function isStructuredContentForView(
  view: SpiceViewKey,
  resultSchema: unknown,
  value: unknown,
): boolean {
  if (
    view === "operatingPoint" && typeof resultSchema === "string" &&
    isAdmittedArtifactSchema(resultSchema)
  ) return isRecordedAdmittedSpiceContent(resultSchema, value);
  return view === "simulationReceipt"
    ? isReceiptViewData(value)
    : isSimulationViewDataForView(view as SimulationResultViewKey, value);
}

function isResultSchemaForView(
  view: SpiceViewKey,
  value: unknown,
): value is string {
  if (typeof value !== "string") return false;
  if (view === "operatingPoint") {
    return (SPICE_RECORDED_OPERATING_POINT_SOURCE_SCHEMA_IDS as readonly string[])
      .includes(value);
  }
  return value === SPICE_VIEW_CONTRACTS[view].resultSchema;
}

function isAdmittedArtifactSchema(value: string): boolean {
  return value === SPICE_ADMITTED_EXECUTION_CAPTURE_SCHEMA ||
    value === SPICE_ADMITTED_OPERATING_POINT_RESULT_SCHEMA;
}

async function fingerprintJsonValue(value: unknown): Promise<`sha256:${string}`> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
}

function isRecordedBasis(value: unknown): boolean {
  return isExactRecord(value, [
    "projectId",
    "projectRevision",
    "subjectId",
    "thread",
    "artifact",
  ]) &&
    isNonEmptyString(value.projectId) &&
    isRevision(value.projectRevision) &&
    isNonEmptyString(value.subjectId) &&
    isExactRecord(value.thread, ["id", "revision"]) &&
    isNonEmptyString(value.thread.id) &&
    isRevision(value.thread.revision) &&
    isExactRecord(value.artifact, ["id", "fingerprint"]) &&
    isNonEmptyString(value.artifact.id) &&
    isSha256Fingerprint(value.artifact.fingerprint);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSha256Fingerprint(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isDenseJsonArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return true;
}

function canonicalJson(value: unknown): string {
  if (
    value === null || typeof value === "string" ||
    typeof value === "boolean"
  ) return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (!isDenseJsonArray(value)) {
      throw new TypeError("Recorded SPICE arrays must be dense and unadorned");
    }
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    const members = Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",");
    return `{${members}}`;
  }
  throw new TypeError("Recorded SPICE projections must contain JSON values only");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return value;
}
