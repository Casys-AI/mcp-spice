# Development and release gates

## Prerequisites

- Deno `2.9.6`, matching CI and the release image
- ngspice on `PATH` for the native integration gate
- Git for source and bundle freshness checks

Viewer builds also use the exact split MCP View source pinned in the workflows. The
environment variables `MCP_VIEW_LOCAL_ROOT`, `MCP_VIEW_CONTRACTS_LOCAL_ROOT`, and
`MCP_VIEW_COMPONENTS_LOCAL_ROOT` may point to a reviewed local checkout.

## Source loop

```bash
deno task serve
```

For source-only changes, use the smallest relevant checks. Before a release, run the
complete repository gate with a private writable store:

```bash
NGSPICE_RUNS_DIR="$(mktemp -d)" SPICE_RUN_NATIVE=1 deno task release:check
```

`release:check` verifies formatting, type checking, linting, deterministic tests, UI
tests, and committed single-file bundle freshness.

## Viewer loop

Edit the TSX or shared viewer modules, then rebuild the actual served resources:

```bash
deno task build:ui
deno task test:ui
deno task check:ui:bundle
```

The provider manifest is generated from the same App constants and committed at
`src/ui/view-app-manifest.json`. Do not hand-edit a generated bundle or substitute a
different manifest identity.

## Native fixtures

Fixtures under `tests/fixtures/` are outputs from a real ngspice baseline. Regenerate
them with `scripts/gen_fixtures.ts` in a reviewed environment; do not author numerical
engine output by hand.

## Publication

A push to `main` runs the native release gate and publishes a new immutable JSR version
when the version is not already present. A matching `v<version>` tag runs the native
gate again, then builds and publishes the multi-architecture GHCR image.

The tag must exactly match `deno.json`. Do not reuse a published JSR version or move a
release tag.
