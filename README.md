# mcp-spice

MCP server for deterministic SPICE circuit simulation via ngspice 44.2 batch mode.

The netlist is the "circuit as code" — the caller owns the circuit definition,
the server writes the `.control` block, runs ngspice in batch mode, and returns
named scalar measurements. No verdict is issued; the oracle
(e.g. `syson_constraint_evaluate`) decides compliance.

## Tools

| Tool | Analysis | Input | Output |
|---|---|---|---|
| `spice_simulate_op` | DC `.op` | circuit netlist + `nodes[]` | `node_voltages`, `measurements` |
| `spice_simulate_tran` | Transient `.tran` | circuit netlist + `nodes[]` + `tstep_s` + `tstop_s` | `node_stats` (min/max/final per node), `simulation` |

## Prerequisites

- **ngspice 44.2** — `apt install ngspice` (Debian trixie / Ubuntu 24.04+) or `brew install ngspice` (macOS)
- **Deno 2.x** — runtime

## Usage

```bash
# Start the server (default port 3023)
deno task serve

# Or with a custom port
deno run --allow-all server.ts --port=3023
```

The server exposes `/mcp` using the stateless MCP protocol `2026-07-28`.

## Netlist format

**The caller MUST NOT include a `.control` block.** The server writes it.
Forbidden in the caller's netlist: `.control`, `.endc`, `.include`, `.lib`,
`.shell`, `shell`, absolute paths. These are rejected before any subprocess
launches (`NetlistSecurityError`).

Provide only the circuit definition and a simulation type directive:

```spice
Voltage Divider Example
Vin in 0 DC 3
R1 in out 1000
R2 out 0 2000
.op
.end
```

Call `spice_simulate_op` with:

```json
{
  "netlist_path":   "/path/to/circuit.cir",
  "netlist_sha256": "<64-char hex SHA-256 of the file>",
  "nodes":          ["out", "in"]
}
```

The tool returns:

```json
{
  "node_voltages": { "out": 2.0, "in": 3.0 },
  "measurements":  { "out": { "value": 2.0 }, "in": { "value": 3.0 } },
  "not_checked":   ["Temperature effects: simulation at TNOM=27°C unless overridden.", "..."],
  "input_artifact": {
    "sha256": "abc123...",
    "bytes": 87,
    "source_path": "/path/to/circuit.cir"
  }
}
```

For a transient simulation:

```spice
RC Low-Pass Filter
Vin in 0 DC 0 PULSE(0 1 0 1n 1n 10m 20m)
R1 in out 1000
C1 out 0 1e-6
.tran 10u 6m
.end
```

```json
{
  "netlist_path":   "/path/to/rc.cir",
  "netlist_sha256": "<64-char hex SHA-256>",
  "tstep_s":        1e-5,
  "tstop_s":        6e-3,
  "nodes":          ["out", "in"]
}
```

Returns per-node statistics (the full time series is never returned):

```json
{
  "node_stats": {
    "out": { "min_v": 0.0, "max_v": 0.9975, "final_v": 0.9975 },
    "in":  { "min_v": 0.0, "max_v": 1.0,    "final_v": 1.0    }
  },
  "measurements": { "out": { "value": 0.9975 }, "in": { "value": 1.0 } },
  "simulation":   { "n_points": 626, "tstop_s": 0.006 },
  "not_checked":  ["Adaptive time step: actual n_points differs from tstop_s/tstep_s.", "..."],
  "input_artifact": { "sha256": "abc123...", "bytes": 102, "source_path": "/path/to/rc.cir" }
}
```

## What this server does NOT check

These limits are always declared in the `not_checked` field of each response:

- **Temperature** — simulation runs at TNOM=27°C unless the netlist overrides `.TEMP` or `.OPTIONS TNOM`.
- **Convergence** — ngspice uses default tolerances (ABSTOL=1e-12, RELTOL=1e-3); divergent circuits raise `SpiceError`.
- **Sweep** — `spice_simulate_op` returns a single `.op` point; there is no DC or AC sweep tool.
- **Monte Carlo / worst-case** — not performed.
- **External model libraries** — no `.lib` or `.include`; models must be inline in the netlist.
- **Branch currents** — not returned; only node voltages requested by `nodes[]`.
- **Full time series** — `spice_simulate_tran` returns only min/max/final per node, never the waveform.
- **Specification compliance** — the tool measures; the oracle decides.

## SHA-256 attestation

Every call requires `netlist_sha256`: a 64-char hex SHA-256 of the netlist file.
The server computes the digest of its private snapshot and raises
`NetlistArtifactError` if it differs. The same digest is returned in
`input_artifact.sha256`, proving the exact bytes the simulator consumed.

## Development

```bash
deno task check        # type-check
deno task lint         # lint
deno task fmt          # format check (deno fmt --check)
deno task test         # unit tests (no ngspice required — 22 tests)
SPICE_RUN_NATIVE=1 deno task test   # include ngspice integration tests (6 additional)
deno task release:check             # full gate: fmt + check + lint + test

# Regenerate fixtures (requires ngspice in PATH, run inside the dev container):
deno run --allow-all scripts/gen_fixtures.ts
```

## Port

3023 — documented in `docs/reference/workspace-map.md` of casys-digital-thread.

## License

MIT
