#!/usr/bin/env node
/**
 * @fileoverview noaa-spaceweather-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initSpaceWeatherService } from './services/space-weather/space-weather-service.js';

await createApp({
  tools: allToolDefinitions,
  resources: [],
  prompts: [],
  instructions:
    'NOAA Space Weather Prediction Center data server — all feeds are public and keyless.\n' +
    '- Start with noaa_spaceweather_get_conditions for a quick status snapshot.\n' +
    '- Use noaa_spaceweather_get_aurora_forecast with coordinates for "can I see the aurora?" queries.\n' +
    '- Use noaa_spaceweather_get_solar_wind for Bz monitoring (southward Bz drives storms).\n' +
    '- Use noaa_spaceweather_get_alerts for active SWPC watches/warnings.\n' +
    'Feeds update frequently (solar wind ~1 min, aurora ~5 min, Kp 3-hour intervals).',
  setup(core) {
    initSpaceWeatherService(core.config, core.storage);
  },
});
