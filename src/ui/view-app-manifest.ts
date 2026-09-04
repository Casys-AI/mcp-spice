/** Provider-owned compatibility declaration for direct and recorded SPICE views. */

import {
  SPICE_DC_SWEEP_URI,
  SPICE_OPERATING_POINT_URI,
  SPICE_RESULT_SCHEMA_IDS,
  SPICE_SIMULATION_OUTCOME_URI,
  SPICE_SIMULATION_RECEIPT_URI,
  SPICE_TRANSIENT_RESULT_URI,
  SPICE_VIEW_APP_ID,
  SPICE_VIEW_APP_TITLE,
  SPICE_VIEW_APP_VERSION,
} from "./constants.ts";
import {
  VIEW_APP_MANIFEST_SCHEMA,
  VIEWER_SESSION_APPLY_ACTION,
} from "@casys/mcp-view-contracts";

/** Re-exported from the shared contract so the value has a single source. */
export const SPICE_VIEW_APP_MANIFEST_SCHEMA = VIEW_APP_MANIFEST_SCHEMA;
export const SPICE_VIEWER_SESSION_ACTION = VIEWER_SESSION_APPLY_ACTION;

export const SPICE_RECORDED_SESSION_SCHEMA_IDS = {
  operatingPoint: "io.casys.mcp-spice.recorded-operating-point-session/1.0",
  dcSweep: "io.casys.mcp-spice.recorded-dc-sweep-session/1.0",
  transientResult: "io.casys.mcp-spice.recorded-transient-result-session/1.0",
  simulationOutcome: "io.casys.mcp-spice.recorded-simulation-outcome-session/1.0",
  simulationReceipt: "io.casys.mcp-spice.recorded-simulation-receipt-session/1.0",
} as const;

/**
 * Exact persisted sources understood by the operating-point session adapter.
 * The two admitted schemas are read as-is; the host does not synthesize an
 * mcp-spice tool result from Digital Thread evidence.
 */
export const SPICE_RECORDED_OPERATING_POINT_SOURCE_SCHEMA_IDS = [
  SPICE_RESULT_SCHEMA_IDS.operatingPoint,
  "spice-operating-point-result/1.0",
  "spice-admitted-execution-capture/1.0",
] as const;

export const SPICE_VIEW_CONTRACTS = {
  operatingPoint: {
    uri: SPICE_OPERATING_POINT_URI,
    resultSchema: SPICE_RESULT_SCHEMA_IDS.operatingPoint,
    sessionSchema: SPICE_RECORDED_SESSION_SCHEMA_IDS.operatingPoint,
  },
  dcSweep: {
    uri: SPICE_DC_SWEEP_URI,
    resultSchema: SPICE_RESULT_SCHEMA_IDS.dcSweep,
    sessionSchema: SPICE_RECORDED_SESSION_SCHEMA_IDS.dcSweep,
  },
  transientResult: {
    uri: SPICE_TRANSIENT_RESULT_URI,
    resultSchema: SPICE_RESULT_SCHEMA_IDS.transientResult,
    sessionSchema: SPICE_RECORDED_SESSION_SCHEMA_IDS.transientResult,
  },
  simulationOutcome: {
    uri: SPICE_SIMULATION_OUTCOME_URI,
    resultSchema: SPICE_RESULT_SCHEMA_IDS.simulationOutcome,
    sessionSchema: SPICE_RECORDED_SESSION_SCHEMA_IDS.simulationOutcome,
  },
  simulationReceipt: {
    uri: SPICE_SIMULATION_RECEIPT_URI,
    resultSchema: SPICE_RESULT_SCHEMA_IDS.simulationReceipt,
    sessionSchema: SPICE_RECORDED_SESSION_SCHEMA_IDS.simulationReceipt,
  },
} as const;

export type SpiceViewKey = keyof typeof SPICE_VIEW_CONTRACTS;

export interface SpiceViewAppResource {
  readonly uri: (typeof SPICE_VIEW_CONTRACTS)[SpiceViewKey]["uri"];
  readonly ownership: "whole-view";
  readonly resultSchemas: readonly string[];
  readonly acceptedActions: readonly [typeof SPICE_VIEWER_SESSION_ACTION];
  readonly sessionSchemas: readonly string[];
}

const resources: readonly SpiceViewAppResource[] = Object.values(
  SPICE_VIEW_CONTRACTS,
).map((contract) => ({
  uri: contract.uri,
  ownership: "whole-view",
  resultSchemas: [contract.resultSchema],
  acceptedActions: [SPICE_VIEWER_SESSION_ACTION],
  sessionSchemas: [contract.sessionSchema],
}));

/**
 * Presentation compatibility only. No endpoint, credentials, tool arguments,
 * Digital Thread anchor, or live execution policy belongs in this manifest.
 */
export const SPICE_VIEW_APP_MANIFEST = Object.freeze({
  schemaVersion: SPICE_VIEW_APP_MANIFEST_SCHEMA,
  app: Object.freeze({
    id: SPICE_VIEW_APP_ID,
    title: SPICE_VIEW_APP_TITLE,
    version: SPICE_VIEW_APP_VERSION,
  }),
  resources: Object.freeze(
    resources.map((resource) =>
      Object.freeze({
        ...resource,
        resultSchemas: Object.freeze([...resource.resultSchemas]),
        acceptedActions: Object.freeze([...resource.acceptedActions]),
        sessionSchemas: Object.freeze([...resource.sessionSchemas]),
      })
    ),
  ),
});
