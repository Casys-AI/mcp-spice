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
  Disclosure,
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
import { spiceMessages, type SpiceTranslator } from "../../shared/i18n.ts";
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
  const t = spiceMessages(context.hostContext.locale);
  const format = numberFormats(context.hostContext.locale);
  const quantities = isPoint(data) ? pointQuantities(data, format, t) : [];
  // Every quantity or none: a positional subset is not a headline.
  const quantitiesInStrip = quantities.length > 0 &&
    quantities.length <= READING_STRIP_LIMIT;
  const readings = quantitiesInStrip
    ? quantities.map((quantity) => ({ ...quantity, detail: quantity.kind }))
    : isReduced(data)
    ? axisReadings(data, format, t)
    : [];
  const footer = footerFingerprint(data, t);
  const technical = technicalSections(data, format, t);
  return (
    <SemanticElement
      reference={resultReference(data)}
      density="card"
      tone={data.kind === "failed-outcome" ? "danger" : "neutral"}
      ident={
        <ElementIdent
          marker={resultMarker(data)}
          label={resultTitle(data, t)}
          detail={resultDetail(data, t)}
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
            <ElementSection title={t("quantities")}>
              {quantityTable(quantities, t)}
            </ElementSection>
          )}
          {isReduced(data) && (
            <ElementSection title={t("extrema")}>
              {extremaTable(data, format, t)}
            </ElementSection>
          )}
          {primarySections(data, format, t)}
          {technical && (
            <Disclosure label={t("technicalDetails")}>{technical}</Disclosure>
          )}
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

function resultTitle(data: SimulationViewData, t: SpiceTranslator): string {
  switch (data.kind) {
    case "operating-point":
      return t("operatingPoint");
    case "recorded-admitted-operating-point":
      return t("admittedOperatingPoint");
    case "dc-sweep":
      return t("reducedDcSweep");
    case "transient-result":
      return t("reducedTransient");
    case "failed-outcome":
      return data.code;
  }
}

function resultDetail(data: SimulationViewData, t: SpiceTranslator): string {
  switch (data.kind) {
    case "operating-point":
      return data.source === "durable"
        ? t("durableOperatingPoint")
        : t("dcOperatingPoint");
    case "recorded-admitted-operating-point":
      return t("recordedSession");
    case "dc-sweep":
      return t("dcSweepDetail");
    case "transient-result":
      return t("transientDetail");
    case "failed-outcome":
      return t("typedFailure");
  }
}

function quantityKindLabel(
  kind: "node-voltage" | "branch-current",
  t: SpiceTranslator,
): string {
  return kind === "node-voltage" ? t("nodeVoltage") : t("branchCurrent");
}

function pointQuantities(
  data: PointResult,
  format: NumberFormats,
  t: SpiceTranslator,
): Quantity[] {
  if (data.kind === "recorded-admitted-operating-point") {
    return data.observables.map((observable) => ({
      id: observable.nativeName,
      label: observable.nativeName,
      kind: t("quantityKind", {
        kind: quantityKindLabel(observable.kind, t),
        symbol: observable.sourceSymbol,
      }),
      value: format.number(observable.value),
      unit: observable.unit,
    }));
  }
  return [
    ...sortedEntries(data.node_voltages).map(([name, value]) => ({
      id: `v:${name}`,
      label: name,
      kind: t("nodeVoltage"),
      value: format.number(value),
      unit: "V",
    })),
    ...sortedEntries(data.branch_currents_a).map(([name, value]) => ({
      id: `i:${name}`,
      label: name,
      kind: t("branchCurrent"),
      value: format.number(value),
      unit: "A",
    })),
  ];
}

/** The reduced analyses headline their axis; their quantities are extrema, tabled below. */
function axisReadings(
  data: ReducedResult,
  format: NumberFormats,
  t: SpiceTranslator,
): Reading[] {
  if (data.kind === "dc-sweep") {
    return [
      { id: "source", label: t("sweptSource"), value: data.sweep.source },
      {
        id: "start",
        label: t("start"),
        value: format.number(data.sweep.start_v),
        unit: "V",
      },
      {
        id: "stop",
        label: t("stop"),
        value: format.number(data.sweep.stop_v),
        unit: "V",
      },
      {
        id: "step",
        label: t("step"),
        value: format.number(data.sweep.step_v),
        unit: "V",
      },
      {
        id: "points",
        label: t("points"),
        value: format.integer(data.sweep.n_points),
        detail: t("ofAllowed", { max: format.integer(data.sweep.max_points) }),
      },
    ];
  }
  return [
    {
      id: "points",
      label: t("points"),
      value: format.integer(data.simulation.n_points),
    },
    {
      id: "tstop",
      label: t("stopTime"),
      value: format.number(data.simulation.tstop_s),
      unit: "s",
    },
  ];
}

