/**
 * The stdio shim is the adapter the Docker MCP Toolkit will actually talk
 * to, so this suite exercises the real thing end to end: real shim process,
 * real child HTTP server, real protocol translation. No mocks — a mock here
 * would encode the developer's guess about both protocol generations at
 * once, which is exactly how adapters rot.
 */
import { assert, assertEquals } from "@std/assert";
import { TextLineStream } from "@std/streams/text-line-stream";

const SHIM_PORT = 3934;

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
  "the stdio shim answers initialize locally and forwards tools/list to the real server",
  async () => {
    const shim = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        new URL("../scripts/stdio-shim.ts", import.meta.url).pathname,
        `--port=${SHIM_PORT}`,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();

    const writer = shim.stdin.getWriter();
    const send = (message: Record<string, unknown>) =>
      writer.write(new TextEncoder().encode(JSON.stringify(message) + "\n"));

    try {
      await send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "stdio-shim-test", version: "0" },
        },
      });
      await send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

      const responses = await collectResponses(shim.stdout, 2, 30_000);
      assertEquals(responses.length, 2, "expected initialize + tools/list responses");

      const init = responses[0].result as Record<string, unknown>;
      assertEquals(responses[0].id, 1);
      assertEquals(
        init.protocolVersion,
        "2025-06-18",
        "the shim must answer with the client's stdio-side revision, not the HTTP one",
      );
      const serverInfo = init.serverInfo as Record<string, unknown>;
      assertEquals(serverInfo.name, "mcp-spice");

      const listed = responses[1].result as Record<string, unknown>;
      assertEquals(responses[1].id, 2);
      const names = (listed.tools as { name: string }[]).map((t) => t.name).sort();
      assertEquals(names, [
        "ngspice_netlist_submit",
        "spice_simulate_op",
        "spice_simulate_tran",
      ]);
    } finally {
      await writer.close();
      shim.kill("SIGTERM");
      await shim.status;
    }
  },
);

Deno.test(
  "the shim surfaces the server's typed refusal instead of inventing a success",
  async () => {
    const shim = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        new URL("../scripts/stdio-shim.ts", import.meta.url).pathname,
        `--port=${SHIM_PORT + 1}`,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();

    const writer = shim.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "no/such-method",
          params: {},
        }) + "\n",
      ));
      const responses = await collectResponses(shim.stdout, 1, 30_000);
      assertEquals(responses.length, 1);
      assertEquals(responses[0].id, 7);
      assert(
        responses[0].error !== undefined,
        "an unknown method must come back as a JSON-RPC error, never silence",
      );
    } finally {
      await writer.close();
      shim.kill("SIGTERM");
      await shim.status;
    }
  },
);
