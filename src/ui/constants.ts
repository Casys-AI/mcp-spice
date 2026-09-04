/**
 * MCP Apps resource identities for bounded SPICE results.
 *
 * These URIs are presentation resources. They do not change tool names, wire
 * schemas, or documentary execution states.
 */

export const SPICE_VIEW_PREFIX = "mcp-spice";

export const SPICE_OPERATING_POINT_VIEWER = "operating-point";
export const SPICE_DC_SWEEP_VIEWER = "dc-sweep";
export const SPICE_TRANSIENT_RESULT_VIEWER = "transient-result";
export const SPICE_SIMULATION_OUTCOME_VIEWER = "simulation-outcome";
export const SPICE_SIMULATION_RECEIPT_VIEWER = "simulation-receipt";

export const SPICE_RESULT_VIEWERS = [
  SPICE_OPERATING_POINT_VIEWER,
  SPICE_DC_SWEEP_VIEWER,
  SPICE_TRANSIENT_RESULT_VIEWER,
  SPICE_SIMULATION_OUTCOME_VIEWER,
] as const;

export const SPICE_VIEWERS = [
  ...SPICE_RESULT_VIEWERS,
  SPICE_SIMULATION_RECEIPT_VIEWER,
] as const;

export const SPICE_OPERATING_POINT_URI =
  `ui://${SPICE_VIEW_PREFIX}/${SPICE_OPERATING_POINT_VIEWER}` as const;
export const SPICE_DC_SWEEP_URI =
  `ui://${SPICE_VIEW_PREFIX}/${SPICE_DC_SWEEP_VIEWER}` as const;
export const SPICE_TRANSIENT_RESULT_URI =
  `ui://${SPICE_VIEW_PREFIX}/${SPICE_TRANSIENT_RESULT_VIEWER}` as const;
export const SPICE_SIMULATION_OUTCOME_URI =
  `ui://${SPICE_VIEW_PREFIX}/${SPICE_SIMULATION_OUTCOME_VIEWER}` as const;
export const SPICE_SIMULATION_RECEIPT_URI =
  `ui://${SPICE_VIEW_PREFIX}/${SPICE_SIMULATION_RECEIPT_VIEWER}` as const;

export const SPICE_RESULT_SCHEMA_IDS = {
  operatingPoint: "io.casys.mcp-spice.operating-point/1.0",
  dcSweep: "io.casys.mcp-spice.dc-sweep/1.0",
  transientResult: "io.casys.mcp-spice.transient-result/1.0",
  simulationOutcome: "io.casys.mcp-spice.simulation-outcome/1.0",
  simulationReceipt: "io.casys.mcp-spice.simulation-receipt/1.0",
} as const;

export const SPICE_VIEW_APP_ID = "io.casys.mcp-spice.results";
export const SPICE_VIEW_APP_TITLE = "SPICE Simulation Results";
export const SPICE_VIEW_APP_VERSION = "0.6.2";

export const SPICE_RESULT_COMPONENT = "spice.simulation-result";
export const SPICE_RECEIPT_COMPONENT = "spice.simulation-receipt";

/**
 * Most quantities the card's readings strip holds. A result with more of them
 * tables every quantity in the body instead: a positional subset is not a headline.
 */
export const READING_STRIP_LIMIT = 6;
