<div align="center">
  <h1>@cyanheads/noaa-spaceweather-mcp-server</h1>
  <p><b>Query NOAA SWPC space weather: geomagnetic storm scales, Kp index, aurora forecasts, solar wind, solar activity, and alerts via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/noaa-spaceweather-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/noaa-spaceweather-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/noaa-spaceweather-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

- `include_discussion` (bool, default false) is the only input — otherwise a single call composing storm scales and current Kp into one snapshot
- Returns today's observed R/S/G storm levels plus SWPC's 3-day forecast series, which starts with today
- `yesterday` carries the R/S/G levels SWPC assessed for the previous UTC day, with its date and no time — the feed states only when it was generated. Null when the feed carries no previous-day period
- Forecast days carry what SWPC issues: a G level, and for R and S a probability — R1–R2, R3 or greater, S1 or greater — with no level. A null level means SWPC forecasts none for that day, which is not the same as level 0
- Current Kp with G-scale equivalent and aurora-visibility latitude guidance
- With `include_discussion`, the forecaster-written Forecast Discussion split into its topic sections (Solar Activity, Energetic Particle, Solar Wind, Geospace), each with its 24-hour summary and 3-day forecast text
- Data sourced from the `noaa-scales.json` + `noaa-planetary-k-index.json` feeds, plus the `discussion.txt` product when the discussion is requested

---

### `noaa_spaceweather_get_kp_index` <sub>tool</sub>

- `window_days` (1–7, default 1) bounds the observed series; the forecast series is always SWPC's full 3-day forecast
- Each observed/forecast record carries Kp, G-scale equivalent, G-scale label, and aurora-latitude guidance
- G levels follow SWPC's minus-third band floors — G1 starts at Kp 4.67 (5−), G4 runs through 8.67 (9−), and only Kp 9 is G5
- Forecast excludes the feed's embedded historical "observed" entries — only forward-looking `estimated`/`predicted` rows
- `observedCount` reports how many observed readings matched the window

---

### `noaa_spaceweather_get_aurora_forecast` <sub>tool</sub>

- Without coordinates: global metadata only — grid point count, global peak probability, peak region
- With `latitude`/`longitude` (WGS84, required together): nearest 1°-grid lookup, the centered-dipole geomagnetic latitude those coordinates convert to, the minimum Kp and G level needed at that geomagnetic latitude, and a plain-language go/no-go verdict
- Darkness gating: the sun's elevation at the coordinates at the forecast time (`sunElevationDeg`) and the sky state it implies (`darkness`: `day`, `civil_twilight`, `nautical_twilight`, `dark`). In daylight the verdict reports aurora as not visible whatever the model probability; in twilight it adds that only bright aurora will show
- Horizon view: the strongest reading within 1000 km poleward and ±2° longitude (`horizonMaxPercent`, `horizonMaxLatitude`, `horizonDistanceKm`). When it reaches 10% and beats the overhead reading outside daylight, the verdict adds that aurora may be visible low on the poleward horizon
- `invalid_coordinates` error when only one of the pair is supplied
- OVATION model updates every ~5 minutes; forecast horizon is ~30–60 minutes ahead

---

### `noaa_spaceweather_get_solar_wind` <sub>tool</sub>

