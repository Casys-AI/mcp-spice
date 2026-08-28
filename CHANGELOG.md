# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.2] - 2026-08-28

### Fixed

- DC `wrdata` now receives the same 8 MiB pre-read byte guard as transient
  output, and its parser stops at the server-owned 512-point ceiling during
  traversal. Both breaches return the typed
  `ngspice_output_limit_exceeded` recovery envelope; no partial DC summary is
  returned.
- ngspice stdout and stderr are each capped at 1 MiB while streaming. This
  closes the diagnostic-capture allocation path used by operating point,
  transient, and DC runs before log parsing or tail extraction.

### Changed

- `execution-budgets/1.0` now names the shared `wrdata` output budget for DC
  and transient analyses. `MAX_TRANSIENT_WRDATA_BYTES` remains a compatibility
  alias for embedding clients.
- Release jobs use Deno `v2.9.6`; the Docker build pins the multi-architecture
  Deno `2.9.6` and Debian trixie-slim OCI indexes by digest.

## [0.5.1] - 2026-08-28

### Changed

- `execution-budgets/1.0` makes the 1 MiB netlist limit identical for
  `ngspice_netlist_submit` and legacy `netlist_path` snapshots. All three
  simulations now reject, rather than clamp, `timeout_s` outside 1–300 seconds;
  each node/current observable array is capped at 32 entries.
- Transient `wrdata` is refused before parsing above 8 MiB or 50,000 samples.
  The raw waveform remains private and reduced statistics remain the only
  transient result surface.

### Fixed

- Operating-point argument failures now use the standard machine-readable
  `{ code, context, recovery }` envelope instead of raw `TypeError` messages.
- Timeout and output-budget breaches are typed as `ngspice_timeout` and
  `ngspice_output_limit_exceeded`, respectively.

## [0.5.0] - 2026-08-28

### Added

- `spice_simulate_dc`: one server-owned, bounded DC sweep over an explicitly named
  independent voltage source. It accepts start/stop/step in volts, enforces a 512-point
  internal cap, and returns only reduced voltage/current extrema and final summaries.
  It does not return a raw transfer curve.
- `spice_simulate_tran` optional `branch_sources[]`: requested voltage-source branch
  current min/max/final summaries in amperes, separate from voltage-only
  `measurements`.
- `spice_simulate_tran` extrema timestamps: node and branch summaries now include
  `min_at_s`, `max_at_s`, and `final_at_s`. Equal extrema resolve to the earliest
  sampled time.

### Changed

- `ngspice_netlist_submit` now accepts `netlist` alone. `netlist_sha256` is an optional
  expected-digest assertion: the server always computes and returns the digest, and a
  supplied mismatch still fails before any store write.
- Transient and DC observable inputs are closed and bounded; node and voltage-source
  names are validated before interpolation into server-owned ngspice control commands.

### Fixed

- `wrdata` parsing is now fail-closed: a malformed numeric row, non-finite value,
  wrong column count, or divergent interleaved axis aborts the whole result rather than
  silently retaining partial statistics. DC additionally verifies the observed grid
  against the server-owned start/stop/step request before returning a summary.
- Identifier refusals and ngspice execution failures are serialized as MCP business
  errors with `{ code, context, recovery }`, rather than surfacing as free-text internal
  JSON-RPC failures.
- The `main` JSR release gate now installs ngspice and runs the native integration suite
  before publishing. README-linked release metadata is included in the JSR package.

## [0.4.1] - 2026-08-27

### Fixed

- Stdio mode now uses the framework-native, era-aware MCP transport directly. A real
  legacy `2025-06-18` initialize plus submission regression protects the direct path.

## [0.4.0] - 2026-08-25

### Added

- `spice_simulate_op` optional `branch_sources[]`: DC branch currents as
  `branch_currents_a` (amperes), keyed by the caller-supplied source spelling.
  At least one of `nodes` or `branch_sources` is required. `measurements`
  remains voltage-only. Returned currents are raw ngspice `i(Vsource)`:
  positive into the voltage source positive terminal; a delivering source
  normally appears negative. Transient analysis still does not return branch
  currents.

### Fixed

- `parseMeasurements` accepts hyphenated SPICE names already allowed by
  `validateNodeName` (for example `v(out-1)` and `i(v-in)`).
- Server runtime identity (`server/discover`, `/health`) reports `0.4.0`,
  matching `deno.json`. Historical 0.3.0 context: published JSR `@0.3.0` and
  that release's digest-pinned image reported `0.1.0` from leftover `VERSION`
  in `server.ts`.

## [0.3.0] - 2026-08-15

### Added

- `ngspice_netlist_submit`: content-addressed netlist admission.
  - Input: exact UTF-8 `netlist` + declared `netlist_sha256`.
  - Server recomputes the digest and refuses a mismatch before any write.
  - Security filter (`.include` / `.control` / `.lib` / `.shell` / absolute
    paths) runs at submit time; a rejected netlist is not stored.
  - Immutable store: same hash + same bytes is idempotent; a colliding
    payload is refused (`netlist_store_collision`).
  - Output: `{ sha256, bytes, uri }` (`uri` = `spice-netlist:sha256:<hex>`).
- `spice_simulate_op` / `spice_simulate_tran` accept the submitted reference
  (`netlist_sha256`, optional `netlist_uri`) in place of `netlist_path`.
  Path + sha256 remains valid (backward compatible). Path and uri together
  are refused (`ambiguous_netlist_source`).

### Spec deviations (mcp-ngspice HTML vs this repo)

- Simulate tools keep repo names `spice_simulate_*`; only the new admit tool
  uses the spec name `ngspice_netlist_submit`.
- Submit takes bytes + declared hash (critique / `/exports` read-only) rather
  than a hash-only lookup of a pre-staged file.
