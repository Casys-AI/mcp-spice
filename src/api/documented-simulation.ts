/** Shared orchestration for a provider simulation and its documentary receipt. */

import {
  beginSimulationDispatch,
  canonicalJsonBytes,
  captureRuntimeIdentity,
  failureResultFromError,
  getSimulationResult,
  publishSimulationOutcome,
  throwPersistedSimulationFailure,
} from "./simulation-receipts.ts";
import type {
  AnalysisKind,
  JsonRecord,
  PublishedSimulation,
} from "./simulation-receipts.ts";

export interface DocumentaryReceiptReference extends PublishedSimulation {
  documentary_only: true;
}

export interface DocumentedSimulation<T extends object> {
  result: T;
  documentary_receipt: DocumentaryReceiptReference;
}

const inFlight = new Map<string, Promise<DocumentedSimulation<object>>>();

/**
 * Acknowledge dispatch before calling execute, persist either a bounded result
 * or typed failure, and never rerun an acknowledged-but-unknown request.
 */
export async function executeDocumentedSimulation<T extends object>(input: {
  analysis_kind: AnalysisKind;
  netlist_sha256: string;
  normalized_request: JsonRecord;
  execute(): Promise<T>;
}): Promise<DocumentedSimulation<T>> {
  const key = new TextDecoder().decode(canonicalJsonBytes({
    analysis_kind: input.analysis_kind,
    netlist_sha256: input.netlist_sha256,
    normalized_request: input.normalized_request,
  }));
  const existing = inFlight.get(key);
  if (existing !== undefined) return await existing as DocumentedSimulation<T>;

  const current = executeDocumentedSimulationOnce(input) as Promise<
    DocumentedSimulation<object>
  >;
  inFlight.set(key, current);
  try {
    return await current as DocumentedSimulation<T>;
  } finally {
    if (inFlight.get(key) === current) inFlight.delete(key);
  }
}

async function executeDocumentedSimulationOnce<T extends object>(input: {
  analysis_kind: AnalysisKind;
  netlist_sha256: string;
  normalized_request: JsonRecord;
  execute(): Promise<T>;
}): Promise<DocumentedSimulation<T>> {
  const runtimeIdentity = await captureRuntimeIdentity();
  const started = await beginSimulationDispatch({
    analysis_kind: input.analysis_kind,
    netlist_sha256: input.netlist_sha256,
    normalized_request: input.normalized_request,
    runtime_identity: runtimeIdentity,
  });

  if (started.status === "published") {
    const result = await getSimulationResult(started.outcome_sha256!);
    if (started.execution_state === "failed") {
      throwPersistedSimulationFailure(result, {
        request_sha256: started.request_sha256,
        dispatch_sha256: started.dispatch_sha256,
        receipt_sha256: started.receipt_sha256!,
        outcome_sha256: started.outcome_sha256!,
        execution_state: "failed",
      });
    }
    return {
      result: result as T,
      documentary_receipt: documentaryReference({
        request_sha256: started.request_sha256,
        dispatch_sha256: started.dispatch_sha256,
        receipt_sha256: started.receipt_sha256!,
        outcome_sha256: started.outcome_sha256!,
        execution_state: "succeeded",
      }),
    };
  }

  let result: T;
  try {
    result = await input.execute();
  } catch (error) {
    const failure = failureResultFromError(error);
    if (failure !== undefined) {
      const publication = await publishSimulationOutcome({
        request_sha256: started.request_sha256,
        dispatch: started.dispatch,
        execution_state: "failed",
        result: failure,
      });
      throwPersistedSimulationFailure(failure, publication);
    }
    throw error;
  }

  const publication = await publishSimulationOutcome({
    request_sha256: started.request_sha256,
    dispatch: started.dispatch,
    execution_state: "succeeded",
    result: result as JsonRecord,
  });
  return { result, documentary_receipt: documentaryReference(publication) };
}

/** Sort and de-duplicate semantically unordered observable selectors. */
export function normalizeSelectors(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function documentaryReference(
  publication: PublishedSimulation,
): DocumentaryReceiptReference {
  return { ...publication, documentary_only: true };
}
