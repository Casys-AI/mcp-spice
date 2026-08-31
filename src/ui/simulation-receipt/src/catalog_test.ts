import { assert, assertEquals } from "@std/assert";
import {
  advertisedComponentCatalog,
  mountComponentSurface,
} from "@casys/mcp-view-components";
import type { PreactSurfaceContext } from "@casys/mcp-view-components/preact";
import { SPICE_RECEIPT_COMPONENT_KEYS, SPICE_RECEIPT_SURFACE } from "./catalog.ts";
import { SPICE_RECEIPT_REGISTRY } from "./components.tsx";
import { parseReceiptViewData, type ReceiptViewData } from "./model.ts";

const receipt = parseReceiptViewData({
  receipt_sha256: "1".repeat(64),
  receipt: {
    type: "spice-simulation-receipt/1.0",
    request_sha256: "2".repeat(64),
    dispatch_sha256: "3".repeat(64),
    analysis_kind: "op",
    netlist_sha256: "4".repeat(64),
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
      ngspice_version_sha256: "6".repeat(64),
    },
    outcome_sha256: "5".repeat(64),
    execution_state: "succeeded",
  },
});

const componentContext = {} as unknown as PreactSurfaceContext<ReceiptViewData>;

Deno.test("receipt catalog defaults to one compact documentary receipt", () => {
  const advertised = advertisedComponentCatalog(SPICE_RECEIPT_REGISTRY);
  assertEquals(advertised.defaultSurface, SPICE_RECEIPT_SURFACE);
  assertEquals(
    Object.keys(advertised.components).toSorted(),
    Object.values(SPICE_RECEIPT_COMPONENT_KEYS).toSorted(),
  );
});

Deno.test("compact receipt keeps succeeded and documentary_only without proof language", async () => {
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
      registry: SPICE_RECEIPT_REGISTRY,
      data: receipt,
      appContext: componentContext,
      hostContext: {} as PreactSurfaceContext<ReceiptViewData>["hostContext"],
    });
    try {
      const text = root.textContent ?? "";
      assert(text.includes("succeeded"));
      assert(text.includes("documentary_only"));
      assertEquals(text.toLowerCase().includes("proof"), false);
      assertEquals(text.toLowerCase().includes("compliance"), false);
      assertEquals(text.includes("pass"), false);
    } finally {
      await mounted.dispose();
    }
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
  }
});
