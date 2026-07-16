<div align="center">
  <h1>@cyanheads/noaa-spaceweather-mcp-server</h1>
  <p><b>Query NOAA SWPC space weather: geomagnetic storm scales, Kp index, aurora forecasts, solar wind, solar activity, and alerts via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.11-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/noaa-spaceweather-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/noaa-spaceweather-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/noaa-spaceweather-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.14-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/noaa-spaceweather-mcp-server/releases/latest/download/noaa-spaceweather-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=noaa-spaceweather-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbm9hYS1zcGFjZXdlYXRoZXItbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22noaa-spaceweather-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fnoaa-spaceweather-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://noaa-spaceweather.caseyjhand.com/mcp](https://noaa-spaceweather.caseyjhand.com/mcp)

</div>

---

## Tools

Six tools covering the full NOAA SWPC space weather surface — from a quick status heartbeat to deep solar and geomagnetic data:

| Tool | Description |
|:-----|:------------|
| `noaa_spaceweather_get_conditions` | Current space-weather snapshot: NOAA R/S/G storm scales, latest Kp, and a plain-language status summary |
| `noaa_spaceweather_get_kp_index` | Planetary K-index (0–9) — recent observed 3-hour values with G-scale equivalents and aurora-latitude guidance, plus 3-day forecast |
| `noaa_spaceweather_get_aurora_forecast` | OVATION model aurora forecast: global probability grid, optional local lookup by coordinates with go/no-go verdict |
| `noaa_spaceweather_get_solar_wind` | Real-time solar wind from the active L1 spacecraft: speed, proton density, temperature, and the critical Bz component — explains why current geomagnetic conditions exist |
| `noaa_spaceweather_get_solar_activity` | Solar flare picture: GOES X-ray flux, 3-day flare-class probabilities, active solar regions with per-region probabilities, and solar radiation storm level |
| `noaa_spaceweather_get_alerts` | Active SWPC alerts, watches, and warnings — structured records with product type, severity, issue time, validity window, and full message text |

### `noaa_spaceweather_get_conditions`

The heartbeat tool. Use it first — it composes storm scales + current Kp into a single snapshot with a plain-language summary.

- Returns today's R/S/G storm scales plus a 3-day forecast
- Current Kp with G-scale equivalent and aurora-visibility latitude guidance
- Plain-language summary: "Quiet conditions" vs. "G2 moderate geomagnetic storm in progress"
- Data sourced from `noaa-scales.json` + `noaa-planetary-k-index.json`

---

### `noaa_spaceweather_get_kp_index`

Planetary K-index time series for geomagnetic activity tracking.

- `window_days` parameter (1–7, default 1) — recent 3-hour observed values
- Each record includes Kp value, G-scale equivalent, aurora-latitude guidance, and observation time
- Separate 3-day forecast series with predicted Kp and NOAA G-scale labels

---

### `noaa_spaceweather_get_aurora_forecast`

OVATION model aurora probability at 1° resolution, updated every ~5 minutes.

- Without coordinates: global metadata — grid point count, global peak probability, peak region
- With coordinates (`latitude`, `longitude`): nearest-grid-point lookup, minimum Kp required at that latitude, and a plain-language verdict ("Good aurora chance (42%) — Kp≥6 needed at this latitude")
- Covers both hemispheres; coordinates are geographic (WGS84)

---

### `noaa_spaceweather_get_solar_wind`

Real-time solar wind plasma and magnetic field from SWPC's RTSW feeds.

- Reads the spacecraft SWPC flags as active; every record names its `source`, so no satellite is assumed
- `window_hours` parameter (1–168, default 3) — sliced client-side from a feed that carries roughly the last 24 hours at 1-minute cadence
- Reports `latestFeedPlasmaTime`, `latestFeedMagTime`, and `feedStalenessHours` so an empty window is distinguishable from a stale feed
- Plasma: speed (km/s), proton density (n/cm³), temperature
- Bz component (southward Bz = storm driver) surfaced prominently in output and format
- Bt (total field magnitude) and GSM vector components

---

### `noaa_spaceweather_get_solar_activity`

Solar flare and radiation storm picture from GOES and SWPC probabilities.

- GOES primary X-ray flux in the 0.1–0.8 nm band (R-scale driver)
- 3-day C/M/X flare-class probabilities
- Active solar regions with per-region flare and proton probabilities when `include_regions: true` (default)
- Solar radiation storm (S-scale) level from ≥10 MeV integral proton flux

---

### `noaa_spaceweather_get_alerts`

Active SWPC alerts, watches, and warnings from the `products/alerts.json` feed.

- Structured product metadata: type (Watch/Warning/Alert/Summary), issue time, and ISO 8601 validity window parsed from the message body (`Valid From`/`To`, `Now Valid Until`, or `Begin`/`End Time`)
- Severity read from the NOAA scale stated in the message body (`noaaScale` e.g. `"G1"`, plus `level` 0–5); products stating no scale report level `0`
- Cancellation notices flagged (`cancelled`) and excluded from the active set
- Filtered to active-only by default (`active_only: true`); set `false` for recent history, including cancellations
- Full raw message text preserved for downstream display

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Space weather domain:

- All SWPC feeds are public and keyless — no API keys required
- Single `SpaceWeatherService` wraps all six NOAA SWPC JSON feeds with `fetchWithTimeout` + `withRetry`
- Heterogeneous feed normalization: interleaved multi-spacecraft records (solar wind), keyed objects (storm scales), coordinate triples (OVATION)
- NOAA scale interpretation: raw Kp 6 → "G2 moderate storm — aurora possible to ~55° geomagnetic latitude"
- Feed freshness surfaced per-response: solar wind updates ~1 min, aurora ~5 min, Kp 3-hour intervals

Agent-friendly output:

- Observed timestamps on every response so agents can reason about data freshness
- Plain-language summaries and verdicts alongside raw values — agents can display or reason without re-interpreting indices
- Bz component surfaced as a first-class field in solar wind output (southward Bz = primary storm driver)
- Typed error contracts with recovery hints: `feed_unavailable` → "Retry in 30–60 s"

---

## Getting started

### Public Hosted Instance

A public instance is available at `https://noaa-spaceweather.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "noaa-spaceweather-mcp-server": {
      "type": "streamable-http",
      "url": "https://noaa-spaceweather.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "noaa-spaceweather": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/noaa-spaceweather-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "noaa-spaceweather": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/noaa-spaceweather-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "noaa-spaceweather": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/noaa-spaceweather-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
- No API keys required — all SWPC feeds are public.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/noaa-spaceweather-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd noaa-spaceweather-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env if needed — all defaults work out of the box
```

---

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_HTTP_HOST` | Hostname for HTTP server. | `127.0.0.1` |
| `MCP_HTTP_ENDPOINT_PATH` | Endpoint path. | `/mcp` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

No domain-specific API keys are required. See [`.env.example`](./.env.example) for the full list of optional overrides.

---

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t noaa-spaceweather-mcp-server .
docker run --rm -p 3010:3010 noaa-spaceweather-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/noaa-spaceweather-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

---

## Project structure

| Path | Purpose |
|:-----|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits the service. |
| `src/services/space-weather/` | `SpaceWeatherService` — fetches and normalizes all NOAA SWPC feeds. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`) — one file per tool. |
| `tests/` | Unit and integration tests mirroring `src/`. |
| `docs/` | Design doc and directory tree. |

---

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools via the barrel in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

---

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
