# MCP Apps and recorded viewer sessions

`mcp-spice` ships small whole-view MCP Apps for an operating point, reduced DC sweep,
reduced transient result, durable outcome, and documentary receipt. Each resource
renders one semantic object with shared `@casys/mcp-view-components` primitives.

The provider-owned manifest is exported as `@casys/mcp-spice/view-app-manifest` and
registered at `ui://mcp-spice/app-manifest`. Its whole-view resources are:

- `ui://mcp-spice/operating-point`
- `ui://mcp-spice/dc-sweep`
- `ui://mcp-spice/transient-result`
- `ui://mcp-spice/simulation-outcome`
- `ui://mcp-spice/simulation-receipt`

`ngspice_netlist_submit` and dispatch recovery remain text-only because they do not
produce a visual business object.

## Live tool results

Hosts supporting MCP Apps receive the resource URI through the tool metadata and render
the exact structured result. Text content stays available as a fallback. The Apps do not
request raw curves or manufacture absent samples.

`succeeded` remains a provider execution state. The viewer never turns it into pass,
proof, compliance, or requirement satisfaction.

## Read-only recorded sessions

Every resource admits exactly one versioned `viewer.session.apply` schema. A recording
host must provide:

- the exact App and resource identity;
- a project, subject, and Thread basis;
- an exact artifact ID and SHA-256 fingerprint;
- the unmodified structured artifact bytes;
- a projection fingerprint over the complete canonical read model.

The App validates the closed envelope synchronously before it connects, then verifies
the projection digest before exposing data. Recorded values are mapped only after those
checks.

The operating-point App additionally accepts exact persisted
`spice-operating-point-result/1.0` and `spice-admitted-execution-capture/1.0` artifacts.
These are Digital Thread records, not rewritten mcp-spice tool results. Their source
schema remains visible in the UI.

## Screenshot provenance

The README screenshot was captured from the built `ui://mcp-spice/operating-point` App
through the Digital Thread read-only MCP App host. Its payload came from the registered
result:

```text
project:  motorized-camera-slider-mcs01@r150
thread:   project:motorized-camera-slider-mcs01:r21:decide-accept-admitted-spice-evaluation-run:queue-mcs01-spice-closeout-r146
artifact: spice-admitted-result-3a789bd0d0c8c9a291c6b309574a183b9ce49c144916f3e363be4af167d9843b
schema:   spice-operating-point-result/1.0
```

No values were invented for the capture. The screenshot is an optimized PNG of the
actual rendered App.

## Rebuild rule

The served artifacts are the single-file HTML documents under `src/ui/dist/`, not the
TSX source. After any viewer or shared-component change, run:

```bash
deno task build:ui
deno task test:ui
deno task check:ui:bundle
```

The bundle check verifies that committed HTML is fresh relative to the sources.
