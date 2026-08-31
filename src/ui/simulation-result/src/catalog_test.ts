import { assert, assertEquals } from "@std/assert";
import { defineViewAppManifest } from "@casys/mcp-view-contracts";
import {
  advertisedComponentCatalog,
  mountComponentSurface,
} from "@casys/mcp-view-components";
import type { PreactSurfaceContext } from "@casys/mcp-view-components/preact";
import { SPICE_VIEW_APP_MANIFEST } from "../../view-app-manifest.ts";
import { SPICE_COMPONENT_KEYS, SPICE_RESULTS_SURFACE } from "./catalog.ts";
import { SPICE_COMPONENT_REGISTRY } from "./components.tsx";
import { parseSimulationViewData, type SimulationViewData } from "./model.ts";

const NETLIST = "a".repeat(64);
const liveOp = parseSimulationViewData({
  node_voltages: { out: 2, in: 3 },
  branch_currents_a: { Vin: -0.001 },
  measurements: { out: { value: 2 }, in: { value: 3 } },
  not_checked: ["Temperature: simulation runs at TNOM=27°C unless overridden."],
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

Deno.test("result catalog defaults to one compact semantic result", () => {
  const advertised = advertisedComponentCatalog(SPICE_COMPONENT_REGISTRY);
  assertEquals(
    advertised.defaultSurface,
    SPICE_RESULTS_SURFACE,
  );
  assertEquals(
    Object.keys(advertised.components).toSorted(),
    Object.values(SPICE_COMPONENT_KEYS).toSorted(),
  );
  assertEquals(SPICE_RESULTS_SURFACE.components.length, 1);
  assertEquals(
    SPICE_RESULTS_SURFACE.components[0]?.component,
    SPICE_COMPONENT_KEYS.simulationResult,
  );
});

Deno.test("view app manifest keeps separate whole-view URIs per schema", () => {
  defineViewAppManifest(SPICE_VIEW_APP_MANIFEST);
  assertEquals(SPICE_VIEW_APP_MANIFEST.resources.length, 5);
  assertEquals(
    SPICE_VIEW_APP_MANIFEST.resources.map((resource) => resource.uri),
    [
      "ui://mcp-spice/operating-point",
      "ui://mcp-spice/dc-sweep",
      "ui://mcp-spice/transient-result",
      "ui://mcp-spice/simulation-outcome",
      "ui://mcp-spice/simulation-receipt",
    ],
  );
  for (const resource of SPICE_VIEW_APP_MANIFEST.resources) {
    assertEquals(resource.ownership, "whole-view");
  }
});

Deno.test("compact operating-point surface uses primitives and keeps succeeded literal", async () => {
  await withMounted(liveOp, (root) => {
    const text = root.textContent ?? "";
    assert(text.includes("Operating point"));
    assert(text.includes("succeeded"));
    assert(text.includes("out"));
    assert(text.includes("V"));
    assertEquals(text.toLowerCase().includes("pass"), false);
    assertEquals(text.toLowerCase().includes("proof"), false);
    assertEquals(text.toLowerCase().includes("compliance"), false);
    assertEquals(
      text.includes("mcp-view-semantic-element") ||
        root.querySelector(".mcp-view-semantic-element") !== null,
      true,
    );
  });
});

Deno.test("host-selectable not_checked does not become a verdict list", async () => {
  await withMounted(liveOp, async (_root, mounted) => {
    await mounted.dispose();
    const documentModule = await import("linkedom");
    const dom = documentModule.parseHTML(
      "<html><body><div id=host></div></body></html>",
    );
    const host = dom.document.getElementById("host") as unknown as HTMLElement;
    const next = await mountComponentSurface({
      root: host,
      registry: SPICE_COMPONENT_REGISTRY,
      data: liveOp,
      appContext: componentContext,
      hostContext: {} as PreactSurfaceContext<SimulationViewData>["hostContext"],
      surface: {
        layout: { type: "stack", gap: "sm" },
        components: [{
          id: "limits",
          component: SPICE_COMPONENT_KEYS.notChecked,
        }],
      },
    });
    try {
      const text = host.textContent ?? "";
      assert(text.includes("TNOM=27°C"));
      assertEquals(text.toLowerCase().includes("failed check"), false);
    } finally {
      await next.dispose();
    }
  });
});

async function withMounted(
  data: SimulationViewData,
  run: (
    root: HTMLElement,
    mounted: Awaited<ReturnType<typeof mountComponentSurface>>,
  ) => void | Promise<void>,
): Promise<void> {
  const documentModule = await import("linkedom");
  const dom = documentModule.parseHTML(
    "<html><body><div id=root></div></body></html>",
  );
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
      hostContext: {} as PreactSurfaceContext<
        SimulationViewData
      >["hostContext"],
    });
    try {
      await run(root, mounted);
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
