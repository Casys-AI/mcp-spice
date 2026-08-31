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
  InlineCode,
  KeyValueList,
  SemanticElement,
  Stack,
} from "@casys/mcp-view-components/preact/components";
import { SPICE_RECEIPT_COMPONENT } from "../../constants.ts";
import { formatNumber } from "../../shared/format.ts";
import type { NormalizedRequest, ReceiptViewData, RuntimeIdentity } from "./model.ts";

export { SPICE_RECEIPT_COMPONENT };
export const SPICE_RECEIPT_SURFACE = {
  layout: { type: "stack", gap: "sm" },
  components: [{ id: "receipt", component: SPICE_RECEIPT_COMPONENT }],
} as const;

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
          detail="Exact documentary provider record"
        />
      }
      reading={
        <ElementReading
          label="execution_state"
          value={data.receipt.execution_state}
        />
      }
      body={
        <ElementBody>
          <Stack gap="sm">
            <KeyValueList items={requestItems(data.receipt.normalized_request)} />
            <KeyValueList items={runtimeItems(data.receipt.runtime_identity)} />
            <KeyValueList
              items={[
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
              ]}
            />
          </Stack>
        </ElementBody>
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
    { id: "deno_version", label: "deno_version", value: identity.deno_version },
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
      value: `${formatNumber(request.timeout_s)} s`,
    },
  ];
  if (request.kind === "tran") {
    return [
      { id: "tstep_s", label: "tstep_s", value: `${formatNumber(request.tstep_s)} s` },
      { id: "tstop_s", label: "tstop_s", value: `${formatNumber(request.tstop_s)} s` },
      ...shared,
    ];
  }
  if (request.kind === "dc") {
    return [
      { id: "sweep_source", label: "sweep_source", value: request.sweep_source },
      { id: "start_v", label: "start_v", value: `${formatNumber(request.start_v)} V` },
      { id: "stop_v", label: "stop_v", value: `${formatNumber(request.stop_v)} V` },
      { id: "step_v", label: "step_v", value: `${formatNumber(request.step_v)} V` },
      ...shared,
    ];
  }
  return shared;
}
