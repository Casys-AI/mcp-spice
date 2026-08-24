# mcp-spice

An MCP server for running bounded SPICE circuit analyses with ngspice and returning
compact, structured results tied to the exact input bytes.

[JSR package](https://jsr.io/@casys/mcp-spice) ·
[container image](https://github.com/Casys-AI/mcp-spice/pkgs/container/mcp-spice) ·
[changelog](CHANGELOG.md) · [security policy](SECURITY.md)

**Release status.** This checkout prepares unpublished package/server version 0.4.0.

Executable JSR examples pin `jsr:@casys/mcp-spice@0.3.0`. Executable Docker examples
that demonstrate the published 0.3.0 contract pin the immutable multi-architecture
image digest. `:latest` is a mutable convenience tag, not the authority for a version
or capability. Operating-point voltage-source branch currents (`branch_sources` /
`branch_currents_a`) are prepared-source/local-image behavior until 0.4.0 is published.

The published JSR `@0.3.0` package and the digest-pinned image have package
version `0.3.0` (`deno.json`; `/app/deno.json` in the image). Their `server.ts`
still has legacy `VERSION` `0.1.0`, so `server/discover` and `/health` report
runtime identity `0.1.0`. This checkout aligns package and server metadata at
`0.4.0`.

Since v0.3.0, a client can send a netlist directly over MCP. The server verifies its
declared SHA-256, applies the netlist security policy, stores the bytes under their
digest, and returns a reusable content-addressed reference. A shared host filesystem or
`docker exec` is no longer required for the normal workflow.

The published 0.3.0 package and digest-pinned image can:

- admit exact UTF-8 circuit netlists into an immutable, content-addressed store;
- run a DC operating point and return requested node voltages;
- run a transient analysis and return min, max, and final voltage for each requested
  node;
- attest every consumed netlist with its SHA-256 and byte length;
- serve stateless MCP over HTTP or classic MCP clients through its stdio adapter.

This unpublished 0.4.0 checkout additionally lets `spice_simulate_op` return requested
voltage-source branch currents.

`mcp-spice` is a numerical engine. It reports observations and declared analysis limits;
it does not decide whether a circuit satisfies a requirement.

## Quick start

### Published Docker image over HTTP

The command below runs the published multi-architecture 0.3.0 image by digest. It does
not include this checkout's unpublished branch-current output. The image contains Deno
and the tested ngspice 44.2 baseline. The named volume preserves submitted netlists
across container restarts.

```bash
docker run --rm \
  -p 127.0.0.1:3023:3023 \
  -v mcp-spice-runs:/ngspice-runs \
  ghcr.io/casys-ai/mcp-spice@sha256:e499519d70e6775580a4a913978e0b931a1131a84185370938c5bb7a1443cf69 http
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
`params.name`. MCP clients and the stdio adapter build this transport envelope for you.

`:latest` is a mutable convenience tag, not the authority for the 0.3.0 contract or
for this checkout's prepared 0.4.0 capabilities. Use the digest above for a
reproducible or production deployment.

### Published Docker image over stdio

The same digest-pinned 0.3.0 image's `stdio` mode adapts the classic MCP initialize
handshake used by desktop hosts and Docker MCP clients to the server's stateless HTTP
transport. A generic client configuration is:

```json
{
  "mcpServers": {
    "spice": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-v",
        "mcp-spice-runs:/ngspice-runs",
        "ghcr.io/casys-ai/mcp-spice@sha256:e499519d70e6775580a4a913978e0b931a1131a84185370938c5bb7a1443cf69",
        "stdio"
      ]
    }
  }
}
```

Keep `-i`: MCP messages travel through the container's stdin and stdout.

### JSR or a source checkout

Running the server module from JSR still requires an `ngspice` executable on `PATH`:

```bash
# macOS
brew install ngspice

# Debian / Ubuntu
sudo apt install ngspice

