# syntax=docker/dockerfile:1
# ──────────────────────────────────────────────────────────────────────────────
# mcp-spice — stateless HTTP MCP server for ngspice 44.2 SPICE simulation
# Fleet port: 3023  |  Protocol: MCP stateless 2026-07-28
# ──────────────────────────────────────────────────────────────────────────────

# Stage 1: exact official multi-arch Deno 2.9.6 image — we copy only its binary.
# The pinned OCI index resolves to amd64 sha256:023603… and arm64 sha256:430f9e… .
FROM denoland/deno:2.9.6@sha256:2014dc167ece617ef7e7ba40631ac2234c59e75ce693e7cc2dc2602b3c87859d AS deno-bin

# ──────────────────────────────────────────────────────────────────────────────
# Stage 2: exact multi-arch Debian trixie slim index — provides ngspice 44.2 via apt.
# ──────────────────────────────────────────────────────────────────────────────
FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132

ENV DENO_DIR=/deno-dir \
    PATH="/usr/local/bin:${PATH}"

# Copy Deno binary from the official multi-arch image.
COPY --from=deno-bin /usr/bin/deno /usr/local/bin/deno

# Install ngspice 44.2 (Debian trixie package).
# ca-certificates is required for deno to reach jsr.io during the cache step.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ngspice \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ngspice --version

# Deno module cache directory — persists across layers.
RUN mkdir -p /deno-dir

WORKDIR /app

# ── Build-time ngspice validation with the repo's vdiv.cir fixture ───────────
# The fixture is a circuit-only netlist (no .control block), matching the format
# the server enforces on callers.  We augment it with a server-style .control
# block to run ngspice in batch mode and assert the expected voltage divider
# result: v(out) = R2/(R1+R2) × Vin = 2000/3000 × 3 = 2.000000e+00 V.
COPY tests/fixtures/vdiv.cir /tmp/vdiv_base.cir
RUN { grep -iv '^\.end[[:space:]]*$' /tmp/vdiv_base.cir; \
      printf '.control\nop\nprint v(out) v(in)\nquit\n.endc\n.end\n'; } \
      > /tmp/vdiv_smoke.cir \
    && ngspice -b /tmp/vdiv_smoke.cir > /tmp/ngspice_smoke.log 2>&1; \
      RC=$?; cat /tmp/ngspice_smoke.log; \
      [ $RC -eq 0 ] || { echo "[mcp-spice] ngspice exited $RC"; exit 1; }; \
      grep -q 'v(out) = 2.000000e+00' /tmp/ngspice_smoke.log \
      || { echo "[mcp-spice] FAIL: v(out) not 2.000000e+00 in output above"; exit 1; }; \
      echo '[mcp-spice] ngspice 44.2 smoke OK: v(out) = 2.000000e+00 V' \
    && rm /tmp/vdiv_base.cir /tmp/vdiv_smoke.cir /tmp/ngspice_smoke.log

# ── Application source ────────────────────────────────────────────────────────
COPY deno.json deno.lock ./
COPY mod.ts server.ts ./
COPY src/ ./src/
COPY docker-entrypoint.sh ./

# ── Cache Deno dependencies at build time ────────────────────────────────────
# The committed deno.lock is authoritative; network access is needed here to
# reach jsr.io.  Once cached in /deno-dir the container starts without network.
# Both HTTP and stdio modes start server.ts directly, so cache the runtime
# entrypoints during the image build.
RUN deno cache --lock=deno.lock server.ts mod.ts

EXPOSE 3023

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["http"]
