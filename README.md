<div align="center">
  <h1>@cyanheads/noaa-spaceweather-mcp-server</h1>
  <p><b>Query NOAA SWPC space weather: geomagnetic storm scales, Kp index, aurora forecasts, solar wind, solar activity, and alerts via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/noaa-spaceweather-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/noaa-spaceweather-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/noaa-spaceweather-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/noaa-spaceweather-mcp-server/releases/latest/download/noaa-spaceweather-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=noaa-spaceweather-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbm9hYS1zcGFjZXdlYXRoZXItbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22noaa-spaceweather-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fnoaa-spaceweather-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://noaa-spaceweather.caseyjhand.com/mcp](https://noaa-spaceweather.caseyjhand.com/mcp)

</div>

---

## Overview

Space weather from NOAA's Space Weather Prediction Center (SWPC) — geomagnetic storm scales, Kp index, aurora forecasts, solar wind, solar activity, and active alerts. Query current conditions, aurora visibility at a coordinate, or windowed plasma and magnetic-field time series from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:-----|:------------|
| `noaa_spaceweather_get_conditions` | Current space-weather snapshot: NOAA R/S/G storm scales for yesterday, today, and the 3-day forecast, latest Kp, a plain-language status summary, and optionally SWPC's forecast discussion explaining the forecast |
| `noaa_spaceweather_get_kp_index` | Planetary K-index (0–9) — recent observed 3-hour values with G-scale equivalents and aurora-latitude guidance, plus 3-day forecast |
| `noaa_spaceweather_get_aurora_forecast` | OVATION model aurora forecast: global probability grid, optional local lookup by coordinates with a daylight-aware go/no-go verdict and a poleward horizon reading |
| `noaa_spaceweather_get_solar_wind` | Real-time solar wind from the active L1 spacecraft: speed, proton density, temperature, and the critical Bz component with the window's most southward reading — explains why current geomagnetic conditions exist |
| `noaa_spaceweather_get_solar_activity` | Solar flare picture: discrete flare events with peak class and R-scale level, GOES X-ray flux, the daily F10.7 cm radio flux, 3-day flare-class probabilities, active solar regions with same-day flare counts and next-day probabilities, and solar radiation storm level |
| `noaa_spaceweather_get_alerts` | Active SWPC alerts, watches, and warnings — structured records with product type, severity, issue time, validity window, and full message text |

## Capability reference

### `noaa_spaceweather_get_conditions` <sub>tool</sub>

- `include_discussion` (bool, default false) is the only input; one call composes the `noaa-scales.json` and `noaa-planetary-k-index.json` feeds, plus the `discussion.txt` product when the discussion is requested
- Returns current Kp with its G-scale equivalent and aurora-latitude guidance, today's observed R/S/G levels, `yesterday` (the previous UTC day's assessed levels, null when the feed carries none), and SWPC's 3-day forecast starting today — forecast R and S carry probabilities rather than levels, and a null level means none was forecast, not level 0
- With `include_discussion`, the forecaster-written Forecast Discussion split into its topic sections (Solar Activity, Energetic Particle, Solar Wind, Geospace), each with its 24-hour summary and 3-day forecast text

---

### `noaa_spaceweather_get_kp_index` <sub>tool</sub>

- `window_days` (1–7, default 1) bounds the observed series, and `observedCount` reports how many readings matched; the forecast is always SWPC's full 3-day series of forward-looking `estimated`/`predicted` rows
- Each record carries Kp, its G level and label, and aurora-latitude guidance. G levels follow SWPC's minus-third band floors — G1 starts at Kp 4.67 (5−), and only Kp 9 is G5

---

### `noaa_spaceweather_get_aurora_forecast` <sub>tool</sub>

- `latitude`/`longitude` (WGS84) are optional but required together — one alone fails `invalid_coordinates`. Without them the call returns global metadata only: grid point count, global peak probability, and peak region
- With coordinates, `localLookup` carries the nearest 1°-grid probability, the geomagnetic latitude, the minimum Kp and G level needed there, the sun's elevation and `darkness` state (`day`, `civil_twilight`, `nautical_twilight`, `dark`) at the forecast time, the strongest reading within 1000 km poleward (`horizonMaxPercent`, `horizonMaxLatitude`, `horizonDistanceKm`), and a go/no-go `verdict` — not visible in daylight, whatever the model probability
- The OVATION model updates every ~5 minutes and forecasts ~30–60 minutes ahead

