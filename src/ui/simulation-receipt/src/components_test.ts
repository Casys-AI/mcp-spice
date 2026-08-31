import { assert, assertEquals } from "@std/assert";
import {
  advertisedComponentCatalog,
  mountComponentSurface,
} from "@casys/mcp-view-components";
import type { PreactSurfaceContext } from "@casys/mcp-view-components/preact";
import {
  SPICE_RECEIPT_COMPONENT,
  SPICE_RECEIPT_REGISTRY,
  SPICE_RECEIPT_SURFACE,
} from "./components.tsx";
import { parseReceiptViewData, type ReceiptViewData } from "./model.ts";

const receipt = parseReceiptViewData({
  receipt_sha256: "1".repeat(64),
  receipt: {
    type: "spice-simulation-receipt/1.0",
    request_sha256: "2".repeat(64),
    dispatch_sha256: "3".repeat(64),
    analysis_kind: "op",
    netlist_sha256: "4".repeat(64),
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
});

Deno.test("receipt registry exposes one mono-object component", () => {
  const advertised = advertisedComponentCatalog(SPICE_RECEIPT_REGISTRY);
  assertEquals(advertised.defaultSurface, SPICE_RECEIPT_SURFACE);
  assertEquals(Object.keys(advertised.components), [SPICE_RECEIPT_COMPONENT]);
});

Deno.test("receipt component includes request, runtime, state, and exact identities", async () => {
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
      registry: SPICE_RECEIPT_REGISTRY,
      data: receipt,
      appContext: {} as PreactSurfaceContext<ReceiptViewData>,
      hostContext: {} as PreactSurfaceContext<ReceiptViewData>["hostContext"],
    });
    try {
      const text = root.textContent ?? "";
      for (
        const expected of [
          "Simulation receipt",
          "succeeded",
          "timeout_s",
          "mcp_spice_version",
          "request_sha256",
          "outcome_sha256",
        ]
      ) assert(text.includes(expected), expected);
      assertEquals(text.includes("documentary_only"), false);
      assertEquals(text.toLowerCase().includes("proof"), false);
      assertEquals(text.toLowerCase().includes("compliance"), false);
      assertEquals(text.includes("pass"), false);
      assertEquals(root.querySelectorAll(".mcp-view-semantic-element").length, 1);
      assertEquals(root.querySelector(".mcp-view-card"), null);
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
