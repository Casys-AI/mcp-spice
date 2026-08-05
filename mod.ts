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
  NgspiceNotFoundError,
  parseMeasurements,
  parseWrdata,
  SpiceError,
} from "./src/api/ngspice.ts";
export type {
  NodeStats,
  OpResult,
  SpiceMeasurement,
  TranResult,
} from "./src/api/ngspice.ts";
export {
  NetlistArtifactError,
  snapshotNetlistArtifact,
} from "./src/api/netlist-artifact.ts";
export type { NetlistArtifact, NetlistSnapshot } from "./src/api/netlist-artifact.ts";
export {
  NetlistSecurityError,
  validateNetlistSecurity,
  validateNodeName,
} from "./src/api/netlist-security.ts";
