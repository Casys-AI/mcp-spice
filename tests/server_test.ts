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

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { NetlistArtifactError } from "../src/api/netlist-artifact.ts";
import { MAX_OBSERVABLES_PER_KIND } from "../src/api/execution-budgets.ts";
import {
  NetlistSecurityError,
  SpiceIdentifierError,
  validateNetlistSecurity,
} from "../src/api/netlist-security.ts";
import {
  estimateDcSweepPoints,
  MAX_DC_SWEEP_POINTS,
  NgspiceNotFoundError,
  parseMeasurements,
  parseWrdata,
  parseWrdataSeries,
  readTransientWrdataWithinLimit,
  SpiceError,
  validateDcObservedSweep,
} from "../src/api/ngspice.ts";
import {
  isMachineReadableError,
  mapSpiceToolError,
  SpiceToolError,
} from "../src/api/tool-error.ts";
import { allTools } from "../src/tools/mod.ts";
import { createSpiceServer, parseCli } from "../server.ts";
import * as publicApi from "../mod.ts";

const RUN_NATIVE = Deno.env.get("SPICE_RUN_NATIVE") === "1";
const PACKAGE_VERSION = (JSON.parse(
  Deno.readTextFileSync(new URL("../deno.json", import.meta.url)),
) as { version: string }).version;

// ---------------------------------------------------------------------------
// Port helper
// ---------------------------------------------------------------------------

let nextPort = 14200;
function freePort(): number {
  return nextPort++;
}

Deno.test("parseCli selects native stdio without an HTTP selector", () => {
  assertEquals(parseCli(["--stdio"]).stdio, true);
});

Deno.test("parseCli rejects stdio mixed with explicit HTTP selectors", () => {
  for (
    const args of [
      ["--stdio", "--port=3023"],
      ["--hostname=127.0.0.1", "--stdio"],
    ]
  ) {
    assertThrows(
      () => parseCli(args),
      TypeError,
      "--stdio cannot be combined with --port or --hostname",
    );
  }
});

// ---------------------------------------------------------------------------
// Wire test — MCP stateless protocol
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = "2026-07-28";

async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL_VERSION,
    "mcp-method": method,
  };
  if (method === "tools/call" && typeof params.name === "string") {
    headers["mcp-name"] = params.name;
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
      assertEquals(serverInfo.version, PACKAGE_VERSION);
    } finally {
      await http.shutdown();
    }
  },
);

Deno.test(
  "mcp-spice tools/list returns submit and the bounded simulation operations",
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
      assert(tools.some((t) => t.name === "ngspice_netlist_submit"));
      assert(tools.some((t) => t.name === "spice_simulate_op"));
      assert(tools.some((t) => t.name === "spice_simulate_tran"));
      assert(tools.some((t) => t.name === "spice_simulate_dc"));
    } finally {
      await http.shutdown();
    }
  },
);

// ---------------------------------------------------------------------------
// Schema invariants — run unconditionally
// ---------------------------------------------------------------------------

