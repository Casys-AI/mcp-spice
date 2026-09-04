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
  type ArtifactFingerprint,
  ArtifactRow,
  DataTable,
  ElementBody,
  ElementIdent,
  ElementProvenance,
  ElementReading,
  ElementSection,
  InlineCode,
  KeyValueList,
  Message,
  NoticeGroup,
  SemanticElement,
} from "@casys/mcp-view-components/preact/components";
import type { ComponentChild, ComponentChildren } from "preact";
import { READING_STRIP_LIMIT, SPICE_RESULT_COMPONENT } from "../../constants.ts";
import { type NumberFormats, numberFormats } from "../../shared/format.ts";
import {
  type BranchCurrentStats,
  type NodeVoltageStats,
  type SimulationViewData,
  sortedEntries,
} from "./model.ts";
import type { Sha256Fingerprint } from "./recorded-admitted.ts";

export { SPICE_RESULT_COMPONENT };
export const SPICE_RESULT_SURFACE = {
  // The datasheet surface is one framed sheet; its sections rule themselves apart.
  layout: { type: "stack", gap: "none" },
  components: [{ id: "result", component: SPICE_RESULT_COMPONENT }],
} as const;

type ResultProps = PreactSurfaceComponentProps<SimulationViewData>;
type PointResult = Extract<
  SimulationViewData,
  { kind: "operating-point" | "recorded-admitted-operating-point" }
>;
type ReducedResult = Extract<
  SimulationViewData,
  { kind: "dc-sweep" | "transient-result" }
>;
type LiveResult = Extract<
  SimulationViewData,
  { kind: "operating-point" | "dc-sweep" | "transient-result" }
>;
type AdmittedResult = Extract<
  SimulationViewData,
  { kind: "recorded-admitted-operating-point" }
>;
type FailedResult = Extract<SimulationViewData, { kind: "failed-outcome" }>;

/** One figure of the readings strip; the caller has already formatted it. */
interface Reading {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly detail?: string;
}

/** One measured quantity; it appears in the readings strip or the table, never both. */
interface Quantity extends Reading {
  readonly kind: string;
  readonly unit: string;
}

/** One reduced quantity: its extrema and final value, each at a point of the axis. */
interface Extremum {
  readonly id: string;
  readonly label: string;
  readonly unit: string;
  readonly min: AxisFigure;
  readonly max: AxisFigure;
  readonly final: AxisFigure;
}

interface AxisFigure {
  readonly value: string;
  readonly at: string;
}

interface Fact {
  readonly id: string;
  readonly label: string;
  readonly value: ComponentChild;
}

const SimulationResult = ({ data, context }: ResultProps) => {
  const format = numberFormats(context.hostContext.locale);
  const quantities = isPoint(data) ? pointQuantities(data, format) : [];
  // Every quantity or none: a positional subset is not a headline.
  const quantitiesInStrip = quantities.length > 0 &&
    quantities.length <= READING_STRIP_LIMIT;
  const readings = quantitiesInStrip
    ? quantities.map((quantity) => ({ ...quantity, detail: quantity.kind }))
    : isReduced(data)
    ? axisReadings(data, format)
    : [];
  const footer = footerFingerprint(data);
  return (
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
      reading={readings.map((reading) => (
        <ElementReading
          key={reading.id}
          label={reading.label}
          value={reading.value}
          unit={reading.unit}
          detail={reading.detail}
        />
      ))}
      body={
        <ElementBody>
          {quantities.length > 0 && !quantitiesInStrip && (
            <ElementSection title="Quantities">
              {quantityTable(quantities)}
            </ElementSection>
          )}
          {isReduced(data) && (
            <ElementSection title="Extrema">
              {extremaTable(data, format)}
            </ElementSection>
          )}
          {resultSections(data, format)}
        </ElementBody>
      }
      provenance={footer && (
        <ElementProvenance
          label={footer.label}
          value={<InlineCode>{footer.value}</InlineCode>}
        />
      )}
    />
  );
};

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

function isPoint(data: SimulationViewData): data is PointResult {
  return data.kind === "operating-point" ||
    data.kind === "recorded-admitted-operating-point";
}

