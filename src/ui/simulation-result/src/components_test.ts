import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  advertisedComponentCatalog,
  mountComponentSurface,
} from "@casys/mcp-view-components";
import type { PreactSurfaceContext } from "@casys/mcp-view-components/preact";
import {
  SPICE_COMPONENT_REGISTRY,
  SPICE_RESULT_COMPONENT,
  SPICE_RESULT_SURFACE,
} from "./components.tsx";
import { parseSimulationViewData, type SimulationViewData } from "./model.ts";
import {
  parseRecordedAdmittedSpiceView,
  SPICE_ADMITTED_OPERATING_POINT_RESULT_SCHEMA,
} from "./recorded-admitted.ts";

const NETLIST = "a".repeat(64);
const liveOp = parseSimulationViewData({
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
});

const componentContext = {} as unknown as PreactSurfaceContext<
  SimulationViewData
>;

Deno.test("result registry exposes one mono-object component", () => {
  const advertised = advertisedComponentCatalog(SPICE_COMPONENT_REGISTRY);
  assertEquals(advertised.defaultSurface, SPICE_RESULT_SURFACE);
  assertEquals(Object.keys(advertised.components), [SPICE_RESULT_COMPONENT]);
  assertEquals(SPICE_RESULT_SURFACE.components.length, 1);
});

Deno.test("mono-object result includes readings, limits, and exact provenance", async () => {
  await withMounted(liveOp, (root) => {
    const text = root.textContent ?? "";
    for (
      const expected of [
        "Operating point",
        "node_voltages.in",
        "branch_currents_a.Vin",
        "Temperature remains outside this analysis.",
        "request_sha256",
        "receipt_sha256",
        "succeeded",
      ]
    ) assert(text.includes(expected), expected);
    assertEquals(root.querySelectorAll(".mcp-view-semantic-element").length, 1);
    assertEquals(root.querySelector(".mcp-view-card"), null);
    assertEquals(text.toLowerCase().includes("pass"), false);
    assertEquals(text.toLowerCase().includes("proof"), false);
    assertEquals(text.toLowerCase().includes("compliance"), false);
  });
});

Deno.test("exact admitted result adapter preserves its own schema and artifact basis", () => {
  const artifactDigest = "f".repeat(64);
  const parsed = parseRecordedAdmittedSpiceView(
    SPICE_ADMITTED_OPERATING_POINT_RESULT_SCHEMA,
    {
      schemaVersion: SPICE_ADMITTED_OPERATING_POINT_RESULT_SCHEMA,
      analysisKind: "operating-point",
      signConvention: {
        kind: "ngspice-native",
        voltageSourceBranchCurrent: "positive-into-positive-terminal",
        passiveCurrent: "positive-from-first-named-node-to-second",
      },
      observables: [{
        nativeName: "v(out)",
        kind: "node-voltage",
        sourceSymbol: "out",
        value: 2,
        unit: "V",
      }],
    },
    {
      projectId: "project-one",
      projectRevision: 7,
      subjectId: "subject-one",
      thread: { id: "thread-one", revision: 3 },
      artifact: {
        id: `spice-admitted-result-${artifactDigest}`,
        fingerprint: `sha256:${artifactDigest}`,
      },
      projectionFingerprint: `sha256:${"0".repeat(64)}`,
    },
  );
  assertEquals(parsed.kind, "recorded-admitted-operating-point");
  assertEquals(parsed.sourceSchema, SPICE_ADMITTED_OPERATING_POINT_RESULT_SCHEMA);
  assertEquals(parsed.observables[0]?.value, 2);
  assertEquals(parsed.recorded.artifact.fingerprint, `sha256:${artifactDigest}`);
  assertThrows(
    () =>
      parseRecordedAdmittedSpiceView(
        SPICE_ADMITTED_OPERATING_POINT_RESULT_SCHEMA,
        { schemaVersion: SPICE_ADMITTED_OPERATING_POINT_RESULT_SCHEMA },
        parsed.recorded,
      ),
    TypeError,
  );
});

async function withMounted(
  data: SimulationViewData,
  run: (root: HTMLElement) => void | Promise<void>,
): Promise<void> {
  const { parseHTML } = await import("linkedom");
  const dom = parseHTML("<html><body><div id=root></div></body></html>");
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.document,
  });
  try {
    const root = dom.document.getElementById("root") as unknown as HTMLElement;
    const mounted = await mountComponentSurface({
      root,
      registry: SPICE_COMPONENT_REGISTRY,
      data,
      appContext: componentContext,
      hostContext: {} as PreactSurfaceContext<SimulationViewData>["hostContext"],
    });
    try {
      await run(root);
    } finally {
      await mounted.dispose();
    }
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
  }
}
