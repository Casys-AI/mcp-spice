/// <reference lib="deno.ns" />

/**
 * Capture docs/images/recorded-operating-point-viewer.png from the committed viewer
 * bundle through the documentation harness, so the README image is
 * reproducible: same recorded session, same handshake, same viewport, headless Chrome.
 *
 * Usage: deno task docs:viewer-screenshot
 *   CHROME_BIN  headless-capable Chrome binary (default: local Chrome / shell)
 *   FFMPEG_BIN  optional ffmpeg; when found the PNG is re-encoded deterministically
 */

import { dirname, extname, fromFileUrl, join, resolve, SEPARATOR } from "@std/path";

const root = dirname(dirname(fromFileUrl(import.meta.url)));
const harnessPath = "/docs/fixtures/viewer-preview.html";
const outputPath = join(root, "docs/images/recorded-operating-point-viewer.png");
const WINDOW = { width: 900, height: 640 };
/** Chrome and ffmpeg both finish in seconds; a deadline keeps a stuck one from hanging. */
const TOOL_DEADLINE_MS = 60_000;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

for (
  const required of [
    "src/ui/dist/operating-point/index.html",
    harnessPath.slice(1),
  ]
) {
  await Deno.stat(join(root, required)).catch(() => {
    throw new Error(
      `CAPTURE_INPUT_MISSING ${required} — run deno task build:ui first`,
    );
  });
}

let resolvePort!: (port: number) => void;
const listening = new Promise<number>((resolve) => resolvePort = resolve);
const server = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen: ({ port }) => resolvePort(port) },
  async (request) => {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const file = resolve(root, pathname.slice(1));
    const type = CONTENT_TYPES[extname(file)];
    // Serve only what resolves inside the repository, whatever the URL spelled.
    if (!type || !file.startsWith(root + SEPARATOR)) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const body = await Deno.readFile(file);
      return new Response(body, { headers: { "content-type": type } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  },
);

const port = await listening;
// The raw frame lands next to the output so the task only needs docs/images writable.
const rawScreenshot = join(
  dirname(outputPath),
  ".recorded-operating-point-viewer.raw.png",
);
try {
  await Deno.mkdir(dirname(outputPath), { recursive: true });
  const chrome = await findExecutable([
    Deno.env.get("CHROME_BIN"),
    "/opt/homebrew/bin/chrome-headless-shell",
    "/usr/local/bin/chrome-headless-shell",
    "/usr/bin/chrome-headless-shell",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ], "CHROME_BIN");
  await run(chrome, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-gpu",
    "--force-color-profile=srgb",
    "--force-device-scale-factor=2",
    "--hide-scrollbars",
    // Locale-sensitive formatting must not follow the capturing machine.
    "--lang=en-US",
    "--run-all-compositor-stages-before-draw",
    "--timeout=8000",
    "--virtual-time-budget=8000",
    `--window-size=${WINDOW.width},${WINDOW.height}`,
    `--screenshot=${rawScreenshot}`,
    `http://127.0.0.1:${port}${harnessPath}`,
  ]);
  const ffmpeg = await findExecutable([
    Deno.env.get("FFMPEG_BIN"),
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
  ]).catch(() => undefined);
  if (ffmpeg) {
    await run(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      rawScreenshot,
      "-compression_level",
      "9",
      "-pred",
      "mixed",
      outputPath,
    ]);
  } else {
    await Deno.copyFile(rawScreenshot, outputPath);
  }
  const { size } = await Deno.stat(outputPath);
  console.log(
    `[docs:viewer-screenshot] wrote ${outputPath} (${(size / 1024).toFixed(1)} KiB)`,
  );
} finally {
  await Deno.remove(rawScreenshot).catch(() => {});
  await server.shutdown();
}

async function findExecutable(
  candidates: readonly (string | undefined)[],
  variable = "FFMPEG_BIN",
): Promise<string> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if ((await Deno.stat(candidate)).isFile) return candidate;
    } catch {
      // Try the next documented local executable.
    }
  }
  throw new Error(`CAPTURE_TOOL_MISSING set ${variable} to a local executable`);
}

async function run(command: string, args: readonly string[]): Promise<void> {
  const result = await new Deno.Command(command, {
    args: [...args],
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(TOOL_DEADLINE_MS),
  }).output();
  if (result.success) return;
  throw new Error(
    `${command} failed (${result.code}): ${
      new TextDecoder().decode(result.stderr).trim()
    }`,
  );
}
