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
      join(here, "simulation-result", "src", "components_test.ts"),
      join(here, "simulation-receipt", "src", "components_test.ts"),
      join(here, "view-contract_test.ts"),
      join(here, "shared", "surface-app_test.ts"),
      join(here, "shared", "format_test.ts"),
    ],
    // A machine locale the viewers must not follow: figures keep the host's or `en`.
    env: { LC_ALL: "de_DE.UTF-8" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;
  if (!status.success) Deno.exit(status.code);
});
