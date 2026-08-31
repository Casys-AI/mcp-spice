/**
 * Durable, documentary records for provider simulation dispatches.
 *
 * The netlist CAS proves submitted source bytes. This module separately
 * records the provider transaction around an ngspice invocation:
 *
 *   dispatch (acknowledged) -> result -> receipt -> publication
 *
 * Results and receipts are canonical JSON addressed by their exact SHA-256.
 * The acknowledgement file is instead keyed by a canonical request SHA-256,
 * while its verified integrity SHA-256 binds the complete provider/runtime/
 * budget document. Thus a runtime upgrade cannot silently retry an ACK-only
 * request, and a bit flip in its runtime remains detectable.
 * The dispatch is intentionally published before ngspice starts. A later
 * process that sees an acknowledged dispatch without its publication must fail
 * closed: it cannot know whether the process was interrupted before, during,
 * or after the provider invocation.
 *
 * These are provider documentary records only. They are not Digital Thread
 * evidence and do not authorize or replace simulate.run-admitted-spice@1.
 */

import { dirname, join } from "@std/path";
import { EXECUTION_BUDGETS_VERSION, NETLIST_MAX_BYTES } from "./execution-budgets.ts";
import { readImmutableFileWithinLimit } from "./immutable-file.ts";
import { sha256Hex } from "./netlist-artifact.ts";
import { normalizeSha256, resolveNetlistStoreDir } from "./netlist-store.ts";
import {
  NgspiceNotFoundError,
  readNgspiceOutputWithinLimit,
  SpiceError,
} from "./ngspice.ts";
import { isMachineReadableError, SpiceToolError } from "./tool-error.ts";

export const MCP_SPICE_VERSION = "0.6.2";

const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_RUNTIME_IDENTITY_BYTES = 8 * 1024;
const MAX_DURABLE_DOCUMENT_BYTES = 1_048_576;
const RUNTIME_IDENTITY_TIMEOUT_MS = 1_000;
const ACKNOWLEDGED_PUBLICATION_WAIT_MS = 1_000;
const ACKNOWLEDGED_PUBLICATION_POLL_MS = 50;

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = { [key: string]: JsonValue };

export type AnalysisKind = "op" | "tran" | "dc";
export type SimulationExecutionState = "succeeded" | "failed";

export interface RuntimeIdentity extends JsonRecord {
  mcp_spice_version: string;
  execution_budgets: string;
  deno_version: string;
  os: string;
  arch: string;
  ngspice_version: string;
  ngspice_version_sha256: string;
}

export interface SimulationDispatch extends JsonRecord {
  type: "spice-simulation-dispatch/1.0";
  request_sha256: string;
  analysis_kind: AnalysisKind;
  netlist_sha256: string;
  normalized_request: JsonRecord;
  runtime_identity: RuntimeIdentity;
  execution_state: "acknowledged";
  integrity_sha256: string;
}

export interface SimulationReceipt extends JsonRecord {
  type: "spice-simulation-receipt/1.0";
  request_sha256: string;
  dispatch_sha256: string;
  analysis_kind: AnalysisKind;
  netlist_sha256: string;
  normalized_request: JsonRecord;
  runtime_identity: RuntimeIdentity;
  outcome_sha256: string;
  execution_state: SimulationExecutionState;
}

interface SimulationPublication extends JsonRecord {
  type: "spice-simulation-publication/1.0";
  request_sha256: string;
  dispatch_sha256: string;
  receipt_sha256: string;
  outcome_sha256: string;
  execution_state: SimulationExecutionState;
  integrity_sha256: string;
}

export interface DispatchStart {
  request_sha256: string;
  dispatch_sha256: string;
  dispatch: SimulationDispatch;
  status: "started" | "published";
  receipt_sha256?: string;
  outcome_sha256?: string;
  execution_state?: SimulationExecutionState;
}

export interface PublishedSimulation {
  request_sha256: string;
  dispatch_sha256: string;
  receipt_sha256: string;
  outcome_sha256: string;
  execution_state: SimulationExecutionState;
}

let configuredReceiptStoreDir: string | undefined;

/** Test hook. Pass undefined to restore environment/default resolution. */
export function configureReceiptStoreDir(dir: string | undefined): void {
  configuredReceiptStoreDir = dir;
}

/**
 * Root of the durable documentary store. It intentionally shares the named
 * run volume with netlists by default, while keeping all namespaces separate.
 */
export function resolveReceiptStoreDir(): string {
  if (configuredReceiptStoreDir !== undefined) return configuredReceiptStoreDir;
  const netlistStore = Deno.env.get("SPICE_NETLIST_STORE");
  if (netlistStore && netlistStore.trim()) {
    return join(dirname(netlistStore), "receipts");
  }
  const root = Deno.env.get("NGSPICE_RUNS_DIR") ?? "/ngspice-runs";
  return join(root, "receipts");
}

/** Canonical UTF-8 JSON used for all durable record identities. */
export function canonicalJsonBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

/**
 * Gather a runtime identity before the acknowledgement is persisted. If
 * ngspice is missing or its identity cannot be bounded and decoded, no
 * dispatch is acknowledged because no provider process can be started.
 */