function quantityTable(
  quantities: readonly Quantity[],
  t: SpiceTranslator,
): ComponentChild {
  return (
    <DataTable
      label={t("quantities")}
      rows={quantities}
      rowKey={(quantity) => quantity.id}
      columns={[
        { id: "quantity", label: t("quantity"), render: (quantity) => quantity.label },
        { id: "kind", label: t("kind"), render: (quantity) => quantity.kind },
        {
          id: "value",
          label: t("value"),
          align: "right",
          render: (quantity) => <span class="spice-figure">{quantity.value}</span>,
        },
        { id: "unit", label: t("unit"), render: (quantity) => quantity.unit },
      ]}
    />
  );
}

function extremaTable(
  data: ReducedResult,
  format: NumberFormats,
  t: SpiceTranslator,
): ComponentChild {
  const axisUnit = data.kind === "dc-sweep" ? "V" : "s";
  const figure = (value: number, at: number | undefined): AxisFigure => ({
    value: format.number(value),
    at: at === undefined
      ? ""
      : t("atAxis", { value: format.number(at), unit: axisUnit }),
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
      label={t("extrema")}
      rows={rows}
      rowKey={(row) => row.id}
      columns={[
        { id: "quantity", label: t("quantity"), render: (row) => row.label },
        {
          id: "min",
          label: t("min"),
          align: "right",
          render: (row) => axisFigure(row.min),
        },
        {
          id: "max",
          label: t("max"),
          align: "right",
          render: (row) => axisFigure(row.max),
        },
        {
          id: "final",
          label: t("final"),
          align: "right",
          render: (row) => axisFigure(row.final),
        },
        { id: "unit", label: t("unit"), render: (row) => row.unit },
      ]}
    />
  );
}

function primarySections(
  data: SimulationViewData,
  format: NumberFormats,
  t: SpiceTranslator,
): ComponentChildren {
  switch (data.kind) {
    case "failed-outcome":
      return <Message tone="danger">{data.recovery}</Message>;
    case "recorded-admitted-operating-point":
      return (
        <NoticeGroup
          label={t("limitations")}
          items={data.execution?.limitations ?? []}
        />
      );
    default:
      return livePrimary(data, format, t);
  }
}

function technicalSections(
  data: SimulationViewData,
  format: NumberFormats,
  t: SpiceTranslator,
): ComponentChildren {
  switch (data.kind) {
    case "failed-outcome":
      return failedTechnical(data, t);
    case "recorded-admitted-operating-point":
      return admittedTechnical(data, format, t);
    default:
      return liveTechnical(data, format, t);
  }
}

function livePrimary(
  data: LiveResult,
  format: NumberFormats,
  t: SpiceTranslator,
): ComponentChildren {
  const measurements = sortedEntries(data.measurements);
  return (
    <>
      {measurements.length > 0 && (
        <ElementSection title={t("measurements")}>
          <Facts
            items={measurements.map(([name, measurement]) => ({
              id: `measurement:${name}`,
              label: name,
              value: format.number(measurement.value),
            }))}
          />
        </ElementSection>
      )}
      <NoticeGroup label={t("notChecked")} items={data.not_checked} />
    </>
  );
}

function liveTechnical(
  data: LiveResult,
  format: NumberFormats,
  t: SpiceTranslator,
): ComponentChildren {
  const receipt = data.documentary_receipt;
  const path = data.input_artifact.source_path ?? data.input_artifact_source_path;
  return (
    <ElementSection title={t("provenance")}>
      <ArtifactRow
        label={t("netlist")}
        kind="input"
        uri={path ?? `sha256:${data.input_artifact.sha256}`}
        fingerprint={path
          ? { algorithm: "sha256", digest: data.input_artifact.sha256 }
          : undefined}
        sizeLabel={t("bytes", { n: format.integer(data.input_artifact.bytes) })}
      />
      {receipt && (
        <Facts
          items={[
            {
              id: "request",
              label: t("request"),
              value: digest(receipt.request_sha256),
            },
            {
              id: "dispatch",
              label: t("dispatch"),
              value: digest(receipt.dispatch_sha256),
            },
            {
              id: "receipt",
              label: t("receipt"),
              value: digest(receipt.receipt_sha256),
            },
            { id: "state", label: t("execution"), value: receipt.execution_state },
            { id: "scope", label: t("receiptScope"), value: t("documentaryOnly") },
          ]}
        />
      )}
    </ElementSection>
  );
}

function admittedTechnical(
  data: AdmittedResult,
  format: NumberFormats,
  t: SpiceTranslator,
): ComponentChildren {
  const { signConvention, execution, recorded } = data;
  return (
    <>
      {signConvention && (
        <ElementSection title={t("signConvention")}>
          <Facts
            items={[
              { id: "kind", label: t("convention"), value: signConvention.kind },
              {
                id: "source-current",
                label: t("sourceBranchCurrent"),
                value: signConvention.voltageSourceBranchCurrent,
              },
              {
                id: "passive-current",
                label: t("passiveCurrent"),
                value: signConvention.passiveCurrent,
              },
            ]}
          />
        </ElementSection>
      )}
      {execution && (
        <ElementSection title={t("execution")}>
          <Facts
            items={[
              {
                id: "engine",
                label: t("engine"),
                value: `${execution.engine.name} ${execution.engine.version}`,
              },
              {
                id: "termination",
                label: t("termination"),
                value: execution.termination,
              },
              {
                id: "source-bytes",
                label: t("netlistSize"),
                value: t("bytes", {
                  n: format.integer(execution.counts.sourceBytes),
                }),
              },
              {
                id: "agent-run",
                label: t("agentRun"),
                value: digest(execution.agentRunId),
              },
              {
                id: "execution-run",
                label: t("executionRun"),
                value: digest(execution.executionRunId),
              },
            ]}
          />
        </ElementSection>
      )}
      {execution && (
        <ElementSection title={t("digests")}>
          <Facts
            items={[
              {
                id: "source",
                label: t("netlist"),
                value: digest(execution.sourceSha256),
              },
              {
                id: "receipt",
                label: t("receipt"),
                value: digest(execution.receiptFingerprint),
              },
              {
                id: "evidence",
                label: t("evidence"),
                value: digest(execution.evidenceSha256),
              },
              {
                id: "result",
                label: t("result"),
                value: digest(execution.resultSha256),
              },
            ]}
          />
        </ElementSection>
      )}
      <ElementSection title={t("provenance")}>
        <Facts
          items={[
            { id: "project", label: t("project"), value: recorded.projectId },
            {
              id: "project-revision",
              label: t("projectRevision"),
              value: String(recorded.projectRevision),
            },
            { id: "subject", label: t("subject"), value: recorded.subjectId },
            {
              id: "thread",
              label: t("thread"),
              value: t("threadRevision", {
                id: recorded.thread.id,
                revision: recorded.thread.revision,
              }),
            },
            { id: "schema", label: t("schema"), value: digest(data.sourceSchema) },
            {
              id: "projection",
              label: t("projection"),
              value: digest(recorded.projectionFingerprint),
            },
          ]}
        />
        <ArtifactRow
          label={t("admittedResult")}
          kind="artifact"
          uri={recorded.artifact.id}
          fingerprint={fingerprintParts(recorded.artifact.fingerprint)}
        />
      </ElementSection>
    </>
  );
}

function failedTechnical(
  data: FailedResult,
  t: SpiceTranslator,
): ComponentChildren {
  const context = Object.entries(data.context);
  if (context.length === 0 && !data.input_artifact_source_path) return null;
  return (
    <>
      {context.length > 0 && (
        <ElementSection title={t("context")}>
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
        <ElementSection title={t("provenance")}>
          <ArtifactRow
            label={t("netlist")}
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
 * The one digest the footer carries for live and failed results. Admitted
 * recorded sessions keep the projection digest in the closed disclosure instead.
 */
function footerFingerprint(
  data: SimulationViewData,
  t: SpiceTranslator,
): { label: string; value: string } | undefined {
  if (data.kind === "recorded-admitted-operating-point") return undefined;
  const outcome = data.kind === "failed-outcome"
    ? data.outcome_sha256
    : outcomeSha256(data);
  return outcome ? { label: t("outcomeSha256"), value: outcome } : undefined;
}
