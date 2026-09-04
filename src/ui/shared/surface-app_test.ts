import { assertEquals, assertStringIncludes } from "@std/assert";
import type { SurfaceHostAccess } from "@casys/mcp-view-components/preact";
import { spiceReceiptAppOptions } from "../simulation-receipt/src/app.ts";
import { spiceResultsAppOptions } from "../simulation-result/src/app.ts";
import { SPICE_VIEW_CONTRACTS } from "../view-app-manifest.ts";
import { fingerprintSpiceRecordedProjection } from "./recorded-session.ts";
import { recordedSessionProjection, SESSION_REJECTED_CODE } from "./surface-app.ts";

/** The README fixture: an admitted MCS01 result, recorded by the thread. */
const MCS01_SESSION_URL = new URL(
  "../../../docs/fixtures/mcs01-recorded-operating-point-session.json",
  import.meta.url,
);

const NETLIST = "a".repeat(64);
const OPERATING_POINT_CONTENT = {
  node_voltages: { in: 3, out: 2 },
  branch_currents_a: { Vin: -0.001 },
  measurements: { out: { value: 2 }, in: { value: 3 } },
  not_checked: ["Temperature remains outside this analysis."],
  input_artifact: {
    sha256: NETLIST,
    bytes: 87,
    source_path: `/ngspice-runs/inputs/${NETLIST}`,
  },
  documentary_receipt: {
    request_sha256: "b".repeat(64),
    dispatch_sha256: "c".repeat(64),
    receipt_sha256: "d".repeat(64),
    outcome_sha256: "e".repeat(64),
    execution_state: "succeeded",
    documentary_only: true,
  },
};

const RECEIPT_CONTENT = {
  receipt_sha256: "1".repeat(64),
  receipt: {
    type: "spice-simulation-receipt/1.0",
    request_sha256: "2".repeat(64),
    dispatch_sha256: "3".repeat(64),
    analysis_kind: "op",
    netlist_sha256: NETLIST,
    normalized_request: { nodes: ["out"], branch_sources: [], timeout_s: 30 },
    runtime_identity: {
      mcp_spice_version: "0.6.2",
      execution_budgets: "execution-budgets/1.0",
      deno_version: "2.9.6",
      os: "linux",
      arch: "aarch64",
      ngspice_version: "ngspice-44.2",
      ngspice_version_sha256: "6".repeat(64),
    },
    outcome_sha256: "5".repeat(64),
    execution_state: "succeeded",
  },
};

const BASIS = {
  projectId: "bench-rc",
  projectRevision: 4,
  subjectId: "project:bench-rc",
  thread: { id: "project:bench-rc:r2:verify", revision: 2 },
  artifact: { id: "spice-result-1", fingerprint: `sha256:${"f".repeat(64)}` as const },
};

const root = {} as HTMLElement;
// The projections never read the host; the App only reaches it for tool results.
const host = {} as SurfaceHostAccess;

async function recordedOperatingPoint(): Promise<Record<string, unknown>> {
  const contract = SPICE_VIEW_CONTRACTS.operatingPoint;
  const envelope = {
    schemaVersion: contract.sessionSchema,
    resourceUri: contract.uri,
    resultSchema: contract.resultSchema,
    readOnly: true as const,
    basis: BASIS,
    structuredContent: OPERATING_POINT_CONTENT,
  };
  return {
    ...envelope,
    projectionFingerprint: await fingerprintSpiceRecordedProjection(envelope),
  };
}

Deno.test("every session payload reaches the strict gate; a refusal is shown, not dropped", async () => {
  const { viewerSession } = spiceResultsAppOptions(root, "operatingPoint");
  assertEquals(viewerSession?.validate({}), true);
  const rejected = await viewerSession!.toState({}, host);
  assertEquals(rejected.kind, "error");
  if (rejected.kind !== "error") return;
  assertEquals(rejected.code, SESSION_REJECTED_CODE);
  assertEquals(rejected.title, "Session rejected");
  assertStringIncludes(
    rejected.message,
    SPICE_VIEW_CONTRACTS.operatingPoint.sessionSchema,
  );
});

Deno.test("a recorded session with a matching digest projects like a live result", async () => {
  const { viewerSession } = spiceResultsAppOptions(root, "operatingPoint");
  const state = await viewerSession!.toState(await recordedOperatingPoint(), host);
  assertEquals(state.kind, "result");
  if (state.kind !== "result") return;
  assertEquals(state.result.kind, "operating-point");
});

