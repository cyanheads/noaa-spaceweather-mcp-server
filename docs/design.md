# noaa-spaceweather-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `noaa_spaceweather_get_conditions` | Current space-weather snapshot: NOAA R/S/G storm scales (the levels SWPC assessed for the previous UTC day, today's observed levels, and SWPC's 3-day forecast, which starts with today), latest Kp index, and a plain-language status summary. Forecast days carry a G level but only probabilities for R and S — SWPC issues no R/S level for a future day. Optionally includes the forecaster-written Forecast Discussion explaining the forecast. The "is anything happening right now?" heartbeat tool. | `include_discussion` (bool, default false) | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_spaceweather_get_kp_index` | Planetary K-index (0–9 geomagnetic activity scale) — recent observed 3-hour values with their NOAA G-scale equivalents and aurora-latitude guidance, plus the 3-day forecast series. Primary driver of aurora visibility and geomagnetic storm severity. | `window_days` (`z.number().int().min(1).max(7)`, default 1) | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_spaceweather_get_aurora_forecast` | OVATION model aurora forecast for the next ~30–60 min: global grid of aurora probability percentages by lat/lon. With optional coordinates, returns local visibility probability, the geomagnetic latitude those coordinates convert to, the minimum Kp and G level needed at that geomagnetic latitude, the sun's elevation and darkness state there at the forecast time, the strongest reading within 1000 km poleward, and a plain-language go/no-go that reports daylight as not visible. | `latitude` (−90–90, optional), `longitude` (−180–180, optional) | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_spaceweather_get_solar_wind` | Real-time solar wind from the active L1 spacecraft: speed (km/s), proton density (n/cm³), temperature, and the critical Bz component (southward = storm driver) with the window's most southward reading and its time tag, plus window maxima of speed, density, and Bt and the minutes of southward Bz. Recent time series, each record tagged with its reporting spacecraft and bounded to 200 records per series at the default resolution, or omitted under `summary`. Explains why current geomagnetic conditions exist. | `window_hours` (`z.number().int().min(1).max(168)`, default 3), `resolution` (`z.enum(['summary','reduced','full'])`, default `reduced`) | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_spaceweather_get_solar_activity` | Solar flare and radiation storm picture: discrete flare events from the past week with the classes SWPC published and the R-scale level their peak flux implies, recent X-ray flux from GOES with flare-class letter and magnitude, the daily F10.7 cm radio flux, 3-day flare-class probabilities (C/M/X), active solar regions with the flares SWPC attributed to each that day and per-region flare probability, solar radiation storm level, and proton flux at ≥10 MeV. For operators tracking HF radio blackout and radiation storm risk. | `include_regions` (bool, default true), `flare_hours` (`z.number().int().min(1).max(168)`, default 24) | `readOnlyHint: true`, `openWorldHint: true` |
| `noaa_spaceweather_get_alerts` | Active SWPC alerts, watches, and warnings — parsed into structured records with product type, severity level, issue time, serial number, validity window, and plain text. Covers geomagnetic storms, radio blackouts, radiation storms, and aurora bulletins. | `active_only` (bool, default true), `max_age_hours` (`z.number().min(1).max(720)`, default 48) | `readOnlyHint: true`, `openWorldHint: true` |

### Resources

_(none — all data is real-time, no stable URIs; tool surface is self-sufficient)_

### Prompts

_(none — data/action-oriented server)_

---

## Overview

`noaa-spaceweather-mcp-server` wraps NOAA's Space Weather Prediction Center (SWPC) public JSON feeds — all keyless, free, and served from `services.swpc.noaa.gov`. It translates raw space-weather indices and grids into meaningful, agent-ready output: Kp 7 becomes "G3 storm — aurora possible to ~50° geomagnetic latitude"; a southward Bz becomes "storm-driving conditions"; an X1.0 flare becomes "R3 radio blackout in progress." Interpretation is the value.

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
6. **`noaa_spaceweather_get_solar_activity`** — X-ray flux + flare events + F10.7 + solar regions + probabilities + proton flux; most complex assembly, six composed feeds.
7. **`noaa_spaceweather_get_aurora_forecast`** — OVATION grid; coordinate lookup and local probability extraction.

Each step is independently testable. Service methods can be unit-tested directly with mock responses.

---

## Error Contracts

The `errors: [...]` entries each tool declares, inline per tool.

| Tool | reason | code | retryable | when | recovery |
|:-----|:-------|:-----|:----------|:-----|:---------|
| all tools | `feed_unavailable` | `ServiceUnavailable` | `true` | SWPC feed returns 5xx or 429, times out, or answers with a body that is not parseable JSON — or, on the forecast-discussion text product, not text at all (an HTML error page included), or its retry ladder runs out of its 45 s budget. Retried — up to four attempts inside that budget | Retry in 30–60 s; SWPC feeds occasionally lag during high-activity events |
| all tools | `feed_moved` | `ServiceUnavailable` | `false` | SWPC feed path returns a permanent 4xx (404, 410, 401, 403, and the rest), or a feed answers without the shape it is documented to have — on `get_conditions`, the scales feed no longer carrying its `"0"` (today) period, or the forecast discussion carrying no topic section; on `get_aurora_forecast`, a coordinate lookup finding no parseable `Forecast Time`. One attempt | Retrying will not help; the feed path no longer resolves or no longer has the expected shape, and the feed URL needs updating against SWPC's current inventory |
| `get_aurora_forecast` | `invalid_coordinates` | `ValidationError` | — | One coordinate supplied without the other | Provide both latitude and longitude together, or omit both for global metadata only |

