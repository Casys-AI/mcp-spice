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
import { resolveNetlistStoreDir } from "../api/netlist-store.ts";
import { SpiceToolError } from "../api/tool-error.ts";
import { join } from "@std/path";
import { DC_OUTPUT_SCHEMA } from "./dc.ts";
import { OP_OUTPUT_SCHEMA } from "./op.ts";
import { TRAN_OUTPUT_SCHEMA } from "./tran.ts";
import type { SpiceTool } from "./types.ts";
import {
  SPICE_SIMULATION_OUTCOME_URI,
  SPICE_SIMULATION_RECEIPT_URI,
} from "../ui/constants.ts";

const SHA256_DESCRIPTION = "64-character lowercase hexadecimal SHA-256 identity.";
const SHA256_SCHEMA = {
  type: "string",
  pattern: "^[a-f0-9]{64}$",
  description: SHA256_DESCRIPTION,
};

const SELECTORS_SCHEMA = {
  type: "array",
  maxItems: 32,
  items: { type: "string" },
};

const NORMALIZED_REQUEST_SCHEMA: Record<string, unknown> = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["nodes", "branch_sources", "timeout_s"],
      properties: {
        nodes: SELECTORS_SCHEMA,
        branch_sources: SELECTORS_SCHEMA,
        timeout_s: { type: "number", minimum: 1, maximum: 300 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["tstep_s", "tstop_s", "nodes", "branch_sources", "timeout_s"],
      properties: {
        tstep_s: { type: "number", exclusiveMinimum: 0 },
        tstop_s: { type: "number", exclusiveMinimum: 0 },
        nodes: SELECTORS_SCHEMA,
        branch_sources: SELECTORS_SCHEMA,
        timeout_s: { type: "number", minimum: 1, maximum: 300 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "sweep_source",
        "start_v",
        "stop_v",
        "step_v",
        "nodes",
        "branch_sources",
        "timeout_s",
      ],
      properties: {
        sweep_source: { type: "string" },
        start_v: { type: "number" },
        stop_v: { type: "number" },
        step_v: { type: "number" },
        nodes: SELECTORS_SCHEMA,
        branch_sources: SELECTORS_SCHEMA,
        timeout_s: { type: "number", minimum: 1, maximum: 300 },
      },
    },
  ],
};

const RUNTIME_IDENTITY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "mcp_spice_version",
    "execution_budgets",
    "deno_version",
    "os",
    "arch",
    "ngspice_version",
    "ngspice_version_sha256",
  ],
  properties: {
    mcp_spice_version: { type: "string" },
    execution_budgets: { type: "string" },
    deno_version: { type: "string" },
    os: { type: "string" },
    arch: { type: "string" },
    ngspice_version: { type: "string" },
    ngspice_version_sha256: SHA256_SCHEMA,
  },
};

const RECEIPT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "type",
    "request_sha256",
    "dispatch_sha256",
    "analysis_kind",
    "netlist_sha256",
    "normalized_request",
    "runtime_identity",
    "outcome_sha256",
    "execution_state",
  ],
  properties: {
    type: { const: "spice-simulation-receipt/1.0" },
    request_sha256: SHA256_SCHEMA,
    dispatch_sha256: SHA256_SCHEMA,
    analysis_kind: { enum: ["op", "tran", "dc"] },
    netlist_sha256: SHA256_SCHEMA,
    normalized_request: NORMALIZED_REQUEST_SCHEMA,
    runtime_identity: RUNTIME_IDENTITY_SCHEMA,
    outcome_sha256: SHA256_SCHEMA,
    execution_state: { enum: ["succeeded", "failed"] },
  },
};

const DISPATCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "type",
    "request_sha256",
    "analysis_kind",
    "netlist_sha256",
    "normalized_request",
    "runtime_identity",
    "execution_state",
    "integrity_sha256",
  ],
  properties: {
    type: { const: "spice-simulation-dispatch/1.0" },
    request_sha256: SHA256_SCHEMA,
    analysis_kind: { enum: ["op", "tran", "dc"] },
    netlist_sha256: SHA256_SCHEMA,
    normalized_request: NORMALIZED_REQUEST_SCHEMA,
    runtime_identity: RUNTIME_IDENTITY_SCHEMA,
    execution_state: { const: "acknowledged" },
    integrity_sha256: SHA256_SCHEMA,
  },
};

const PUBLICATION_REFERENCE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "request_sha256",
    "dispatch_sha256",
    "receipt_sha256",
    "outcome_sha256",
    "execution_state",
  ],
  properties: {
    request_sha256: SHA256_SCHEMA,
    dispatch_sha256: SHA256_SCHEMA,
    receipt_sha256: SHA256_SCHEMA,
    outcome_sha256: SHA256_SCHEMA,
    execution_state: { enum: ["succeeded", "failed"] },
  },
};

const FAILURE_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["code", "context", "recovery"],
  properties: {
    code: { type: "string" },
    context: { type: "object" },
    recovery: { type: "string" },
  },
};

function persistedSuccessSchema(
  publicSchema: Record<string, unknown>,
): Record<string, unknown> {
  const publicProperties = publicSchema.properties as Record<string, unknown>;
  const properties = { ...publicProperties };
  delete properties.documentary_receipt;

  const publicArtifact = publicProperties.input_artifact as Record<string, unknown>;
  const artifactProperties = {
    ...(publicArtifact.properties as Record<string, unknown>),
  };
  delete artifactProperties.source_path;
  properties.input_artifact = {
    ...publicArtifact,
    required: ["sha256", "bytes"],
    properties: artifactProperties,
  };

  return {
    ...publicSchema,
    required: (publicSchema.required as string[]).filter((field) =>
      field !== "documentary_receipt"
    ),
    properties,
  };
}

const RESULT_SCHEMA: Record<string, unknown> = {
  oneOf: [
    persistedSuccessSchema(OP_OUTPUT_SCHEMA),
    persistedSuccessSchema(TRAN_OUTPUT_SCHEMA),
    persistedSuccessSchema(DC_OUTPUT_SCHEMA),
    FAILURE_RESULT_SCHEMA,
  ],
  description:
    "Exact canonical stored outcome: one bounded simulation result or one typed terminal failure envelope.",
};

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
    receipt_sha256: SHA256_SCHEMA,
  },
};

const RECEIPT_GET_OUTPUT: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["receipt_sha256", "receipt"],
  properties: {
    receipt_sha256: SHA256_SCHEMA,
    receipt: RECEIPT_SCHEMA,
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
  _meta: { ui: { resourceUri: SPICE_SIMULATION_RECEIPT_URI } },
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
    outcome_sha256: SHA256_SCHEMA,
  },
};

const RESULT_GET_OUTPUT: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["outcome_sha256", "result"],
  properties: {
    outcome_sha256: SHA256_SCHEMA,
    result: RESULT_SCHEMA,
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
  _meta: { ui: { resourceUri: SPICE_SIMULATION_OUTCOME_URI } },
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
      ? join(resolveNetlistStoreDir(), netlistSha256)
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
      ...SHA256_SCHEMA,
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
    request_sha256: SHA256_SCHEMA,
    dispatch_sha256: {
      ...SHA256_SCHEMA,
      description: "Exact complete dispatch-document integrity SHA-256.",
    },
    dispatch: DISPATCH_SCHEMA,
    publication: PUBLICATION_REFERENCE_SCHEMA,
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
