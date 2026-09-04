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

/** The tool's structuredContent; parsing adds `kind`, so overrides start from this. */
const RAW = {
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
};
const receipt = parseReceiptViewData(RAW);

Deno.test("receipt registry exposes one mono-object component", () => {
  const advertised = advertisedComponentCatalog(SPICE_RECEIPT_REGISTRY);
  assertEquals(advertised.defaultSurface, SPICE_RECEIPT_SURFACE);
  assertEquals(Object.keys(advertised.components), [SPICE_RECEIPT_COMPONENT]);
});

Deno.test("the receipt reads as a datasheet: state headlined, every digest once in its section", async () => {
  await withMounted(receipt, (root) => {
    const text = root.textContent ?? "";
    for (
      const expected of [
        "Simulation receipt",
        "Operating point analysis",
        "succeeded",
        "Timeout",
        "30 s",
        "ngspice-44.2",
        "linux / aarch64",
      ]
    ) assert(text.includes(expected), expected);
    for (
      const raw of [
        "timeout_s",
        "mcp_spice_version",
        "request_sha256",
        "outcome_sha256",
        "documentary_only",
      ]
    ) assertEquals(text.includes(raw), false, raw);
    assertEquals(text.toLowerCase().includes("proof"), false);
    assertEquals(text.toLowerCase().includes("compliance"), false);
    assertEquals(text.includes("pass"), false);
    assertEquals(root.querySelectorAll(".mcp-view-semantic-element").length, 1);
    assertEquals(root.querySelector(".mcp-view-card"), null);
    assertEquals(readingValues(root), ["succeeded"]);
    assertEquals(sectionTitles(root), ["Request", "Runtime", "Digests"]);
    // One figure, one place: each digest is spelled exactly once, the receipt's own in the footer.
    for (const digit of ["1", "2", "3", "4", "5", "6"]) {
      assertEquals(text.split(digit.repeat(64)).length - 1, 1, `digest ${digit}`);
    }
    assertEquals(
      root.querySelector(".mcp-view-element-provenance code")?.textContent,
      "1".repeat(64),
    );
  });
});

Deno.test("a transient receipt headlines its time axis in the host locale", async () => {
  const transient = parseReceiptViewData({
    ...RAW,
    receipt: {
      ...RAW.receipt,
      analysis_kind: "tran",
      normalized_request: {
        nodes: ["out"],
        branch_sources: [],
        timeout_s: 30,
        tstep_s: 0.0005,
        tstop_s: 0.01,
      },
    },
  });
  await withMounted(transient, (root) => {
    assertEquals(readingValues(root), ["succeeded", "0.0005", "0.01"]);
    // The axis is headlined, not repeated as a request fact.
    assertEquals((root.textContent ?? "").split("0.0005").length - 1, 1);
  }, { locale: "en-US" });
  await withMounted(transient, (root) => {
    assertEquals(readingValues(root), ["succeeded", "0,0005", "0,01"]);
  }, { locale: "de-DE" });
});

Deno.test("a failed receipt keeps its literal state and turns the sheet to danger", async () => {
  const failed = parseReceiptViewData({
    ...RAW,
    receipt: { ...RAW.receipt, execution_state: "failed" },
  });
  await withMounted(failed, (root) => {
    const element = root.querySelector(".mcp-view-semantic-element");
    assertEquals(element?.getAttribute("data-tone"), "danger");
    assertEquals(readingValues(root), ["failed"]);
  });
});

type HostContext = PreactSurfaceContext<ReceiptViewData>["hostContext"];

async function withMounted(
  data: ReceiptViewData,
  run: (root: HTMLElement) => void | Promise<void>,
  hostContext: HostContext = {},
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
      registry: SPICE_RECEIPT_REGISTRY,
      data,
      // The App context the kit hands components: only the host context matters here.
      appContext: { hostContext } as unknown as PreactSurfaceContext<ReceiptViewData>,
      hostContext,
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

function sectionTitles(root: HTMLElement): string[] {
  return [...root.querySelectorAll(".mcp-view-element-section-title")].map(
    (title) => title.textContent ?? "",
  );
}

function readingValues(root: HTMLElement): string[] {
  return [...root.querySelectorAll(".mcp-view-element-reading-value")].map(
    (value) => value.textContent ?? "",
  );
}
