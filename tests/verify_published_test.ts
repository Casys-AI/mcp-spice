import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  createGitSource,
  parseArgs,
  PUBLISHED_IMAGE,
  PUBLISHED_PACKAGE,
  PUBLISHED_SOURCE,
  resolveTagCommit,
  VerifyFailure,
  verifyPublished,
} from "../scripts/verify_published.ts";
import type { VerifyDeps } from "../scripts/verify_published.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const TAG = "v9.9.9";
const VERSION = "9.9.9";
const COMMIT = "aa".repeat(20);
const README = "# mcp-spice\n";
const MOD = 'import "@std/path";\n';
const DENO_JSON = JSON.stringify(
  {
    name: PUBLISHED_PACKAGE,
    version: VERSION,
  },
  null,
  2,
) + "\n";

const encoder = new TextEncoder();

Deno.test("parseArgs requires an explicit release tag", () => {
  const err = parseArgsFailure([]);
  assertEquals(err.code, "invalid_cli");
  assertStringIncludes(String(err.context.reason), "git-tag");
});

Deno.test("parseArgs rejects unknown flags, positionals, and malformed values", () => {
  assertEquals(parseArgsFailure(["--wat"]).code, "invalid_cli");
  assertEquals(parseArgsFailure(["--"]).code, "invalid_cli");
  assertEquals(parseArgsFailure(["--git-tag", TAG, "extra"]).code, "invalid_cli");
  assertEquals(parseArgsFailure(["--git-tag", "v1"]).code, "invalid_cli");
  assertEquals(parseArgsFailure(["--git-tag", "latest"]).code, "invalid_cli");
  assertEquals(
    parseArgsFailure(["--git-tag", TAG, "--image", PUBLISHED_IMAGE]).code,
    "invalid_cli",
  );
  assertEquals(
    parseArgsFailure(["--git-tag", TAG, "--jsr-origin", "https://jsr.io"]).code,
    "invalid_cli",
  );
  assertEquals(
    parseArgsFailure(["--git-tag", TAG, "--expected-commit", "abc"]).code,
    "invalid_cli",
  );
  assertEquals(
    parseArgsFailure(["--git-tag", TAG, "--wait-timeout-ms", "-1"]).code,
    "invalid_cli",
  );
  assertEquals(
    parseArgsFailure(["--git-tag", TAG, "--wait-interval-ms", "0"]).code,
    "invalid_cli",
  );
  assertEquals(
    parseArgsFailure([
      "--git-tag",
      TAG,
      "--wait-timeout-ms",
      "10",
      "--wait-interval-ms",
      "20",
    ]).code,
    "invalid_cli",
  );
});

Deno.test("parseArgs accepts a verified tag and numeric wait bounds", () => {
  const opts = parseArgs([
    "--git-tag",
    TAG,
    "--expected-commit",
    COMMIT,
    "--wait-timeout-ms",
    "0",
    "--wait-interval-ms",
    "5",
  ]);
  assertEquals(opts.help, false);
  assertEquals(opts.gitTag, TAG);
  assertEquals(opts.version, VERSION);
  assertEquals(opts.expectedCommit, COMMIT);
  assertEquals(opts.waitTimeoutMs, 0);
  assertEquals(opts.waitIntervalMs, 5);
});

Deno.test("parseArgs --help does not require a tag", () => {
  assertEquals(parseArgs(["--help"]).help, true);
  assertEquals(parseArgs(["-h"]).help, true);
});

Deno.test("verify:published task help and invalid flags stay offline", async () => {
  const help = await runVerifyTask(["--help"]);
  assertEquals(help.code, 0);
  assertStringIncludes(help.stdout, "--git-tag");
  assertStringIncludes(help.stdout, PUBLISHED_IMAGE);
  assertEquals(help.stdout.includes("--image"), false);
  assertEquals(help.stdout.includes("--jsr-origin"), false);

  const standalone = await runVerifyTask(["--", "--git-tag", TAG]);
  assertEquals(standalone.code, 2);
  assertStringIncludes(standalone.stderr, "invalid_cli");
  assertStringIncludes(standalone.stderr, `"flag": "--"`);

  const unknownImage = await runVerifyTask(["--image", PUBLISHED_IMAGE]);
  assertEquals(unknownImage.code, 2);
  assertStringIncludes(unknownImage.stderr, "invalid_cli");

  const missingValue = await runVerifyTask(["--git-tag"]);
  assertEquals(missingValue.code, 2);
  assertStringIncludes(missingValue.stderr, "invalid_cli");
});

