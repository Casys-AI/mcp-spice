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
  ElementIdent,
  ElementProvenance,
  ElementReading,
  InlineCode,
  KeyValueList,
  Message,
  SemanticElement,
} from "@casys/mcp-view-components/preact/components";
import { SPICE_RECEIPT_COMPONENT_KEYS, SPICE_RECEIPT_SURFACE } from "./catalog.ts";
import type { NormalizedRequest, ReceiptViewData, RuntimeIdentity } from "./model.ts";
import { formatNumber } from "../../shared/format.ts";

type ReceiptProps = PreactSurfaceComponentProps<ReceiptViewData>;

const Receipt = ({ data }: ReceiptProps) => {
  const failed = data.receipt.execution_state === "failed";
  return (
    <SemanticElement
      reference={{
        domain: "spice",
        kind: "simulation-receipt",
        id: data.receipt_sha256,
        basisFingerprint: data.receipt.netlist_sha256,
      }}
      density="card"
      tone={failed ? "danger" : "neutral"}
      ident={
        <ElementIdent
          marker={data.receipt.analysis_kind.toUpperCase()}
          label="Simulation receipt"
          detail="Documentary provider record"
        />
      }
      reading={
        <ElementReading
          label="execution_state"
          value={data.receipt.execution_state}
        />
      }
      body={
        <Message tone="neutral">
          documentary_only · not Digital Thread evidence
        </Message>
      }
      provenance={
        <ElementProvenance
          label="receipt SHA-256"
          value={<InlineCode>{data.receipt_sha256}</InlineCode>}
        />
      }
    />
  );
};

const Identities = ({ data }: ReceiptProps) => (
  <Card title="Receipt identities" eyebrow="SHA-256">
    <KeyValueList
      items={[
        {
          id: "receipt_sha256",
          label: "receipt_sha256",
          value: <InlineCode>{data.receipt_sha256}</InlineCode>,
        },
        {
          id: "request_sha256",
          label: "request_sha256",
          value: <InlineCode>{data.receipt.request_sha256}</InlineCode>,
        },
        {
          id: "dispatch_sha256",
          label: "dispatch_sha256",
          value: <InlineCode>{data.receipt.dispatch_sha256}</InlineCode>,
        },
        {
          id: "netlist_sha256",
          label: "netlist_sha256",
          value: <InlineCode>{data.receipt.netlist_sha256}</InlineCode>,
        },
        {
          id: "outcome_sha256",
          label: "outcome_sha256",
          value: <InlineCode>{data.receipt.outcome_sha256}</InlineCode>,
        },
        {
          id: "execution_state",
          label: "execution_state",
          value: data.receipt.execution_state,
        },
      ]}
    />
  </Card>
);

const Runtime = ({ data }: ReceiptProps) => (
  <Card title="Runtime identity" eyebrow="Provider environment">
    <KeyValueList items={runtimeItems(data.receipt.runtime_identity)} />
  </Card>
);

const Request = ({ data }: ReceiptProps) => (
  <Card title="Normalized request" eyebrow={data.receipt.analysis_kind}>
    <KeyValueList items={requestItems(data.receipt.normalized_request)} />
  </Card>
);

export const SPICE_RECEIPT_REGISTRY = defineComponentRegistry<
  ReceiptViewData,
  PreactSurfaceContext<ReceiptViewData>
>({
  components: {
    [SPICE_RECEIPT_COMPONENT_KEYS.receipt]: definePreactComponent(
      {
        title: "Simulation receipt",
        description:
          "One documentary receipt identity with the literal execution_state.",
      },
      Receipt,
    ),
    [SPICE_RECEIPT_COMPONENT_KEYS.identities]: definePreactComponent(
      {
        title: "Receipt identities",
        description: "SHA-256 identities bound by the documentary receipt.",
      },
      Identities,
    ),
    [SPICE_RECEIPT_COMPONENT_KEYS.runtimeIdentity]: definePreactComponent(
      {
        title: "Runtime identity",
        description: "Provider, budget, Deno, and ngspice identity fields.",
      },
      Runtime,
    ),
    [SPICE_RECEIPT_COMPONENT_KEYS.normalizedRequest]: definePreactComponent(
      {
        title: "Normalized request",
        description: "Canonical request fields stored on the receipt.",
      },
      Request,
    ),
  },
  defaultSurface: defineComponentSurface(SPICE_RECEIPT_SURFACE),
});

function runtimeItems(identity: RuntimeIdentity) {
  return [
    {
      id: "mcp_spice_version",
      label: "mcp_spice_version",
      value: identity.mcp_spice_version,
    },
    {
      id: "execution_budgets",
      label: "execution_budgets",
      value: identity.execution_budgets,
    },
    {
      id: "deno_version",
      label: "deno_version",
      value: identity.deno_version,
    },
    { id: "os", label: "os", value: identity.os },
    { id: "arch", label: "arch", value: identity.arch },
    {
      id: "ngspice_version",
      label: "ngspice_version",
      value: identity.ngspice_version,
    },
    {
      id: "ngspice_version_sha256",
      label: "ngspice_version_sha256",
      value: <InlineCode>{identity.ngspice_version_sha256}</InlineCode>,
    },
  ];
}

function requestItems(request: NormalizedRequest) {
  const shared = [
    { id: "nodes", label: "nodes", value: request.nodes.join(", ") || "—" },
    {
      id: "branch_sources",
      label: "branch_sources",
      value: request.branch_sources.join(", ") || "—",
    },
    {
      id: "timeout_s",
      label: "timeout_s",
      value: formatNumber(request.timeout_s),
    },
  ];
  if (request.kind === "tran") {
    return [
      {
        id: "tstep_s",
        label: "tstep_s",
        value: `${formatNumber(request.tstep_s)} s`,
      },
      {
        id: "tstop_s",
        label: "tstop_s",
        value: `${formatNumber(request.tstop_s)} s`,
      },
      ...shared,
    ];
  }
  if (request.kind === "dc") {
    return [
      {
        id: "sweep_source",
        label: "sweep_source",
        value: request.sweep_source,
      },
      {
        id: "start_v",
        label: "start_v",
        value: `${formatNumber(request.start_v)} V`,
      },
      {
        id: "stop_v",
        label: "stop_v",
        value: `${formatNumber(request.stop_v)} V`,
      },
      {
        id: "step_v",
        label: "step_v",
        value: `${formatNumber(request.step_v)} V`,
      },
      ...shared,
    ];
  }
  return shared;
}
