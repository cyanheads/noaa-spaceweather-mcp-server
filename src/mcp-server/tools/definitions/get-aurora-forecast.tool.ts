/**
 * @fileoverview Tool: noaa_spaceweather_get_aurora_forecast — OVATION aurora probability grid.
 * @module mcp-server/tools/definitions/get-aurora-forecast
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

/** Minimum Kp thresholds by geomagnetic latitude band for aurora visibility. */
function minKpForLatitude(geomLat: number): number {
  if (geomLat >= 65) return 0;
  if (geomLat >= 60) return 2;
  if (geomLat >= 55) return 4;
  if (geomLat >= 50) return 5;
  if (geomLat >= 45) return 6;
  if (geomLat >= 40) return 7;
  return 9;
}

/** Find the nearest grid point (1° resolution) and return its aurora probability. */
function lookupGridPoint(
  grid: { longitude: number; latitude: number; auroraPercent: number }[],
  lat: number,
  lon: number,
): { auroraPercent: number; gridLat: number; gridLon: number } | null {
  if (grid.length === 0) return null;
  // Normalize longitude to -180..179
  const normLon = ((((lon + 180) % 360) + 360) % 360) - 180;
  let best: { longitude: number; latitude: number; auroraPercent: number } | null = null;
  let bestDist = Infinity;
  for (const pt of grid) {
    const dLat = pt.latitude - lat;
    const dLon = pt.longitude - normLon;
    const dist = dLat * dLat + dLon * dLon;
    if (dist < bestDist) {
      bestDist = dist;
      best = pt;
    }
  }
  return best
    ? { auroraPercent: best.auroraPercent, gridLat: best.latitude, gridLon: best.longitude }
    : null;
}