export async function captureRuntimeIdentity(): Promise<RuntimeIdentity> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("ngspice", {
      args: ["--version"],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) throw new NgspiceNotFoundError();
    throw error;
  }

  let timedOut = false;
  const kill = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* Process has already exited. */
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, RUNTIME_IDENTITY_TIMEOUT_MS);
  const [statusResult, stdoutResult, stderrResult] = await Promise.allSettled([
    child.status,
    readNgspiceOutputWithinLimit(
      child.stdout,
      "stdout",
      kill,
      MAX_RUNTIME_IDENTITY_BYTES,
    ),
    readNgspiceOutputWithinLimit(
      child.stderr,
      "stderr",
      kill,
      MAX_RUNTIME_IDENTITY_BYTES,
    ),
  ]).finally(() => clearTimeout(timer));

  if (timedOut) {
    throw new SpiceToolError(
      "ngspice_runtime_identity_unavailable",
      { reason: "timeout", timeoutMs: RUNTIME_IDENTITY_TIMEOUT_MS },
      "Restore an ngspice runtime that reports its version within the fixed identity-capture timeout before dispatching a simulation.",
    );
  }
  if (stdoutResult.status === "rejected") {
    throwRuntimeIdentityOutputFailure(stdoutResult.reason);
  }
  if (stderrResult.status === "rejected") {
    throwRuntimeIdentityOutputFailure(stderrResult.reason);
  }
  if (statusResult.status === "rejected") throw statusResult.reason;

  const output = statusResult.value;
  const versionBytes = concatBytes(stdoutResult.value, stderrResult.value);
  if (!output.success) {
    throw new SpiceToolError(
      "ngspice_runtime_identity_unavailable",
      { exitCode: output.code },
      "Restore the configured ngspice runtime before dispatching a simulation.",
    );
  }
  if (versionBytes.length === 0 || versionBytes.length > MAX_RUNTIME_IDENTITY_BYTES) {
    throw new SpiceToolError(
      "ngspice_runtime_identity_invalid",
      {
        byteCount: versionBytes.length,
        maxBytes: MAX_RUNTIME_IDENTITY_BYTES,
      },
      "Restore an ngspice runtime that reports a bounded version identity before dispatching a simulation.",
    );
  }

  let ngspiceVersion: string;
  try {
    ngspiceVersion = new TextDecoder("utf-8", { fatal: true }).decode(versionBytes)
      .trim();
  } catch {
    throw new SpiceToolError(
      "ngspice_runtime_identity_invalid",
      { reason: "version_not_utf8" },
      "Restore an ngspice runtime that reports a UTF-8 version identity before dispatching a simulation.",
    );
  }
  if (!ngspiceVersion) {
    throw new SpiceToolError(
      "ngspice_runtime_identity_invalid",
      { reason: "version_empty" },
      "Restore an ngspice runtime that reports a version identity before dispatching a simulation.",
    );
  }

  return {
    mcp_spice_version: MCP_SPICE_VERSION,
    execution_budgets: EXECUTION_BUDGETS_VERSION,
    deno_version: Deno.version.deno,
    os: Deno.build.os,
    arch: Deno.build.arch,
    ngspice_version: ngspiceVersion,
    ngspice_version_sha256: await sha256Hex(
      new TextEncoder().encode(ngspiceVersion),
    ),
  };
}

/**
 * Persist the pre-dispatch acknowledgement or return a verified completed
 * publication for the identical request. An acknowledged-but-unpublished
 * dispatch is deliberately an error, never permission to run ngspice again.
 */
export async function beginSimulationDispatch(input: {
  analysis_kind: AnalysisKind;
  netlist_sha256: string;
  normalized_request: JsonRecord;
  runtime_identity: RuntimeIdentity;
}): Promise<DispatchStart> {
  const analysisKind = assertAnalysisKind(input.analysis_kind, "simulation_dispatch");
  const netlistSha256 = normalizeDigest(
    input.netlist_sha256,
    "invalid_netlist_sha256",
    "netlist_sha256",
  );
  const normalizedRequest = assertNormalizedRequest(
    analysisKind,
    input.normalized_request,
  );
  const requestSha256 = await requestIdentity({
    analysis_kind: analysisKind,
    netlist_sha256: netlistSha256,
    normalized_request: normalizedRequest,
  });
  const dispatch = await createDispatch({
    request_sha256: requestSha256,
    analysis_kind: analysisKind,
    netlist_sha256: netlistSha256,
    normalized_request: normalizedRequest,
    runtime_identity: assertRuntimeIdentity(input.runtime_identity),
  });
  const acknowledgement = await acknowledgeDispatch(requestSha256, dispatch);
  const storedDispatch = acknowledgement.dispatch;

  if (acknowledgement.created) {
    return {
      request_sha256: requestSha256,
      dispatch_sha256: storedDispatch.integrity_sha256,
      dispatch: storedDispatch,
      status: "started",
    };
  }

  const publication = await waitForPublication(requestSha256);
  if (publication === undefined) {
    throw uncertainDispatchError(requestSha256, storedDispatch.integrity_sha256);
  }
  await assertPublicationLinks(requestSha256, storedDispatch, publication);
  return {
    request_sha256: requestSha256,
    dispatch_sha256: storedDispatch.integrity_sha256,
    dispatch: storedDispatch,
    status: "published",
    receipt_sha256: publication.receipt_sha256,
    outcome_sha256: publication.outcome_sha256,
    execution_state: publication.execution_state,
  };
}

/** Publish a successful or failed outcome in the required atomic order. */
export async function publishSimulationOutcome(input: {
  request_sha256: string;
  dispatch: SimulationDispatch;
  execution_state: SimulationExecutionState;
  result: JsonRecord;
}): Promise<PublishedSimulation> {
  const requestSha = normalizeDigest(
    input.request_sha256,
    "invalid_request_sha256",
    "request_sha256",
  );
  const dispatch = assertDispatch(await readDocument("dispatches", requestSha));
  await assertDispatchRequestIdentity(requestSha, dispatch);
  assertSameCanonicalDocument(dispatch, input.dispatch, "simulation_dispatch_mismatch");
  const executionState = assertExecutionState(input.execution_state);
  const result = assertJsonRecord(input.result, "result");
  await assertOutcomeForWrite(
    result,
    dispatch.analysis_kind,
    executionState,
    dispatch.netlist_sha256,
  );

  // Result and receipt must both be durable before a publication can make the
  // dispatch visible as complete. A crash before the final write remains
  // acknowledged and therefore fail-closed on recovery.
  const outcome = await putDocument("results", result);
  const receipt: SimulationReceipt = {
    type: "spice-simulation-receipt/1.0",
    request_sha256: requestSha,
    dispatch_sha256: dispatch.integrity_sha256,
    analysis_kind: dispatch.analysis_kind,
    netlist_sha256: dispatch.netlist_sha256,
    normalized_request: dispatch.normalized_request,
    runtime_identity: dispatch.runtime_identity,
    outcome_sha256: outcome.sha256,
    execution_state: executionState,
  };
  const receiptRef = await putDocument("receipts", receipt);
  const publication = await createPublication({
    request_sha256: requestSha,
    dispatch_sha256: dispatch.integrity_sha256,
    receipt_sha256: receiptRef.sha256,
    outcome_sha256: outcome.sha256,
    execution_state: executionState,
  });
  await putPublication(requestSha, publication);
  await assertPublicationLinks(requestSha, dispatch, publication);

  return {
    request_sha256: requestSha,
    dispatch_sha256: dispatch.integrity_sha256,
    receipt_sha256: receiptRef.sha256,
    outcome_sha256: outcome.sha256,
    execution_state: executionState,
  };
}

/** Exact result readback with byte-hash, canonical-form, and JSON checks. */
export async function getSimulationResult(outcomeSha256: string): Promise<JsonRecord> {
  const digest = normalizeDigest(
    outcomeSha256,
    "invalid_outcome_sha256",
    "outcome_sha256",
  );
  const result = assertJsonRecord(await readDocument("results", digest), "result");
  assertOutcomeForResultRead(result, digest);
  return result;
}

