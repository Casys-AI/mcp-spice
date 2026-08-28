/**
 * Immutable content-addressed netlist store.
 *
 * Bytes are addressed by the SHA-256 of their exact UTF-8 encoding. The
 * digest is always recomputed from the bytes; a caller-declared hash is
 * never used as a path. Existing objects are never overwritten: same hash
 * and same bytes is a no-op; same hash and different bytes is refused.
 *
 * Layout (spec volume, repo default):
 *   ${NGSPICE_RUNS_DIR:-/ngspice-runs}/inputs/<sha256>
 * Override with SPICE_NETLIST_STORE (tests) or configureNetlistStoreDir().
 *
 * Écart vs spec HTML: the retained form writes the bytes through
 * `ngspice_netlist_submit` instead of assuming a pre-staged file; the
 * URI is `spice-netlist:sha256:<hex>`, not a host filesystem path.
 */

import { join } from "@std/path";
import { NETLIST_MAX_BYTES } from "./execution-budgets.ts";
import { sha256Hex } from "./netlist-artifact.ts";
import { SpiceToolError } from "./tool-error.ts";

export { NETLIST_MAX_BYTES } from "./execution-budgets.ts";

const SHA256_RE = /^[a-fA-F0-9]{64}$/;
const URI_RE = /^spice-netlist:sha256:([a-fA-F0-9]{64})$/;

export interface NetlistRef {
  sha256: string;
  bytes: number;
  uri: string;
}

let configuredStoreDir: string | undefined;

/** Test hook. Pass `undefined` to restore env / default resolution. */
export function configureNetlistStoreDir(dir: string | undefined): void {
  configuredStoreDir = dir;
}

export function resolveNetlistStoreDir(): string {
  if (configuredStoreDir !== undefined) return configuredStoreDir;
  const explicit = Deno.env.get("SPICE_NETLIST_STORE");
  if (explicit && explicit.trim()) return explicit;
  const root = Deno.env.get("NGSPICE_RUNS_DIR") ?? "/ngspice-runs";
  return join(root, "inputs");
}

export function netlistUri(sha256: string): string {
  return `spice-netlist:sha256:${normalizeSha256(sha256, "netlist_store")}`;
}

export function parseNetlistUri(uri: string, toolName: string): string {
  if (typeof uri !== "string" || !uri.trim()) {
    throw new SpiceToolError(
      "invalid_netlist_uri",
      { toolName, uri },
      "Pass the uri returned by ngspice_netlist_submit (spice-netlist:sha256:<hex>).",
    );
  }
  const match = URI_RE.exec(uri.trim());
  if (!match) {
    throw new SpiceToolError(
      "invalid_netlist_uri",
      { toolName, uri },
      "Pass the uri returned by ngspice_netlist_submit (spice-netlist:sha256:<hex>).",
    );
  }
  return match[1].toLowerCase();
}

export function normalizeSha256(value: string, toolName: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new SpiceToolError(
      "invalid_netlist_sha256",
      { toolName, netlist_sha256: value },
      "Pass a 64-character hexadecimal SHA-256 of the UTF-8 netlist bytes.",
    );
  }
  return value.toLowerCase();
}

export async function putNetlistBytes(
  bytes: Uint8Array,
  toolName: string,
  storeDir: string = resolveNetlistStoreDir(),
): Promise<NetlistRef> {
  if (bytes.length === 0) {
    throw new SpiceToolError(
      "netlist_empty",
      { toolName, byteCount: 0 },
      "Submit a non-empty UTF-8 netlist.",
    );
  }
  if (bytes.length > NETLIST_MAX_BYTES) {
    throw new SpiceToolError(
      "netlist_too_large",
      { toolName, byteCount: bytes.length, maxBytes: NETLIST_MAX_BYTES },
      `Submit a netlist of at most ${NETLIST_MAX_BYTES} UTF-8 bytes.`,
    );
  }

  // Filename is the recomputed digest — never a caller-declared hash.
  const sha256 = await sha256Hex(bytes);
  await Deno.mkdir(storeDir, { recursive: true });
  const dest = join(storeDir, sha256);
  const tmp = join(storeDir, `.tmp-${sha256}-${crypto.randomUUID()}`);

  await Deno.writeFile(tmp, bytes, { createNew: true, mode: 0o400 });
  try {
    await exclusiveCreate(tmp, dest, bytes, toolName, sha256);
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }

  return { sha256, bytes: bytes.length, uri: netlistUri(sha256) };
}

export async function getNetlistPath(
  sha256: string,
  toolName: string,
  storeDir: string = resolveNetlistStoreDir(),
): Promise<string> {
  const hex = normalizeSha256(sha256, toolName);
  const dest = join(storeDir, hex);
  try {
    const info = await Deno.stat(dest);
    if (!info.isFile) {
      throw new SpiceToolError(
        "netlist_not_in_store",
        { toolName, sha256: hex, path: dest },
        "Submit the netlist with ngspice_netlist_submit, then retry with the returned sha256.",
      );
    }
  } catch (error) {
    if (error instanceof SpiceToolError) throw error;
    if (error instanceof Deno.errors.NotFound) {
      throw new SpiceToolError(
        "netlist_not_in_store",
        { toolName, sha256: hex },
        "Submit the netlist with ngspice_netlist_submit, then retry with the returned sha256.",
      );
    }
    throw error;
  }
  return dest;
}

/**
 * Exclusive create of `dest`. `Deno.rename` would overwrite — forbidden.
 * `link` + compare-on-exists is the immutable CAS write.
 */
async function exclusiveCreate(
  tmp: string,
  dest: string,
  bytes: Uint8Array,
  toolName: string,
  sha256: string,
): Promise<void> {
  try {
    await Deno.link(tmp, dest);
    return;
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) {
      await assertSameContent(dest, bytes, toolName, sha256);
      return;
    }
  }

  try {
    await Deno.writeFile(dest, bytes, { createNew: true, mode: 0o400 });
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) {
      await assertSameContent(dest, bytes, toolName, sha256);
      return;
    }
    throw error;
  }
}

async function assertSameContent(
  dest: string,
  bytes: Uint8Array,
  toolName: string,
  sha256: string,
): Promise<void> {
  const existing = await Deno.readFile(dest);
  if (!equalBytes(existing, bytes)) {
    throw new SpiceToolError(
      "netlist_store_collision",
      {
        toolName,
        sha256,
        existingBytes: existing.length,
        submittedBytes: bytes.length,
      },
      "Refuse the write. The store already holds different bytes at this digest; do not retry with a mutated payload under the same hash.",
    );
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