export const getAuroraForecast = tool('noaa_spaceweather_get_aurora_forecast', {
  title: 'Get Aurora Forecast',
  description:
    'OVATION model aurora forecast for the next ~30–60 min: global grid of aurora probability ' +
    'percentages by latitude/longitude (1° resolution). With optional coordinates, returns the local ' +
    'aurora probability at the nearest grid point, the minimum Kp needed for aurora at that latitude, ' +
    'and a plain-language go/no-go verdict. Without coordinates, returns only global metadata. ' +
    'Data updates every ~5 minutes. Coordinates are geographic (WGS84), not geomagnetic.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe(
        'Geographic latitude in degrees (−90 to 90). Provide with longitude for a local aurora probability lookup.',
      ),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe(
        'Geographic longitude in degrees (−180 to 180). Provide with latitude for a local aurora probability lookup.',
      ),
  }),
  output: z.object({
    observationTime: z.string().describe('Time of the OVATION model observation, ISO 8601.'),
    forecastTime: z.string().describe('Time the aurora forecast is valid for, ISO 8601.'),
    localLookup: z
      .object({
        requestedLatitude: z
          .number()
          .describe('Geographic latitude supplied in the request (degrees, −90 to 90).'),
        requestedLongitude: z
          .number()
          .describe('Geographic longitude supplied in the request (degrees, −180 to 180).'),
        gridLatitude: z.number().describe('Nearest OVATION grid latitude.'),
        gridLongitude: z.number().describe('Nearest OVATION grid longitude.'),
        auroraPercent: z
          .number()
          .describe('Aurora probability at the nearest grid point (0–100%).'),
        minKpRequired: z
          .number()
          .describe('Minimum Kp threshold for aurora visibility at this latitude.'),
        verdict: z
          .string()
          .describe(
            'Plain-language visibility verdict, e.g. "Good aurora chance (42%) — Kp≥6 needed at this latitude."',
          ),
      })
      .nullable()
      .describe('Local aurora lookup result. Null when no coordinates were provided.'),
    gridPointCount: z.number().describe('Total number of grid points in the OVATION model.'),
    topAuroraPercent: z
      .number()
      .describe('Highest aurora probability anywhere on the globe (0–100).'),
    topAuroraRegion: z
      .string()
      .describe('Approximate region of the highest aurora probability grid point.'),
  }),

  errors: [
    {
      reason: 'feed_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'SWPC endpoint returns non-OK status or times out after retries.',
      retryable: true,
      recovery: 'Retry in 30–60 seconds; SWPC feeds occasionally lag during high-activity events.',
    },
    {
      reason: 'invalid_coordinates',
      code: JsonRpcErrorCode.ValidationError,
      when: 'One coordinate provided without the other.',
      recovery:
        'Provide both latitude and longitude together, or omit both for global metadata only.',
    },
  ],

  async handler(input, ctx) {
    // Validate: if one coordinate is provided, the other must be too
    const hasLat = input.latitude != null;
    const hasLon = input.longitude != null;
    if ((hasLat && !hasLon) || (!hasLat && hasLon)) {
      throw ctx.fail('invalid_coordinates', 'Provide both latitude and longitude, or neither.', {
        ...ctx.recoveryFor('invalid_coordinates'),
      });
    }

    ctx.log.info('Fetching aurora forecast', {
      latitude: input.latitude,
      longitude: input.longitude,
    });
    const svc = getSpaceWeatherService();
    const aurora = await svc.getAuroraForecast(ctx);

    const grid = aurora.grid;

    // Find global maximum
    let topPercent = 0;
    let topPoint: { latitude: number; longitude: number } | null = null;
    for (const pt of grid) {
      if (pt.auroraPercent > topPercent) {
        topPercent = pt.auroraPercent;
        topPoint = pt;
      }
    }
    const topRegion = topPoint
      ? `${topPoint.latitude >= 0 ? `${topPoint.latitude}°N` : `${Math.abs(topPoint.latitude)}°S`}, ${topPoint.longitude >= 0 ? `${topPoint.longitude}°E` : `${Math.abs(topPoint.longitude)}°W`}`
      : 'Unknown';

    // Local lookup
    let localLookup = null;
    if (hasLat && hasLon) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by hasLat && hasLon checks above
      const lat = input.latitude!;
      // biome-ignore lint/style/noNonNullAssertion: guarded by hasLat && hasLon checks above
      const lon = input.longitude!;
      const nearest = lookupGridPoint(grid, lat, lon);
      if (nearest) {
        const minKp = minKpForLatitude(Math.abs(lat));
        const pct = nearest.auroraPercent;
        const kpClause = minKp > 0 ? ` Kp≥${minKp} needed at this latitude.` : '';
        let verdict: string;
        // Guard: when minKp===9 the location is below the minimum aurora latitude (~40° geographic).
        // Even a G5 extreme storm (Kp 9) reaches only ~40° geomagnetic — implying aurora is
        // "possible with Kp≥9" at equatorial latitudes is misleading.
        if (minKp === 9) {
          verdict = `Aurora not visible at this latitude — even G5 extreme storms (Kp 9) do not reach below ~40° geographic latitude. Travel to latitudes above 40° to see aurora.`;
        } else if (pct >= 30) {
          verdict =
            minKp === 0
              ? `Good aurora chance (${pct}%) at this latitude — no Kp minimum required, aurora possible now.`
              : `Good aurora chance (${pct}%) —${kpClause}`;
        } else if (pct >= 5) {
          verdict =
            minKp === 0
              ? `Low aurora chance (${pct}%) at this location — aurora activity is low despite the favorable latitude.`
              : `Low aurora chance (${pct}%) — conditions marginal.${kpClause}`;
        } else if (minKp === 0) {
          verdict = `Very low aurora probability (${pct}%) despite favorable latitude — wait for elevated solar activity and higher Kp.`;
        } else {
          verdict = `Very low aurora probability (${pct}%) at this location. Kp≥${minKp} needed — travel to higher latitudes or wait for elevated Kp.`;
        }

        localLookup = {
          requestedLatitude: lat,
          requestedLongitude: lon,
          gridLatitude: nearest.gridLat,
          gridLongitude: nearest.gridLon,
          auroraPercent: pct,
          minKpRequired: minKp,
          verdict,
        };
      }
    }

    return {
      observationTime: aurora.meta.observationTime,
      forecastTime: aurora.meta.forecastTime,
      localLookup,
      gridPointCount: grid.length,
      topAuroraPercent: topPercent,
      topAuroraRegion: topRegion,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push('## Aurora Forecast (OVATION)');
    lines.push(`**Observation Time:** ${result.observationTime}`);
    lines.push(`**Forecast Valid:** ${result.forecastTime}`);
    lines.push(`**Global Peak:** ${result.topAuroraPercent}% near ${result.topAuroraRegion}`);
    lines.push(`**Grid Points:** ${result.gridPointCount}`);
    if (result.localLookup) {
      const l = result.localLookup;
      lines.push('');
      lines.push('### Local Forecast');
      lines.push(
        `**Location:** ${l.requestedLatitude}°, ${l.requestedLongitude}° → nearest grid (${l.gridLatitude}°, ${l.gridLongitude}°)`,
      );
      lines.push(`**Aurora Probability:** ${l.auroraPercent}%`);
      lines.push(`**Min Kp Required:** ${l.minKpRequired}`);
      lines.push(`**Verdict:** ${l.verdict}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
