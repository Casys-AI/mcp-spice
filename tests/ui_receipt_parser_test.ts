import { assertEquals, assertThrows } from "@std/assert";
import {
  displayStateFromReceiptToolResult,
  parseReceiptViewData,
} from "../src/ui/simulation-receipt/src/model.ts";

const SHA = {
  receipt: "1".repeat(64),
  request: "2".repeat(64),
  dispatch: "3".repeat(64),
  netlist: "4".repeat(64),
  outcome: "5".repeat(64),
  ngspice: "6".repeat(64),
};

const receipt = {
  type: "spice-simulation-receipt/1.0",
  request_sha256: SHA.request,
  dispatch_sha256: SHA.dispatch,
  analysis_kind: "op",
  netlist_sha256: SHA.netlist,
  normalized_request: {
    nodes: ["out"],
    branch_sources: [],
    timeout_s: 30,
  },
  runtime_identity: {
    mcp_spice_version: "0.6.0",
    execution_budgets: "execution-budgets/1.0",
    deno_version: "2.9.6",
    os: "linux",
    arch: "aarch64",
    ngspice_version: "ngspice-44.2",
    ngspice_version_sha256: SHA.ngspice,
  },
  outcome_sha256: SHA.outcome,
  execution_state: "succeeded",
};

Deno.test("receipt parser copies documentary identity and literal execution_state", () => {
  const parsed = parseReceiptViewData({
    receipt_sha256: SHA.receipt,
    receipt,
  });
  assertEquals(parsed.kind, "simulation-receipt");
  assertEquals(parsed.receipt.execution_state, "succeeded");
  assertEquals(parsed.receipt.type, "spice-simulation-receipt/1.0");
  assertEquals(parsed.receipt.analysis_kind, "op");
});

Deno.test("receipt parser keeps failed as failed, never pass or proof", () => {
  const parsed = parseReceiptViewData({
    receipt_sha256: SHA.receipt,
    receipt: { ...receipt, execution_state: "failed" },
  });
  assertEquals(parsed.receipt.execution_state, "failed");
  assertThrows(
    () =>
      parseReceiptViewData({
        receipt_sha256: SHA.receipt,
        receipt: { ...receipt, execution_state: "pass" },
      }),
    TypeError,
    "succeeded or failed",
  );
});

Deno.test("receipt parser rejects Digital Thread fields and extra keys", () => {
  assertThrows(
    () =>
      parseReceiptViewData({
        receipt_sha256: SHA.receipt,
        receipt: { ...receipt, evidence_uri: "casys://thread/run" },
      }),
    TypeError,
    "unsupported fields",
  );
  const submit = displayStateFromReceiptToolResult({
    structuredContent: {
      sha256: SHA.netlist,
      bytes: 87,
      uri: `spice-netlist:sha256:${SHA.netlist}`,
    },
  });
  assertEquals(submit.kind, "error");
});