Coordinate and window *bounds* (`latitude` −90–90, `longitude` −180–180, `window_hours` 1–168, `window_days` 1–7, `flare_hours` 1–168) are Zod constraints, not contract entries: the handler never runs, so the framework rejects them as `InvalidParams` with its own `invalid_arguments` reason and a schema-derived hint. A bound enforced in both places would leave the contract entry unreachable — see `api-errors`.

Baseline infrastructure errors (`InternalError`, `Timeout`, `SerializationError`, `RequestCancelled`) bubble freely from the service layer and do not need declaring. A caller abort stays `RequestCancelled` and carries no reason — it is not a feed failure.

---

## Domain Mapping

| Noun | Operations | API Feed |
|:-----|:-----------|:---------|
| Storm scales (R/S/G) | get current + 3-day forecast | `noaa-scales.json` |
| Forecast discussion | get the forecaster's narrative, by topic section | `text/discussion.txt` |
| Planetary K-index | list recent observed, list forecast | `noaa-planetary-k-index.json`, `noaa-planetary-k-index-forecast.json` |
| Aurora forecast | get current OVATION grid, lookup by coordinate | `ovation_aurora_latest.json` |
| Solar wind | list recent plasma series, list recent mag series | `json/rtsw/rtsw_wind_1m.json`, `json/rtsw/rtsw_mag_1m.json` |
| Solar activity | get X-ray flux series, get discrete flare events, get F10.7 index, get active regions, get flare probabilities | `goes/primary/xrays-6-hour.json`, `goes/primary/xray-flares-7-day.json`, `f107_cm_flux.json`, `solar_regions.json`, `solar_probabilities.json` |
| Alerts | list active alerts/watches/warnings | `products/alerts.json` |

---

## Design Decisions

**Single service, no per-feed service split.** All six tools call one `SpaceWeatherService`. The feeds are from the same domain, share the same base URL, have identical resilience requirements, and a single `fetchWithTimeout`+`withRetry` utility covers them all. Per-feed services would add files without adding isolation value.

**Feed failures are classified in `fetchFeed`, outside the `withRetry` boundary.** `fetchFeed` is the single funnel every feed call passes through and it already receives `ctx`, so `ctx.recoveryFor(reason)` resolves the calling tool's hint without the service knowing which tool called it. It enriches the rejected `McpError` — adding `reason`, the recovery hint, and `path` — rather than replacing it, so `status`, `statusText`, `retryAfter`, `retryAttempts`, and `available` all survive to the client. Two placements were rejected: wrapping in the handlers needs a `try/catch` in all six, which the project's core rule forbids, and `ctx.fail` builds a *new* error from `{...data, reason}`, dropping the upstream diagnostics unless every handler re-spreads them. Sitting outside the retry boundary is what keeps the attempt counts intact: both reasons map to `ServiceUnavailable`, which is in the framework's transient set, so rewriting the code inside the retry closure would turn a permanent 404 into four attempts against a feed SWPC no longer serves. The tradeoff accepted is that the conformance linter only scans handler source for `throw`, so a service-raised reason is not lint-enforced as reachable; one wire-shape test per reason per tool compensates.

**Each feed's retry ladder runs inside one 45 s wall-clock budget (`RETRY_DEADLINE_MS`, `withRetry`'s `deadlineMs`).** Four 15 s attempts plus ~7 s of backoff ran ~67 s against an upstream that accepts the connection and never answers, so a client with a 60 s request timeout saw a transport timeout instead of `feed_unavailable` and its recovery hint. 45 s leaves 15 s for the error to cross the transport while still fitting three hung attempts, and a fast failure's full four-attempt ladder (~7 s) never touches it — its attempt count and timing are unchanged. Each attempt threads `withRetry`'s attempt signal (the deadline composed with `ctx.signal`) into its request, so an expiry mid-attempt aborts the request in flight rather than waiting out its own 15 s timeout. The expiry, a `Timeout` carrying `retry_deadline_exceeded` and no status, classifies as `feed_unavailable` like any other transient failure, and `deadlineMs`/`elapsedMs`/`retryAttempts` survive on `data`. An honored `Retry-After` that would outlast what is left stops the ladder with the upstream's own error, `retryAfter` intact. A caller abort still outranks the deadline. Feeds a tool composes run their ladders in parallel, so the budget bounds the call.

**`feed_moved` is a separate reason, not a message variant.** The recovery hint is resolved from the contract by `ctx.recoveryFor`, so one reason can carry exactly one hint — and the two hints point in opposite directions. A 503 clears on its own and "retry in 30–60 s" is right; a removed feed never clears without a code change, and the same hint would tell the agent to burn retries on something that can never succeed. Both map to `ServiceUnavailable` because the failure is upstream either way: these tools accept no upstream identifier, so no 4xx from these feeds can be caused by caller input, and an agent reading `NotFound` would conclude "the thing I asked for doesn't exist" when the truth is "this server is pointed at a feed SWPC no longer serves".

