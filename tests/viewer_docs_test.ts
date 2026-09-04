import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parseSpiceRecordedViewSession } from "../src/ui/shared/recorded-session.ts";
import { SPICE_VIEW_CONTRACTS } from "../src/ui/view-app-manifest.ts";

const FIXTURE = new URL(
  "../docs/fixtures/mcs01-recorded-operating-point-session.json",
  import.meta.url,
);
const HARNESS = new URL("../docs/fixtures/viewer-preview.html", import.meta.url);
const IMAGE = "docs/images/recorded-operating-point-viewer.png";

Deno.test("the README capture fixture is the registered MCS01 session, verbatim", async () => {
  const session = await parseSpiceRecordedViewSession(
    "operatingPoint",
    JSON.parse(await Deno.readTextFile(FIXTURE)),
  );
  // The strict gate covers structure and both digests; a stale digest fails here.
  assert(session, "the committed fixture must pass the App's own session gate");
  assertEquals(session.resourceUri, SPICE_VIEW_CONTRACTS.operatingPoint.uri);
  assertEquals(session.resultSchema, "spice-operating-point-result/1.0");
  assertEquals(session.basis.projectId, "motorized-camera-slider-mcs01");
  assertEquals(session.basis.projectRevision, 150);
  assertEquals(session.basis.thread.revision, 21);
  assertEquals(
    session.basis.artifact.id,
    "spice-admitted-result-3a789bd0d0c8c9a291c6b309574a183b9ce49c144916f3e363be4af167d9843b",
  );
});

Deno.test("the documentation harness replays the fixture through the built bundle", async () => {
  const preview = await Deno.readTextFile(HARNESS);
  assertStringIncludes(preview, 'src="../../src/ui/dist/operating-point/index.html"');
  assertStringIncludes(preview, "./mcs01-recorded-operating-point-session.json");
  assertStringIncludes(preview, 'action: "viewer.session.apply"');
  // The capture must not follow the capturing machine's locale.
  assertStringIncludes(preview, 'locale: "en"');
});

Deno.test("the README image and its provenance page point at the reproducible capture", async () => {
  const readme = await Deno.readTextFile(new URL("../README.md", import.meta.url));
  assertStringIncludes(readme, IMAGE);
  const { isFile } = await Deno.stat(new URL(`../${IMAGE}`, import.meta.url));
  assert(isFile);
  const viewers = await Deno.readTextFile(
    new URL("../docs/viewers.md", import.meta.url),
  );
  assertStringIncludes(viewers, "deno task docs:viewer-screenshot");
  assertStringIncludes(
    viewers,
    "docs/fixtures/mcs01-recorded-operating-point-session.json",
  );
});
