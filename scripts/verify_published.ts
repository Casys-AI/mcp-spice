/**
 * Fail-closed verifier for tagged Casys SPICE on public JSR and GHCR.
 * Compares JSR README/deno.json and GHCR identity to the tag, not the working tree.
 * JSR rewrites TypeScript imports: this does not verify all source bytes or JSR provenance.
 * Identity is fixed; GHCR uses anonymous public token exchange only.
 */

export const PUBLISHED_PACKAGE = "@casys/mcp-spice";
export const PUBLISHED_IMAGE = "ghcr.io/casys-ai/mcp-spice";
export const PUBLISHED_SOURCE = "https://github.com/Casys-AI/mcp-spice";
export const REQUIRED_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;

const JSR_ORIGIN = "https://jsr.io";
const GHCR = "ghcr.io";
const REPO = "casys-ai/mcp-spice";
const REQUEST_TIMEOUT_MS = 15_000;
const TAG_PATTERN = /^v([0-9]+\.[0-9]+\.[0-9]+)$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const INDEX_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
];
const MANIFEST_TYPES = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];
const TOKEN_URL = `https://${GHCR}/token?service=${GHCR}&scope=repository:${REPO}:pull`;
const MANIFESTS = `https://${GHCR}/v2/${REPO}/manifests`;
const BLOBS = `https://${GHCR}/v2/${REPO}/blobs`;

const USAGE = `Verify that a tagged mcp-spice release matches published JSR and GHCR.

Usage:
  deno task verify:published --git-tag v<version> [options]

Required:
  --git-tag vX.Y.Z          Release tag; version is taken from the tag

Options:
  --expected-commit <sha>   Full 40-hex commit the tag must peel to
  --wait-timeout-ms <n>     Bounded wait for both surfaces (default: 120000)
  --wait-interval-ms <n>    Poll interval while waiting (default: 5000)
  --help, -h                Print this usage text

JSR is ${JSR_ORIGIN}/${PUBLISHED_PACKAGE}. GHCR is ${PUBLISHED_IMAGE}.
Authentication is anonymous public GHCR token exchange; caller tokens are not read.
`;

export class VerifyFailure extends Error {
  readonly code: string;
  readonly context: Record<string, unknown>;
  readonly recovery: string;

  constructor(
    code: string,
    context: Record<string, unknown>,
    recovery: string,
  ) {
    super(JSON.stringify({ status: "failed", code, context, recovery }));
    this.name = "VerifyFailure";
    this.code = code;
    this.context = context;
    this.recovery = recovery;
  }

  toJSON() {
    return {
      status: "failed" as const,
      code: this.code,
      context: this.context,
      recovery: this.recovery,
    };
  }
}

export interface CliOptions {
  help: boolean;
  gitTag: string;
  version: string;
  expectedCommit?: string;
  waitTimeoutMs: number;
  waitIntervalMs: number;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GitSource {
  resolveTagCommit(tag: string): Promise<string>;
  readFile(commit: string, path: string): Promise<Uint8Array | null>;
}

export interface VerifyDeps {
  fetch: FetchLike;
  git: GitSource;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface PublishedPlatform {
  os: string;
  architecture: string;
  manifestDigest: string;
  configDigest: string;
  labels: {
    "org.opencontainers.image.source": string;
    "org.opencontainers.image.revision": string;
    "org.opencontainers.image.version": string;
  };
}

export interface PublishedEvidence {
  status: "verified";
  package: string;
  version: string;
  gitTag: string;
  commit: string;
  jsr: { version: string; checkedFiles: string[] };
  ghcr: { tag: string; indexDigest: string; platforms: PublishedPlatform[] };
}

interface HttpBody {
  status: number;
  bytes: Uint8Array;
  headers: Headers;
}

interface OciIndex {
  mediaType: string;
  manifests: Array<{
    digest?: string;
    platform?: { os?: string; architecture?: string };
  }>;
}

export function parseArgs(args: string[]): CliOptions {
  if (args.includes("--help") || args.includes("-h")) {
    return {
      help: true,
      gitTag: "",
      version: "",
      waitTimeoutMs: 120_000,
      waitIntervalMs: 5_000,
    };
  }

  let gitTag: string | undefined;
  let expectedCommit: string | undefined;
  let waitTimeoutMs = 120_000;
  let waitIntervalMs = 5_000;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--") || arg === "--") {
      throw invalidCli("unknown flag", { flag: arg });
    }
    const value = args[i + 1];
    switch (arg) {
      case "--git-tag":
        gitTag = readFlagValue(arg, value);
        i++;
        break;
      case "--expected-commit":
        expectedCommit = readFlagValue(arg, value).toLowerCase();
        i++;
        break;
      case "--wait-timeout-ms":
        waitTimeoutMs = readInt(arg, value, 0);
        i++;
        break;
      case "--wait-interval-ms":
        waitIntervalMs = readInt(arg, value, 1);
        i++;
        break;
      default:
        throw invalidCli("unknown flag", { flag: arg });
    }
  }

