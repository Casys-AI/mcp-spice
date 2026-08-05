/**
 * Tool registry for mcp-spice.
 *
 * Mirrors mcp-dfm/src/tools/mod.ts — a single export surface that the client
 * and tests use to enumerate all tools without importing individual categories.
 */

import { opTool } from "./op.ts";
import type { SpiceTool, SpiceToolCategory } from "./types.ts";

export { type SpiceTool, type SpiceToolCategory } from "./types.ts";

export const allTools: SpiceTool[] = [opTool];

export function getToolByName(name: string): SpiceTool | undefined {
  return allTools.find((t) => t.name === name);
}

export function toolsByCategory(
  category: SpiceToolCategory,
): SpiceTool[] {
  return allTools.filter((t) => t.category === category);
}