deno run --allow-all jsr:@casys/mcp-spice@0.3.0/server --port=3023
```

`@0.3.0` is the version actually published on JSR. `@0.4.0` is not published. Do not
expect branch currents from the JSR module or from the digest-pinned published image.

For the unpublished 0.4.0 branch-current capability, run this checkout:

```bash
deno task serve
```

or build a local container from these sources.

The server binds to `127.0.0.1:3023` by default. Use `--hostname`, `--port`,
`MCP_HOSTNAME`, or `MCP_PORT` to override it. The JSR package also exports
`createSpiceServer`, `SpiceToolsClient`, the tool registry, parsers, and the
content-addressed store helpers for embedding in a Deno application.

## MCP tools

The table below describes this unpublished 0.4.0 checkout. On published 0.3.0 (JSR
`@0.3.0` and the digest-pinned image), `spice_simulate_op` requires `nodes[]`, rejects
`branch_sources`, and does not return `branch_currents_a`.

| Tool                     | Purpose                                       | Required input                                                                                                        | Structured result                                                                     |
| ------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `ngspice_netlist_submit` | Verify, filter, and store exact netlist bytes | `netlist`, `netlist_sha256`                                                                                           | `sha256`, `bytes`, `uri`                                                              |
| `spice_simulate_op`      | Run a DC operating point                      | `netlist_sha256` and at least one of `nodes[]` or `branch_sources[]`; optional `netlist_uri` or legacy `netlist_path` | `node_voltages`, `branch_currents_a`, `measurements`, `not_checked`, `input_artifact` |
| `spice_simulate_tran`    | Run a transient analysis                      | `netlist_sha256`, `nodes[]`, `tstep_s`, `tstop_s`; optional `netlist_uri` or legacy `netlist_path`                    | `node_stats`, `measurements`, `simulation`, `not_checked`, `input_artifact`           |

Each registered operation is non-destructive, idempotent, and closed-world. Simulation
calls default to a 30-second timeout; `timeout_s` is clamped to the range 1–300 seconds.

## End-to-end content-addressed workflow

The JSON snippets below are the `arguments` objects passed to the named MCP tools.

### 1. Submit the circuit

The hash below is the SHA-256 of the exact `netlist` string after UTF-8 encoding,
including its final newline:

```json
{
  "netlist": "Voltage Divider R1=1k R2=2k Vin=3V\nVin in 0 DC 3\nR1 in out 1000\nR2 out 0 2000\n.op\n.end\n",
  "netlist_sha256": "38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1"
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

Submitting the same bytes again is an idempotent no-op. The submitted-netlist limit is 1
MiB. A digest mismatch, forbidden construct, oversized input, or attempt to replace
different bytes at an existing digest is refused before a mutable object can be exposed.

### 2. Run the operating point

Pass the returned digest and, optionally, its URI to `spice_simulate_op`. This call is
valid on published 0.3.0 (JSR `@0.3.0` and the digest-pinned image):

```json
{
  "netlist_sha256": "38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1",
  "netlist_uri": "spice-netlist:sha256:38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1",
  "nodes": ["out", "in"]
}
```

The structured result contains the requested voltages and the identity of the private
snapshot consumed by ngspice. This example is abridged only to shorten the
`not_checked` list. Published 0.3.0 does not return `branch_currents_a`:

```json
{
  "node_voltages": { "out": 2, "in": 3 },
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
  }
}
```

`source_path` is provider-local provenance, not a path the client must be able to read.

#### Prepared source: operating-point branch currents (unpublished 0.4.0)

Until 0.4.0 is published, `branch_sources` and `branch_currents_a` are
prepared-source/local-image behavior. They are not available from JSR `@0.3.0` or from
the digest-pinned published image.

```json
{
  "netlist_sha256": "38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1",
  "netlist_uri": "spice-netlist:sha256:38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1",
  "nodes": ["out", "in"],
  "branch_sources": ["Vin"]
}
```

This checkout returns `branch_currents_a` in addition to the 0.3.0 voltage fields:

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
  "tstep_s": 0.00001,
  "tstop_s": 0.006
}
```

For the repository's RC fixture, the key result fields are:

```json
{
  "node_stats": {
    "out": { "min_v": 0, "max_v": 0.99752137, "final_v": 0.99752137 },
    "in": { "min_v": 0, "max_v": 1, "final_v": 1 }
  },
  "measurements": {
    "out": { "value": 0.99752137 },
    "in": { "value": 1 }
  },
  "simulation": { "n_points": 626, "tstop_s": 0.006 }
}
```

`measurements` is a cross-tool convenience view: it mirrors the operating-point voltage
and the transient `final_v`. Use `node_stats` when min/max/final matter. The actual
point count is adaptive and is therefore not necessarily `tstop_s / tstep_s`.

## Netlist and source contract

The caller supplies circuit and inline model definitions. An `.op` or `.tran` directive
may be present, as in the examples, but is not required and does not select the server
operation. The called MCP tool owns the analysis and appends the `.control` block that
runs it and extracts the requested node voltages and, in this unpublished 0.4.0
checkout, any requested voltage-source branch currents on a DC operating point.
Published 0.3.0 extracts node voltages only. A terminal `.end` is accepted and
replaced when the server assembles the executable netlist.

Inline ngspice constructs such as `.model`, `.param`, `.global`, and `.subckt`/`.ends`
can be used. This makes self-contained non-linear devices and reusable subcircuits
possible without granting the simulator access to an arbitrary model-library path.

The following caller-controlled constructs are rejected before ngspice starts:

- `.control` and `.endc`;
- `.include` and `.lib`;
- `.shell` and bare `shell` commands;
- whitespace-delimited absolute paths beginning with `/` or `~/`.

Requested node names are validated before interpolation into the server-owned control
block. In this unpublished 0.4.0 checkout, operating-point voltage-source names are
validated the same way. Names may contain letters, digits, underscores, dots, hyphens,
and `#`; ground is `0`.