  if (gitTag === undefined) {
    throw invalidCli("missing required --git-tag", { flag: "--git-tag" });
  }
  const tagMatch = TAG_PATTERN.exec(gitTag);
  if (!tagMatch) {
    throw invalidCli("git-tag must be v<major.minor.patch>", { gitTag });
  }
  if (expectedCommit !== undefined && !COMMIT_PATTERN.test(expectedCommit)) {
    throw invalidCli("expected-commit must be a 40-character hex SHA", {
      expectedCommit,
    });
  }
  if (waitTimeoutMs > 0 && waitIntervalMs > waitTimeoutMs) {
    throw invalidCli("wait-interval-ms must be <= wait-timeout-ms", {
      waitTimeoutMs,
      waitIntervalMs,
    });
  }
  return {
    help: false,
    gitTag,
    version: tagMatch[1],
    expectedCommit,
    waitTimeoutMs,
    waitIntervalMs,
  };
}

export async function verifyPublished(
  opts: CliOptions,
  deps: VerifyDeps,
): Promise<PublishedEvidence> {
  if (opts.help || !opts.gitTag) {
    throw invalidCli("missing required flag", { flag: "--git-tag" });
  }

  const commit = await resolveCommit(opts, deps.git);
  await readTaggedDenoJson(deps.git, commit, opts.version);
  const token: { value?: string } = {};
  await waitForBothSurfaces(opts, deps, token);

  const manifest = await loadJsrManifest(deps.fetch, opts.version, false);
  if (!manifest) {
    fail(
      "jsr_unavailable",
      { package: PUBLISHED_PACKAGE, version: opts.version },
      "Wait until the JSR version exists, then re-run the verifier.",
    );
  }
  await assertJsrMatchesTag(manifest, deps.git, commit, opts.version);

  const index = await fetchOciIndex(deps, opts.version, token);
  const platforms = await readPlatformConfigs(
    deps,
    index.body,
    commit,
    opts.version,
    token,
  );
  return {
    status: "verified",
    package: PUBLISHED_PACKAGE,
    version: opts.version,
    gitTag: opts.gitTag,
    commit,
    jsr: { version: opts.version, checkedFiles: ["/README.md", "/deno.json"] },
    ghcr: { tag: opts.version, indexDigest: index.digest, platforms },
  };
}

export async function main(
  args: string[],
  deps: VerifyDeps = createDefaultDeps(),
): Promise<number> {
  try {
    const opts = parseArgs(args);
    if (opts.help) {
      console.log(USAGE);
      return 0;
    }
    console.log(JSON.stringify(await verifyPublished(opts, deps), null, 2));
    return 0;
  } catch (error) {
    if (error instanceof VerifyFailure) {
      console.error(JSON.stringify(error.toJSON(), null, 2));
      return error.code === "invalid_cli" ? 2 : 1;
    }
    throw error;
  }
}

export function createGitSource(cwd = "."): GitSource {
  return {
    resolveTagCommit: (tag) => resolveTagCommit(tag, cwd),
    readFile: (commit, path) => gitReadFile(commit, path, cwd),
  };
}

