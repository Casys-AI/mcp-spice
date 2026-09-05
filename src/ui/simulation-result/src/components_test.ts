import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
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

type HostContext = PreactSurfaceContext<SimulationViewData>["hostContext"];

/** The App context the kit hands components: only the host context matters here. */
function componentContext(
  hostContext: HostContext,
): PreactSurfaceContext<SimulationViewData> {
  return { hostContext } as unknown as PreactSurfaceContext<SimulationViewData>;
}

Deno.test("result registry exposes one mono-object component", () => {
  const advertised = advertisedComponentCatalog(SPICE_COMPONENT_REGISTRY);
  assertEquals(advertised.defaultSurface, SPICE_RESULT_SURFACE);
  assertEquals(Object.keys(advertised.components), [SPICE_RESULT_COMPONENT]);
  assertEquals(SPICE_RESULT_SURFACE.components.length, 1);
});

Deno.test("the live operating point reads as a datasheet, not as a field dump", async () => {
  await withMounted(liveOp, (root) => {
    const text = root.textContent ?? "";
    for (
      const expected of [
        "Operating point",
        "Node voltage",
        "Branch current",
        "Measurements",
        "Not checked",
        "Temperature remains outside this analysis.",
        "Provenance",
        "87 bytes",
        "succeeded",
        "documentary only",
      ]
    ) assert(text.includes(expected), expected);
    // Reader-worded labels: the JSON field names stay in the JSON.
    for (
      const raw of [
        "node_voltages",
        "branch_currents_a",
        "request_sha256",
        "documentary_only",
        "not_checked",
      ]
    ) assertEquals(text.includes(raw), false, raw);
    assertEquals(root.querySelectorAll(".mcp-view-semantic-element").length, 1);
    assertEquals(root.querySelector(".mcp-view-card"), null);
    // Three quantities fit the strip, so none is tabled.
    assertEquals(root.querySelectorAll(".mcp-view-element-reading").length, 3);
    assertEquals(root.querySelector(".mcp-view-table"), null);
    assertEquals(
      sectionTitles(root),
      ["Measurements", "Provenance"],
    );
    // One figure, one place: the outcome digest sits in the footer only.
    assertEquals(text.split("e".repeat(64)).length - 1, 1);
    assertStringIncludes(
      root.querySelector(".mcp-view-element-provenance")?.textContent ?? "",
      "e".repeat(64),
    );
    assertEquals(root.querySelectorAll(".mcp-view-artifact-row").length, 1);
    assertEquals(text.toLowerCase().includes("pass"), false);
    assertEquals(text.toLowerCase().includes("proof"), false);
    assertEquals(text.toLowerCase().includes("compliance"), false);
    const details = disclosure(root);
    assertEquals(details.hasAttribute("open"), false);
    assertEquals(details.querySelector(".mcp-view-element-reading"), null);
    assertEquals(details.querySelector(".mcp-view-element-ident"), null);
    assert(
      (details.textContent ?? "").includes("Provenance"),
      "provenance belongs under the closed disclosure",
    );
    assertEquals(
      details.contains(sectionTitle(root, "Measurements")),
      false,
      "measurements stay visible",
    );
    assert(
      (details.textContent ?? "").includes("e".repeat(64)) === false,
      "outcome digest is not repeated inside the disclosure",
    );
  });
});

Deno.test("French host locale translates labels and leaves literal states and data", async () => {
  await withMounted(liveOp, (root) => {
    const text = root.textContent ?? "";
    assert(text.includes("Point de fonctionnement"), text);
    assert(text.includes("Mesures"), text);
    assert(text.includes("Détails techniques"), text);
    assert(text.includes("Tension de nœud"), text);
    assert(text.includes("succeeded"), "execution_state stays literal");
    assert(
      text.includes("Temperature remains outside this analysis."),
      "not_checked content is not translated",
    );
    assert(text.includes("e".repeat(64)), "outcome digest stays verbatim");
    assertEquals(text.includes("Operating point"), false);
    assertEquals(text.includes("Measurements"), false);
    assertEquals(text.includes("Technical details"), false);
    const details = disclosure(root);
    assertEquals(details.hasAttribute("open"), false);
    assertEquals(readingValues(root), ["3", "2", "-0,001"]);
  }, { locale: "fr" });
});

Deno.test("more quantities than the strip holds are tabled; none is headlined", async () => {
  const OUTCOME = "9".repeat(64);
  const wide = parseSimulationViewData({
    outcome_sha256: OUTCOME,
    result: {
      node_voltages: Object.fromEntries(
        Array.from({ length: 7 }, (_, index) => [`n${index}`, index / 10]),
      ),
      branch_currents_a: {},
      measurements: {},
      not_checked: [],
      input_artifact: { sha256: NETLIST, bytes: 87 },
    },
  });
  await withMounted(wide, (root) => {
    const text = root.textContent ?? "";
    assertEquals(root.querySelectorAll(".mcp-view-element-reading").length, 0);
    assertEquals(sectionTitles(root), ["Quantities", "Provenance"]);
    assertEquals(root.querySelectorAll(".mcp-view-table tbody tr").length, 7);
    // No path: the content address is the netlist's only name, shown once.
    assertEquals(text.split(NETLIST).length - 1, 1);
    assertEquals(text.split(OUTCOME).length - 1, 1);
  });
});