- `window_hours` (1–168, default 3) slices client-side from a feed that carries roughly the last 24 hours at ~1-minute cadence
- `resolution` (`summary`, `reduced` default, or `full`) sets the series detail. `reduced` bounds each returned series to 200 records: the window is bucketed by record count and one real measurement is emitted per bucket — the bucket's fastest speed for plasma, its most southward Bz for mag — with the newest record in the window always last. A series already inside the bound comes back untouched, so a default 3-hour call is unaffected; `full` returns every record (~1,400 per series over 24 hours); `summary` returns both series empty and keeps every headline field, about 2 KB whatever the window
- Plasma (speed, density, temperature) and magnetic field (Bx/By/Bz/Bt GSM) returned as separate oldest-first series
- `bzStatus` surfaces southward Bz (the storm driver) as a plain-language field, and `bzMinInWindow` with its time tag reports the window's most southward reading
- Window statistics: `speedMaxInWindow` with its time tag, `densityMaxInWindow`, `btMaxInWindow`, and `bzSouthMinutesInWindow` — the count of 1-minute records with Bz below 0, so a gap in the feed adds nothing. Every headline field is computed from the full window, before any reduction, at every resolution
- `latestFeedPlasmaTime`/`latestFeedMagTime`/`feedStalenessHours` distinguish an empty window from a stale feed
- Every record names its reporting spacecraft — no satellite is assumed as "the" active one

---

### `noaa_spaceweather_get_solar_activity` <sub>tool</sub>

- `include_regions` (default true) toggles per-region active-solar-region detail to control response size
- `flare_hours` (1–168, default 24) bounds the discrete flare events returned, filtered on each flare's onset; the feed keeps a rolling 7 days, so 168 returns everything it carries
- Flare events come with the classes SWPC publishes — onset, peak, and decay, each with magnitude — the peak flux, and the NOAA R-scale level (0–5) that flux implies. Decay time and class are null while a flare is still in progress, and an empty window names the newest flare the feed holds
- GOES X-ray flux (0.1–0.8 nm) with flare-class letter (A/B/C/M/X), the class with magnitude (`flareClassFull`, derived by SWPC's truncation rule so it agrees with the published flare classes), and the unformatted flux alongside the display string; recent readings cover the past hour
- Daily F10.7 cm solar radio flux in sfu with its 90-day mean, from the Noon Penticton report — the value SWPC reports for the day. It can be up to ~24 h old, so its observation time rides with it
- 3-day C/M/X flare-class and proton-event probabilities, each duplicated under a legacy `*1Day` name and a date-neutral name
- Each active region carries the C/M/X flare counts SWPC attributed to it on its observation day — the flare events carry no region, so these name the region driving current activity — its sunspot area in millionths of the hemisphere, and when SWPC first recorded it. Its flare probabilities cover the following day. A spotless region (plage) reads as such, with a null area
- Integral proton flux (≥10 MeV) drives the reported NOAA S-scale (0–5)
- Data sourced from the `goes/primary/xrays-6-hour.json`, `goes/primary/xray-flares-7-day.json`, `f107_cm_flux.json`, `solar_probabilities.json`, `goes/primary/integral-protons-plot-3-day.json`, and `solar_regions.json` feeds

---

### `noaa_spaceweather_get_alerts` <sub>tool</sub>

- `active_only` (default true) — in-force Warnings/Watches/Alerts only. A product stays in force until the feed says otherwise, so this also drops any product a later cancellation names by serial, and all but the newest Watch carrying `THIS SUPERSEDES ANY/ALL PRIOR WATCHES IN EFFECT` — alongside cancellations, Summaries, and products whose validity end has passed
- `max_age_hours` (1–720, default 48) bounds how far back to look for candidates; the SWPC feed itself has no expiry. Under `active_only=true` it does not cut off a product whose validity end is still ahead, so a multi-day Watch survives until the last day it forecasts a storm for ends; under `active_only=false` it is a literal age cutoff
- Each record carries product type, NOAA scale + level (0 means "no scale stated," not zero severity), serial number, parsed validity window, and full message text
- `cancelled` flags a record that cancels a prior product rather than being active; the product it cancels is a separate record, excluded by the serial link rather than by this flag
- Under `active_only=true` the response echoes the applied window and counts what it excluded, by reason — so an empty result reads as "quiet" or "everything was filtered" without a second call

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
| `MCP_SESSION_MODE` | HTTP session mode. This project explicitly uses `stateless`; `auto` resolves to `stateful`. | `stateless` |
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

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
