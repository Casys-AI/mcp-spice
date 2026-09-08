import { assertStringIncludes } from "@std/assert";

Deno.test("pull requests run source gates while JSR publication requires a main push", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/publish.yml", import.meta.url),
  );
  assertStringIncludes(workflow, "on:\n  pull_request:\n    branches:\n      - main\n");
  assertStringIncludes(workflow, "deno task release:check");
  assertStringIncludes(
    workflow,
    "  publish-jsr:\n    if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n    needs: check\n",
  );
});
