/**
 * Closed parsers for SPICE MCP App projections. These tests fail if a missing
 * adapter lets extra fields, invented units, or verdict language through.
 */
import { assertEquals, assertThrows } from "@std/assert";
import {
  displayStateFromToolResult,
  parseSimulationViewData,
} from "../src/ui/simulation-result/src/model.ts";

const NETLIST = "a".repeat(64);
const REQUEST = "b".repeat(64);
const DISPATCH = "c".repeat(64);
const RECEIPT = "d".repeat(64);
const OUTCOME = "e".repeat(64);

const documentaryReceipt = {
  request_sha256: REQUEST,
  dispatch_sha256: DISPATCH,
  receipt_sha256: RECEIPT,
  outcome_sha256: OUTCOME,
  execution_state: "succeeded",
  documentary_only: true,
} as const;

const liveOp = {
  node_voltages: { out: 2, in: 3 },
  branch_currents_a: { Vin: -0.001 },
  measurements: { out: { value: 2 }, in: { value: 3 } },
  not_checked: [
    "Temperature: simulation runs at TNOM=27°C unless the netlist overrides .TEMP or .OPTIONS TNOM.",
  ],
  input_artifact: {
    sha256: NETLIST,
    bytes: 87,
    source_path: `/ngspice-runs/inputs/${NETLIST}`,
  },
  documentary_receipt: documentaryReceipt,
};

const persistedOp = {
  node_voltages: { out: 2 },
  branch_currents_a: {},
  measurements: { out: { value: 2 } },
  not_checked: ["documentary test only"],
  input_artifact: { sha256: NETLIST, bytes: 87 },
};

const liveTran = {
  node_stats: {
    out: {
      min_v: 0,
      max_v: 0.99752137,
      final_v: 0.99752137,
      min_at_s: 0,
      max_at_s: 0.006,
      final_at_s: 0.006,
    },
  },
  branch_current_stats_a: {
    Vin: {
      min_a: -0.001,
      max_a: 0,
      final_a: -0.00000247863,
      min_at_s: 0.000000001,
      max_at_s: 0,
      final_at_s: 0.006,
    },
  },
  measurements: { out: { value: 0.99752137 } },
  simulation: { n_points: 626, tstop_s: 0.006 },
  not_checked: [
    "The complete time series is never returned; only reduced statistics are returned.",
  ],
  input_artifact: {
    sha256: NETLIST,
    bytes: 120,
    source_path: `/ngspice-runs/inputs/${NETLIST}`,
  },
  documentary_receipt: documentaryReceipt,
};

const liveDc = {
  node_stats: {
    out: {
      min_v: 0,
      max_v: 2,
      final_v: 2,
      min_at_source_v: 0,
      max_at_source_v: 3,
      final_at_source_v: 3,
    },
  },
  branch_current_stats_a: {},
  measurements: { out: { value: 2 } },
  sweep: {
    source: "Vin",
    start_v: 0,
    stop_v: 3,
    step_v: 1,
    n_points: 4,
    max_points: 512,
  },
  not_checked: [
    "The full DC transfer curve is not returned. Only reduced min/max/final summaries and their swept-source positions are returned.",
  ],
  input_artifact: {
    sha256: NETLIST,
    bytes: 87,
    source_path: `/ngspice-runs/inputs/${NETLIST}`,
  },
  documentary_receipt: documentaryReceipt,
};

Deno.test("parser accepts the closed live operating-point result", () => {
  const parsed = parseSimulationViewData(liveOp);
  assertEquals(parsed.kind, "operating-point");
  if (parsed.kind !== "operating-point") return;
  assertEquals(parsed.source, "live");
  assertEquals(parsed.node_voltages.out, 2);
  assertEquals(parsed.branch_currents_a.Vin, -0.001);
  assertEquals(parsed.documentary_receipt?.execution_state, "succeeded");
  assertEquals(parsed.documentary_receipt?.documentary_only, true);
});

