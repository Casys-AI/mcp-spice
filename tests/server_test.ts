/**
 * Tests for mcp-spice.
 *
 * Tests requiring ngspice are guarded by environment variable:
 *   SPICE_RUN_NATIVE=1  — enable integration tests against the real simulator.
 *
 * Unit tests (pure TypeScript, no subprocess) run unconditionally; they use
 * committed fixture files for realistic inputs.
 *
 * Fixture reference values (ngspice 44.2, arm64, Debian trixie):
 *   vdiv_op.txt    : v(out)=2.000000e+00 V, v(in)=3.000000e+00 V
 *   rc_tran_wrdata : 626 rows, v(out) final≈0.9975 V at t=6 ms
 *                    wrdata layout: col 0=time, col 1=v(out), col 2=time, col 3=v(in)
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { NetlistArtifactError } from "../src/api/netlist-artifact.ts";
import {
  NetlistSecurityError,
  validateNetlistSecurity,
} from "../src/api/netlist-security.ts";
import { parseMeasurements, parseWrdata, SpiceError } from "../src/api/ngspice.ts";
import { allTools } from "../src/tools/mod.ts";
import { createSpiceServer } from "../server.ts";

const RUN_NATIVE = Deno.env.get("SPICE_RUN_NATIVE") === "1";

// ---------------------------------------------------------------------------
// Port helper
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
      assertEquals(discovered.response.headers.get("mcp-session-id"), null);
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
  "mcp-spice tools/list returns spice_simulate_op and spice_simulate_tran",
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
      assert(tools.some((t) => t.name === "spice_simulate_tran"));
    } finally {
      await http.shutdown();
    }
  },
);

// ---------------------------------------------------------------------------
// Schema invariants — run unconditionally
// ---------------------------------------------------------------------------

Deno.test(
  "All spice tools declare closed outputSchemas with required not_checked, measurements, input_artifact",
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
  "All spice tools have destructiveHint and openWorldHint false in annotations",
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

Deno.test(
  "spice_simulate_op and spice_simulate_tran both require netlist_sha256 in their input schema",
  () => {
    for (const tool of allTools) {
      const schema = tool.inputSchema as Record<string, unknown>;
      const required = schema.required as string[];
      assert(
        required.includes("netlist_sha256"),
        `${tool.name}: inputSchema.required must include "netlist_sha256"`,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// parseMeasurements — unit tests, no subprocess
// ---------------------------------------------------------------------------

Deno.test(
  "parseMeasurements extracts v(out) and v(in) from vdiv_op.txt fixture",
  async () => {
    // Real ngspice 44.2 output committed as fixture.
    const log = await Deno.readTextFile(
      new URL("./fixtures/vdiv_op.txt", import.meta.url).pathname,
    );
    const m = parseMeasurements(log);
    // v(out) = 2.000000e+00 — R2/(R1+R2)*Vin = 2000/3000*3 = 2.0 V exact
    assert(
      Math.abs((m["v(out)"]?.value ?? -1) - 2.0) < 1e-9,
      `Expected v(out)=2.0, got ${m["v(out)"]?.value}`,
    );
    // v(in) = 3.000000e+00 — Vin = 3 V
    assert(
      Math.abs((m["v(in)"]?.value ?? -1) - 3.0) < 1e-9,
      `Expected v(in)=3.0, got ${m["v(in)"]?.value}`,
    );
    // i(vin) = -1.000000e-03 — current out of positive terminal
    assert(
      Math.abs((m["i(vin)"]?.value ?? 0) - (-1e-3)) < 1e-10,
      `Expected i(vin)=-1e-3, got ${m["i(vin)"]?.value}`,
    );
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
// parseWrdata — unit tests on rc_tran_wrdata.dat fixture
// ---------------------------------------------------------------------------

Deno.test(
  "parseWrdata extracts 626 rows from rc_tran_wrdata.dat fixture",
  async () => {
    // Real ngspice 44.2 wrdata output: 4 columns (2 nodes × 2 cols each).
    // Layout: col0=time(v(out)), col1=v(out), col2=time(v(in)), col3=v(in)
    const content = await Deno.readTextFile(
      new URL("./fixtures/rc_tran_wrdata.dat", import.meta.url).pathname,
    );
    const { nodeStats, nPoints } = parseWrdata(content, ["out", "in"]);
    // ngspice 44.2 produced 626 adaptive time steps for this circuit.
    assertEquals(nPoints, 626);

    // v(out) starts at 0, charges toward 1V; min≈0, max≈final≈0.9975
    assert(nodeStats["out"].min_v >= 0, "v(out) min must be >= 0");
    assert(nodeStats["out"].max_v < 1.0, "v(out) max must be < 1V (not fully charged)");
    // At tstop=6ms, v(out) ≈ 1 - exp(-6) ≈ 0.9975 V
    assert(
      Math.abs(nodeStats["out"].final_v - (1 - Math.exp(-6))) < 5e-4,
      `Expected v(out) final ≈ ${(1 - Math.exp(-6)).toFixed(4)}, got ${
        nodeStats["out"].final_v
      }`,
    );

    // v(in) = PULSE source = 1V after rise; final must be 1.0V
    assert(
      Math.abs(nodeStats["in"].final_v - 1.0) < 1e-6,
      `Expected v(in) final = 1.0, got ${nodeStats["in"].final_v}`,
    );
  },
);

Deno.test(
  "parseWrdata raises SpiceError when content has no numeric rows",
  () => {
    const empty = "no data here\njust text\n";
    try {
      parseWrdata(empty, ["out"]);
      assert(false, "Should have thrown SpiceError");
    } catch (e) {
      assert(e instanceof SpiceError);
      assert(
        (e as SpiceError).message.includes("no parseable numeric rows"),
        `Unexpected message: ${(e as SpiceError).message}`,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// validateNetlistSecurity — unit tests, no subprocess
// ---------------------------------------------------------------------------

Deno.test(
  "validateNetlistSecurity accepts a clean voltage-divider circuit",
  async () => {
    const content = await Deno.readTextFile(
      new URL("./fixtures/vdiv.cir", import.meta.url).pathname,
    );
    // Must not throw
    validateNetlistSecurity(content, "spice_simulate_op");
  },
);

Deno.test(
  "validateNetlistSecurity accepts the RC transient circuit",
  async () => {
    const content = await Deno.readTextFile(
      new URL("./fixtures/rc_tran.cir", import.meta.url).pathname,
    );
    validateNetlistSecurity(content, "spice_simulate_tran");
  },
);

Deno.test(
  "validateNetlistSecurity rejects a netlist containing .control",
  () => {
    const netlist = `Injected control block
Vin in 0 DC 1
R1 in out 1000
.op
.control
op
shell rm -rf /
.endc
.end
`;
    try {
      validateNetlistSecurity(netlist, "spice_simulate_op");
      assert(false, "Should have thrown NetlistSecurityError");
    } catch (e) {
      assert(e instanceof NetlistSecurityError);
      assert((e as NetlistSecurityError).directive.toLowerCase().includes("control"));
    }
  },
);

Deno.test(
  "validateNetlistSecurity rejects .include directive",
  () => {
    const netlist = `* circuit
.include models/transistors.sp
Vin in 0 DC 1
.op
.end
`;
    try {
      validateNetlistSecurity(netlist, "spice_simulate_op");
      assert(false, "Should have thrown NetlistSecurityError");
    } catch (e) {
      assert(e instanceof NetlistSecurityError);
      assertEquals((e as NetlistSecurityError).directive, ".include");
    }
  },
);

Deno.test(
  "validateNetlistSecurity rejects .lib directive",
  () => {
    const netlist = `.lib /opt/pdk/sky130.lib tt
Vin in 0 DC 1
.op
.end
`;
    try {
      validateNetlistSecurity(netlist, "spice_simulate_op");
      assert(false, "Should have thrown NetlistSecurityError");
    } catch (e) {
      assert(e instanceof NetlistSecurityError);
      assertEquals((e as NetlistSecurityError).directive, ".lib");
    }
  },
);

Deno.test(
  "validateNetlistSecurity rejects .shell directive",
  () => {
    const netlist = `Vin in 0 DC 1
.op
.shell echo pwned
.end
`;
    try {
      validateNetlistSecurity(netlist, "spice_simulate_op");
      assert(false, "Should have thrown NetlistSecurityError");
    } catch (e) {
      assert(e instanceof NetlistSecurityError);
      assert((e as NetlistSecurityError).directive.toLowerCase().includes("shell"));
    }
  },
);

Deno.test(
  "validateNetlistSecurity rejects a bare shell command",
  () => {
    const netlist = `Vin in 0 DC 1
.op
shell cat /etc/passwd
.end
`;
    try {
      validateNetlistSecurity(netlist, "spice_simulate_op");
      assert(false, "Should have thrown NetlistSecurityError");
    } catch (e) {
      assert(e instanceof NetlistSecurityError);
      assert((e as NetlistSecurityError).directive.toLowerCase().startsWith("shell"));
    }
  },
);

Deno.test(
  "validateNetlistSecurity rejects an absolute path token",
  () => {
    const netlist = `Vin in 0 DC 1
R1 /evil/path out 1000
.op
.end
`;
    try {
      validateNetlistSecurity(netlist, "spice_simulate_op");
      assert(false, "Should have thrown NetlistSecurityError");
    } catch (e) {
      assert(e instanceof NetlistSecurityError);
      assert(
        (e as NetlistSecurityError).directive.includes("absolute path"),
        `Expected "absolute path" in directive, got: ${
          (e as NetlistSecurityError).directive
        }`,
      );
    }
  },
);

Deno.test(
  "validateNetlistSecurity accepts SPICE comment lines starting with *",
  () => {
    const netlist = `* This is a comment
* .include is ignored in comments
* .control is also a comment
Vin in 0 DC 1
R1 in out 1000
.op
.end
`;
    // Must not throw
    validateNetlistSecurity(netlist, "spice_simulate_op");
  },
);

// ---------------------------------------------------------------------------
// NetlistArtifactError — digest validation before I/O
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
// Native integration tests — require SPICE_RUN_NATIVE=1
// ---------------------------------------------------------------------------

/** Compute SHA-256 hex of a file, for use in native tests. */
async function sha256File(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  const contiguous = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    contiguous.buffer as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test({
  name: "spice_simulate_op returns V(out)=2.0 for R1=1k R2=2k Vin=3V voltage divider",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_op");
    assert(tool, "spice_simulate_op must be registered");

    const tmpDir = await Deno.makeTempDir({ prefix: "spice-test-" });
    const netlistPath = `${tmpDir}/vdiv.cir`;
    // Circuit-only netlist — no .control block
    await Deno.writeTextFile(
      netlistPath,
      `Voltage Divider R1=1k R2=2k Vin=3V
Vin in 0 DC 3
R1 in out 1000
R2 out 0 2000
.op
.end
`,
    );
    const sha256 = await sha256File(netlistPath);

    try {
      const result = await tool.handler({
        netlist_path: netlistPath,
        netlist_sha256: sha256,
        nodes: ["out", "in"],
      }) as { structuredContent: Record<string, unknown> };
      const sc = result.structuredContent;
      const nodeVoltages = sc.node_voltages as Record<string, number>;

      // Real ngspice-44.2 result: v(out) = 2.000000e+00 V
      assert(
        Math.abs((nodeVoltages["out"] ?? -1) - 2.0) < 1e-9,
        `Expected v(out) ≈ 2.0 V, got ${nodeVoltages["out"]}`,
      );
      assert(
        Math.abs((nodeVoltages["in"] ?? -1) - 3.0) < 1e-9,
        `Expected v(in) ≈ 3.0 V, got ${nodeVoltages["in"]}`,
      );

      const artifact = sc.input_artifact as Record<string, unknown>;
      assert(
        typeof artifact.sha256 === "string" &&
          /^[a-f0-9]{64}$/.test(artifact.sha256),
        "input_artifact.sha256 must be a 64-char hex string",
      );
      assertEquals(artifact.sha256, sha256);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "spice_simulate_op raises NetlistSecurityError when netlist contains .control",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_op");
    assert(tool);

    const tmpDir = await Deno.makeTempDir({ prefix: "spice-test-" });
    const netlistPath = `${tmpDir}/injected.cir`;
    await Deno.writeTextFile(
      netlistPath,
      `Injected
Vin in 0 DC 1
.control
op
quit
.endc
.end
`,
    );
    const sha256 = await sha256File(netlistPath);

    try {
      await assertRejects(
        async () => {
          await tool.handler({
            netlist_path: netlistPath,
            netlist_sha256: sha256,
            nodes: ["in"],
          });
        },
        NetlistSecurityError,
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "spice_simulate_op raises NetlistArtifactError on SHA-256 mismatch",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_op");
    assert(tool);

    const tmpDir = await Deno.makeTempDir({ prefix: "spice-test-" });
    const netlistPath = `${tmpDir}/vdiv.cir`;
    await Deno.writeTextFile(netlistPath, "Vin in 0 DC 1\nR1 in out 1k\n.op\n.end\n");

    try {
      await assertRejects(
        async () => {
          await tool.handler({
            netlist_path: netlistPath,
            netlist_sha256: "a".repeat(64), // wrong hash
            nodes: ["out"],
          });
        },
        NetlistArtifactError,
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "spice_simulate_op raises SpiceError when requested node is absent from output",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_op");
    assert(tool);

    const tmpDir = await Deno.makeTempDir({ prefix: "spice-test-" });
    const netlistPath = `${tmpDir}/vdiv.cir`;
    await Deno.writeTextFile(
      netlistPath,
      "Vin in 0 DC 3\nR1 in out 1000\nR2 out 0 2000\n.op\n.end\n",
    );
    const sha256 = await sha256File(netlistPath);

    try {
      await assertRejects(
        async () => {
          await tool.handler({
            netlist_path: netlistPath,
            netlist_sha256: sha256,
            nodes: ["nonexistent_node_xyz"],
          });
        },
        SpiceError,
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "spice_simulate_tran returns min/max/final for RC low-pass R=1k C=1µF Vin=1V",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_tran");
    assert(tool, "spice_simulate_tran must be registered");

    const tmpDir = await Deno.makeTempDir({ prefix: "spice-test-" });
    const netlistPath = `${tmpDir}/rc.cir`;
    // Circuit-only netlist — no .control block
    // PULSE: 0→1 V step at t=0, rise=1ns, tstop=6ms → covers > 5τ (τ=1ms)
    await Deno.writeTextFile(
      netlistPath,
      `RC Low-Pass Filter R=1k C=1uF Vin=1V step
Vin in 0 DC 0 PULSE(0 1 0 1n 1n 10m 20m)
R1 in out 1000
C1 out 0 1e-6
.tran 10u 6m
.end
`,
    );
    const sha256 = await sha256File(netlistPath);

    try {
      const result = await tool.handler({
        netlist_path: netlistPath,
        netlist_sha256: sha256,
        tstep_s: 10e-6,
        tstop_s: 6e-3,
        nodes: ["out", "in"],
      }) as { structuredContent: Record<string, unknown> };
      const sc = result.structuredContent;
      const nodeStats = sc.node_stats as Record<
        string,
        { min_v: number; max_v: number; final_v: number }
      >;
      const simulation = sc.simulation as Record<string, unknown>;

      // v(out): starts at 0, charges toward 1V; at t=6ms ≈ 1-exp(-6) ≈ 0.9975
      // Real ngspice-44.2: final=9.97521370e-01, 626 rows
      assert(nodeStats["out"].min_v >= 0, "v(out) min must be >= 0");
      assert(
        Math.abs(nodeStats["out"].final_v - (1 - Math.exp(-6))) < 5e-4,
        `Expected v(out) final ≈ ${(1 - Math.exp(-6)).toFixed(4)}, got ${
          nodeStats["out"].final_v
        }`,
      );

      // v(in) = PULSE = 1V after rise; final ≈ 1V
      assert(
        Math.abs(nodeStats["in"].final_v - 1.0) < 1e-4,
        `Expected v(in) final = 1.0, got ${nodeStats["in"].final_v}`,
      );

      // n_points: ngspice 44.2 produced 626 for this circuit
      assert(
        typeof simulation.n_points === "number" && simulation.n_points > 100,
        `Expected n_points > 100, got ${simulation.n_points}`,
      );
      assertEquals(simulation.tstop_s, 6e-3);

      const artifact = sc.input_artifact as Record<string, unknown>;
      assertEquals(artifact.sha256, sha256);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "spice_simulate_tran raises NetlistSecurityError when netlist contains .include",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_tran");
    assert(tool);

    const tmpDir = await Deno.makeTempDir({ prefix: "spice-test-" });
    const netlistPath = `${tmpDir}/bad.cir`;
    await Deno.writeTextFile(
      netlistPath,
      `* bad netlist
.include models/sky130.sp
Vin in 0 DC 1
.tran 1u 1m
.end
`,
    );
    const sha256 = await sha256File(netlistPath);

    try {
      await assertRejects(
        async () => {
          await tool.handler({
            netlist_path: netlistPath,
            netlist_sha256: sha256,
            tstep_s: 1e-6,
            tstop_s: 1e-3,
            nodes: ["in"],
          });
        },
        NetlistSecurityError,
        ".include",
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
