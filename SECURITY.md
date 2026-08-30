# Security Policy

Please report suspected vulnerabilities privately to **hello@casys.ai**. Do not open
public issues for security reports. You will receive an acknowledgement within a few
business days.

## Durable-store boundary

The netlist (`inputs/`) and documentary receipt (`receipts/`) roots must be private,
server-owned directories on a single/exclusive-writer volume. The server fails closed
for corrupt, oversized, substituted, symlinked, FIFO, and other unsafe pre-existing
objects through bounded immutable reads. It is not a sandbox against an actor already
authorised to write those roots concurrently; deploy filesystem permissions and volume
ownership that exclude such writers.
