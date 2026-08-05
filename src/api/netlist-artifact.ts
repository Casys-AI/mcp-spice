/**
 * Netlist artifact snapshot: copies a caller-supplied netlist into a private
 * read-only temp directory before any subprocess touches it, then computes the
 * SHA-256 of the copy. The hash proves the exact bytes the simulator consumed.
 *
 * Pattern mirrors mcp-dfm/src/api/input-artifact.ts and
 * mcp-calculix/src/api/input-artifact.ts — see those repos for rationale.
 */

/** Raised when the netlist path is missing, empty, or the digest mismatches. */
export class NetlistArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetlistArtifactError";
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

function sha256Hex(bytes: Uint8Array): Promise<string> {
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
      );
    }
    throw error;
  }
}
