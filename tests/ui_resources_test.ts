import { assert, assertEquals } from "@std/assert";
import { allTools } from "../src/tools/mod.ts";
import { createSpiceServer } from "../server.ts";
import {
  SPICE_DC_SWEEP_URI,
  SPICE_OPERATING_POINT_URI,
  SPICE_SIMULATION_OUTCOME_URI,
  SPICE_SIMULATION_RECEIPT_URI,
  SPICE_TRANSIENT_RESULT_URI,
  SPICE_VIEWERS,
} from "../src/ui/constants.ts";

const PROTOCOL_VERSION = "2026-07-28";
let nextPort = 15200;
function freePort(): number {
  return nextPort++;
}

Deno.test("default server registers committed HTML viewers from server.ts", () => {
  const { viewerRegistration } = createSpiceServer({ logger: () => {} });
  assertEquals(viewerRegistration.registered, [...SPICE_VIEWERS]);
  assertEquals(viewerRegistration.skipped, []);
});

Deno.test("UI is attached only to simulation results and their documentary readback", () => {
  const expected = {
    spice_simulate_op: SPICE_OPERATING_POINT_URI,
    spice_simulate_dc: SPICE_DC_SWEEP_URI,
    spice_simulate_tran: SPICE_TRANSIENT_RESULT_URI,
    spice_simulation_result_get: SPICE_SIMULATION_OUTCOME_URI,
    spice_simulation_receipt_get: SPICE_SIMULATION_RECEIPT_URI,
  };
  for (const [name, uri] of Object.entries(expected)) {
    const tool = allTools.find((candidate) => candidate.name === name);
    assert(tool, name);
    assertEquals(
      (tool._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri,
      uri,
    );
  }
  assertEquals(
    allTools.find((tool) => tool.name === "ngspice_netlist_submit")?._meta,
    undefined,
  );
  assertEquals(
    allTools.find((tool) => tool.name === "spice_simulation_dispatch_get")
      ?._meta,
    undefined,
  );
});

Deno.test("tools/list and resources/read expose MCP Apps HTML without changing tool names", async () => {
  const html = "<!doctype html><title>SPICE Operating Point</title>";
  const { app, viewerRegistration } = createSpiceServer({
    logger: () => {},
    viewerFileSystem: {
      exists: () => true,
      readFile: () => html,
    },
    viewerModuleUrl: import.meta.url,
  });
  assertEquals(viewerRegistration.registered, [...SPICE_VIEWERS]);
  const port = freePort();
  const http = await app.startHttp({
    port,
    hostname: "127.0.0.1",
    onListen: () => {},
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  try {
    const listed = await rpc(url, "tools/list");
    const tools = (listed.body.result as { tools: Array<Record<string, unknown>> })
      .tools;
    assertEquals(
      tools.map((tool) => tool.name).toSorted(),
      [
        "ngspice_netlist_submit",
        "spice_simulate_dc",
        "spice_simulate_op",
        "spice_simulate_tran",
        "spice_simulation_dispatch_get",
        "spice_simulation_receipt_get",
        "spice_simulation_result_get",
      ],
    );
    const submit = tools.find((tool) => tool.name === "ngspice_netlist_submit");
    assertEquals(submit?._meta, undefined);
    const op = tools.find((tool) => tool.name === "spice_simulate_op");
    assertEquals(
      ((op?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui)
        ?.resourceUri,
      SPICE_OPERATING_POINT_URI,
    );

    const resource = await rpc(url, "resources/read", {
      uri: SPICE_OPERATING_POINT_URI,
    });
    const contents =
      (resource.body.result as { contents: Array<Record<string, unknown>> })
        .contents;
    assertEquals(contents[0]?.text, html);
    assertEquals(contents[0]?.uri, SPICE_OPERATING_POINT_URI);
  } finally {
    await http.shutdown();
  }
});

async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL_VERSION,
    "mcp-method": method,
  };
  if (method === "tools/call" && typeof params.name === "string") {
    headers["mcp-name"] = params.name;
  }
  if (method === "resources/read" && typeof params.uri === "string") {
    headers["mcp-name"] = params.uri;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "mcp-spice-test",
            version: "0.1.0",
          },
        },
      },
    }),
  });
  return { body: await response.json() as Record<string, unknown> };
}
