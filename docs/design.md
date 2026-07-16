# noaa-spaceweather-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `noaa_spaceweather_get_conditions` | Current space-weather snapshot: NOAA R/S/G storm scales (today + 3-day forecast), latest Kp index, and a plain-language status summary. The "is anything happening right now?" heartbeat tool. | _(none required)_ | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_spaceweather_get_kp_index` | Planetary K-index (0–9 geomagnetic activity scale) — recent observed 3-hour values with their NOAA G-scale equivalents and aurora-latitude guidance, plus the 3-day forecast series. Primary driver of aurora visibility and geomagnetic storm severity. | `window_days` (`z.number().int().min(1).max(7)`, default 1) | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_spaceweather_get_aurora_forecast` | OVATION model aurora forecast for the next ~30–60 min: global grid of aurora probability percentages by lat/lon. With optional coordinates, returns local visibility probability, minimum Kp needed at that latitude, and a plain-language go/no-go. | `latitude` (−90–90, optional), `longitude` (−180–180, optional) | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_spaceweather_get_solar_wind` | Real-time solar wind from the active L1 spacecraft: speed (km/s), proton density (n/cm³), temperature, and the critical Bz component (southward = storm driver). Recent time series, each record tagged with its reporting spacecraft. Explains why current geomagnetic conditions exist. | `window_hours` (`z.number().int().min(1).max(168)`, default 3) | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_spaceweather_get_solar_activity` | Solar flare and radiation storm picture: recent X-ray flux from GOES, 3-day flare-class probabilities (C/M/X), active solar regions with per-region flare probability, solar radiation storm level, and proton flux at ≥10 MeV. For operators tracking HF radio blackout and radiation storm risk. | `include_regions` (bool, default true) | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_spaceweather_get_alerts` | Active SWPC alerts, watches, and warnings — parsed into structured records with product type, severity level, issue time, validity window, and plain text. Covers geomagnetic storms, radio blackouts, radiation storms, and aurora bulletins. | `active_only` (bool, default true) | `readOnlyHint: true`, `openWorldHint: true` |

### Resources

_(none — all data is real-time, no stable URIs; tool surface is self-sufficient)_

### Prompts

_(none — data/action-oriented server)_

---

## Overview

`noaa-spaceweather-mcp-server` wraps NOAA's Space Weather Prediction Center (SWPC) public JSON feeds — all keyless, free, and served from `services.swpc.noaa.gov`. It translates raw space-weather indices and grids into meaningful, agent-ready output: Kp 7 becomes "G3 storm — aurora possible to ~45° geomagnetic latitude"; a southward Bz becomes "storm-driving conditions"; an X1.0 flare becomes "R3 radio blackout in progress." Interpretation is the value.

**Audience:** Aurora chasers, HF radio and satellite/GPS operators, power-grid and aviation planners, and agents answering "can I see the aurora tonight?" or "is a geomagnetic storm happening?"

Part of the NOAA cluster (`nws-weather` for terrestrial forecasts, `noaa-cdo` for historical climate). Space weather has its own vocabulary — solar/geomagnetic, not atmospheric — and its own audience. Tools are namespaced `noaa_spaceweather_*`.

---

## Requirements

- No API key; no auth; all feeds are public at `services.swpc.noaa.gov`
- Polite `User-Agent` header on every request
- Keyless, fully hostable
- Read-only; no write operations
- Feeds update at different cadences — surface each value's `observed_time` so agents know freshness
  - Solar wind: ~1 min; OVATION aurora: ~5 min; Kp: 3-hour intervals; NOAA scales: real-time; alerts: as-issued
- Feed shapes are heterogeneous — normalization required per feed (see API Reference)
- Interpretation layer converts raw indices to NOAA storm scales and plain-language guidance

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `SpaceWeatherService` | NOAA SWPC JSON feeds via `fetchWithTimeout` + `withRetry` | All tools |

Single service — all six tools call into the same service. The service exposes per-feed methods that normalize the diverse shapes (array-of-objects, keyed objects, coordinate triples) into clean typed records. Handlers assemble tool responses from composed service calls.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| _(none)_ | — | All SWPC feeds are public and keyless. Standard `MCP_*` framework env vars apply. |

