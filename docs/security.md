# Runtime limits and security model

`mcp-spice` accepts circuit-only netlists and constructs the ngspice control program on
the server. The following boundaries are enforced before or during execution:

- submitted and legacy-path netlists are limited to 1 MiB;
- `.control`, `.endc`, `.include`, `.lib`, shell commands, and absolute external paths
  are rejected;
- node and voltage-source selectors are syntax checked and bounded;
- simulation timeouts must be explicit values from 1 to 300 seconds;
- ngspice stdout and stderr are read through fixed byte ceilings;
- transient and DC `wrdata` files are bounded before parsing;
- transient sampling and DC sweep traversal stop at server-owned ceilings;
- malformed, non-finite, incomplete, or divergent numeric output aborts the complete
  result rather than returning partial data.

Exact current limits are exported through `execution-budgets/1.0` and implemented in
[`src/api/execution-budgets.ts`](../src/api/execution-budgets.ts). Code is authoritative
when this prose and a release differ.

## Subprocess boundary

The caller does not supply a control block or output path. The provider creates private
temporary paths, runs ngspice without a shell, and validates both exit state and output.
Exit code zero alone is not accepted as sufficient: diagnostics are scanned for ngspice
errors, and required output must exist and parse completely.

## Store boundary

The netlist and receipt roots must be private and single-writer. Content hashes and
bounded snapshot reads detect unsafe or substituted objects, but they cannot protect a
directory that an unrelated privileged process may mutate concurrently.

Container deployments should use the image entrypoint and a dedicated named volume.
Native deployments should restrict directory permissions and set an explicit writable
`NGSPICE_RUNS_DIR`.

## Reporting vulnerabilities

Follow [SECURITY.md](../SECURITY.md). Do not include private circuit data, credentials,
or customer artifacts in a public issue.
