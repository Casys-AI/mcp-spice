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

Every `viewer.session.apply` payload reaches the App's strict gate, which checks the
closed envelope, recomputes the projection digest, and — for admitted artifacts — the
artifact fingerprint and ID. Recorded values are mapped only after those checks; a
payload that fails any of them is shown as a `Session rejected` status, never dropped.

The operating-point App additionally accepts exact persisted
`spice-operating-point-result/1.0` and `spice-admitted-execution-capture/1.0` artifacts.
These are Digital Thread records, not rewritten mcp-spice tool results. Their source
schema remains visible in the UI.

## Screenshot provenance

The README image is a reproducible capture of the built `ui://mcp-spice/operating-point`
App, not a hand-taken screenshot. Its input is the session the Digital Thread registered
for the MCS01 admitted operating point, committed verbatim as
`docs/fixtures/mcs01-recorded-operating-point-session.json`:

| Identity       | Value                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| project        | `motorized-camera-slider-mcs01@r150`                                                                                        |
| thread         | `project:motorized-camera-slider-mcs01:r21:decide-accept-admitted-spice-evaluation-run:queue-mcs01-spice-closeout-r146@r21` |
| artifact       | `spice-admitted-result-3a789bd0d0c8c9a291c6b309574a183b9ce49c144916f3e363be4af167d9843b`                                    |
| result schema  | `spice-operating-point-result/1.0`                                                                                          |
| session schema | `io.casys.mcp-spice.recorded-operating-point-session/1.0`                                                                   |

The App, session and bundle rows of that registration are the Digital Thread's own
record; they are not carried inside the session envelope. `tests/viewer_docs_test.ts`
runs the fixture through the App's strict session gate, so a drifted digest or a
rewritten basis fails the suite rather than the picture.

`docs/fixtures/viewer-preview.html` is a minimal MCP Apps host: it answers
`ui/initialize` with an `en` locale, a light theme and a 760 px inline container, then
posts the fixture as `viewer.session.apply`. Regenerate the image with:

```bash
deno task build:ui
deno task docs:viewer-screenshot   # CHROME_BIN, optional FFMPEG_BIN
```

The task serves the repository over loopback, renders the harness in headless Chrome at
900×640 CSS px, 2× device scale and `--lang=en-US`, then re-encodes the PNG when
`ffmpeg` is available. The image therefore shows the checked-out bundle rendering the
registered payload; the App version the Thread recorded at registration time may be
older than the bundle that produced the picture. No values were invented for the
capture.

## Rebuild rule

The served artifacts are the single-file HTML documents under `src/ui/dist/`, not the
TSX source. After any viewer or shared-component change, run:

```bash
deno task build:ui
deno task test:ui
deno task check:ui:bundle
```

The bundle check verifies that committed HTML is fresh relative to the sources.
