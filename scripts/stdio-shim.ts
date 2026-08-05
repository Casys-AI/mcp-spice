/**
 * stdio → stateless-HTTP adapter for this MCP server.
 *
 * Two protocol generations meet here. Clients built on the stock MCP SDKs
 * (Docker MCP Toolkit, Claude Desktop, …) speak stdio with the classic
 * `initialize` handshake of the 2025-xx revisions. This server speaks the
 * stateless 2026-07-28 revision over HTTP, where `initialize` and sessions
 * no longer exist and every request carries its own version + capabilities.
 * The park's servers accept ONLY 2026-07-28 on the wire (older versions are
 * rejected with -32022), so the translation is not optional.
 *
 * The shim therefore answers `initialize` locally — nobody downstream should
 * ever receive it — using the identity the running server publishes through
 * `server/discover` (the mandatory 2026-07-28 replacement). Everything else
 * is forwarded with the stateless envelope injected. stdout is reserved for
 * JSON-RPC lines; every log, including the child server's own output, goes
 * to stderr.
 *
 * A client that never sends `initialize` (a future stateless-aware stdio
 * client) simply hits the forwarding path — both generations are served.
 */

import { TextLineStream } from "@std/streams/text-line-stream";

const HTTP_VERSION = "2026-07-28";
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
/** Newest stdio-side revision the shim offers when the client's is unknown. */
const FALLBACK_CLIENT_VERSION = "2025-06-18";
const READINESS_TIMEOUT_MS = 20_000;
const FORWARD_TIMEOUT_MS = 120_000;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function parseArgs(): { port: number; spawnServer: boolean } {
  let port = 3023;
  let spawnServer = true;
  for (const arg of Deno.args) {
    if (arg.startsWith("--port=")) port = Number(arg.slice("--port=".length));
    if (arg === "--no-spawn") spawnServer = false;
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`[stdio-shim] invalid --port: ${port}`);
    Deno.exit(2);
  }
  return { port, spawnServer };
}

function log(message: string): void {
  console.error(`[stdio-shim] ${message}`);
}

async function forwardHttp(
  endpoint: string,
  method: string,
  message: JsonRpcMessage,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const params = { ...(message.params ?? {}) };
  const meta = { ...(params._meta as Record<string, unknown> | undefined) };
  meta[META_VERSION] = HTTP_VERSION;
  meta[META_CAPABILITIES] = meta[META_CAPABILITIES] ?? {};
  params._meta = meta;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": HTTP_VERSION,
      "Mcp-Method": method,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: message.id ?? 0,
      method,
      params,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json();
  if (typeof body !== "object" || body === null) {
    throw new Error(`non-object JSON-RPC response (HTTP ${response.status})`);
  }
  return body as Record<string, unknown>;
}

/** Pump a child stream to stderr so stdout stays pure JSON-RPC. */
function pumpToStderr(stream: ReadableStream<Uint8Array>): void {
  (async () => {
    for await (const chunk of stream) {
      await Deno.stderr.write(chunk);
    }
  })().catch(() => {});
}

async function waitForServer(
  endpoint: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const body = await forwardHttp(
        endpoint,
        "server/discover",
        { id: 0, params: {} },
        3_000,
      );
      const result = body.result as Record<string, unknown> | undefined;
      if (result !== undefined) return result;
      lastError = JSON.stringify(body.error ?? body);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  log(`server did not become ready within ${READINESS_TIMEOUT_MS} ms: ${lastError}`);
  Deno.exit(1);
}

const encoder = new TextEncoder();

async function respond(message: Record<string, unknown>): Promise<void> {
  await Deno.stdout.write(encoder.encode(JSON.stringify(message) + "\n"));
}

async function main(): Promise<void> {
  const { port, spawnServer } = parseArgs();
  const endpoint = `http://127.0.0.1:${port}/mcp`;

  let child: Deno.ChildProcess | undefined;
  if (spawnServer) {
    const serverEntry = new URL("../server.ts", import.meta.url).pathname;
    child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        serverEntry,
        `--port=${port}`,
        "--hostname=127.0.0.1",
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    pumpToStderr(child.stdout);
    pumpToStderr(child.stderr);
  }

  const discovered = await waitForServer(endpoint);
  const serverInfo = discovered.serverInfo ?? { name: "unknown", version: "0" };
  const instructions = discovered.instructions;
  log(`ready, forwarding stdio to ${endpoint}`);

  const lines = Deno.stdin.readable
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream());

  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      log(`dropping unparseable input line (${trimmed.length} chars)`);
      continue;
    }
    const { id, method } = message;

    if (method === undefined) continue;
    if (method.startsWith("notifications/")) continue;

    if (method === "initialize") {
      const requested = (message.params?.protocolVersion as string) ??
        FALLBACK_CLIENT_VERSION;
      await respond({
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          protocolVersion: requested,
          capabilities: discovered.capabilities ?? { tools: {} },
          serverInfo,
          ...(instructions !== undefined ? { instructions } : {}),
        },
      });
      continue;
    }

    if (method === "ping") {
      await respond({ jsonrpc: "2.0", id: id ?? null, result: {} });
      continue;
    }

    try {
      const body = await forwardHttp(endpoint, method, message, FORWARD_TIMEOUT_MS);
      await respond({
        jsonrpc: "2.0",
        id: id ?? null,
        ...body.result !== undefined
          ? { result: body.result }
          : { error: body.error ?? { code: -32603, message: "empty response" } },
      });
    } catch (error) {
      await respond({
        jsonrpc: "2.0",
        id: id ?? null,
        error: {
          code: -32603,
          message: `forward failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    }
  }

  child?.kill("SIGTERM");
}

await main();
