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
  Card,
  DataTable,
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
  StateMessage,
} from "@casys/mcp-view-components/preact/components";
import type { ComponentChild } from "preact";
import {
  compactReadings,
  executionStateLabel,
  executionStateTone,
  resultDetail,
  resultIdentity,
  resultMarker,
  resultTitle,
  SPICE_COMPONENT_KEYS,
  SPICE_RESULTS_SURFACE,
} from "./catalog.ts";
import {
  type BranchCurrentStats,
  type NodeVoltageStats,
  type SimulationViewData,
  sortedEntries,
} from "./model.ts";
import { formatInteger, formatNumber } from "../../shared/format.ts";

type ResultProps = PreactSurfaceComponentProps<SimulationViewData>;

const SimulationResult = ({ data }: ResultProps) => {
  const readings = compactReadings(data);
  const state = executionStateLabel(data);
  return (
    <SemanticElement
      reference={{
        domain: "spice",
        kind: data.kind,
        id: resultIdentity(data),
        ...(data.kind === "failed-outcome"
          ? (data.outcome_sha256 ? { basisFingerprint: data.outcome_sha256 } : {})
          : { basisFingerprint: data.input_artifact.sha256 }),
      }}
      density="card"
      tone={executionStateTone(state)}
      ident={
        <ElementIdent
          marker={resultMarker(data)}
          label={resultTitle(data)}
          detail={resultDetail(data)}
        />
      }
      reading={readings.entries.map((item) => (
        <ElementReading
          key={item.id}
          label={item.label}
          value={formatNumber(item.value)}
          unit={item.unit}
        />
      ))}
      body={
        <ElementBody>
          {data.kind === "failed-outcome"
            ? <Message tone="danger">{data.recovery}</Message>
            : readings.omitted > 0
            ? (
              <Message tone="neutral">
                {`${readings.omitted} additional observables are in the host-selectable statistics components.`}
              </Message>
            )
            : (
              <Message tone="neutral">
                {state}
                {data.kind !== "operating-point" ? " · reduced summaries only" : ""}
              </Message>
            )}
        </ElementBody>
      }
      provenance={
        <ElementProvenance
          label={data.kind === "failed-outcome" ? "outcome SHA-256" : "netlist SHA-256"}
          value={
            <InlineCode>
              {data.kind === "failed-outcome"
                ? (data.outcome_sha256 ?? data.code)
                : data.input_artifact.sha256}
            </InlineCode>
          }
        />
      }
    />
  );
};

const NodeStatistics = ({ data }: ResultProps) => {
  if (data.kind === "failed-outcome") {
    return (
      <Card title="Node statistics" eyebrow="Reduced observations">
        <EmptyState>A typed failure has no node statistics.</EmptyState>
      </Card>
    );
  }
  if (data.kind === "operating-point") {
    const rows = sortedEntries(data.node_voltages);
    return (
      <Card title="Node voltages" eyebrow="Volts">
        {rows.length === 0
          ? <EmptyState>No node voltages were requested.</EmptyState>
          : (
            <KeyValueList
              items={rows.map(([name, value]) => ({
                id: name,
                label: name,
                value: `${formatNumber(value)} V`,
              }))}
            />
          )}
      </Card>
    );
  }
  const rows = sortedEntries(data.node_stats).map(([name, stats]) => ({
    name,
    ...stats,
  }));
  return (
    <Card title="Node statistics" eyebrow="Reduced voltage summaries">
      <DataTable
        label="Node voltage statistics"
        rows={rows}
        rowKey={(row) => row.name}
        emptyLabel="No node statistics were requested."
        columns={voltageColumns(data.kind)}
      />
    </Card>
  );
};

const CurrentStatistics = ({ data }: ResultProps) => {
  if (data.kind === "failed-outcome") {
    return (
      <Card title="Branch-current statistics" eyebrow="Reduced observations">
        <EmptyState>A typed failure has no branch-current statistics.</EmptyState>
      </Card>
    );
  }
  if (data.kind === "operating-point") {
    const rows = sortedEntries(data.branch_currents_a);
    return (
      <Card title="Branch currents" eyebrow="Amperes">
        {rows.length === 0
          ? <EmptyState>No branch currents were requested.</EmptyState>
          : (
            <KeyValueList
              items={rows.map(([name, value]) => ({
                id: name,
                label: name,
                value: `${formatNumber(value)} A`,
              }))}
            />
          )}
      </Card>
    );
  }
  const rows = sortedEntries(data.branch_current_stats_a).map(
    ([name, stats]) => ({ name, ...stats }),
  );
  return (
    <Card title="Branch-current statistics" eyebrow="Reduced current summaries">
      <DataTable
        label="Branch-current statistics"
        rows={rows}
        rowKey={(row) => row.name}
        emptyLabel="No branch-current statistics were requested."
        columns={currentColumns(data.kind)}
      />
    </Card>
  );
};