/** Exact receipt readback plus verification of the linked result identity. */
export async function getSimulationReceipt(
  receiptSha256: string,
): Promise<SimulationReceipt> {
  const digest = normalizeDigest(
    receiptSha256,
    "invalid_receipt_sha256",
    "receipt_sha256",
  );
  const receipt = assertReceipt(await readDocument("receipts", digest));
  const dispatch = assertDispatch(
    await readDocument("dispatches", receipt.request_sha256),
  );
  await assertDispatchRequestIdentity(receipt.request_sha256, dispatch);
  if (
    receipt.dispatch_sha256 !== dispatch.integrity_sha256 ||
    receipt.analysis_kind !== dispatch.analysis_kind ||
    receipt.netlist_sha256 !== dispatch.netlist_sha256 ||
    canonicalJson(receipt.normalized_request) !==
      canonicalJson(dispatch.normalized_request) ||
    canonicalJson(receipt.runtime_identity) !== canonicalJson(dispatch.runtime_identity)
  ) {
    throw corruptRecordError("receipts", digest, "dispatch_binding_mismatch");
  }
  const netlistBytes = await assertNetlistBinding(receipt.netlist_sha256);
  const result = await getSimulationResult(receipt.outcome_sha256);
  assertOutcomeForReceiptRead(result, receipt, digest, netlistBytes);
  return receipt;
}

/**
 * Read the durable recovery state by exact dispatch identity. A dispatch with
 * no publication remains acknowledged; callers must investigate it outside
 * this provider rather than request an automatic replay.
 */
export async function getSimulationDispatch(requestSha256: string): Promise<{
  dispatch: SimulationDispatch;
  publication?: PublishedSimulation;
}> {
  const digest = normalizeDigest(
    requestSha256,
    "invalid_request_sha256",
    "request_sha256",
  );
  const dispatch = assertDispatch(await readDocument("dispatches", digest));
  await assertDispatchRequestIdentity(digest, dispatch);
  const publication = await readPublicationIfPresent(digest);
  if (publication === undefined) return { dispatch };
  await assertPublicationLinks(digest, dispatch, publication);
  return {
    dispatch,
    publication: {
      request_sha256: digest,
      dispatch_sha256: dispatch.integrity_sha256,
      receipt_sha256: publication.receipt_sha256,
      outcome_sha256: publication.outcome_sha256,
      execution_state: publication.execution_state,
    },
  };
}

/** Convert a persisted typed failure back into an MCP business error. */
export function throwPersistedSimulationFailure(
  result: JsonRecord,
  publication?: PublishedSimulation,
): never {
  const code = result["code"];
  const context = result["context"];
  const recovery = result["recovery"];
  if (
    typeof code !== "string" || !isJsonRecord(context) ||
    typeof recovery !== "string" || !recovery
  ) {
    throw new SpiceToolError(
      "simulation_failure_record_invalid",
      {},
      "Inspect the documentary receipt and durable result before deciding whether a new, distinct request is appropriate.",
    );
  }
  const durableContext = publication === undefined ? context : {
    ...context,
    request_sha256: publication.request_sha256,
    dispatch_sha256: publication.dispatch_sha256,
    receipt_sha256: publication.receipt_sha256,
    outcome_sha256: publication.outcome_sha256,
    execution_state: publication.execution_state,
  };
  if (code === "ngspice_unavailable") {
    throw new NgspiceNotFoundError({ context: durableContext, recovery });
  }
  if (code.startsWith("ngspice_")) {
    throw new SpiceError(
      "A durable ngspice simulation failure was replayed. Inspect its documentary receipt identities before submitting a distinct request.",
      { code, context: durableContext, recovery },
    );
  }
  throw new SpiceToolError(code, durableContext, recovery);
}

/** A canonical failure result contains only the standard machine-readable envelope. */
export function failureResultFromError(error: unknown): JsonRecord | undefined {
  if (!isMachineReadableError(error)) return undefined;
  return {
    code: error.code,
    context: toJsonRecord(error.context, "error_context"),
    recovery: error.recovery,
  };
}

function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SpiceToolError(
        "simulation_document_not_canonicalizable",
        { reason: "non_finite_number" },
        "Do not publish a non-finite value in a durable simulation document.",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = assertJsonRecord(value, "document");
  return `{${
    Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")
  }}`;
}

async function putDocument(
  namespace: "results" | "receipts",
  document: JsonRecord,
): Promise<{ sha256: string; created: boolean }> {
  const bytes = canonicalJsonBytes(document);
  const sha256 = await sha256Hex(bytes);
  const created = await putImmutableBytes(namespace, sha256, bytes);
  await readDocument(namespace, sha256);
  return { sha256, created };
}

/**
 * The request-keyed dispatch is the acknowledgement point. A conflicting
 * complete-runtime document belongs to the same request and must be reopened,
 * never replaced or re-dispatched under a later runtime.
 */
async function acknowledgeDispatch(
  requestSha256: string,
  dispatch: SimulationDispatch,
): Promise<{ created: boolean; dispatch: SimulationDispatch }> {
  const bytes = canonicalJsonBytes(dispatch);
  let created = false;
  try {
    created = await putImmutableBytes("dispatches", requestSha256, bytes);
  } catch (error) {
    if (
      !(error instanceof SpiceToolError) ||
      error.code !== "simulation_immutable_record_conflict"
    ) {
      throw error;
    }
  }
  const stored = assertDispatch(
    await readDocument("dispatches", requestSha256),
  );
  await assertDispatchRequestIdentity(requestSha256, stored);
  if (created) {
    assertSameCanonicalDocument(stored, dispatch, "simulation_dispatch_conflict");
  }
  return { created, dispatch: stored };
}

async function putPublication(
  requestSha256: string,
  publication: SimulationPublication,
): Promise<void> {
  const bytes = canonicalJsonBytes(publication);
  await putImmutableBytes("publications", requestSha256, bytes);
  const stored = assertPublication(await readDocument("publications", requestSha256));
  await assertPublicationIntegrity(stored);
  assertSameCanonicalDocument(stored, publication, "simulation_publication_conflict");
}

async function putImmutableBytes(
  namespace: "dispatches" | "results" | "receipts" | "publications",
  name: string,
  bytes: Uint8Array,
): Promise<boolean> {
  const dir = join(resolveReceiptStoreDir(), namespace);
  await ensureDurableDirectory(dir);
  const destination = join(dir, name);
  const temporary = join(dir, `.tmp-${name}-${crypto.randomUUID()}`);
  const temporaryFile = await Deno.open(temporary, {
    write: true,
    createNew: true,
    mode: 0o600,
  });
  try {
    await writeAll(temporaryFile, bytes);
    await temporaryFile.sync();
    await Deno.chmod(temporary, 0o400);
    // chmod changes inode metadata; make that permission state durable before
    // its link can become the immutable public object.
    await temporaryFile.sync();
  } finally {
    temporaryFile.close();
  }
  try {
    try {
      await Deno.link(temporary, destination);
      await syncDirectory(dir);
      return true;
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      await readDocument(namespace, name, bytes);
      return false;
    }
  } finally {
    await Deno.remove(temporary).catch(() => {});
  }
}

