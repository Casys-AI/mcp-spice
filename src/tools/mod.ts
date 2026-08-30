/**
 * Tool registry for mcp-spice.
 *
 * Single export surface for all tools; mirrors mcp-dfm/src/tools/mod.ts.
 */

import { opTool } from "./op.ts";
import { dcTool } from "./dc.ts";
import { dispatchGetTool, receiptGetTool, resultGetTool } from "./receipts.ts";
import { submitTool } from "./submit.ts";
import { tranTool } from "./tran.ts";
import type { SpiceTool, SpiceToolCategory } from "./types.ts";

export { type SpiceTool, type SpiceToolCategory } from "./types.ts";

export const allTools: SpiceTool[] = [
  submitTool,
  opTool,
  tranTool,
  dcTool,
  receiptGetTool,
  resultGetTool,
  dispatchGetTool,
];

export function getToolByName(name: string): SpiceTool | undefined {
  return allTools.find((t) => t.name === name);
}

export function toolsByCategory(
  category: SpiceToolCategory,
): SpiceTool[] {
  return allTools.filter((t) => t.category === category);
}