Deno.test("docker workflow uses the task argument contract and archives JSON evidence", async () => {
  const yaml = await Deno.readTextFile(
    new URL("../.github/workflows/docker.yml", import.meta.url),
  );
  const verifyJob = yaml.slice(yaml.indexOf("verify-published:"));
  assertStringIncludes(verifyJob, "deno task verify:published \\");
  assertEquals(/deno task verify:published\s+--\s/.test(verifyJob), false);
  assertEquals(/GHCR_TOKEN|secrets\.GITHUB_TOKEN/.test(verifyJob), false);
  assertStringIncludes(verifyJob, "git rev-parse --verify HEAD");
  assertStringIncludes(
    verifyJob,
    '> "${RUNNER_TEMP}/published-evidence.json"',
  );
  assertStringIncludes(verifyJob, "upload-artifact");
});

Deno.test("verifyPublished records JSR, tag commit, index digest and image labels", async () => {
  const world = await successfulWorld();
  const evidence = await verifyPublished(world.opts, world.deps);
  assertEquals(evidence.status, "verified");
  assertEquals(evidence.package, PUBLISHED_PACKAGE);
  assertEquals(evidence.version, VERSION);
  assertEquals(evidence.gitTag, TAG);
  assertEquals(evidence.commit, COMMIT);
  assertEquals(evidence.jsr.version, VERSION);
  assertEquals(evidence.jsr.checkedFiles, ["/README.md", "/deno.json"]);
  assertEquals(evidence.ghcr.tag, VERSION);
  assertEquals(evidence.ghcr.indexDigest, world.indexDigest);
  assertEquals(evidence.ghcr.platforms.length, 2);
  for (const platform of evidence.ghcr.platforms) {
    assertEquals(platform.labels["org.opencontainers.image.source"], PUBLISHED_SOURCE);
    assertEquals(platform.labels["org.opencontainers.image.revision"], COMMIT);
    assertEquals(platform.labels["org.opencontainers.image.version"], VERSION);
  }
  assertEquals(
    evidence.ghcr.platforms.map((p) => `${p.os}/${p.architecture}`).sort(),
    ["linux/amd64", "linux/arm64"],
  );
});

Deno.test("GHCR token exchange is anonymous and does not send caller credentials", async () => {
  const world = await successfulWorld();
  const auths: Array<{ url: string; authorization: string | null }> = [];
  const inner = world.deps.fetch;
  world.deps.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    auths.push({
      url: String(input),
      authorization: headers.get("Authorization"),
    });
    return await inner(input, init);
  };
  await verifyPublished(world.opts, world.deps);
  const tokenReq = auths.find((entry) => entry.url.includes("/token"));
  if (!tokenReq) throw new Error("missing GHCR token request");
  assertEquals(tokenReq.authorization, null);
  const manifestReq = auths.find((entry) => entry.url.includes("/manifests/"));
  if (!manifestReq) throw new Error("missing GHCR manifest request");
  assertEquals(manifestReq.authorization, "Bearer registry-token");
});

Deno.test("verifyPublished waits until both JSR and GHCR exist, then verifies", async () => {
  const world = await successfulWorld({ waitTimeoutMs: 30, waitIntervalMs: 10 });
  let jsrReady = false;
  let ociReady = false;
  const inner = world.deps.fetch;
  world.deps.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/meta.json") || url.includes("_meta.json")) {
      if (!jsrReady) return new Response("{}", { status: 404 });
    }
    if (url.includes("/manifests/") && !url.includes("sha256:")) {
      if (!ociReady) return new Response("missing", { status: 404 });
    }
    return await inner(input, init);
  };
  const originalSleep = world.deps.sleep;
  world.deps.sleep = async (ms) => {
    jsrReady = true;
    ociReady = true;
    await originalSleep(ms);
  };
  const evidence = await verifyPublished(world.opts, world.deps);
  assertEquals(evidence.status, "verified");
  assertEquals(world.now(), 10);
});

