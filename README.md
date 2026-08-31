# mcp-spice

An MCP server for running bounded SPICE circuit analyses with ngspice and returning
compact, structured results tied to the exact input bytes.

[JSR package](https://jsr.io/@casys/mcp-spice) ·
[container image](https://github.com/Casys-AI/mcp-spice/pkgs/container/mcp-spice) ·
[changelog](CHANGELOG.md) · [security policy](SECURITY.md)

**Release status.** Version `0.6.0` is published on JSR and as a native-gated,
multi-architecture GHCR image. The immutable OCI index digest is
`sha256:5991ad186da859b66dda078e0c80ce76765d544c920e38beafa48bba77744873`. The main
workflow qualified the exact JSR package; the `v0.6.0` tag separately qualified and
published the image.

Historical 0.3.0 context: that release's JSR package and digest-pinned image had package
version `0.3.0`, but leftover `VERSION` `0.1.0` in `server.ts` meant `server/discover`
and `/health` reported runtime identity `0.1.0`. 0.3.0 `spice_simulate_op` required
`nodes[]`, rejected `branch_sources`, and did not return `branch_currents_a`.

A client can send a netlist directly over MCP. The server computes its SHA-256, applies
the netlist security policy, stores the bytes under that digest, and returns a reusable
content-addressed reference. A client may additionally assert an expected digest; a
mismatch is refused before any write. A shared host filesystem or `docker exec` is not
required for the normal workflow.

The current source checkout can:

- admit exact UTF-8 circuit netlists into an immutable, content-addressed store, with an
  optional expected SHA-256 assertion;
- run a DC operating point and return requested node voltages and requested
  voltage-source branch currents;
- run a transient analysis and return requested voltage and branch-current min/max/final
  summaries with extrema and final-sample timestamps;
- run a bounded DC sweep over one named voltage source and return reduced voltage and
  branch-current summaries rather than a raw transfer curve;
- attest every consumed netlist with its SHA-256 and byte length;
- publish immutable documentary receipts and bounded-result records that survive a
  process or container restart, with exact readback by SHA-256;
- serve stateless MCP over HTTP or framework-native, era-aware stdio.

`mcp-spice` is a numerical engine. It reports observations and declared analysis limits;
it does not decide whether a circuit satisfies a requirement.

## Quick start

### Published 0.6.0 Docker image

The `v0.6.0` release workflow built the image for amd64 and arm64, ran the native
ngspice suite, and published the digest-pinned image below. Its entrypoint is
`./docker-entrypoint.sh` and its `CMD` is `http`; the command therefore starts the
stateless HTTP transport. The image contains Deno 2.9.6 and the tested ngspice 44.2
baseline. The named volume preserves submitted netlists and documentary simulation
records across container restarts.

```bash
docker run --rm \
  -p 127.0.0.1:3023:3023 \
  -v mcp-spice-runs:/ngspice-runs \
  ghcr.io/casys-ai/mcp-spice@sha256:5991ad186da859b66dda078e0c80ce76765d544c920e38beafa48bba77744873 http
```

The MCP endpoint is `http://127.0.0.1:3023/mcp`. This repository's native HTTP transport
is stateless MCP protocol `2026-07-28`. For example, a raw `tools/list` request is:

```bash
curl -sS -X POST http://127.0.0.1:3023/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

For a raw `tools/call` request, also set `Mcp-Name` to the exact tool name in
`params.name`. Native stdio clients do not use this HTTP transport envelope.

The version tag identifies the release; the digest above is the immutable deployment
authority.

### Native stdio from source or published JSR 0.6.0

The source server uses the framework-native, era-aware stdio transport directly; the
published JSR 0.6.0 package uses the same path. Both accept the classic `2025-06-18`
initialize handshake and write only JSON-RPC messages to stdout. Running from a source
checkout still requires ngspice on `PATH`:

```bash
deno run --allow-all server.ts --stdio
```

The equivalent version-pinned JSR command is:

```bash
deno run --allow-all jsr:@casys/mcp-spice@0.6.0/server --stdio
```

The JSR module also requires an `ngspice` executable on `PATH`.

The published 0.6.0 image also runs native stdio when `stdio` is passed to Docker:

```bash
docker run --rm -i \
  -v mcp-spice-runs:/ngspice-runs \
  ghcr.io/casys-ai/mcp-spice@sha256:5991ad186da859b66dda078e0c80ce76765d544c920e38beafa48bba77744873 stdio
```

Passing `stdio` overrides the image's `CMD http`; it does not start an HTTP child.

### JSR or a source checkout

Running the server module from JSR still requires an `ngspice` executable on `PATH`:

```bash
# macOS
brew install ngspice

# Debian / Ubuntu
sudo apt install ngspice

deno run --allow-all jsr:@casys/mcp-spice@0.6.0/server --port=3023
```

The version-pinned JSR command and source checkout are separate from the release image.
The shared versioned surface includes `execution-budgets/1.0`.

For local development from this source checkout:

```bash
deno task serve
```

or build a local container from these sources.

The server binds to `127.0.0.1:3023` by default. Use `--hostname`, `--port`,
`MCP_HOSTNAME`, or `MCP_PORT` to override it. The JSR package also exports
`createSpiceServer`, `SpiceToolsClient`, the tool registry, parsers, and the
content-addressed store helpers for embedding in a Deno application.

## MCP tools

The table below describes the 0.6.0 surface. Historical 0.3.0 context:
`spice_simulate_op` required `nodes[]`, rejected `branch_sources`, and did not return
`branch_currents_a`.

| Tool                            | Purpose                                       | Required input                                                                                                                                                        | Structured result                                                                                                            |
| ------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ngspice_netlist_submit`        | Verify, filter, and store exact netlist bytes | `netlist`; optional expected `netlist_sha256`                                                                                                                         | `sha256`, `bytes`, `uri`                                                                                                     |
| `spice_simulate_op`             | Run a DC operating point                      | `netlist_sha256` and at least one of `nodes[]` or `branch_sources[]`; optional `netlist_uri` or legacy `netlist_path`                                                 | `node_voltages`, `branch_currents_a`, `measurements`, `not_checked`, `input_artifact`, `documentary_receipt`                 |
| `spice_simulate_tran`           | Run a transient analysis                      | `netlist_sha256`, `tstep_s`, `tstop_s`, and at least one of `nodes[]` or `branch_sources[]`; optional `netlist_uri` or legacy `netlist_path`                          | `node_stats`, `branch_current_stats_a`, `measurements`, `simulation`, `not_checked`, `input_artifact`, `documentary_receipt` |
| `spice_simulate_dc`             | Run one bounded DC source sweep               | `netlist_sha256`, `sweep_source`, `start_v`, `stop_v`, `step_v`, and at least one of `nodes[]` or `branch_sources[]`; optional `netlist_uri` or legacy `netlist_path` | `node_stats`, `branch_current_stats_a`, `measurements`, `sweep`, `not_checked`, `input_artifact`, `documentary_receipt`      |
| `spice_simulation_receipt_get`  | Read one immutable documentary receipt        | `receipt_sha256`                                                                                                                                                      | Exact receipt after receipt/result/netlist rehash checks                                                                     |
| `spice_simulation_result_get`   | Read one immutable documentary outcome        | `outcome_sha256`                                                                                                                                                      | Exact bounded outcome after byte rehash                                                                                      |
| `spice_simulation_dispatch_get` | Inspect recovery state                        | `request_sha256`                                                                                                                                                      | Acknowledged request and optional terminal publication                                                                       |

MCP Apps hosts that understand `ui://` resources can render the simulation results and
documentary readback as compact MCP View v2 surfaces. The tools keep their existing
names, wire schemas, and text `content` fallback. `ngspice_netlist_submit` remains a
text confirmation. Full DC and transient curves are still not returned, so the viewers
do not invent plots or samples. `succeeded` remains `succeeded`; it is never shown as
pass, proof, or compliance.

Each registered operation is non-destructive, idempotent, and closed-world. Simulation
calls default to a 30-second timeout; `timeout_s` outside 1–300 seconds is refused. Both
source modes accept at most 1 MiB of netlist bytes. Each `nodes[]` and
`branch_sources[]` array accepts at most 32 names. Private transient and DC `wrdata`
files are each capped at 8 MiB before decoding; reduced transient statistics stop at
50,000 samples and DC statistics stop at 512 sweep points. ngspice stdout and stderr are
each capped at 1 MiB before diagnostic parsing.

## Durable documentary receipts and recovery

Every simulation first copies the exact private snapshot into the immutable netlist CAS,
including a legacy `netlist_path` call. Before the server starts ngspice, it writes an
immutable acknowledged dispatch record. A terminal run then publishes in this order:
immutable bounded outcome, immutable receipt, then an immutable publication record. The
last record is the only indication that the dispatch is terminal.

The receipt is canonical UTF-8 JSON addressed by its SHA-256. It binds the netlist
SHA-256, analysis kind, canonical normalized request (sorted unique selectors, resolved
timeout, and finite numeric arguments), exact provider/runtime identity, outcome
SHA-256, and terminal execution state (`succeeded` or `failed`). Runtime identity
includes the provider version, `execution-budgets/1.0`, Deno version and platform, and
the exact ngspice version-output digest. Caller paths, URIs, timestamps, and process
identifiers do not enter those identities.

The durable acknowledgement key is `request_sha256`: the hash of analysis kind, netlist
digest, and canonical normalized request only. Its dispatch document carries
`integrity_sha256` over the complete canonical body, including the exact runtime
identity; responses repeat that value as `dispatch_sha256`. This separates recovery from
integrity: a different provider, ngspice version output, provider version, or
execution-budget contract cannot mask a corrupt runtime record, but it also cannot
silently unblock or rerun an earlier ACK-only request. The no-rerun rule applies to a
`request_sha256` across restarts and runtime upgrades.

By default the named `NGSPICE_RUNS_DIR` volume contains separate immutable namespaces:

```text
inputs/<netlist sha256>
receipts/dispatches/<request sha256>
receipts/results/<outcome sha256>
receipts/receipts/<receipt sha256>
receipts/publications/<request sha256>
```

The `inputs/` and `receipts/` roots are private, server-owned storage on a
single/exclusive-writer volume. Bounded immutable snapshots fail closed for corrupt,
oversized, substituted, symlinked, FIFO, or other unsafe pre-existing objects. They do
not make a shared writable root safe against a concurrent actor already authorised to
modify it; deploy with filesystem permissions and volume ownership that exclude such
writers.

The normal simulation response adds `documentary_receipt`, with the dispatch, receipt,
and outcome identities. Its `input_artifact.source_path` is reconstructed from the
durable netlist digest; it is provider-local metadata and is deliberately not part of
the outcome digest. The existing reduced-result limits remain unchanged: raw transient
and DC data are not retained or exposed by this receipt contract.

`spice_simulation_receipt_get` rehashes the stored receipt and its linked outcome and
netlist before returning it. `spice_simulation_result_get` rehashes the exact canonical
outcome bytes before returning `result`; when applicable, its separate
`input_artifact_source_path` reconstructs provider-local input location without changing
those exact bytes. `spice_simulation_dispatch_get` exposes whether a dispatch is merely
acknowledged or has a terminal publication. Corrupt, missing, or non-canonical bytes are
typed failures; the server never silently reconstructs them.

If a restart finds an acknowledged dispatch without a publication, it returns
`simulation_dispatch_uncertain`. This state is deliberately fail-closed: the server does
not rerun automatically for that exact request identity, including after a runtime
upgrade. A known typed ngspice failure is terminally recorded as `failed` and is
replayed as the same typed MCP error, including its request, dispatch, receipt, and
outcome identities. A write that never reached the acknowledgement is absent and
therefore retryable. Inspect the request by identity and make any distinct follow-up
request deliberately.

The receipt layout must be writable before the acknowledgement. Containers use the named
`NGSPICE_RUNS_DIR` volume shown above. Native source and JSR runs must provide a
writable `NGSPICE_RUNS_DIR` (for both `inputs/` and `receipts/`) or an explicit writable
`SPICE_NETLIST_STORE`; when the latter is set, receipts are stored beside it in
`<dirname>/receipts/`. This also applies to legacy `netlist_path` calls because their
snapshot is copied into the immutable CAS before dispatch.

These records are documentary provider records only. They are not Digital Thread product
evidence, a requirement verdict, or a substitute for `simulate.run-admitted-spice@1`.

## End-to-end content-addressed workflow

The JSON snippets below are the `arguments` objects passed to the named MCP tools.

### 1. Submit the circuit

The server computes the SHA-256 of the exact UTF-8 string, including its final newline.
The normal MCP call therefore needs only the netlist:

```json
{
  "netlist": "Voltage Divider R1=1k R2=2k Vin=3V\nVin in 0 DC 3\nR1 in out 1000\nR2 out 0 2000\n.op\n.end\n"
}
```

Call `ngspice_netlist_submit`. It returns:

```json
{
  "sha256": "38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1",
  "bytes": 87,
  "uri": "spice-netlist:sha256:38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1"
}
```

Submitting the same bytes again is an idempotent no-op. To assert a precomputed digest,
add the optional `netlist_sha256` field; a mismatch is refused before any write. The
submitted and legacy-path netlist limit is 1 MiB. A forbidden construct, oversized
input, or attempt to replace different bytes at an existing digest is refused before a
mutable object can be exposed.

### 2. Run the operating point

Pass the returned digest and, optionally, its URI to `spice_simulate_op`. This call
requests node voltages only:

```json
{
  "netlist_sha256": "38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1",
  "netlist_uri": "spice-netlist:sha256:38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1",
  "nodes": ["out", "in"]
}
```

The structured result contains the requested voltages, the identity of the private
snapshot consumed by ngspice, and the durable documentary reference. This example
shortens the `not_checked` list and labels the four digest values for readability:

```json
{
  "node_voltages": { "out": 2, "in": 3 },
  "branch_currents_a": {},
  "measurements": {
    "out": { "value": 2 },
    "in": { "value": 3 }
  },
  "not_checked": [
    "Temperature: simulation runs at TNOM=27°C unless the netlist overrides .TEMP or .OPTIONS TNOM."
  ],
  "input_artifact": {
    "sha256": "38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1",
    "bytes": 87,
    "source_path": "/ngspice-runs/inputs/38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1"
  },
  "documentary_receipt": {
    "request_sha256": "<request sha256>",
    "dispatch_sha256": "<dispatch sha256>",
    "receipt_sha256": "<receipt sha256>",
    "outcome_sha256": "<outcome sha256>",
    "execution_state": "succeeded",
    "documentary_only": true
  }
}
```

`source_path` is provider-local provenance, not a path the client must be able to read.

#### Operating-point branch currents

The current surface accepts `branch_sources` and returns `branch_currents_a`:

```json
{
  "netlist_sha256": "38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1",
  "netlist_uri": "spice-netlist:sha256:38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1",
  "nodes": ["out", "in"],
  "branch_sources": ["Vin"]
}
```

The result includes `branch_currents_a` in addition to the voltage fields:

```json
{
  "node_voltages": { "out": 2, "in": 3 },
  "branch_currents_a": { "Vin": -0.001 },
  "measurements": {
    "out": { "value": 2 },
    "in": { "value": 3 }
  }
}
```

`measurements` stays voltage-only. `branch_currents_a` is keyed with the caller-supplied
source spelling and is raw ngspice `i(Vsource)` in amperes: positive into the voltage
source positive terminal; a delivering source normally appears negative. Either `nodes`
or `branch_sources` may be omitted; a call that supplies neither is refused.

### 3. Run a transient analysis

Submit the transient netlist by the same first step, then call `spice_simulate_tran`:

```spice
RC Low-Pass Filter R=1k C=1uF Vin=1V step
Vin in 0 DC 0 PULSE(0 1 0 1n 1n 10m 20m)
R1 in out 1000
C1 out 0 1e-6
.tran 10u 6m
.end
```

Its exact UTF-8 bytes, including the final newline, have digest
`cda6e07b79adeec9df7ac41a5e20315d8c51afaa1311b63350d540a4ebe9eb80`.

```json
{
  "netlist_sha256": "cda6e07b79adeec9df7ac41a5e20315d8c51afaa1311b63350d540a4ebe9eb80",
  "nodes": ["out", "in"],
  "branch_sources": ["Vin"],
  "tstep_s": 0.00001,
  "tstop_s": 0.006
}
```

For the repository's RC fixture, the key result fields are:

```json
{
  "node_stats": {
    "out": {
      "min_v": 0,
      "max_v": 0.99752137,
      "final_v": 0.99752137,
      "min_at_s": 0,
      "max_at_s": 0.006,
      "final_at_s": 0.006
    }
  },
  "branch_current_stats_a": {
    "Vin": {
      "min_a": -0.001,
      "max_a": 0,
      "final_a": -0.00000247863,
      "min_at_s": 0.000000001,
      "max_at_s": 0,
      "final_at_s": 0.006
    }
  },
  "measurements": {
    "out": { "value": 0.99752137 },
    "in": { "value": 1 }
  },
  "simulation": { "n_points": 626, "tstop_s": 0.006 }
}
```

`measurements` is a cross-tool convenience view: it mirrors the operating-point voltage
and the transient `final_v`. Use `node_stats` or `branch_current_stats_a` when extrema
or timestamps matter. The actual point count is adaptive and is therefore not
necessarily `tstop_s / tstep_s`. If an extremum has equal samples, its timestamp is the
first matching sample. Raw ngspice `i(Vsource)` is in amperes and positive into the
source's positive terminal; a delivering source normally appears negative.

### 4. Run a bounded DC source sweep

`spice_simulate_dc` is a server-owned sweep over one named independent voltage source.
It accepts voltage values in volts and returns reduced extrema/final summaries, not a
transfer-curve array. The server refuses a direction mismatch and any request that would
exceed 512 internal sweep points.

```json
{
  "netlist_sha256": "38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1",
  "sweep_source": "Vin",
  "start_v": 0,
  "stop_v": 3,
  "step_v": 1,
  "nodes": ["out"],
  "branch_sources": ["Vin"]
}
```

For the divider above, `out` ranges from 0 V to 2 V, with its final sample at a swept
source value of 3 V. `branch_current_stats_a.Vin` is reported separately in amperes; it
is not mixed into the voltage-only `measurements` alias.

## Netlist and source contract

The caller supplies circuit and inline model definitions. An `.op` or `.tran` directive
may be present, as in the examples, but is not required and does not select the server
operation. The called MCP tool owns the analysis and appends the `.control` block that
runs it and extracts only the requested node voltages and voltage-source branch
currents. A terminal `.end` is accepted and replaced when the server assembles the
executable netlist.

Inline ngspice constructs such as `.model`, `.param`, `.global`, and `.subckt`/`.ends`
can be used. This makes self-contained non-linear devices and reusable subcircuits
possible without granting the simulator access to an arbitrary model-library path.

The following caller-controlled constructs are rejected before ngspice starts:

- `.control` and `.endc`;
- `.include` and `.lib`;
- `.shell` and bare `shell` commands;
- whitespace-delimited absolute paths beginning with `/` or `~/`.

Requested node names and all voltage-source names are validated before interpolation
into the server-owned control block. This includes operating-point, transient, and
DC-sweep observables, plus the DC sweep source. Names may contain letters, digits,
underscores, dots, hyphens, and `#`; ground is `0` for a node only.

There are two mutually exclusive input modes:

- **Submitted reference, recommended:** omit `netlist_path`, pass the returned
  `netlist_sha256`, and optionally pass the matching `netlist_uri`. This works across
  process and container boundaries.
- **Filesystem path, legacy:** pass a path visible inside the server process and the
  SHA-256 of that file. The server copies it to a private read-only snapshot and
  verifies the snapshot before simulation. It has the same 1 MiB limit as submitted
  netlists. Do not combine `netlist_path` with `netlist_uri`.

The immutable store defaults to `${NGSPICE_RUNS_DIR:-/ngspice-runs}/inputs/<sha256>`.
Set `SPICE_NETLIST_STORE` to override the exact inputs directory. The server does not
currently garbage-collect stored netlists, so persistent deployments should monitor or
manage the volume.

## Results, provenance, and errors

Every successful tool response has a short text `content` summary and closed
`structuredContent` matching the advertised output schema.

- Submit returns the server-computed digest, UTF-8 byte length, and stable URI.
- Simulation re-snapshots the selected object and repeats its digest and byte length in
  `input_artifact`.
- Simulation results always carry a `not_checked` list so downstream code can preserve
  the analysis boundary rather than infer unsupported coverage.
- Admission, selector-validation, provenance, and ngspice failures are serialized as
  `{ "code", "context", "recovery" }`. Examples include `netlist_sha256_mismatch`,
  `netlist_forbidden_directive`, `invalid_node_name`, `ngspice_unavailable`,
  `ngspice_timeout`, `ngspice_output_limit_exceeded`, `ngspice_dc_grid_invalid`,
  `simulation_dispatch_uncertain`, and typed durable-record corruption errors.
- ngspice non-zero exits, error/fatal log lines, malformed or divergent `wrdata`,
  missing output, output-limit breaches, and absent requested observables fail the tool
  call instead of returning a partial success.

The digest proves which bytes this process consumed. It does not, by itself, turn a
numerical result into a requirement verdict or a qualified engineering claim.

## Current analysis scope

The present source surface stays deliberately bounded. It exposes an operating point,
transient summaries with timestamps and requested branch currents, and a one-dimensional
DC source sweep reduced to extrema/final summaries. It does not expose AC analysis,
noise analysis, Monte Carlo, caller-supplied control scripts, or waveform samples. The
qualified 0.6.0 image exposes this same bounded surface.

| Area                 | Current behavior                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| DC operating point   | One `.op` point. Returns requested node voltages and requested voltage-source branch currents.                              |
| DC source sweep      | One named independent voltage source, explicit start/stop/step in volts, at most 512 internal points, reduced results only. |
| Transient            | Requested node voltage and voltage-source current min/max/final summaries, extrema timestamps, and adaptive point count.    |
| Initial conditions   | Server-owned transient command uses a DC operating point; UIC is not exposed                                                |
| Temperature          | ngspice default TNOM 27°C unless the netlist supplies `.TEMP` or `.OPTIONS TNOM`                                            |
| Models               | Inline model and subcircuit definitions; no caller-selected external libraries                                              |
| Convergence          | ngspice defaults; detected failures become tool errors                                                                      |
| Sweeps and variation | No multidimensional sweep, AC analysis, noise analysis, Monte Carlo, or worst-case aggregation tool                         |
| Other observables    | No waveform samples in the response; no caller-supplied `.control` script                                                   |
| Interpretation       | No specification, safety, EMC, lifetime, or compliance verdict                                                              |

These are interface limits, not limits of ngspice itself.

## Extension candidates

The current submit, snapshot, timeout, and provenance pipeline can be reused for more
analyses. These capabilities do **not** exist today, but are natural scoped
contributions:

- An explicit transient initialization mode so callers can select the current DC
  operating-point start or a bounded UIC path with declared initial conditions.
- Bounded or decimated transient samples, or a content-addressed waveform artifact.
  ngspice already writes a private series that the server currently reduces to
  min/max/final and then deletes.
- AC magnitude/phase analysis with a purpose-built complex-number and frequency schema.
- Digest-pinned, server-managed model bundles. This needs a separate trust and
  provenance design; simply allowing caller-selected `.include` or `.lib` paths would
  weaken the current security boundary.

## Operational security

- HTTP authentication and TLS are not configured by this repository. The source server
  binds loopback by default; keep it on a trusted local interface or place an
  authenticated reverse proxy in front of it.
- The Docker HTTP entrypoint binds `0.0.0.0` inside the container. The quick-start
  command publishes it only on host loopback.
- Netlist filtering removes known file-loading, control-block, shell, and absolute-path
  injection surfaces. It is not a substitute for OS/container isolation when accepting
  untrusted, computationally expensive circuits.
- The server queues above four concurrent calls. Each simulation defaults to 30 seconds
  and accepts at most 300 seconds, but operators should still apply container CPU,
  memory, process, and storage limits appropriate to their threat model.
- Prefer submitted content-addressed references for remote clients. Legacy path mode
  intentionally reads a server-visible filesystem path.

Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Relationship to Casys Digital Thread

This repository is a standalone MCP numerical provider. In the separate Casys Digital
Thread workspace, `mcp-spice` is an optional provider/preflight surface on port 3023. It
is not the governed product execution path.

The Digital Thread's admitted circuit flow reopens sealed `spice-circuit-source` bytes
and executes the registered `simulate.run-admitted-spice@1` operation in an isolated
worker. That separate path owns product authority, recovery, evidence publication, and
later human evaluation. An `mcp-spice` result must not be presented as that admitted run
or as a Digital Thread requirement verdict. The integration status remains owned by that
workspace's provider reference, not by this standalone server README.

## Development

Commands in this section run against this source checkout. They validate the local
sources; they are not a substitute for the digest-pinned published image.

```bash
deno task check          # type-check
deno task lint           # lint
deno task fmt            # format check
deno task test           # test without requiring ngspice
SPICE_RUN_NATIVE=1 deno task test  # include native ngspice integration
deno task build:ui       # rebuild MCP Apps HTML from audited mcp-view sources
deno task test:ui        # component catalog tests against those sources
deno task check:ui:bundle  # rebuild and require a byte-identical committed HTML
deno task release:check  # fmt + check + lint + test + UI catalog + freshness
```

Viewer builds require the exact split MCP View v2 packages from `Casys-AI/mcp-server` at
`8fad891839203122efbe2438ba81a6e7d08c9202`. Point `MCP_VIEW_LOCAL_ROOT`,
`MCP_VIEW_CONTRACTS_LOCAL_ROOT`, and `MCP_VIEW_COMPONENTS_LOCAL_ROOT` at that checkout's
`packages/view`, `packages/view-contracts`, and `packages/view-components`. There is no
published compatibility fallback. The dedicated `src/ui/deno.lock` is used with
`--frozen`.

The `main` publication workflow installs ngspice and runs the full native suite before
it can publish the JSR package.

Regenerate engine fixtures only with ngspice available:

```bash
deno run --allow-all scripts/gen_fixtures.ts
```

Build a local container from this source checkout. That local tag is not the
digest-pinned published 0.6.0 image:

```bash
docker build -t mcp-spice:local .
docker run --rm -p 127.0.0.1:3023:3023 mcp-spice:local http
```

The Docker build runs a real voltage-divider smoke simulation and fails unless ngspice
returns `v(out) = 2.000000e+00 V`.

## License and citation

MIT. Citation metadata is available in [CITATION.cff](CITATION.cff).
