---
name: noaa-spaceweather-mcp-server
description: "Space weather via NOAA SWPC — geomagnetic storms, planetary K-index, aurora forecast, solar wind, flares, and active alerts."
version: 0.0.0
status: idea
category: external-data
hosted: false
subdomain: ""
port: 0
tools: 0
resources: 0
prompts: 0
rating: unrated
stars: 0
open_issues: 0
auth: none
framework: mcp-ts-core
core_version: ""
npm: "@cyanheads/noaa-spaceweather-mcp-server"
created: 2026-05-30
error_handling: unaudited
response_enrichment: unaudited
needs_migration: false
pattern: deep single-source
complexity: low-medium
api-deps: NOAA SWPC (Space Weather Prediction Center) JSON + product feeds
api-cost: free (no key; public services.swpc.noaa.gov feeds)
hostable: true
composes-with: nws-weather-mcp-server, opensky-mcp-server, earthquake-mcp-server
---

# noaa-spaceweather-mcp-server

Space weather from NOAA's Space Weather Prediction Center (SWPC) — geomagnetic storm conditions, planetary K-index, OVATION aurora forecast, real-time solar wind, solar flares, and active alerts/watches/warnings. Keyless public feeds.

Part of the **NOAA cluster** (see Design Notes) — a deliberately separate server from `nws-weather` (terrestrial forecast), the planned `noaa-climate` (historical climate), and `noaa-marine` (tides/currents/buoys). Space weather has its own audience and vocabulary: solar/geomagnetic activity, not atmospheric weather. Folding it into a weather server would mix "tomorrow's rain" with "tonight's aurora and the radio-blackout risk for HF operators."

**Audience:** Aurora chasers, satellite/GPS and HF-radio operators, power-grid and aviation (polar-route) planners, space-weather hobbyists, agents answering "can I see the aurora tonight?" or "is there a geomagnetic storm right now?"

## User Goals

- Check current overall space-weather conditions (the NOAA R/S/G storm scales)
- See the planetary K-index — recent values and the short-term forecast
- Get the aurora forecast: where it's visible now / in the next hour, by location
- Read real-time solar wind (speed, density, magnetic field) driving geomagnetic activity
- Track solar activity — flares (X-ray flux/class), radiation storms, sunspot/F10.7
- See active SWPC alerts, watches, and warnings

## API Surface

SWPC publishes keyless JSON at `services.swpc.noaa.gov`. Feeds are heterogeneous — some are arrays of objects, some are header-row "arrays of arrays," some are coordinate grids — so the service layer must normalize each into clean per-record shapes.

| Feed | Path | Shape |
|:-----|:-----|:------|
| Storm scales (R/S/G) | `/products/noaa-scales/...` | current + forecast scale levels |
| Planetary K-index | `/products/noaa-planetary-k-index.json` | array-of-arrays, time-tagged Kp |
| Aurora forecast (OVATION) | `/json/ovation_aurora_latest.json` | lat/lon/probability grid + viewline |
| Solar wind (DSCOVR/ACE) | `/products/solar-wind/{plasma,mag}-1-day.json` | header-row arrays: speed, density, Bz |
| Solar X-ray flux (GOES) | `/json/goes/primary/xrays-1-day.json` | array of objects; flare class |
| Alerts/watches/warnings | `/products/alerts.json` | array of message objects |

## Tool Surface (sketch)

Prefix `noaa_spaceweather_*` (NOAA cluster namespace — see Design Notes).

```
noaa_spaceweather_get_conditions — current overall snapshot: NOAA R/S/G scales (radio
    blackout / solar radiation / geomagnetic storm), latest planetary K-index, a
    plain-language summary, and the 3-day R/S/G scale forecast so callers get both
    "right now" and "what's coming". The "is anything happening right now?" heartbeat.

noaa_spaceweather_get_kp_index — planetary K-index (0–9 geomagnetic activity): recent
    observed values plus the short-term forecast. Kp is the primary driver of aurora
    visibility latitude — surface that link in the description.

noaa_spaceweather_get_aurora_forecast — OVATION aurora model: where the aurora is
    visible now and in the next ~30–60 min. Optional coordinates → local visibility
    probability and whether the viewline reaches that latitude. The consumer favorite.

noaa_spaceweather_get_solar_wind — real-time solar wind from DSCOVR/ACE: speed, density,
    temperature, and the all-important Bz (southward IMF drives storms). Recent series.

noaa_spaceweather_get_solar_activity — solar flares (GOES X-ray flux + recent flare
    events, class M/X), proton/radiation-storm levels, sunspot number, F10.7 flux,
    active solar regions (position, area, magnetic classification), and per-region
    flare/CME probability from solar_probabilities.json. Gives operators the full
    picture: not just "there was an X2 flare" but "from which active region, and
    what's the probability of another?"

noaa_spaceweather_get_alerts — active SWPC alerts, watches, and warnings (e.g. G3 storm
    warning, R2 radio blackout), parsed into {type, level, issued, valid, message}.
```

## Design Notes

- **NOAA cluster, not a NOAA mega-server.** The fleet splits NOAA by *workflow*, not org chart: `nws-weather` (real-time forecast/alerts), `noaa-climate` (historical climate — the planned rename of `noaa-cdo`), `noaa-marine` (tides/currents/buoys), and this `noaa-spaceweather` (solar/geomagnetic). Tools namespace under `noaa_` with a domain segment — prefix `noaa_spaceweather_*`. "NOAA" is a README cluster tag, not one server.
- Low-medium complexity — keyless, but the feeds are inconsistent (objects vs. header-row arrays vs. coordinate grids). The real work is a normalization layer that turns each into clean records, plus translating raw indices into meaning (Kp 7 = "G3 storm, aurora to ~mid-latitudes").
- **Interpretation is the value.** Raw Kp/Bz/flux numbers are opaque. Tools should attach the NOAA scale and a plain-language read ("Kp 6 — G2 moderate storm; aurora possible to ~45° geomagnetic latitude"), not just the number.
- Feeds update at different cadences (solar wind ~1 min, Kp ~3 h, OVATION ~5 min). Surface each value's timestamp so the agent knows freshness.
- No auth, no key, no token — fully hostable. Polite identifying User-Agent in the service layer.
- Composes with `nws-weather` (aurora-viewing also needs cloud cover — a clear-sky check), `opensky` (polar-route radiation/HF-blackout context for aviation), `earthquake` (shared "natural-hazard monitoring" framing). Aurora + a clear-sky forecast is the standout cross-server workflow.
- Moonshot: a "can I see the aurora from here tonight?" workflow that takes a place, pulls OVATION + Kp forecast + (via nws-weather) cloud cover + sun/moon conditions, and returns a single go/no-go with timing.
- README one-liner: "Geomagnetic storms, aurora forecasts, and solar activity from NOAA's Space Weather Prediction Center."
