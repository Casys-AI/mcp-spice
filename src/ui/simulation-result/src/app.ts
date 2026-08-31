import { SPICE_VIEW_APP_ID, SPICE_VIEW_APP_VERSION } from "../../constants.ts";
import { startSpiceSurfaceApp } from "../../shared/start-surface-app.ts";
import { SPICE_COMPONENT_REGISTRY } from "./components.tsx";
import { displayStateFromToolResult } from "./model.ts";

export const SPICE_RESULT_APP_INFO = {
  name: SPICE_VIEW_APP_ID,
  version: SPICE_VIEW_APP_VERSION,
} as const;

export async function startSpiceResultsApp(root: HTMLElement): Promise<void> {
  await startSpiceSurfaceApp({
    root,
    info: SPICE_RESULT_APP_INFO,
    registry: SPICE_COMPONENT_REGISTRY,
    loadingLabel: "Receiving a SPICE simulation result…",
    emptyLabel: "SPICE returned no supported simulation projection.",
    fromToolResult: displayStateFromToolResult,
  });
}
