/**
 * The server's stdio mode is framework-native. Exercise a real process rather
 * than a transport mock so legacy client negotiation and a tool call stay
 * covered together.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { TextLineStream } from "@std/streams/text-line-stream";
import { EXECUTION_BUDGETS_VERSION } from "../src/api/execution-budgets.ts";
import { configureNetlistStoreDir, putNetlistBytes } from "../src/api/netlist-store.ts";
import {
  beginSimulationDispatch,
  configureReceiptStoreDir,
  MCP_SPICE_VERSION,
  publishSimulationOutcome,
} from "../src/api/simulation-receipts.ts";

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
  "server --stdio accepts legacy initialize and submits a netlist without a client-computed hash",
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
          arguments: { netlist },
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
  "server --stdio maps an unsafe selector to a machine-readable MCP tool error",
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
      stderr: "null",
    }).spawn();

    const writer = server.stdin.getWriter();
    const send = (message: Record<string, unknown>) =>
      writer.write(new TextEncoder().encode(JSON.stringify(message) + "\n"));
    try {
      await send({
        jsonrpc: "2.0",
        id: 10,
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
        id: 11,
        method: "tools/call",
        params: {
          name: "spice_simulate_op",
          arguments: {
            netlist_sha256: "a".repeat(64),
            branch_sources: ["Vin); quit"],
          },
        },
      });

      const responses = await collectResponses(server.stdout, 2, 30_000);
      assertEquals(responses.length, 2);
      assertEquals(responses[1].id, 11);
      assertEquals(responses[1].error, undefined);
      const result = responses[1].result as Record<string, unknown>;
      assertEquals(result.isError, true);
      const content = result.content as Array<Record<string, unknown>>;
      const mapped = JSON.parse(content[0].text as string) as {
        code: string;
        context: Record<string, unknown>;
        recovery: string;
      };
      assertEquals(mapped.code, "invalid_source_name");
      assertEquals(mapped.context.tool, "spice_simulate_op");
      assertEquals(mapped.context.kind, "source");
      assert(typeof mapped.recovery === "string" && mapped.recovery.length > 0);
    } finally {
      await writer.close();
      try {
        server.kill("SIGTERM");
      } catch {
        /* process already stopped */
      }
      await server.status;
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

Deno.test(
  "server --stdio reads an exact durable documentary receipt after restart",
  async () => {
    const root = await Deno.makeTempDir({ prefix: "mcp-spice-stdio-receipts-" });
    configureNetlistStoreDir(join(root, "inputs"));
    configureReceiptStoreDir(join(root, "receipts"));
    const netlistText = "V1 in 0 1\nR1 in 0 1000\n.end\n";
    const netlist = await putNetlistBytes(
      new TextEncoder().encode(netlistText),
      "stdio_receipt_test",
    );
    const ngspiceVersion = "ngspice stdio test runtime";
    const started = await beginSimulationDispatch({
      analysis_kind: "op",
      netlist_sha256: netlist.sha256,
      normalized_request: {
        nodes: ["in"],
        branch_sources: [],
        timeout_s: 30,
      },
      runtime_identity: {
        mcp_spice_version: MCP_SPICE_VERSION,
        execution_budgets: EXECUTION_BUDGETS_VERSION,
        deno_version: "2.9.6-test",
        os: "test",
        arch: "test",
        ngspice_version: ngspiceVersion,
        ngspice_version_sha256: await sha256Hex(ngspiceVersion),
      },
    });
    const published = await publishSimulationOutcome({
      request_sha256: started.request_sha256,
      dispatch: started.dispatch,
      execution_state: "succeeded",
      result: {
        node_voltages: { in: 1 },
        branch_currents_a: {},
        measurements: { in: { value: 1 } },
        not_checked: ["documentary test only"],
        input_artifact: { sha256: netlist.sha256, bytes: netlist.bytes },
      },
    });
    configureReceiptStoreDir(undefined);
    configureNetlistStoreDir(undefined);

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
      env: { NGSPICE_RUNS_DIR: root },
    }).spawn();
    const writer = server.stdin.getWriter();
    const send = (message: Record<string, unknown>) =>
      writer.write(new TextEncoder().encode(JSON.stringify(message) + "\n"));
    try {
      await send({
        jsonrpc: "2.0",
        id: 30,
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
        id: 31,
        method: "tools/call",
        params: {
          name: "spice_simulation_receipt_get",
          arguments: { receipt_sha256: published.receipt_sha256 },
        },
      });
      const responses = await collectResponses(server.stdout, 2, 30_000);
      assertEquals(responses.length, 2);
      assertEquals(responses[1].id, 31);
      const result = responses[1].result as Record<string, unknown>;
      assertEquals(result.isError, undefined);
      const structured = result.structuredContent as Record<string, unknown>;
      assertEquals(structured.receipt_sha256, published.receipt_sha256);
    } finally {
      await writer.close();
      try {
        server.kill("SIGTERM");
      } catch {
        /* process already stopped */
      }
      await server.status;
      await Deno.remove(root, { recursive: true });
    }
  },
);