There are two mutually exclusive input modes:

- **Submitted reference, recommended:** omit `netlist_path`, pass the returned
  `netlist_sha256`, and optionally pass the matching `netlist_uri`. This works across
  process and container boundaries.
- **Filesystem path, legacy:** pass a path visible inside the server process and the
  SHA-256 of that file. The server copies it to a private read-only snapshot and
  verifies the snapshot before simulation. Do not combine `netlist_path` with
  `netlist_uri`.

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
- Admission and input-provenance refusals are serialized as
  `{ "code", "context", "recovery" }`. Examples include `netlist_sha256_mismatch`,
  `netlist_forbidden_directive`, `netlist_not_in_store`, and `ambiguous_netlist_source`.
- ngspice non-zero exits, error/fatal log lines, missing transient output, and absent
  requested nodes fail the tool call instead of returning partial success. In this
  unpublished 0.4.0 checkout, absent requested branch sources fail the same way.

The digest proves which bytes this process consumed. It does not, by itself, turn a
numerical result into a requirement verdict or a qualified engineering claim.

## Current analysis scope

The present MCP surface is deliberately small. This unpublished 0.4.0 checkout exposes
operating-point node voltages plus requested voltage-source branch currents, and
transient voltage min/max/final summaries. It does not expose a DC sweep, AC analysis,
noise analysis, Monte Carlo, caller-supplied control scripts, or waveform samples.
Published 0.3.0 is the same bound without the branch currents.

| Area                 | Current behavior                                                                      |
| -------------------- | ------------------------------------------------------------------------------------- |
| DC                   | One `.op` point. Published 0.3.0 returns requested node voltages. This checkout also returns requested voltage-source branch currents. |
| Transient            | Requested node voltage min/max/final plus adaptive point count; no branch currents    |
| Initial conditions   | Server-owned transient command uses a DC operating point; UIC is not exposed          |
| Temperature          | ngspice default TNOM 27°C unless the netlist supplies `.TEMP` or `.OPTIONS TNOM`      |
| Models               | Inline model and subcircuit definitions; no caller-selected external libraries        |
| Convergence          | ngspice defaults; detected failures become tool errors                                |
| Sweeps and variation | No DC sweep, AC analysis, noise analysis, Monte Carlo, or worst-case aggregation tool |
| Other observables    | No waveform samples in the response; no caller-supplied `.control` script             |
| Interpretation       | No specification, safety, EMC, lifetime, or compliance verdict                        |

These are interface limits, not limits of ngspice itself.

## Extension candidates

The current submit, snapshot, timeout, and provenance pipeline can be reused for more
analyses. These capabilities do **not** exist today, but are natural scoped
contributions:

- A bounded `spice_simulate_dc` sweep with explicit source/start/stop/step inputs and a
  capped output schema.
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

Commands in this section, run in this checkout, exercise unpublished 0.4.0.

```bash
deno task check          # type-check
deno task lint           # lint
deno task fmt            # format check
deno task test           # test without requiring ngspice
SPICE_RUN_NATIVE=1 deno task test  # include native ngspice integration
deno task release:check  # fmt + check + lint + test
```

Regenerate engine fixtures only with ngspice available:

```bash
deno run --allow-all scripts/gen_fixtures.ts
```

Build the local container from this unpublished 0.4.0 checkout (including branch
currents). That local tag is not the digest-pinned published 0.3.0 image:

```bash
docker build -t mcp-spice:local .
docker run --rm -p 127.0.0.1:3023:3023 mcp-spice:local http
```

The Docker build runs a real voltage-divider smoke simulation and fails unless ngspice
returns `v(out) = 2.000000e+00 V`.

## License and citation

MIT. Citation metadata is available in [CITATION.cff](CITATION.cff).