No `server-config.ts` needed — no domain-specific config beyond what the framework handles.

---

## Implementation Order

1. **`SpaceWeatherService`** — `src/services/space-weather/space-weather-service.ts` with typed methods per feed, normalization helpers, and NOAA-scale translation utilities. Each method returns clean domain objects, not raw feed shapes.
2. **`noaa_spaceweather_get_conditions`** — composes scales + Kp current; simplest integration test of the service.
3. **`noaa_spaceweather_get_alerts`** — pure feed parse; no interpretation beyond product-code parsing.
4. **`noaa_spaceweather_get_kp_index`** — Kp series + forecast; validates the array-of-objects normalization.
5. **`noaa_spaceweather_get_solar_wind`** — RTSW plasma + mag feeds; validates the active-spacecraft filter and the oldest-first ordering.
6. **`noaa_spaceweather_get_solar_activity`** — X-ray flux + solar regions + probabilities; most complex assembly.
7. **`noaa_spaceweather_get_aurora_forecast`** — OVATION grid; coordinate lookup and local probability extraction.

Each step is independently testable. Service methods can be unit-tested directly with mock responses.

---

## Error Contracts

Typed error contracts for each tool — becomes the literal `errors: [...]` entries during scaffolding.

| Tool | reason | code | when | recovery |
|:-----|:-------|:-----|:-----|:---------|
| all tools | `feed_unavailable` | `ServiceUnavailable` | SWPC endpoint returns non-OK or times out | Retry in 30–60 s; SWPC feeds occasionally lag during high-activity events |
| `get_aurora_forecast` | `invalid_coordinates` | `InvalidParams` | `latitude` outside −90–90 or `longitude` outside −180–180 | Provide latitude in range [−90, 90] and longitude in range [−180, 180] |
| `get_solar_wind` | `invalid_window` | `InvalidParams` | `window_hours` outside 1–168 | Use a value between 1 and 168 |
| `get_kp_index` | `invalid_window` | `InvalidParams` | `window_days` outside 1–7 | Use a value between 1 and 7 |

Baseline infrastructure errors (`InternalError`, `Timeout`, `SerializationError`) bubble freely from the service layer and do not need declaring.

---

## Domain Mapping

| Noun | Operations | API Feed |
|:-----|:-----------|:---------|
| Storm scales (R/S/G) | get current + 3-day forecast | `noaa-scales.json` |
| Planetary K-index | list recent observed, list forecast | `noaa-planetary-k-index.json`, `noaa-planetary-k-index-forecast.json` |
| Aurora forecast | get current OVATION grid, lookup by coordinate | `ovation_aurora_latest.json` |
| Solar wind | list recent plasma series, list recent mag series | `json/rtsw/rtsw_wind_1m.json`, `json/rtsw/rtsw_mag_1m.json` |
| Solar activity | get X-ray flux series, get active regions, get flare probabilities | `goes/primary/xrays-7-day.json`, `solar_regions.json`, `solar_probabilities.json` |
| Alerts | list active alerts/watches/warnings | `products/alerts.json` |

---

## Design Decisions

**Single service, no per-feed service split.** All six tools call one `SpaceWeatherService`. The feeds are from the same domain, share the same base URL, have identical resilience requirements, and a single `fetchWithTimeout`+`withRetry` utility covers them all. Per-feed services would add files without adding isolation value.

**No resources.** Space weather data is real-time and feed-based — there are no stable resource URIs that would give agents more than the tools already provide. Resources fit addressable entities (a specific study, a specific report); these are live sensor feeds with no meaningful URI identity.

**No prompts.** The server is data-oriented. The interpretation layer in tool outputs makes prompts redundant for this domain.

**Tool `noaa_spaceweather_get_conditions` as the heartbeat.** This tool composes the NOAA scales + current Kp + a narrative summary. It's the first call any agent should make. It's the cheapest way to answer "is anything happening right now?" before deciding whether to drill deeper.

