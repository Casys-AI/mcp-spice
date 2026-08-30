/**
 * Read one immutable store object without reopening its caller-controlled path.
 *
 * The store publication paths already require hardlinks. A fresh hardlink in
 * the store root therefore pins the source inode before any metadata or bytes
 * are read. The unpredictable link name keeps the lstat/open window detached
 * from the source pathname; callers still validate the returned exact bytes.
 */

import { isAbsolute, join, relative } from "@std/path";

export type ImmutableFileReadReason =
  | "not_regular_file"
  | "too_large"
  | "outside_store_root"
  | "unsafe_parent"
  | "changed_during_read"
  | "content_mismatch";

export interface ImmutableFileReadOptions {
  root: string;
  sourcePath: string;
  maxBytes: number;
  expectedBytes?: Uint8Array;
  fail(reason: ImmutableFileReadReason, byteCount?: number): Error;
}

export async function readImmutableFileWithinLimit(
  options: ImmutableFileReadOptions,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer.");
  }
  const pinName = `.tmp-read-${crypto.randomUUID()}`;
  const pinPath = join(options.root, pinName);
  let linked = false;
  try {
    const parents = await snapshotParentChain(options);
    const sourceBeforeLink = await Deno.lstat(options.sourcePath);
    if (!sourceBeforeLink.isFile || sourceBeforeLink.isSymlink) {
      throw options.fail("not_regular_file", sourceBeforeLink.size);
    }
    if (sourceBeforeLink.size > options.maxBytes) {
      throw options.fail("too_large", sourceBeforeLink.size);
    }
    await Deno.link(options.sourcePath, pinPath);
    linked = true;
    // Do not open a FIFO or other special object merely to inspect it. This
    // small lstat is the only pathname check before immediately pinning the
    // regular file through its descriptor below.
    const pinnedBeforeOpen = await Deno.lstat(pinPath);
    if (!pinnedBeforeOpen.isFile || pinnedBeforeOpen.isSymlink) {
      throw options.fail("not_regular_file", pinnedBeforeOpen.size);
    }
    if (pinnedBeforeOpen.size > options.maxBytes) {
      throw options.fail("too_large", pinnedBeforeOpen.size);
    }
    if (
      !sameIdentityWhenAvailable(sourceBeforeLink, pinnedBeforeOpen, pinnedBeforeOpen)
    ) {
      throw options.fail("changed_during_read", pinnedBeforeOpen.size);
    }
    const file = await Deno.open(pinPath, { read: true });
    try {
      const openedBefore = await file.stat();
      if (!openedBefore.isFile || openedBefore.isSymlink) {
        throw options.fail("changed_during_read", openedBefore.size);
      }
      if (openedBefore.size > options.maxBytes) {
        throw options.fail("too_large", openedBefore.size);
      }

      const afterLinkParents = await snapshotParentChain(options);
      if (!sameParentChain(parents, afterLinkParents)) {
        throw options.fail("changed_during_read");
      }
      const pinned = await Deno.lstat(pinPath);
      if (!pinned.isFile || pinned.isSymlink || pinned.size !== openedBefore.size) {
        throw options.fail("changed_during_read", pinned.size);
      }
      const [realRoot, pinRealPath] = await Promise.all([
        Deno.realPath(options.root),
        Deno.realPath(pinPath),
      ]);
      if (pinRealPath !== join(realRoot, pinName)) {
        throw options.fail("outside_store_root", pinned.size);
      }
      if (!sameIdentityWhenAvailable(pinned, openedBefore, pinned)) {
        throw options.fail("changed_during_read", pinned.size);
      }
      await assertPinnedSourceMatches(options, afterLinkParents, openedBefore);

      // POSIX keeps this descriptor usable after unlink. Windows may refuse an
      // unlink of an open file, so retain the name there and verify it below.
      let unlinked = false;
      try {
        await Deno.remove(pinPath);
        linked = false;
        unlinked = true;
      } catch {
        /* Keep the pin until cleanup on platforms with sharing restrictions. */
      }

      const bytes = await readFileWithinLimit(file, options.maxBytes, options.fail);
      const openedAfter = await file.stat();
      if (
        !openedAfter.isFile || openedAfter.isSymlink ||
        openedAfter.size !== bytes.length ||
        !sameIdentityWhenAvailable(openedBefore, openedBefore, openedAfter)
      ) {
        throw options.fail("changed_during_read", openedAfter.size);
      }
      if (!unlinked) {
        const after = await Deno.lstat(pinPath);
        if (!after.isFile || after.isSymlink || after.size !== bytes.length) {
          throw options.fail("changed_during_read", after.size);
        }
        const [afterRealRoot, afterRealPath] = await Promise.all([
          Deno.realPath(options.root),
          Deno.realPath(pinPath),
        ]);
        if (
          afterRealPath !== pinRealPath ||
          afterRealPath !== join(afterRealRoot, pinName) ||
          !sameIdentityWhenAvailable(openedBefore, openedAfter, after)
        ) {
          throw options.fail("changed_during_read", after.size);
        }
      }
      if (!sameParentChain(parents, await snapshotParentChain(options))) {
        throw options.fail("changed_during_read", openedAfter.size);
      }
      if (
        options.expectedBytes !== undefined &&
        !equalBytes(bytes, options.expectedBytes)
      ) {
        throw options.fail("content_mismatch", bytes.length);
      }
      return bytes;
    } finally {
      file.close();
    }
  } finally {
    if (linked) await Deno.remove(pinPath).catch(() => {});
  }
}

