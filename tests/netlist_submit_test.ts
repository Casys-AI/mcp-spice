/**
 * Guards for ngspice_netlist_submit and hash-ref simulate resolution.
 *
 * Unconditional: no ngspice required. Native equivalence of simulate-by-ref
 * vs simulate-by-path is gated by SPICE_RUN_NATIVE=1.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { NetlistArtifactError, sha256Hex } from "../src/api/netlist-artifact.ts";
import { resolveSimulationNetlist } from "../src/api/netlist-resolve.ts";
import { NetlistSecurityError } from "../src/api/netlist-security.ts";
import {
  configureNetlistStoreDir,
  getNetlistPath,
  NETLIST_MAX_BYTES,
  putNetlistBytes,
} from "../src/api/netlist-store.ts";
import { isMachineReadableError, SpiceToolError } from "../src/api/tool-error.ts";
import { allTools } from "../src/tools/mod.ts";

const RUN_NATIVE = Deno.env.get("SPICE_RUN_NATIVE") === "1";

const VDIV = `Voltage Divider R1=1k R2=2k Vin=3V
Vin in 0 DC 3
R1 in out 1000
R2 out 0 2000
.end
`;

async function withStore<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "spice-store-" });
  configureNetlistStoreDir(dir);
  try {
    return await fn(dir);
  } finally {
    configureNetlistStoreDir(undefined);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function submitTool() {
  const tool = allTools.find((t) => t.name === "ngspice_netlist_submit");
  assert(tool, "ngspice_netlist_submit must be registered");
  return tool;
}

async function submit(
  netlist: string,
  expectedSha256?: string,
): Promise<{ sha256: string; bytes: number; uri: string }> {
  const args: Record<string, unknown> = { netlist };
  if (expectedSha256 !== undefined) args.netlist_sha256 = expectedSha256;
  const result = await submitTool().handler({
    ...args,
  }) as { structuredContent: { sha256: string; bytes: number; uri: string } };
  return result.structuredContent;
}

function storedHashes(dir: string): string[] {
  const names: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (entry.isFile && !entry.name.startsWith(".")) names.push(entry.name);
  }
  return names.sort();
}

Deno.test("ngspice_netlist_submit is idempotent for identical bytes", async () => {
  await withStore(async (dir) => {
    const first = await submit(VDIV);
    const second = await submit(VDIV);
    assertEquals(second, first);
    assertEquals(storedHashes(dir), [first.sha256]);
    const path = await getNetlistPath(first.sha256, "test");
    const stored = await Deno.readFile(path);
    assertEquals(stored, new TextEncoder().encode(VDIV));
    assertEquals(first.uri, `spice-netlist:sha256:${first.sha256}`);
    assertEquals(first.bytes, stored.length);
  });
});

Deno.test(
  "ngspice_netlist_submit computes and returns a digest when no expected hash is supplied",
  async () => {
    await withStore(async () => {
      const submitted = await submit(VDIV);
      const expected = await sha256Hex(new TextEncoder().encode(VDIV));
      assertEquals(submitted.sha256, expected);
      assertEquals(submitted.uri, `spice-netlist:sha256:${expected}`);
    });
  },
);

Deno.test(
  "ngspice_netlist_submit accepts a matching optional expected hash",
  async () => {
    await withStore(async () => {
      const expected = await sha256Hex(new TextEncoder().encode(VDIV));
      const submitted = await submit(VDIV, expected.toUpperCase());
      assertEquals(submitted.sha256, expected);
    });
  },
);

Deno.test(
  "ngspice_netlist_submit refuses a malformed declared SHA-256 and writes nothing",
  async () => {
    await withStore(async (dir) => {
      const error = await assertRejects(
        () => submit(VDIV, "not-a-valid-sha256"),
        SpiceToolError,
      );
      assertEquals(error.code, "invalid_netlist_sha256");
      assertEquals(storedHashes(dir), []);
    });
  },
);

Deno.test(
  "ngspice_netlist_submit refuses a declared SHA-256 mismatch and writes nothing",
  async () => {
    await withStore(async (dir) => {
      const error = await assertRejects(
        () => submit(VDIV, "a".repeat(64)),
        SpiceToolError,
      );
      assertEquals(error.code, "netlist_sha256_mismatch");
      assert(isMachineReadableError(error));
      assertEquals(typeof error.recovery, "string");
      assert(error.recovery.length > 0);
      assertEquals(error.context.expected, "a".repeat(64));
      assertEquals(typeof error.context.computed, "string");
      assertEquals(storedHashes(dir), []);
    });
  },
);

Deno.test(
  "ngspice_netlist_submit refuses .include before any store write",
  async () => {
    await withStore(async (dir) => {
      const netlist = `* circuit
.include models/transistors.sp
Vin in 0 DC 1
.op
.end
`;
      const error = await assertRejects(
        () => submit(netlist),
        NetlistSecurityError,
      );
      assertEquals(error.directive, ".include");
      assertEquals(error.code, "netlist_forbidden_directive");
      assert(isMachineReadableError(error));
      assertEquals(storedHashes(dir), []);
    });
  },
);

Deno.test(
  "ngspice_netlist_submit refuses .control before any store write",
  async () => {
    await withStore(async (dir) => {
      const netlist = `Vin in 0 DC 1
.control
op
.endc
.end
`;
      await assertRejects(() => submit(netlist), NetlistSecurityError);
      assertEquals(storedHashes(dir), []);
    });
  },
);

Deno.test(
  "putNetlistBytes refuses to overwrite a colliding object at the same hash",
  async () => {
    await withStore(async (dir) => {
      const bytes = new TextEncoder().encode(VDIV);
      const sha256 = await sha256Hex(bytes);
      await Deno.writeTextFile(`${dir}/${sha256}`, "not-the-netlist");
      const error = await assertRejects(
        () => putNetlistBytes(bytes, "ngspice_netlist_submit", dir),
        SpiceToolError,
      );
      assertEquals(error.code, "netlist_store_collision");
      assertEquals(await Deno.readTextFile(`${dir}/${sha256}`), "not-the-netlist");
    });
  },
);

Deno.test("putNetlistBytes refuses unsafe pre-existing CAS collision targets", async () => {
  const cases = [
    {
      name: "symlink",
      reason: "not_regular_file",
      prepare: async (dir: string, path: string) => {
        const outside = `${dir}/outside-netlist`;
        await Deno.writeTextFile(outside, VDIV);
        await Deno.symlink(outside, path);
      },
    },
    {
      name: "FIFO",
      reason: "not_regular_file",
      prepare: async (_dir: string, path: string) => {
        const output = await new Deno.Command("mkfifo", { args: [path] }).output();
        assert(output.success, "mkfifo must create the test collision target");
      },
    },
    {
      name: "oversized regular file",
      reason: "size_mismatch",
      prepare: async (_dir: string, path: string) => {
        await Deno.writeFile(path, new Uint8Array());
        await Deno.truncate(path, NETLIST_MAX_BYTES + 1);
      },
    },
  ];
  for (const fixture of cases) {
    await withStore(async (dir) => {
      const bytes = new TextEncoder().encode(VDIV);
      const sha256 = await sha256Hex(bytes);
      await fixture.prepare(dir, `${dir}/${sha256}`);
      const error = await assertRejects(
        () => putNetlistBytes(bytes, "ngspice_netlist_submit", dir),
        SpiceToolError,
      );
      assertEquals(error.code, "netlist_store_collision", fixture.name);
      assertEquals(error.context.reason, fixture.reason, fixture.name);
    });
  }
});

Deno.test(
  "normalizeSha256 / getNetlistPath reject path-traversal hashes",
  async () => {
    await withStore(async () => {
      const error = await assertRejects(
        () => getNetlistPath("../".repeat(8) + "etc/passwd", "test"),
        SpiceToolError,
      );
      assertEquals(error.code, "invalid_netlist_sha256");
    });
  },
);

Deno.test(
  "resolveSimulationNetlist from store equals snapshot of the same path bytes",
  async () => {
    await withStore(async () => {
      const fixture = new URL("./fixtures/vdiv.cir", import.meta.url).pathname;
      const fileBytes = await Deno.readFile(fixture);
      const sha256 = await sha256Hex(fileBytes);
      const netlist = new TextDecoder().decode(fileBytes);
      const ref = await submit(netlist, sha256);

      const fromPath = await resolveSimulationNetlist("spice_simulate_op", {
        netlist_path: fixture,
        netlist_sha256: sha256,
      });
      const fromHash = await resolveSimulationNetlist("spice_simulate_op", {
        netlist_sha256: ref.sha256,
        netlist_uri: ref.uri,
      });
      try {
        const pathText = await Deno.readTextFile(fromPath.artifact.path);
        const hashText = await Deno.readTextFile(fromHash.artifact.path);
        assertEquals(hashText, pathText);
        assertEquals(fromHash.artifact.sha256, fromPath.artifact.sha256);
        assertEquals(fromHash.artifact.bytes, fromPath.artifact.bytes);
        assertEquals(fromHash.artifact.sha256, ref.sha256);
      } finally {
        await fromPath.cleanup();
        await fromHash.cleanup();
      }
    });
  },
);

Deno.test(
  "legacy netlist_path refuses the same byte budget as ngspice_netlist_submit",
  async () => {
    const directory = await Deno.makeTempDir({ prefix: "spice-legacy-limit-" });
    const path = `${directory}/oversized.cir`;
    try {
      const bytes = new Uint8Array(NETLIST_MAX_BYTES + 1);
      bytes.fill(0x20);
      await Deno.writeFile(path, bytes);
      const sha256 = await sha256Hex(bytes);
      const error = await assertRejects(
        () =>
          resolveSimulationNetlist("spice_simulate_op", {
            netlist_path: path,
            netlist_sha256: sha256,
          }),
        NetlistArtifactError,
      );
      assertEquals(error.code, "netlist_too_large");
      assertEquals(error.context.byteCount, NETLIST_MAX_BYTES + 1);
      assertEquals(error.context.maxBytes, NETLIST_MAX_BYTES);
    } finally {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "ngspice_netlist_submit refuses the shared byte budget before store write",
  async () => {
    await withStore(async (dir) => {
      const oversized = " ".repeat(NETLIST_MAX_BYTES + 1);
      const error = await assertRejects(
        () => submit(oversized),
        SpiceToolError,
      );
      assertEquals(error.code, "netlist_too_large");
      assertEquals(error.context.byteCount, NETLIST_MAX_BYTES + 1);
      assertEquals(error.context.maxBytes, NETLIST_MAX_BYTES);
      assertEquals(storedHashes(dir), []);
    });
  },
);

Deno.test(
  "resolveSimulationNetlist refuses path and uri together",
  async () => {
    await withStore(async () => {
      const ref = await submit(VDIV);
      const error = await assertRejects(
        () =>
          resolveSimulationNetlist("spice_simulate_op", {
            netlist_path: "/tmp/vdiv.cir",
            netlist_uri: ref.uri,
            netlist_sha256: ref.sha256,
          }),
        SpiceToolError,
      );
      assertEquals(error.code, "ambiguous_netlist_source");
    });
  },
);

Deno.test({
  name: "spice_simulate_op by store reference equals spice_simulate_op by path",
  ignore: !RUN_NATIVE,
  fn: async () => {
    await withStore(async (dir) => {
      const netlistPath = `${dir}/vdiv.cir`;
      await Deno.writeTextFile(netlistPath, VDIV);
      const sha256 = await sha256Hex(new TextEncoder().encode(VDIV));
      const ref = await submit(VDIV, sha256);

      const tool = allTools.find((t) => t.name === "spice_simulate_op");
      assert(tool);

      const byPath = await tool.handler({
        netlist_path: netlistPath,
        netlist_sha256: sha256,
        nodes: ["out", "in"],
      }) as { structuredContent: Record<string, unknown> };
      const byRef = await tool.handler({
        netlist_sha256: ref.sha256,
        netlist_uri: ref.uri,
        nodes: ["out", "in"],
      }) as { structuredContent: Record<string, unknown> };

      assertEquals(
        byRef.structuredContent.node_voltages,
        byPath.structuredContent.node_voltages,
      );
      const pathArt = byPath.structuredContent.input_artifact as { sha256: string };
      const refArt = byRef.structuredContent.input_artifact as { sha256: string };
      assertEquals(refArt.sha256, pathArt.sha256);
      assertEquals(refArt.sha256, sha256);
    });
  },
});