**Aurora tool accepts optional coordinates, not required.** The global OVATION grid is useful without coordinates (for general awareness), but the primary user goal ("can I see the aurora from here?") requires a coordinate. Making coordinates optional serves both cases without splitting into two tools.

**`window_hours`/`window_days` parameters on time-series tools.** Solar wind and Kp are time series. Defaulting to the last 1–3 hours covers the "current conditions" case; a larger window covers operators tracking trends. The service fetches each feed once and slices client-side — no extra upstream calls per window size.

**`window_hours` keeps its 1–168 range after the RTSW port, even though the feed spans ~24h.** SWPC removed `/products/solar-wind/`; its RTSW replacement carries roughly 24 hours, so windows beyond that can't be satisfied. Narrowing the validator to 24 would reject inputs that used to be valid — a breaking change to the tool's contract for no gain, since an over-wide window is not an error, it just returns the whole feed. Instead the range is documented and the response reports feed freshness (below), so the caller can tell "quiet" from "stale" rather than guessing.

**Empty windows report feed freshness instead of a bare empty array.** `latestFeedPlasmaTime`, `latestFeedMagTime`, and `feedStalenessHours` are read from the unwindowed series and always populated, so a caller that gets no rows can see what the feed actually holds. The human-readable advisory rides `ctx.enrich.notice()` rather than an output field: the framework mirrors enrichment into both `structuredContent` and the `content[]` trailer, and a plain `notice` output field would instead trip the linter's `enrichment-prefer-block` rule.

**Solar wind filters to the spacecraft SWPC flags `active`.** The RTSW feeds interleave every reporting spacecraft (`SOLAR1`, `ACE`, `IMAP`), and `overall_quality` is uniformly `0`, so `active` is the only discriminating signal. Records carry their `source` rather than the tool naming a satellite — the removed feed exposed no source at all, so the tool hardcoded `DSCOVR` and simply asserted it; RTSW reports the spacecraft per record, so echoing the feed survives the next roster change.

**The service normalizes solar wind ordering to oldest-first.** RTSW serves newest-first, the removed feed served oldest-first, and the tool's "latest = last element" contract plus its rendered time series both assume chronological order. Sorting in the service makes ordering an explicit invariant of the domain type instead of an accident of upstream.

**Bz is surfaced prominently in solar wind output.** Southward Bz (negative) is the primary driver of geomagnetic storm development. It belongs in the summary and format output as a first-class field, not buried in a metrics array.

**NOAA scale text included alongside numeric values.** Raw Kp = 6 is opaque; "G2 moderate storm — aurora possible to ~45° geomagnetic latitude" is actionable. Both are returned so agents can reason with the number and format with the text.

**Proton flux included in solar activity, not a separate tool.** The ≥10 MeV proton flux (S-scale) is part of the same radiation storm picture as X-ray flux and active regions. Splitting it into a separate tool would force agents to call both for a complete solar-activity answer.

---

## API Reference

### Feed Shapes (confirmed by live probing)