const AnalysisFacts = ({ data }: ResultProps) => {
  if (data.kind === "dc-sweep") {
    return (
      <Card title="Sweep facts" eyebrow="Server-owned DC sweep">
        <KeyValueList
          items={[
            { id: "source", label: "source", value: data.sweep.source },
            {
              id: "start_v",
              label: "start_v",
              value: `${formatNumber(data.sweep.start_v)} V`,
            },
            {
              id: "stop_v",
              label: "stop_v",
              value: `${formatNumber(data.sweep.stop_v)} V`,
            },
            {
              id: "step_v",
              label: "step_v",
              value: `${formatNumber(data.sweep.step_v)} V`,
            },
            {
              id: "n_points",
              label: "n_points",
              value: formatInteger(data.sweep.n_points),
            },
            {
              id: "max_points",
              label: "max_points",
              value: formatInteger(data.sweep.max_points),
            },
          ]}
        />
      </Card>
    );
  }
  if (data.kind === "transient-result") {
    return (
      <Card title="Simulation facts" eyebrow="Transient window">
        <KeyValueList
          items={[
            {
              id: "n_points",
              label: "n_points",
              value: formatInteger(data.simulation.n_points),
            },
            {
              id: "tstop_s",
              label: "tstop_s",
              value: `${formatNumber(data.simulation.tstop_s)} s`,
            },
          ]}
        />
      </Card>
    );
  }
  return (
    <Card title="Analysis facts" eyebrow="Simulation metadata">
      <StateMessage title="No sweep or time-window facts" tone="neutral">
        This result is a single operating point or a typed failure. It has no sweep or
        transient window fields.
      </StateMessage>
    </Card>
  );
};

const ReceiptProvenance = ({ data }: ResultProps) => {
  const items = provenanceItems(data);
  return (
    <Card title="Documentary receipt provenance" eyebrow="Provider record">
      {items.length === 0
        ? (
          <EmptyState>
            This payload has no documentary receipt reference.
          </EmptyState>
        )
        : <KeyValueList items={items} />}
    </Card>
  );
};

const NotChecked = ({ data }: ResultProps) => {
  if (data.kind === "failed-outcome") {
    return (
      <Card title="Not checked" eyebrow="Analysis boundary">
        <EmptyState>A typed failure has no not_checked list.</EmptyState>
      </Card>
    );
  }
  return (
    <Card title="Not checked" eyebrow="Declared analysis limits">
      {data.not_checked.length === 0
        ? <EmptyState>No not_checked items were supplied.</EmptyState>
        : (
          <Stack gap="xs">
            {data.not_checked.map((item, index) => (
              <Message key={`limit-${index}`} tone="neutral">{item}</Message>
            ))}
          </Stack>
        )}
    </Card>
  );
};

export const SPICE_COMPONENT_REGISTRY = defineComponentRegistry<
  SimulationViewData,
  PreactSurfaceContext<SimulationViewData>
>({
  components: {
    [SPICE_COMPONENT_KEYS.simulationResult]: definePreactComponent(
      {
        title: "Simulation result",
        description:
          "One compact operating-point, reduced DC sweep, reduced transient, or typed failure.",
      },
      SimulationResult,
    ),
    [SPICE_COMPONENT_KEYS.nodeStatistics]: definePreactComponent(
      {
        title: "Node statistics",
        description:
          "Requested node voltages or reduced voltage statistics from the actual schema.",
      },
      NodeStatistics,
    ),
    [SPICE_COMPONENT_KEYS.currentStatistics]: definePreactComponent(
      {
        title: "Current statistics",
        description:
          "Requested branch currents or reduced current statistics from the actual schema.",
      },
      CurrentStatistics,
    ),
    [SPICE_COMPONENT_KEYS.analysisFacts]: definePreactComponent(
      {
        title: "Analysis facts",
        description: "Sweep or transient window facts when the schema supplies them.",
      },
      AnalysisFacts,
    ),
    [SPICE_COMPONENT_KEYS.receiptProvenance]: definePreactComponent(
      {
        title: "Documentary receipt provenance",
        description:
          "Documentary identities from the live receipt reference or durable outcome envelope.",
      },
      ReceiptProvenance,
    ),
    [SPICE_COMPONENT_KEYS.notChecked]: definePreactComponent(
      {
        title: "Not checked",
        description: "Declared analysis limits copied from not_checked.",
      },
      NotChecked,
    ),
  },
  defaultSurface: defineComponentSurface(SPICE_RESULTS_SURFACE),
});