Deno.test("verifyPublished fails closed when JSR never appears", async () => {
  const world = await successfulWorld({ waitTimeoutMs: 20, waitIntervalMs: 10 });
  const inner = world.deps.fetch;
  world.deps.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("jsr.io") || url.includes("/@casys/mcp-spice/")) {
      return new Response("{}", { status: 404 });
    }
    return await inner(input, init);
  };
  const err = await assertRejects(
    () => verifyPublished(world.opts, world.deps),
    VerifyFailure,
  );
  assertEquals(err.code, "jsr_unavailable");
});

Deno.test("verifyPublished fails closed when the GHCR tag never appears", async () => {
  const world = await successfulWorld({ waitTimeoutMs: 20, waitIntervalMs: 10 });
  const inner = world.deps.fetch;
  world.deps.fetch = async (input, init) => {
    const url = String(input);
    if (
      url.includes("/v2/") && url.includes("/manifests/") && !url.includes("sha256:")
    ) {
      return new Response("missing", { status: 404 });
    }
    return await inner(input, init);
  };
  const err = await assertRejects(
    () => verifyPublished(world.opts, world.deps),
    VerifyFailure,
  );
  assertEquals(err.code, "oci_unavailable");
});

Deno.test("401 and malformed remote JSON fail immediately without polling", async () => {
  const forbidden = await successfulWorld({ waitTimeoutMs: 30, waitIntervalMs: 10 });
  const innerForbidden = forbidden.deps.fetch;
  forbidden.deps.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/manifests/") && !url.includes("sha256:")) {
      return new Response("denied", { status: 401 });
    }
    return await innerForbidden(input, init);
  };
  const forbiddenErr = await assertRejects(
    () => verifyPublished(forbidden.opts, forbidden.deps),
    VerifyFailure,
  );
  assertEquals(forbiddenErr.code, "oci_unavailable");
  assertEquals(forbidden.now(), 0);

  const malformed = await successfulWorld({ waitTimeoutMs: 30, waitIntervalMs: 10 });
  const innerMalformed = malformed.deps.fetch;
  malformed.deps.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/meta.json")) {
      return new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return await innerMalformed(input, init);
  };
  const malformedErr = await assertRejects(
    () => verifyPublished(malformed.opts, malformed.deps),
    VerifyFailure,
  );
  assertEquals(malformedErr.code, "jsr_manifest_mismatch");
  assertEquals(malformed.now(), 0);
});

Deno.test("verifyPublished fails when remote JSR checksums do not match the tag", async () => {
  const world = await successfulWorld();
  const inner = world.deps.fetch;
  world.deps.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith(`/${VERSION}_meta.json`)) {
      const meta = JSON.parse(world.versionMeta);
      meta.manifest["/README.md"].checksum = "sha256-" + "00".repeat(32);
      return jsonResponse(JSON.stringify(meta), {
        "content-type": "application/json",
      });
    }
    return await inner(input, init);
  };
  const err = await assertRejects(
    () => verifyPublished(world.opts, world.deps),
    VerifyFailure,
  );
  assertEquals(err.code, "jsr_manifest_mismatch");
});

Deno.test("JSR deno.json must be present and match even when TypeScript is normalized", async () => {
  for (const missing of [true, false]) {
    const world = await successfulWorld();
    const inner = world.deps.fetch;
    world.deps.fetch = async (input, init) => {
      if (String(input).endsWith(`/${VERSION}_meta.json`)) {
        const meta = JSON.parse(world.versionMeta);
        if (missing) delete meta.manifest["/deno.json"];
        else meta.manifest["/deno.json"].checksum = "sha256-" + "00".repeat(32);
        return jsonResponse(JSON.stringify(meta), {
          "content-type": "application/json",
        });
      }
      return await inner(input, init);
    };
    const err = await assertRejects(
      () => verifyPublished(world.opts, world.deps),
      VerifyFailure,
    );
    assertEquals(err.code, "jsr_manifest_mismatch");
  }
});

Deno.test("verifyPublished fails when a published JSR path is missing from the tag", async () => {
  const world = await successfulWorld();
  world.deps.git.readFile = (_commit, path) => {
    if (path === "README.md") return Promise.resolve(null);
    return Promise.resolve(gitFiles()[path] ?? null);
  };
  const err = await assertRejects(
    () => verifyPublished(world.opts, world.deps),
    VerifyFailure,
  );
  assertEquals(err.code, "jsr_manifest_mismatch");
});