export function createDefaultDeps(): VerifyDeps {
  return {
    fetch: globalThis.fetch,
    git: createGitSource(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

if (import.meta.main) Deno.exit(await main(Deno.args));

function invalidCli(
  reason: string,
  context: Record<string, unknown> = {},
): VerifyFailure {
  return new VerifyFailure("invalid_cli", { reason, ...context }, "See --help.");
}

function fail(
  code: string,
  context: Record<string, unknown>,
  recovery: string,
): never {
  throw new VerifyFailure(code, context, recovery);
}

function readFlagValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) {
    throw invalidCli("flag requires a value", { flag });
  }
  return value;
}

function readInt(flag: string, value: string | undefined, min: number): number {
  const text = readFlagValue(flag, value);
  if (!/^[0-9]+$/.test(text)) {
    throw invalidCli("flag requires a non-negative integer", { flag, value: text });
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw invalidCli("flag requires a valid integer", { flag, value: text, min });
  }
  return parsed;
}

async function resolveCommit(opts: CliOptions, git: GitSource): Promise<string> {
  const commit = (await git.resolveTagCommit(opts.gitTag)).toLowerCase();
  if (!COMMIT_PATTERN.test(commit)) {
    fail(
      "tag_not_found",
      { gitTag: opts.gitTag, commit },
      "Resolve the release tag to a full commit SHA.",
    );
  }
  if (opts.expectedCommit && opts.expectedCommit !== commit) {
    fail(
      "tag_commit_mismatch",
      {
        gitTag: opts.gitTag,
        expectedCommit: opts.expectedCommit,
        commit,
      },
      "The tag must peel to the expected commit; do not move release tags.",
    );
  }
  return commit;
}

async function readTaggedDenoJson(
  git: GitSource,
  commit: string,
  version: string,
): Promise<void> {
  const bytes = await git.readFile(commit, "deno.json");
  if (!bytes) {
    fail(
      "tag_not_found",
      { commit, path: "deno.json" },
      "The tag commit must contain deno.json.",
    );
  }
  const parsed = parseObject(bytes, "jsr_manifest_mismatch", {
    commit,
    path: "deno.json",
  });
  if (parsed.name !== PUBLISHED_PACKAGE || typeof parsed.version !== "string") {
    fail(
      "jsr_manifest_mismatch",
      { name: parsed.name, version: parsed.version, expected: PUBLISHED_PACKAGE },
      "The tagged package must be the public Casys SPICE JSR identity.",
    );
  }
  if (parsed.version !== version) {
    fail(
      "tag_commit_mismatch",
      { version, taggedVersion: parsed.version, commit },
      "The git tag must match the tagged deno.json version.",
    );
  }
}

async function waitForBothSurfaces(
  opts: CliOptions,
  deps: VerifyDeps,
  token: { value?: string },
): Promise<void> {
  const deadline = deps.now() + opts.waitTimeoutMs;
  for (;;) {
    const jsr = await loadJsrManifest(deps.fetch, opts.version, true);
    const oci = await probeOci(deps, opts.version, token);
    if (jsr && oci) return;
    if (deps.now() >= deadline) {
      if (!jsr) {
        fail(
          "jsr_unavailable",
          { package: PUBLISHED_PACKAGE, version: opts.version },
          "Wait until the JSR version exists, then re-run the verifier.",
        );
      }
      fail(
        "oci_unavailable",
        { image: PUBLISHED_IMAGE, tag: opts.version },
        "Wait until the GHCR tag exists, then re-run the verifier.",
      );
    }
    await deps.sleep(opts.waitIntervalMs);
  }
}

async function loadJsrManifest(
  fetchLike: FetchLike,
  version: string,
  optional: boolean,
): Promise<Record<string, { size: number; checksum: string }> | null> {
  const pkg = await getJson(
    fetchLike,
    `${JSR_ORIGIN}/${PUBLISHED_PACKAGE}/meta.json`,
    "jsr_unavailable",
    { package: PUBLISHED_PACKAGE },
    optional,
  );
  if (!pkg) return null;
  const versions = pkg.versions;
  if (versions === null || typeof versions !== "object" || Array.isArray(versions)) {
    fail(
      "jsr_manifest_mismatch",
      { package: PUBLISHED_PACKAGE, reason: "versions missing" },
      "Remote JSR package metadata must list versions.",
    );
  }
  if (!(version in versions)) {
    if (optional) return null;
    fail(
      "jsr_unavailable",
      { package: PUBLISHED_PACKAGE, version },
      "Wait until the JSR version exists, then re-run the verifier.",
    );
  }
  const meta = await getJson(
    fetchLike,
    `${JSR_ORIGIN}/${PUBLISHED_PACKAGE}/${version}_meta.json`,
    "jsr_unavailable",
    { package: PUBLISHED_PACKAGE, version },
    optional,
  );
  if (!meta) return null;
  const manifest = meta.manifest;
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail(
      "jsr_manifest_mismatch",
      { package: PUBLISHED_PACKAGE, version, reason: "manifest missing" },
      "The JSR version metadata must include a file manifest.",
    );
  }
  return manifest as Record<string, { size: number; checksum: string }>;
}