| Feed | Path | Shape | Key Fields |
|:-----|:-----|:------|:-----------|
| Storm scales | `/products/noaa-scales.json` | Object keyed `"0"`, `"1"`, `"2"`, `"3"`, `"-1"` (today, days 1–3, yesterday) | `DateStamp`, `TimeStamp`, `R.Scale`, `R.Text`, `R.MinorProb`, `R.MajorProb`, `S.Scale`, `S.Text`, `S.Prob`, `G.Scale`, `G.Text` |
| K-index observed | `/products/noaa-planetary-k-index.json` | Array of objects | `time_tag` (ISO), `Kp` (float), `a_running`, `station_count` |
| K-index forecast | `/products/noaa-planetary-k-index-forecast.json` | Array of objects | `time_tag`, `kp` (float), `observed` (`"observed"` or `"predicted"`), `noaa_scale` (nullable) |
| Aurora (OVATION) | `/json/ovation_aurora_latest.json` | Object with top-level metadata + `coordinates` array | `Observation Time`, `Forecast Time`, `Data Format` (`"[Longitude, Latitude, Aurora]"`), `coordinates` (array of `[lon, lat, aurora%]` triples) |
| Solar wind plasma (RTSW) | `/json/rtsw/rtsw_wind_1m.json` | Array of objects, newest-first, spacecraft interleaved | `time_tag` (T-separated, no `Z`), `active` (bool), `source` (e.g. `SOLAR1`, `ACE`, `IMAP`), `proton_speed`, `proton_density`, `proton_temperature` (numbers) |
| Solar wind mag (RTSW) | `/json/rtsw/rtsw_mag_1m.json` | Array of objects, newest-first, spacecraft interleaved | `time_tag`, `active`, `source`, `bt`, `bx_gsm`, `by_gsm`, `bz_gsm` (numbers). `max_data_flag` is `-9999` on live active rows and is not mapped |
| GOES X-ray flux | `/json/goes/primary/xrays-7-day.json` | Array of objects | `time_tag` (ISO Z), `satellite` (int), `flux` (float, W/m²), `observed_flux`, `electron_correction`, `electron_contaminaton`, `energy` (`"0.05-0.4nm"` or `"0.1-0.8nm"`) |
| Solar regions | `/json/solar_regions.json` | Array of objects | `observed_date`, `region` (int, NOAA AR number), `latitude`, `longitude`, `location` (e.g. `N17E47`), `area`, `spot_class`, `number_spots`, `mag_class`, `c_flare_probability`, `m_flare_probability`, `x_flare_probability`, `proton_probability` |
| Solar probabilities | `/json/solar_probabilities.json` | Array of objects | `date` (ISO), `c_class_1_day`, `m_class_1_day`, `x_class_1_day`, `10mev_protons_1_day`, etc. (int %) for days 1–3, `polar_cap_absorption` |
| Proton flux | `/json/goes/primary/integral-protons-plot-3-day.json` | Array of objects | `time_tag` (ISO Z), `satellite`, `flux` (float, pfu), `energy` (`">=10 MeV"`, `">=50 MeV"`, `">=100 MeV"`, `">=500 MeV"`) |
| Alerts | `/products/alerts.json` | Array of objects | `product_id` (e.g. `K04W`, `A50F`, `XX0S`), `issue_datetime`, `message` (raw text with CRLF, includes machine-readable structured fields) |

### Alert Product Parsing

The message code's prefix gives the product type — `WAR*` Warning, `WAT*` Watch, `ALT*` Alert, `SUM*` Summary. Everything else is read from the message body; the rest of the code is not a severity.

- **Level and phenomenon come from the scale the body states** — either a `NOAA Scale: G1 - Minor` line or a Watch headline's `Category G2`. The letter gives the phenomenon (`G` Geomagnetic, `R` Radio Blackout, `S` Solar Radiation); the digit gives the level.
- **A code's numeric suffix is not a severity.** It encodes flux thresholds (`EF3`), radio-burst types (`TP2`, `TP4`), wavelengths (`10R`), and predicted A-index (`A20`, `A30`, `A50`). Reading it as a level reports `SUM10R` as level 10 and `WATA30` as level 30.
- **Products stating no scale resolve to level 0**, meaning "no NOAA scale" — not a severity of zero. K-index codes convert through `kpToGScale()` (K4 sits below the G-scale, so `WARK04`/`ALTK04` → 0); `ALTEF3`, `ALTTP2`, `ALTTP4`, `SUM10R`, and `WARSUD` sit outside the scales entirely.
- **The code is a phenomenon fallback only**, keyed on its core: `A`/`G`/`K` + digit → Geomagnetic (the `A` family is a predicted-A-index storm watch, not an aurora bulletin); `SUD` → Geomagnetic (Sudden Impulse — its leading `S` is not the solar-radiation scale letter); `X`/`R` → Radio Blackout; `PX`/`S` → Solar Radiation.
- **The scale label is matched case-insensitively and without a line anchor.** SWPC emits both `NOAA Scale:` and `Noaa Scale:`, and sometimes glues correction prose straight onto the label with no line break (`...valid until 12/2100 UTC.NOAA Scale: G1 - Minor`).

