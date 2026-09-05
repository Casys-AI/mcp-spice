import { assertEquals, assertStrictEquals, assertStringIncludes } from "@std/assert";
import { mcpViewMessages } from "@casys/mcp-view-components";
import {
  startPreactSurfaceApp,
  type SurfaceHostAccess,
} from "@casys/mcp-view-components/preact";
import { spiceReceiptAppOptions } from "../simulation-receipt/src/app.ts";
import { spiceResultsAppOptions } from "../simulation-result/src/app.ts";
import { SPICE_VIEW_CONTRACTS } from "../view-app-manifest.ts";
import { spiceMessages } from "./i18n.ts";
import { fingerprintSpiceRecordedProjection } from "./recorded-session.ts";
import { fakeApp, until, withDocument } from "./surface-app-double.ts";
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
  assertEquals(typeof rejected.title, "function");
  assertEquals(typeof rejected.message, "function");
  assertEquals(resolveLabel(rejected.title, "en"), "Session rejected");
  assertStringIncludes(
    resolveLabel(rejected.message, "en"),
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
  assertStringIncludes(resolveLabel(state.message, "en"), "mapper exploded");
  assertStringIncludes(resolveLabel(state.message, "fr"), "mapper exploded");
});

Deno.test("a session addressed to another view is refused by this App", async () => {
  const { viewerSession } = spiceResultsAppOptions(root, "dcSweep");
  const state = await viewerSession!.toState(await recordedOperatingPoint(), host);
  assertEquals(state.kind, "error");
  if (state.kind !== "error") return;
  assertStringIncludes(
    resolveLabel(state.message, "en"),
    SPICE_VIEW_CONTRACTS.dcSweep.sessionSchema,
  );
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
  assertEquals(results.themeUpdates, "in-place");
  assertEquals(receipt.themeUpdates, "in-place");
  assertEquals(results.messages, mcpViewMessages);
  assertEquals(receipt.messages, mcpViewMessages);
  assertEquals(results.documentLanguage, spiceMessages.locale);
  assertEquals(receipt.documentLanguage, spiceMessages.locale);
  assertEquals(typeof results.loadingLabel, "function");
  assertEquals(typeof receipt.loadingLabel, "function");
  const loading = results.loadingLabel as (locale?: string) => string;
  assertEquals(loading("en"), spiceMessages("en")("loadingResult"));
  assertEquals(loading("fr"), spiceMessages("fr")("loadingResult"));
  const empty = receipt.emptyLabel as (locale?: string) => string;
  assertEquals(empty("fr"), spiceMessages("fr")("emptyReceipt"));
});

Deno.test("a refused session retranslates from callbacks without repeating parse I/O", async () => {
  const { viewerSession } = spiceResultsAppOptions(root, "operatingPoint");
  let projections = 0;
  const original = viewerSession!;
  const wrapped = {
    validate: original.validate,
    toState: (value: unknown, access: SurfaceHostAccess) => {
      projections += 1;
      return original.toState(value, access);
    },
  };
  const rejected = await wrapped.toState({}, host);
  assertEquals(projections, 1);
  assertEquals(rejected.kind, "error");
  if (rejected.kind !== "error") return;
  assertEquals(typeof rejected.title, "function");
  assertEquals(typeof rejected.message, "function");
  assertEquals(resolveLabel(rejected.title, "en"), "Session rejected");
  assertEquals(resolveLabel(rejected.title, "fr"), "Session rejetée");
  const english = resolveLabel(rejected.message, "en");
  const french = resolveLabel(rejected.message, "fr");
  assertStringIncludes(
    english,
    SPICE_VIEW_CONTRACTS.operatingPoint.sessionSchema,
  );
  assertStringIncludes(
    french,
    SPICE_VIEW_CONTRACTS.operatingPoint.sessionSchema,
  );
  assertStringIncludes(english, "the envelope failed the strict gate");
  assertStringIncludes(french, "l'enveloppe n'a pas passé le contrôle strict");
  assertEquals(french.includes("Rejected"), false);
  assertEquals(projections, 1);

  await withDocument(async (mountRoot) => {
    const fake = fakeApp(mountRoot, {
      hostContext: { theme: "light", locale: "en" },
    });
    const handle = await startPreactSurfaceApp({
      ...spiceResultsAppOptions(mountRoot, "operatingPoint"),
      viewerSession: wrapped,
      theme: false,
    }, fake.runtime);
    await handle.show(rejected);
    await until(
      () => (mountRoot.textContent ?? "").includes("Session rejected"),
      "english session rejection",
    );
    fake.hostContextChanged({ locale: "fr" });
    await until(
      () => (mountRoot.textContent ?? "").includes("Session rejetée"),
      "french session rejection",
    );
    assertStringIncludes(
      mountRoot.textContent ?? "",
      SPICE_VIEW_CONTRACTS.operatingPoint.sessionSchema,
    );
    assertEquals(projections, 1);
    await handle.dispose();
  });
});