**No resources.** Space weather data is real-time and feed-based — there are no stable resource URIs that would give agents more than the tools already provide. Resources fit addressable entities (a specific study, a specific report); these are live sensor feeds with no meaningful URI identity.

**No prompts.** The server is data-oriented. The interpretation layer in tool outputs makes prompts redundant for this domain.

**Tool `noaa_spaceweather_get_conditions` as the heartbeat.** This tool composes the NOAA scales + current Kp + a narrative summary. It's the first call any agent should make. It's the cheapest way to answer "is anything happening right now?" before deciding whether to drill deeper.

**Aurora tool accepts optional coordinates, not required.** The global OVATION grid is useful without coordinates (for general awareness), but the primary user goal ("can I see the aurora from here?") requires a coordinate. Making coordinates optional serves both cases without splitting into two tools.

**Aurora darkness is judged once, at the requested coordinates.** Aurora is seen against the observer's own sky, so what decides visibility is whether that sky is dark — not whether the overhead or horizon grid cell is sunlit. The gate runs before any probability clause, and a daylit verdict never carries one: OVATION reads non-zero on the oval's dayside (in one live draw, 7,828 sunlit cells up to 8%), and SWPC states that aurora is not visible during daylight. Four states rather than five: astronomical twilight folds into `dark`, since the twilight caveat already covers everything short of it. Moon phase and cloud cover are out of scope — weather-server data.

