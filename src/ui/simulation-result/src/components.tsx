/** @jsxImportSource preact */

import {
  defineComponentRegistry,
  defineComponentSurface,
} from "@casys/mcp-view-components";
import {
  definePreactComponent,
  type PreactSurfaceComponentProps,
  type PreactSurfaceContext,
} from "@casys/mcp-view-components/preact";
import {
  ElementBody,
  ElementIdent,
  ElementProvenance,
  ElementReading,
  EmptyState,
  InlineCode,
  KeyValueList,
  Message,
  SemanticElement,
  Stack,
} from "@casys/mcp-view-components/preact/components";
import type { ComponentChild } from "preact";
import { COMPACT_READING_LIMIT, SPICE_RESULT_COMPONENT } from "../../constants.ts";
import { formatInteger, formatNumber } from "../../shared/format.ts";
import {
  type BranchCurrentStats,
  type NodeVoltageStats,
  type SimulationViewData,
  sortedEntries,
} from "./model.ts";

export { SPICE_RESULT_COMPONENT };
export const SPICE_RESULT_SURFACE = {
  layout: { type: "stack", gap: "sm" },
  components: [{ id: "result", component: SPICE_RESULT_COMPONENT }],
} as const;

type ResultProps = PreactSurfaceComponentProps<SimulationViewData>;

const SimulationResult = ({ data }: ResultProps) => (
  <SemanticElement
    reference={resultReference(data)}
    density="card"
    tone={data.kind === "failed-outcome" ? "danger" : "neutral"}
    ident={
      <ElementIdent
        marker={resultMarker(data)}
        label={resultTitle(data)}
        detail={resultDetail(data)}
      />
    }
    reading={primaryReadings(data).map((reading) => (
      <ElementReading
        key={reading.id}
        label={reading.label}
        value={reading.value}
        unit={reading.unit}
      />
    ))}
    body={<ElementBody>{resultBody(data)}</ElementBody>}
    provenance={
      <ElementProvenance
        label={primaryProvenance(data).label}
        value={<InlineCode>{primaryProvenance(data).value}</InlineCode>}
      />
    }
  />
);

export const SPICE_COMPONENT_REGISTRY = defineComponentRegistry<
  SimulationViewData,
  PreactSurfaceContext<SimulationViewData>
>({
  components: {
    [SPICE_RESULT_COMPONENT]: definePreactComponent(
      {
        title: "SPICE simulation result",
        description:
          "One exact operating point, reduced sweep/transient, durable outcome, or recorded admitted capture.",
      },
      SimulationResult,
    ),
  },
  defaultSurface: defineComponentSurface(SPICE_RESULT_SURFACE),
});

function resultReference(data: SimulationViewData) {
  if (data.kind === "recorded-admitted-operating-point") {
    return {
      domain: "spice",
      kind: data.kind,
      id: data.recorded.artifact.id,
      basisFingerprint: data.recorded.artifact.fingerprint,
    };
  }
  if (data.kind === "failed-outcome") {
    return {
      domain: "spice",
      kind: data.kind,
      id: data.outcome_sha256 ?? data.code,
      ...(data.outcome_sha256 ? { basisFingerprint: data.outcome_sha256 } : {}),
    };
  }
  return {
    domain: "spice",
    kind: data.kind,
    id: data.documentary_receipt?.outcome_sha256 ??
      data.outcome_sha256 ?? data.input_artifact.sha256,
    basisFingerprint: data.input_artifact.sha256,
  };
}

function resultMarker(data: SimulationViewData): string {
  switch (data.kind) {
    case "operating-point":
    case "recorded-admitted-operating-point":
      return "OP";
    case "dc-sweep":
      return "DC";
    case "transient-result":
      return "TRAN";
    case "failed-outcome":
      return "failed";
  }
}

function resultTitle(data: SimulationViewData): string {
  switch (data.kind) {
    case "operating-point":
      return "Operating point";
    case "recorded-admitted-operating-point":
      return "Admitted SPICE operating point";
    case "dc-sweep":
      return "Reduced DC sweep";
    case "transient-result":
      return "Reduced transient result";
    case "failed-outcome":
      return data.code;
  }
}

