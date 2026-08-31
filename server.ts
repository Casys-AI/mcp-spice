/**
 * Stateless HTTP MCP server for deterministic SPICE circuit simulation.
 *
 * Runs ngspice 44.2 in batch mode. The netlist is the circuit as code —
 * the caller owns it, the server only runs the simulation and returns
 * named scalar measurements. No verdict; the oracle decides compliance.
 *
 * Default port: 3023. Override with --port=<n> or MCP_PORT env var.
 */

import { McpApp, type RegisterViewersSummary } from "@casys/mcp-server";
import { MCP_SPICE_VERSION } from "./src/api/simulation-receipts.ts";
import { mapSpiceToolError } from "./src/api/tool-error.ts";
import { SpiceToolsClient } from "./src/client.ts";
import { registerSpiceViewers, type SpiceViewerFileSystem } from "./src/viewers.ts";

/** Public runtime identity; kept lockstep with deno.json by the test suite. */
export const SERVER_VERSION = MCP_SPICE_VERSION;
const DEFAULT_PORT = 3023;
const DEFAULT_HOSTNAME = "127.0.0.1";

export interface CreateSpiceServerOptions {
  logger?: (message: string) => void;
  viewerFileSystem?: SpiceViewerFileSystem;
  viewerModuleUrl?: string;
}

export function createSpiceServer(
  options: CreateSpiceServerOptions = {},
): { app: McpApp; viewerRegistration: RegisterViewersSummary } {
  const client = new SpiceToolsClient();
  const handlers = client.buildHandlersMap();

  const app = new McpApp({
    name: "mcp-spice",
    version: SERVER_VERSION,
    transport: "stateless",
    maxConcurrent: 4,
    backpressureStrategy: "queue",
    validateSchema: true,
    instructions: "SPICE circuit simulation via ngspice 44.2 batch mode. " +
      "Admit a netlist with ngspice_netlist_submit (exact UTF-8 bytes; an " +
      "expected SHA-256 is optional) to obtain a content-addressed reference. " +
      "spice_simulate_op, spice_simulate_tran, and spice_simulate_dc accept " +
      "that reference via netlist_sha256 (optional netlist_uri) or a filesystem " +
      "path as before. " +
      "spice_simulate_op returns requested node voltages and optional " +
      "voltage-source branch currents (raw i(Vsource), positive into the " +
      "source positive terminal). spice_simulate_tran returns requested node " +
      "voltage and branch-current min/max/final summaries with timestamps. " +
      "spice_simulate_dc runs one bounded voltage-source sweep and returns " +
      "reduced summaries, never a raw transfer curve. " +
      "Both submitted and legacy-path netlists are limited to 1 MiB; each " +
      "observable kind is limited to 32 names. Transient wrdata is bounded " +
      "to 8 MiB and 50,000 samples before reduction. " +
      "Completed simulations publish a documentary receipt and bounded outcome " +
      "on the configured durable run volume; those provider records are not " +
      "Digital Thread evidence. An acknowledged dispatch without a terminal " +
      "publication is fail-closed and must not be rerun automatically. " +
      "The caller supplies the circuit definition only (no .control block). " +
      "The server validates the netlist for forbidden directives, writes the " +
      ".control block, runs ngspice, and returns raw scalar results. " +
      "No verdict on compliance — the oracle decides.",
    toolErrorMapper: mapSpiceToolError,
    logger: options.logger ?? ((message) => console.error(`[mcp-spice] ${message}`)),
  });

  app.registerTools(client.toMCPFormat(), handlers);
  const viewerRegistration = registerSpiceViewers(
    app,
    options.viewerFileSystem,
    options.viewerModuleUrl ?? import.meta.url,
  );
  return { app, viewerRegistration };
}

export interface CliArgs {
  port: number;
  hostname: string;
  stdio: boolean;
}

export function parseCli(args: string[]): CliArgs {
  let port = parseInt(Deno.env.get("MCP_PORT") ?? "", 10) || DEFAULT_PORT;
  let hostname = Deno.env.get("MCP_HOSTNAME") ?? DEFAULT_HOSTNAME;
  let stdio = false;
  let hasHttpCliOption = false;

  for (const arg of args) {
    if (arg === "--stdio") {
      stdio = true;
    } else if (arg.startsWith("--port=")) {
      hasHttpCliOption = true;
      const n = parseInt(arg.slice("--port=".length), 10);
      if (isNaN(n) || n < 1 || n > 65535) {
        throw new TypeError(
          `--port must be an integer between 1 and 65535, got: ${arg}`,
        );
      }
      port = n;
    } else if (arg.startsWith("--hostname=")) {
      hasHttpCliOption = true;
      hostname = arg.slice("--hostname=".length);
    } else {
      throw new TypeError(`Unknown argument: ${arg}`);
    }
  }

  if (stdio && hasHttpCliOption) {
    throw new TypeError("--stdio cannot be combined with --port or --hostname.");
  }

  return { port, hostname, stdio };
}

if (import.meta.main) {
  const cli = parseCli(Deno.args);
  const { app, viewerRegistration } = createSpiceServer();
  if (viewerRegistration.registered.length === 0) {
    console.error(
      "[mcp-spice] MCP Apps viewers are not built; run `deno task build:ui`.",
    );
  }
  if (cli.stdio) {
    await app.start();
  } else {
    await app.startHttp({
      port: cli.port,
      hostname: cli.hostname,
      corsOrigins: ["http://127.0.0.1", "http://localhost"],
      onListen: ({ hostname, port }) => {
        console.error(
          `[mcp-spice] Stateless MCP: http://${hostname}:${port}/mcp`,
        );
      },
    });
  }
}
