#!/bin/sh
# Two run modes, chosen by the first argument:
#   (none) | http  — stateless HTTP on 0.0.0.0, the park's native mode
#   stdio          — MCP stdio for catalog/desktop clients, adapted by the
#                    stdio shim (the park's HTTP dialect never leaves the
#                    container). Requires `docker run -i`.
set -e
MODE="${1:-http}"
case "$MODE" in
  http)
    exec deno run --allow-all server.ts --port=3023 --hostname=0.0.0.0
    ;;
  stdio)
    exec deno run --allow-all scripts/stdio-shim.ts --port=3023
    ;;
  *)
    echo "unknown mode: $MODE (expected: http | stdio)" >&2
    exit 2
    ;;
esac
