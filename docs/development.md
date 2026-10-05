# Development and release gates

## Prerequisites

- Deno `2.9.6`, matching CI and the release image
- ngspice on `PATH` for the native integration gate
- Git for source and bundle freshness checks

Viewer builds also use the exact split MCP View source pinned in the workflows at
`Casys-AI/mcp-server@b08802df353bb25d25a1c8d64b22ea61b5287ae0` (`@casys/mcp-view@0.9.3`,
`@casys/mcp-view-contracts@0.1.0`, `@casys/mcp-view-components@0.9.0`). The environment
variables `MCP_VIEW_LOCAL_ROOT`, `MCP_VIEW_CONTRACTS_LOCAL_ROOT`, and
`MCP_VIEW_COMPONENTS_LOCAL_ROOT` must point to that checkout; the UI build refuses any
other package identity or git revision.

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
deno task docs:viewer-screenshot   # only after a visible viewer change
```

The last task regenerates the README image from the committed MCS01 session fixture;
[viewers.md](viewers.md#screenshot-provenance) documents the harness and the capture
geometry. Commit the regenerated PNG with the viewer change it illustrates.

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

After that GHCR publish, the Docker workflow runs a fail-closed verifier. JSR may
already have been published from `main`; the verifier polls a bounded time until both
publication surfaces exist, then records and checks:

- the exact JSR version and the manifest checksums/sizes of `README.md` and `deno.json`
  against those two files in the tag, reported explicitly as `checkedFiles`;
- the exact GHCR tag and immutable OCI index digest (`Docker-Content-Digest` and the
  SHA-256 of the index bytes);
- each `linux/amd64` and `linux/arm64` image config's `os`/`architecture` plus
  `org.opencontainers.image.source`, `revision`, and `version` labels against that same
  commit.

JSR
[rewrites TypeScript imports during publication](https://jsr.io/docs/publishing-packages).
The verifier does not compare all TypeScript source bytes or independently attest the
JSR publishing commit. It checks the two unchanged JSR identity files and the GHCR
revision/version/platform identities.

A missing surface or a mismatch fails the job. The verifier never marks those cases
successful. Successful evidence is written to a JSON file and archived as a GitHub
Actions artifact. The workflow supplies the source URL and image from the reviewed
release context. For a historical release, pass its original coordinates explicitly, for
example the existing Casys `v0.6.4` release (with that tag available locally):

```bash
deno task verify:published --git-tag v0.6.4 \
  --expected-commit "$(git rev-parse --verify 'refs/tags/v0.6.4^{commit}')" \
  --expected-source https://github.com/Casys-AI/mcp-spice \
  --image ghcr.io/casys-ai/mcp-spice
```

Deployment examples keep the digest-pinned form
`ghcr.io/casys-ai/mcp-spice@sha256:<verified-index-digest>`. Fill that placeholder from
the verifier evidence after an approved tag publish. This tree does not bake in a
previous release's digest or treat a mutable version tag as the runtime identity.

The tag must exactly match `deno.json`. Do not reuse a published JSR version or move a
release tag.