Deno.test(
  "Simulation tools declare closed outputSchemas with required not_checked, measurements, input_artifact",
  () => {
    for (const tool of allTools.filter((t) => t.category === "simulation")) {
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
  "ngspice_netlist_submit declares a closed content-addressed reference schema",
  () => {
    const tool = allTools.find((t) => t.name === "ngspice_netlist_submit");
    assert(tool, "ngspice_netlist_submit must be registered");
    const schema = tool.outputSchema as Record<string, unknown>;
    assertEquals(schema.additionalProperties, false);
    const required = schema.required as string[];
    assertEquals(required, ["sha256", "bytes", "uri"]);
    const inputRequired = (tool.inputSchema as Record<string, unknown>)
      .required as string[];
    assertEquals(inputRequired, ["netlist"]);
    const inputProperties = (tool.inputSchema as Record<string, unknown>)
      .properties as Record<string, unknown>;
    assert(inputProperties.netlist_sha256 !== undefined);
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
  "Every spice simulation requires netlist_sha256; path is optional on simulate",
  () => {
    for (const tool of allTools.filter((t) => t.category === "simulation")) {
      const schema = tool.inputSchema as Record<string, unknown>;
      const required = schema.required as string[];
      assert(
        required.includes("netlist_sha256"),
        `${tool.name}: inputSchema.required must include "netlist_sha256"`,
      );
    }
    for (const tool of allTools.filter((t) => t.category === "simulation")) {
      const required = (tool.inputSchema as Record<string, unknown>)
        .required as string[];
      assert(
        !required.includes("netlist_path"),
        `${tool.name}: netlist_path must be optional so a submitted hash can replace it`,
      );
    }
  },
);

Deno.test(
  "spice_simulate_op schema accepts nodes-only, branch-only, or both, and requires one",
  () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_op");
    assert(tool, "spice_simulate_op must be registered");
    const input = tool.inputSchema as Record<string, unknown>;
    const required = input.required as string[];
    assert(
      required.includes("netlist_sha256"),
      "netlist_sha256 remains required",
    );
    assertEquals(
      required.includes("nodes"),
      false,
      "nodes must be omittable when branch_sources is supplied",
    );
    assertEquals(
      required.includes("branch_sources"),
      false,
      "branch_sources must be omittable when nodes is supplied",
    );
    const properties = input.properties as Record<string, Record<string, unknown>>;
    assertEquals(properties.nodes?.minItems, 1);
    assertEquals(properties.nodes?.maxItems, MAX_OBSERVABLES_PER_KIND);
    assertEquals(properties.branch_sources?.minItems, 1);
    assertEquals(
      properties.branch_sources?.maxItems,
      MAX_OBSERVABLES_PER_KIND,
    );
    const anyOf = input.anyOf as Array<{ required: string[] }>;
    assert(
      Array.isArray(anyOf) && anyOf.length >= 2,
      "anyOf must require one observable",
    );
    const requiredSets = anyOf.map((alt) => [...alt.required].sort().join(","));
    assert(
      requiredSets.includes("nodes"),
      "schema must accept a nodes-only call",
    );
    assert(
      requiredSets.includes("branch_sources"),
      "schema must accept a branch-only call",
    );

    const output = tool.outputSchema as Record<string, unknown>;
    assertEquals(output.additionalProperties, false);
    const outRequired = output.required as string[];
    assert(
      outRequired.includes("node_voltages"),
      "node_voltages remains in the closed output schema",
    );
    assert(
      outRequired.includes("measurements"),
      "measurements remains in the closed output schema",
    );
    assert(
      outRequired.includes("branch_currents_a"),
      "branch_currents_a must be advertised on the closed output schema",
    );
    const outProps = output.properties as Record<string, Record<string, unknown>>;
    assertEquals(outProps.branch_currents_a?.type, "object");
    assert(
      String(outProps.branch_currents_a?.description ?? "").includes("positive into"),
      "output schema must document the ngspice i(Vsource) sign convention",
    );
  },
);

Deno.test(
  "spice_simulate_tran schema accepts node or branch observables and advertises timestamped ampere summaries",
  () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_tran");
    assert(tool, "spice_simulate_tran must be registered");
    const input = tool.inputSchema as Record<string, unknown>;
    const required = input.required as string[];
    assertEquals(required.includes("nodes"), false);
    assertEquals(required.includes("branch_sources"), false);
    const anyOf = input.anyOf as Array<{ required: string[] }>;
    assert(anyOf.some((alternative) => alternative.required.includes("nodes")));
    assert(
      anyOf.some((alternative) => alternative.required.includes("branch_sources")),
    );

    const output = tool.outputSchema as Record<string, unknown>;
    assertEquals(output.additionalProperties, false);
    const outputRequired = output.required as string[];
    assert(outputRequired.includes("branch_current_stats_a"));
    const properties = output.properties as Record<string, Record<string, unknown>>;
    const nodeStats = properties.node_stats?.additionalProperties as Record<
      string,
      unknown
    >;
    assert((nodeStats.required as string[]).includes("min_at_s"));
    assert((nodeStats.required as string[]).includes("max_at_s"));
    assert((nodeStats.required as string[]).includes("final_at_s"));
    const branchStats = properties.branch_current_stats_a
      ?.additionalProperties as Record<string, unknown>;
    assert((branchStats.required as string[]).includes("min_a"));
    assert((branchStats.required as string[]).includes("final_a"));
  },
);

Deno.test(
  "spice_simulate_dc declares a closed, bounded source-sweep contract",
  () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_dc");
    assert(tool, "spice_simulate_dc must be registered");
    const input = tool.inputSchema as Record<string, unknown>;
    assertEquals(input.additionalProperties, false);
    const required = input.required as string[];
    for (
      const field of [
        "netlist_sha256",
        "sweep_source",
        "start_v",
        "stop_v",
        "step_v",
      ]
    ) {
      assert(required.includes(field), `${field} must be required`);
    }
    const properties = input.properties as Record<string, Record<string, unknown>>;
    assertEquals(properties.nodes?.maxItems, 32);
    assertEquals(properties.branch_sources?.maxItems, 32);
    assert(String(properties.step_v?.description ?? "").includes("512"));

    const output = tool.outputSchema as Record<string, unknown>;
    assertEquals(output.additionalProperties, false);
    const outputRequired = output.required as string[];
    assert(outputRequired.includes("sweep"));
    assert(outputRequired.includes("branch_current_stats_a"));
  },
);

