/**
 * Tool type definitions for mcp-spice.
 *
 * Mirrors the naming convention from mcp-dfm/src/tools/types.ts and
 * mcp-calculix/src/tools/types.ts.
 */

export type SpiceToolCategory = "simulation";

export type SpiceToolHandler = (
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

export interface SpiceTool {
  name: string;
  description: string;
  category: SpiceToolCategory;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  handler: SpiceToolHandler;
  _meta?: Record<string, unknown>;
}
