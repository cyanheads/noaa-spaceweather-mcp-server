---
name: noaa-spaceweather-guide
description: Judgment for the noaa_spaceweather_* tools — turning SWPC Kp, storm scales, solar wind, flares, and alerts into answers about aurora visibility tonight, coming geomagnetic storms, radio blackouts, and impacts on HF radio, GPS, satellites, and power grids. Use before answering an aurora or space-weather question with these tools; covers UTC-day vs local-night timing, geomagnetic latitude, data lag, and what the feeds cannot answer.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

The server reads NOAA SWPC's live public feeds: storm scales, planetary Kp, the OVATION aurora nowcast, L1 solar wind, GOES X-ray and proton flux, flare events, active regions, the forecast discussion, and alert products. Keyless.

The feeds reach only a short way back and ahead:

| Data | Reaches back | Reaches ahead |
|:-----|:-------------|:--------------|
| Kp observed / forecast, storm-scale forecast | 7 days (Kp) | 3 UTC days, starting today |
| Aurora (OVATION) | now only | 30–90 min, the solar wind's L1-to-Earth travel time (`forecastTime`) |
| Solar wind | ~24 h | none — it is measured upstream of Earth |
| Flare events | 7 days | flare-class probabilities, 3 days |
| Alerts | roughly the last 30 days | Watches list up to 3 UTC days |

A storm older than the feed's reach, or "this week" beyond day 3, is out of reach: say so rather than extrapolating. There is no CME arrival model, no TEC or GPS-error product, and no HF absorption map; the forecast discussion and Watch comments are the only statements of cause and arrival.

Seeing aurora also needs a clear, dark sky. Cloud cover and moonlight are not here; pair with a weather server for clouds and an astronomy server for the moon.

## Identifiers

- **Geomagnetic latitude** comes from `noaa_spaceweather_get_aurora_forecast` called with coordinates (`geomagneticLatitude`, `minKpRequired`). Every "aurora to ~N°" figure on the Kp and conditions tools is geomagnetic, and geographic latitude can differ by up to ~9° either way: Seattle (47.6°N) is 53.0° geomagnetic, London (51.5°N) 53.4°, Yakutsk (62.0°N) 53.4°. Never compare a geographic latitude against those figures; look the place up.
- **Alert serials** link records. A message's `Continuation of Serial Number`, `Cancel Serial Number`, or `Extension to Serial Number` line names another record's `serialNumber` under the same `messageCode`. Records joined by continuation lines are one ongoing event: count and report it once, using the newest record. A serial can repeat: a `CORRECTED` record reuses the serial of the one it replaces, so take the newest by issue time.
- **Flare source.** Flare events carry no region. A ≥M5 flare's `SUMXM5` summary alert states its disk `Location` (for example N08W50); below M5, use the per-region C/M/X counts on `noaa_spaceweather_get_solar_activity`.

## Gates

1. **A UTC day is not the user's night.** Scale forecast dates, Watch day lists, and Kp bins are UTC. Convert each Kp bin to the user's local time before saying "tonight" or naming a date. Example: a G1 that SWPC dates to a UTC day, with its storm-level bins at 00:00–06:00 UTC, lands on the previous evening across North America.
2. **The aurora verdict is a nowcast.** `verdict`, `darkness`, and `auroraPercent` describe `forecastTime`, 30–90 min out. A daytime call returns "Not visible — daylight" even when tonight looks promising. For any later time, use the Kp forecast against the location's `minKpRequired` (gate 3).
3. **Location threshold first, then the Kp bins.** Get `minKpRequired` for the place, then read the `noaa_spaceweather_get_kp_index` forecast bins that fall in local darkness. A bin below the threshold makes overhead aurora unlikely there, whatever the global storm level. The threshold steps in 5° geomagnetic bands, so a place a degree or two short of the next band's edge is a judgment call: when a K-index or Watch product carries a Potential Impacts block, it names how far equatorward aurora may be seen (G1: the northern tier of the U.S.; G2: "as low as New York to Wisconsin to Washington state"), and `horizonMaxPercent` shows aurora low on the poleward horizon. Report both rather than a flat no.
4. **Observed Kp lags.** A Kp `timeTag` is the start of a 3-hour bin, and the observed series ends at the last completed bin, so `currentKp` describes a bin that ended up to ~3 h ago. Forecast rows marked `estimated` cover every bin of the current UTC day, later bins included; `predicted` rows cover the days after. For a storm starting now, the faster signals are an active `ALTK0n` or `WARK0n` product and the solar wind.
5. **Southward Bz needs magnitude and persistence.** Brief southward swings are routine. Example: on one quiet day (Kp never above 2.33), Bz was south for about 45% of the minutes and never below −7 nT. `bzSouthMinutesInWindow` counts scattered minutes, not a continuous run, so judging persistence needs the `mag` series, which `resolution: "summary"` omits. Look for hours of Bz at or below −10 nT with elevated speed before calling a storm likely. SWPC puts the warning a shock seen at L1 gives before it reaches Earth at 15–60 min.
6. **"Was there a blackout?" reads flare events, not alerts.** R1 (M1–M5) blackouts trigger no alert: `ALTXMF` and `SUMXM5` fire only at M5 (R2). Call `noaa_spaceweather_get_solar_activity` with `flare_hours` reaching back past the time asked about; each event's `rScale` is the level its peak flux implies. Radio blackouts affect only the sunlit hemisphere, centred on the sub-solar point, and their extent tracks the X-ray flux as the flare rises and decays. A flare older than 7 days is gone from the feed.
7. **An alert's presence is not current state.** An Alert (`ALT*`) records a threshold crossing. In the default in-force view, one with no end time stays listed until its issue time ages out of the look-back window, even after conditions subside. Confirm persistence with current Kp, solar wind, or proton flux. Level 0 on an alert means "no NOAA scale stated", not "harmless".
8. **Impacts come from SWPC's text.** Most K-index, geomagnetic Watch, and X-ray products carry a "Potential Impacts" block (power grid, spacecraft, HF radio, aurora). Quote it when present rather than writing generic impacts. Not every product has one: `ALTEF3`, `ALTTP2`/`ALTTP4`, `SUM10R`, `WARSUD`, and `SUMSUD` carry none, and G3 K-index products (`ALTK07`/`WARK07`) have been seen without it, while K4 products carry it. Without that text, the NOAA scales map as: G → power grid, satellite drag and orientation, high-latitude HF, satellite navigation at the upper levels, aurora; R → HF radio and low-frequency navigation on the sunlit side; S → polar HF, satellites, and radiation exposure on high-latitude flights.