Deno.test(
  "estimateDcSweepPoints fixes DC admission bounds and direction semantics",
  () => {
    // The estimate is deliberately conservative for a non-dividing stop: a
    // 0 → 1 V sweep at 0.3 V admits an upper bound of five positions even
    // though ngspice's observed in-range grid has four (0, 0.3, 0.6, 0.9).
    assertEquals(estimateDcSweepPoints(0, 511, 1), MAX_DC_SWEEP_POINTS);
    assertThrows(
      () => estimateDcSweepPoints(0, 512, 1),
      TypeError,
      "512-point server limit",
    );
    assertEquals(estimateDcSweepPoints(3, 0, -1), 4);
    assertThrows(
      () => estimateDcSweepPoints(0, 3, -1),
      TypeError,
      "matching sign",
    );
    assertEquals(estimateDcSweepPoints(2, 2, -0.5), 1);
    assertEquals(estimateDcSweepPoints(0, 1, 0.3), 5);
  },
);

Deno.test(
  "validateDcObservedSweep accepts reachable descending and non-dividing grids, then rejects divergence",
  () => {
    validateDcObservedSweep([0, 0.3, 0.6, 0.9], 0, 1, 0.3);
    validateDcObservedSweep([3, 2, 1, 0], 3, 0, -1);
    validateDcObservedSweep([2], 2, 2, 1);

    const error = assertThrows(
      () => validateDcObservedSweep([0, 0.3, 0.6, 1], 0, 1, 0.3),
      SpiceError,
      "axis position does not match the requested step",
    );
    assertEquals(error.code, "ngspice_dc_grid_invalid");
  },
);

Deno.test(
  "package surface keeps the raw DC executor internal and publishes README-linked metadata",
  () => {
    assertEquals(
      "runNgspiceDc" in publicApi,
      false,
      "The root package must not expose an executor that bypasses tool-level netlist validation.",
    );
    const manifest = JSON.parse(
      Deno.readTextFileSync(new URL("../deno.json", import.meta.url)),
    ) as { publish: { include: string[] } };
    for (const file of ["README.md", "CHANGELOG.md", "SECURITY.md", "CITATION.cff"]) {
      assert(
        manifest.publish.include.includes(file),
        `${file} must be included in the JSR package because README links it relatively.`,
      );
    }
  },
);

Deno.test(
  "spice_simulate_dc rejects a non-voltage sweep source before resolving the netlist",
  async () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_dc");
    assert(tool);
    const error = await assertRejects(
      async () => {
        await tool.handler({
          netlist_sha256: "a".repeat(64),
          sweep_source: "Iin",
          start_v: 0,
          stop_v: 1,
          step_v: 0.1,
          nodes: ["out"],
        });
      },
      SpiceToolError,
    );
    assertEquals(error.code, "invalid_sweep_source");
  },
);