- Submit returns a content-addressed reference, not `{ requestId, status }`.
- Field names follow repo snake_case (`netlist_sha256`, `bytes`) rather than
  spec camelCase (`netlistSha256`, `byteCount`).

## [0.2.0] — 2026-08-05

- `scripts/stdio-shim.ts`: stdio → stateless-HTTP adapter. Classic-SDK stdio clients
  (Docker MCP Toolkit, desktop hosts) get `initialize` answered locally from
  `server/discover`; everything else is forwarded in the 2026-07-28 stateless envelope,
  which is the only revision the server accepts on the wire.
- `docker-entrypoint.sh`: the image now has two run modes — `http` (default, unchanged)
  and `stdio` (`docker run -i <image> stdio`).

## [0.1.0] — 2026-08-05

### Added

- `spice_simulate_op`: DC operating-point simulation via ngspice 44.2 batch mode.
  - Caller supplies circuit-only netlist (no `.control` block) + `nodes[]` list + SHA-256.
  - Server writes the `.control` block (`op` / `print v(node1)…` / `quit`).
  - Returns `node_voltages` (node name → voltage in V) and cross-tool `measurements` alias.
  - `not_checked` field enumerates known analysis limits (temperature, convergence, sweeps,
    Monte Carlo, external model libraries, branch currents).
  - SHA-256 attestation of the netlist private snapshot (`input_artifact`).

- `spice_simulate_tran`: Transient simulation via ngspice 44.2 batch mode.
  - Caller supplies circuit-only netlist + `nodes[]` + `tstep_s` + `tstop_s` + SHA-256.
  - Server writes the `.control` block (`tran` / `wrdata <server-temp-path>` / `quit`).
  - Returns per-node statistics: `{min_v, max_v, final_v}` in volts over the full window.
  - Full time series is never returned; only reduced statistics.
  - `simulation` field reports `n_points` (adaptive) and `tstop_s`.
  - SHA-256 attestation of the netlist private snapshot (`input_artifact`).

- `src/api/netlist-security.ts`: fail-closed netlist validation.
  - Rejects `.control`, `.endc`, `.include`, `.lib`, `.shell`, bare `shell`,
    and any whitespace-separated token starting with `/` or `~/`.
  - Validated before subprocess launch; `NetlistSecurityError` carries the offending token.
  - `validateNodeName` rejects injection metacharacters from `nodes[]` entries.

- `src/api/netlist-artifact.ts`: netlist snapshot with SHA-256 attestation.
  - Copies the caller's file to a private temp directory (mode 0o400).
  - Computes SHA-256 of the snapshot; raises `NetlistArtifactError` on digest mismatch.
  - Returns `cleanup()` for deterministic teardown in both success and error paths.

- `src/api/ngspice.ts`: ngspice 44.2 subprocess bridge.
  - `runNgspiceOp` — DC operating point; parses `print v(node)` output lines.
  - `runNgspiceTran` — Transient; uses server-owned absolute `wrdata` path (lesson: relative
    paths resolve from Deno process cwd, not from the netlist directory).
  - `parseMeasurements` — exported for unit testing; handles `at=` trailers from `.meas`.
  - `parseWrdata` — exported for unit testing; interleaved 2N-column format (col 2i = time,
    col 2i+1 = v(nodes[i])); raises `SpiceError` when no numeric rows found.
  - Exit-0 check: scans log for `Error:` / `Fatal:` even after zero exit code.
  - Absence check: raises `SpiceError` when wrdata file is not written (convergence failure
    may produce no output without a detectable error in the log).

- `scripts/gen_fixtures.ts`: fixture generator — must be run inside the dev container
  with ngspice on PATH; never written by hand.

- Test fixtures generated by ngspice 44.2, arm64, Debian trixie:
  - `tests/fixtures/vdiv.cir` — voltage-divider circuit (no `.control`).
  - `tests/fixtures/vdiv_op.txt` — raw ngspice output: `v(out)=2.000000e+00 V`,
    `v(in)=3.000000e+00 V`, `i(vin)=-1.00000e-03 A`.
  - `tests/fixtures/rc_tran.cir` — RC low-pass filter circuit (no `.control`).
  - `tests/fixtures/rc_tran_wrdata.dat` — 626 adaptive rows, 4 columns (2 nodes);
    `v(out)` final at t=6 ms: `9.97521370e-01 V ≈ 1−e⁻⁶`.

- Test suite: deterministic unit coverage plus native checks gated by
  `SPICE_RUN_NATIVE=1`.

### Engine baseline

- ngspice 44.2+ds-1 (Debian trixie `arm64`, package `ngspice`).
- Validation circuits:
  - Voltage divider: R1=1 kΩ, R2=2 kΩ, Vin=3 V → V(out)=2.000000e+00 V (exact).
  - RC filter: R=1 kΩ, C=1 µF, Vin=1 V step, 6 ms simulation → V(out)=9.97521370e-01 V ≈ 1−e⁻⁶.

### Lessons applied from prior tool implementations

- wrdata path must be absolute (relative paths resolve from Deno process cwd, not the netlist).
- Exit 0 does not guarantee output; wrdata file existence is checked explicitly.
- Exit 0 does not guarantee convergence; log is scanned for `Error:`/`Fatal:` after zero exit.
- Caller never supplies `.control`; the server owns the simulation sequence entirely.
- No density/threshold/profile defaults; every missing required field raises a typed error.
- Units live in field names: `tstep_s`, `tstop_s`, `min_v`, `max_v`, `final_v`.
- `error`/`unresolved` are first-class states; no silent invention of values.
- Fixtures generated by the real engine; `scripts/gen_fixtures.ts` is the authoritative source.