---

### `noaa_spaceweather_get_solar_wind` <sub>tool</sub>

- `window_hours` (1–168, default 3) slices a feed that carries roughly the last 24 hours at ~1-minute cadence. `resolution` sets series detail: `reduced` (default) caps each series at 200 records, keeping each bucket's fastest speed and most southward Bz; `full` returns every record (~1,400 per series over 24 hours); `summary` returns empty series and every headline field, about 2 KB
- Returns oldest-first plasma (speed, density, temperature) and magnetic-field (Bx/By/Bz/Bt GSM) series, each record naming its spacecraft, plus headline fields computed over the full window at every resolution: `bzStatus`, `bzMinInWindow`, `speedMaxInWindow`, `densityMaxInWindow`, `btMaxInWindow`, and `bzSouthMinutesInWindow`
- `latestFeedPlasmaTime`/`latestFeedMagTime`/`feedStalenessHours` distinguish an empty window from a stale feed

---

### `noaa_spaceweather_get_solar_activity` <sub>tool</sub>

- `flare_hours` (1–168, default 24) bounds the flare events returned by onset over the feed's rolling 7 days; `include_regions` (default true) toggles per-region detail to control response size
- Returns discrete flare events with onset, peak, and decay classes, peak flux, and the NOAA R level (0–5) it implies (decay is null while a flare is in progress; peak fields are null when SWPC recorded no peak); GOES X-ray flux with its flare class (`flareClassFull`); the daily F10.7 cm radio flux with its observation time; 3-day C/M/X flare and proton-event probabilities (`cClassProbability`, `mClassProbability`, `xClassProbability`, `protonEventProbability` — the deprecated `*1Day` names still carry them in `structuredContent`); and the S level from ≥10 MeV proton flux
- With `include_regions`, each active region's sunspot area, the C/M/X flare counts SWPC attributed to it on its observation day, and its next-day flare probabilities

---

### `noaa_spaceweather_get_alerts` <sub>tool</sub>

- `active_only` (default true) keeps in-force Warnings/Watches/Alerts, dropping cancelled and superseded products, Summaries, and products whose validity has ended. `max_age_hours` (1–720, default 48) bounds how far back candidates reach — under `active_only` a product whose validity end is still ahead survives it; otherwise it is a literal age cutoff
- Each record carries product type, NOAA scale and level (0 means "no scale stated," not zero severity), serial number, parsed validity window, `cancelled`, and full message text. Under `active_only` the response also counts what it excluded, by reason, so an empty result reads as "quiet" or "everything was filtered"

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

SWPC-specific:

- All SWPC feeds are public and keyless — no API keys required
- Single `SpaceWeatherService` wraps every NOAA SWPC feed — the JSON products and the plain-text forecast discussion — behind one `fetchWithTimeout` + `withRetry` funnel, so both paths classify an upstream failure the same way — and every retry ladder runs inside one 45-second budget, so a hung upstream still returns the classified error before a 60-second client timeout
- Heterogeneous feed normalization: interleaved multi-spacecraft records (solar wind), keyed objects (storm scales), coordinate triples (OVATION), section-delimited text (forecast discussion)
- NOAA scale interpretation: raw Kp 6 → "G2 moderate storm — aurora possible to ~55° geomagnetic latitude"
- Feed freshness surfaced per-response: solar wind updates ~1 min, aurora ~5 min, Kp 3-hour intervals

Agent-friendly output:

- Observed timestamps on every response so agents can reason about data freshness
- Plain-language summaries and verdicts alongside raw values — agents can display or reason without re-interpreting indices
- Bz component surfaced as a first-class field in solar wind output (southward Bz = primary storm driver)
- Typed error contracts with recovery hints, split on whether retrying can help: a transient feed failure is `feed_unavailable` → "Retry in 30–60 s"; a feed path SWPC no longer serves is `feed_moved` → "Retrying will not help", raised on the first attempt

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
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
| `MCP_SESSION_MODE` | HTTP session mode. This project explicitly uses `stateless`; `auto` resolves to `stateful`. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |
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

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