Deno.test("reduced analyses headline their axis and table extrema with where each was taken", async () => {
  const sweep = parseSimulationViewData({
    node_stats: {
      out: {
        min_v: 0,
        max_v: 4.5,
        final_v: 4.5,
        min_at_source_v: 0,
        max_at_source_v: 5,
        final_at_source_v: 5,
      },
    },
    branch_current_stats_a: {
      Vin: {
        min_a: -0.002,
        max_a: 0,
        final_a: -0.002,
        min_at_source_v: 5,
        max_at_source_v: 0,
        final_at_source_v: 5,
      },
    },
    measurements: {},
    not_checked: [],
    sweep: {
      source: "Vin",
      start_v: 0,
      stop_v: 5,
      step_v: 0.5,
      n_points: 11,
      max_points: 1000,
    },
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
  await withMounted(sweep, (root) => {
    const text = root.textContent ?? "";
    assertStringIncludes(text, "DC sweep");
    // The whole axis is the strip; the quantities never compete with it.
    assertEquals(readingValues(root), ["Vin", "0", "5", "0.5", "11"]);
    assertStringIncludes(text, "of 1,000 allowed");
    assertEquals(root.querySelectorAll(".mcp-view-table tbody tr").length, 2);
    // Every extremum says where on the axis it was taken, voltages before currents.
    assertEquals(
      Array.from(root.querySelectorAll(".spice-figure-at"), (at) => at.textContent),
      ["at 0 V", "at 5 V", "at 5 V", "at 5 V", "at 0 V", "at 5 V"],
    );
    const details = disclosure(root);
    assertEquals(details.hasAttribute("open"), false);
    assertEquals(
      details.querySelector(".mcp-view-table"),
      null,
      "extrema stay visible outside the disclosure",
    );
    assertEquals(details.querySelector(".mcp-view-element-reading"), null);
  });

  const transient = parseSimulationViewData({
    outcome_sha256: "9".repeat(64),
    result: {
      node_stats: {
        out: {
          min_v: -1,
          max_v: 1,
          final_v: 0.25,
          min_at_s: 0.0015,
          max_at_s: 0.0005,
          final_at_s: 0.002,
        },
      },
      branch_current_stats_a: {},
      measurements: {},
      not_checked: [],
      simulation: { n_points: 2001, tstop_s: 0.002 },
      input_artifact: { sha256: NETLIST, bytes: 87 },
    },
  });
  await withMounted(transient, (root) => {
    assertStringIncludes(root.textContent ?? "", "Reduced transient result");
    assertEquals(readingValues(root), ["2,001", "0.002"]);
    assertEquals(
      Array.from(root.querySelectorAll(".spice-figure-at"), (at) => at.textContent),
      ["at 0.0015 s", "at 0.0005 s", "at 0.002 s"],
    );
  }, { locale: "en-US" });
});

Deno.test("readings follow the host locale, not the viewing machine", async () => {
  await withMounted(liveOp, (root) => {
    assert(readingValues(root).includes("-0.001"), readingValues(root).join(","));
  }, { locale: "en-US" });
  await withMounted(liveOp, (root) => {
    assert(readingValues(root).includes("-0,001"), readingValues(root).join(","));
  }, { locale: "de-DE" });
});

Deno.test("the admitted result names its record once and its projection once", async () => {
  const artifactDigest = "f".repeat(64);
  const projectionDigest = "0".repeat(64);
  const admitted = parseRecordedAdmittedSpiceView(
    SPICE_ADMITTED_OPERATING_POINT_RESULT_SCHEMA,
    {
      schemaVersion: SPICE_ADMITTED_OPERATING_POINT_RESULT_SCHEMA,
      analysisKind: "operating-point",
      signConvention: {
        kind: "ngspice-native",
        voltageSourceBranchCurrent: "positive-into-positive-terminal",
        passiveCurrent: "positive-from-first-named-node-to-second",
      },
      observables: [
        {
          nativeName: "i(vin)",
          kind: "branch-current",
          sourceSymbol: "Vin",
          value: -0.001,
          unit: "A",
        },
        {
          nativeName: "v(out)",
          kind: "node-voltage",
          sourceSymbol: "out",
          value: 2,
          unit: "V",
        },
      ],
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
      projectionFingerprint: `sha256:${projectionDigest}`,
    },
  );
  await withMounted(admitted, (root) => {
    const text = root.textContent ?? "";
    assertStringIncludes(text, "Admitted operating point");
    assertStringIncludes(text, "Recorded session");
    assertEquals(text.includes("Recorded by project-one r7"), false);
    assertStringIncludes(text, "Branch current · Vin");
    assertEquals(root.querySelectorAll(".mcp-view-element-reading").length, 2);
    assertEquals(sectionTitles(root), ["Sign convention", "Provenance"]);
    const details = disclosure(root);
    assertEquals(details.hasAttribute("open"), false);
    assertEquals(details.contains(sectionTitle(root, "Sign convention")), true);
    assertEquals(details.contains(sectionTitle(root, "Provenance")), true);
    assertEquals(details.querySelector(".mcp-view-element-reading"), null);
    assertEquals(root.querySelector(".mcp-view-element-provenance"), null);
    assertStringIncludes(details.textContent ?? "", "project-one");
    assertStringIncludes(details.textContent ?? "", "Project revision");
    assertEquals(
      (details.textContent ?? "").includes("7"),
      true,
      "project revision sits in the closed disclosure",
    );
    assertStringIncludes(
      details.textContent ?? "",
      `sha256:${projectionDigest}`,
    );
    assertEquals(
      text.split(artifactDigest).length - 1,
      2,
      "artifact id and its fingerprint",
    );
    assertEquals(
      root.querySelector(".mcp-view-artifact-row-fingerprint code")?.textContent,
      artifactDigest,
    );
    assertEquals(
      root.querySelector("[data-basis-fingerprint]")?.getAttribute(
        "data-basis-fingerprint",
      ),
      artifactDigest,
    );
    assertEquals(text.split(projectionDigest).length - 1, 1);
  });
  await withMounted(admitted, (root) => {
    const text = root.textContent ?? "";
    assertStringIncludes(text, "Session enregistrée");
    assertEquals(text.includes("Recorded session"), false);
    const details = disclosure(root);
    assertStringIncludes(details.textContent ?? "", "Projet");
    assertStringIncludes(details.textContent ?? "", "Révision du projet");
    assertStringIncludes(details.textContent ?? "", "project-one");
    assertStringIncludes(details.textContent ?? "", `sha256:${projectionDigest}`);
    assertEquals(root.querySelector(".mcp-view-element-provenance"), null);
    assertEquals(text.split(projectionDigest).length - 1, 1);
  }, { locale: "fr" });
});

Deno.test("a typed failure keeps its recovery first and shows only what it has", async () => {
  const failed = parseSimulationViewData({
    outcome_sha256: "9".repeat(64),
    result: {
      code: "SPICE_CONVERGENCE_FAILED",
      context: { iterations: 100, node: "out" },
      recovery: "Add a .nodeset for node out and rerun.",
    },
  });
  await withMounted(failed, (root) => {
    const element = root.querySelector(".mcp-view-semantic-element");
    assertEquals(element?.getAttribute("data-tone"), "danger");
    assertEquals(root.querySelectorAll(".mcp-view-element-reading").length, 0);
    assertStringIncludes(
      root.textContent ?? "",
      "Add a .nodeset for node out and rerun.",
    );
    assertEquals(sectionTitles(root), ["Context"]);
    const details = disclosure(root);
    assertEquals(details.hasAttribute("open"), false);
    assertEquals(details.contains(sectionTitle(root, "Context")), true);
    assertEquals(
      (details.textContent ?? "").includes("Add a .nodeset for node out and rerun."),
      false,
      "failure recovery stays outside the disclosure",
    );
    assertStringIncludes(root.textContent ?? "", "iterations");
    assertEquals(root.querySelector(".mcp-view-artifact-row"), null);
    assertStringIncludes(
      root.querySelector(".mcp-view-element-provenance")?.textContent ?? "",
      "9".repeat(64),
    );
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
      registry: SPICE_COMPONENT_REGISTRY,
      data,
      appContext: componentContext(hostContext),
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
  return Array.from(
    root.querySelectorAll(".mcp-view-element-section-title"),
    (title) => title.textContent ?? "",
  );
}

function sectionTitle(root: HTMLElement, title: string): HTMLElement {
  const node = Array.from(
    root.querySelectorAll(".mcp-view-element-section-title"),
  ).find((candidate) => candidate.textContent === title);
  if (!node) throw new Error(`missing section title ${title}`);
  return node as HTMLElement;
}

function disclosure(root: HTMLElement): HTMLDetailsElement {
  const details = root.querySelector("details.mcp-view-disclosure");
  if (!details) throw new Error("expected a native technical disclosure");
  return details as HTMLDetailsElement;
}

function readingValues(root: HTMLElement): string[] {
  return Array.from(
    root.querySelectorAll(".mcp-view-element-reading-value"),
    (value) => value.textContent ?? "",
  );
}