Deno.test("a session whose digest drifted from its content is refused", async () => {
  const { viewerSession } = spiceResultsAppOptions(root, "operatingPoint");
  const session = await recordedOperatingPoint();
  const state = await viewerSession!.toState(
    { ...session, projectionFingerprint: `sha256:${"0".repeat(64)}` },
    host,
  );
  assertEquals(state.kind, "error");
  if (state.kind !== "error") return;
  assertEquals(state.code, SESSION_REJECTED_CODE);
});

Deno.test("the recorded MCS01 fixture projects as an admitted operating point", async () => {
  const fixture = JSON.parse(await Deno.readTextFile(MCS01_SESSION_URL));
  const { viewerSession } = spiceResultsAppOptions(root, "operatingPoint");
  const state = await viewerSession!.toState(fixture, host);
  assertEquals(state.kind, "result");
  if (state.kind !== "result") return;
  assertEquals(state.result.kind, "recorded-admitted-operating-point");
});

Deno.test("an admitted artifact whose fingerprint drifted is refused even with a fresh projection digest", async () => {
  const fixture = JSON.parse(await Deno.readTextFile(MCS01_SESSION_URL));
  const drifted = {
    ...fixture,
    basis: {
      ...fixture.basis,
      artifact: { ...fixture.basis.artifact, fingerprint: `sha256:${"0".repeat(64)}` },
    },
  };
  // The projection digest covers the basis, so the forger recomputes it too.
  const { projectionFingerprint: _stale, ...envelope } = drifted;
  const session = {
    ...envelope,
    projectionFingerprint: await fingerprintSpiceRecordedProjection(envelope),
  };
  const { viewerSession } = spiceResultsAppOptions(root, "operatingPoint");
  const state = await viewerSession!.toState(session, host);
  assertEquals(state.kind, "error");
  if (state.kind !== "error") return;
  assertEquals(state.code, SESSION_REJECTED_CODE);
});

Deno.test("a recorded receipt session projects through the receipt App", async () => {
  const contract = SPICE_VIEW_CONTRACTS.simulationReceipt;
  const envelope = {
    schemaVersion: contract.sessionSchema,
    resourceUri: contract.uri,
    resultSchema: contract.resultSchema,
    readOnly: true as const,
    basis: BASIS,
    structuredContent: RECEIPT_CONTENT,
  };
  const { viewerSession } = spiceReceiptAppOptions(root);
  const state = await viewerSession!.toState({
    ...envelope,
    projectionFingerprint: await fingerprintSpiceRecordedProjection(envelope),
  }, host);
  assertEquals(state.kind, "result");
  if (state.kind !== "result") return;
  assertEquals(state.result.kind, "simulation-receipt");
  assertEquals(state.result.receipt.execution_state, "succeeded");
});

Deno.test("a mapper that throws on an accepted envelope is shown as a session rejection", async () => {
  const projection = recordedSessionProjection("operatingPoint", () => {
    throw new Error("mapper exploded");
  });
  const state = await projection.toState(await recordedOperatingPoint(), host);
  assertEquals(state.kind, "error");
  if (state.kind !== "error") return;
  assertEquals(state.code, SESSION_REJECTED_CODE);
  assertStringIncludes(state.message, "mapper exploded");
});

Deno.test("a session addressed to another view is refused by this App", async () => {
  const { viewerSession } = spiceResultsAppOptions(root, "dcSweep");
  const state = await viewerSession!.toState(await recordedOperatingPoint(), host);
  assertEquals(state.kind, "error");
  if (state.kind !== "error") return;
  assertStringIncludes(state.message, SPICE_VIEW_CONTRACTS.dcSweep.sessionSchema);
});

Deno.test("both Apps share the viewer-owned surface and status classes", () => {
  const results = spiceResultsAppOptions(root, "transientResult");
  const receipt = spiceReceiptAppOptions(root);
  assertEquals(results.surfaceClassName, "spice-component-surface");
  assertEquals(receipt.surfaceClassName, "spice-component-surface");
  assertEquals(results.statusClassName, "spice-viewer-state");
  assertEquals(receipt.statusClassName, "spice-viewer-state");
  assertEquals(results.strict, true);
  assertEquals(receipt.strict, true);
  assertEquals(receipt.info.name.endsWith(".receipt"), true);
});