Deno.test("verifyPublished does not hash the working tree; it uses the tag commit", async () => {
  const world = await successfulWorld();
  const commits: string[] = [];
  const inner = world.deps.git.readFile;
  world.deps.git.readFile = async (commit, path) => {
    commits.push(commit);
    return await inner(commit, path);
  };
  await verifyPublished(world.opts, world.deps);
  assertEquals(new Set(commits), new Set([COMMIT]));
});

Deno.test("verifyPublished fails when the tag commit does not match --expected-commit", async () => {
  const world = await successfulWorld();
  world.opts.expectedCommit = "bb".repeat(20);
  const err = await assertRejects(
    () => verifyPublished(world.opts, world.deps),
    VerifyFailure,
  );
  assertEquals(err.code, "tag_commit_mismatch");
});

Deno.test("verifyPublished fails when the Docker-Content-Digest header mismatches the bytes", async () => {
  const world = await successfulWorld();
  const inner = world.deps.fetch;
  world.deps.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith(`/manifests/${VERSION}`)) {
      return bytesResponse(world.indexBytes, {
        "content-type": "application/vnd.oci.image.index.v1+json",
        "docker-content-digest": "sha256:" + "00".repeat(32),
      });
    }
    return await inner(input, init);
  };
  const err = await assertRejects(
    () => verifyPublished(world.opts, world.deps),
    VerifyFailure,
  );
  assertEquals(err.code, "oci_digest_mismatch");
});

Deno.test("verifyPublished fails when the index omits Docker-Content-Digest", async () => {
  const world = await successfulWorld();
  const inner = world.deps.fetch;
  world.deps.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith(`/manifests/${VERSION}`)) {
      return bytesResponse(world.indexBytes, {
        "content-type": "application/vnd.oci.image.index.v1+json",
      });
    }
    return await inner(input, init);
  };
  const err = await assertRejects(
    () => verifyPublished(world.opts, world.deps),
    VerifyFailure,
  );
  assertEquals(err.code, "oci_digest_mismatch");
});

Deno.test("verifyPublished fails when an image revision label does not match the tag", async () => {
  const world = await successfulWorld({
    amd64Revision: "cc".repeat(20),
  });
  const err = await assertRejects(
    () => verifyPublished(world.opts, world.deps),
    VerifyFailure,
  );
  assertEquals(err.code, "oci_label_mismatch");
});

Deno.test("verifyPublished fails when image source or version labels do not match", async () => {
  const wrongSource = await successfulWorld({
    amd64Source: "https://github.com/example/not-spice",
  });
  const sourceErr = await assertRejects(
    () => verifyPublished(wrongSource.opts, wrongSource.deps),
    VerifyFailure,
  );
  assertEquals(sourceErr.code, "oci_label_mismatch");

  const wrongVersion = await successfulWorld({ amd64Version: "0.0.1" });
  const versionErr = await assertRejects(
    () => verifyPublished(wrongVersion.opts, wrongVersion.deps),
    VerifyFailure,
  );
  assertEquals(versionErr.code, "oci_label_mismatch");
});

Deno.test("verifyPublished fails when config os/architecture disagrees with the descriptor", async () => {
  const world = await successfulWorld({
    amd64ConfigArchitecture: "arm64",
  });
  const err = await assertRejects(
    () => verifyPublished(world.opts, world.deps),
    VerifyFailure,
  );
  assertEquals(err.code, "oci_platform_mismatch");
});

Deno.test("verifyPublished fails when linux/arm64 is missing from the index", async () => {
  const world = await successfulWorld({ omitArm64: true });
  const err = await assertRejects(
    () => verifyPublished(world.opts, world.deps),
    VerifyFailure,
  );
  assertEquals(err.code, "oci_platform_missing");
});

Deno.test("resolveTagCommit peels an annotated tag and rejects a same-named branch", async () => {
  const tagged = await Deno.makeTempDir({ prefix: "spice-verify-tag-" });
  const branched = await Deno.makeTempDir({ prefix: "spice-verify-branch-" });
  try {
    const taggedCommit = await initGit(tagged);
    await git(tagged, ["tag", "-a", TAG, "-m", "annotated release"]);
    await git(tagged, ["branch", TAG]);
    assertEquals(await resolveTagCommit(TAG, tagged), taggedCommit);
    assertEquals(await createGitSource(tagged).resolveTagCommit(TAG), taggedCommit);

    await initGit(branched);
    await git(branched, ["branch", TAG]);
    const err = await assertRejects(
      () => resolveTagCommit(TAG, branched),
      VerifyFailure,
    );
    assertEquals(err.code, "tag_not_found");
  } finally {
    await Deno.remove(tagged, { recursive: true });
    await Deno.remove(branched, { recursive: true });
  }
});

