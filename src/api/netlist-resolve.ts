/**
 * Resolve a simulation netlist from either a caller path (legacy) or a
 * content-addressed store reference produced by `ngspice_netlist_submit`.
 *
 * Exclusive sources: a non-empty `netlist_path` and a `netlist_uri` together
 * are refused. Omitting the path looks the declared SHA-256 up in the store.
 */

import { snapshotNetlistArtifact } from "./netlist-artifact.ts";
import type { NetlistSnapshot } from "./netlist-artifact.ts";
import { getNetlistPath, normalizeSha256, parseNetlistUri } from "./netlist-store.ts";
import { SpiceToolError } from "./tool-error.ts";

export async function resolveSimulationNetlist(
  toolName: string,
  args: Record<string, unknown>,
): Promise<NetlistSnapshot> {
  const rawSha = args["netlist_sha256"];
  if (typeof rawSha !== "string" || !rawSha.trim()) {
    throw new SpiceToolError(
      "invalid_netlist_sha256",
      { toolName, netlist_sha256: rawSha },
      "Pass a 64-character hexadecimal SHA-256 of the UTF-8 netlist bytes.",
    );
  }
  const netlistSha256 = normalizeSha256(rawSha, toolName);

  const netlistPath = args["netlist_path"];
  const netlistUri = args["netlist_uri"];

  if (netlistPath !== undefined && netlistPath !== null) {
    if (typeof netlistPath !== "string") {
      throw new SpiceToolError(
        "invalid_netlist_path",
        { toolName, netlist_path: netlistPath },
        "Pass a non-empty filesystem path, or omit netlist_path and use a submitted sha256.",
      );
    }
    if (!netlistPath.trim()) {
      throw new SpiceToolError(
        "invalid_netlist_path",
        { toolName, netlist_path: netlistPath },
        "Pass a non-empty filesystem path, or omit netlist_path and use a submitted sha256.",
      );
    }
  }

  if (netlistUri !== undefined && netlistUri !== null) {
    if (typeof netlistUri !== "string") {
      throw new SpiceToolError(
        "invalid_netlist_uri",
        { toolName, netlist_uri: netlistUri },
        "Pass the uri returned by ngspice_netlist_submit, or omit netlist_uri.",
      );
    }
  }

  const hasPath = typeof netlistPath === "string" && netlistPath.trim().length > 0;
  const hasUri = typeof netlistUri === "string" && netlistUri.trim().length > 0;

  if (hasPath && hasUri) {
    throw new SpiceToolError(
      "ambiguous_netlist_source",
      { toolName, netlist_path: netlistPath, netlist_uri: netlistUri },
      "Pass either netlist_path (legacy) or the content-addressed reference, not both.",
    );
  }

  if (hasPath) {
    return await snapshotNetlistArtifact(
      toolName,
      netlistPath as string,
      netlistSha256,
    );
  }

  if (hasUri) {
    const uriSha = parseNetlistUri(netlistUri as string, toolName);
    if (uriSha !== netlistSha256) {
      throw new SpiceToolError(
        "netlist_uri_sha256_mismatch",
        { toolName, uriSha, netlist_sha256: netlistSha256 },
        "Pass the sha256 and uri from the same ngspice_netlist_submit result.",
      );
    }
  }

  const storePath = await getNetlistPath(netlistSha256, toolName);
  return await snapshotNetlistArtifact(toolName, storePath, netlistSha256);
}
