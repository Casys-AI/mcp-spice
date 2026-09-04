/** What every SPICE App adds to the kit lifecycle: classes, codes, startup failure. */

import {
  renderStatusMessage,
  type SurfaceDisplayState,
  type SurfaceViewerSession,
} from "@casys/mcp-view-components/preact";
import { SPICE_VIEW_CONTRACTS, type SpiceViewKey } from "../view-app-manifest.ts";
import {
  parseSpiceRecordedViewSession,
  type SpiceRecordedViewSession,
} from "./recorded-session.ts";

/** Class of the element wrapping every mounted SPICE surface. */
export const SPICE_SURFACE_CLASS = "spice-component-surface";
/** Class of every status a SPICE App renders, in and out of the lifecycle. */
export const SPICE_STATUS_CLASS = "spice-viewer-state";
/** `code` of the danger state shown when a recorded session fails the strict gate. */
export const SESSION_REJECTED_CODE = "session-rejected";

/**
 * Project one `viewer.session.apply` payload for `view`. Every payload addresses
 * this whole-view App: the strict gate decides, and a rejection is shown, never
 * dropped. `toData` only maps an envelope the gate already accepted.
 */
export function recordedSessionProjection<TData>(
  view: SpiceViewKey,
  toData: (session: SpiceRecordedViewSession) => TData | Promise<TData>,
): SurfaceViewerSession<TData, unknown> {
  return {
    validate: (_value: unknown): _value is unknown => true,
    toState: async (value) => {
      try {
        const session = await parseSpiceRecordedViewSession(view, value);
        if (!session) {
          return sessionRejected(view, "the envelope failed the strict gate");
        }
        return { kind: "result", result: await toData(session) };
      } catch (error) {
        return sessionRejected(view, errorMessage(error));
      }
    },
  };
}

/** The danger state for a recorded `view` session the App refuses to project. */
export function sessionRejected<TData>(
  view: SpiceViewKey,
  detail: string,
): SurfaceDisplayState<TData> {
  return {
    kind: "error",
    title: "Session rejected",
    code: SESSION_REJECTED_CODE,
    message: `Rejected ${SPICE_VIEW_CONTRACTS[view].sessionSchema} session: ${detail}`,
  };
}

/** The one status an App cannot render itself: its own failure to start. */
export function renderStartupFailure(title: string, error: unknown): HTMLElement {
  return renderStatusMessage(
    error instanceof Error ? error.message : "The viewer could not start.",
    { className: SPICE_STATUS_CLASS, title, tone: "danger" },
  );
}

/** Boot one App at `#root`; a startup failure is shown in place, not only logged. */
export function bootSpiceApp(
  title: string,
  start: (root: HTMLElement) => Promise<unknown>,
): void {
  const root = document.getElementById("root");
  if (!root) throw new Error("The SPICE viewer root is missing.");
  void start(root).catch((error) => {
    root.replaceChildren(renderStartupFailure(title, error));
    console.error(error);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
