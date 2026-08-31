import { startSpiceResultsApp } from "./app.ts";

const root = document.getElementById("root");
if (!root) throw new Error("The SPICE results viewer root is missing.");

void startSpiceResultsApp(root).catch((error) => {
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