Deno.test("parser accepts persisted operating-point outcomes without a receipt", () => {
  const parsed = parseSimulationViewData({
    outcome_sha256: OUTCOME,
    result: persistedOp,
  });
  assertEquals(parsed.kind, "operating-point");
  if (parsed.kind !== "operating-point") return;
  assertEquals(parsed.source, "durable");
  assertEquals(parsed.outcome_sha256, OUTCOME);
  assertEquals(parsed.documentary_receipt, undefined);
  assertEquals("source_path" in parsed.input_artifact, false);
});

Deno.test("parser accepts reduced transient and DC live results", () => {
  const tran = parseSimulationViewData(liveTran);
  assertEquals(tran.kind, "transient-result");
  if (tran.kind !== "transient-result") return;
  assertEquals(tran.simulation.n_points, 626);
  assertEquals(tran.node_stats.out.final_v, 0.99752137);
  assertEquals("samples" in tran, false);

  const dc = parseSimulationViewData(liveDc);
  assertEquals(dc.kind, "dc-sweep");
  if (dc.kind !== "dc-sweep") return;
  assertEquals(dc.sweep.source, "Vin");
  assertEquals(dc.sweep.n_points, 4);
  assertEquals("curve" in dc, false);
});

Deno.test("parser accepts a durable typed failure without turning it into a verdict", () => {
  const parsed = parseSimulationViewData({
    outcome_sha256: OUTCOME,
    result: {
      code: "ngspice_timeout",
      context: { timeout_s: 30 },
      recovery: "Increase timeout_s or simplify the netlist.",
    },
  });
  assertEquals(parsed.kind, "failed-outcome");
  if (parsed.kind !== "failed-outcome") return;
  assertEquals(parsed.code, "ngspice_timeout");
  assertEquals(parsed.recovery, "Increase timeout_s or simplify the netlist.");
});

Deno.test("parser rejects extra fields, verdict aliases, and fabricated series", () => {
  assertThrows(
    () => parseSimulationViewData({ ...liveOp, extra: true }),
    TypeError,
    "unsupported fields",
  );
  assertThrows(
    () =>
      parseSimulationViewData({
        ...liveOp,
        documentary_receipt: {
          ...documentaryReceipt,
          execution_state: "pass",
        },
      }),
    TypeError,
    "succeeded",
  );
  assertThrows(
    () =>
      parseSimulationViewData({
        ...liveTran,
        samples: [{ t: 0, v: 0 }],
      }),
    TypeError,
    "unsupported fields",
  );
  assertThrows(
    () =>
      parseSimulationViewData({
        ...liveDc,
        transfer_curve: [0, 1, 2],
      }),
    TypeError,
    "unsupported fields",
  );
  assertThrows(
    () =>
      parseSimulationViewData({
        sha256: NETLIST,
        bytes: 87,
        uri: `spice-netlist:sha256:${NETLIST}`,
      }),
    TypeError,
  );
});

Deno.test("tool-result display keeps text fallback and refuses submit confirmations", () => {
  const fromStructured = displayStateFromToolResult({
    content: [{ type: "text", text: `[spice_simulate_op] sha256:${NETLIST}` }],
    structuredContent: liveOp,
  });
  assertEquals(fromStructured.kind, "result");

  const fromText = displayStateFromToolResult({
    content: [{ type: "text", text: JSON.stringify(liveOp) }],
  });
  assertEquals(fromText.kind, "result");

  const submit = displayStateFromToolResult({
    content: [{
      type: "text",
      text: `[ngspice_netlist_submit] sha256:${NETLIST} bytes:87`,
    }],
    structuredContent: {
      sha256: NETLIST,
      bytes: 87,
      uri: `spice-netlist:sha256:${NETLIST}`,
    },
  });
  assertEquals(submit.kind, "error");

  const toolError = displayStateFromToolResult({
    isError: true,
    content: [{ type: "text", text: "ngspice_timeout" }],
  });
  assertEquals(toolError, {
    kind: "error",
    message: "ngspice_timeout",
  });
});
