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
            return { value: 2 };
          },
        });
      const [left, right] = await Promise.all([run(), run()]);
      assertEquals(executions, 1);
      assertEquals(left.result, { value: 2 });
      assertEquals(right.result, { value: 2 });
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

Deno.test("terminal typed failures return durable references and replay without execution", async () => {
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
                "ngspice_timeout",
                { timeoutMs: 30_000 },
                "Inspect the circuit before submitting a distinct request.",
              ),
            );
          },
        });
      const first = await assertRejects(run, SpiceToolError);
      assertEquals(first.code, "ngspice_timeout");
      assertEquals(first.context.execution_state, "failed");
      assert(typeof first.context.request_sha256 === "string");
      assert(typeof first.context.dispatch_sha256 === "string");
      assert(typeof first.context.receipt_sha256 === "string");
      assert(typeof first.context.outcome_sha256 === "string");

      const replay = await assertRejects(run, SpiceToolError);
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
