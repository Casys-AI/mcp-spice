import { dirname, fromFileUrl, join } from "@std/path";
import { SPICE_RESULT_VIEWERS, SPICE_SIMULATION_RECEIPT_VIEWER } from "./constants.ts";
import { withAuditedViewerDenoConfig } from "./local-modules.ts";

const here = dirname(fromFileUrl(import.meta.url));
export const VIEWER_LOCK = join(here, "deno.lock");
export const RESULT_ENTRIES = {
  "operating-point": join(
    here,
    "simulation-result",
    "src",
    "operating-point-main.ts",
  ),
  "dc-sweep": join(here, "simulation-result", "src", "dc-sweep-main.ts"),
  "transient-result": join(
    here,
    "simulation-result",
    "src",
    "transient-result-main.ts",
  ),
  "simulation-outcome": join(
    here,
    "simulation-result",
    "src",
    "simulation-outcome-main.ts",
  ),
} as const;
export const RECEIPT_ENTRY = join(
  here,
  "simulation-receipt",
  "src",
  "main.ts",
);

export function versionedViewerPath(viewer: string): string {
  return join(here, "dist", viewer, "index.html");
}

export async function buildSpiceViewers(
  outputRoot = join(here, "dist"),
): Promise<void> {
  await withAuditedViewerDenoConfig(async (configPath) => {
    const resultHtml = new Map<string, string>();
    for (const viewer of SPICE_RESULT_VIEWERS) {
      resultHtml.set(
        viewer,
        await bundleViewer({
          configPath,
          entry: RESULT_ENTRIES[viewer],
          template: join(here, "simulation-result", "index.html"),
          css: join(here, "simulation-result", "src", "styles.css"),
          prefix: `mcp-spice-${viewer}-viewer-`,
        }),
      );
    }
    const receiptHtml = await bundleViewer({
      configPath,
      entry: RECEIPT_ENTRY,
      template: join(here, "simulation-receipt", "index.html"),
      css: join(here, "simulation-receipt", "src", "styles.css"),
      prefix: "mcp-spice-receipt-viewer-",
    });
    for (const viewer of SPICE_RESULT_VIEWERS) {
      const output = join(outputRoot, viewer, "index.html");
      await Deno.mkdir(dirname(output), { recursive: true });
      await Deno.writeTextFile(output, resultHtml.get(viewer)!);
      console.log(`[mcp-spice] wrote ${output}`);
    }
    const receiptOutput = join(
      outputRoot,
      SPICE_SIMULATION_RECEIPT_VIEWER,
      "index.html",
    );
    await Deno.mkdir(dirname(receiptOutput), { recursive: true });
    await Deno.writeTextFile(receiptOutput, receiptHtml);
    console.log(`[mcp-spice] wrote ${receiptOutput}`);
  });
}

async function bundleViewer(options: {
  readonly configPath: string;
  readonly entry: string;
  readonly template: string;
  readonly css: string;
  readonly prefix: string;
}): Promise<string> {
  const temporaryDirectory = await Deno.makeTempDir({
    prefix: options.prefix,
  });
  const bundlePath = join(temporaryDirectory, "viewer.js");
  try {
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "bundle",
        "--config",
        options.configPath,
        `--lock=${VIEWER_LOCK}`,
        "--frozen",
        "--check",
        "--platform=browser",
        "--minify",
        options.entry,
        "--output",
        bundlePath,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    if (!result.success) {
      throw new Error(new TextDecoder().decode(result.stderr));
    }
    const template = await Deno.readTextFile(options.template);
    const css = await Deno.readTextFile(options.css);
    const js = await Deno.readTextFile(bundlePath);
    return template
      .replace("/* STYLES_PLACEHOLDER */", () => css)
      .replace("/* BUNDLE_PLACEHOLDER */", () => js)
      .replaceAll(/[ \t]+(?=\r?\n)/g, "");
  } finally {
    await Deno.remove(temporaryDirectory, { recursive: true });
  }
}

if (import.meta.main) {
  await buildSpiceViewers();
}
