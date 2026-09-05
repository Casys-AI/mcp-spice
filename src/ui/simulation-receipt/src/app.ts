import { mcpViewMessages } from "@casys/mcp-view-components";
import {
  type PreactSurfaceAppOptions,
  startPreactSurfaceApp,
  type SurfaceAppHandle,
} from "@casys/mcp-view-components/preact";
import { installMcpViewFonts } from "@casys/mcp-view-components/fonts";
import { SPICE_VIEW_APP_ID, SPICE_VIEW_APP_VERSION } from "../../constants.ts";
import { spiceMessages } from "../../shared/i18n.ts";
import {
  recordedSessionProjection,
  SPICE_STATUS_CLASS,
  SPICE_SURFACE_CLASS,
} from "../../shared/surface-app.ts";
import { SPICE_RECEIPT_REGISTRY } from "./components.tsx";
import {
  displayStateFromReceiptToolResult,
  parseReceiptViewData,
  type ReceiptViewData,
} from "./model.ts";

export const SPICE_RECEIPT_APP_INFO = {
  name: `${SPICE_VIEW_APP_ID}.receipt`,
  version: SPICE_VIEW_APP_VERSION,
} as const;

export type SpiceReceiptAppOptions = PreactSurfaceAppOptions<
  ReceiptViewData,
  unknown
>;

/** Start the MCP-owned documentary receipt projection; the lifecycle is the kit's. */
export function startSpiceReceiptApp(
  root: HTMLElement,
): Promise<SurfaceAppHandle<ReceiptViewData>> {
  // Hosts sandbox the App without web fonts; the kit embeds its three faces.
  installMcpViewFonts(root.ownerDocument);
  return startPreactSurfaceApp(spiceReceiptAppOptions(root));
}

/** The App configuration, exposed so its projections are testable without a host. */
export function spiceReceiptAppOptions(root: HTMLElement): SpiceReceiptAppOptions {
  return {
    root,
    info: SPICE_RECEIPT_APP_INFO,
    registry: SPICE_RECEIPT_REGISTRY,
    strict: true,
    surfaceClassName: SPICE_SURFACE_CLASS,
    statusClassName: SPICE_STATUS_CLASS,
    messages: mcpViewMessages,
    loadingLabel: (locale) => spiceMessages(locale)("loadingReceipt"),
    emptyLabel: (locale) => spiceMessages(locale)("emptyReceipt"),
    documentLanguage: spiceMessages.locale,
    themeUpdates: "in-place",
    fromToolResult: displayStateFromReceiptToolResult,
    viewerSession: recordedSessionProjection(
      "simulationReceipt",
      (session) => parseReceiptViewData(session.structuredContent),
    ),
    onError: (error) => {
      console.error("[mcp-spice] Receipt projection failed", error);
    },
  };
}