async function probeOci(
  deps: VerifyDeps,
  tag: string,
  token: { value?: string },
): Promise<boolean> {
  const bearer = await ghcrToken(deps, token, true);
  if (!bearer) return false;
  const result = readyOrRetry(
    await timedGet(deps.fetch, `${MANIFESTS}/${tag}`, {
      Accept: INDEX_TYPES.join(", "),
      Authorization: `Bearer ${bearer}`,
    }),
  );
  if (!result) return false;
  if (result.status !== 200) {
    fail(
      "oci_unavailable",
      { image: PUBLISHED_IMAGE, tag, status: result.status },
      "Anonymous public GHCR access is required.",
    );
  }
  parseObject(result.bytes, "oci_digest_mismatch", { tag });
  return true;
}

async function assertJsrMatchesTag(
  manifest: Record<string, { size: number; checksum: string }>,
  git: GitSource,
  commit: string,
  version: string,
): Promise<void> {
  // JSR normalizes TypeScript imports during publication. Only these unchanged
  // publication identity files are byte-compared; no source/provenance claim.
  const entries = ["/README.md", "/deno.json"].map((path) =>
    [path, manifest[path]] as const
  );
  if (entries.length === 0) {
    fail(
      "jsr_manifest_mismatch",
      { package: PUBLISHED_PACKAGE, version, reason: "empty manifest" },
      "The published JSR manifest must list the tagged source files.",
    );
  }
  for (const [jsrPath, entry] of entries) {
    const path = gitPathFromJsr(jsrPath);
    if (
      entry === undefined || entry === null ||
      typeof entry !== "object" ||
      typeof entry.size !== "number" ||
      typeof entry.checksum !== "string" ||
      !/^sha256-[0-9a-f]{64}$/i.test(entry.checksum)
    ) {
      fail(
        "jsr_manifest_mismatch",
        { path: jsrPath, reason: "invalid manifest entry" },
        "Each JSR manifest entry must include size and checksum.",
      );
    }
    const bytes = await git.readFile(commit, path);
    if (!bytes || bytes.byteLength !== entry.size) {
      fail(
        "jsr_manifest_mismatch",
        {
          path: jsrPath,
          commit,
          expectedSize: entry.size,
          actualSize: bytes?.byteLength ?? null,
        },
        "Remote JSR content must correspond to the tagged source commit.",
      );
    }
    const checksum = `sha256-${await sha256Hex(bytes)}`;
    if (checksum !== entry.checksum.toLowerCase()) {
      fail(
        "jsr_manifest_mismatch",
        {
          path: jsrPath,
          commit,
          expectedChecksum: entry.checksum,
          actualChecksum: checksum,
        },
        "Remote JSR content must correspond to the tagged source commit.",
      );
    }
  }
}

function gitPathFromJsr(jsrPath: string): string {
  if (!jsrPath.startsWith("/") || jsrPath.includes("\0") || jsrPath.includes("//")) {
    fail(
      "jsr_manifest_mismatch",
      { path: jsrPath, reason: "unsafe path" },
      "JSR manifest paths must be package-root relative.",
    );
  }
  const path = jsrPath.slice(1);
  if (
    path === "" || path.startsWith("/") ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    fail(
      "jsr_manifest_mismatch",
      { path: jsrPath, reason: "unsafe path" },
      "JSR manifest paths must be package-root relative.",
    );
  }
  return path;
}