type NamedVoltageStats = { name: string } & NodeVoltageStats;
type NamedCurrentStats = { name: string } & BranchCurrentStats;

function voltageColumns(kind: "dc-sweep" | "transient-result") {
  return [
    {
      id: "name",
      label: "node",
      render: (row: NamedVoltageStats) => row.name,
    },
    {
      id: "min_v",
      label: "min_v",
      align: "right" as const,
      render: (row: NamedVoltageStats) => `${formatNumber(row.min_v)} V`,
    },
    {
      id: "max_v",
      label: "max_v",
      align: "right" as const,
      render: (row: NamedVoltageStats) => `${formatNumber(row.max_v)} V`,
    },
    {
      id: "final_v",
      label: "final_v",
      align: "right" as const,
      render: (row: NamedVoltageStats) => `${formatNumber(row.final_v)} V`,
    },
    {
      id: "min_at",
      label: kind === "dc-sweep" ? "min_at_source_v" : "min_at_s",
      align: "right" as const,
      render: (row: NamedVoltageStats) =>
        kind === "dc-sweep"
          ? `${formatNumber(row.min_at_source_v ?? 0)} V`
          : `${formatNumber(row.min_at_s ?? 0)} s`,
    },
    {
      id: "max_at",
      label: kind === "dc-sweep" ? "max_at_source_v" : "max_at_s",
      align: "right" as const,
      render: (row: NamedVoltageStats) =>
        kind === "dc-sweep"
          ? `${formatNumber(row.max_at_source_v ?? 0)} V`
          : `${formatNumber(row.max_at_s ?? 0)} s`,
    },
    {
      id: "final_at",
      label: kind === "dc-sweep" ? "final_at_source_v" : "final_at_s",
      align: "right" as const,
      render: (row: NamedVoltageStats) =>
        kind === "dc-sweep"
          ? `${formatNumber(row.final_at_source_v ?? 0)} V`
          : `${formatNumber(row.final_at_s ?? 0)} s`,
    },
  ];
}

function currentColumns(kind: "dc-sweep" | "transient-result") {
  return [
    {
      id: "name",
      label: "source",
      render: (row: NamedCurrentStats) => row.name,
    },
    {
      id: "min_a",
      label: "min_a",
      align: "right" as const,
      render: (row: NamedCurrentStats) => `${formatNumber(row.min_a)} A`,
    },
    {
      id: "max_a",
      label: "max_a",
      align: "right" as const,
      render: (row: NamedCurrentStats) => `${formatNumber(row.max_a)} A`,
    },
    {
      id: "final_a",
      label: "final_a",
      align: "right" as const,
      render: (row: NamedCurrentStats) => `${formatNumber(row.final_a)} A`,
    },
    {
      id: "min_at",
      label: kind === "dc-sweep" ? "min_at_source_v" : "min_at_s",
      align: "right" as const,
      render: (row: NamedCurrentStats) =>
        kind === "dc-sweep"
          ? `${formatNumber(row.min_at_source_v ?? 0)} V`
          : `${formatNumber(row.min_at_s ?? 0)} s`,
    },
    {
      id: "max_at",
      label: kind === "dc-sweep" ? "max_at_source_v" : "max_at_s",
      align: "right" as const,
      render: (row: NamedCurrentStats) =>
        kind === "dc-sweep"
          ? `${formatNumber(row.max_at_source_v ?? 0)} V`
          : `${formatNumber(row.max_at_s ?? 0)} s`,
    },
    {
      id: "final_at",
      label: kind === "dc-sweep" ? "final_at_source_v" : "final_at_s",
      align: "right" as const,
      render: (row: NamedCurrentStats) =>
        kind === "dc-sweep"
          ? `${formatNumber(row.final_at_source_v ?? 0)} V`
          : `${formatNumber(row.final_at_s ?? 0)} s`,
    },
  ];
}

function provenanceItems(data: SimulationViewData): {
  readonly id: string;
  readonly label: string;
  readonly value: ComponentChild;
}[] {
  if (data.kind === "failed-outcome") {
    return [
      ...(data.outcome_sha256
        ? [{
          id: "outcome_sha256",
          label: "outcome_sha256",
          value: <InlineCode>{data.outcome_sha256}</InlineCode>,
        }]
        : []),
      { id: "code", label: "code", value: <InlineCode>{data.code}</InlineCode> },
      { id: "recovery", label: "recovery", value: data.recovery },
    ];
  }
  const items = [
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
      {
        id: "documentary_only",
        label: "documentary_only",
        value: "true",
      },
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
