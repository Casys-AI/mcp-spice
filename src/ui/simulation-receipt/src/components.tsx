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
  ElementSection,
  InlineCode,
  KeyValueList,
  SemanticElement,
} from "@casys/mcp-view-components/preact/components";
import type { ComponentChild } from "preact";
import { SPICE_RECEIPT_COMPONENT } from "../../constants.ts";
import { type NumberFormats, numberFormats } from "../../shared/format.ts";
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

const ANALYSIS_LABELS: Record<AnalysisKind, string> = {
  op: "Operating point",
  tran: "Transient",
  dc: "DC sweep",
};

/**
 * A receipt reads as a datasheet: what ran and how it ended in the readings strip,
 * what was asked, on which runtime, and every digest once in its own section.
 */
const Receipt = ({ data, context }: ReceiptProps) => {
  const { receipt } = data;
  const failed = receipt.execution_state === "failed";
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
          label="Simulation receipt"
          detail={`${
            ANALYSIS_LABELS[receipt.analysis_kind]
          } analysis · documentary record`}
        />
      }
      reading={readings(receipt, format).map((reading) => (
        <ElementReading
          key={reading.id}
          label={reading.label}
          value={reading.value}
          unit={reading.unit}
        />
      ))}
      body={
        <ElementBody>
          <ElementSection title="Request">
            <Facts items={requestFacts(receipt.normalized_request, format)} />
          </ElementSection>
          <ElementSection title="Runtime">
            <Facts items={runtimeFacts(receipt.runtime_identity)} />
          </ElementSection>
          <ElementSection title="Digests">
            <Facts items={digestFacts(receipt)} />
          </ElementSection>
        </ElementBody>
      }
      provenance={
        <ElementProvenance
          label="Receipt"
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
function readings(receipt: SimulationReceipt, format: NumberFormats): Reading[] {
  const request = receipt.normalized_request;
  const state: Reading = {
    id: "state",
    label: "Execution state",
    value: receipt.execution_state,
  };
  if (request.kind === "tran") {
    return [
      state,
      {
        id: "tstep",
        label: "Time step",
        value: format.number(request.tstep_s),
        unit: "s",
      },
      {
        id: "tstop",
        label: "Stop time",
        value: format.number(request.tstop_s),
        unit: "s",
      },
    ];
  }
  if (request.kind === "dc") {
    return [
      state,
      { id: "source", label: "Swept source", value: request.sweep_source },
      { id: "start", label: "Start", value: format.number(request.start_v), unit: "V" },
      { id: "stop", label: "Stop", value: format.number(request.stop_v), unit: "V" },
      { id: "step", label: "Step", value: format.number(request.step_v), unit: "V" },
    ];
  }
  return [state];
}

function requestFacts(request: NormalizedRequest, format: NumberFormats): Fact[] {
  return [
    { id: "nodes", label: "Nodes", value: request.nodes.join(", ") || "—" },
    {
      id: "branch-sources",
      label: "Branch sources",
      value: request.branch_sources.join(", ") || "—",
    },
    { id: "timeout", label: "Timeout", value: `${format.number(request.timeout_s)} s` },
  ];
}

function runtimeFacts(identity: RuntimeIdentity): Fact[] {
  return [
    { id: "mcp-spice", label: "mcp-spice", value: identity.mcp_spice_version },
    { id: "engine", label: "Engine", value: identity.ngspice_version },
    { id: "deno", label: "Deno", value: identity.deno_version },
    { id: "platform", label: "Platform", value: `${identity.os} / ${identity.arch}` },
    { id: "budgets", label: "Execution budgets", value: identity.execution_budgets },
  ];
}

function digestFacts(receipt: SimulationReceipt): Fact[] {
  return [
    { id: "request", label: "Request", value: digest(receipt.request_sha256) },
    { id: "dispatch", label: "Dispatch", value: digest(receipt.dispatch_sha256) },
    { id: "netlist", label: "Netlist", value: digest(receipt.netlist_sha256) },
    { id: "outcome", label: "Outcome", value: digest(receipt.outcome_sha256) },
    {
      id: "engine",
      label: "Engine",
      value: digest(receipt.runtime_identity.ngspice_version_sha256),
    },
  ];
}

const Facts = ({ items }: { readonly items: readonly Fact[] }) => (
  <KeyValueList layout="facts" items={items} />
);

const digest = (value: string): ComponentChild => <InlineCode>{value}</InlineCode>;