interface ParentChainSnapshot {
  readonly infos: Deno.FileInfo[];
  readonly realPaths: string[];
  readonly expectedSourcePath: string;
}

async function snapshotParentChain(
  options: ImmutableFileReadOptions,
): Promise<ParentChainSnapshot> {
  const sourceRelative = relative(options.root, options.sourcePath);
  if (
    !sourceRelative || isAbsolute(sourceRelative) || sourceRelative === ".." ||
    sourceRelative.startsWith("../") || sourceRelative.startsWith("..\\")
  ) {
    throw options.fail("outside_store_root");
  }
  const components = sourceRelative.split(/[\\/]/);
  if (
    components.some((component) =>
      !component || component === "." || component === ".."
    )
  ) {
    throw options.fail("outside_store_root");
  }

  const infos: Deno.FileInfo[] = [];
  const realPaths: string[] = [];
  let logicalPath = options.root;
  const parentComponents = components.slice(0, -1);
  for (let index = 0; index <= parentComponents.length; index++) {
    const component = parentComponents[index - 1];
    if (component !== undefined) logicalPath = join(logicalPath, component);
    const info = await Deno.lstat(logicalPath);
    if (!info.isDirectory || info.isSymlink) {
      throw options.fail("unsafe_parent");
    }
    const realPath = await Deno.realPath(logicalPath);
    if (
      component !== undefined &&
      realPath !== join(realPaths[realPaths.length - 1], component)
    ) {
      throw options.fail("unsafe_parent");
    }
    infos.push(info);
    realPaths.push(realPath);
  }
  return {
    infos,
    realPaths,
    expectedSourcePath: join(realPaths[realPaths.length - 1], components.at(-1)!),
  };
}

function sameParentChain(
  before: ParentChainSnapshot,
  after: ParentChainSnapshot,
): boolean {
  if (
    before.infos.length !== after.infos.length ||
    before.realPaths.length !== after.realPaths.length ||
    before.expectedSourcePath !== after.expectedSourcePath ||
    before.realPaths.some((path, index) => path !== after.realPaths[index])
  ) {
    return false;
  }
  return before.infos.every((info, index) =>
    sameIdentityWhenAvailable(info, after.infos[index], after.infos[index])
  );
}

/**
 * A second lstat of the leaf never opens or reads its caller-controlled path.
 * It only proves that the freshly linked inode still belongs to the validated
 * parent chain, closing the transient-parent-symlink window around Deno.link.
 */
async function assertPinnedSourceMatches(
  options: ImmutableFileReadOptions,
  parents: ParentChainSnapshot,
  pinned: Deno.FileInfo,
): Promise<void> {
  const source = await Deno.lstat(options.sourcePath);
  if (!source.isFile || source.isSymlink || source.size !== pinned.size) {
    throw options.fail(
      !source.isFile || source.isSymlink ? "not_regular_file" : "changed_during_read",
      source.size,
    );
  }
  if (await Deno.realPath(options.sourcePath) !== parents.expectedSourcePath) {
    throw options.fail("changed_during_read", source.size);
  }
  if (!sameIdentityWhenAvailable(pinned, source, pinned)) {
    throw options.fail("changed_during_read", source.size);
  }
}

async function readFileWithinLimit(
  file: Deno.FsFile,
  maxBytes: number,
  fail: ImmutableFileReadOptions["fail"],
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  const buffer = new Uint8Array(Math.min(64 * 1024, Math.max(1, maxBytes + 1)));
  while (true) {
    const remaining = maxBytes + 1 - byteCount;
    const read = await file.read(
      buffer.subarray(0, Math.min(buffer.length, remaining)),
    );
    if (read === null) break;
    if (read === 0) continue;
    byteCount += read;
    if (byteCount > maxBytes) throw fail("too_large", byteCount);
    chunks.push(buffer.slice(0, read));
  }
  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function sameIdentityWhenAvailable(
  before: Deno.FileInfo,
  opened: Deno.FileInfo,
  after: Deno.FileInfo,
): boolean {
  const infos = [before, opened, after];
  if (infos.some((info) => info.dev === null || info.ino === null)) return true;
  return infos.every((info) => info.dev === before.dev && info.ino === before.ino);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
