/**
 * Documentary readback for durable provider simulation records.
 *
 * These records explain what this standalone provider persisted. They are not
 * Digital Thread product evidence, a requirement verdict, or an alternative to
 * the registered admitted-SPICE execution path.
 */

import {
  getSimulationDispatch,
  getSimulationReceipt,
  getSimulationResult,
} from "../api/simulation-receipts.ts";
import { getNetlistPath } from "../api/netlist-store.ts";
import { SpiceToolError } from "../api/tool-error.ts";
import type { SpiceTool } from "./types.ts";

const SHA256_DESCRIPTION = "64-character lowercase hexadecimal SHA-256 identity.";

function requireDigest(
  args: Record<string, unknown>,
  field: string,
  toolName: string,
): string {
  const value = args[field];
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new SpiceToolError(
      `invalid_${field}`,
      { toolName, [field]: value },
      `Pass ${field} as a ${SHA256_DESCRIPTION}`,
    );
  }
  return value;
}

const RECEIPT_GET_INPUT: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["receipt_sha256"],
  properties: {
    receipt_sha256: { type: "string", description: SHA256_DESCRIPTION },
  },
};

const RECEIPT_GET_OUTPUT: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["receipt_sha256", "receipt"],
  properties: {
    receipt_sha256: { type: "string" },
    receipt: { type: "object" },
  },
};

export const receiptGetTool: SpiceTool = {
  name: "spice_simulation_receipt_get",
  description: "Read one immutable documentary provider receipt by SHA-256. " +
    "The server rehashes the exact stored bytes and verifies the linked result. " +
    "This is not Digital Thread product evidence or a requirement verdict.",
  category: "artifact",
  inputSchema: RECEIPT_GET_INPUT,
  outputSchema: RECEIPT_GET_OUTPUT,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args) => {
    const receipt_sha256 = requireDigest(
      args,
      "receipt_sha256",
      "spice_simulation_receipt_get",
    );
    const receipt = await getSimulationReceipt(receipt_sha256);
    return {
      content: `[spice_simulation_receipt_get] receipt_sha256:${receipt_sha256}`,
      structuredContent: { receipt_sha256, receipt },
    };
  },
};

const RESULT_GET_INPUT: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["outcome_sha256"],
  properties: {
    outcome_sha256: { type: "string", description: SHA256_DESCRIPTION },
  },
};

const RESULT_GET_OUTPUT: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["outcome_sha256", "result"],
  properties: {
    outcome_sha256: { type: "string" },
    result: { type: "object" },
    input_artifact_source_path: {
      type: "string",
      description:
        "Reconstructed provider-local path for a durable simulation input. It is outside the exact outcome bytes.",
    },
  },
};

export const resultGetTool: SpiceTool = {
  name: "spice_simulation_result_get",
  description: "Read one immutable documentary provider outcome by SHA-256. " +
    "The server rehashes the exact stored canonical bytes before returning it. " +
    "It is documentary provider output, not Digital Thread evidence.",
  category: "artifact",
  inputSchema: RESULT_GET_INPUT,
  outputSchema: RESULT_GET_OUTPUT,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args) => {
    const outcome_sha256 = requireDigest(
      args,
      "outcome_sha256",
      "spice_simulation_result_get",
    );
    const result = await getSimulationResult(outcome_sha256);
    const inputArtifact = result["input_artifact"];
    const netlistSha256 = inputArtifact !== null && typeof inputArtifact === "object" &&
        !Array.isArray(inputArtifact)
      ? inputArtifact["sha256"]
      : undefined;
    const input_artifact_source_path = typeof netlistSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(netlistSha256)
      ? await getNetlistPath(netlistSha256, "spice_simulation_result_get")
      : undefined;
    return {
      content: `[spice_simulation_result_get] outcome_sha256:${outcome_sha256}`,
      structuredContent: {
        outcome_sha256,
        result,
        ...(input_artifact_source_path === undefined
          ? {}
          : { input_artifact_source_path }),
      },
    };
  },
};

const DISPATCH_GET_INPUT: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["request_sha256"],
  properties: {
    request_sha256: {
      type: "string",
      description: "Runtime-independent acknowledged request identity. " +
        SHA256_DESCRIPTION,
    },
  },
};

const DISPATCH_GET_OUTPUT: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["request_sha256", "dispatch_sha256", "dispatch"],
  properties: {
    request_sha256: { type: "string" },
    dispatch_sha256: {
      type: "string",
      description: "Exact complete dispatch-document integrity SHA-256.",
    },
    dispatch: { type: "object" },
    publication: { type: "object" },
  },
};

export const dispatchGetTool: SpiceTool = {
  name: "spice_simulation_dispatch_get",
  description:
    "Read a durable provider dispatch by acknowledged request SHA-256 for recovery. " +
    "An acknowledged dispatch with no publication is deliberately uncertain: " +
    "do not request an automatic rerun. This record is documentary only.",
  category: "artifact",
  inputSchema: DISPATCH_GET_INPUT,
  outputSchema: DISPATCH_GET_OUTPUT,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args) => {
    const request_sha256 = requireDigest(
      args,
      "request_sha256",
      "spice_simulation_dispatch_get",
    );
    const state = await getSimulationDispatch(request_sha256);
    return {
      content:
        `[spice_simulation_dispatch_get] request_sha256:${request_sha256} state:${
          state.publication ? "published" : "acknowledged"
        }`,
      structuredContent: {
        request_sha256,
        dispatch_sha256: state.dispatch.integrity_sha256,
        dispatch: state.dispatch,
        ...(state.publication === undefined ? {} : { publication: state.publication }),
      },
    };
  },
};