async function readDocument(
  namespace: "dispatches" | "results" | "receipts" | "publications",
  identity: string,
  expectedBytes?: Uint8Array,
): Promise<JsonRecord> {
  const storeDir = resolveReceiptStoreDir();
  const path = join(storeDir, namespace, identity);
  let bytes: Uint8Array;
  try {
    bytes = await readImmutableFileWithinLimit({
      root: storeDir,
      sourcePath: path,
      maxBytes: MAX_DURABLE_DOCUMENT_BYTES,
      expectedBytes,
      fail: (reason) =>
        expectedBytes !== undefined &&
          (reason === "too_large" || reason === "content_mismatch")
          ? immutableRecordConflict(namespace, identity)
          : corruptRecordError(namespace, identity, reason),
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new SpiceToolError(
        missingCode(namespace),
        { identity },
        `The durable ${
          namespace.slice(0, -1)
        } record is absent. Do not infer an outcome from an absent record.`,
      );
    }
    throw error;
  }
  if (
    namespace !== "publications" && namespace !== "dispatches" &&
    await sha256Hex(bytes) !== identity
  ) {
    throw corruptRecordError(namespace, identity, "sha256_mismatch");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw corruptRecordError(namespace, identity, "not_utf8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw corruptRecordError(namespace, identity, "invalid_json");
  }
  if (!isJsonRecord(parsed)) {
    throw corruptRecordError(namespace, identity, "not_object");
  }
  let canonical: Uint8Array;
  try {
    canonical = canonicalJsonBytes(parsed);
  } catch {
    throw corruptRecordError(namespace, identity, "not_canonicalizable");
  }
  if (!equalBytes(canonical, bytes)) {
    throw corruptRecordError(namespace, identity, "non_canonical_bytes");
  }
  return parsed;
}

async function readPublicationIfPresent(
  requestSha256: string,
): Promise<SimulationPublication | undefined> {
  try {
    const publication = assertPublication(
      await readDocument("publications", requestSha256),
    );
    await assertPublicationIntegrity(publication);
    return publication;
  } catch (error) {
    if (
      error instanceof SpiceToolError &&
      error.code === "simulation_publication_not_found"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function waitForPublication(
  requestSha256: string,
): Promise<SimulationPublication | undefined> {
  const deadline = Date.now() + ACKNOWLEDGED_PUBLICATION_WAIT_MS;
  while (true) {
    const publication = await readPublicationIfPresent(requestSha256);
    if (publication !== undefined || Date.now() >= deadline) return publication;
    await new Promise((resolve) =>
      setTimeout(resolve, ACKNOWLEDGED_PUBLICATION_POLL_MS)
    );
  }
}

async function assertPublicationLinks(
  requestSha256: string,
  dispatch: SimulationDispatch,
  publication: SimulationPublication,
): Promise<void> {
  if (
    publication.request_sha256 !== requestSha256 ||
    publication.dispatch_sha256 !== dispatch.integrity_sha256
  ) {
    throw corruptRecordError("publications", requestSha256, "dispatch_mismatch");
  }
  const receipt = assertReceipt(
    await readDocument("receipts", publication.receipt_sha256),
  );
  const netlistBytes = await assertNetlistBinding(receipt.netlist_sha256);
  const result = await getSimulationResult(publication.outcome_sha256);
  if (
    receipt.request_sha256 !== requestSha256 ||
    receipt.dispatch_sha256 !== dispatch.integrity_sha256 ||
    receipt.analysis_kind !== dispatch.analysis_kind ||
    receipt.netlist_sha256 !== dispatch.netlist_sha256 ||
    receipt.outcome_sha256 !== publication.outcome_sha256 ||
    receipt.execution_state !== publication.execution_state ||
    canonicalJson(receipt.normalized_request) !==
      canonicalJson(dispatch.normalized_request) ||
    canonicalJson(receipt.runtime_identity) !== canonicalJson(dispatch.runtime_identity)
  ) {
    throw corruptRecordError(
      "publications",
      requestSha256,
      "receipt_binding_mismatch",
    );
  }
  assertOutcomeForPublicationRead(
    result,
    dispatch,
    publication,
    requestSha256,
    netlistBytes,
  );
}

async function assertNetlistBinding(netlistSha256: string): Promise<number> {
  const storeDir = resolveNetlistStoreDir();
  const digest = normalizeSha256(netlistSha256, "simulation_receipt_readback");
  const path = join(storeDir, digest);
  try {
    const bytes = await readImmutableFileWithinLimit({
      root: storeDir,
      sourcePath: path,
      maxBytes: NETLIST_MAX_BYTES,
      fail: (reason) => netlistCorruptError(digest, reason),
    });
    if (await sha256Hex(bytes) !== digest) {
      throw netlistCorruptError(digest, "sha256_mismatch");
    }
    return bytes.length;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new SpiceToolError(
        "simulation_netlist_not_found",
        { netlist_sha256: digest },
        "The receipt cannot be verified without its durable netlist bytes. Restore the immutable netlist object before using this receipt.",
      );
    }
    throw error;
  }
}

/**
 * The public tool schemas describe these records, but durable storage must not
 * rely on a caller having passed through an MCP schema validator. Keep the
 * discriminator and binding checks here, beside the persisted links, so a
 * forged result cannot make an acknowledged dispatch look complete.
 */
async function assertOutcomeForWrite(
  result: JsonRecord,
  analysisKind: AnalysisKind,
  executionState: SimulationExecutionState,
  netlistSha256: string,
): Promise<void> {
  try {
    const outcome = assertOutcomeForBinding(
      result,
      analysisKind,
      executionState,
      netlistSha256,
    );
    if (outcome !== "failed") {
      const netlistBytes = await assertNetlistBinding(netlistSha256);
      assertOutcomeArtifactBytes(result, netlistBytes);
    }
  } catch (error) {
    if (error instanceof OutcomeValidationError) {
      throw new SpiceToolError(
        "simulation_outcome_invalid",
        { reason: error.reason },
        "Publish a bounded outcome matching the acknowledged analysis kind, execution state, and netlist identity.",
      );
    }
    throw error;
  }
}

function assertOutcomeForResultRead(result: JsonRecord, outcomeSha256: string): void {
  try {
    assertPersistedOutcome(result);
  } catch (error) {
    if (error instanceof OutcomeValidationError) {
      throw corruptRecordError("results", outcomeSha256, `outcome_${error.reason}`);
    }
    throw error;
  }
}

function assertOutcomeForReceiptRead(
  result: JsonRecord,
  receipt: SimulationReceipt,
  receiptSha256: string,
  netlistBytes: number,
): void {
  try {
    assertOutcomeForBinding(
      result,
      receipt.analysis_kind,
      receipt.execution_state,
      receipt.netlist_sha256,
    );
    assertOutcomeArtifactBytes(result, netlistBytes);
  } catch (error) {
    if (error instanceof OutcomeValidationError) {
      throw corruptRecordError("receipts", receiptSha256, `outcome_${error.reason}`);
    }
    throw error;
  }
}

function assertOutcomeForPublicationRead(
  result: JsonRecord,
  dispatch: SimulationDispatch,
  publication: SimulationPublication,
  requestSha256: string,
  netlistBytes: number,
): void {
  try {
    assertOutcomeForBinding(
      result,
      dispatch.analysis_kind,
      publication.execution_state,
      dispatch.netlist_sha256,
    );
    assertOutcomeArtifactBytes(result, netlistBytes);
  } catch (error) {
    if (error instanceof OutcomeValidationError) {
      throw corruptRecordError(
        "publications",
        requestSha256,
        `outcome_${error.reason}`,
      );
    }
    throw error;
  }
}

function assertOutcomeForBinding(
  result: JsonRecord,
  analysisKind: AnalysisKind,
  executionState: SimulationExecutionState,
  netlistSha256: string,
): AnalysisKind | "failed" {
  const outcome = assertPersistedOutcome(result);
  if (executionState === "failed") {
    if (outcome !== "failed") outcomeInvalid("failed_result_not_error_envelope");
    return outcome;
  }
  if (outcome === "failed") outcomeInvalid("succeeded_result_not_persisted_success");
  if (outcome !== analysisKind) outcomeInvalid("analysis_kind_mismatch");

  const artifact = outcomeRecord(result["input_artifact"], "input_artifact");
  if (artifact["sha256"] !== netlistSha256) {
    outcomeInvalid("input_artifact_netlist_sha256_mismatch");
  }
  return outcome;
}

function assertOutcomeArtifactBytes(result: JsonRecord, netlistBytes: number): void {
  if (assertPersistedOutcome(result) === "failed") return;
  const artifact = outcomeRecord(result["input_artifact"], "input_artifact");
  if (artifact["bytes"] !== netlistBytes) {
    outcomeInvalid("input_artifact_netlist_bytes_mismatch");
  }
}

function assertPersistedOutcome(result: JsonRecord): AnalysisKind | "failed" {
  if (
    Object.hasOwn(result, "code") || Object.hasOwn(result, "context") ||
    Object.hasOwn(result, "recovery")
  ) {
    assertFailureOutcome(result);
    return "failed";
  }

  const isOp = Object.hasOwn(result, "node_voltages");
  const isTran = Object.hasOwn(result, "simulation");
  const isDc = Object.hasOwn(result, "sweep");
  if (Number(isOp) + Number(isTran) + Number(isDc) !== 1) {
    outcomeInvalid("success_discriminator_invalid");
  }
  if (isOp) {
    assertOpOutcome(result);
    return "op";
  }
  if (isTran) {
    assertTranOutcome(result);
    return "tran";
  }
  assertDcOutcome(result);
  return "dc";
}

function assertFailureOutcome(result: JsonRecord): void {
  assertOutcomeKeys(result, ["code", "context", "recovery"], "failure_keys_invalid");
  if (typeof result["code"] !== "string" || !result["code"]) {
    outcomeInvalid("failure_code_invalid");
  }
  if (!isJsonRecord(result["context"])) outcomeInvalid("failure_context_invalid");
  if (typeof result["recovery"] !== "string" || !result["recovery"]) {
    outcomeInvalid("failure_recovery_invalid");
  }
}

function assertOpOutcome(result: JsonRecord): void {
  assertOutcomeKeys(
    result,
    [
      "node_voltages",
      "branch_currents_a",
      "measurements",
      "not_checked",
      "input_artifact",
    ],
    "op_keys_invalid",
  );
  assertNumberMap(result["node_voltages"], "node_voltages");
  assertNumberMap(result["branch_currents_a"], "branch_currents_a");
  assertMeasurements(result["measurements"]);
  assertNotChecked(result["not_checked"]);
  assertInputArtifact(result["input_artifact"]);
}

function assertTranOutcome(result: JsonRecord): void {
  assertOutcomeKeys(
    result,
    [
      "node_stats",
      "branch_current_stats_a",
      "measurements",
      "simulation",
      "not_checked",
      "input_artifact",
    ],
    "tran_keys_invalid",
  );
  assertStatsMap(
    result["node_stats"],
    ["min_v", "max_v", "final_v", "min_at_s", "max_at_s", "final_at_s"],
    "node_stats",
  );
  assertStatsMap(
    result["branch_current_stats_a"],
    ["min_a", "max_a", "final_a", "min_at_s", "max_at_s", "final_at_s"],
    "branch_current_stats_a",
  );
  assertMeasurements(result["measurements"]);
  const simulation = outcomeRecord(result["simulation"], "simulation");
  assertOutcomeKeys(simulation, ["n_points", "tstop_s"], "simulation_keys_invalid");
  assertOutcomeNumber(simulation["n_points"], "simulation.n_points");
  assertOutcomeNumber(simulation["tstop_s"], "simulation.tstop_s");
  assertNotChecked(result["not_checked"]);
  assertInputArtifact(result["input_artifact"]);
}

function assertDcOutcome(result: JsonRecord): void {
  assertOutcomeKeys(
    result,
    [
      "node_stats",
      "branch_current_stats_a",
      "measurements",
      "sweep",
      "not_checked",
      "input_artifact",
    ],
    "dc_keys_invalid",
  );
  assertStatsMap(
    result["node_stats"],
    [
      "min_v",
      "max_v",
      "final_v",
      "min_at_source_v",
      "max_at_source_v",
      "final_at_source_v",
    ],
    "node_stats",
  );
  assertStatsMap(
    result["branch_current_stats_a"],
    [
      "min_a",
      "max_a",
      "final_a",
      "min_at_source_v",
      "max_at_source_v",
      "final_at_source_v",
    ],
    "branch_current_stats_a",
  );
  assertMeasurements(result["measurements"]);
  const sweep = outcomeRecord(result["sweep"], "sweep");
  assertOutcomeKeys(
    sweep,
    ["source", "start_v", "stop_v", "step_v", "n_points", "max_points"],
    "sweep_keys_invalid",
  );
  if (typeof sweep["source"] !== "string") outcomeInvalid("sweep.source_invalid");
  for (const field of ["start_v", "stop_v", "step_v", "n_points", "max_points"]) {
    assertOutcomeNumber(sweep[field], `sweep.${field}`);
  }
  assertNotChecked(result["not_checked"]);
  assertInputArtifact(result["input_artifact"]);
}

function assertNumberMap(value: unknown, field: string): void {
  const record = outcomeRecord(value, field);
  for (const [key, item] of Object.entries(record)) {
    assertOutcomeNumber(item, `${field}.${key}`);
  }
}

function assertStatsMap(value: unknown, fields: string[], field: string): void {
  const record = outcomeRecord(value, field);
  for (const [key, item] of Object.entries(record)) {
    const stats = outcomeRecord(item, `${field}.${key}`);
    assertOutcomeKeys(stats, fields, `${field}_stat_keys_invalid`);
    for (const statField of fields) {
      assertOutcomeNumber(stats[statField], `${field}.${key}.${statField}`);
    }
  }
}

function assertMeasurements(value: unknown): void {
  const record = outcomeRecord(value, "measurements");
  for (const [key, item] of Object.entries(record)) {
    const measurement = outcomeRecord(item, `measurements.${key}`);
    assertOutcomeKeys(measurement, ["value"], "measurement_keys_invalid");
    assertOutcomeNumber(measurement["value"], `measurements.${key}.value`);
  }
}

function assertNotChecked(value: unknown): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    outcomeInvalid("not_checked_invalid");
  }
}

function assertInputArtifact(value: unknown): void {
  const artifact = outcomeRecord(value, "input_artifact");
  assertOutcomeKeys(artifact, ["sha256", "bytes"], "input_artifact_keys_invalid");
  if (typeof artifact["sha256"] !== "string" || !SHA256_RE.test(artifact["sha256"])) {
    outcomeInvalid("input_artifact.sha256_invalid");
  }
  if (
    typeof artifact["bytes"] !== "number" ||
    !Number.isSafeInteger(artifact["bytes"]) || artifact["bytes"] < 0
  ) {
    outcomeInvalid("input_artifact.bytes_invalid");
  }
}

function outcomeRecord(value: unknown, field: string): JsonRecord {
  if (!isJsonRecord(value)) outcomeInvalid(`${field}_invalid`);
  return value;
}

function assertOutcomeKeys(
  value: JsonRecord,
  expected: string[],
  reason: string,
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (
    actual.length !== allowed.length ||
    actual.some((key, index) => key !== allowed[index])
  ) {
    outcomeInvalid(reason);
  }
}

function assertOutcomeNumber(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    outcomeInvalid(`${field}_invalid`);
  }
}

function outcomeInvalid(reason: string): never {
  throw new OutcomeValidationError(reason);
}

class OutcomeValidationError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

async function requestIdentity(input: {
  analysis_kind: AnalysisKind;
  netlist_sha256: string;
  normalized_request: JsonRecord;
}): Promise<string> {
  return await sha256Hex(canonicalJsonBytes({
    type: "spice-simulation-request/1.0",
    analysis_kind: input.analysis_kind,
    netlist_sha256: input.netlist_sha256,
    normalized_request: input.normalized_request,
  }));
}

async function assertDispatchRequestIdentity(
  requestSha256: string,
  dispatch: SimulationDispatch,
): Promise<void> {
  if (
    dispatch.request_sha256 !== requestSha256 ||
    await requestIdentity(dispatch) !== requestSha256
  ) {
    throw corruptRecordError("dispatches", requestSha256, "request_identity_mismatch");
  }
  await assertDispatchIntegrity(dispatch);
}

async function createDispatch(input: {
  request_sha256: string;
  analysis_kind: AnalysisKind;
  netlist_sha256: string;
  normalized_request: JsonRecord;
  runtime_identity: RuntimeIdentity;
}): Promise<SimulationDispatch> {
  const body: JsonRecord = {
    type: "spice-simulation-dispatch/1.0",
    request_sha256: input.request_sha256,
    analysis_kind: input.analysis_kind,
    netlist_sha256: input.netlist_sha256,
    normalized_request: input.normalized_request,
    runtime_identity: input.runtime_identity,
    execution_state: "acknowledged",
  };
  return {
    type: "spice-simulation-dispatch/1.0",
    request_sha256: input.request_sha256,
    analysis_kind: input.analysis_kind,
    netlist_sha256: input.netlist_sha256,
    normalized_request: input.normalized_request,
    runtime_identity: input.runtime_identity,
    execution_state: "acknowledged",
    integrity_sha256: await sha256Hex(canonicalJsonBytes(body)),
  };
}

async function assertDispatchIntegrity(dispatch: SimulationDispatch): Promise<void> {
  const body: JsonRecord = {
    type: dispatch.type,
    request_sha256: dispatch.request_sha256,
    analysis_kind: dispatch.analysis_kind,
    netlist_sha256: dispatch.netlist_sha256,
    normalized_request: dispatch.normalized_request,
    runtime_identity: dispatch.runtime_identity,
    execution_state: dispatch.execution_state,
  };
  if (await sha256Hex(canonicalJsonBytes(body)) !== dispatch.integrity_sha256) {
    throw corruptRecordError(
      "dispatches",
      dispatch.request_sha256,
      "integrity_sha256_mismatch",
    );
  }
}

function assertDispatch(value: JsonRecord): SimulationDispatch {
  assertClosedKeys(
    value,
    [
      "type",
      "request_sha256",
      "analysis_kind",
      "netlist_sha256",
      "normalized_request",
      "runtime_identity",
      "execution_state",
      "integrity_sha256",
    ],
    "simulation_dispatch_invalid",
  );
  if (
    value["type"] !== "spice-simulation-dispatch/1.0" ||
    value["execution_state"] !== "acknowledged"
  ) {
    throw new SpiceToolError(
      "simulation_dispatch_invalid",
      {},
      "Inspect the durable dispatch record; do not replay an invalid dispatch.",
    );
  }
  const analysisKind = assertAnalysisKind(
    value["analysis_kind"],
    "simulation_dispatch",
  );
  return {
    type: "spice-simulation-dispatch/1.0",
    request_sha256: normalizeDigest(
      value["request_sha256"],
      "simulation_dispatch_invalid",
      "request_sha256",
    ),
    analysis_kind: analysisKind,
    netlist_sha256: normalizeDigest(
      value["netlist_sha256"],
      "simulation_dispatch_invalid",
      "netlist_sha256",
    ),
    normalized_request: assertNormalizedRequest(
      analysisKind,
      value["normalized_request"],
    ),
    runtime_identity: assertRuntimeIdentity(value["runtime_identity"]),
    execution_state: "acknowledged",
    integrity_sha256: normalizeDigest(
      value["integrity_sha256"],
      "simulation_dispatch_invalid",
      "integrity_sha256",
    ),
  };
}

function assertReceipt(value: JsonRecord): SimulationReceipt {
  assertClosedKeys(
    value,
    [
      "type",
      "request_sha256",
      "dispatch_sha256",
      "analysis_kind",
      "netlist_sha256",
      "normalized_request",
      "runtime_identity",
      "outcome_sha256",
      "execution_state",
    ],
    "simulation_receipt_invalid",
  );
  if (value["type"] !== "spice-simulation-receipt/1.0") {
    throw new SpiceToolError(
      "simulation_receipt_invalid",
      {},
      "Inspect the durable receipt record; do not use an invalid receipt as evidence.",
    );
  }
  const analysisKind = assertAnalysisKind(value["analysis_kind"], "simulation_receipt");
  return {
    type: "spice-simulation-receipt/1.0",
    request_sha256: normalizeDigest(
      value["request_sha256"],
      "simulation_receipt_invalid",
      "request_sha256",
    ),
    dispatch_sha256: normalizeDigest(
      value["dispatch_sha256"],
      "simulation_receipt_invalid",
      "dispatch_sha256",
    ),
    analysis_kind: analysisKind,
    netlist_sha256: normalizeDigest(
      value["netlist_sha256"],
      "simulation_receipt_invalid",
      "netlist_sha256",
    ),
    normalized_request: assertNormalizedRequest(
      analysisKind,
      value["normalized_request"],
    ),
    runtime_identity: assertRuntimeIdentity(value["runtime_identity"]),
    outcome_sha256: normalizeDigest(
      value["outcome_sha256"],
      "simulation_receipt_invalid",
      "outcome_sha256",
    ),
    execution_state: assertExecutionState(value["execution_state"]),
  };
}

function assertPublication(value: JsonRecord): SimulationPublication {
  assertClosedKeys(
    value,
    [
      "type",
      "request_sha256",
      "dispatch_sha256",
      "receipt_sha256",
      "outcome_sha256",
      "execution_state",
      "integrity_sha256",
    ],
    "simulation_publication_invalid",
  );
  if (value["type"] !== "spice-simulation-publication/1.0") {
    throw new SpiceToolError(
      "simulation_publication_invalid",
      {},
      "Inspect the durable publication record; do not infer a completed simulation.",
    );
  }
  return {
    type: "spice-simulation-publication/1.0",
    request_sha256: normalizeDigest(
      value["request_sha256"],
      "simulation_publication_invalid",
      "request_sha256",
    ),
    dispatch_sha256: normalizeDigest(
      value["dispatch_sha256"],
      "simulation_publication_invalid",
      "dispatch_sha256",
    ),
    receipt_sha256: normalizeDigest(
      value["receipt_sha256"],
      "simulation_publication_invalid",
      "receipt_sha256",
    ),
    outcome_sha256: normalizeDigest(
      value["outcome_sha256"],
      "simulation_publication_invalid",
      "outcome_sha256",
    ),
    execution_state: assertExecutionState(value["execution_state"]),
    integrity_sha256: normalizeDigest(
      value["integrity_sha256"],
      "simulation_publication_invalid",
      "integrity_sha256",
    ),
  };
}

async function createPublication(input: {
  request_sha256: string;
  dispatch_sha256: string;
  receipt_sha256: string;
  outcome_sha256: string;
  execution_state: SimulationExecutionState;
}): Promise<SimulationPublication> {
  const body: JsonRecord = {
    type: "spice-simulation-publication/1.0",
    request_sha256: input.request_sha256,
    dispatch_sha256: input.dispatch_sha256,
    receipt_sha256: input.receipt_sha256,
    outcome_sha256: input.outcome_sha256,
    execution_state: input.execution_state,
  };
  return {
    ...body,
    type: "spice-simulation-publication/1.0",
    request_sha256: input.request_sha256,
    dispatch_sha256: input.dispatch_sha256,
    receipt_sha256: input.receipt_sha256,
    outcome_sha256: input.outcome_sha256,
    execution_state: input.execution_state,
    integrity_sha256: await sha256Hex(canonicalJsonBytes(body)),
  };
}

async function assertPublicationIntegrity(
  publication: SimulationPublication,
): Promise<void> {
  const body: JsonRecord = {
    type: publication.type,
    request_sha256: publication.request_sha256,
    dispatch_sha256: publication.dispatch_sha256,
    receipt_sha256: publication.receipt_sha256,
    outcome_sha256: publication.outcome_sha256,
    execution_state: publication.execution_state,
  };
  if (await sha256Hex(canonicalJsonBytes(body)) !== publication.integrity_sha256) {
    throw corruptRecordError(
      "publications",
      publication.dispatch_sha256,
      "integrity_sha256_mismatch",
    );
  }
}

function assertRuntimeIdentity(value: unknown): RuntimeIdentity {
  if (!isJsonRecord(value)) invalidRuntimeIdentity();
  const identity = value as JsonRecord;
  assertClosedKeys(
    identity,
    [
      "mcp_spice_version",
      "execution_budgets",
      "deno_version",
      "os",
      "arch",
      "ngspice_version",
      "ngspice_version_sha256",
    ],
    "simulation_runtime_identity_invalid",
  );
  const fields = [
    "mcp_spice_version",
    "execution_budgets",
    "deno_version",
    "os",
    "arch",
    "ngspice_version",
    "ngspice_version_sha256",
  ] as const;
  for (const field of fields) {
    if (typeof identity[field] !== "string" || !identity[field]) {
      invalidRuntimeIdentity();
    }
  }
  return {
    mcp_spice_version: identity["mcp_spice_version"] as string,
    execution_budgets: identity["execution_budgets"] as string,
    deno_version: identity["deno_version"] as string,
    os: identity["os"] as string,
    arch: identity["arch"] as string,
    ngspice_version: identity["ngspice_version"] as string,
    ngspice_version_sha256: normalizeDigest(
      identity["ngspice_version_sha256"],
      "simulation_runtime_identity_invalid",
      "ngspice_version_sha256",
    ),
  };
}

function invalidRuntimeIdentity(): never {
  throw new SpiceToolError(
    "simulation_runtime_identity_invalid",
    {},
    "Inspect the runtime identity before using this durable documentary record.",
  );
}

function assertAnalysisKind(value: unknown, recordType: string): AnalysisKind {
  if (value === "op" || value === "tran" || value === "dc") return value;
  throw new SpiceToolError(
    `${recordType}_invalid`,
    { analysis_kind: value },
    "Inspect the durable record; it does not name a supported analysis kind.",
  );
}

function assertExecutionState(value: unknown): SimulationExecutionState {
  if (value === "succeeded" || value === "failed") return value;
  throw new SpiceToolError(
    "simulation_execution_state_invalid",
    { execution_state: value },
    "Inspect the durable record; it does not name a completed execution state.",
  );
}

function assertNormalizedRequest(
  analysisKind: AnalysisKind,
  value: unknown,
): JsonRecord {
  const request = assertJsonRecord(value, "normalized_request");
  const keys = analysisKind === "op"
    ? ["nodes", "branch_sources", "timeout_s"]
    : analysisKind === "tran"
    ? ["tstep_s", "tstop_s", "nodes", "branch_sources", "timeout_s"]
    : [
      "sweep_source",
      "start_v",
      "stop_v",
      "step_v",
      "nodes",
      "branch_sources",
      "timeout_s",
    ];
  assertClosedKeys(request, keys, "simulation_normalized_request_invalid");
  assertCanonicalSelectorList(request["nodes"], "nodes");
  assertCanonicalSelectorList(request["branch_sources"], "branch_sources");
  assertFiniteNumber(request["timeout_s"], "timeout_s");
  if (analysisKind === "tran") {
    assertFiniteNumber(request["tstep_s"], "tstep_s");
    assertFiniteNumber(request["tstop_s"], "tstop_s");
  }
  if (analysisKind === "dc") {
    if (typeof request["sweep_source"] !== "string" || !request["sweep_source"]) {
      invalidNormalizedRequest("sweep_source");
    }
    assertFiniteNumber(request["start_v"], "start_v");
    assertFiniteNumber(request["stop_v"], "stop_v");
    assertFiniteNumber(request["step_v"], "step_v");
  }
  return request;
}

function assertCanonicalSelectorList(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    invalidNormalizedRequest(field);
  }
  const selectors = value as string[];
  const expected = [...new Set(selectors)].sort();
  if (
    selectors.length !== expected.length ||
    selectors.some((selector, index) => selector !== expected[index])
  ) {
    invalidNormalizedRequest(field);
  }
}

