# Installation and transports

## Container

The release image contains Deno and the qualified ngspice baseline. It supports
`linux/amd64` and `linux/arm64` and stores admitted netlists and documentary records
under `/ngspice-runs`.

Start the stateless HTTP transport:

```bash
docker run --rm \
  -p 127.0.0.1:3023:3023 \
  -v mcp-spice-runs:/ngspice-runs \
  ghcr.io/casys-ai/mcp-spice@sha256:3d42ff26d3114e3f0e3e2302261d94fa2aaf612758078a7e624aac1eda924551 http
```

The MCP endpoint is `http://127.0.0.1:3023/mcp`. The server binds to `127.0.0.1:3023` by
default; `--hostname`, `--port`, `MCP_HOSTNAME`, and `MCP_PORT` override that listener.

For native stdio:

```bash
docker run --rm -i \
  -v mcp-spice-runs:/ngspice-runs \
  ghcr.io/casys-ai/mcp-spice@sha256:3d42ff26d3114e3f0e3e2302261d94fa2aaf612758078a7e624aac1eda924551 stdio
```

Passing `stdio` replaces the image's default `http` command. It does not start an HTTP
child process.

The pinned OCI index contains `linux/amd64` and `linux/arm64` manifests. A version tag
identifies the release; the digest above is the immutable runtime identity.

## JSR

The JSR package requires an `ngspice` executable on `PATH`:

```bash
# macOS
brew install ngspice

# Debian or Ubuntu
sudo apt install ngspice
```

Run the exact published module over stdio:

```bash
deno run --allow-all jsr:@casys/mcp-spice@0.6.3/server --stdio
```

Or start its HTTP transport:

```bash
deno run --allow-all jsr:@casys/mcp-spice@0.6.3/server --port=3023
```

The JSR package exports `createSpiceServer`, `SpiceToolsClient`, the tool registry,
parsers, content-addressed store helpers, and the serialized MCP App manifest.

## Source checkout

With Deno and ngspice installed:

```bash
git clone https://github.com/Casys-AI/mcp-spice.git
cd mcp-spice
deno task serve
```

The source and JSR entrypoints use the same framework-native transports. Native stdio
accepts the MCP `2025-06-18` initialize handshake. The HTTP endpoint uses the stateless
MCP protocol revision declared by the pinned `@casys/mcp-server` dependency.

## Persistent directories

Set `NGSPICE_RUNS_DIR` to a private, writable, single-writer directory when running
outside the container. It contains both the immutable netlist store and documentary
records. If `SPICE_NETLIST_STORE` is set explicitly, receipt data is kept in a sibling
`receipts/` directory.

Do not place these stores in a directory writable by unrelated processes. Hash checks
detect substituted objects when read; they do not turn a shared mutable filesystem into
a safe concurrent authority.
