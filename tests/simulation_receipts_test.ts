/** Durable documentary simulation records: restart, torn publication, and corruption. */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { EXECUTION_BUDGETS_VERSION } from "../src/api/execution-budgets.ts";
import { sha256Hex } from "../src/api/netlist-artifact.ts";
import { configureNetlistStoreDir, putNetlistBytes } from "../src/api/netlist-store.ts";
import {
  beginSimulationDispatch,
  canonicalJsonBytes,
  captureRuntimeIdentity,
  configureReceiptStoreDir,
  getSimulationDispatch,
  getSimulationReceipt,
  getSimulationResult,
  MCP_SPICE_VERSION,
  publishSimulationOutcome,
} from "../src/api/simulation-receipts.ts";
import type { JsonRecord, RuntimeIdentity } from "../src/api/simulation-receipts.ts";
import { executeDocumentedSimulation } from "../src/api/documented-simulation.ts";
import { NgspiceNotFoundError, SpiceError } from "../src/api/ngspice.ts";
import { SpiceToolError } from "../src/api/tool-error.ts";
import { allTools } from "../src/tools/mod.ts";

const NETLIST = "Voltage divider\nVin in 0 DC 3\nR1 in out 1000\nR2 out 0 2000\n.end\n";

async function withStores<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "spice-durable-receipts-" });
  configureNetlistStoreDir(join(root, "inputs"));
  configureReceiptStoreDir(join(root, "receipts"));
  try {
    return await fn(root);
  } finally {
    configureReceiptStoreDir(undefined);
    configureNetlistStoreDir(undefined);
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

async function runtimeIdentity(): Promise<RuntimeIdentity> {
  const ngspiceVersion = "ngspice test runtime 44.2";
  return {
    mcp_spice_version: MCP_SPICE_VERSION,
    execution_budgets: EXECUTION_BUDGETS_VERSION,
    deno_version: "2.9.6-test",
    os: "test",
    arch: "test",
    ngspice_version: ngspiceVersion,
    ngspice_version_sha256: await sha256Hex(new TextEncoder().encode(ngspiceVersion)),
  };
}

async function start(): Promise<{
  netlist_sha256: string;
  normalized_request: JsonRecord;
  runtime_identity: RuntimeIdentity;
}> {
  const netlist = await putNetlistBytes(
    new TextEncoder().encode(NETLIST),
    "simulation_receipts_test",
  );
  return {
    netlist_sha256: netlist.sha256,
    normalized_request: {
      nodes: ["out"],
      branch_sources: [],
      timeout_s: 30,
    },
    runtime_identity: await runtimeIdentity(),
  };
}

function successResult(netlistSha256: string): JsonRecord {
  return {
    node_voltages: { out: 2 },
    branch_currents_a: {},
    measurements: { out: { value: 2 } },
    not_checked: ["documentary test only"],
    input_artifact: { sha256: netlistSha256, bytes: NETLIST.length },
  };
}

function tranSuccessResult(netlistSha256: string): JsonRecord {
  return {
    node_stats: {
      out: {
        min_v: 1,
        max_v: 2,
        final_v: 2,
        min_at_s: 0,
        max_at_s: 0.1,
        final_at_s: 0.1,
      },
    },
    branch_current_stats_a: {},
    measurements: { out: { value: 2 } },
    simulation: { n_points: 2, tstop_s: 0.1 },
    not_checked: ["documentary test only"],
    input_artifact: { sha256: netlistSha256, bytes: NETLIST.length },
  };
}

Deno.test("durable receipt and result survive a fresh store configuration", async () => {
  await withStores(async (root) => {
    const input = await start();
    const first = await beginSimulationDispatch({ analysis_kind: "op", ...input });
    assertEquals(first.status, "started");
    const result = successResult(input.netlist_sha256);
    const published = await publishSimulationOutcome({
      request_sha256: first.request_sha256,
      dispatch: first.dispatch,
      execution_state: "succeeded",
      result,
    });

    const receipt = await getSimulationReceipt(published.receipt_sha256);
    assertEquals(receipt.netlist_sha256, input.netlist_sha256);
    assertEquals(receipt.normalized_request, input.normalized_request);
    assertEquals(receipt.runtime_identity, input.runtime_identity);
    assertEquals(receipt.outcome_sha256, published.outcome_sha256);
    assertEquals(await getSimulationResult(published.outcome_sha256), result);

    // Forget all in-memory configuration and reopen the same mounted root.
    configureReceiptStoreDir(undefined);
    configureNetlistStoreDir(undefined);
    configureNetlistStoreDir(join(root, "inputs"));
    configureReceiptStoreDir(join(root, "receipts"));
    const afterRestart = await beginSimulationDispatch({
      analysis_kind: "op",
      ...input,
    });
    assertEquals(afterRestart.status, "published");
    assertEquals(afterRestart.request_sha256, first.request_sha256);
    assertEquals(afterRestart.receipt_sha256, published.receipt_sha256);
    assertEquals(afterRestart.outcome_sha256, published.outcome_sha256);

    const receiptTool = allTools.find((tool) =>
      tool.name === "spice_simulation_receipt_get"
    );
    const resultTool = allTools.find((tool) =>
      tool.name === "spice_simulation_result_get"
    );
    assert(receiptTool && resultTool, "documentary readback tools must be registered");
    const receiptReadback = await receiptTool.handler({
      receipt_sha256: published.receipt_sha256,
    }) as { structuredContent: JsonRecord };
    const resultReadback = await resultTool.handler({
      outcome_sha256: published.outcome_sha256,
    }) as { structuredContent: JsonRecord };
    assertEquals(
      receiptReadback.structuredContent["receipt_sha256"],
      published.receipt_sha256,
    );
    assertEquals(resultReadback.structuredContent["result"], result);
    assertEquals(
      resultReadback.structuredContent["input_artifact_source_path"],
      join(root, "inputs", input.netlist_sha256),
    );
  });
});

Deno.test("acknowledged partial publication remains uncertain and is never rerun", async () => {
  await withStores(async (root) => {
    const input = await start();
    const first = await beginSimulationDispatch({ analysis_kind: "op", ...input });
    assertEquals(first.status, "started");

    // Simulate a process crash after result staging but before receipt/publication.
    const tornResult = successResult(input.netlist_sha256);
    const bytes = canonicalJsonBytes(tornResult);
    const outcomeSha256 = await sha256Hex(bytes);
    const resultsDir = join(root, "receipts", "results");
    await Deno.mkdir(resultsDir, { recursive: true });
    await Deno.writeFile(join(resultsDir, outcomeSha256), bytes, { mode: 0o400 });

    configureReceiptStoreDir(undefined);
    configureNetlistStoreDir(undefined);
    configureNetlistStoreDir(join(root, "inputs"));
    configureReceiptStoreDir(join(root, "receipts"));
    const error = await assertRejects(
      () => beginSimulationDispatch({ analysis_kind: "op", ...input }),
      SpiceToolError,
    );
    assertEquals(error.code, "simulation_dispatch_uncertain");
    assertEquals(error.context.request_sha256, first.request_sha256);
    const dispatch = await getSimulationDispatch(first.request_sha256);
    assertEquals(dispatch.dispatch.execution_state, "acknowledged");
    assertEquals(dispatch.publication, undefined);
  });
});

Deno.test("receipt and result readback fail closed on exact-byte corruption", async () => {
  await withStores(async (root) => {
    const input = await start();
    const started = await beginSimulationDispatch({ analysis_kind: "op", ...input });
    const published = await publishSimulationOutcome({
      request_sha256: started.request_sha256,
      dispatch: started.dispatch,
      execution_state: "succeeded",
      result: successResult(input.netlist_sha256),
    });

    const resultPath = join(root, "receipts", "results", published.outcome_sha256);
    await Deno.chmod(resultPath, 0o600);
    await Deno.writeTextFile(resultPath, "{}");
    const resultError = await assertRejects(
      () => getSimulationResult(published.outcome_sha256),
      SpiceToolError,
    );
    assertEquals(resultError.code, "simulation_result_corrupt");

    const receiptPath = join(root, "receipts", "receipts", published.receipt_sha256);
    await Deno.chmod(receiptPath, 0o600);
    await Deno.writeTextFile(receiptPath, "{}");
    const receiptError = await assertRejects(
      () => getSimulationReceipt(published.receipt_sha256),
      SpiceToolError,
    );
    assertEquals(receiptError.code, "simulation_receipt_corrupt");
  });
});

Deno.test("direct result readback refuses symlink, FIFO, and oversized objects", async () => {
  const cases = [
    {
      name: "symlink",
      reason: "not_regular_file",
      prepare: async (root: string, path: string) => {
        const outside = join(root, "outside-result");
        await Deno.writeTextFile(outside, "not-a-result");
        await Deno.symlink(outside, path);
      },
    },
    {
      name: "FIFO",
      reason: "not_regular_file",
      prepare: async (_root: string, path: string) => {
        const output = await new Deno.Command("mkfifo", { args: [path] }).output();
        assert(output.success, "mkfifo must create the test result object");
      },
    },
    {
      name: "oversized regular file",
      reason: "too_large",
      prepare: async (_root: string, path: string) => {
        await Deno.writeFile(path, new Uint8Array());
        await Deno.truncate(path, 2 * 1024 * 1024);
      },
    },
  ];
  for (const fixture of cases) {
    await withStores(async (root) => {
      const input = await start();
      const started = await beginSimulationDispatch({ analysis_kind: "op", ...input });
      const published = await publishSimulationOutcome({
        request_sha256: started.request_sha256,
        dispatch: started.dispatch,
        execution_state: "succeeded",
        result: successResult(input.netlist_sha256),
      });
      const resultPath = join(root, "receipts", "results", published.outcome_sha256);
      await Deno.remove(resultPath);
      await fixture.prepare(root, resultPath);

      const error = await assertRejects(
        () => getSimulationResult(published.outcome_sha256),
        SpiceToolError,
      );
      assertEquals(error.code, "simulation_result_corrupt", fixture.name);
      assertEquals(error.context.reason, fixture.reason, fixture.name);
    });
  }
});

Deno.test("outcome collision readback refuses unsafe existing durable objects", async () => {
  const cases = [
    {
      name: "symlink",
      expectedCode: "simulation_result_corrupt",
      prepare: async (root: string, path: string) => {
        const outside = join(root, "outside-result");
        await Deno.writeTextFile(outside, "not-a-result");
        await Deno.symlink(outside, path);
      },
    },
    {
      name: "FIFO",
      expectedCode: "simulation_result_corrupt",
      prepare: async (_root: string, path: string) => {
        const output = await new Deno.Command("mkfifo", { args: [path] }).output();
        assert(output.success, "mkfifo must create the test collision target");
      },
    },
    {
      name: "oversized regular file",
      expectedCode: "simulation_immutable_record_conflict",
      prepare: async (_root: string, path: string) => {
        await Deno.writeFile(path, new Uint8Array());
        await Deno.truncate(path, 8 * 1024 * 1024);
      },
    },
  ];
  for (const fixture of cases) {
    await withStores(async (root) => {
      const input = await start();
      const started = await beginSimulationDispatch({ analysis_kind: "op", ...input });
      const result = successResult(input.netlist_sha256);
      const outcomeSha256 = await sha256Hex(canonicalJsonBytes(result));
      const resultsDir = join(root, "receipts", "results");
      await Deno.mkdir(resultsDir, { recursive: true });
      await fixture.prepare(root, join(resultsDir, outcomeSha256));

      const error = await assertRejects(
        () =>
          publishSimulationOutcome({
            request_sha256: started.request_sha256,
            dispatch: started.dispatch,
            execution_state: "succeeded",
            result,
          }),
        SpiceToolError,
      );
      assertEquals(error.code, fixture.expectedCode, fixture.name);
    });
  }
});

Deno.test("dispatch runtime and terminal publication corruption fail closed", async () => {
  await withStores(async (root) => {
    const input = await start();
    const started = await beginSimulationDispatch({ analysis_kind: "op", ...input });
    await publishSimulationOutcome({
      request_sha256: started.request_sha256,
      dispatch: started.dispatch,
      execution_state: "succeeded",
      result: successResult(input.netlist_sha256),
    });

    const publicationPath = join(
      root,
      "receipts",
      "publications",
      started.request_sha256,
    );
    await Deno.chmod(publicationPath, 0o600);
    const publicationText = await Deno.readTextFile(publicationPath);
    assert(publicationText.includes('"execution_state":"succeeded"'));
    await Deno.writeTextFile(
      publicationPath,
      publicationText.replace(
        '"execution_state":"succeeded"',
        '"execution_state":"failed"',
      ),
    );
    const publicationError = await assertRejects(
      () => getSimulationDispatch(started.request_sha256),
      SpiceToolError,
    );
    assertEquals(publicationError.code, "simulation_publication_corrupt");

    const dispatchPath = join(
      root,
      "receipts",
      "dispatches",
      started.request_sha256,
    );
    await Deno.chmod(dispatchPath, 0o600);
    const dispatchText = await Deno.readTextFile(dispatchPath);
    assert(dispatchText.includes("ngspice test runtime 44.2"));
    await Deno.writeTextFile(
      dispatchPath,
      dispatchText.replace("ngspice test runtime 44.2", "ngspice test runtime 54.2"),
    );
    const dispatchError = await assertRejects(
      () => getSimulationDispatch(started.request_sha256),
      SpiceToolError,
    );
    assertEquals(dispatchError.code, "simulation_dispatch_corrupt");
  });
});

Deno.test("readback refuses a documentary symlink outside the durable root", async () => {
  await withStores(async (root) => {
    const input = await start();
    const started = await beginSimulationDispatch({ analysis_kind: "op", ...input });
    const dispatchPath = join(
      root,
      "receipts",
      "dispatches",
      started.request_sha256,
    );
    const outside = join(root, "outside-dispatch");
    await Deno.writeTextFile(outside, await Deno.readTextFile(dispatchPath));
    await Deno.remove(dispatchPath);
    await Deno.symlink(outside, dispatchPath);
    const error = await assertRejects(
      () => getSimulationDispatch(started.request_sha256),
      SpiceToolError,
    );
    assertEquals(error.code, "simulation_dispatch_corrupt");
  });
});

Deno.test("documentary getters reject namespace-parent symlinks outside the store", async () => {
  await withStores(async (root) => {
    const input = await start();
    const started = await beginSimulationDispatch({ analysis_kind: "op", ...input });
    const dispatches = join(root, "receipts", "dispatches");
    await Deno.rename(dispatches, join(root, "outside-dispatches"));
    await Deno.symlink(join(root, "outside-dispatches"), dispatches);
    const error = await assertRejects(
      () => getSimulationDispatch(started.request_sha256),
      SpiceToolError,
    );
    assertEquals(error.code, "simulation_dispatch_corrupt");
    assertEquals(error.context.reason, "unsafe_parent");
  });

  await withStores(async (root) => {
    const input = await start();
    const started = await beginSimulationDispatch({ analysis_kind: "op", ...input });
    const published = await publishSimulationOutcome({
      request_sha256: started.request_sha256,
      dispatch: started.dispatch,
      execution_state: "succeeded",
      result: successResult(input.netlist_sha256),
    });
    const results = join(root, "receipts", "results");
    await Deno.rename(results, join(root, "outside-results"));
    await Deno.symlink(join(root, "outside-results"), results);
    const error = await assertRejects(
      () => getSimulationResult(published.outcome_sha256),
      SpiceToolError,
    );
    assertEquals(error.code, "simulation_result_corrupt");
    assertEquals(error.context.reason, "unsafe_parent");
  });

  await withStores(async (root) => {
    const input = await start();
    const started = await beginSimulationDispatch({ analysis_kind: "op", ...input });
    const published = await publishSimulationOutcome({
      request_sha256: started.request_sha256,
      dispatch: started.dispatch,
      execution_state: "succeeded",
      result: successResult(input.netlist_sha256),
    });
    const receipts = join(root, "receipts", "receipts");
    await Deno.rename(receipts, join(root, "outside-receipts"));
    await Deno.symlink(join(root, "outside-receipts"), receipts);
    const error = await assertRejects(
      () => getSimulationReceipt(published.receipt_sha256),
      SpiceToolError,
    );
    assertEquals(error.code, "simulation_receipt_corrupt");
    assertEquals(error.context.reason, "unsafe_parent");
  });
});

Deno.test("durable outcomes are a closed union bound to their dispatch", async () => {
  await withStores(async (root) => {
    const input = await start();
    const invalidOutcomes: Array<{
      name: string;
      execution_state: "succeeded" | "failed";
      result: JsonRecord;
      reason: string;
    }> = [
      {
        name: "succeeded result with error fields",
        execution_state: "succeeded",
        result: { ...successResult(input.netlist_sha256), code: "ngspice_timeout" },
        reason: "failure_keys_invalid",
      },
      {
        name: "succeeded result with a different analysis kind",
        execution_state: "succeeded",
        result: tranSuccessResult(input.netlist_sha256),
        reason: "analysis_kind_mismatch",
      },
      {
        name: "succeeded result with a different input artifact",
        execution_state: "succeeded",
        result: {
          ...successResult(input.netlist_sha256),
          input_artifact: { sha256: "a".repeat(64), bytes: NETLIST.length },
        },
        reason: "input_artifact_netlist_sha256_mismatch",
      },
      {
        name: "succeeded result with a different input artifact byte length",
        execution_state: "succeeded",
        result: {
          ...successResult(input.netlist_sha256),
          input_artifact: {
            sha256: input.netlist_sha256,
            bytes: NETLIST.length + 1,
          },
        },
        reason: "input_artifact_netlist_bytes_mismatch",
      },
      {
        name: "succeeded result with a negative input artifact byte length",
        execution_state: "succeeded",
        result: {
          ...successResult(input.netlist_sha256),
          input_artifact: { sha256: input.netlist_sha256, bytes: -1 },
        },
        reason: "input_artifact.bytes_invalid",
      },
      {
        name: "succeeded result with a fractional input artifact byte length",
        execution_state: "succeeded",
        result: {
          ...successResult(input.netlist_sha256),
          input_artifact: { sha256: input.netlist_sha256, bytes: NETLIST.length + 0.5 },
        },
        reason: "input_artifact.bytes_invalid",
      },
      {
        name: "failed result with a success shape",
        execution_state: "failed",
        result: successResult(input.netlist_sha256),
        reason: "failed_result_not_error_envelope",
      },
    ];

    for (const [index, fixture] of invalidOutcomes.entries()) {
      const started = await beginSimulationDispatch({
        analysis_kind: "op",
        ...input,
        normalized_request: { ...input.normalized_request, timeout_s: 30 + index },
      });
      const error = await assertRejects(
        () =>
          publishSimulationOutcome({
            request_sha256: started.request_sha256,
            dispatch: started.dispatch,
            execution_state: fixture.execution_state,
            result: fixture.result,
          }),
        SpiceToolError,
      );
      assertEquals(error.code, "simulation_outcome_invalid", fixture.name);
      assertEquals(error.context.reason, fixture.reason, fixture.name);
    }

    const malformed = {
      ...successResult(input.netlist_sha256),
      code: "ngspice_timeout",
    };
    const bytes = canonicalJsonBytes(malformed);
    const outcomeSha256 = await sha256Hex(bytes);
    const results = join(root, "receipts", "results");
    await Deno.mkdir(results, { recursive: true });
    await Deno.writeFile(join(results, outcomeSha256), bytes, { mode: 0o400 });
    const error = await assertRejects(
      () => getSimulationResult(outcomeSha256),
      SpiceToolError,
    );
    assertEquals(error.code, "simulation_result_corrupt");
    assertEquals(error.context.reason, "outcome_failure_keys_invalid");

    for (const artifactBytes of [-1, NETLIST.length + 0.5]) {
      const malformedArtifact = {
        ...successResult(input.netlist_sha256),
        input_artifact: {
          sha256: input.netlist_sha256,
          bytes: artifactBytes,
        },
      };
      const malformedArtifactBytes = canonicalJsonBytes(malformedArtifact);
      const malformedArtifactSha256 = await sha256Hex(malformedArtifactBytes);
      await Deno.writeFile(
        join(results, malformedArtifactSha256),
        malformedArtifactBytes,
        { mode: 0o400 },
      );
      const artifactError = await assertRejects(
        () => getSimulationResult(malformedArtifactSha256),
        SpiceToolError,
      );
      assertEquals(artifactError.code, "simulation_result_corrupt");
      assertEquals(
        artifactError.context.reason,
        "outcome_input_artifact.bytes_invalid",
      );
    }

    const started = await beginSimulationDispatch({
      analysis_kind: "op",
      ...input,
      normalized_request: { ...input.normalized_request, timeout_s: 99 },
    });
    const published = await publishSimulationOutcome({
      request_sha256: started.request_sha256,
      dispatch: started.dispatch,
      execution_state: "succeeded",
      result: successResult(input.netlist_sha256),
    });
    const originalReceipt = await getSimulationReceipt(published.receipt_sha256);
    const forgedOutcomes: Array<{
      name: string;
      result: JsonRecord;
      reason: string;
    }> = [
      {
        name: "different analysis kind",
        result: tranSuccessResult(input.netlist_sha256),
        reason: "outcome_analysis_kind_mismatch",
      },
      {
        name: "failed result for a succeeded receipt",
        result: {
          code: "ngspice_timeout",
          context: { timeoutMs: 30_000 },
          recovery: "Inspect the circuit before submitting a distinct request.",
        },
        reason: "outcome_succeeded_result_not_persisted_success",
      },
      {
        name: "different input artifact",
        result: {
          ...successResult(input.netlist_sha256),
          input_artifact: { sha256: "a".repeat(64), bytes: NETLIST.length },
        },
        reason: "outcome_input_artifact_netlist_sha256_mismatch",
      },
      {
        name: "different input artifact byte length",
        result: {
          ...successResult(input.netlist_sha256),
          input_artifact: {
            sha256: input.netlist_sha256,
            bytes: NETLIST.length + 1,
          },
        },
        reason: "outcome_input_artifact_netlist_bytes_mismatch",
      },
    ];
    for (const fixture of forgedOutcomes) {
      const forgedOutcomeBytes = canonicalJsonBytes(fixture.result);
      const forgedOutcomeSha256 = await sha256Hex(forgedOutcomeBytes);
      await Deno.writeFile(join(results, forgedOutcomeSha256), forgedOutcomeBytes, {
        mode: 0o400,
      });
      const forgedReceiptBytes = canonicalJsonBytes({
        ...originalReceipt,
        outcome_sha256: forgedOutcomeSha256,
      });
      const forgedReceiptSha256 = await sha256Hex(forgedReceiptBytes);
      await Deno.writeFile(
        join(root, "receipts", "receipts", forgedReceiptSha256),
        forgedReceiptBytes,
        { mode: 0o400 },
      );
      const receiptError = await assertRejects(
        () => getSimulationReceipt(forgedReceiptSha256),
        SpiceToolError,
      );
      assertEquals(receiptError.code, "simulation_receipt_corrupt", fixture.name);
      assertEquals(receiptError.context.reason, fixture.reason, fixture.name);
    }
  });
});

Deno.test("receipt readback refuses unsafe netlist CAS objects", async () => {
  const cases = [
    {
      name: "symlink",
      reason: "not_regular_file",
      prepare: async (root: string, path: string) => {
        const outside = join(root, "outside-netlist");
        await Deno.writeTextFile(outside, NETLIST);
        await Deno.symlink(outside, path);
      },
    },
    {
      name: "FIFO",
      reason: "not_regular_file",
      prepare: async (_root: string, path: string) => {
        const output = await new Deno.Command("mkfifo", { args: [path] }).output();
        assert(output.success, "mkfifo must create the test netlist object");
      },
    },
    {
      name: "oversized regular file",
      reason: "too_large",
      prepare: async (_root: string, path: string) => {
        await Deno.writeFile(path, new Uint8Array());
        await Deno.truncate(path, 2 * 1024 * 1024);
      },
    },
  ];
  for (const fixture of cases) {
    await withStores(async (root) => {
      const input = await start();
      const started = await beginSimulationDispatch({ analysis_kind: "op", ...input });
      const published = await publishSimulationOutcome({
        request_sha256: started.request_sha256,
        dispatch: started.dispatch,
        execution_state: "succeeded",
        result: successResult(input.netlist_sha256),
      });
      const netlistPath = join(root, "inputs", input.netlist_sha256);
      await Deno.remove(netlistPath);
      await fixture.prepare(root, netlistPath);

      const error = await assertRejects(
        () => getSimulationReceipt(published.receipt_sha256),
        SpiceToolError,
      );
      assertEquals(error.code, "simulation_netlist_corrupt", fixture.name);
      assertEquals(error.context.reason, fixture.reason, fixture.name);
    });
  }
});

Deno.test("receipt readback verifies the runtime-linked dispatch chain", async () => {
  await withStores(async (root) => {
    const input = await start();
    const started = await beginSimulationDispatch({ analysis_kind: "op", ...input });
    const published = await publishSimulationOutcome({
      request_sha256: started.request_sha256,
      dispatch: started.dispatch,
      execution_state: "succeeded",
      result: successResult(input.netlist_sha256),
    });
    const receipt = await getSimulationReceipt(published.receipt_sha256);
    const ngspice_version = "ngspice forged runtime 99.0";
    const forged = {
      ...receipt,
      runtime_identity: {
        ...receipt.runtime_identity,
        ngspice_version,
        ngspice_version_sha256: await sha256Hex(
          new TextEncoder().encode(ngspice_version),
        ),
      },
    };
    const bytes = canonicalJsonBytes(forged);
    const forgedSha256 = await sha256Hex(bytes);
    await Deno.writeFile(
      join(root, "receipts", "receipts", forgedSha256),
      bytes,
      { mode: 0o400 },
    );
    const error = await assertRejects(
      () => getSimulationReceipt(forgedSha256),
      SpiceToolError,
    );
    assertEquals(error.code, "simulation_receipt_corrupt");
  });
});

Deno.test("concurrent dispatch writers produce one acknowledgement and no automatic second run", async () => {
  await withStores(async () => {
    const input = await start();
    const [left, right] = await Promise.allSettled([
      beginSimulationDispatch({ analysis_kind: "op", ...input }),
      beginSimulationDispatch({ analysis_kind: "op", ...input }),
    ]);
    const outcomes = [left, right];
    const started = outcomes.filter((outcome) =>
      outcome.status === "fulfilled" && outcome.value.status === "started"
    );
    assertEquals(started.length, 1);
    const uncertain = outcomes.find((outcome) => outcome.status === "rejected");
    assert(uncertain && uncertain.status === "rejected");
    assert(uncertain.reason instanceof SpiceToolError);
    assertEquals(uncertain.reason.code, "simulation_dispatch_uncertain");
  });
});

Deno.test("a terminal typed failure is durable, while a pre-dispatch torn temporary is retryable", async () => {
  await withStores(async (root) => {
    const input = await start();
    const dispatchDir = join(root, "receipts", "dispatches");
    await Deno.mkdir(dispatchDir, { recursive: true });
    await Deno.writeTextFile(join(dispatchDir, ".tmp-crashed-before-ack"), "partial");
    const started = await beginSimulationDispatch({ analysis_kind: "op", ...input });
    assertEquals(started.status, "started");
    const published = await publishSimulationOutcome({
      request_sha256: started.request_sha256,
      dispatch: started.dispatch,
      execution_state: "failed",
      result: {
        code: "ngspice_timeout",
        context: { timeoutMs: 30_000 },
        recovery: "Inspect the circuit before submitting a distinct request.",
      },
    });

    const replay = await beginSimulationDispatch({ analysis_kind: "op", ...input });
    assertEquals(replay.status, "published");
    assertEquals(replay.execution_state, "failed");
    assertEquals(replay.receipt_sha256, published.receipt_sha256);
  });
});

Deno.test("a changed runtime cannot unblock an acknowledged request", async () => {
  await withStores(async () => {
    const input = await start();
    const first = await beginSimulationDispatch({ analysis_kind: "op", ...input });
    const ngspice_version = "ngspice test runtime 45.0";
    const runtime_identity: RuntimeIdentity = {
      ...input.runtime_identity,
      ngspice_version,
      ngspice_version_sha256: await sha256Hex(
        new TextEncoder().encode(ngspice_version),
      ),
    };
    const error = await assertRejects(
      () =>
        beginSimulationDispatch({
          analysis_kind: "op",
          netlist_sha256: input.netlist_sha256,
          normalized_request: input.normalized_request,
          runtime_identity,
        }),
      SpiceToolError,
    );
    assertEquals(error.code, "simulation_dispatch_uncertain");
    assertEquals(error.context.request_sha256, first.request_sha256);
    assertEquals(error.context.dispatch_sha256, first.dispatch_sha256);
  });
});

Deno.test("runtime identity capture kills an ngspice version process at its fixed deadline", async () => {
  const binDir = await Deno.makeTempDir({ prefix: "spice-fake-ngspice-" });
  const executable = join(binDir, "ngspice");
  await Deno.writeTextFile(
    executable,
    "#!/bin/sh\nwhile :; do :; done\n",
  );
  await Deno.chmod(executable, 0o755);
  const priorPath = Deno.env.get("PATH");
  Deno.env.set("PATH", `${binDir}:${priorPath ?? ""}`);
  try {
    const startedAt = Date.now();
    const error = await assertRejects(
      () => captureRuntimeIdentity(),
      SpiceToolError,
    );
    assertEquals(error.code, "ngspice_runtime_identity_unavailable");
    assertEquals(error.context.reason, "timeout");
    assert(
      Date.now() - startedAt < 3_000,
      "version capture must return shortly after its fixed deadline",
    );
  } finally {
    if (priorPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", priorPath);
    await Deno.remove(binDir, { recursive: true });
  }
});

Deno.test("runtime identity hashes its normalized persisted banner", async () => {
  const binDir = await Deno.makeTempDir({ prefix: "spice-fake-ngspice-" });
  const executable = join(binDir, "ngspice");
  await Deno.writeTextFile(
    executable,
    "#!/bin/sh\nprintf '  ngspice test runtime 44.2  \\n\\n'\n",
  );
  await Deno.chmod(executable, 0o755);
  const priorPath = Deno.env.get("PATH");
  Deno.env.set("PATH", `${binDir}:${priorPath ?? ""}`);
  try {
    const identity = await captureRuntimeIdentity();
    assertEquals(identity.ngspice_version, "ngspice test runtime 44.2");
    assertEquals(
      identity.ngspice_version_sha256,
      await sha256Hex(new TextEncoder().encode(identity.ngspice_version)),
    );
  } finally {
    if (priorPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", priorPath);
    await Deno.remove(binDir, { recursive: true });
  }
});

Deno.test("in-process duplicate execution is single-flight rather than a second dispatch", async () => {
  await withStores(async () => {
    const binDir = await Deno.makeTempDir({ prefix: "spice-fake-ngspice-" });
    const executable = join(binDir, "ngspice");
    await Deno.writeTextFile(
      executable,
      "#!/bin/sh\nprintf 'ngspice test runtime 44.2\\n'\n",
    );
    await Deno.chmod(executable, 0o755);
    const priorPath = Deno.env.get("PATH");
    Deno.env.set("PATH", `${binDir}:${priorPath ?? ""}`);
    try {
      const input = await start();
      let executions = 0;
      const run = () =>
        executeDocumentedSimulation({
          analysis_kind: "op",
          netlist_sha256: input.netlist_sha256,
          normalized_request: input.normalized_request,
          execute: async () => {
            executions += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return successResult(input.netlist_sha256);
          },
        });
      const [left, right] = await Promise.all([run(), run()]);
      assertEquals(executions, 1);
      assertEquals(left.result, successResult(input.netlist_sha256));
      assertEquals(right.result, successResult(input.netlist_sha256));
      assertEquals(
        left.documentary_receipt.receipt_sha256,
        right.documentary_receipt.receipt_sha256,
      );
    } finally {
      if (priorPath === undefined) Deno.env.delete("PATH");
      else Deno.env.set("PATH", priorPath);
      await Deno.remove(binDir, { recursive: true });
    }
  });
});

Deno.test("an ACK-only R1 dispatch after an R2 restart executes zero provider calls", async () => {
  await withStores(async (root) => {
    const binDir = await Deno.makeTempDir({ prefix: "spice-fake-ngspice-" });
    const executable = join(binDir, "ngspice");
    await Deno.writeTextFile(
      executable,
      "#!/bin/sh\nprintf 'ngspice test runtime 44.2\\n'\n",
    );
    await Deno.chmod(executable, 0o755);
    const priorPath = Deno.env.get("PATH");
    Deno.env.set("PATH", `${binDir}:${priorPath ?? ""}`);
    try {
      const input = await start();
      const runtime_identity = await captureRuntimeIdentity();
      const acknowledged = await beginSimulationDispatch({
        analysis_kind: "op",
        netlist_sha256: input.netlist_sha256,
        normalized_request: input.normalized_request,
        runtime_identity,
      });
      assertEquals(acknowledged.status, "started");
      await Deno.writeTextFile(
        executable,
        "#!/bin/sh\nprintf 'ngspice test runtime 45.0\\n'\n",
      );
      await Deno.chmod(executable, 0o755);

      // Clear process-local configuration to model a new process reopening the
      // same mounted durable root; no in-flight state can suppress this test.
      configureReceiptStoreDir(undefined);
      configureNetlistStoreDir(undefined);
      configureNetlistStoreDir(join(root, "inputs"));
      configureReceiptStoreDir(join(root, "receipts"));
      let executions = 0;
      const error = await assertRejects(
        () =>
          executeDocumentedSimulation({
            analysis_kind: "op",
            netlist_sha256: input.netlist_sha256,
            normalized_request: input.normalized_request,
            execute: () => {
              executions += 1;
              return Promise.resolve({ value: 2 });
            },
          }),
        SpiceToolError,
      );
      assertEquals(error.code, "simulation_dispatch_uncertain");
      assertEquals(error.context.request_sha256, acknowledged.request_sha256);
      assertEquals(error.context.dispatch_sha256, acknowledged.dispatch_sha256);
      assertEquals(executions, 0);
    } finally {
      if (priorPath === undefined) Deno.env.delete("PATH");
      else Deno.env.set("PATH", priorPath);
      await Deno.remove(binDir, { recursive: true });
    }
  });
});

Deno.test("terminal engine failures preserve SpiceError and receipt identities on replay", async () => {
  await withStores(async () => {
    const binDir = await Deno.makeTempDir({ prefix: "spice-fake-ngspice-" });
    const executable = join(binDir, "ngspice");
    await Deno.writeTextFile(
      executable,
      "#!/bin/sh\nprintf 'ngspice test runtime 44.2\\n'\n",
    );
    await Deno.chmod(executable, 0o755);
    const priorPath = Deno.env.get("PATH");
    Deno.env.set("PATH", `${binDir}:${priorPath ?? ""}`);
    try {
      const input = await start();
      let executions = 0;
      const run = () =>
        executeDocumentedSimulation({
          analysis_kind: "op",
          netlist_sha256: input.netlist_sha256,
          normalized_request: input.normalized_request,
          execute: () => {
            executions += 1;
            return Promise.reject(
              new SpiceError("private engine diagnostics", {
                code: "ngspice_timeout",
                context: { timeoutMs: 30_000 },
                recovery: "Inspect the circuit before submitting a distinct request.",
              }),
            );
          },
        });
      const first = await assertRejects(run, SpiceError);
      assertEquals(first.code, "ngspice_timeout");
      assertEquals(first.context.execution_state, "failed");
      assert(typeof first.context.request_sha256 === "string");
      assert(typeof first.context.dispatch_sha256 === "string");
      assert(typeof first.context.receipt_sha256 === "string");
      assert(typeof first.context.outcome_sha256 === "string");

      const replay = await assertRejects(run, SpiceError);
      assertEquals(replay.code, "ngspice_timeout");
      assertEquals(replay.context, first.context);
      assertEquals(executions, 1);
    } finally {
      if (priorPath === undefined) Deno.env.delete("PATH");
      else Deno.env.set("PATH", priorPath);
      await Deno.remove(binDir, { recursive: true });
    }
  });
});

Deno.test("terminal missing-engine failures preserve NgspiceNotFoundError and receipt identities on replay", async () => {
  await withStores(async () => {
    const binDir = await Deno.makeTempDir({ prefix: "spice-fake-ngspice-" });
    const executable = join(binDir, "ngspice");
    await Deno.writeTextFile(
      executable,
      "#!/bin/sh\nprintf 'ngspice test runtime 44.2\\n'\n",
    );
    await Deno.chmod(executable, 0o755);
    const priorPath = Deno.env.get("PATH");
    Deno.env.set("PATH", `${binDir}:${priorPath ?? ""}`);
    try {
      const input = await start();
      let executions = 0;
      const run = () =>
        executeDocumentedSimulation({
          analysis_kind: "op",
          netlist_sha256: input.netlist_sha256,
          normalized_request: input.normalized_request,
          execute: () => {
            executions += 1;
            return Promise.reject(new NgspiceNotFoundError());
          },
        });
      const first = await assertRejects(run, NgspiceNotFoundError);
      assertEquals(first.code, "ngspice_unavailable");
      assertEquals(first.context.execution_state, "failed");
      assert(typeof first.context.request_sha256 === "string");
      assert(typeof first.context.dispatch_sha256 === "string");
      assert(typeof first.context.receipt_sha256 === "string");
      assert(typeof first.context.outcome_sha256 === "string");

      const replay = await assertRejects(run, NgspiceNotFoundError);
      assertEquals(replay.code, "ngspice_unavailable");
      assertEquals(replay.context, first.context);
      assertEquals(executions, 1);
    } finally {
      if (priorPath === undefined) Deno.env.delete("PATH");
      else Deno.env.set("PATH", priorPath);
      await Deno.remove(binDir, { recursive: true });
    }
  });
});

Deno.test("terminal non-engine tool failures remain SpiceToolError on replay", async () => {
  await withStores(async () => {
    const binDir = await Deno.makeTempDir({ prefix: "spice-fake-ngspice-" });
    const executable = join(binDir, "ngspice");
    await Deno.writeTextFile(
      executable,
      "#!/bin/sh\nprintf 'ngspice test runtime 44.2\\n'\n",
    );
    await Deno.chmod(executable, 0o755);
    const priorPath = Deno.env.get("PATH");
    Deno.env.set("PATH", `${binDir}:${priorPath ?? ""}`);
    try {
      const input = await start();
      let executions = 0;
      const run = () =>
        executeDocumentedSimulation({
          analysis_kind: "op",
          netlist_sha256: input.netlist_sha256,
          normalized_request: input.normalized_request,
          execute: () => {
            executions += 1;
            return Promise.reject(
              new SpiceToolError(
                "simulation_provider_policy_refused",
                { policy: "test" },
                "Inspect the provider policy before submitting a distinct request.",
              ),
            );
          },
        });
      const first = await assertRejects(run, SpiceToolError);
      assertEquals(first.code, "simulation_provider_policy_refused");
      assertEquals(first.context.execution_state, "failed");
      assert(typeof first.context.receipt_sha256 === "string");

      const replay = await assertRejects(run, SpiceToolError);
      assertEquals(replay.code, "simulation_provider_policy_refused");
      assertEquals(replay.context, first.context);
      assertEquals(executions, 1);
    } finally {
      if (priorPath === undefined) Deno.env.delete("PATH");
      else Deno.env.set("PATH", priorPath);
      await Deno.remove(binDir, { recursive: true });
    }
  });
});
