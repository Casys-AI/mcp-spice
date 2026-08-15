/**
 * Machine-readable tool errors: `{ code, context, recovery }`.
 *
 * Agents parse `code`, not the prose message. `context` carries the facts
 * needed to decide the next call; `recovery` is the single next action.
 */

export interface MachineReadableErrorFields {
  readonly code: string;
  readonly context: Record<string, unknown>;
  readonly recovery: string;
}

export class SpiceToolError extends Error implements MachineReadableErrorFields {
  readonly code: string;
  readonly context: Record<string, unknown>;
  readonly recovery: string;

  constructor(
    code: string,
    context: Record<string, unknown>,
    recovery: string,
  ) {
    super(JSON.stringify({ code, context, recovery }));
    this.name = "SpiceToolError";
    this.code = code;
    this.context = context;
    this.recovery = recovery;
  }

  toJSON(): MachineReadableErrorFields {
    return {
      code: this.code,
      context: this.context,
      recovery: this.recovery,
    };
  }
}

export function isMachineReadableError(
  error: unknown,
): error is Error & MachineReadableErrorFields {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & Partial<MachineReadableErrorFields>;
  return typeof candidate.code === "string" &&
    candidate.code.length > 0 &&
    typeof candidate.recovery === "string" &&
    candidate.recovery.length > 0 &&
    typeof candidate.context === "object" &&
    candidate.context !== null &&
    !Array.isArray(candidate.context);
}

/** Serialize a thrown tool error for McpApp.toolErrorMapper. */
export function mapSpiceToolError(
  error: unknown,
  toolName: string,
): string | null {
  if (!isMachineReadableError(error)) return null;
  return JSON.stringify({
    code: error.code,
    context: { ...error.context, tool: toolName },
    recovery: error.recovery,
  });
}
