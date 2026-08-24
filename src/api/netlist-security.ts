/**
 * Fail-closed netlist security validation.
 *
 * The caller's netlist may contain circuit and inline model definitions
 * (.model, .param, .global, .subckt/.ends). Analysis directives may be present,
 * but they are optional and do not select or override the server operation.
 *
 * The server owns the .control block. Any attempt to inject control
 * directives, load external files, or reference absolute paths is rejected
 * before the subprocess launches.
 *
 * Forbidden constructs (name of offending token is carried in the error):
 *   .control / .endc   — reserved for the server; the caller cannot override
 *                        the simulation sequence or output directives
 *   .include            — no external file inclusion; models must be inline
 *   .lib                — no library loading by path
 *   .shell              — shell escape in a control context
 *   shell               — bare shell command
 *   Absolute paths      — any whitespace-separated token starting with "/"
 *                         or "~/" (prevents path traversal)
 *
 * These checks are enforced regardless of case, since SPICE is
 * case-insensitive for directives.
 */

import type { MachineReadableErrorFields } from "./tool-error.ts";

/** Raised when the netlist contains a forbidden directive or construct. */
export class NetlistSecurityError extends Error implements MachineReadableErrorFields {
  /** The offending directive or construct, as extracted from the netlist. */
  readonly directive: string;
  readonly code = "netlist_forbidden_directive";
  readonly context: Record<string, unknown>;
  readonly recovery =
    "Remove the forbidden construct from the netlist. Supply circuit and inline model definitions. Analysis directives may be present but do not select or override the server operation; the server owns the .control block.";

  constructor(directive: string, toolName: string) {
    super(
      `[${toolName}] Forbidden directive in netlist: "${directive}". ` +
        "Supply circuit and inline model definitions. Analysis directives may " +
        "be present but do not select or override the server operation. " +
        "The server manages the .control block.",
    );
    this.name = "NetlistSecurityError";
    this.directive = directive;
    this.context = { toolName, directive };
  }
}

/**
 * Validate that a netlist string contains no forbidden directives.
 *
 * Processes line by line; raises on the first offending construct found.
 *
 * @param content  - Raw netlist text as supplied by the caller.
 * @param toolName - MCP tool name, included in error messages.
 * @throws {NetlistSecurityError} On the first forbidden construct.
 */
export function validateNetlistSecurity(
  content: string,
  toolName: string,
): void {
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    // Empty lines and SPICE comment characters (* and $) are ignored.
    if (!line || line.startsWith("*") || line.startsWith("$")) {
      continue;
    }

    const lower = line.toLowerCase();

    // .control / .endc — the server owns these sections.
    if (lower.startsWith(".control") || lower.startsWith(".endc")) {
      throw new NetlistSecurityError(line.split(/\s/)[0], toolName);
    }

    // .include — no loading of external files by path.
    if (lower.startsWith(".include")) {
      throw new NetlistSecurityError(".include", toolName);
    }

    // .lib — no library loading by path.
    if (lower.startsWith(".lib")) {
      throw new NetlistSecurityError(".lib", toolName);
    }

    // .shell and bare `shell` — no shell escape.
    if (
      lower.startsWith(".shell") || lower === "shell" ||
      lower.startsWith("shell ")
    ) {
      throw new NetlistSecurityError(line.split(/\s/)[0], toolName);
    }

    // Absolute paths: reject any whitespace-separated token starting with "/"
    // or "~/".  This catches absolute paths in any directive, not just .include
    // and .lib, which the caller might try to disguise.
    for (const token of line.split(/\s+/)) {
      if (token.startsWith("/") || token.startsWith("~/")) {
        throw new NetlistSecurityError(`absolute path: ${token}`, toolName);
      }
    }
  }
}

/** Characters allowed in SPICE node and source names interpolated into `.control`. */
const SPICE_IDENTIFIER = /^[a-zA-Z0-9_.\-#]+$/;

function validateSpiceIdentifier(
  name: string,
  toolName: string,
  kind: "node" | "source",
): void {
  if (kind === "node" && name === "0") return; // ground node is always valid
  if (name.length === 0 || !SPICE_IDENTIFIER.test(name)) {
    const label = kind === "node" ? "node" : "source";
    const labelCap = kind === "node" ? "Node" : "Source";
    throw new TypeError(
      `[${toolName}] Invalid ${label} name: "${name}". ` +
        `${labelCap} names must contain only letters, digits, underscores, dots, ` +
        "hyphens, and #.",
    );
  }
}

/**
 * Validate a node name as safe to interpolate into a .control block.
 *
 * SPICE node names may contain letters, digits, underscores, dots, hyphens,
 * and the # sign.  Parentheses, spaces, semicolons, and shell metacharacters
 * are rejected to prevent injection into `print v(nodename)` or
 * `wrdata file v(nodename)` constructs.
 *
 * The special ground node "0" is accepted.
 *
 * @throws {TypeError} When the name contains forbidden characters.
 */
export function validateNodeName(name: string, toolName: string): void {
  validateSpiceIdentifier(name, toolName, "node");
}

/**
 * Validate a voltage-source name as safe to interpolate into `print i(name)`.
 *
 * Uses the same injection-safe identifier alphabet as {@link validateNodeName}.
 *
 * @throws {TypeError} When the name contains forbidden characters.
 */
export function validateSourceName(name: string, toolName: string): void {
  validateSpiceIdentifier(name, toolName, "source");
}