function isReduced(data: SimulationViewData): data is ReducedResult {
  return data.kind === "dc-sweep" || data.kind === "transient-result";
}

function resultReference(data: SimulationViewData) {
  if (data.kind === "recorded-admitted-operating-point") {
    return {
      domain: "spice",
      kind: data.kind,
      id: data.recorded.artifact.id,
      // The reference contract wants the bare digest, not the thread's `sha256:` spelling.
      basisFingerprint: fingerprintParts(data.recorded.artifact.fingerprint).digest,
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
    id: outcomeSha256(data) ?? data.input_artifact.sha256,
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
      return "Admitted operating point";
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
      return `Recorded by ${data.recorded.projectId} r${data.recorded.projectRevision}`;
    case "dc-sweep":
      return "Extrema and final values only; no transfer curve";
    case "transient-result":
      return "Extrema and final values only; no time series";
    case "failed-outcome":
      return "Typed terminal failure";
  }
}

const QUANTITY_KINDS = {
  "node-voltage": "Node voltage",
  "branch-current": "Branch current",
} as const;

function pointQuantities(data: PointResult, format: NumberFormats): Quantity[] {
  if (data.kind === "recorded-admitted-operating-point") {
    return data.observables.map((observable) => ({
      id: observable.nativeName,
      label: observable.nativeName,
      kind: `${QUANTITY_KINDS[observable.kind]} · ${observable.sourceSymbol}`,
      value: format.number(observable.value),
      unit: observable.unit,
    }));
  }
  return [
    ...sortedEntries(data.node_voltages).map(([name, value]) => ({
      id: `v:${name}`,
      label: name,
      kind: QUANTITY_KINDS["node-voltage"],
      value: format.number(value),
      unit: "V",
    })),
    ...sortedEntries(data.branch_currents_a).map(([name, value]) => ({
      id: `i:${name}`,
      label: name,
      kind: QUANTITY_KINDS["branch-current"],
      value: format.number(value),
      unit: "A",
    })),
  ];
}

/** The reduced analyses headline their axis; their quantities are extrema, tabled below. */
function axisReadings(data: ReducedResult, format: NumberFormats): Reading[] {
  if (data.kind === "dc-sweep") {
    return [
      { id: "source", label: "Swept source", value: data.sweep.source },
      {
        id: "start",
        label: "Start",
        value: format.number(data.sweep.start_v),
        unit: "V",
      },
      { id: "stop", label: "Stop", value: format.number(data.sweep.stop_v), unit: "V" },
      { id: "step", label: "Step", value: format.number(data.sweep.step_v), unit: "V" },
      {
        id: "points",
        label: "Points",
        value: format.integer(data.sweep.n_points),
        detail: `of ${format.integer(data.sweep.max_points)} allowed`,
      },
    ];
  }
  return [
    { id: "points", label: "Points", value: format.integer(data.simulation.n_points) },
    {
      id: "tstop",
      label: "Stop time",
      value: format.number(data.simulation.tstop_s),
      unit: "s",
    },
  ];
}

function quantityTable(quantities: readonly Quantity[]): ComponentChild {
  return (
    <DataTable
      label="Quantities"
      rows={quantities}
      rowKey={(quantity) => quantity.id}
      columns={[
        { id: "quantity", label: "Quantity", render: (quantity) => quantity.label },
        { id: "kind", label: "Kind", render: (quantity) => quantity.kind },
        {
          id: "value",
          label: "Value",
          align: "right",
          render: (quantity) => <span class="spice-figure">{quantity.value}</span>,
        },
        { id: "unit", label: "Unit", render: (quantity) => quantity.unit },
      ]}
    />
  );
}

function extremaTable(data: ReducedResult, format: NumberFormats): ComponentChild {
  const axisUnit = data.kind === "dc-sweep" ? "V" : "s";
  const figure = (value: number, at: number | undefined): AxisFigure => ({
    value: format.number(value),
    at: at === undefined ? "" : `at ${format.number(at)} ${axisUnit}`,
  });
  const axis = (stats: NodeVoltageStats | BranchCurrentStats) =>
    data.kind === "dc-sweep"
      ? [stats.min_at_source_v, stats.max_at_source_v, stats.final_at_source_v]
      : [stats.min_at_s, stats.max_at_s, stats.final_at_s];
  const rows: Extremum[] = [
    ...sortedEntries(data.node_stats).map(([name, stats]) => {
      const [minAt, maxAt, finalAt] = axis(stats);
      return {
        id: `v:${name}`,
        label: name,
        unit: "V",
        min: figure(stats.min_v, minAt),
        max: figure(stats.max_v, maxAt),
        final: figure(stats.final_v, finalAt),
      };
    }),
    ...sortedEntries(data.branch_current_stats_a).map(([name, stats]) => {
      const [minAt, maxAt, finalAt] = axis(stats);
      return {
        id: `i:${name}`,
        label: name,
        unit: "A",
        min: figure(stats.min_a, minAt),
        max: figure(stats.max_a, maxAt),
        final: figure(stats.final_a, finalAt),
      };
    }),
  ];
  const axisFigure = (figure: AxisFigure) => (
    <span class="spice-figure">
      {figure.value}
      {figure.at && <small class="spice-figure-at">{figure.at}</small>}
    </span>
  );
  return (
    <DataTable
      label="Extrema"
      rows={rows}
      rowKey={(row) => row.id}
      columns={[
        { id: "quantity", label: "Quantity", render: (row) => row.label },
        {
          id: "min",
          label: "Min",
          align: "right",
          render: (row) => axisFigure(row.min),
        },
        {
          id: "max",
          label: "Max",
          align: "right",
          render: (row) => axisFigure(row.max),
        },
        {
          id: "final",
          label: "Final",
          align: "right",
          render: (row) => axisFigure(row.final),
        },
        { id: "unit", label: "Unit", render: (row) => row.unit },
      ]}
    />
  );
}

function resultSections(
  data: SimulationViewData,
  format: NumberFormats,
): ComponentChildren {
  switch (data.kind) {
    case "failed-outcome":
      return failedSections(data);
    case "recorded-admitted-operating-point":
      return admittedSections(data, format);
    default:
      return liveSections(data, format);
  }
}

function liveSections(data: LiveResult, format: NumberFormats): ComponentChildren {
  const measurements = sortedEntries(data.measurements);
  const receipt = data.documentary_receipt;
  const path = data.input_artifact.source_path ?? data.input_artifact_source_path;
  return (
    <>
      {measurements.length > 0 && (
        <ElementSection title="Measurements">
          <Facts
            items={measurements.map(([name, measurement]) => ({
              id: `measurement:${name}`,
              label: name,
              value: format.number(measurement.value),
            }))}
          />
        </ElementSection>
      )}
      <NoticeGroup label="Not checked" items={data.not_checked} />
      <ElementSection title="Provenance">
        <ArtifactRow
          label="Netlist"
          kind="input"
          uri={path ?? `sha256:${data.input_artifact.sha256}`}
          fingerprint={path
            ? { algorithm: "sha256", digest: data.input_artifact.sha256 }
            : undefined}
          sizeLabel={`${format.integer(data.input_artifact.bytes)} bytes`}
        />
        {receipt && (
          <Facts
            items={[
              {
                id: "request",
                label: "Request",
                value: digest(receipt.request_sha256),
              },
              {
                id: "dispatch",
                label: "Dispatch",
                value: digest(receipt.dispatch_sha256),
              },
              {
                id: "receipt",
                label: "Receipt",
                value: digest(receipt.receipt_sha256),
              },
              { id: "state", label: "Execution", value: receipt.execution_state },
              { id: "scope", label: "Receipt scope", value: "documentary only" },
            ]}
          />
        )}
      </ElementSection>
    </>
  );
}

function admittedSections(
  data: AdmittedResult,
  format: NumberFormats,
): ComponentChildren {
  const { signConvention, execution, recorded } = data;
  return (
    <>
      {signConvention && (
        <ElementSection title="Sign convention">
          <Facts
            items={[
              { id: "kind", label: "Convention", value: signConvention.kind },
              {
                id: "source-current",
                label: "Source branch current",
                value: signConvention.voltageSourceBranchCurrent,
              },
              {
                id: "passive-current",
                label: "Passive current",
                value: signConvention.passiveCurrent,
              },
            ]}
          />
        </ElementSection>
      )}
      {execution && (
        <ElementSection title="Execution">
          <Facts
            items={[
              {
                id: "engine",
                label: "Engine",
                value: `${execution.engine.name} ${execution.engine.version}`,
              },
              { id: "termination", label: "Termination", value: execution.termination },
              {
                id: "source-bytes",
                label: "Netlist size",
                value: `${format.integer(execution.counts.sourceBytes)} bytes`,
              },
              {
                id: "agent-run",
                label: "Agent run",
                value: digest(execution.agentRunId),
              },
              {
                id: "execution-run",
                label: "Execution run",
                value: digest(execution.executionRunId),
              },
            ]}
          />
        </ElementSection>
      )}
      {execution && (
        <ElementSection title="Digests">
          <Facts
            items={[
              { id: "source", label: "Netlist", value: digest(execution.sourceSha256) },
              {
                id: "receipt",
                label: "Receipt",
                value: digest(execution.receiptFingerprint),
              },
              {
                id: "evidence",
                label: "Evidence",
                value: digest(execution.evidenceSha256),
              },
              { id: "result", label: "Result", value: digest(execution.resultSha256) },
            ]}
          />
        </ElementSection>
      )}
      <NoticeGroup label="Limitations" items={execution?.limitations ?? []} />
      <ElementSection title="Provenance">
        <Facts
          items={[
            { id: "subject", label: "Subject", value: recorded.subjectId },
            {
              id: "thread",
              label: "Thread",
              value: `${recorded.thread.id} r${recorded.thread.revision}`,
            },
            { id: "schema", label: "Schema", value: digest(data.sourceSchema) },
          ]}
        />
        <ArtifactRow
          label="Admitted result"
          kind="artifact"
          uri={recorded.artifact.id}
          fingerprint={fingerprintParts(recorded.artifact.fingerprint)}
        />
      </ElementSection>
    </>
  );
}

function failedSections(data: FailedResult): ComponentChildren {
  const context = Object.entries(data.context);
  return (
    <>
      <Message tone="danger">{data.recovery}</Message>
      {context.length > 0 && (
        <ElementSection title="Context">
          <Facts
            items={context.map(([key, value]) => ({
              id: key,
              label: key,
              value: digest(JSON.stringify(value)),
            }))}
          />
        </ElementSection>
      )}
      {data.input_artifact_source_path && (
        <ElementSection title="Provenance">
          <ArtifactRow
            label="Netlist"
            kind="input"
            uri={data.input_artifact_source_path}
          />
        </ElementSection>
      )}
    </>
  );
}

function Facts({ items }: { readonly items: readonly Fact[] }) {
  return <KeyValueList layout="facts" items={items} />;
}

function digest(value: string): ComponentChild {
  return <InlineCode>{value}</InlineCode>;
}

function outcomeSha256(data: LiveResult): string | undefined {
  return data.documentary_receipt?.outcome_sha256 ?? data.outcome_sha256;
}

/** The thread spells fingerprints `sha256:<hex>`; the artifact row shows the two parts. */
function fingerprintParts(fingerprint: Sha256Fingerprint): ArtifactFingerprint {
  return { algorithm: "sha256", digest: fingerprint.slice("sha256:".length) };
}

/**
 * The one digest the footer carries: whatever identifies this result and is shown
 * nowhere else. The netlist digest already sits on its artifact row.
 */
function footerFingerprint(
  data: SimulationViewData,
): { label: string; value: string } | undefined {
  if (data.kind === "recorded-admitted-operating-point") {
    return { label: "Projection", value: data.recorded.projectionFingerprint };
  }
  const outcome = data.kind === "failed-outcome"
    ? data.outcome_sha256
    : outcomeSha256(data);
  return outcome ? { label: "Outcome SHA-256", value: outcome } : undefined;
}