async function fetchOciIndex(
  deps: VerifyDeps,
  tag: string,
  token: { value?: string },
): Promise<{ digest: string; body: OciIndex }> {
  const bearer = await ghcrToken(deps, token, false);
  const result = await requireOk(
    deps.fetch,
    `${MANIFESTS}/${tag}`,
    { Accept: INDEX_TYPES.join(", "), Authorization: `Bearer ${bearer}` },
    "oci_unavailable",
    { image: PUBLISHED_IMAGE, tag },
  );
  const digest = await assertDigest(result, INDEX_TYPES);
  const body = parseObject(result.bytes, "oci_unavailable", { ref: tag });
  if (typeof body.mediaType !== "string" || !INDEX_TYPES.includes(body.mediaType)) {
    fail(
      "oci_digest_mismatch",
      { mediaType: body.mediaType, expected: INDEX_TYPES },
      "The GHCR tag must resolve to an image index.",
    );
  }
  if (!Array.isArray(body.manifests)) {
    fail(
      "oci_platform_missing",
      { reason: "index manifests missing" },
      "The GHCR index must list per-platform manifests.",
    );
  }
  return { digest, body: body as unknown as OciIndex };
}

async function readPlatformConfigs(
  deps: VerifyDeps,
  index: OciIndex,
  commit: string,
  version: string,
  token: { value?: string },
): Promise<PublishedPlatform[]> {
  const bearer = await ghcrToken(deps, token, false);
  const found = new Map<string, PublishedPlatform>();
  for (const entry of index.manifests) {
    const platform = entry.platform;
    if (
      !platform || typeof platform.os !== "string" ||
      typeof platform.architecture !== "string" ||
      platform.os === "unknown" || platform.architecture === "unknown"
    ) {
      continue;
    }
    const key = `${platform.os}/${platform.architecture}`;
    if (!(REQUIRED_PLATFORMS as readonly string[]).includes(key)) continue;
    if (found.has(key)) {
      fail(
        "oci_platform_missing",
        { platform: key, reason: "duplicate" },
        "The GHCR index must contain one manifest per required platform.",
      );
    }
    if (typeof entry.digest !== "string") {
      fail(
        "oci_digest_mismatch",
        { platform: key, reason: "missing digest" },
        "Each platform descriptor must include a digest.",
      );
    }
    const manifest = await fetchManifest(deps, entry.digest, bearer);
    const configDigest = manifest.config?.digest;
    if (typeof configDigest !== "string") {
      fail(
        "oci_digest_mismatch",
        { platform: key, reason: "missing config digest" },
        "Each platform manifest must include a config digest.",
      );
    }
    const config = await fetchConfig(deps, configDigest, bearer);
    if (config.os !== platform.os || config.architecture !== platform.architecture) {
      fail(
        "oci_platform_mismatch",
        {
          platform: key,
          expected: { os: platform.os, architecture: platform.architecture },
          actual: { os: config.os, architecture: config.architecture },
        },
        "Each image config os/architecture must match its index descriptor.",
      );
    }
    found.set(key, {
      os: platform.os,
      architecture: platform.architecture,
      manifestDigest: manifest.digest,
      configDigest,
      labels: readLabels(config, key, commit, version),
    });
  }
  return REQUIRED_PLATFORMS.map((name) => {
    const platform = found.get(name);
    if (!platform) {
      fail(
        "oci_platform_missing",
        { missing: [name] },
        "The GHCR index must include linux/amd64 and linux/arm64 image manifests.",
      );
    }
    return platform;
  });
}

function readLabels(
  config: Record<string, unknown>,
  platform: string,
  commit: string,
  version: string,
): PublishedPlatform["labels"] {
  const nested = config.config;
  const labels = nested !== null && typeof nested === "object"
    ? (nested as { Labels?: unknown }).Labels
    : undefined;
  if (labels === null || typeof labels !== "object") {
    fail(
      "oci_label_mismatch",
      { platform, reason: "labels missing" },
      "Each platform config must carry OCI source, revision, and version labels.",
    );
  }
  const record = labels as Record<string, unknown>;
  const source = record["org.opencontainers.image.source"];
  const revision = record["org.opencontainers.image.revision"];
  const imageVersion = record["org.opencontainers.image.version"];
  if (
    typeof source !== "string" ||
    typeof revision !== "string" ||
    typeof imageVersion !== "string" ||
    source !== PUBLISHED_SOURCE ||
    revision !== commit ||
    imageVersion !== version
  ) {
    fail(
      "oci_label_mismatch",
      {
        platform,
        expected: {
          "org.opencontainers.image.source": PUBLISHED_SOURCE,
          "org.opencontainers.image.revision": commit,
          "org.opencontainers.image.version": version,
        },
        actual: {
          "org.opencontainers.image.source": source,
          "org.opencontainers.image.revision": revision,
          "org.opencontainers.image.version": imageVersion,
        },
      },
      "Image source, revision, and version labels must match the tagged commit.",
    );
  }
  return {
    "org.opencontainers.image.source": source,
    "org.opencontainers.image.revision": revision,
    "org.opencontainers.image.version": imageVersion,
  };
}

