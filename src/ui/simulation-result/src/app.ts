import { mcpViewMessages } from "@casys/mcp-view-components";
import {
  type PreactSurfaceAppOptions,
  startPreactSurfaceApp,
  type SurfaceAppHandle,
} from "@casys/mcp-view-components/preact";
import { installMcpViewFonts } from "@casys/mcp-view-components/fonts";
import { SPICE_VIEW_APP_ID, SPICE_VIEW_APP_VERSION } from "../../constants.ts";
import { spiceMessages } from "../../shared/i18n.ts";
import type { SpiceRecordedViewSession } from "../../shared/recorded-session.ts";
import {
  bootSpiceApp,
  recordedSessionProjection,
  SPICE_STATUS_CLASS,
  SPICE_SURFACE_CLASS,
} from "../../shared/surface-app.ts";
import { SPICE_COMPONENT_REGISTRY } from "./components.tsx";
import {
  displayStateFromToolResultForView,
  parseSimulationViewDataForView,
  type SimulationResultViewKey,
  type SimulationViewData,
} from "./model.ts";
import {
  parseRecordedAdmittedSpiceView,
  SPICE_ADMITTED_EXECUTION_CAPTURE_SCHEMA,
  SPICE_ADMITTED_OPERATING_POINT_RESULT_SCHEMA,
} from "./recorded-admitted.ts";

export const SPICE_RESULT_APP_INFO = {
  name: SPICE_VIEW_APP_ID,
  version: SPICE_VIEW_APP_VERSION,
} as const;

export type SpiceResultsAppOptions = PreactSurfaceAppOptions<
  SimulationViewData,
  unknown
>;

/**
 * Start the MCP-owned SPICE projection for one result view.
 *
 * The App lifecycle — loading until the first result, one projection per tool
 * result, the host-selected surface remounted when the host context moves,
 * recorded sessions buffered before the transport connects — belongs to
 * `startPreactSurfaceApp`. This module only says what SPICE projects.
 */
export function startSpiceResultsApp(
  root: HTMLElement,
  view: SimulationResultViewKey,
): Promise<SurfaceAppHandle<SimulationViewData>> {
  // Hosts sandbox the App without web fonts; the kit embeds its three faces.
  installMcpViewFonts(root.ownerDocument);
  return startPreactSurfaceApp(spiceResultsAppOptions(root, view));
}

/** The App configuration, exposed so its projections are testable without a host. */
export function spiceResultsAppOptions(
  root: HTMLElement,
  view: SimulationResultViewKey,
): SpiceResultsAppOptions {
  return {
    root,
    info: SPICE_RESULT_APP_INFO,
    registry: SPICE_COMPONENT_REGISTRY,
    strict: true,
    surfaceClassName: SPICE_SURFACE_CLASS,
    statusClassName: SPICE_STATUS_CLASS,
    messages: mcpViewMessages,
    loadingLabel: (locale) => spiceMessages(locale)("loadingResult"),
    emptyLabel: (locale) => spiceMessages(locale)("emptyResult"),
    documentLanguage: spiceMessages.locale,
    themeUpdates: "in-place",
    fromToolResult: (value) => displayStateFromToolResultForView(view, value),
    viewerSession: recordedSessionProjection(
      view,
      (session) => simulationViewDataFromSession(view, session),
    ),
    onError: (error) => {
      console.error("[mcp-spice] Simulation projection failed", error);
    },
  };
}

/** Map one accepted recorded session to the same model as a live tool result. */
export function simulationViewDataFromSession(
  view: SimulationResultViewKey,
  session: SpiceRecordedViewSession,
): SimulationViewData {
  if (
    view === "operatingPoint" &&
    (session.resultSchema === SPICE_ADMITTED_EXECUTION_CAPTURE_SCHEMA ||
      session.resultSchema === SPICE_ADMITTED_OPERATING_POINT_RESULT_SCHEMA)
  ) {
    return parseRecordedAdmittedSpiceView(
      session.resultSchema,
      session.structuredContent,
      {
        projectId: session.basis.projectId,
        projectRevision: session.basis.projectRevision,
        subjectId: session.basis.subjectId,
        thread: session.basis.thread,
        artifact: session.basis.artifact,
        projectionFingerprint: session.projectionFingerprint,
      },
    );
  }
  return parseSimulationViewDataForView(view, session.structuredContent);
}

export function bootSpiceResultsApp(view: SimulationResultViewKey): void {
  bootSpiceApp("SPICE viewer unavailable", (root) => startSpiceResultsApp(root, view));
}
