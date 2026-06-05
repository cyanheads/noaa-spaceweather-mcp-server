/**
 * @fileoverview Barrel export for all tool definitions.
 * @module mcp-server/tools/definitions/index
 */

import { getAlerts } from './get-alerts.tool.js';
import { getAuroraForecast } from './get-aurora-forecast.tool.js';
import { getConditions } from './get-conditions.tool.js';
import { getKpIndex } from './get-kp-index.tool.js';
import { getSolarActivity } from './get-solar-activity.tool.js';
import { getSolarWind } from './get-solar-wind.tool.js';

export const allToolDefinitions = [
  getConditions,
  getAlerts,
  getKpIndex,
  getSolarWind,
  getSolarActivity,
  getAuroraForecast,
];
