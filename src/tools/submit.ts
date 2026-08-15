/**
 * ngspice_netlist_submit — content-addressed netlist admission.
 *
 * The caller sends the exact UTF-8 netlist text plus its declared SHA-256.
 * The server recomputes the digest of the encoded bytes and refuses any
 * mismatch before touching the store. Security filtering runs at submit
 * time (same rules as simulate). The store write is immutable: same hash
 * and same bytes is idempotent; a colliding payload is refused.
 *
 * Écarts vs spec HTML mcp-ngspice:
 *   - Tool name kept as specified (`ngspice_netlist_submit`); simulate
 *     tools stay `spice_simulate_*` (repo names).
 *   - Input is bytes + declared hash (critique), not hash-only of a
 *     pre-staged `/ngspice-runs/inputs/<sha>` file (spec §2.1).
 *   - Output is a content-addressed ref `{ sha256, bytes, uri }`, not
 *     `{ requestId, status }` of an async run.
 *   - Field names follow repo snake_case (`netlist`, `netlist_sha256`,
 *     `bytes`) rather than spec camelCase (`netlistSha256`, `byteCount`).
 */

import { sha256Hex } from "../api/netlist-artifact.ts";
import { validateNetlistSecurity } from "../api/netlist-security.ts";
import { normalizeSha256, putNetlistBytes } from "../api/netlist-store.ts";
import { SpiceToolError } from "../api/tool-error.ts";
import type { SpiceTool } from "./types.ts";

const TOOL_NAME = "ngspice_netlist_submit";

const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["netlist", "netlist_sha256"],
  properties: {
    netlist: {
      type: "string",
      minLength: 1,
      description: "Exact UTF-8 netlist text (circuit only, no .control block). " +
        "The server hashes these bytes and refuses a declared-digest mismatch. " +
        "Forbidden: .control, .include, .lib, .shell, absolute paths.",
    },
    netlist_sha256: {
      type: "string",
      description: "Declared 64-char hex SHA-256 of the UTF-8 encoding of `netlist`. " +
        "The server recomputes the digest and raises SpiceToolError if it differs.",
    },
  },
};

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["sha256", "bytes", "uri"],
  properties: {
    sha256: {
      type: "string",
      description: "Server-computed SHA-256 (lowercase hex) of the stored bytes.",
    },
    bytes: {
      type: "number",
      description: "Byte length of the stored UTF-8 netlist (spec `byteCount`).",
    },
    uri: {
      type: "string",
      description: "Content-addressed URI `spice-netlist:sha256:<hex>`, reusable by " +
        "spice_simulate_op / spice_simulate_tran in place of netlist_path.",
    },
  },
};

export const submitTool: SpiceTool = {
  name: TOOL_NAME,
  description: "Admit a caller-supplied SPICE netlist into the provider's immutable " +
    "content-addressed store. The caller sends the exact UTF-8 bytes and a " +
    "declared SHA-256; the server recomputes the digest, refuses a mismatch, " +
    "applies the same security filter as simulate, and returns a reference " +
    "({ sha256, bytes, uri }) that spice_simulate_op / spice_simulate_tran " +
    "accept in place of a filesystem path.",
  category: "artifact",
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args: Record<string, unknown>) => {
    const netlist = args["netlist"];
    if (typeof netlist !== "string" || netlist.length === 0) {
      throw new SpiceToolError(
        "invalid_netlist",
        { toolName: TOOL_NAME },
        "Pass the exact UTF-8 netlist text in `netlist`.",
      );
    }

    const declared = args["netlist_sha256"];
    if (typeof declared !== "string" || !declared.trim()) {
      throw new SpiceToolError(
        "invalid_netlist_sha256",
        { toolName: TOOL_NAME, netlist_sha256: declared },
        "Pass a 64-character hexadecimal SHA-256 of the UTF-8 netlist bytes.",
      );
    }
    const expected = normalizeSha256(declared, TOOL_NAME);

    const bytes = new TextEncoder().encode(netlist);
    const computed = await sha256Hex(bytes);
    if (computed !== expected) {
      throw new SpiceToolError(
        "netlist_sha256_mismatch",
        {
          toolName: TOOL_NAME,
          expected,
          computed,
          byteCount: bytes.length,
        },
        "Recompute the SHA-256 of the exact UTF-8 bytes and resubmit. The server does not write on digest mismatch.",
      );
    }

    // Security before any store write — a rejected netlist must not persist.
    validateNetlistSecurity(netlist, TOOL_NAME);

    const ref = await putNetlistBytes(bytes, TOOL_NAME);
    return {
      content: `[${TOOL_NAME}] sha256:${ref.sha256} bytes:${ref.bytes}`,
      structuredContent: {
        sha256: ref.sha256,
        bytes: ref.bytes,
        uri: ref.uri,
      },
    };
  },
};