function resultDetail(data: SimulationViewData): string {
  switch (data.kind) {
    case "operating-point":
      return data.source === "durable"
        ? "Durable operating-point outcome"
        : "DC operating point";
    case "recorded-admitted-operating-point":
      return `Exact recorded ${data.sourceSchema}`;
    case "dc-sweep":
      return "Reduced extrema and final values; no transfer curve";
    case "transient-result":
      return "Reduced extrema and final values; no time series";
    case "failed-outcome":
      return "Typed terminal failure";
  }
}

function primaryReadings(data: SimulationViewData): readonly {
  id: string;
  label: string;
  value: string;
  unit?: string;
}[] {
  if (data.kind === "failed-outcome") {
    return [{ id: "code", label: "code", value: data.code }];
  }
  if (data.kind === "recorded-admitted-operating-point") {
    return data.observables.slice(0, COMPACT_READING_LIMIT).map((observable) => ({
      id: observable.nativeName,
      label: observable.nativeName,
      value: formatNumber(observable.value),
      unit: observable.unit,
    }));
  }
  if (data.kind === "operating-point") {
    const voltages = sortedEntries(data.node_voltages).map(([name, value]) => ({
      id: `v:${name}`,
      label: name,
      value: formatNumber(value),
      unit: "V",
    }));
    const currents = sortedEntries(data.branch_currents_a).map(([name, value]) => ({
      id: `i:${name}`,
      label: name,
      value: formatNumber(value),
      unit: "A",
    }));
    return [...voltages, ...currents].slice(0, COMPACT_READING_LIMIT);
  }
  const voltages = sortedEntries(data.node_stats).map(([name, stats]) => ({
    id: `v:${name}`,
    label: `${name} final`,
    value: formatNumber(stats.final_v),
    unit: "V",
  }));
  const currents = sortedEntries(data.branch_current_stats_a).map(
    ([name, stats]) => ({
      id: `i:${name}`,
      label: `${name} final`,
      value: formatNumber(stats.final_a),
      unit: "A",
    }),
  );
  return [...voltages, ...currents].slice(0, COMPACT_READING_LIMIT);
}

function resultBody(data: SimulationViewData): ComponentChild {
  if (data.kind === "failed-outcome") {
    return (
      <Stack gap="sm">
        <Message tone="danger">{data.recovery}</Message>
        <KeyValueList
          items={[
            {
              id: "context",
              label: "context",
              value: <InlineCode>{JSON.stringify(data.context)}</InlineCode>,
            },
            ...(data.input_artifact_source_path
              ? [{
                id: "input_artifact_source_path",
                label: "input_artifact_source_path",
                value: <InlineCode>{data.input_artifact_source_path}</InlineCode>,
              }]
              : []),
          ]}
        />
      </Stack>
    );
  }
  if (data.kind === "recorded-admitted-operating-point") {
    return (
      <Stack gap="sm">
        <KeyValueList
          items={data.observables.map((observable) => ({
            id: observable.nativeName,
            label: observable.nativeName,
            value: `${
              formatNumber(observable.value)
            } ${observable.unit} · ${observable.kind} · ${observable.sourceSymbol}`,
          }))}
        />
        {data.execution
          ? (
            <KeyValueList
              items={[
                {
                  id: "engine",
                  label: "engine",
                  value:
                    `${data.execution.engine.name} ${data.execution.engine.version}`,
                },
                {
                  id: "termination",
                  label: "termination",
                  value: data.execution.termination,
                },
                {
                  id: "source_sha256",
                  label: "source_sha256",
                  value: <InlineCode>{data.execution.sourceSha256}</InlineCode>,
                },
                {
                  id: "receipt_fingerprint",
                  label: "receipt fingerprint",
                  value: <InlineCode>{data.execution.receiptFingerprint}</InlineCode>,
                },
                {
                  id: "evidence_sha256",
                  label: "evidence_sha256",
                  value: <InlineCode>{data.execution.evidenceSha256}</InlineCode>,
                },
                {
                  id: "result_sha256",
                  label: "result_sha256",
                  value: <InlineCode>{data.execution.resultSha256}</InlineCode>,
                },
                {
                  id: "observable_count",
                  label: "observable_count",
                  value: formatInteger(data.execution.counts.observableCount),
                },
              ]}
            />
          )
          : null}
        <KeyValueList
          items={[
            {
              id: "project",
              label: "project",
              value: `${data.recorded.projectId}@r${data.recorded.projectRevision}`,
            },
            { id: "subject", label: "subject", value: data.recorded.subjectId },
            {
              id: "thread",
              label: "thread",
              value: `${data.recorded.thread.id}@r${data.recorded.thread.revision}`,
            },
            { id: "artifact", label: "artifact", value: data.recorded.artifact.id },
            {
              id: "artifact_fingerprint",
              label: "artifact fingerprint",
              value: <InlineCode>{data.recorded.artifact.fingerprint}</InlineCode>,
            },
            {
              id: "projection_fingerprint",
              label: "projection fingerprint",
              value: <InlineCode>{data.recorded.projectionFingerprint}</InlineCode>,
            },
          ]}
        />
        {data.execution?.limitations.map((item) => (
          <Message key={item} tone="neutral">{item}</Message>
        ))}
      </Stack>
    );
  }
  return (
    <Stack gap="sm">
      {data.kind === "operating-point"
        ? <KeyValueList items={operatingPointItems(data)} />
        : (
          <>
            <KeyValueList items={analysisItems(data)} />
            <KeyValueList items={statsItems(data)} />
          </>
        )}
      {Object.keys(data.measurements).length > 0
        ? (
          <KeyValueList
            items={sortedEntries(data.measurements).map(([name, measurement]) => ({
              id: `measurement:${name}`,
              label: `measurement.${name}`,
              value: formatNumber(measurement.value),
            }))}
          />
        )
        : null}
      <KeyValueList items={providerProvenanceItems(data)} />
      {data.not_checked.length === 0
        ? <EmptyState>No not_checked items were supplied.</EmptyState>
        : data.not_checked.map((item, index) => (
          <Message key={`not-checked-${index}`} tone="neutral">{item}</Message>
        ))}
    </Stack>
  );
}

