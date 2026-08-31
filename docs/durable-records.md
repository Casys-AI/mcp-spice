# Durable receipts and recovery

Every simulation snapshots the exact netlist into the immutable content-addressed store.
Before starting ngspice, the server writes an acknowledged dispatch record. A terminal
execution then publishes, in order:

1. the immutable bounded outcome;
2. the immutable documentary receipt;
3. the immutable terminal publication record.

Only the publication record establishes that the dispatch reached a terminal state.

## Identities

The receipt binds the netlist digest, analysis kind, normalized request, runtime
identity, execution-budget contract, outcome digest, and literal terminal execution
state. Canonical request normalization sorts and deduplicates selectors, resolves the
timeout, and admits finite numeric arguments only.

`request_sha256` identifies the analysis kind, netlist digest, and canonical request.
The dispatch document has a separate integrity digest covering the complete body,
including runtime identity. This prevents a provider or ngspice upgrade from masking a
corrupt record while retaining the no-automatic-rerun rule for an acknowledged request.

## Storage layout

Within `NGSPICE_RUNS_DIR`:

```text
inputs/<netlist sha256>
receipts/dispatches/<request sha256>
receipts/results/<outcome sha256>
receipts/receipts/<receipt sha256>
receipts/publications/<request sha256>
```

Reads use bounded immutable snapshots. Existing symlinks, FIFOs, oversized files,
substituted bytes, and conflicting objects fail closed.

## Recovery states

An acknowledged dispatch without a terminal publication returns
`simulation_dispatch_uncertain`. The provider does not automatically rerun the same
request after a restart or runtime upgrade because execution may already have happened.

A typed ngspice failure is durably terminal and replays as the same typed MCP error with
its request, dispatch, receipt, and outcome identities. A write that never reached the
acknowledgement is absent and may be retried deliberately.

Receipt readback rehashes the receipt, linked outcome, and netlist. Outcome readback
rehashes the canonical outcome bytes. Corrupt, missing, non-canonical, or substituted
records remain errors; the server does not silently reconstruct them.

These records are documentary provider records. They are not Digital Thread product
evidence, a requirement verdict, or a substitute for a registered Digital Thread
operation such as `simulate.run-admitted-spice@1`.
