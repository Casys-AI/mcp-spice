/**
 * Netlist artifact snapshot: copies a caller-supplied netlist into a private
 * read-only temp directory before any subprocess touches it, then computes the
 * SHA-256 of the copy. The hash proves the exact bytes the simulator consumed.
 *
 * Pattern mirrors mcp-dfm/src/api/input-artifact.ts and
 * mcp-calculix/src/api/input-artifact.ts — see those repos for rationale.
 */

import type { MachineReadableErrorFields } from "./tool-error.ts";

/** Raised when the netlist path is missing, empty, or the digest mismatches. */
export class NetlistArtifactError extends Error implements MachineReadableErrorFields {
  readonly code: string;
  readonly context: Record<string, unknown>;
  readonly recovery: string;

  constructor(
    message: string,
    code = "netlist_artifact_error",
    context: Record<string, unknown> = {},
    recovery = "Check the netlist path and the declared SHA-256, then retry.",
  ) {
    super(message);
    this.name = "NetlistArtifactError";
    this.code = code;
    this.context = context;
    this.recovery = recovery;
  }
}

export interface NetlistArtifact {
  /** Path inside the private read-only snapshot directory (ephemeral). */
  path: string;
  /** Original path supplied by the caller. */
  sourcePath: string;
  /** Hex SHA-256 of the private snapshot (not the source). */
  sha256: string;
  /** Byte length of the snapshot. */
  bytes: number;
}

export interface NetlistSnapshot {
  artifact: NetlistArtifact;
  cleanup(): Promise<void>;
}

export function sha256Hex(bytes: Uint8Array): Promise<string> {
  const contiguous = Uint8Array.from(bytes);
  return crypto.subtle
    .digest("SHA-256", contiguous.buffer as ArrayBuffer)
    .then((digest) =>
      Array.from(
        new Uint8Array(digest),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("")
    );
}

/**
 * Snapshot the netlist at `sourcePath` into a private temp directory.
 *
 * @param toolName   - MCP tool name, included in error messages.
 * @param sourcePath - Absolute path to the .cir / .sp / .spi file.
 * @param expectedSha256 - Optional 64-char hex digest; raises if it mismatches.
 */
export async function snapshotNetlistArtifact(
  toolName: string,
  sourcePath: string,
  expectedSha256?: string,
): Promise<NetlistSnapshot> {
  if (
    expectedSha256 !== undefined &&
    !/^[a-fA-F0-9]{64}$/.test(expectedSha256)
  ) {
    throw new NetlistArtifactError(
      `[${toolName}] expected_netlist_sha256 must be a 64-character hexadecimal SHA-256 digest.`,
      "invalid_netlist_sha256",
      { toolName, expectedSha256 },
      "Pass a 64-character hexadecimal SHA-256 of the UTF-8 netlist bytes.",
    );
  }

  const workDir = await Deno.makeTempDir({ prefix: "spice-input-" });
  const snapshotPath = `${workDir}/circuit.cir`;
  const cleanup = () => Deno.remove(workDir, { recursive: true }).catch(() => {});

  try {
    await Deno.copyFile(sourcePath, snapshotPath);
    const bytes = await Deno.readFile(snapshotPath);
    if (bytes.length === 0) {
      throw new NetlistArtifactError(
        `[${toolName}] Netlist input is empty: ${sourcePath}`,
        "netlist_empty",
        { toolName, sourcePath, byteCount: 0 },
        "Provide a non-empty netlist file.",
      );
    }
    const sha256 = await sha256Hex(bytes);
    if (
      expectedSha256 !== undefined &&
      sha256 !== expectedSha256.toLowerCase()
    ) {
      throw new NetlistArtifactError(
        `[${toolName}] Netlist SHA-256 mismatch: expected ${expectedSha256.toLowerCase()}, ` +
          `computed ${sha256} from the private input snapshot.`,
        "netlist_sha256_mismatch",
        {
          toolName,
          expected: expectedSha256.toLowerCase(),
          computed: sha256,
        },
        "Recompute the SHA-256 of the exact UTF-8 bytes and resubmit. The server does not trust a declared digest.",
      );
    }
    await Deno.chmod(snapshotPath, 0o400);
    return {
      artifact: {
        path: snapshotPath,
        sourcePath,
        sha256,
        bytes: bytes.length,
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    if (error instanceof NetlistArtifactError) throw error;
    if (error instanceof Deno.errors.NotFound) {
      throw new NetlistArtifactError(
        `[${toolName}] Netlist file not found: ${sourcePath}`,
        "netlist_not_found",
        { toolName, sourcePath },
        "Pass an existing absolute path, or submit the netlist with ngspice_netlist_submit and retry by sha256.",
      );
    }
    throw error;
  }
}
