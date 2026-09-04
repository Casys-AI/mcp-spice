import { assertEquals } from "@std/assert";
import { defineViewAppManifest } from "@casys/mcp-view-contracts";
import {
  SPICE_VIEW_APP_MANIFEST,
  SPICE_VIEW_CONTRACTS,
  SPICE_VIEWER_SESSION_ACTION,
  type SpiceViewKey,
} from "./view-app-manifest.ts";
import { isSpiceRecordedViewSession } from "./shared/recorded-session.ts";
import { SESSION_REJECTED_CODE } from "./shared/surface-app.ts";
import type { SurfaceHostAccess } from "@casys/mcp-view-components/preact";
import { spiceReceiptAppOptions } from "./simulation-receipt/src/app.ts";
import { spiceResultsAppOptions } from "./simulation-result/src/app.ts";

const SPICE_VIEW_KEYS = Object.keys(SPICE_VIEW_CONTRACTS) as SpiceViewKey[];
const root = {} as HTMLElement;
const host = {} as SurfaceHostAccess;

Deno.test("serialized View App manifest is the exact provider-owned contract", async () => {
  defineViewAppManifest(SPICE_VIEW_APP_MANIFEST);
  const serialized = JSON.parse(
    await Deno.readTextFile(new URL("./view-app-manifest.json", import.meta.url)),
  );
  assertEquals(serialized, SPICE_VIEW_APP_MANIFEST);
  const packageManifest = JSON.parse(
    await Deno.readTextFile(new URL("../../deno.json", import.meta.url)),
  );
  assertEquals(packageManifest.version, SPICE_VIEW_APP_MANIFEST.app.version);
  assertEquals(
    packageManifest.exports["./view-app-manifest"],
    "./src/ui/view-app-manifest.json",
  );
});

Deno.test("five whole-view resources declare one App-level session receiver", () => {
  assertEquals(SPICE_VIEW_APP_MANIFEST.resources.length, 5);
  for (const resource of SPICE_VIEW_APP_MANIFEST.resources) {
    assertEquals(resource.ownership, "whole-view");
    assertEquals(resource.resultSchemas.length, 1);
    assertEquals(resource.acceptedActions, [SPICE_VIEWER_SESSION_ACTION]);
    assertEquals(resource.sessionSchemas.length, 1);
    assertEquals("components" in resource, false);
  }
  assertEquals("endpoint" in SPICE_VIEW_APP_MANIFEST, false);
  assertEquals("tools" in SPICE_VIEW_APP_MANIFEST, false);
  assertEquals("anchors" in SPICE_VIEW_APP_MANIFEST, false);
});

Deno.test("App-level receivers reject non-session input before connect", async () => {
  assertEquals(isSpiceRecordedViewSession("operatingPoint", {}), false);
  assertEquals(isSpiceRecordedViewSession("dcSweep", null), false);
  assertEquals(isSpiceRecordedViewSession("transientResult", []), false);
  assertEquals(isSpiceRecordedViewSession("simulationOutcome", false), false);
  assertEquals(isSpiceRecordedViewSession("simulationReceipt", "invalid"), false);
  // Each App projects a recorded session through this gate; the projection
  // itself is exercised in shared/surface-app_test.ts.
  for (const view of SPICE_VIEW_KEYS) {
    const options = view === "simulationReceipt"
      ? spiceReceiptAppOptions(root)
      : spiceResultsAppOptions(root, view);
    const state = await options.viewerSession!.toState({}, host);
    assertEquals(state.kind, "error");
    if (state.kind === "error") assertEquals(state.code, SESSION_REJECTED_CODE);
  }
});
