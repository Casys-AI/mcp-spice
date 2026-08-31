/**
 * Optional MCP Apps HTML resources. Text tool results remain complete when a
 * source checkout has not built the viewers yet.
 */

import type { McpApp, RegisterViewersSummary } from "@casys/mcp-server";
import { SPICE_VIEW_PREFIX, SPICE_VIEWERS } from "./ui/constants.ts";

export interface SpiceViewerFileSystem {
  exists(path: string): boolean;
  readFile(path: string): string | Promise<string>;
}

export function registerSpiceViewers(
  app: McpApp,
  fileSystem: SpiceViewerFileSystem = defaultViewerFileSystem,
  moduleUrl: string = import.meta.url,
): RegisterViewersSummary {
  return app.registerViewers({
    prefix: SPICE_VIEW_PREFIX,
    viewers: [...SPICE_VIEWERS],
    moduleUrl,
    exists: fileSystem.exists,
    readFile: fileSystem.readFile,
    humanName: spiceViewerName,
  });
}

export function createSpiceViewerFileSystem(
  fetchViewer: (url: string) => Promise<Response> = (url) => fetch(url),
): SpiceViewerFileSystem {
  return {
    exists(path) {
      if (isRemoteViewerUrl(path)) return true;
      try {
        return Deno.statSync(path).isFile;
      } catch (error) {
        if (
          error instanceof Deno.errors.NotFound ||
          error instanceof Deno.errors.PermissionDenied ||
          (error instanceof Error && error.name === "NotCapable")
        ) {
          return false;
        }
        throw error;
      }
    },
    async readFile(path) {
      if (!isRemoteViewerUrl(path)) return await Deno.readTextFile(path);
      let response: Response;
      try {
        response = await fetchViewer(path);
      } catch (error) {
        throw new Error(`Unable to fetch SPICE viewer from ${path}.`, {
          cause: error,
        });
      }
      if (!response.ok) {
        throw new Error(
          `Unable to fetch SPICE viewer from ${path}: HTTP ${response.status} ${response.statusText}.`,
        );
      }
      return await response.text();
    },
  };
}

const defaultViewerFileSystem = createSpiceViewerFileSystem();

function spiceViewerName(name: string): string {
  switch (name) {
    case "operating-point":
      return "SPICE Operating Point";
    case "dc-sweep":
      return "SPICE Reduced DC Sweep";
    case "transient-result":
      return "SPICE Reduced Transient Result";
    case "simulation-outcome":
      return "SPICE Simulation Outcome";
    case "simulation-receipt":
      return "SPICE Simulation Receipt";
    default:
      return name;
  }
}

function isRemoteViewerUrl(path: string): boolean {
  try {
    const protocol = new URL(path).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}
