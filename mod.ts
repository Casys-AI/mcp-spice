/**
 * Public API surface for @casys/mcp-spice.
 *
 * Consumer imports (JSR):
 *   import { createSpiceServer } from "@casys/mcp-spice";
 *   import { SpiceToolsClient } from "@casys/mcp-spice";
 *   import { allTools } from "@casys/mcp-spice";
 */

export { createSpiceServer } from "./server.ts";
export type { CreateSpiceServerOptions } from "./server.ts";
export { SpiceToolsClient } from "./src/client.ts";
export { allTools, getToolByName, toolsByCategory } from "./src/tools/mod.ts";
export type { SpiceTool, SpiceToolCategory } from "./src/tools/types.ts";
export {
  estimateDcSweepPoints,
  MAX_DC_SWEEP_POINTS,
  NgspiceNotFoundError,
  parseMeasurements,
  parseWrdata,
  parseWrdataSeries,
  SpiceError,
} from "./src/api/ngspice.ts";
export type {
  BranchCurrentStats,
  DcBranchCurrentStats,
  DcNodeStats,
  DcResult,
  NodeStats,
  OpResult,
  SpiceMeasurement,
  TranResult,
  WrdataSeriesStats,
} from "./src/api/ngspice.ts";
export {
  NetlistArtifactError,
  sha256Hex,
  snapshotNetlistArtifact,
} from "./src/api/netlist-artifact.ts";
export type { NetlistArtifact, NetlistSnapshot } from "./src/api/netlist-artifact.ts";
export {
  NetlistSecurityError,
  SpiceIdentifierError,
  validateNetlistSecurity,
  validateNodeName,
  validateSourceName,
} from "./src/api/netlist-security.ts";
export { resolveSimulationNetlist } from "./src/api/netlist-resolve.ts";
export {
  configureNetlistStoreDir,
  getNetlistPath,
  NETLIST_MAX_BYTES,
  netlistUri,
  parseNetlistUri,
  putNetlistBytes,
  resolveNetlistStoreDir,
} from "./src/api/netlist-store.ts";
export type { NetlistRef } from "./src/api/netlist-store.ts";
export {
  isMachineReadableError,
  mapSpiceToolError,
  SpiceToolError,
} from "./src/api/tool-error.ts";
export type { MachineReadableErrorFields } from "./src/api/tool-error.ts";
