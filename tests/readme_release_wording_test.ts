import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const ROOT = new URL("../", import.meta.url);
const VERSION = JSON.parse(
  await Deno.readTextFile(new URL("deno.json", ROOT)),
).version as string;

const README = await Deno.readTextFile(new URL("README.md", ROOT));
const GETTING_STARTED = await Deno.readTextFile(
  new URL("docs/getting-started.md", ROOT),
);
const DEVELOPMENT = await Deno.readTextFile(
  new URL("docs/development.md", ROOT),
);

const PUBLISHED_PROSE = [
  ["README.md", README],
  ["docs/getting-started.md", GETTING_STARTED],
] as const;

const DIGEST_PLACEHOLDER = "ghcr.io/casys-ai/mcp-spice@sha256:<verified-index-digest>";

Deno.test("the package version is a concrete semver the docs can name", () => {
  assertEquals(typeof VERSION, "string");
  assert(/^[0-9]+\.[0-9]+\.[0-9]+$/.test(VERSION), VERSION);
});

Deno.test("install docs pin JSR and keep a digest placeholder, not a baked-in digest", () => {
  for (const [name, text] of PUBLISHED_PROSE) {
    assertStringIncludes(
      text,
      `jsr:@casys/mcp-spice@${VERSION}`,
      `${name} must pin the exact JSR version`,
    );
    assertStringIncludes(
      text,
      DIGEST_PLACEHOLDER,
      `${name} must keep a digest-pinned container identity`,
    );
    assert(
      !/ghcr\.io\/casys-ai\/mcp-spice@sha256:[0-9a-f]{64}/i.test(text),
      `${name} must not bake in a post-publication index digest`,
    );
    assert(
      !new RegExp(`ghcr\\.io/casys-ai/mcp-spice:${VERSION}\\b`).test(text),
      `${name} must not use the mutable version tag as the container identity`,
    );
  }
});

Deno.test("development docs name the verifier task without a standalone --", () => {
  assertStringIncludes(DEVELOPMENT, "deno task verify:published --git-tag");
  assert(
    !/deno task verify:published -- /.test(DEVELOPMENT),
    "the documented task must not pass a standalone --",
  );
});
