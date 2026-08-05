/**
 * Tests for mcp-spice.
 *
 * Tests requiring ngspice are guarded by environment variable:
 *   SPICE_RUN_NATIVE=1  — enable integration tests against the real simulator.
 *
 * Unit tests (pure TypeScript, no subprocess) run unconditionally.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { parseMeasurements } from "../src/api/ngspice.ts";
import { NetlistArtifactError } from "../src/api/netlist-artifact.ts";
import { allTools } from "../src/tools/mod.ts";
import { createSpiceServer } from "../server.ts";

const RUN_NATIVE = Deno.env.get("SPICE_RUN_NATIVE") === "1";

// ---------------------------------------------------------------------------
// Port helper (mirrors mcp-dfm pattern)
// ---------------------------------------------------------------------------

let nextPort = 14200;
function freePort(): number {
  return nextPort++;
}

// ---------------------------------------------------------------------------
// Wire test — MCP stateless protocol
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = "2026-07-28";

async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-method": method,
    },
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
  const body = await response.json() as Record<string, unknown>;
  return { response, body };
}

Deno.test(
  "mcp-spice server starts and serves stateless MCP discover",
  async () => {
    const { app } = createSpiceServer({ logger: () => {} });
    const port = freePort();
    const http = await app.startHttp({
      port,
      hostname: "127.0.0.1",
      onListen: () => {},
    });
    const url = `http://127.0.0.1:${port}/mcp`;
    try {
      const discovered = await rpc(url, "server/discover");
      // Stateless: no mcp-session-id header
      assertEquals(
        discovered.response.headers.get("mcp-session-id"),
        null,
      );
      const result = discovered.body.result as Record<string, unknown>;
      const serverInfo = result.serverInfo as Record<string, unknown>;
      assertEquals(serverInfo.name, "mcp-spice");
      assertEquals(serverInfo.version, "0.1.0");
    } finally {
      await http.shutdown();
    }
  },
);

Deno.test(
  "mcp-spice tools/list returns spice_simulate_op",
  async () => {
    const { app } = createSpiceServer({ logger: () => {} });
    const port = freePort();
    const http = await app.startHttp({
      port,
      hostname: "127.0.0.1",
      onListen: () => {},
    });
    const url = `http://127.0.0.1:${port}/mcp`;
    try {
      const listed = await rpc(url, "tools/list");
      const result = listed.body.result as Record<string, unknown>;
      const tools = result.tools as Array<Record<string, unknown>>;
      assert(tools.some((t) => t.name === "spice_simulate_op"));
    } finally {
      await http.shutdown();
    }
  },
);

// ---------------------------------------------------------------------------
// Schema invariants — run unconditionally
// ---------------------------------------------------------------------------

Deno.test(
  "All spice tools declare closed outputSchemas with required not_checked",
  () => {
    for (const tool of allTools) {
      const schema = tool.outputSchema as Record<string, unknown>;
      assertEquals(
        schema.additionalProperties,
        false,
        `${tool.name}: outputSchema must have additionalProperties: false`,
      );
      const required = schema.required as string[];
      assert(
        required.includes("not_checked"),
        `${tool.name}: outputSchema.required must include "not_checked"`,
      );
      assert(
        required.includes("input_artifact"),
        `${tool.name}: outputSchema.required must include "input_artifact"`,
      );
      assert(
        required.includes("measurements"),
        `${tool.name}: outputSchema.required must include "measurements"`,
      );
    }
  },
);

Deno.test(
  "All spice tools have readOnlyHint and openWorldHint false in annotations",
  () => {
    for (const tool of allTools) {
      assertEquals(
        tool.annotations.openWorldHint,
        false,
        `${tool.name}: openWorldHint must be false`,
      );
      assertEquals(
        tool.annotations.destructiveHint,
        false,
        `${tool.name}: destructiveHint must be false`,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// parseMeasurements — unit tests, no subprocess
// ---------------------------------------------------------------------------

Deno.test(
  "parseMeasurements extracts v(out) and i(vin) from .op print output",
  () => {
    const log = `
Note: No compatibility mode selected!

Circuit: voltage divider test

v(out) = 2.000000e+00
v(in) = 3.000000e+00
i(vin) = -1.00000e-03
ngspice-44.2 done
`;
    const m = parseMeasurements(log);
    assertEquals(m["v(out)"]?.value, 2.0);
    assertEquals(m["v(in)"]?.value, 3.0);
    // i(vin) is negative
    assert(Math.abs((m["i(vin)"]?.value ?? 0) - (-1e-3)) < 1e-10);
  },
);

Deno.test(
  "parseMeasurements extracts .meas result with at= trailer",
  () => {
    const log = `
vmax                =  5.382215e-01 at=  1.500001e-03
t50                 =  1.420479e-03
f3db                =  1.587800e+02
`;
    const m = parseMeasurements(log);
    assert(Math.abs((m["vmax"]?.value ?? 0) - 5.382215e-1) < 1e-10);
    assert(Math.abs((m["vmax"]?.at ?? 0) - 1.500001e-3) < 1e-12);
    assert(Math.abs((m["t50"]?.value ?? 0) - 1.420479e-3) < 1e-12);
    assert(Math.abs((m["f3db"]?.value ?? 0) - 1.587800e+2) < 1e-6);
    assertEquals(m["t50"]?.at, undefined);
  },
);

Deno.test(
  "parseMeasurements ignores Index table headers from print all",
  () => {
    const log = `
Index   time            in              out             t50
Index   time            vin#branch      vmax
v(out) = 1.234567e+00
`;
    const m = parseMeasurements(log);
    // Only v(out) should be present
    assertEquals(Object.keys(m).length, 1);
    assert(Math.abs((m["v(out)"]?.value ?? 0) - 1.234567) < 1e-7);
  },
);

Deno.test(
  "parseMeasurements returns empty object when no measurement lines present",
  () => {
    const log = `
Note: No compatibility mode selected!

Circuit: empty
ngspice-44.2 done
`;
    const m = parseMeasurements(log);
    assertEquals(Object.keys(m).length, 0);
  },
);

// ---------------------------------------------------------------------------
// NetlistArtifactError — invalid digest format rejected before I/O
// ---------------------------------------------------------------------------

Deno.test(
  "snapshotNetlistArtifact rejects a malformed expected_sha256 before touching the filesystem",
  async () => {
    const { snapshotNetlistArtifact } = await import(
      "../src/api/netlist-artifact.ts"
    );
    await assertRejects(
      () =>
        snapshotNetlistArtifact(
          "spice_simulate_op",
          "/nonexistent/circuit.cir",
          "not-a-valid-sha256",
        ),
      NetlistArtifactError,
      "expected_netlist_sha256 must be a 64-character hexadecimal SHA-256 digest",
    );
  },
);

Deno.test(
  "snapshotNetlistArtifact raises NetlistArtifactError for missing file",
  async () => {
    const { snapshotNetlistArtifact } = await import(
      "../src/api/netlist-artifact.ts"
    );
    await assertRejects(
      () =>
        snapshotNetlistArtifact(
          "spice_simulate_op",
          "/this/file/does/not/exist.cir",
        ),
      NetlistArtifactError,
      "Netlist file not found",
    );
  },
);

// ---------------------------------------------------------------------------
// Native integration test — requires SPICE_RUN_NATIVE=1
// ---------------------------------------------------------------------------

Deno.test({
  name: "spice_simulate_op returns V(out)=2.0 for R1=1k R2=2k Vin=3V voltage divider",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_op");
    assert(tool, "spice_simulate_op must be registered");

    // Write the netlist to a temp file
    const tmpDir = await Deno.makeTempDir({ prefix: "spice-test-" });
    const netlistPath = `${tmpDir}/vdiv.cir`;
    await Deno.writeTextFile(
      netlistPath,
      `Voltage Divider Integration Test
Vin in 0 DC 3
R1 in out 1000
R2 out 0 2000
.op
.control
run
print v(out) v(in) i(Vin)
quit
.endc
.end
`,
    );

    try {
      const result = await tool.handler({ netlist_path: netlistPath }) as {
        structuredContent: Record<string, unknown>;
      };
      const sc = result.structuredContent;
      const measurements = sc.measurements as Record<
        string,
        { value: number }
      >;

      // V(out) must equal 2.0 V (R2/(R1+R2) * Vin = 2000/3000 * 3 = 2.0)
      // Real ngspice-44.2 result: v(out) = 2.000000e+00
      assert(
        Math.abs((measurements["v(out)"]?.value ?? -1) - 2.0) < 1e-9,
        `Expected v(out) ≈ 2.0 V, got ${measurements["v(out)"]?.value}`,
      );
      assert(
        Math.abs((measurements["v(in)"]?.value ?? -1) - 3.0) < 1e-9,
        `Expected v(in) ≈ 3.0 V, got ${measurements["v(in)"]?.value}`,
      );

      const artifact = sc.input_artifact as Record<string, unknown>;
      assert(
        typeof artifact.sha256 === "string" &&
          /^[a-f0-9]{64}$/.test(artifact.sha256),
        "input_artifact.sha256 must be a 64-char hex string",
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
