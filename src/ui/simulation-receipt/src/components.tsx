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
  Disclosure,
  ElementBody,
  ElementIdent,
  ElementProvenance,
  ElementReading,
  ElementSection,
  InlineCode,
  KeyValueList,
  SemanticElement,
} from "@casys/mcp-view-components/preact/components";
import type { ComponentChild } from "preact";
import { SPICE_RECEIPT_COMPONENT } from "../../constants.ts";
import { type NumberFormats, numberFormats } from "../../shared/format.ts";
import { spiceMessages, type SpiceTranslator } from "../../shared/i18n.ts";
import type {
  AnalysisKind,
  NormalizedRequest,
  ReceiptViewData,
  RuntimeIdentity,
  SimulationReceipt,
} from "./model.ts";

export { SPICE_RECEIPT_COMPONENT };
export const SPICE_RECEIPT_SURFACE = {
  // The datasheet surface is one framed sheet; its sections rule themselves apart.
  layout: { type: "stack", gap: "none" },
  components: [{ id: "receipt", component: SPICE_RECEIPT_COMPONENT }],
} as const;

type ReceiptProps = PreactSurfaceComponentProps<ReceiptViewData>;

interface Reading {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
}

interface Fact {
  readonly id: string;
  readonly label: string;
  readonly value: ComponentChild;
}

function analysisLabel(kind: AnalysisKind, t: SpiceTranslator): string {
  switch (kind) {
    case "op":
      return t("analysisOp");
    case "tran":
      return t("analysisTran");
    case "dc":
      return t("analysisDc");
  }
}

/**
 * A receipt reads as a datasheet: what ran and how it ended in the readings strip,
 * request/runtime/digests under a closed native disclosure.
 */
const Receipt = ({ data, context }: ReceiptProps) => {
  const { receipt } = data;
  const failed = receipt.execution_state === "failed";
  const t = spiceMessages(context.hostContext.locale);
  const format = numberFormats(context.hostContext.locale);
  return (
    <SemanticElement
      reference={{
        domain: "spice",
        kind: "simulation-receipt",
        id: data.receipt_sha256,
        basisFingerprint: receipt.netlist_sha256,
      }}
      density="card"
      tone={failed ? "danger" : "neutral"}
      ident={
        <ElementIdent
          marker={receipt.analysis_kind.toUpperCase()}
          label={t("simulationReceipt")}
          detail={t("receiptDetail", {
            analysis: analysisLabel(receipt.analysis_kind, t),
          })}
        />
      }
      reading={readings(receipt, format, t).map((reading) => (
        <ElementReading
          key={reading.id}
          label={reading.label}
          value={reading.value}
          unit={reading.unit}
        />
      ))}
      body={
        <ElementBody>
          <Disclosure label={t("technicalDetails")}>
            <ElementSection title={t("request")}>
              <Facts items={requestFacts(receipt.normalized_request, format, t)} />
            </ElementSection>
            <ElementSection title={t("runtime")}>
              <Facts items={runtimeFacts(receipt.runtime_identity, t)} />
            </ElementSection>
            <ElementSection title={t("digests")}>
              <Facts items={digestFacts(receipt, t)} />
            </ElementSection>
          </Disclosure>
        </ElementBody>
      }
      provenance={
        <ElementProvenance
          label={t("receipt")}
          value={<InlineCode>{data.receipt_sha256}</InlineCode>}
        />
      }
    />
  );
};

export const SPICE_RECEIPT_REGISTRY = defineComponentRegistry<
  ReceiptViewData,
  PreactSurfaceContext<ReceiptViewData>
>({
  components: {
    [SPICE_RECEIPT_COMPONENT]: definePreactComponent(
      {
        title: "SPICE simulation receipt",
        description:
          "One exact receipt with request, runtime, terminal state, and documentary identities.",
      },
      Receipt,
    ),
  },
  defaultSurface: defineComponentSurface(SPICE_RECEIPT_SURFACE),
});

/** The terminal state is copied literally; the analysis axis joins it as the headline. */
function readings(
  receipt: SimulationReceipt,
  format: NumberFormats,
  t: SpiceTranslator,
): Reading[] {
  const request = receipt.normalized_request;
  const state: Reading = {
    id: "state",
    label: t("executionState"),
    value: receipt.execution_state,
  };
  if (request.kind === "tran") {
    return [
      state,
      {
        id: "tstep",
        label: t("timeStep"),
        value: format.number(request.tstep_s),
        unit: "s",
      },
      {
        id: "tstop",
        label: t("stopTime"),
        value: format.number(request.tstop_s),
        unit: "s",
      },
    ];
  }
  if (request.kind === "dc") {
    return [
      state,
      { id: "source", label: t("sweptSource"), value: request.sweep_source },
      {
        id: "start",
        label: t("start"),
        value: format.number(request.start_v),
        unit: "V",
      },
      { id: "stop", label: t("stop"), value: format.number(request.stop_v), unit: "V" },
      { id: "step", label: t("step"), value: format.number(request.step_v), unit: "V" },
    ];
  }
  return [state];
}

function requestFacts(
  request: NormalizedRequest,
  format: NumberFormats,
  t: SpiceTranslator,
): Fact[] {
  return [
    {
      id: "nodes",
      label: t("nodes"),
      value: request.nodes.join(", ") || t("emptyList"),
    },
    {
      id: "branch-sources",
      label: t("branchSources"),
      value: request.branch_sources.join(", ") || t("emptyList"),
    },
    {
      id: "timeout",
      label: t("timeout"),
      value: t("timeoutValue", { n: format.number(request.timeout_s) }),
    },
  ];
}

function runtimeFacts(identity: RuntimeIdentity, t: SpiceTranslator): Fact[] {
  return [
    { id: "mcp-spice", label: "mcp-spice", value: identity.mcp_spice_version },
    { id: "engine", label: t("engine"), value: identity.ngspice_version },
    { id: "deno", label: "Deno", value: identity.deno_version },
    {
      id: "platform",
      label: t("platform"),
      value: `${identity.os} / ${identity.arch}`,
    },
    {
      id: "budgets",
      label: t("executionBudgets"),
      value: identity.execution_budgets,
    },
  ];
}

function digestFacts(receipt: SimulationReceipt, t: SpiceTranslator): Fact[] {
  return [
    { id: "request", label: t("request"), value: digest(receipt.request_sha256) },
    { id: "dispatch", label: t("dispatch"), value: digest(receipt.dispatch_sha256) },
    { id: "netlist", label: t("netlist"), value: digest(receipt.netlist_sha256) },
    { id: "outcome", label: t("outcome"), value: digest(receipt.outcome_sha256) },
    {
      id: "engine",
      label: t("engine"),
      value: digest(receipt.runtime_identity.ngspice_version_sha256),
    },
  ];
}

const Facts = ({ items }: { readonly items: readonly Fact[] }) => (
  <KeyValueList layout="facts" items={items} />
);

const digest = (value: string): ComponentChild => <InlineCode>{value}</InlineCode>;
