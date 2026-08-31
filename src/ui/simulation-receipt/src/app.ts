import { SPICE_VIEW_APP_ID, SPICE_VIEW_APP_VERSION } from "../../constants.ts";
import { startSpiceSurfaceApp } from "../../shared/start-surface-app.ts";
import { SPICE_RECEIPT_REGISTRY } from "./components.tsx";
import { displayStateFromReceiptToolResult } from "./model.ts";

export const SPICE_RECEIPT_APP_INFO = {
  name: `${SPICE_VIEW_APP_ID}.receipt`,
  version: SPICE_VIEW_APP_VERSION,
} as const;

export async function startSpiceReceiptApp(root: HTMLElement): Promise<void> {
  await startSpiceSurfaceApp({
    root,
    info: SPICE_RECEIPT_APP_INFO,
    registry: SPICE_RECEIPT_REGISTRY,
    loadingLabel: "Receiving a documentary simulation receipt…",
    emptyLabel: "SPICE returned no documentary receipt projection.",
    fromToolResult: displayStateFromReceiptToolResult,
  });
}
