/**
 * Host-selectable SPICE component identities. Default surfaces stay one
 * compact semantic result; statistics, sweep/simulation facts, documentary
 * receipt provenance, and not_checked limits are optional catalog entries.
 */

import { COMPACT_READING_LIMIT } from "../../constants.ts";
import {
  compactCurrentReadings,
  type CompactReading,
  compactVoltageReadings,
  type SimulationViewData,
  sortedEntries,
} from "./model.ts";

export const SPICE_COMPONENT_KEYS = {
  simulationResult: "spice.simulation-result",
  nodeStatistics: "spice.node-statistics",
  currentStatistics: "spice.current-statistics",
  analysisFacts: "spice.analysis-facts",
  receiptProvenance: "spice.receipt-provenance",
  notChecked: "spice.not-checked",
} as const;

export const SPICE_RESULTS_SURFACE = {
  layout: { type: "stack", gap: "sm" },
  components: [
    { id: "result", component: SPICE_COMPONENT_KEYS.simulationResult },
  ],
} as const;

export function compactReadings(
  data: SimulationViewData,
): { readonly entries: readonly CompactReading[]; readonly omitted: number } {
  if (data.kind === "failed-outcome") {
    return { entries: [], omitted: 0 };
  }
  if (data.kind === "operating-point") {
    const voltages = compactVoltageReadings(data.node_voltages);
    if (voltages.entries.length > 0) return voltages;
    return compactCurrentReadings(data.branch_currents_a);
  }
  const finals = sortedEntries(data.node_stats).map(([id, stats]) => ({
    id,
    label: id,
    value: stats.final_v,
    unit: "V" as const,
  }));
  if (finals.length > 0) {
    return {
      entries: finals.slice(0, COMPACT_READING_LIMIT),
      omitted: Math.max(0, finals.length - COMPACT_READING_LIMIT),
    };
  }
  const currents = sortedEntries(data.branch_current_stats_a).map(
    ([id, stats]) => ({
      id,
      label: id,
      value: stats.final_a,
      unit: "A" as const,
    }),
  );
  return {
    entries: currents.slice(0, COMPACT_READING_LIMIT),
    omitted: Math.max(0, currents.length - COMPACT_READING_LIMIT),
  };
}

export function resultTitle(data: SimulationViewData): string {
  switch (data.kind) {
    case "operating-point":
      return "Operating point";
    case "dc-sweep":
      return "Reduced DC sweep";
    case "transient-result":
      return "Reduced transient result";
    case "failed-outcome":
      return data.code;
  }
}

export function resultMarker(data: SimulationViewData): string {
  switch (data.kind) {
    case "operating-point":
      return "OP";
    case "dc-sweep":
      return "DC";
    case "transient-result":
      return "TRAN";
    case "failed-outcome":
      return "failed";
  }
}

export function resultDetail(data: SimulationViewData): string {
  switch (data.kind) {
    case "operating-point":
      return data.source === "durable"
        ? "Durable operating-point outcome"
        : "DC operating point";
    case "dc-sweep":
      return "Reduced extrema and final values; no transfer curve";
    case "transient-result":
      return "Reduced extrema and final values; no time series";
    case "failed-outcome":
      return "Typed terminal failure";
  }
}

export function resultIdentity(data: SimulationViewData): string {
  if (data.kind === "failed-outcome") {
    return data.outcome_sha256 ?? data.code;
  }
  return data.documentary_receipt?.outcome_sha256 ??
    data.outcome_sha256 ??
    data.input_artifact.sha256;
}

export function executionStateLabel(
  data: SimulationViewData,
): "succeeded" | "failed" {
  return data.kind === "failed-outcome" ? "failed" : "succeeded";
}

/** Factual execution coloring. `succeeded` is not a pass or proof tone. */
export function executionStateTone(
  state: "succeeded" | "failed",
): "neutral" | "danger" {
  return state === "failed" ? "danger" : "neutral";
}