Deno.test(
  "spice_simulate_op handler returns a machine-readable error with neither observable",
  async () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_op");
    assert(tool);
    const error = await assertRejects(
      async () => {
        await tool.handler({ netlist_sha256: "a".repeat(64) });
      },
      SpiceToolError,
    );
    assertEquals(error.code, "missing_observables");
    assert(isMachineReadableError(error));
  },
);

Deno.test(
  "spice_simulate_op handler returns a machine-readable error for empty observables",
  async () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_op");
    assert(tool);
    const error = await assertRejects(
      async () => {
        await tool.handler({
          netlist_sha256: "a".repeat(64),
          nodes: [],
          branch_sources: [],
        });
      },
      SpiceToolError,
    );
    assertEquals(error.code, "invalid_nodes");
    assert(isMachineReadableError(error));
  },
);

Deno.test(
  "spice_simulate_op rejects over-budget observables and invalid timeout before resolving a netlist",
  async () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_op");
    assert(tool);
    const observableError = await assertRejects(
      async () => {
        await tool.handler({
          netlist_sha256: "a".repeat(64),
          nodes: Array.from(
            { length: MAX_OBSERVABLES_PER_KIND + 1 },
            (_, index) => `n${index}`,
          ),
        });
      },
      SpiceToolError,
    );
    assertEquals(observableError.code, "invalid_nodes");
    assertEquals(observableError.context.maxItems, MAX_OBSERVABLES_PER_KIND);

    const timeoutError = await assertRejects(
      async () => {
        await tool.handler({
          netlist_sha256: "a".repeat(64),
          nodes: ["out"],
          timeout_s: 0,
        });
      },
      SpiceToolError,
    );
    assertEquals(timeoutError.code, "invalid_timeout_s");
    assert(isMachineReadableError(timeoutError));
  },
);

Deno.test(
  "spice_simulate_op handler rejects an injection-unsafe branch source name",
  async () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_op");
    assert(tool);
    const error = await assertRejects(
      async () => {
        await tool.handler({
          netlist_sha256: "a".repeat(64),
          branch_sources: ["Vin); quit"],
        });
      },
      SpiceIdentifierError,
      "Invalid source name",
    );
    assertEquals(error.code, "invalid_source_name");
    assertEquals(error.context.kind, "source");
  },
);

Deno.test(
  "tools/call maps selector validation to a machine-readable MCP error",
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
      const called = await rpc(url, "tools/call", {
        name: "spice_simulate_op",
        arguments: {
          netlist_sha256: "a".repeat(64),
          nodes: ["out); quit"],
        },
      });
      assertEquals(called.body.error, undefined);
      const result = called.body.result as Record<string, unknown>;
      assertEquals(result.isError, true);
      const content = result.content as Array<Record<string, unknown>>;
      const mapped = JSON.parse(content[0].text as string) as {
        code: string;
        context: Record<string, unknown>;
        recovery: string;
      };
      assertEquals(mapped.code, "invalid_node_name");
      assertEquals(mapped.context.tool, "spice_simulate_op");
      assertEquals(mapped.context.kind, "node");
      assert(typeof mapped.recovery === "string" && mapped.recovery.length > 0);
    } finally {
      await http.shutdown();
    }
  },
);

Deno.test(
  "ngspice engine errors have a structured MCP mapping without raw diagnostics",
  () => {
    const engineError = new SpiceError("private engine log tail");
    const missingEngine = new NgspiceNotFoundError();
    for (
      const [error, expectedCode] of [
        [engineError, "ngspice_simulation_failed"],
        [missingEngine, "ngspice_unavailable"],
      ] as const
    ) {
      assert(isMachineReadableError(error));
      const serialized = mapSpiceToolError(error, "spice_simulate_op");
      assert(serialized !== null);
      const mapped = JSON.parse(serialized) as {
        code: string;
        context: Record<string, unknown>;
        recovery: string;
      };
      assertEquals(mapped.code, expectedCode);
      assertEquals(mapped.context.tool, "spice_simulate_op");
      assert(typeof mapped.recovery === "string" && mapped.recovery.length > 0);
      assertEquals(serialized.includes("private engine log tail"), false);
    }
  },
);

