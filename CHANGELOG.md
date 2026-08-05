# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-08-05

### Added

- `spice_simulate_op`: DC operating-point simulation via ngspice 44.2 batch mode.
  - Accepts a caller-supplied SPICE netlist with `.op` + `.control/print/quit`.
  - Returns named scalar measurements (`v(out)`, `i(vin)`, `.meas` results).
  - SHA-256 attestation of the netlist snapshot (`input_artifact`).
  - `not_checked` field enumerates analysis limitations (temperature, convergence,
    sweep, Monte Carlo, external model libraries).
  - Native integration test gated by `SPICE_RUN_NATIVE=1`.

### Engine baseline

- ngspice 44.2+ds-1 (Debian trixie `arm64`, package `ngspice`).
- Validation circuit: R1=1 kΩ, R2=2 kΩ, Vin=3 V → V(out) = 2.000000e+00 V (exact).
- Batch invocation: `ngspice -b <netlist>` with `.control/run/print/quit` block.
- Parser regex: `^([\w()#.]+)\s*=\s*([-+]?[0-9.]+[eE][+-]?[0-9]+)(\s+at=…)?`
