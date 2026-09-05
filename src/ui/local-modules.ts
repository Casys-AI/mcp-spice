import { join, resolve, toFileUrl } from "@std/path";

/** Exact audited kit this viewer build is allowed to consume. */
export const AUDITED_KIT_REVISION = "b08802df353bb25d25a1c8d64b22ea61b5287ae0";
export const AUDITED_VIEW_VERSION = "0.9.3";
export const AUDITED_VIEW_CONTRACTS_VERSION = "0.1.0";
export const AUDITED_VIEW_COMPONENTS_VERSION = "0.9.0";

const REQUIRED_ROOTS = [
  {
    environment: "MCP_VIEW_LOCAL_ROOT",
    packageName: "@casys/mcp-view",
    version: AUDITED_VIEW_VERSION,
    entries: {
      "@casys/mcp-view": "mod.ts",
      "@casys/mcp-view/contracts": "contracts.ts",
    },
  },
  {
    environment: "MCP_VIEW_CONTRACTS_LOCAL_ROOT",
    packageName: "@casys/mcp-view-contracts",
    version: AUDITED_VIEW_CONTRACTS_VERSION,
    entries: { "@casys/mcp-view-contracts": "mod.ts" },
  },
  {
    environment: "MCP_VIEW_COMPONENTS_LOCAL_ROOT",
    packageName: "@casys/mcp-view-components",
    version: AUDITED_VIEW_COMPONENTS_VERSION,
    entries: {
      "@casys/mcp-view-components": "mod.ts",
      "@casys/mcp-view-components/preact": "preact.ts",
      "@casys/mcp-view-components/preact/components": "preact-components.ts",
      "@casys/mcp-view-components/fonts": "fonts.ts",
    },
  },
] as const;

export const AUDITED_VIEW_ROOT_ENVIRONMENTS = REQUIRED_ROOTS.map((entry) =>
  entry.environment
);

/**
 * Build a Deno config from three explicitly selected, split local packages.
 *
 * There is deliberately no registry or monolithic-package fallback. Package
 * metadata and every imported entry point are checked before Deno is invoked.
 */
export async function auditedViewerDenoConfig(): Promise<unknown> {
  const imports: Record<string, string> = {};

  for (const requirement of REQUIRED_ROOTS) {
    const root = requiredLocalRoot(requirement.environment);
    await assertPackageIdentity(
      root,
      requirement.environment,
      requirement.packageName,
      requirement.version,
    );
    await assertKitRevision(root, requirement.environment);
    for (
      const [specifier, relativeEntry] of Object.entries(requirement.entries)
    ) {
      const entry = join(root, relativeEntry);
      await assertRegularFile(entry, `${specifier} entry point`);
      imports[specifier] = toFileUrl(entry).href;
    }
  }

  return {
    minimumDependencyAge: { age: "P1D" },
    compilerOptions: {
      jsx: "react-jsx",
      jsxImportSource: "preact",
      lib: [
        "deno.ns",
        "deno.window",
        "dom",
        "dom.iterable",
        "dom.asynciterable",
        "esnext",
      ],
    },
    imports: {
      ...imports,
      "@modelcontextprotocol/ext-apps": "npm:@modelcontextprotocol/ext-apps@1.7.5",
      "@modelcontextprotocol/sdk": "npm:@modelcontextprotocol/sdk@1.30.0",
      "@modelcontextprotocol/sdk/types.js":
        "npm:@modelcontextprotocol/sdk@1.30.0/types.js",
      "@std/assert": "jsr:@std/assert@1.0.19",
      "@std/path": "jsr:@std/path@1.1.6",
      "linkedom": "npm:linkedom@0.18.12",
      "preact": "npm:preact@10.29.7",
      "preact/jsx-runtime": "npm:preact@10.29.7/jsx-runtime",
    },
  };
}

export async function withAuditedViewerDenoConfig<T>(
  action: (configPath: string) => Promise<T>,
): Promise<T> {
  const temporaryDirectory = await Deno.makeTempDir({
    prefix: "mcp-spice-view-config-",
  });
  const configPath = join(temporaryDirectory, "deno.json");
  try {
    await Deno.writeTextFile(
      configPath,
      `${JSON.stringify(await auditedViewerDenoConfig(), null, 2)}\n`,
    );
    return await action(configPath);
  } finally {
    await Deno.remove(temporaryDirectory, { recursive: true });
  }
}

function requiredLocalRoot(environment: string): string {
  const value = Deno.env.get(environment)?.trim();
  if (!value) {
    throw new Error(
      `Missing ${environment}. SPICE viewer builds require explicit audited local roots for ${
        AUDITED_VIEW_ROOT_ENVIRONMENTS.join(", ")
      }; no published compatibility fallback is allowed.`,
    );
  }
  return resolve(Deno.cwd(), value);
}

async function assertPackageIdentity(
  root: string,
  environment: string,
  expectedName: string,
  expectedVersion: string,
): Promise<void> {
  const metadataPath = join(root, "deno.json");
  await assertRegularFile(metadataPath, `${environment} package metadata`);
  let metadata: unknown;
  try {
    metadata = JSON.parse(await Deno.readTextFile(metadataPath));
  } catch (error) {
    throw new Error(
      `${environment} must contain readable JSON package metadata: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    typeof metadata !== "object" || metadata === null ||
    Array.isArray(metadata)
  ) {
    throw new Error(
      `${environment} must identify the split package ${expectedName}@${expectedVersion}.`,
    );
  }
  const record = metadata as Record<string, unknown>;
  if (record.name !== expectedName || record.version !== expectedVersion) {
    throw new Error(
      `${environment} must identify the split package ${expectedName}@${expectedVersion}.`,
    );
  }
}

async function assertKitRevision(
  root: string,
  environment: string,
): Promise<void> {
  const command = new Deno.Command("git", {
    args: ["-C", root, "rev-parse", "HEAD"],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  const decoder = new TextDecoder();
  if (!result.success) {
    throw new Error(
      `${environment} must be a git checkout of ${AUDITED_KIT_REVISION}: ${
        decoder.decode(result.stderr).trim() || "git rev-parse failed"
      }`,
    );
  }
  const head = decoder.decode(result.stdout).trim();
  if (head !== AUDITED_KIT_REVISION) {
    throw new Error(
      `${environment} must be ${AUDITED_KIT_REVISION}, got ${head}.`,
    );
  }
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch (error) {
    throw new Error(
      `${label} is unavailable at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!info.isFile) throw new Error(`${label} is not a regular file: ${path}`);
}
