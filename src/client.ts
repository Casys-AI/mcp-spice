/**
 * SpiceToolsClient — wires all registered tools into a format consumable by
 * McpApp.registerTools().
 *
 * Mirrors DfmToolsClient (mcp-dfm/src/client.ts) and CalculixToolsClient
 * (mcp-calculix/src/client.ts).
 */

import { allTools } from "./tools/mod.ts";
import type { SpiceTool, SpiceToolHandler } from "./tools/types.ts";

export class SpiceToolsClient {
  private readonly tools: SpiceTool[];

  constructor() {
    this.tools = allTools;
  }

  /** Returns the list of tools in the MCP JSON-Schema format expected by McpApp. */
  toMCPFormat(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    annotations: Record<string, unknown>;
  }> {
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      annotations: t.annotations,
    }));
  }

  /** Returns a handler map keyed by tool name, for McpApp.registerTools(). */
  buildHandlersMap(): Map<string, SpiceToolHandler> {
    const handlers = new Map<string, SpiceToolHandler>();
    for (const tool of this.tools) handlers.set(tool.name, tool.handler);
    return handlers;
  }
}