function assertFiniteNumber(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidNormalizedRequest(field);
  }
}

function invalidNormalizedRequest(field: string): never {
  throw new SpiceToolError(
    "simulation_normalized_request_invalid",
    { field },
    "Inspect the canonical request record; do not replay an invalid durable dispatch.",
  );
}

function assertClosedKeys(
  value: JsonRecord,
  expected: string[],
  code: string,
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (
    actual.length !== allowed.length ||
    actual.some((key, index) => key !== allowed[index])
  ) {
    throw new SpiceToolError(
      code,
      { keys: actual },
      "Inspect the durable record; its closed document schema does not match this contract.",
    );
  }
}

function normalizeDigest(value: unknown, code: string, field: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new SpiceToolError(
      code,
      { [field]: value },
      `Pass ${field} as a 64-character lowercase hexadecimal SHA-256 identity.`,
    );
  }
  return value;
}

function assertJsonRecord(value: unknown, field: string): JsonRecord {
  if (!isJsonRecord(value)) {
    throw new SpiceToolError(
      "simulation_document_not_canonicalizable",
      { field },
      "Publish only finite JSON object values in a durable simulation document.",
    );
  }
  return value;
}

function toJsonRecord(value: unknown, field: string): JsonRecord {
  const record = assertJsonRecord(value, field);
  // Validate recursively before a typed error can be persisted as an outcome.
  canonicalJson(record);
  return record;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSameCanonicalDocument(
  left: JsonRecord,
  right: JsonRecord,
  code: string,
): void {
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw new SpiceToolError(
      code,
      {},
      "Do not replace an immutable durable simulation record with different content.",
    );
  }
}

