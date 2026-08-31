import { dirname, fromFileUrl, join } from "@std/path";
import { withAuditedViewerDenoConfig } from "./local-modules.ts";

const here = dirname(fromFileUrl(import.meta.url));

await withAuditedViewerDenoConfig(async (configPath) => {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "test",
      "--config",
      configPath,
      `--lock=${join(here, "deno.lock")}`,
      "--frozen",
      "--allow-all",
      join(here, "simulation-result", "src", "catalog_test.ts"),
      join(here, "simulation-receipt", "src", "catalog_test.ts"),
    ],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;
  if (!status.success) Deno.exit(status.code);
});
