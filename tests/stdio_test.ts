/**
 * The server's stdio mode is framework-native. Exercise a real process rather
 * than a transport mock so legacy client negotiation and a tool call stay
 * covered together.
 */
import { assertEquals } from "@std/assert";
import { TextLineStream } from "@std/streams/text-line-stream";

const PACKAGE_VERSION = (JSON.parse(
  Deno.readTextFileSync(new URL("../deno.json", import.meta.url)),
) as { version: string }).version;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function collectResponses(
  stdout: ReadableStream<Uint8Array>,
  expected: number,
  timeoutMs: number,
): Promise<Record<string, unknown>[]> {
  const responses: Record<string, unknown>[] = [];
  const lines = stdout
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream());
  const deadline = AbortSignal.timeout(timeoutMs);
  const reader = lines.getReader();
  try {
    while (responses.length < expected) {
      if (deadline.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      if (value.trim() === "") continue;
      responses.push(JSON.parse(value) as Record<string, unknown>);
    }
  } finally {
    reader.releaseLock();
  }
  return responses;
}

Deno.test(
  "server --stdio accepts legacy initialize and submits a content-addressed netlist",
  async () => {
    const storeDir = await Deno.makeTempDir({ prefix: "mcp-spice-stdio-store-" });
    const server = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        new URL("../server.ts", import.meta.url).pathname,
        "--stdio",
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
      env: { SPICE_NETLIST_STORE: storeDir },
    }).spawn();

    const writer = server.stdin.getWriter();
    const send = (message: Record<string, unknown>) =>
      writer.write(new TextEncoder().encode(JSON.stringify(message) + "\n"));
    const netlist = "Voltage divider\nVin in 0 1\nR1 in out 1k\nR2 out 0 1k\n.end\n";
    const netlistSha256 = await sha256Hex(netlist);

    try {
      await send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "mcp-spice-stdio-test", version: "0" },
        },
      });
      await send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "ngspice_netlist_submit",
          arguments: { netlist, netlist_sha256: netlistSha256 },
        },
      });

      const responses = await collectResponses(server.stdout, 2, 30_000);
      assertEquals(responses.length, 2, "expected initialize + tools/call responses");
      assertEquals(responses[0].id, 1);
      const initialized = responses[0].result as Record<string, unknown>;
      assertEquals(initialized.protocolVersion, "2025-06-18");

      assertEquals(responses[1].id, 2);
      assertEquals(responses[1].error, undefined);
      const submitted = responses[1].result as Record<string, unknown>;
      assertEquals(submitted.isError, undefined);
      const structured = submitted.structuredContent as Record<string, unknown>;
      assertEquals(structured.sha256, netlistSha256);
    } finally {
      await writer.close();
      server.kill("SIGTERM");
      await server.status;
      await Deno.remove(storeDir, { recursive: true });
    }
  },
);

Deno.test(
  "server --stdio accepts a modern-first discover request with clean stdout",
  async () => {
    const server = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        new URL("../server.ts", import.meta.url).pathname,
        "--stdio",
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    const writer = server.stdin.getWriter();
    await writer.write(new TextEncoder().encode(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 20,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "mcp-spice-modern-stdio-test",
              version: "0",
            },
          },
        },
      }) + "\n",
    ));
    await writer.close();

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      server.output(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          try {
            server.kill("SIGKILL");
          } catch { /* process already stopped */ }
          reject(new Error("modern-first stdio response timed out"));
        }, 10_000);
      }),
    ]).finally(() => clearTimeout(timeout));

    assertEquals(result.success, true);
    const stdout = new TextDecoder().decode(result.stdout);
    const line = stdout.trim();
    assertEquals(
      stdout,
      `${line}\n`,
      "stdout must contain exactly one JSON-RPC response line and no logs",
    );

    const response = JSON.parse(line) as Record<string, unknown>;
    assertEquals(response.id, 20);
    assertEquals(response.error, undefined);
    const discovered = response.result as Record<string, unknown>;
    assertEquals(discovered.resultType, "complete");
    const meta = discovered._meta as Record<string, unknown>;
    assertEquals(meta["io.modelcontextprotocol/serverInfo"], {
      name: "mcp-spice",
      version: PACKAGE_VERSION,
    });
  },
);
