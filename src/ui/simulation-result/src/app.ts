import { SPICE_VIEW_APP_ID, SPICE_VIEW_APP_VERSION } from "../../constants.ts";
import {
  isSpiceRecordedViewSession,
  parseSpiceRecordedViewSession,
  type SpiceRecordedViewSession,
} from "../../shared/recorded-session.ts";
import { startSpiceSurfaceApp } from "../../shared/start-surface-app.ts";
import { SPICE_COMPONENT_REGISTRY } from "./components.tsx";
import {
  displayStateFromToolResultForView,
  parseSimulationViewDataForView,
  type SimulationResultViewKey,
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

export async function startSpiceResultsApp(
  root: HTMLElement,
  view: SimulationResultViewKey,
): Promise<void> {
  await startSpiceSurfaceApp({
    root,
    info: SPICE_RESULT_APP_INFO,
    registry: SPICE_COMPONENT_REGISTRY,
    loadingLabel: "Receiving a SPICE simulation result…",
    emptyLabel: "SPICE returned no supported simulation projection.",
    fromToolResult: (value) => displayStateFromToolResultForView(view, value),
    validateSession: (value): value is SpiceRecordedViewSession =>
      isSpiceRecordedViewSession(view, value),
    mapSessionToData: async (session) => {
      const parsed = await parseSpiceRecordedViewSession(view, session);
      if (!parsed) throw new TypeError(`Recorded ${view} projection rejected.`);
      if (
        view === "operatingPoint" &&
        (parsed.resultSchema === SPICE_ADMITTED_EXECUTION_CAPTURE_SCHEMA ||
          parsed.resultSchema === SPICE_ADMITTED_OPERATING_POINT_RESULT_SCHEMA)
      ) {
        return parseRecordedAdmittedSpiceView(
          parsed.resultSchema,
          parsed.structuredContent,
          {
            projectId: parsed.basis.projectId,
            projectRevision: parsed.basis.projectRevision,
            subjectId: parsed.basis.subjectId,
            thread: parsed.basis.thread,
            artifact: parsed.basis.artifact,
            projectionFingerprint: parsed.projectionFingerprint,
          },
        );
      }
      return parseSimulationViewDataForView(view, parsed.structuredContent);
    },
  });
}

export function bootSpiceResultsApp(view: SimulationResultViewKey): void {
  const root = document.getElementById("root");
  if (!root) throw new Error("The SPICE results viewer root is missing.");
  void startSpiceResultsApp(root, view).catch((error) => {
    const state = document.createElement("div");
    state.className = "mcp-view-state";
    state.dataset.tone = "danger";
    state.setAttribute("role", "alert");
    const title = document.createElement("strong");
    title.textContent = "SPICE viewer unavailable";
    const detail = document.createElement("div");
    detail.className = "mcp-view-state-detail";
    detail.textContent = error instanceof Error
      ? error.message
      : "The viewer could not start.";
    state.append(title, detail);
    root.replaceChildren(state);
    root.setAttribute("aria-busy", "false");
    console.error(error);
  });
}