Deno.test("document language follows the selected dictionary, not the host tag", async () => {
  const results = spiceResultsAppOptions(root, "operatingPoint");
  const receipt = spiceReceiptAppOptions(root);
  assertEquals(results.documentLanguage, spiceMessages.locale);
  assertEquals(receipt.documentLanguage, spiceMessages.locale);
  assertEquals(spiceMessages.locale("fr-CA"), "fr");
  assertEquals(spiceMessages.locale("not a locale"), "en");
  assertEquals(spiceMessages.locale(), "en");

  await withDocument(async (mountRoot) => {
    document.documentElement.lang = "de";
    const fake = fakeApp(mountRoot, {
      hostContext: { theme: "light", locale: "fr-CA" },
    });
    const handle = await startPreactSurfaceApp({
      ...spiceResultsAppOptions(mountRoot, "operatingPoint"),
      theme: false,
    }, fake.runtime);
    await fake.idle();
    assertEquals(document.documentElement.lang, "fr");
    fake.hostContextChanged({ locale: "not a locale" });
    await fake.idle();
    assertEquals(document.documentElement.lang, "en");
    fake.hostContextChanged({ locale: "fr-FR" });
    await fake.idle();
    assertEquals(document.documentElement.lang, "fr");
    await handle.dispose();
  });
});

Deno.test("theme-only host updates keep the mounted surface and an open disclosure", async () => {
  await withDocument(async (mountRoot) => {
    const fake = fakeApp(mountRoot, {
      hostContext: { theme: "light", locale: "en" },
    });
    const handle = await startPreactSurfaceApp({
      ...spiceResultsAppOptions(mountRoot, "operatingPoint"),
      theme: false,
    }, fake.runtime);
    await fake.toolResult({
      content: [],
      structuredContent: OPERATING_POINT_CONTENT,
    });
    await until(
      () => mountRoot.querySelector(".mcp-view-semantic-element") !== null,
      "the first result mount",
    );
    const surface = mountRoot.querySelector(".mcp-view-semantic-element");
    const details = mountRoot.querySelector("details.mcp-view-disclosure");
    if (!details) throw new Error("expected a native technical disclosure");
    (details as HTMLDetailsElement).open = true;
    details.setAttribute("open", "");
    fake.hostContextChanged({ theme: "dark" });
    await fake.idle();
    assertStrictEquals(
      mountRoot.querySelector(".mcp-view-semantic-element"),
      surface,
    );
    assertStrictEquals(
      mountRoot.querySelector("details.mcp-view-disclosure"),
      details,
    );
    assertEquals((details as HTMLDetailsElement).open, true);
    fake.hostContextChanged({ locale: "fr" });
    await until(
      () => (mountRoot.textContent ?? "").includes("Point de fonctionnement"),
      "locale remount",
    );
    assertEquals(
      mountRoot.querySelector("details.mcp-view-disclosure") === details,
      false,
    );
    assertEquals(
      mountRoot.querySelector("details.mcp-view-disclosure")?.hasAttribute("open"),
      false,
    );
    await handle.dispose();
  });
});

function resolveLabel(
  value: string | ((locale?: string) => string) | undefined,
  locale?: string,
): string {
  if (typeof value === "function") return value(locale);
  return value ?? "";
}
