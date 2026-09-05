/**
 * Minimal `createMcpApp` stand-in for Surface App lifecycle tests.
 * Mirrors the kit runtime where the theme/locale remount decision depends on it.
 */

import { assert } from "@std/assert";
import type { AppConfig, AppHandle, ViewDefinition } from "@casys/mcp-view";
import type { SurfaceAppRuntime } from "@casys/mcp-view-components/preact";

export async function withDocument(
  fn: (root: HTMLElement) => Promise<void>,
): Promise<void> {
  const { parseHTML } = await import("linkedom");
  const dom = parseHTML("<html><body><div id=root></div></body></html>");
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.document,
  });
  try {
    await fn(dom.document.getElementById("root") as unknown as HTMLElement);
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
  }
}

export interface FakeApp {
  readonly runtime: SurfaceAppRuntime;
  hostContextChanged(params?: Record<string, unknown>): void;
  toolResult(result: unknown): Promise<void>;
  idle(): Promise<void>;
}

export function fakeApp(
  root: HTMLElement,
  options: { hostContext?: Record<string, unknown> } = {},
): FakeApp {
  let hostContext: Record<string, unknown> = { ...(options.hostContext ?? {}) };
  let config: AppConfig<unknown, unknown> | undefined;
  let handle: AppHandle<unknown> | undefined;
  const listeners = new Map<string, Set<() => void>>();
  let queue: Promise<void> = Promise.resolve();
  let notifications: Promise<void> = Promise.resolve();
  const app = {
    addEventListener(name: string, listener: () => void) {
      listeners.set(name, (listeners.get(name) ?? new Set()).add(listener));
    },
    removeEventListener(name: string, listener: () => void) {
      listeners.get(name)?.delete(listener);
    },
    readServerResource(params: { uri: string }) {
      return Promise.resolve({
        contents: [{ uri: params.uri, text: "resource" }],
      });
    },
  };
  const current = () => {
    assert(handle && config, "the App was not created");
    return { handle, config };
  };
  const notify = (run: () => Promise<void> | void): Promise<void> => {
    const next = notifications.then(run);
    notifications = next.catch(() => {});
    return next;
  };
  const createApp = async (next: AppConfig<unknown, unknown>) => {
    config = next;
    let currentView: string | undefined;
    const views = next.views as Record<
      string,
      ViewDefinition<unknown, unknown, unknown>
    >;
    const ctx = {
      get hostContext() {
        return hostContext;
      },
      state: next.initialState,
      app,
      navigate: (name: string, args?: unknown) => goto(name, args),
    } as unknown as AppHandle<unknown>["ctx"];
    const leave = async (): Promise<void> => {
      const leaving = currentView;
      currentView = undefined;
      if (!leaving) return;
      await views[leaving]?.onLeave?.(ctx);
    };
    const transition = async (name: string, args?: unknown): Promise<void> => {
      await leave();
      const view = views[name];
      if (!view) throw new Error(`Unknown view ${name}`);
      const data = await view.onEnter?.(ctx, args);
      const output = view.render(ctx, data);
      root.replaceChildren(
        typeof output === "string" ? document.createTextNode(output) : output,
      );
      currentView = name;
    };
    let routerDisposed = false;
    const goto = (name: string, args?: unknown): Promise<void> => {
      if (routerDisposed) {
        return Promise.reject(new Error("Router has been disposed"));
      }
      queue = queue.then(() => transition(name, args), () => transition(name, args));
      return queue;
    };
    let teardownPromise: Promise<void> | undefined;
    const teardown = (reason: "host" | "dispose"): Promise<void> =>
      teardownPromise ??= (async () => {
        try {
          await next.onTeardown?.(handle!, reason);
        } finally {
          await queue.catch(() => {});
          routerDisposed = true;
          await leave();
        }
      })();
    await goto(next.initialView, next.initialArgs);
    handle = {
      ctx,
      get currentView() {
        if (currentView === undefined) {
          throw new Error("Router.currentView read mid-transition");
        }
        return currentView;
      },
      navigate: goto,
      dispose: () => teardown("dispose"),
    };
    return handle;
  };
  return {
    runtime: { createApp: createApp as SurfaceAppRuntime["createApp"] },
    toolResult: (result) =>
      notify(() => current().config.onToolResult?.(result as never, current().handle)),
    hostContextChanged: (params = {}) => {
      hostContext = { ...hostContext, ...params };
      for (const listener of listeners.get("hostcontextchanged") ?? []) {
        listener();
      }
    },
    idle: () => queue,
  };
}

export async function until(
  condition: () => boolean,
  what: string,
): Promise<void> {
  for (let i = 0; i < 64; i += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  assert(condition(), `timed out waiting for ${what}`);
}
