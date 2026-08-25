# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.12](changelog/0.1.x/0.1.12.md) — 2026-08-25

adopts mcp-ts-core 0.12.3 and the MCP SDK v2 stack, adding modern 2026-07-28 and legacy protocol support, strict tool-input validation, and consistent stateless HTTP serving

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-07-16

get_alerts level and phenomenon now derive from the NOAA scale the message body states instead of the code suffix, correcting severity and phenomenon for most live product codes; a new cancelled field flags cancellation notices, which active_only now excludes, and noaaScale exposes the raw scale

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-07-15

get_solar_wind ports from the removed DSCOVR feeds to SWPC's RTSW feeds, adding a per-record spacecraft source and feed-freshness reporting for empty windows; mcp-ts-core ^0.10.10 → ^0.10.14 with new supply-chain install guards

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-06-30 · 🛡️ Security

get_solar_activity gains date-neutral flare-probability aliases alongside the *1Day fields; get_kp_index and get_solar_activity window filters switch to epoch comparison; SWPC User-Agent tracks the package version; mcp-ts-core ^0.10.10 clears the moderate js-yaml advisory (GHSA-h67p-54hq-rp68)

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-06-30

get_alerts active_only now drops warnings whose validTo has elapsed and gains a messageCode field carrying the full SWPC code; get_kp_index timeTag values normalized to explicit UTC (Z)

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-06-22

get_alerts validity window populated from all SWPC label variants as ISO 8601; get_solar_activity proton flux rounded to 3 significant figures

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-06-20

Maintenance: mcp-ts-core ^0.10.9 adoption — check-dependency-specifiers + plugin-manifest devcheck guards, fresh-scaffold check fixes, vendored skill re-sync, .codex-plugin longDescription

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-06-12

Maintenance: mcp-ts-core ^0.10.6 adoption, explicit display identity, Docker healthcheck, MCPB bundle cleaner, aurora coordinate-error contract fix

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-08

Three correctness fixes: alert timestamp filtering, Kp forecast forward-only + G-scale parity, aurora sub-auroral verdict

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-06

Five correctness fixes: alert active_only window, conditions quiet-forecast, aurora high-latitude verdict, X-ray flux formatting, forecast None normalization

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-06

Public hosted endpoint — server.json remotes + README hosted instance docs

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-05 · 🛡️ Security

Initial public release — 6 NOAA SWPC space weather tools (conditions, Kp index, aurora forecast, solar wind, solar activity, alerts), output injection hardening, and field-validated data normalization