## Core chain — "Can I see the aurora from X tonight?"

1. Geocode X to coordinates (another server), then call `noaa_spaceweather_get_aurora_forecast` with them for `geomagneticLatitude`, `minKpRequired`, and, if it is dark there now, the live verdict and horizon reading.
2. `noaa_spaceweather_get_kp_index`: keep the forecast bins inside the local dark hours (converted from UTC) and compare each to `minKpRequired`.
3. `noaa_spaceweather_get_alerts`: an in-force `WATA20`/`WATA30` Watch states the predicted G level per UTC day and its cause; its Potential Impacts names how far equatorward aurora may be seen.
4. Clouds and moon from other servers, then answer with the best local window, the Kp it needs, and the Kp forecast for it.

## Workflows

**Is a storm coming, and how strong?** `noaa_spaceweather_get_conditions` gives the G forecast per UTC day; the forecaster's cause (CME or coronal-hole stream) and timing come only with `include_discussion`. The in-force Watch carries the same outlook, and the Kp forecast shows which 3-hour bins carry it. Beyond day 3 the answer is "not forecast yet".

**Did a flare cause a blackout?** Gate 6. For a flare of M5 or above, `noaa_spaceweather_get_alerts` with `active_only=false` and a look-back reaching the flare returns the `ALTXMF` threshold alert and the `SUMXM5` summary with class, times, disk location, and R level. The default in-force view never shows the summary and drops the threshold alert once it ages out of the look-back window.

**What do the solar wind numbers mean?** `noaa_spaceweather_get_solar_wind` for the latest readings and window extremes, with the series when persistence matters (gate 5). Compare with the Kp series: if Bz has been strongly south for hours and Kp has not risen yet, the next bins are the ones to watch.

**Active watches and what they mean for HF, GPS, and grids.** `noaa_spaceweather_get_alerts` in its default in-force view. Count each continuation chain once (Identifiers), decode each code with the table below, then quote each product's Potential Impacts (gate 8).

**Alert codes** seen in the feed:

| Code | Meaning | Scale |
|:-----|:--------|:------|
| `WARK04`–`WARK07` / `ALTK04`–`ALTK07` | K-index of 4–7 expected (warning) / reached (alert) | K5 = G1, K6 = G2, K7 = G3; K4 is below the scale |
| `WATA20` / `WATA30` | Geomagnetic storm watch, G1 / G2 predicted | G, listed by UTC day |
| `WARSUD` / `SUMSUD` | Shock seen upstream (`Ip Shock` time); sudden impulse expected / observed at Earth | no NOAA scale; marks storm onset |
| `ALTXMF` / `SUMXM5` | X-ray flux exceeded M5 / event summary | R2 or higher |
| `ALTTP2` / `ALTTP4` | Type II (with an estimated shock speed) / Type IV solar radio emission | no NOAA scale; whether a CME is Earth-directed is stated only in the forecast discussion or a later Watch |
| `ALTEF3` | ≥2 MeV electron integral flux exceeded 1,000 pfu | no NOAA scale |
| `SUM10R` | 10 cm radio burst | no NOAA scale |
