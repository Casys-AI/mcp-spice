import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { SPICE_COMPONENT_KEYS } from "../src/ui/simulation-result/src/catalog.ts";
import {
  SPICE_RECEIPT_COMPONENT_KEYS,
} from "../src/ui/simulation-receipt/src/catalog.ts";
import {
  SPICE_RESULT_VIEWERS,
  SPICE_SIMULATION_RECEIPT_VIEWER,
} from "../src/ui/constants.ts";

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

Deno.test("committed result viewers share one discriminated HTML bundle", async () => {
  const bodies = await Promise.all(
    SPICE_RESULT_VIEWERS.map((viewer) =>
      Deno.readTextFile(
        new URL(`../src/ui/dist/${viewer}/index.html`, import.meta.url),
      )
    ),
  );
  for (const html of bodies.slice(1)) {
    assertEquals(html, bodies[0]);
  }
  const html = bodies[0] ?? "";
  assertInlineModule(html);
  assert(html.includes("spice.simulation-result"));
  for (const key of Object.values(SPICE_COMPONENT_KEYS)) {
    assert(html.includes(key), key);
  }
  assert(html.includes("mcp-view-semantic-element"));
  assert(html.includes("io.casys.mcp.view-components/v1"));
  assertEquals(html.includes("Recorded proof"), false);
  assertEquals(html.includes("requirement verdict"), false);
  assertEquals(html.includes("MCP RESULT"), false);
  assertEquals(html.includes('class="masthead"'), false);
});

Deno.test("committed receipt viewer is a distinct documentary resource", async () => {
  const html = await Deno.readTextFile(
    new URL(
      `../src/ui/dist/${SPICE_SIMULATION_RECEIPT_VIEWER}/index.html`,
      import.meta.url,
    ),
  );
  const resultHtml = await Deno.readTextFile(
    new URL(
      `../src/ui/dist/${SPICE_RESULT_VIEWERS[0]}/index.html`,
      import.meta.url,
    ),
  );
  assertInlineModule(html);
  assertEquals(html === resultHtml, false);
  for (const key of Object.values(SPICE_RECEIPT_COMPONENT_KEYS)) {
    assert(html.includes(key), key);
  }
  assert(html.includes("documentary_only"));
  assertEquals(html.includes("Recorded proof"), false);
  assertEquals(html.includes("requirement verdict"), false);
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