function parseArgsFailure(args: string[]): VerifyFailure {
  try {
    parseArgs(args);
  } catch (error) {
    if (error instanceof VerifyFailure) return error;
    throw error;
  }
  throw new Error("expected invalid CLI to fail closed");
}

async function runVerifyTask(args: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["task", "verify:published", ...args],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (result.code !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function initGit(cwd: string): Promise<string> {
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.email", "verify@example.com"]);
  await git(cwd, ["config", "user.name", "Verifier"]);
  await Deno.writeTextFile(`${cwd}/README.md`, "fixture\n");
  await git(cwd, ["add", "README.md"]);
  await git(cwd, ["commit", "-m", "init"]);
  return (await git(cwd, ["rev-parse", "HEAD"])).toLowerCase();
}

function gitFiles(): Record<string, Uint8Array> {
  return {
    "deno.json": encoder.encode(DENO_JSON),
    "README.md": encoder.encode(README),
    "mod.ts": encoder.encode(MOD),
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function jsrChecksum(bytes: Uint8Array): Promise<string> {
  return `sha256-${await sha256Hex(bytes)}`;
}

async function ociDigest(bytes: Uint8Array): Promise<string> {
  return `sha256:${await sha256Hex(bytes)}`;
}

function jsonResponse(body: string, headers: Record<string, string>, status = 200) {
  return new Response(body, { status, headers });
}

function bytesResponse(
  bytes: Uint8Array,
  headers: Record<string, string>,
  status = 200,
): Response {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Response(copy, { status, headers });
}

async function platformImage(options: {
  architecture: string;
  configArchitecture?: string;
  configOs?: string;
  revision: string;
  source?: string;
  version?: string;
}) {
  const configObject = {
    architecture: options.configArchitecture ?? options.architecture,
    os: options.configOs ?? "linux",
    config: {
      Labels: {
        "org.opencontainers.image.source": options.source ?? PUBLISHED_SOURCE,
        "org.opencontainers.image.revision": options.revision,
        "org.opencontainers.image.version": options.version ?? VERSION,
      },
    },
  };
  const configBytes = encoder.encode(JSON.stringify(configObject));
  const configDigest = await ociDigest(configBytes);
  const manifestObject = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: configDigest,
      size: configBytes.byteLength,
    },
    layers: [],
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifestObject));
  return {
    architecture: options.architecture,
    configBytes,
    configDigest,
    manifestBytes,
    manifestDigest: await ociDigest(manifestBytes),
  };
}

async function successfulWorld(options?: {
  waitTimeoutMs?: number;
  waitIntervalMs?: number;
  amd64Revision?: string;
  amd64Source?: string;
  amd64Version?: string;
  amd64ConfigArchitecture?: string;
  omitArm64?: boolean;
}) {
  const files = gitFiles();
  const versionMetaObj = {
    exports: { ".": "./mod.ts" },
    manifest: {
      "/deno.json": {
        size: files["deno.json"].byteLength,
        checksum: await jsrChecksum(files["deno.json"]),
      },
      "/README.md": {
        size: files["README.md"].byteLength,
        checksum: await jsrChecksum(files["README.md"]),
      },
      "/mod.ts": {
        // JSR rewrites import-map specifiers in published TypeScript.
        size: encoder.encode('import "jsr:@std/path@^1.1.0";\n').byteLength,
        checksum: await jsrChecksum(encoder.encode('import "jsr:@std/path@^1.1.0";\n')),
      },
    },
  };
  const versionMeta = JSON.stringify(versionMetaObj);
  const packageMeta = JSON.stringify({
    scope: "casys",
    name: "mcp-spice",
    versions: { [VERSION]: { createdAt: "2026-09-08T00:00:00.000000Z" } },
  });
  const amd64 = await platformImage({
    architecture: "amd64",
    configArchitecture: options?.amd64ConfigArchitecture,
    revision: options?.amd64Revision ?? COMMIT,
    source: options?.amd64Source,
    version: options?.amd64Version,
  });
  const arm64 = await platformImage({
    architecture: "arm64",
    revision: COMMIT,
  });
  const manifests = [
    {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: amd64.manifestDigest,
      size: amd64.manifestBytes.byteLength,
      platform: { architecture: "amd64", os: "linux" },
    },
  ];
  if (!options?.omitArm64) {
    manifests.push({
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: arm64.manifestDigest,
      size: arm64.manifestBytes.byteLength,
      platform: { architecture: "arm64", os: "linux" },
    });
  }
  manifests.push({
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: "sha256:" + "ee".repeat(32),
    size: 12,
    platform: { architecture: "unknown", os: "unknown" },
  });
  const indexBytes = encoder.encode(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests,
  }));
  const indexDigest = await ociDigest(indexBytes);
  const tokenBody = JSON.stringify({ token: "registry-token" });

  const blobs = new Map<
    string,
    { bytes: Uint8Array; contentType: string; digestHeader: boolean }
  >([
    [amd64.manifestDigest, {
      bytes: amd64.manifestBytes,
      contentType: "application/vnd.oci.image.manifest.v1+json",
      digestHeader: true,
    }],
    [arm64.manifestDigest, {
      bytes: arm64.manifestBytes,
      contentType: "application/vnd.oci.image.manifest.v1+json",
      digestHeader: true,
    }],
    [amd64.configDigest, {
      bytes: amd64.configBytes,
      contentType: "application/vnd.oci.image.config.v1+json",
      digestHeader: false,
    }],
    [arm64.configDigest, {
      bytes: arm64.configBytes,
      contentType: "application/vnd.oci.image.config.v1+json",
      digestHeader: false,
    }],
  ]);

  let clock = 0;
  const opts = parseArgs([
    "--git-tag",
    TAG,
    "--expected-commit",
    COMMIT,
    "--wait-timeout-ms",
    String(options?.waitTimeoutMs ?? 0),
    "--wait-interval-ms",
    String(options?.waitIntervalMs ?? 5),
  ]);

  const deps: VerifyDeps = {
    fetch: (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "ghcr.io" && url.pathname === "/token") {
        return Promise.resolve(
          jsonResponse(tokenBody, { "content-type": "application/json" }),
        );
      }
      if (url.href === `https://jsr.io/${PUBLISHED_PACKAGE}/meta.json`) {
        return Promise.resolve(
          jsonResponse(packageMeta, { "content-type": "application/json" }),
        );
      }
      if (url.href === `https://jsr.io/${PUBLISHED_PACKAGE}/${VERSION}_meta.json`) {
        return Promise.resolve(
          jsonResponse(versionMeta, { "content-type": "application/json" }),
        );
      }
      if (url.pathname === `/v2/casys-ai/mcp-spice/manifests/${VERSION}`) {
        return Promise.resolve(bytesResponse(indexBytes, {
          "content-type": "application/vnd.oci.image.index.v1+json",
          "docker-content-digest": indexDigest,
        }));
      }
      const digestMatch = url.pathname.match(
        /\/v2\/casys-ai\/mcp-spice\/(?:manifests|blobs)\/(sha256:[0-9a-f]+)$/,
      );
      if (digestMatch) {
        const blob = blobs.get(digestMatch[1]);
        if (!blob) {
          return Promise.resolve(new Response("missing", { status: 404 }));
        }
        const headers: Record<string, string> = {
          "content-type": blob.contentType,
        };
        if (blob.digestHeader) {
          headers["docker-content-digest"] = digestMatch[1];
        }
        return Promise.resolve(bytesResponse(blob.bytes, headers));
      }
      return Promise.resolve(
        new Response(`unexpected ${url.href}`, { status: 404 }),
      );
    },
    git: {
      resolveTagCommit: (tag: string) => {
        assertEquals(tag, TAG);
        return Promise.resolve(COMMIT);
      },
      readFile: (_commit: string, path: string) => Promise.resolve(files[path] ?? null),
    },
    now: () => clock,
    sleep: (ms: number) => {
      clock += ms;
      return Promise.resolve();
    },
  };

  return { opts, deps, indexBytes, indexDigest, versionMeta, now: () => clock };
}
