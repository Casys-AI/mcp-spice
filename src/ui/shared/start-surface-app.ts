import { createMcpApp, defineView } from "@casys/mcp-view";
import {
  activeComponentSurface,
  applySurfaceContext,
  componentCatalogCapabilities,
  type ComponentSurface,
  installMcpViewTheme,
  type McpViewHostContext,
  mountComponentSurface,
  type MountedComponentSurface,
  type ViewComponentRegistry,
} from "@casys/mcp-view-components";
import {
  type PresentationTone,
  StateMessage,
} from "@casys/mcp-view-components/preact/components";
import { createElement, render } from "preact";
export type SurfaceDisplayState<TData> =
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "result"; readonly result: TData };

export interface SpiceSurfaceAppOptions<TData, TSession = never> {
  readonly root: HTMLElement;
  readonly info: { readonly name: string; readonly version: string };
  readonly registry: ViewComponentRegistry<TData>;
  readonly loadingLabel: string;
  readonly emptyLabel: string;
  readonly fromToolResult: (value: unknown) => SurfaceDisplayState<TData>;
  /** App-owned validator for the whole-resource recorded-session action. */
  readonly validateSession?: (value: unknown) => value is TSession;
  /** Map one validated session to the same mono-object model as a tool result. */
  readonly mapSessionToData?: (session: TSession) => TData | Promise<TData>;
  readonly surfaceClassName?: string;
}

export async function startSpiceSurfaceApp<TData, TSession = never>(
  options: SpiceSurfaceAppOptions<TData, TSession>,
): Promise<void> {
  const sessionEnabled = options.validateSession !== undefined ||
    options.mapSessionToData !== undefined;
  if (sessionEnabled && (!options.validateSession || !options.mapSessionToData)) {
    throw new TypeError(
      "startSpiceSurfaceApp requires both validateSession and mapSessionToData",
    );
  }
  const validateSession = options.validateSession;
  const mapSessionToData = options.mapSessionToData;
  installMcpViewTheme();
  const state: Record<string, never> = {};
  let mounted: MountedComponentSurface | undefined;
  let pendingMount: Promise<void> | undefined;
  let mountGeneration = 0;
  let currentResult: TData | undefined;
  let removeHostContextListener: (() => void) | undefined;

  const reportError = (error: unknown): void => {
    console.error("[mcp-spice] View projection failed", error);
  };

  const disposeSurface = async (): Promise<void> => {
    mountGeneration += 1;
    await pendingMount;
    pendingMount = undefined;
    const active = mounted;
    mounted = undefined;
    await active?.dispose();
  };

  const status = defineView<
    Record<string, never>,
    SurfaceDisplayState<TData>,
    SurfaceDisplayState<TData>
  >({
    onEnter: (_context, next) => {
      currentResult = undefined;
      return next;
    },
    render(_context, next) {
      return renderStatus(next, options);
    },
    onLeave: disposeSurface,
  });

  const surface = defineView<Record<string, never>, TData, TData>({
    onEnter: (_context, data) => {
      currentResult = data;
      return data;
    },
    render(context, data) {
      const shell = document.createElement("div");
      shell.className = options.surfaceClassName ?? "spice-component-surface";
      const resolution = resolveSurface(options.registry, context.hostContext);
      if (!resolution.ok) {
        shell.replaceChildren(statusMessage(
          resolution.message,
          "danger",
          "error",
        ));
        return shell;
      }
      const generation = ++mountGeneration;
      pendingMount = mountComponentSurface({
        root: shell,
        registry: options.registry,
        data,
        appContext: context,
        hostContext: context.hostContext,
        surface: resolution.surface,
      }).then(async (next) => {
        if (generation !== mountGeneration) {
          await next.dispose();
          return;
        }
        mounted = next;
      }).catch((error) => {
        shell.replaceChildren(statusMessage(
          `The component surface failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "danger",
          "error",
        ));
        reportError(error);
      });
      return shell;
    },
    onLeave: disposeSurface,
  });

  const handle = await createMcpApp<Record<string, never>, TSession>({
    info: options.info,
    root: options.root,
    strict: true,
    views: { status, surface },
    initialView: "status",
    initialArgs: { kind: "loading" } satisfies SurfaceDisplayState<TData>,
    initialState: state,
    ...(validateSession && mapSessionToData
      ? {
        viewerSession: {
          validate: validateSession,
          onSession: async (session, _payload, app) => {
            const data = await mapSessionToData(session);
            await app.navigate("surface", data);
          },
          onError: reportError,
        },
      }
      : {}),
    capabilities: {
      experimental: componentCatalogCapabilities(options.registry),
    },
    onToolInputPartial: async (_params, app) => {
      await app.navigate(
        "status",
        {
          kind: "loading",
        } satisfies SurfaceDisplayState<TData>,
      );
    },
    onToolResult: async (result, app) => {
      const next = options.fromToolResult(result);
      await showDisplayState(app.navigate, next);
    },
    onTeardown: async () => {
      removeHostContextListener?.();
      removeHostContextListener = undefined;
      currentResult = undefined;
      await disposeSurface();
    },
  });

  const onHostContextChanged = (): void => {
    applySurfaceContext(handle.ctx.hostContext, document.documentElement);
    if (!currentResult || handle.currentView !== "surface") return;
    void handle.navigate("surface", currentResult).catch(reportError);
  };
  handle.ctx.app.addEventListener("hostcontextchanged", onHostContextChanged);
  applySurfaceContext(handle.ctx.hostContext, document.documentElement);
  removeHostContextListener = () => {
    handle.ctx.app.removeEventListener(
      "hostcontextchanged",
      onHostContextChanged,
    );
  };
}

export function resolveSurface<TData>(
  registry: ViewComponentRegistry<TData>,
  hostContext: McpViewHostContext,
):
  | { readonly ok: true; readonly surface: ComponentSurface }
  | { readonly ok: false; readonly message: string } {
  try {
    const surface = activeComponentSurface(registry, hostContext);
    return surface ? { ok: true, surface } : {
      ok: false,
      message: "This App exposes components and requires a host-selected surface.",
    };
  } catch (error) {
    return {
      ok: false,
      message: `The host-selected component surface is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

async function showDisplayState<TData>(
  navigate: (name: string, args?: unknown) => Promise<void>,
  state: SurfaceDisplayState<TData>,
): Promise<void> {
  if (state.kind === "result") {
    await navigate("surface", state.result);
    return;
  }
  await navigate("status", state);
}

function renderStatus<TData, TSession>(
  state: SurfaceDisplayState<TData>,
  options: SpiceSurfaceAppOptions<TData, TSession>,
): HTMLElement {
  switch (state.kind) {
    case "loading":
      return statusMessage(options.loadingLabel, "info", "Loading", true);
    case "empty":
      return statusMessage(options.emptyLabel, "neutral", "Empty");
    case "error":
      return statusMessage(state.message, "danger", "error");
    case "result":
      throw new TypeError(
        "Result data must render through the component surface.",
      );
  }
}

function statusMessage(
  detail: string,
  tone: PresentationTone,
  title?: string,
  busy = false,
): HTMLElement {
  const node = document.createElement("div");
  node.className = "spice-viewer-state";
  render(
    createElement(StateMessage, { busy, title, tone }, detail),
    node,
  );
  return node;
}