function uncertainDispatchError(
  requestSha256: string,
  dispatchSha256: string,
): SpiceToolError {
  return new SpiceToolError(
    "simulation_dispatch_uncertain",
    {
      request_sha256: requestSha256,
      dispatch_sha256: dispatchSha256,
      execution_state: "acknowledged",
    },
    "Do not retry this request automatically. Read the dispatch by identity, investigate the acknowledged provider run, then submit a distinct human-authorized request if appropriate.",
  );
}

function corruptRecordError(
  namespace: string,
  identity: string,
  reason: string,
): SpiceToolError {
  const recordType = namespace === "dispatches" ? "dispatch" : namespace.slice(0, -1);
  return new SpiceToolError(
    `simulation_${recordType}_corrupt`,
    { identity, reason },
    "Do not use or replay the corrupted durable record. Preserve it for investigation and restore it from an authoritative copy.",
  );
}

function immutableRecordConflict(namespace: string, identity: string): SpiceToolError {
  return new SpiceToolError(
    "simulation_immutable_record_conflict",
    { namespace, identity },
    "Do not overwrite a durable simulation record. Inspect the existing record for corruption or a conflicting writer.",
  );
}

function netlistCorruptError(
  netlistSha256: string,
  reason: string,
): SpiceToolError {
  return new SpiceToolError(
    "simulation_netlist_corrupt",
    { netlist_sha256: netlistSha256, reason },
    "Do not use this receipt. Restore the durable netlist bytes from an authoritative copy.",
  );
}

