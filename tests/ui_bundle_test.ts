import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  SPICE_RECEIPT_COMPONENT,
  SPICE_RESULT_COMPONENT,
  SPICE_RESULT_VIEWERS,
  SPICE_SIMULATION_RECEIPT_VIEWER,
  SPICE_VIEWERS,
} from "../src/ui/constants.ts";
import {
  SPICE_VIEW_CONTRACTS,
  type SpiceViewKey,
} from "../src/ui/view-app-manifest.ts";

Deno.test("viewer build fails closed without every audited split root", async () => {
  const repository = fromFileUrl(new URL("../", import.meta.url));
  const result = await new Deno.Command(Deno.execPath(), {
    cwd: repository,
    args: ["run", "--config", "deno.json", "-A", "src/ui/build.ts"],
    env: {
      MCP_VIEW_LOCAL_ROOT: "",
      MCP_VIEW_CONTRACTS_LOCAL_ROOT: "",
      MCP_VIEW_COMPONENTS_LOCAL_ROOT: "",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.success, false);
  const error = new TextDecoder().decode(result.stderr);
  assertStringIncludes(error, "Missing MCP_VIEW_LOCAL_ROOT");
  assertStringIncludes(error, "no published compatibility fallback");
});

Deno.test("five committed resources are distinct App-level session receivers", async () => {
  const bodies = await Promise.all(
    SPICE_VIEWERS.map((viewer) =>
      Deno.readTextFile(
        new URL(`../src/ui/dist/${viewer}/index.html`, import.meta.url),
      )
    ),
  );
  assertEquals(new Set(bodies).size, SPICE_VIEWERS.length);
  for (const [index, html] of bodies.entries()) {
    assertInlineModule(html);
    assert(html.includes("viewer.session.apply"), SPICE_VIEWERS[index]);
    assert(html.includes("mcp-view-semantic-element"), SPICE_VIEWERS[index]);
    assertEquals(html.includes("ElementVerdict"), false);
    assertEquals(html.includes("PathBar"), false);
    assertEquals(html.includes("spice.node-statistics"), false);
    assertEquals(html.includes("spice.receipt-identities"), false);
  }
});

Deno.test("each bundle contains its exact recorded-session schema", async () => {
  const mapping: readonly [string, SpiceViewKey][] = [
    ["operating-point", "operatingPoint"],
    ["dc-sweep", "dcSweep"],
    ["transient-result", "transientResult"],
    ["simulation-outcome", "simulationOutcome"],
    ["simulation-receipt", "simulationReceipt"],
  ];
  for (const [viewer, key] of mapping) {
    const html = await Deno.readTextFile(
      new URL(`../src/ui/dist/${viewer}/index.html`, import.meta.url),
    );
    assert(html.includes(SPICE_VIEW_CONTRACTS[key].sessionSchema), viewer);
  }
});

Deno.test("result and receipt bundles expose one business component each", async () => {
  for (const viewer of SPICE_RESULT_VIEWERS) {
    const html = await Deno.readTextFile(
      new URL(`../src/ui/dist/${viewer}/index.html`, import.meta.url),
    );
    assert(html.includes(SPICE_RESULT_COMPONENT));
  }
  const receipt = await Deno.readTextFile(
    new URL(
      `../src/ui/dist/${SPICE_SIMULATION_RECEIPT_VIEWER}/index.html`,
      import.meta.url,
    ),
  );
  assert(receipt.includes(SPICE_RECEIPT_COMPONENT));
});

function assertInlineModule(html: string): void {
  assertEquals((html.match(/<!doctype html>/gi) ?? []).length, 1);
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assertEquals(scripts.length, 1);
  const source = scripts[0]?.[1] ?? "";
  assert(source.trim().length > 0);
  assertEquals(source.includes("BUNDLE_PLACEHOLDER"), false);
  new Function(source);
}