function operatingPointItems(
  data: Extract<SimulationViewData, { kind: "operating-point" }>,
) {
  return [
    ...sortedEntries(data.node_voltages).map(([name, value]) => ({
      id: `node:${name}`,
      label: `node_voltages.${name}`,
      value: `${formatNumber(value)} V`,
    })),
    ...sortedEntries(data.branch_currents_a).map(([name, value]) => ({
      id: `branch:${name}`,
      label: `branch_currents_a.${name}`,
      value: `${formatNumber(value)} A`,
    })),
  ];
}

function analysisItems(
  data: Extract<SimulationViewData, { kind: "dc-sweep" | "transient-result" }>,
) {
  return data.kind === "dc-sweep"
    ? [
      { id: "source", label: "sweep.source", value: data.sweep.source },
      {
        id: "start_v",
        label: "sweep.start_v",
        value: `${formatNumber(data.sweep.start_v)} V`,
      },
      {
        id: "stop_v",
        label: "sweep.stop_v",
        value: `${formatNumber(data.sweep.stop_v)} V`,
      },
      {
        id: "step_v",
        label: "sweep.step_v",
        value: `${formatNumber(data.sweep.step_v)} V`,
      },
      {
        id: "n_points",
        label: "sweep.n_points",
        value: formatInteger(data.sweep.n_points),
      },
      {
        id: "max_points",
        label: "sweep.max_points",
        value: formatInteger(data.sweep.max_points),
      },
    ]
    : [
      {
        id: "n_points",
        label: "simulation.n_points",
        value: formatInteger(data.simulation.n_points),
      },
      {
        id: "tstop_s",
        label: "simulation.tstop_s",
        value: `${formatNumber(data.simulation.tstop_s)} s`,
      },
    ];
}

function statsItems(
  data: Extract<SimulationViewData, { kind: "dc-sweep" | "transient-result" }>,
) {
  return [
    ...sortedEntries(data.node_stats).map(([name, stats]) => ({
      id: `node:${name}`,
      label: `node_stats.${name}`,
      value: voltageStats(data.kind, stats),
    })),
    ...sortedEntries(data.branch_current_stats_a).map(([name, stats]) => ({
      id: `branch:${name}`,
      label: `branch_current_stats_a.${name}`,
      value: currentStats(data.kind, stats),
    })),
  ];
}

