# mcp-spice

MCP server for deterministic SPICE circuit simulation via ngspice 44.2 batch mode.

The netlist is the "circuit as code" — the caller owns the netlist, the server runs
the simulation and returns named scalar measurements. No verdict is issued; the oracle
(e.g. `syson_constraint_evaluate`) decides compliance.

## Tools

| Tool | Analysis | Description |
|---|---|---|
| `spice_simulate_op` | DC `.op` | Operating-point node voltages, branch currents, `.meas` results |

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

The netlist must include a `.control` block with `run`, `print` directives for the
variables you want returned, and `quit`:

```spice
Voltage Divider Example
Vin in 0 DC 3
R1 in out 1000
R2 out 0 2000
.op
.control
run
print v(out) v(in) i(Vin)
quit
.endc
.end
```

The tool returns:

```json
{
  "measurements": {
    "v(out)": { "value": 2.0 },
    "v(in)":  { "value": 3.0 },
    "i(vin)": { "value": -0.001 }
  },
  "not_checked": ["Temperature effects: …", "…"],
  "input_artifact": {
    "sha256": "abc123…",
    "bytes": 142,
    "source_path": "/path/to/circuit.cir"
  }
}
```

## Development

```bash
deno task check        # type-check
deno task lint         # lint
deno task fmt          # format check
deno task test         # unit tests (no ngspice required)
SPICE_RUN_NATIVE=1 deno task test   # include ngspice integration tests
deno task release:check             # full gate: fmt + check + lint + test
```

## Port

3023 — documented in `docs/reference/workspace-map.md` of casys-digital-thread.

## License

MIT
