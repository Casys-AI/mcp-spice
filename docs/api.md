# MCP API and content-addressed workflow

## Operations

`ngspice_netlist_submit` validates and stores exact UTF-8 netlist bytes. It returns the
computed SHA-256, byte length, and a `spice-netlist:sha256:…` reference. An optional
declared digest is treated as an assertion and a mismatch is refused before any write.

`spice_simulate_op` runs a DC operating point for explicitly named nodes and voltage
sources. It returns node voltages, branch currents, input identity, declared limits, and
a documentary receipt reference.

`spice_simulate_tran` runs a bounded transient analysis. It returns min, max, final, and
associated timestamps for requested node voltages and branch currents. It does not
return the raw time series.

`spice_simulate_dc` runs one bounded sweep over an explicitly named independent voltage
source. It returns reduced extrema and final values rather than a transfer curve.

`spice_simulation_receipt_get`, `spice_simulation_result_get`, and
`spice_simulation_dispatch_get` reopen exact persisted records by SHA-256 and recheck
their linked bytes before returning them.

All simulation operations are non-destructive and idempotent for the same canonical
request. Typed refusals and failures use `{ code, context, recovery }` rather than a
free-text success substitute.

## Submit a circuit

The following object is passed as the arguments to `ngspice_netlist_submit`:

```json
{
  "netlist": "Voltage Divider R1=1k R2=2k Vin=3V\nVin in 0 DC 3\nR1 in out 1000\nR2 out 0 2000\n.op\n.end\n"
}
```

The exact final newline is part of the identity. The response for those bytes is:

```json
{
  "sha256": "38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1",
  "bytes": 87,
  "uri": "spice-netlist:sha256:38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1"
}
```

Submitting identical bytes again is an idempotent no-op.

## Run an operating point

```json
{
  "netlist_sha256": "38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1",
  "netlist_uri": "spice-netlist:sha256:38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1",
  "nodes": ["out", "in"],
  "branch_sources": ["Vin"]
}
```

The structured result contains values in field-named units and the exact input identity.
Branch current is raw ngspice `i(Vsource)` in amperes: positive into the voltage
source's positive terminal, so a delivering source commonly appears negative.

```json
{
  "node_voltages": { "out": 2, "in": 3 },
  "branch_currents_a": { "Vin": -0.001 },
  "measurements": {
    "out": { "value": 2 },
    "in": { "value": 3 }
  },
  "input_artifact": {
    "sha256": "38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1",
    "bytes": 87,
    "source_path": "/ngspice-runs/inputs/38173716ff427a29aee98fa88b7fcb51964c6d5aa7ab80dda7e4f42d796932a1"
  }
}
```

`source_path` is provider-local provenance. A client does not need access to it.

## Run a transient analysis

```json
{
  "netlist_sha256": "<sha256>",
  "nodes": ["in", "out"],
  "branch_sources": ["Vin"],
  "tstep_s": 0.00001,
  "tstop_s": 0.006
}
```

Each requested observable returns its minimum, maximum, final value, and the time of
those samples. Equal extrema resolve to the earliest sampled time. The raw waveform is
private and is neither persisted nor exposed through this API.

## Run a DC sweep

```json
{
  "netlist_sha256": "<sha256>",
  "sweep_source": "Vin",
  "start_v": 0,
  "stop_v": 5,
  "step_v": 0.1,
  "nodes": ["out"],
  "branch_sources": ["Vin"]
}
```

The server owns the ngspice control program, verifies the returned grid against the
request, and exposes only bounded summary statistics.

## Source modes

Content-addressed `netlist_sha256` with an optional matching `netlist_uri` is the normal
path. The legacy `netlist_path` input remains supported for embedding scenarios, but the
provider copies those bytes into the immutable store before dispatch. Supplying a path
and URI together is refused as ambiguous.

The caller supplies circuit statements only. `.control`, `.endc`, `.include`, `.lib`,
shell commands, and absolute external paths are rejected; the server builds the analysis
sequence itself.