**The horizon clause shares the 10% floor, not the ladder's 5%.** SWPC's 1000 km view distance applies to bright aurora, and 10% is where this tool already reads a cell as real oval signal rather than model noise (the #9 artifact read 8%). The clause is added only when the horizon reading also beats the overhead one, so it never restates what the ladder said.

**A coordinate lookup with no parseable `Forecast Time` fails as `feed_moved`.** The daylight gate has no instant to evaluate without it, and guessing one (the observation time, or now) would silently shift every darkness call. The global-metadata call does not need the time and still answers.

**`window_hours`/`window_days` parameters on time-series tools.** Solar wind and Kp are time series. Defaulting to the last 1–3 hours covers the "current conditions" case; a larger window covers operators tracking trends. The service fetches each feed once and slices client-side — no extra upstream calls per window size.

**`window_hours` keeps its 1–168 range after the RTSW port, even though the feed spans ~24h.** SWPC removed `/products/solar-wind/`; its RTSW replacement carries roughly 24 hours, so windows beyond that can't be satisfied. Narrowing the validator to 24 would reject inputs that used to be valid — a breaking change to the tool's contract for no gain, since an over-wide window is not an error, it just returns more of the same feed. What an over-wide window used to *cost* is what changed: it returned every record it reached, so any window at or above 24 hours rendered the whole feed twice for a ~540 KB response. The range stays; the series it returns is bounded instead (below), and the response reports feed freshness so the caller can tell "quiet" from "stale" rather than guessing.

**Empty windows report feed freshness instead of a bare empty array.** `latestFeedPlasmaTime`, `latestFeedMagTime`, and `feedStalenessHours` are read from the unwindowed series and always populated, so a caller that gets no rows can see what the feed actually holds. The human-readable advisory rides `ctx.enrich.notice()` rather than an output field because it is retrieval context rather than a measurement: enrichment reaches both `structuredContent` and the `content[]` trailer on its own, so the advisory needs no `format()` line and never reads as data the feed reported.

**The solar wind series are bounded per call, by per-bucket extreme, and only past 200 records.** `resolution` (`summary`, `reduced` default, `full`) bounds each series to at most `REDUCED_SERIES_MAX` = 200 records at `reduced`. The ceiling is pinned at 200 because the default 3-hour call already sits under it at roughly 170 records per series, so the default response is byte-identical to the unbounded build and reduction begins only when the caller widens the window. Five choices inside that:

- **Buckets by record count, not a stride or an average.** Over one measured 24-hour mag window the full-resolution minimum Bz was −4.95 nT; a raw index stride recovered −4.23 nT at 5 records per step and −3.97 nT at 12, each tagged to the wrong record, and a time-bucket average was worse still because averaging attenuates excursions. A per-bucket extreme recovered −4.95 nT exactly at every step tested, for the same emitted record count and byte cost. Short excursions are not rare — that window held 31 runs of Bz ≤ −2 nT, 20 of them shorter than 5 records — so the loss is arithmetic, not a property of a quiet day.
- **The extreme is the storm-relevant one per series**: the bucket's most southward `bzGsm` for mag, its fastest `speedKmS` for plasma. Every emitted element is a real upstream record, so a bucket whose readings are all null keeps its oldest record rather than dropping the interval.
- **The newest windowed record is always the final emitted element**, bucketed separately from the rest. `latestPlasma`, `latestMag`, `bzStatus`, and `bzMinInWindow` are all derived from the full windowed series before reduction, and a caller reading the series tail for "current Bz" would otherwise get whichever record happened to be its last bucket's extreme.
- **`bzMinInWindow` and `bzMinTimeTag` are output, the reduction factors are enrichment.** The minimum is derived domain data and the one number that survives any reduction, so it belongs in `output` where `format-parity` requires a rendered line — including the null branch, since `bzGsm` is nullable and the window can be empty. Bucket size and pre-reduction total describe how the response was assembled, so they ride the enrichment block. They are emitted only when a reduction actually happened: enrichment renders a `content[]` trailer, so populating them unconditionally would change the default call's bytes. Within a reduced response a series that stayed inside the bound reports a bucket of 1.
- **An enum, not a numeric per-series cap.** A cap-shaped input engages the linter's `capped-list-no-truncation` rule, whose disclosure `ctx.enrich.truncated({ shown, cap })` is single-valued while this tool reduces two independent series — and a caller wanting full resolution would have to guess how large "large enough" is. Every enum value names a resolution, and the reduction notice joins the same `notices` array the empty-window advisory builds, since the `notice` field is last-wins.

**`summary` is a third `resolution` value, not an `include_series` boolean.** The most common solar-wind question — what are Bz and speed now, and has Bz gone south lately — needs only the headline fields, yet the default 3-hour call was ~67 KB and `window_hours: 1` still ~22 KB. `summary` empties `plasma` and `mag` and keeps everything else, so the response stays at the headline size whatever the window. A boolean would overlap `resolution` and admit a contradictory `full` + no series; lowering the 200-record bound would change the default call and still never reach zero. `plasmaCount`/`magCount` and the `plasmaWindowRecords`/`magWindowRecords` enrichment report the records the window held under `summary`, so emptying the arrays does not hide how many existed; no bucket size is reported, since no bucketing ran.

**Window statistics are output fields computed from the pre-reduction window, like `bzMinInWindow`.** `speedMaxInWindow` (with `speedMaxTimeTag`), `densityMaxInWindow`, `btMaxInWindow`, and `bzSouthMinutesInWindow` are populated at every resolution from the same arrays `bzMinInWindow` reads, so they are identical across `summary`, `reduced`, and `full`. The maxima are nullable for an empty or all-null window. `bzSouthMinutesInWindow` counts mag records with `bzGsm < 0` rather than measuring wall-clock spans: each record is a 1-minute average, so the count is measured southward minutes, and the mag feed is not a guaranteed 1-minute grid — a gap adds nothing rather than being bridged by an assumption.

**Solar wind filters to the spacecraft SWPC flags `active`.** The RTSW feeds interleave every reporting spacecraft (`SOLAR1`, `ACE`, `IMAP`), and `overall_quality` is uniformly `0`, so `active` is the only discriminating signal. Records carry their `source` rather than the tool naming a satellite — the removed feed exposed no source at all, so the tool hardcoded `DSCOVR` and simply asserted it; RTSW reports the spacecraft per record, so echoing the feed survives the next roster change.

**The service normalizes solar wind ordering to oldest-first.** RTSW serves newest-first, the removed feed served oldest-first, and the tool's "latest = last element" contract plus its rendered time series both assume chronological order. Sorting in the service makes ordering an explicit invariant of the domain type instead of an accident of upstream.

**Bz is surfaced prominently in solar wind output.** Southward Bz (negative) is the primary driver of geomagnetic storm development. It belongs in the summary and format output as a first-class field, not buried in a metrics array.

**NOAA scale text included alongside numeric values.** Raw Kp = 6 is opaque; "G2 moderate storm — aurora possible to ~55° geomagnetic latitude" is actionable. Both are returned so agents can reason with the number and format with the text.

**Proton flux included in solar activity, not a separate tool.** The ≥10 MeV proton flux (S-scale) is part of the same radiation storm picture as X-ray flux and active regions. Splitting it into a separate tool would force agents to call both for a complete solar-activity answer.

**Discrete flare events belong to the solar-activity tool, not a flare-history tool of their own.** "What flares happened today, how big, and when did they peak?" is the same question the tool's flare-and-radiation picture already answers; a separate tool would make one question two calls. The events ride a `flare_hours` window (1–168, default 24) filtered on onset, for the same reason the other time-series tools carry one: the default covers "what just happened" and the ceiling covers the feed's whole rolling week.

**Flare classes are read as SWPC publishes them; only the X-ray flux readings derive one.** The flare feed already states `begin_class`, `max_class`, and `end_class` with magnitudes, so deriving those would risk disagreeing with upstream over data upstream owns. The flux feed states only a flux, so `flareClassFull` on `latestXray` / `recentXray[]` is derived — and the derivation has to match SWPC's, or one response reports the same flare two ways. SWPC **truncates** the decade quotient to one decimal: across a full 7-day flare capture all 29 published `max_class` values reproduce under truncation and only 11 under rounding, and rounding invents a class that does not exist at a decade edge (`9.986e-7` → `B10.0`). The quotient is snapped to 12 significant digits before truncating because binary division is inexact in an input-dependent way (`4.9e-5 / 1e-5` evaluates to `4.8999999999999995`, which a bare truncation reports as `M4.8`). Below the A1 floor of `1e-8` W/m² the magnitude is `null` — SWPC's scheme starts at A1.0, so `"A0.0"` for a zero reading or `"A0.9"` for `9.9e-9` would state a class no SWPC product writes. Zero and the occasional negative reading fall under the same floor: in a 7-day capture 431 of 9,982 long-channel readings were exactly `0.0` and none fell between 0 and `1e-8`. The bare `flareClass` letter is unchanged there and still reads `A`, the weakest letter it has — it is a populated field with an existing contract.

**The magnitude is a new field, not a change to `flareClass`.** `flareClass` keeps its bare letter and its description; `flareClassFull` carries the magnitude alongside. Rewriting the populated field's value format would break every consumer comparing `flareClass === 'X'` and contradict the field's own name. Same additive precedent as the date-neutral probability aliases (#16).

**`rScale` is derived from the peak flux, not parsed from the class string.** The NOAA scales page states the R levels as flux floors (R1 1e-5, R2 5e-5, R3 1e-4, R4 1e-3, R5 2e-3), the flux is already in hand, and a string parse would add a second spelling of the same threshold table.

**F10.7 takes the latest Noon report, not the feed's newest record.** The feed carries three reports per UTC day — Morning, Noon, Afternoon — and its index 0 is often that day's Afternoon report, while SWPC's own one-value summary product (`/products/summary/10cm-flux.json`) reports the Noon one. Noon is also the only schedule carrying `ninety_day_mean`, which is the figure HF propagation work reads next to the daily value. Selection is by time among the Noon records rather than by position, so it does not depend on the order upstream serves. The summary product itself was rejected as the source: it is 47 bytes but carries only `flux` and `time_tag`. The value can be ~24 h old, so `observedTime` rides with it instead of being read as "now".

**X-ray flux reads the 6-hour feed, not the 7-day one.** The tool slices the past hour, and the 6-hour feed's 710 records are byte-identical JSON to the newest 710 of the 7-day feed — same seven keys, same two energy channels, same 1-minute cadence, same newest timestamp — so the slice is the same 61 records either way, for ~4.36 MB (96.4%) less per call. That saving is what keeps the two added feeds from making the tool more expensive than it was.

**`get_solar_activity` keeps `Promise.all` across all six feeds.** Any feed failure fails the call with the declared `feed_unavailable` / `feed_moved` reason. `Promise.allSettled` with per-feed nulls would make a null `f107` ambiguous between "feed down" and "no data" — the thing the project's preserve-uncertainty rule forbids — and a partial-degradation posture is a decision for all six tools and the error contract, not a side effect of adding a feed.

**"Which region produced today's flares?" is answered by per-region daily counts, not per-flare attribution.** The GOES flare feed carries no region or location, so tagging each `recentFlares[]` event with its region needs SWPC's edited-events product — a larger change. The regions feed already fetched carries `c_xray_events` / `m_xray_events` / `x_xray_events` per region per UTC day, which close most of the question: on 2026-09-22 it credited Region 4536 with 2 C events and 4534 with 1, matching the three C-class flares in `recentFlares` that day. The counts are same-day tallies while the probability fields on the same record cover the following day, so both descriptions and the rendered lines say which day each covers. A spotless region (plage) renders as "no spots (plage)" with a null area rather than an empty `Class: /` line.

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
| GOES X-ray flux | `/json/goes/primary/xrays-6-hour.json` | Array of objects, oldest-first, 1-minute cadence, both energy channels interleaved (710 records / 162 KB) | `time_tag` (ISO Z), `satellite` (int), `flux` (float, W/m²), `observed_flux`, `electron_correction`, `electron_contaminaton`, `energy` (`"0.05-0.4nm"` or `"0.1-0.8nm"`). Byte-identical per record to the newest 710 of `xrays-7-day.json` (19,964 records / 4.5 MB) |
| GOES X-ray flares | `/json/goes/primary/xray-flares-7-day.json` | Array of objects, one per discrete flare event, oldest-first, rolling 7 days (29 records / 11 KB in a full-window capture) | `time_tag` (ISO Z, equal to `begin_time` on every record — SWPC publishes at onset), `begin_time`, `begin_class` (e.g. `"B4.2"`), `max_time`, `max_class`, `max_xrlong` (float, W/m² peak long-channel), `end_time` (nullable), `end_class` (nullable), `satellite` (int). Not mapped: `max_ratio` / `max_ratio_time` (null on 8 of 29) and `current_int_xrlong`, an *integrated* flux ~4 decades above the peak. All 12 keys present on every record, so sparsity arrives as `null`, never as an absent key |
| F10.7 cm radio flux | `/json/f107_cm_flux.json` | Array of objects, **newest-first**, 3 reports per UTC day (123 records / 23 KB) | `time_tag` (T-separated, **no `Z`**), `frequency` (2800 on every record, not mapped), `flux` (float, sfu), `reporting_schedule` (`"Morning"` 17:00, `"Noon"` 20:00, `"Afternoon"` 22:00), `avg_begin_date`, `ninety_day_mean`, `rec_count` — the last three populated on the Noon records only |
| Solar regions | `/json/solar_regions.json` | Array of objects, reverse-chrono, ~30 days of daily records (229 records in a 2026-09-22 capture) | `observed_date`, `region` (int, NOAA AR number), `latitude`, `longitude`, `location` (e.g. `N17E47`), `area` (millionths of the hemisphere), `spot_class`, `number_spots`, `mag_class`, `c_xray_events` / `m_xray_events` / `x_xray_events` (flares SWPC attributed to the region on `observed_date`, updated during that day), `first_date` (T-separated, no `Z`), `c_flare_probability`, `m_flare_probability`, `x_flare_probability`, `proton_probability` (the following day). `area`, `spot_class`, `number_spots`, and `mag_class` are null together on a spotless region (67 of 229), never separately. Not mapped: `extent`, `mag_string`, `status`, `proton_events`, `s_flares`, `impulse_flares_1`–`4`, `protons`, Carrington longitudes |
| Solar probabilities | `/json/solar_probabilities.json` | Array of objects | `date` (ISO), `c_class_1_day`, `m_class_1_day`, `x_class_1_day`, `10mev_protons_1_day`, etc. (int %) for days 1–3, `polar_cap_absorption` |
| Proton flux | `/json/goes/primary/integral-protons-plot-3-day.json` | Array of objects | `time_tag` (ISO Z), `satellite`, `flux` (float, pfu), `energy` (`">=10 MeV"`, `">=50 MeV"`, `">=100 MeV"`, `">=500 MeV"`) |
| Alerts | `/products/alerts.json` | Array of objects | `product_id` (e.g. `K04W`, `A50F`, `XX0S`), `issue_datetime`, `message` (raw text with CRLF, includes machine-readable structured fields) |
| Forecast discussion | `/text/discussion.txt` | Plain text, not JSON — `:directive` lines, `#comment` lines, unprefixed topic headings, `.header`-delimited blocks | `:Issued:` (`YYYY Mon DD HHMM UTC`), topic headings (`Solar Activity`, `Energetic Particle`, `Solar Wind`, `Geospace`), `.24 hr Summary...` and `.Forecast...` blocks per section |

### Alert Product Parsing

The message code's prefix gives the product type — `WAR*` Warning, `WAT*` Watch, `ALT*` Alert, `SUM*` Summary. Everything else is read from the message body; the rest of the code is not a severity.

- **Level and phenomenon come from the scale the body states** — either a `NOAA Scale: G1 - Minor` line or a Watch headline's `Category G2`. The letter gives the phenomenon (`G` Geomagnetic, `R` Radio Blackout, `S` Solar Radiation); the digit gives the level.
- **A code's numeric suffix is not a severity.** It encodes flux thresholds (`EF3`), radio-burst types (`TP2`, `TP4`), wavelengths (`10R`), and predicted A-index (`A20`, `A30`, `A50`). Reading it as a level reports `SUM10R` as level 10 and `WATA30` as level 30.
- **Products stating no scale resolve to level 0**, meaning "no NOAA scale" — not a severity of zero. K-index codes convert through `kpToGScale()` (K4 sits below the G-scale, so `WARK04`/`ALTK04` → 0); `ALTEF3`, `ALTTP2`, `ALTTP4`, `SUM10R`, and `WARSUD` sit outside the scales entirely.
- **The code is a phenomenon fallback only**, keyed on its core: `A`/`G`/`K` + digit → Geomagnetic (the `A` family is a predicted-A-index storm watch, not an aurora bulletin); `SUD` → Geomagnetic (Sudden Impulse — its leading `S` is not the solar-radiation scale letter); `X`/`R` → Radio Blackout; `PX`/`S` → Solar Radiation.
- **The scale label is matched case-insensitively and without a line anchor.** SWPC emits both `NOAA Scale:` and `Noaa Scale:`, and sometimes glues correction prose straight onto the label with no line break (`...valid until 12/2100 UTC.NOAA Scale: G1 - Minor`).

### NOAA Scale Reference

SWPC reports Kp in thirds and starts each G level at that level's "minus" value, so the band floors are thirds rather than whole numbers. Aurora latitudes are geomagnetic.

| Scale | Index | Descriptor | Kp range | Aurora latitude |
|:------|:------|:-----------|:---------|:----------------|
| G0 | 0 | None | < 4.67 | — |
| G1 | 1 | Minor | 4.67 – 5.33 | ≤ 60° |
| G2 | 2 | Moderate | 5.67 – 6.33 | ≤ 55° |
| G3 | 3 | Strong | 6.67 – 7.33 | ≤ 50° |
| G4 | 4 | Severe | 7.67 – 8.67 | ≤ 45° |
| G5 | 5 | Extreme | 9.00 | ≤ 40° |
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
| GOES X-ray flares | As events resolve (published at onset, ~29 records per rolling week) |
| Solar regions | Daily |
| Solar probabilities | Daily |
| F10.7 cm radio flux | 3 reports per UTC day (17:00, 20:00, 22:00) |

### Normalization Notes

**NOAA scales key semantics:** Key `"0"` = today's observation, keys `"1"`–`"3"` = SWPC's 3-day forecast, `"-1"` = the previous UTC day, in key `"0"`'s shape (levels populated, probabilities null), reported by `get_conditions` as `yesterday`. Its `DateStamp` is fixed one UTC day back while its `TimeStamp` moves in lockstep with key `"0"`'s — it is the feed's generation clock, shared by every period — so `yesterday` carries a date and no time, and its levels are read from `Scale`/`Text` only. Its zero R/S/G for a quiet day matched the observed Kp history, GOES X-ray flares, and integral proton flux for the same UTC day. `yesterday` is nullable because the key set is not guaranteed; a `"-1"` period missing a level also reads as null rather than failing the call, since the period is supplementary — unlike today's, where a missing level is `feed_moved`. The forecast is not "the next 3 days": it covers today plus the next two, so key `"1"` carries the same `DateStamp` as key `"0"` and `forecast[0]` is today — which is why `summary` says "today" rather than naming that date as a future day, and why the `forecast` field description states where the series starts. Each entry has both `DateStamp` (date string) and `TimeStamp` (HH:MM:SS UTC); the service joins them into one explicit ISO 8601 UTC `observedAt` per period, and a date alone does not identify a period, so do not deduplicate or look up by it.

**X-ray flares:** the feed is one record per discrete flare event, published at onset — `time_tag` equals `begin_time` on every record — so `end_time` / `end_class` are nullable because a flare still in progress has not decayed yet. Every class comes across with its magnitude already stated and is mapped verbatim; the service sorts oldest-first by onset so ordering is an invariant of the domain type rather than an accident of the feed, and the tool filters the `flare_hours` window on epoch millis (the cutoff carries milliseconds and the feed's onset times do not). `rScale` is the only derived field, from `max_xrlong` against the NOAA R floors.

**F10.7 cm radio flux:** the feed is newest-first with three reports per UTC day, and only the Noon record carries `ninety_day_mean` / `avg_begin_date` / `rec_count`. The service selects the latest **Noon** record by time rather than index 0 — SWPC's own `/products/summary/10cm-flux.json` reports the Noon value as the day's figure. `time_tag` is T-separated without a `Z`, so it routes through `normalizeSwpcTime` like the Kp feeds; `frequency` is 2800 on every record and is not mapped. `ninety_day_mean` parses through `parseNum`, so an absent or unparseable mean stays null rather than reading as zero.

**RTSW solar wind:** `rtsw_wind_1m.json` and `rtsw_mag_1m.json` are arrays of objects, served newest-first, interleaving every reporting spacecraft. The service keeps only `active: true` records (`overall_quality` is uniformly `0`, so it discriminates nothing), carries each record's `source`, and sorts oldest-first to match the chronological series the tool renders. Values are already numbers. `time_tag` is T-separated without a `Z` — `normalizeSwpcTime` appends one. The tool compares epoch millis rather than ISO strings when windowing: RTSW tags carry no milliseconds and so don't collate against a `toISOString()` cutoff that does. Plasma and mag agree on the active source at every shared timestamp, so the two feeds need no cross-reconciliation.

**OVATION coordinates:** `coordinates` is an array of `[longitude, latitude, aurora_probability%]` triples (integers) on a 1° grid, 360 longitudes (0–359) × 181 latitudes (−90..90). The service normalizes longitude with `lon > 180 ? lon − 360 : lon`, so the tool sees −179..180 — a `+180` column and no `−180` one — and compares longitudes through an antimeridian-safe delta. A coordinate lookup reads three things from the grid and the forecast time:

- **Overhead:** the nearest grid point's probability.
- **Darkness:** the geometric solar elevation at the requested coordinates at `Forecast Time` (NOAA GML solar-position algorithm, no refraction, rounded to 0.1°), classified `day` ≥ 0°, `civil_twilight` [−6°, 0°), `nautical_twilight` [−12°, −6°), `dark` < −12°. The classification reads the rounded value, so `sunElevationDeg` and `darkness` agree at a boundary.
- **Horizon:** the highest probability among cells strictly poleward of the nearest grid latitude (toward the pole the requested latitude's sign points at), within ±2° longitude and 1000 km great-circle distance of the requested point; a tie goes to the nearer cell. With the nearest grid latitude at ±90 no cell is poleward, and the three horizon fields are null.

The verdict is built in that order. `day` returns "Not visible — daylight at the forecast time" and stops, offering no probability, overhead or horizon. Otherwise the overhead ladder runs unchanged, a horizon clause follows when the horizon reading is at least 10% and higher than the overhead one, and civil or nautical twilight closes with a note that only bright aurora will show.

**Scale values can be `null`** in `noaa-scales.json`, and a null is never normalized to `0`. SWPC forecasts a *probability* rather than a *level* for future-day radio blackouts and radiation storms, so every forecast period carries `R.Scale: null` / `S.Scale: null` (with `Text` null too) alongside a populated `MinorProb`/`MajorProb` (R) or `Prob` (S). Resolving that null to `0` asserts an "R0/S0, no storm" level SWPC never issued *and* drops the probability it did issue, which is the defect #23 fixed. Levels and probabilities both parse through `parseNum`, so an absent or unparseable value stays null; `G` is unaffected, since it does carry a real forecast `Scale`. The distinction is read from upstream, never inferred from a period's position in the response.

That holds for the level-carrying surfaces too — today's R/S/G and each forecast day's `G`, whose output schema declares `scale` as a plain number. SWPC populates a real `Scale` on all of them, so `get_conditions` treats a null there as the shape break it is (`feed_moved`, naming the period and category) rather than resolving it to 0. Resolving it would restate the same "no storm" claim the forecast R/S fix removed, on a surface with no probability to fall back to.

**Forecast-discussion sections:** the product marks structure with line prefixes — `:directive`, `#comment`, `.header` — and leaves topic headings unprefixed, which makes them indistinguishable from body prose by shape alone. Sections are therefore located from their `.24 hr Summary...` headers: the last non-blank line above one is that section's heading, and the section runs to the next heading. A block's text runs from its header to the next `.`-prefixed line, keeping interior blank lines, because a summary can span several paragraphs (Solar Activity's routinely does) and splitting on a blank line truncates it. A section with no `.Forecast...` block resolves to `forecast: null` rather than an empty string. `:Issued:` is the issue time — HTTP `Last-Modified` tracks the file, not the issuance, and the two routinely differ by hours. A body carrying no section at all is a shape break (`feed_moved`), and the issue line does not redeem it: every SWPC text product opens with that directive, so a body with `:Issued:` and no section is as likely to be a different product served on this path as an empty discussion. The reverse — real sections with no issue line — parses, with `issued: null`.

**Alerts message text:** Raw CRLF-separated text. The service parses out the structured fields (product code, serial number, issue time, validity window, warning conditions) via regex on the structured lines, and preserves the full message for downstream use. `serialNumber` is line-anchored on the record's own `Serial Number:` field — a cancellation, extension, or continuation also carries a `<prefix> Serial Number:` line naming a *different* record — and is exposed on the output because serials are what make those chains navigable. It is a per-message-code counter, not a global identifier: it repeats across codes and within one code on a corrected reissue, so it is only meaningful alongside `messageCode`.

**Validity windows:** Labeled differently per product type — `Valid From`/`Valid To` (Warnings), `Now Valid Until` (extended Warnings), and `Begin Time`/`End Time` (Alerts/Summaries) — and normalized to ISO 8601 UTC. No `WAT*` product carries a label at all: a Watch states its coverage as a `Highest Storm Level Predicted by Day:` list, so its `validTo` is derived from the end of the last listed UTC day whose level is not `None`. A trailing `None` day forecasts quiet rather than extending coverage, so taking the last *listed* day would over-extend by 24 h on most live Watches. The list omits the year; it comes from the record's issue time, rolled forward for a January day listed by a December Watch. A cancellation's `Cancelled Level Predicted:` list uses a different header and different spacing (`Sep 08  :`) and must never parse as a validity end. Products with neither a label nor a storm day keep `null`, which the in-force filter reads as "nothing says this has finished" rather than "expired".

**Alert cancellations:** SWPC cancels a product by issuing a new record under the same message code with a `CANCEL WARNING:`/`CANCEL WATCH:`/`CANCEL ALERT:` headline. A cancellation keeps the cancelled product's own type and carries no validity window, so neither the product-type nor the elapsed-`validTo` check excludes it — the service flags it as `cancelled` and `get_alerts` drops it from `active_only=true`. Detection is per record, never cached per code: a single code cycles CONTINUED → CANCEL → CONTINUED within minutes. `EXTENDED WARNING:` and `CONTINUED` headlines mean the product is still in force and are deliberately not cancellations. The explanation line varies (`Conditions no longer justify...`, `Should have only been valid until...`, `Incorrect maximum value...`), so the headline is the only reliable marker.

Flagging the cancellation is only half the job: the product it cancels is a separate record that carries `cancelled: false` and often a `validTo` still in the future, so it would otherwise stay in the active set. The service parses the cancellation's `Cancel Serial Number:` into `cancelsSerialNumber` and its `Original Issue Time:` into `cancelsOriginalIssueDatetime`, and `get_alerts` resolves each cancellation to exactly one target: same `messageCode`, matching `serialNumber`, issued earlier, with the original issue time picking between reissues that share a serial. One target per cancellation is what keeps a cancellation from clearing its whole message code, and the `Extension to`/`Continuation of` links never populate the cancel field.

**Watch supersession:** Every in-force Watch body carries `THIS SUPERSEDES ANY/ALL PRIOR WATCHES IN EFFECT`. `get_alerts` keeps only the newest record carrying that line and drops the rest under `active_only=true`. The rule keys on the line, not on the product code: the text says any and all, and the live Watches are sequential revisions of one three-day forecast issued under whichever `WATA*` code matches the level they predict, so per-code scoping returns two conflicting outlooks for the same day. A cancellation does not carry the line and is not a superseding record — it removes its target through the serial link instead.

**Filter disclosure:** `active_only=true` can remove dozens of records, so the result would otherwise read as "quiet" when it means "everything was filtered". The tool echoes the applied window (`appliedWindowHours`, `appliedCutoff`) and per-reason exclusion counts (`exclusions`) as enrichment fields, which reach `structuredContent` and the `content[]` trailer without a `format()` entry. Reasons overlap, so each excluded record is attributed to the first that fires — aged out, product type, cancellation record, cancelled by serial, superseded, elapsed validity — and the counts plus `totalCount` equal the number of records the feed carried. That order puts the reasons naming a replacement ahead of the generic elapsed-validity one on purpose: a superseded Watch has normally outlived its own forecast days too, so the reverse order would report the whole Watch chain as merely stale and never say a newer forecast replaced it. Under `active_only=false` nothing is filtered by reason, so neither the echo nor the counts are emitted.