async function fetchManifest(
  deps: VerifyDeps,
  digest: string,
  bearer: string,
): Promise<{ digest: string; config?: { digest?: string } }> {
  const result = await requireOk(
    deps.fetch,
    `${MANIFESTS}/${digest}`,
    { Accept: MANIFEST_TYPES.join(", "), Authorization: `Bearer ${bearer}` },
    "oci_unavailable",
    { digest },
  );
  const actual = await assertDigest(result, MANIFEST_TYPES, digest);
  const body = parseObject(result.bytes, "oci_digest_mismatch", { digest });
  return { digest: actual, config: (body as { config?: { digest?: string } }).config };
}

async function fetchConfig(
  deps: VerifyDeps,
  digest: string,
  bearer: string,
): Promise<Record<string, unknown>> {
  const result = await requireOk(
    deps.fetch,
    `${BLOBS}/${digest}`,
    {
      Accept: "application/vnd.oci.image.config.v1+json, application/octet-stream",
      Authorization: `Bearer ${bearer}`,
    },
    "oci_unavailable",
    { digest },
  );
  const actual = `sha256:${await sha256Hex(result.bytes)}`;
  if (actual !== digest.toLowerCase()) {
    fail(
      "oci_digest_mismatch",
      { expected: digest, actual },
      "The config blob bytes must match the requested digest.",
    );
  }
  const header = result.headers.get("docker-content-digest");
  if (header && normalizeDigest(header) !== actual) {
    fail(
      "oci_digest_mismatch",
      { expected: actual, header },
      "The config blob digest header must match the bytes.",
    );
  }
  return parseObject(result.bytes, "oci_digest_mismatch", { digest });
}

async function assertDigest(
  result: HttpBody,
  mediaTypes: string[],
  expected?: string,
): Promise<string> {
  const contentType = (result.headers.get("content-type") ?? "").split(";")[0]
    .trim();
  if (!mediaTypes.includes(contentType)) {
    fail(
      "oci_digest_mismatch",
      { contentType, expected: mediaTypes },
      "Registry manifest responses must use the OCI or Docker manifest content type.",
    );
  }
  const actual = `sha256:${await sha256Hex(result.bytes)}`;
  const header = result.headers.get("docker-content-digest");
  if (!header || normalizeDigest(header) !== actual) {
    fail(
      "oci_digest_mismatch",
      { header, actual },
      "Docker-Content-Digest must match the SHA-256 of the manifest bytes.",
    );
  }
  if (expected && normalizeDigest(expected) !== actual) {
    fail(
      "oci_digest_mismatch",
      { expected, actual },
      "The fetched manifest bytes must match the requested digest.",
    );
  }
  return actual;
}

function normalizeDigest(value: string): string | null {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(value.trim());
  return match ? `sha256:${match[1].toLowerCase()}` : null;
}

async function ghcrToken(
  deps: VerifyDeps,
  cache: { value?: string },
  optional: true,
): Promise<string | null>;
async function ghcrToken(
  deps: VerifyDeps,
  cache: { value?: string },
  optional: false,
): Promise<string>;
async function ghcrToken(
  deps: VerifyDeps,
  cache: { value?: string },
  optional: boolean,
): Promise<string | null> {
  if (cache.value) return cache.value;
  const raw = await timedGet(deps.fetch, TOKEN_URL, {
    Accept: "application/json",
  });
  const result = readyOrRetry(raw);
  if (!result) {
    if (optional) return null;
    fail(
      "oci_unavailable",
      { url: TOKEN_URL, reason: raw === "timeout" ? "timeout" : raw.status },
      "Anonymous public GHCR token exchange must succeed.",
    );
  }
  if (result.status !== 200) {
    fail(
      "oci_unavailable",
      { url: TOKEN_URL, status: result.status },
      "Anonymous public GHCR token exchange must succeed.",
    );
  }
  const body = parseObject(result.bytes, "oci_unavailable", { url: TOKEN_URL });
  const value = [body.token, body.access_token].find((item) =>
    typeof item === "string" && item.length > 0
  );
  if (typeof value !== "string") {
    fail(
      "oci_unavailable",
      { url: TOKEN_URL, reason: "token missing" },
      "Anonymous public GHCR token exchange must return a token.",
    );
  }
  cache.value = value;
  return value;
}