### NOAA Scale Reference

| Scale | Index | Descriptor | Kp equiv | Aurora latitude |
|:------|:------|:-----------|:---------|:----------------|
| G0 | 0 | None | < 5 | — |
| G1 | 1 | Minor | 5 | ≤ 60° |
| G2 | 2 | Moderate | 6 | ≤ 55° |
| G3 | 3 | Strong | 7 | ≤ 50° |
| G4 | 4 | Severe | 8 | ≤ 45° |
| G5 | 5 | Extreme | 9 | ≤ 40° |
| R1 | 1 | Minor | — | HF radio degraded |
| R3 | 3 | Strong | — | HF blackout likely |
| S1 | 1 | Minor | — | Minor radiation risk |
| S3+ | 3+ | Strong | — | Radiation risk; polar-route concern |

### Update Cadences

| Feed | Cadence |
|:-----|:--------|
| Solar wind (plasma, mag) | ~1 min |
| GOES X-ray flux | ~1 min |
| OVATION aurora | ~5 min |
| NOAA scales | Real-time (updated on events) |
| Alerts | As-issued |
| Kp observed | 3-hour intervals |
| Kp forecast | 3-hour intervals |
| Solar regions | Daily |
| Solar probabilities | Daily |

### Normalization Notes

**NOAA scales key semantics:** Key `"0"` = today, keys `"1"`–`"3"` = next 3 days, `"-1"` = yesterday. Each entry has both `DateStamp` (date string) and `TimeStamp` (HH:MM:SS UTC) — use both for freshness display. Warning: keys `"0"` and `"1"` frequently share the same `DateStamp` when the current forecast period extends past midnight UTC into the next calendar day; do not deduplicate by date.

**RTSW solar wind:** `rtsw_wind_1m.json` and `rtsw_mag_1m.json` are arrays of objects, served newest-first, interleaving every reporting spacecraft. The service keeps only `active: true` records (`overall_quality` is uniformly `0`, so it discriminates nothing), carries each record's `source`, and sorts oldest-first to match the chronological series the tool renders. Values are already numbers. `time_tag` is T-separated without a `Z` — `normalizeSwpcTime` appends one. The tool compares epoch millis rather than ISO strings when windowing: RTSW tags carry no milliseconds and so don't collate against a `toISOString()` cutoff that does. Plasma and mag agree on the active source at every shared timestamp, so the two feeds need no cross-reconciliation.

**OVATION coordinates:** `coordinates` is an array of `[longitude, latitude, aurora_probability%]` triples (integers). For a given coordinate lookup, find the nearest grid point (1° resolution, 360 longitudes × 181 latitudes) and return its aurora probability.

**Scale values can be `null`** in `noaa-scales.json` when a forecast is unavailable for that period — normalize nulls to `0` (no storm) or mark as `unknown` depending on the field context.

**Alerts message text:** Raw CRLF-separated text. The service parses out the structured fields (product code, serial number, issue time, validity window, warning conditions) via regex on the structured lines, and preserves the full message for downstream use. The validity window is labeled differently per product type — `Valid From`/`Valid To` (Warnings/Watches), `Now Valid Until` (extended Warnings), and `Begin Time`/`End Time` (Alerts/Summaries) — and is normalized to ISO 8601 UTC; products carrying no time line keep `null`.

**Alert cancellations:** SWPC cancels a product by issuing a new record under the same message code with a `CANCEL WARNING:`/`CANCEL ALERT:` headline. A cancellation keeps the cancelled product's own type and carries no validity window, so neither the product-type nor the elapsed-`validTo` check excludes it — the service flags it as `cancelled` and `get_alerts` drops it from `active_only=true`. Detection is per record, never cached per code: a single code cycles CONTINUED → CANCEL → CONTINUED within minutes. `EXTENDED WARNING:` and `CONTINUED` headlines mean the product is still in force and are deliberately not cancellations. The explanation line varies (`Conditions no longer justify...`, `Should have only been valid until...`, `Incorrect maximum value...`), so the headline is the only reliable marker.