function voltageStats(
  kind: "dc-sweep" | "transient-result",
  stats: NodeVoltageStats,
): string {
  const axis = kind === "dc-sweep"
    ? `${formatNumber(stats.min_at_source_v!)} / ${
      formatNumber(stats.max_at_source_v!)
    } / ${formatNumber(stats.final_at_source_v!)} V source`
    : `${formatNumber(stats.min_at_s!)} / ${formatNumber(stats.max_at_s!)} / ${
      formatNumber(stats.final_at_s!)
    } s`;
  return `min ${formatNumber(stats.min_v)} V · max ${
    formatNumber(stats.max_v)
  } V · final ${formatNumber(stats.final_v)} V · at ${axis}`;
}

function currentStats(
  kind: "dc-sweep" | "transient-result",
  stats: BranchCurrentStats,
): string {
  const axis = kind === "dc-sweep"
    ? `${formatNumber(stats.min_at_source_v!)} / ${
      formatNumber(stats.max_at_source_v!)
    } / ${formatNumber(stats.final_at_source_v!)} V source`
    : `${formatNumber(stats.min_at_s!)} / ${formatNumber(stats.max_at_s!)} / ${
      formatNumber(stats.final_at_s!)
    } s`;
  return `min ${formatNumber(stats.min_a)} A · max ${
    formatNumber(stats.max_a)
  } A · final ${formatNumber(stats.final_a)} A · at ${axis}`;
}

function providerProvenanceItems(
  data: Exclude<
    SimulationViewData,
    { kind: "failed-outcome" | "recorded-admitted-operating-point" }
  >,
): { id: string; label: string; value: ComponentChild }[] {
  const items: { id: string; label: string; value: ComponentChild }[] = [
    {
      id: "netlist_sha256",
      label: "netlist SHA-256",
      value: <InlineCode>{data.input_artifact.sha256}</InlineCode>,
    },
    {
      id: "bytes",
      label: "netlist bytes",
      value: formatInteger(data.input_artifact.bytes),
    },
  ];
  if (data.input_artifact.source_path) {
    items.push({
      id: "source_path",
      label: "source_path",
      value: <InlineCode>{data.input_artifact.source_path}</InlineCode>,
    });
  }
  if (data.input_artifact_source_path) {
    items.push({
      id: "input_artifact_source_path",
      label: "input_artifact_source_path",
      value: <InlineCode>{data.input_artifact_source_path}</InlineCode>,
    });
  }
  if (data.documentary_receipt) {
    items.push(
      {
        id: "request_sha256",
        label: "request_sha256",
        value: <InlineCode>{data.documentary_receipt.request_sha256}</InlineCode>,
      },
      {
        id: "dispatch_sha256",
        label: "dispatch_sha256",
        value: <InlineCode>{data.documentary_receipt.dispatch_sha256}</InlineCode>,
      },
      {
        id: "receipt_sha256",
        label: "receipt_sha256",
        value: <InlineCode>{data.documentary_receipt.receipt_sha256}</InlineCode>,
      },
      {
        id: "outcome_sha256",
        label: "outcome_sha256",
        value: <InlineCode>{data.documentary_receipt.outcome_sha256}</InlineCode>,
      },
      {
        id: "execution_state",
        label: "execution_state",
        value: data.documentary_receipt.execution_state,
      },
      { id: "documentary_only", label: "documentary_only", value: "true" },
    );
  } else if (data.outcome_sha256) {
    items.push({
      id: "outcome_sha256",
      label: "outcome_sha256",
      value: <InlineCode>{data.outcome_sha256}</InlineCode>,
    });
  }
  return items;
}

function primaryProvenance(data: SimulationViewData): { label: string; value: string } {
  if (data.kind === "recorded-admitted-operating-point") {
    return { label: "artifact fingerprint", value: data.recorded.artifact.fingerprint };
  }
  if (data.kind === "failed-outcome") {
    return { label: "outcome SHA-256", value: data.outcome_sha256 ?? data.code };
  }
  return { label: "netlist SHA-256", value: data.input_artifact.sha256 };
}