async function timedGet(
  fetchLike: FetchLike,
  url: string,
  headers: Record<string, string>,
): Promise<HttpBody | "timeout"> {
  try {
    const response = await fetchLike(url, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return {
      status: response.status,
      bytes: new Uint8Array(await response.arrayBuffer()),
      headers: response.headers,
    };
  } catch {
    return "timeout";
  }
}

function readyOrRetry(result: HttpBody | "timeout"): HttpBody | null {
  if (
    result === "timeout" ||
    result.status === 404 ||
    result.status === 429 ||
    result.status >= 500
  ) {
    return null;
  }
  return result;
}

async function getJson(
  fetchLike: FetchLike,
  url: string,
  unavailableCode: string,
  context: Record<string, unknown>,
  optional: boolean,
): Promise<Record<string, unknown> | null> {
  const result = readyOrRetry(
    await timedGet(fetchLike, url, { Accept: "application/json" }),
  );
  if (!result) {
    if (optional) return null;
    fail(
      unavailableCode,
      { ...context, url },
      "The remote metadata must be reachable.",
    );
  }
  if (result.status !== 200) {
    fail(
      unavailableCode,
      { ...context, url, status: result.status },
      "Anonymous public access is required.",
    );
  }
  return parseObject(result.bytes, "jsr_manifest_mismatch", { ...context, url });
}

async function requireOk(
  fetchLike: FetchLike,
  url: string,
  headers: Record<string, string>,
  code: string,
  context: Record<string, unknown>,
): Promise<HttpBody> {
  const result = await timedGet(fetchLike, url, headers);
  if (result === "timeout") {
    fail(code, { ...context, url, reason: "timeout" }, "HTTPS fetch timed out.");
  }
  if (result.status !== 200) {
    fail(
      code,
      { ...context, url, status: result.status },
      "HTTPS fetch must return 200.",
    );
  }
  return result;
}

function parseObject(
  bytes: Uint8Array,
  code: string,
  context: Record<string, unknown>,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail(code, { ...context, reason: "invalid JSON" }, "Remote JSON must parse.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(
      code,
      { ...context, reason: "expected object" },
      "Remote JSON must be an object.",
    );
  }
  return parsed as Record<string, unknown>;
}

export async function resolveTagCommit(tag: string, cwd = "."): Promise<string> {
  if (!TAG_PATTERN.test(tag)) {
    fail("tag_not_found", { gitTag: tag }, "Pass a v<major.minor.patch> tag.");
  }
  const output = await runGit(
    ["rev-parse", "--verify", "--end-of-options", `refs/tags/${tag}^{commit}`],
    cwd,
  );
  if (!output || !COMMIT_PATTERN.test(output.toLowerCase())) {
    fail(
      "tag_not_found",
      { gitTag: tag },
      "Resolve refs/tags/<tag>^{commit}; branches of the same name are not tags.",
    );
  }
  return output.toLowerCase();
}

async function gitReadFile(
  commit: string,
  path: string,
  cwd: string,
): Promise<Uint8Array | null> {
  if (!COMMIT_PATTERN.test(commit)) return null;
  return await runGitBytes(["show", "--end-of-options", `${commit}:${path}`], cwd);
}

async function runGit(args: string[], cwd: string): Promise<string | null> {
  const bytes = await runGitBytes(args, cwd);
  return bytes ? new TextDecoder().decode(bytes).trim() : null;
}

async function runGitBytes(
  args: string[],
  cwd: string,
): Promise<Uint8Array | null> {
  const result = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return result.code === 0 ? result.stdout : null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