function missingCode(namespace: string): string {
  switch (namespace) {
    case "dispatches":
      return "simulation_dispatch_not_found";
    case "results":
      return "simulation_result_not_found";
    case "receipts":
      return "simulation_receipt_not_found";
    case "publications":
      return "simulation_publication_not_found";
    default:
      return "simulation_document_not_found";
  }
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const combined = new Uint8Array(first.length + second.length);
  combined.set(first, 0);
  combined.set(second, first.length);
  return combined;
}

function throwRuntimeIdentityOutputFailure(reason: unknown): never {
  if (
    reason instanceof SpiceError &&
    reason.code === "ngspice_output_limit_exceeded"
  ) {
    throw new SpiceToolError(
      "ngspice_runtime_identity_invalid",
      {
        reason: "version_output_too_large",
        maxBytes: MAX_RUNTIME_IDENTITY_BYTES,
      },
      "Restore an ngspice runtime that reports a bounded version identity before dispatching a simulation.",
    );
  }
  throw reason;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    offset += await file.write(bytes.subarray(offset));
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await Deno.open(path, { read: true });
  try {
    await directory.sync();
  } finally {
    directory.close();
  }
}

/**
 * Create the durable layout one directory at a time. Every first creation
 * syncs its parent before a record may be acknowledged, so a power loss cannot
 * leave an acknowledged file reachable through an unsynchronised directory.
 */
async function ensureDurableDirectory(path: string): Promise<void> {
  try {
    const info = await Deno.lstat(path);
    if (!info.isDirectory || info.isSymlink) {
      throw new SpiceToolError(
        "simulation_store_directory_invalid",
        { path },
        "Restore the durable simulation store as a real directory before dispatching a simulation.",
      );
    }
    return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  const parent = dirname(path);
  if (parent !== path) await ensureDurableDirectory(parent);
  try {
    await Deno.mkdir(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink) {
    throw new SpiceToolError(
      "simulation_store_directory_invalid",
      { path },
      "Restore the durable simulation store as a real directory before dispatching a simulation.",
    );
  }
  await syncDirectory(parent);
  await syncDirectory(path);
}