Deno.test(
  "tools/call spice_simulate_op schema-rejects a call with neither observable",
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
      const called = await rpc(url, "tools/call", {
        name: "spice_simulate_op",
        arguments: { netlist_sha256: "a".repeat(64) },
      });
      assert(
        called.body.error !== undefined,
        "neither-observable call must fail schema validation",
      );
    } finally {
      await http.shutdown();
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

Deno.test(
  "parseMeasurements extracts hyphenated voltage and current selectors",
  () => {
    const log = `
v(out-1) = 1.250000e+00
i(v-in) = -2.50000e-03
`;
    const m = parseMeasurements(log);
    assert(
      Math.abs((m["v(out-1)"]?.value ?? -1) - 1.25) < 1e-12,
      `Expected v(out-1)=1.25, got ${m["v(out-1)"]?.value}`,
    );
    assert(
      Math.abs((m["i(v-in)"]?.value ?? 0) - (-2.5e-3)) < 1e-12,
      `Expected i(v-in)=-2.5e-3, got ${m["i(v-in)"]?.value}`,
    );
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
    assertEquals(nodeStats["out"].min_at_s, 0);
    assert(
      Math.abs(nodeStats["out"].final_at_s - 6e-3) < 1e-12,
      `Expected final sample at 6 ms, got ${nodeStats["out"].final_at_s}`,
    );
    assert(
      nodeStats["out"].max_at_s <= nodeStats["out"].final_at_s,
      "maximum timestamp must be inside the sampled transient window",
    );

    // v(in) = PULSE source = 1V after rise; final must be 1.0V
    assert(
      Math.abs(nodeStats["in"].final_v - 1.0) < 1e-6,
      `Expected v(in) final = 1.0, got ${nodeStats["in"].final_v}`,
    );
  },
);

Deno.test(
  "parseWrdataSeries keeps the first sampled independent-axis position on extrema ties",
  () => {
    const content = "0 1 0 -1\n1 1 1 -2\n2 0 2 -2\n";
    const { seriesStats, nPoints } = parseWrdataSeries(content, 2);
    assertEquals(nPoints, 3);
    assertEquals(seriesStats[0], {
      min: 0,
      max: 1,
      final: 0,
      minAt: 2,
      maxAt: 0,
      finalAt: 2,
    });
    assertEquals(seriesStats[1], {
      min: -2,
      max: -1,
      final: -2,
      minAt: 1,
      maxAt: 0,
      finalAt: 2,
    });
  },
);

Deno.test(
  "parseWrdataSeries fails closed on a malformed central row instead of returning partial statistics",
  () => {
    const error = assertThrows(
      () =>
        parseWrdataSeries(
          "0 1 0 2\n1 3 bad 4\n2 5 2 6\n",
          2,
        ),
      SpiceError,
      "non-finite or non-numeric token",
    );
    assertEquals(error.code, "ngspice_output_invalid");
    assertEquals(error.context.lineNumber, 2);
  },
);

Deno.test(
  "parseWrdataSeries rejects malformed numeric widths and non-finite numeric rows",
  () => {
    for (
      const [label, content] of [
        ["wrong-width", "0 1\n1 2 1\n"],
        ["non-finite", "0 1\n1 Infinity\n"],
      ] as const
    ) {
      const error = assertThrows(
        () => parseWrdataSeries(content, 1),
        SpiceError,
      );
      assertEquals(
        error.code,
        "ngspice_output_invalid",
        `${label} wrdata row must fail closed.`,
      );
    }
  },
);

Deno.test(
  "parseWrdataSeries rejects divergent interleaved axes rather than mixing observables",
  () => {
    const error = assertThrows(
      () => parseWrdataSeries("0 1 0 2\n1 3 1.01 4\n2 5 2 6\n", 2),
      SpiceError,
      "interleaved axes diverge",
    );
    assertEquals(error.code, "ngspice_output_invalid");
    assertEquals(error.context.lineNumber, 2);
  },
);

Deno.test(
  "transient wrdata point budget fails closed with a typed output-limit error",
  () => {
    const error = assertThrows(
      () => parseWrdataSeries("0 1\n1 2\n", 1, 1),
      SpiceError,
    );
    assertEquals(error.code, "ngspice_output_limit_exceeded");
    assertEquals(error.context.limit, "points");
    assertEquals(error.context.maxPoints, 1);
  },
);

Deno.test(
  "transient wrdata byte budget fails before the file is read",
  async () => {
    const directory = await Deno.makeTempDir({ prefix: "spice-wrdata-limit-" });
    const path = `${directory}/tran_out.dat`;
    try {
      await Deno.writeTextFile(path, "0 1\n");
      const error = await assertRejects(
        () => readTransientWrdataWithinLimit(path, 3),
        SpiceError,
      );
      assertEquals(error.code, "ngspice_output_limit_exceeded");
      assertEquals(error.context.limit, "bytes");
      assertEquals(error.context.maxBytes, 3);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "parseWrdata raises SpiceError when content has no numeric rows",
  () => {
    const empty = "\n\n";
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
  name:
    "spice_simulate_op selects OP without a caller .op directive and returns V(out)=2.0",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_op");
    assert(tool, "spice_simulate_op must be registered");

    const tmpDir = await Deno.makeTempDir({ prefix: "spice-test-" });
    const netlistPath = `${tmpDir}/vdiv.cir`;
    // No .op or .control: the called tool owns the analysis command.
    await Deno.writeTextFile(
      netlistPath,
      `Voltage Divider R1=1k R2=2k Vin=3V
Vin in 0 DC 3
R1 in out 1000
R2 out 0 2000
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

      const measurements = sc.measurements as Record<string, { value: number }>;
      assertEquals(Object.keys(measurements).sort(), ["in", "out"]);
      assertEquals(sc.branch_currents_a, {});
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

const VDIV_CIRCUIT = `Voltage Divider R1=1k R2=2k Vin=3V
Vin in 0 DC 3
R1 in out 1000
R2 out 0 2000
.end
`;

Deno.test({
  name:
    "spice_simulate_op branch-only returns i(Vin)≈-1e-3 A without mixing currents into measurements",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_op");
    assert(tool, "spice_simulate_op must be registered");

    const tmpDir = await Deno.makeTempDir({ prefix: "spice-test-" });
    const netlistPath = `${tmpDir}/vdiv.cir`;
    await Deno.writeTextFile(netlistPath, VDIV_CIRCUIT);
    const sha256 = await sha256File(netlistPath);

    try {
      const result = await tool.handler({
        netlist_path: netlistPath,
        netlist_sha256: sha256,
        branch_sources: ["Vin"],
      }) as { structuredContent: Record<string, unknown> };
      const sc = result.structuredContent;
      assertEquals(sc.node_voltages, {});
      assertEquals(sc.measurements, {});
      const currents = sc.branch_currents_a as Record<string, number>;
      assert(
        Math.abs((currents["Vin"] ?? 0) - (-1e-3)) < 1e-9,
        `Expected i(Vin) ≈ -1e-3 A, got ${currents["Vin"]}`,
      );
      assertEquals(Object.keys(currents), ["Vin"]);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "spice_simulate_op with nodes and branch_sources keeps voltages in measurements and currents separate",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_op");
    assert(tool, "spice_simulate_op must be registered");

    const tmpDir = await Deno.makeTempDir({ prefix: "spice-test-" });
    const netlistPath = `${tmpDir}/vdiv.cir`;
    await Deno.writeTextFile(netlistPath, VDIV_CIRCUIT);
    const sha256 = await sha256File(netlistPath);

    try {
      const result = await tool.handler({
        netlist_path: netlistPath,
        netlist_sha256: sha256,
        nodes: ["out", "in"],
        branch_sources: ["Vin"],
      }) as { structuredContent: Record<string, unknown> };
      const sc = result.structuredContent;
      const nodeVoltages = sc.node_voltages as Record<string, number>;
      assert(Math.abs((nodeVoltages["out"] ?? -1) - 2.0) < 1e-9);
      assert(Math.abs((nodeVoltages["in"] ?? -1) - 3.0) < 1e-9);
      const measurements = sc.measurements as Record<string, { value: number }>;
      assertEquals(Object.keys(measurements).sort(), ["in", "out"]);
      assertEquals(
        Object.keys(measurements).includes("Vin"),
        false,
        "amperes must not be mixed into measurements",
      );
      const currents = sc.branch_currents_a as Record<string, number>;
      assert(Math.abs((currents["Vin"] ?? 0) - (-1e-3)) < 1e-9);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "spice_simulate_op raises SpiceError when requested branch source is absent",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_op");
    assert(tool);

    const tmpDir = await Deno.makeTempDir({ prefix: "spice-test-" });
    const netlistPath = `${tmpDir}/vdiv.cir`;
    await Deno.writeTextFile(netlistPath, VDIV_CIRCUIT);
    const sha256 = await sha256File(netlistPath);

    try {
      await assertRejects(
        async () => {
          await tool.handler({
            netlist_path: netlistPath,
            netlist_sha256: sha256,
            branch_sources: ["Vmissing"],
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
  name:
    "tools/call spice_simulate_op accepts branch_sources and returns branch_currents_a",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const { app } = createSpiceServer({ logger: () => {} });
    const port = freePort();
    const http = await app.startHttp({
      port,
      hostname: "127.0.0.1",
      onListen: () => {},
    });
    const url = `http://127.0.0.1:${port}/mcp`;
    const tmpDir = await Deno.makeTempDir({ prefix: "spice-wire-" });
    try {
      const netlistPath = `${tmpDir}/vdiv.cir`;
      await Deno.writeTextFile(netlistPath, VDIV_CIRCUIT);
      const sha256 = await sha256File(netlistPath);
      const called = await rpc(url, "tools/call", {
        name: "spice_simulate_op",
        arguments: {
          netlist_path: netlistPath,
          netlist_sha256: sha256,
          branch_sources: ["Vin"],
        },
      });
      assertEquals(called.body.error, undefined);
      const result = called.body.result as Record<string, unknown>;
      const sc = result.structuredContent as Record<string, unknown>;
      const currents = sc.branch_currents_a as Record<string, number>;
      assert(
        Math.abs((currents["Vin"] ?? 0) - (-1e-3)) < 1e-9,
        `Expected i(Vin) ≈ -1e-3 A, got ${currents["Vin"]}`,
      );
    } finally {
      await http.shutdown();
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
  name:
    "spice_simulate_tran selects transient without a caller .tran directive and returns RC statistics",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_tran");
    assert(tool, "spice_simulate_tran must be registered");

    const tmpDir = await Deno.makeTempDir({ prefix: "spice-test-" });
    const netlistPath = `${tmpDir}/rc.cir`;
    // No .tran or .control: tstep_s/tstop_s and the called tool own the analysis.
    // PULSE: 0→1 V step at t=0, rise=1ns, tstop=6ms → covers > 5τ (τ=1ms)
    await Deno.writeTextFile(
      netlistPath,
      `RC Low-Pass Filter R=1k C=1uF Vin=1V step
Vin in 0 DC 0 PULSE(0 1 0 1n 1n 10m 20m)
R1 in out 1000
C1 out 0 1e-6
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
        branch_sources: ["Vin"],
      }) as { structuredContent: Record<string, unknown> };
      const sc = result.structuredContent;
      const nodeStats = sc.node_stats as Record<
        string,
        {
          min_v: number;
          max_v: number;
          final_v: number;
          min_at_s: number;
          max_at_s: number;
          final_at_s: number;
        }
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
      assert(
        Math.abs(nodeStats["out"].final_at_s - 6e-3) < 1e-12,
        `Expected v(out) final_at_s=0.006, got ${nodeStats["out"].final_at_s}`,
      );
      assert(
        nodeStats["out"].min_at_s >= 0 &&
          nodeStats["out"].max_at_s <= nodeStats["out"].final_at_s,
        "node extrema timestamps must be within the simulated window",
      );

      const branchStats = sc.branch_current_stats_a as Record<
        string,
        {
          min_a: number;
          max_a: number;
          final_a: number;
          min_at_s: number;
          max_at_s: number;
          final_at_s: number;
        }
      >;
      assert("Vin" in branchStats, "requested Vin branch current must be returned");
      assert(
        (branchStats["Vin"].min_a ?? 0) < -5e-4,
        `Expected Vin to deliver current at the transient start, got ${
          branchStats["Vin"].min_a
        }`,
      );
      assert(
        Math.abs(branchStats["Vin"].final_at_s - 6e-3) < 1e-12,
        "branch current final timestamp must be the final sample time",
      );
      const measurements = sc.measurements as Record<string, { value: number }>;
      assertEquals(Object.keys(measurements).sort(), ["in", "out"]);

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

Deno.test({
  name:
    "spice_simulate_dc runs a bounded source sweep and returns reduced voltage/current summaries",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "spice_simulate_dc");
    assert(tool, "spice_simulate_dc must be registered");

    const tmpDir = await Deno.makeTempDir({ prefix: "spice-dc-test-" });
    const netlistPath = `${tmpDir}/vdiv.cir`;
    await Deno.writeTextFile(netlistPath, VDIV_CIRCUIT);
    const sha256 = await sha256File(netlistPath);
    try {
      const result = await tool.handler({
        netlist_path: netlistPath,
        netlist_sha256: sha256,
        sweep_source: "Vin",
        start_v: 0,
        stop_v: 3,
        step_v: 1,
        nodes: ["out"],
        branch_sources: ["Vin"],
      }) as {
        content: string;
        structuredContent: Record<string, unknown>;
      };
      const sc = result.structuredContent;
      const nodeStats = sc.node_stats as Record<
        string,
        {
          min_v: number;
          max_v: number;
          final_v: number;
          min_at_source_v: number;
          max_at_source_v: number;
          final_at_source_v: number;
        }
      >;
      assertEquals(nodeStats["out"], {
        min_v: 0,
        max_v: 2,
        final_v: 2,
        min_at_source_v: 0,
        max_at_source_v: 3,
        final_at_source_v: 3,
      });
      const branchStats = sc.branch_current_stats_a as Record<
        string,
        {
          min_a: number;
          max_a: number;
          final_a: number;
          min_at_source_v: number;
          max_at_source_v: number;
          final_at_source_v: number;
        }
      >;
      assert(
        Math.abs(branchStats["Vin"].min_a - (-1e-3)) < 1e-12,
        `Expected i(Vin) min=-1mA, got ${branchStats["Vin"].min_a}`,
      );
      assertEquals(branchStats["Vin"].max_a, 0);
      assertEquals(branchStats["Vin"].final_at_source_v, 3);
      const sweep = sc.sweep as Record<string, unknown>;
      assertEquals(sweep.source, "Vin");
      assertEquals(sweep.n_points, 4);
      assertEquals(sweep.max_points, 512);
      assert(result.content.includes("full transfer curve not returned"));
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "tools/call spice_simulate_dc is a real MCP-path smoke",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const { app } = createSpiceServer({ logger: () => {} });
    const port = freePort();
    const http = await app.startHttp({
      port,
      hostname: "127.0.0.1",
      onListen: () => {},
    });
    const url = `http://127.0.0.1:${port}/mcp`;
    const tmpDir = await Deno.makeTempDir({ prefix: "spice-dc-wire-" });
    try {
      const netlistPath = `${tmpDir}/vdiv.cir`;
      await Deno.writeTextFile(netlistPath, VDIV_CIRCUIT);
      const sha256 = await sha256File(netlistPath);
      const called = await rpc(url, "tools/call", {
        name: "spice_simulate_dc",
        arguments: {
          netlist_path: netlistPath,
          netlist_sha256: sha256,
          sweep_source: "Vin",
          start_v: 0,
          stop_v: 3,
          step_v: 1,
          nodes: ["out"],
        },
      });
      assertEquals(called.body.error, undefined);
      const result = called.body.result as Record<string, unknown>;
      const sc = result.structuredContent as Record<string, unknown>;
      const nodeStats = sc.node_stats as Record<string, { final_v: number }>;
      assertEquals(nodeStats["out"].final_v, 2);
      assertEquals(sc.branch_current_stats_a, {});
    } finally {
      await http.shutdown();
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
