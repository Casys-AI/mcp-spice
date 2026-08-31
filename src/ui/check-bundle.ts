import { join } from "@std/path";
import {
  SPICE_RESULT_VIEWERS,
  SPICE_SIMULATION_RECEIPT_VIEWER,
  SPICE_VIEWERS,
} from "./constants.ts";
import { buildSpiceViewers, versionedViewerPath } from "./build.ts";

const temporaryDirectory = await Deno.makeTempDir({
  prefix: "mcp-spice-view-freshness-",
});

try {
  await buildSpiceViewers(temporaryDirectory);
  for (const viewer of SPICE_VIEWERS) {
    const versioned = await Deno.readFile(versionedViewerPath(viewer));
    const rebuilt = await Deno.readFile(
      join(temporaryDirectory, viewer, "index.html"),
    );
    if (!equalBytes(versioned, rebuilt)) {
      throw new Error(
        `The versioned ${viewer} viewer is stale: an audited local rebuild ` +
          `does not match it byte-for-byte (versioned ${await sha256(
            versioned,
          )}, rebuilt ${await sha256(rebuilt)}). Run deno task build:ui ` +
          "and review the generated HTML.",
      );
    }
  }
  const [canonicalResult, ...copiedResults] = await Promise.all(
    SPICE_RESULT_VIEWERS.map((viewer) => Deno.readFile(versionedViewerPath(viewer))),
  );
  for (const copy of copiedResults) {
    if (!equalBytes(canonicalResult, copy)) {
      throw new Error(
        "Result viewers must share one discriminated HTML bundle.",
      );
    }
  }
  const receipt = await Deno.readFile(
    versionedViewerPath(SPICE_SIMULATION_RECEIPT_VIEWER),
  );
  if (equalBytes(canonicalResult, receipt)) {
    throw new Error(
      "The receipt viewer must remain a distinct HTML resource.",
    );
  }
  console.log(
    `[mcp-spice] versioned bundles are current (${await sha256(
      canonicalResult,
    )})`,
  );
} finally {
  await Deno.remove(temporaryDirectory, { recursive: true });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

async function sha256(value: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  return `sha256:${
    Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}
