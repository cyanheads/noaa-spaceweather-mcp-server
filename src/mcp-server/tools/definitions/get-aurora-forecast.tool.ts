/**
 * @fileoverview Tool: noaa_spaceweather_get_aurora_forecast — OVATION aurora probability grid.
 * @module mcp-server/tools/definitions/get-aurora-forecast
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  auroraBandForGeomagneticLatitude,
  getSpaceWeatherService,
} from '@/services/space-weather/space-weather-service.js';

/**
 * North geomagnetic pole for IGRF-14 epoch 2025.0, derived from the model's
 * degree-1 Gauss coefficients (g₁⁰ = −29350.0, g₁¹ = −1410.3, h₁¹ = 4545.5). The
 * pole drifts slowly enough that one epoch is ample for 5°-wide bands.
 */
const GEOMAGNETIC_POLE_LATITUDE = 80.789;
const GEOMAGNETIC_POLE_LONGITUDE = -72.763;

const DEG_TO_RAD = Math.PI / 180;

/**
 * Convert geographic (WGS84) coordinates to centered-dipole geomagnetic latitude.
 *
 * The dipole is tilted 9.21° from the rotation axis, so geographic and geomagnetic
 * latitude differ by up to ±9.2° and the sign of the difference changes with
 * longitude. Aurora bands are geomagnetic, so feeding them a geographic latitude
 * mis-bands a location by as much as two bands in either direction.
 */
function toGeomagneticLatitude(latitude: number, longitude: number): number {
  const lat = latitude * DEG_TO_RAD;
  const poleLat = GEOMAGNETIC_POLE_LATITUDE * DEG_TO_RAD;
  const deltaLon = (longitude - GEOMAGNETIC_POLE_LONGITUDE) * DEG_TO_RAD;
  const sinGeomagnetic =
    Math.sin(lat) * Math.sin(poleLat) + Math.cos(lat) * Math.cos(poleLat) * Math.cos(deltaLon);
  // Clamp against float drift past ±1 at the poles, where asin is undefined.
  return Math.asin(Math.min(1, Math.max(-1, sinGeomagnetic))) / DEG_TO_RAD;
}

/** Signed angular separation between two longitudes, in degrees: [−180, 180). */
function longitudeDelta(a: number, b: number): number {
  return ((((a - b + 180) % 360) + 360) % 360) - 180;
}

/** Find the nearest grid point (1° resolution) and return its aurora probability. */
function lookupGridPoint(
  grid: { longitude: number; latitude: number; auroraPercent: number }[],
  lat: number,
  lon: number,
): { auroraPercent: number; gridLat: number; gridLon: number } | null {
  let best: { longitude: number; latitude: number; auroraPercent: number } | null = null;
  let bestDist = Infinity;
  for (const pt of grid) {
    const dLat = pt.latitude - lat;
    // The normalized grid runs −179..180 — a +180 column and no −180 one — so a
    // request within ~1° of the antimeridian lands a cell off on a raw difference.
    const dLon = longitudeDelta(pt.longitude, lon);
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

/**
 * Aurora probability at which a grid point below the 40° geomagnetic edge is read
 * as real signal rather than model noise. #9 pinned an 8% artifact at (0, 0), and
 * the live oval reads 10–17% where it is genuinely present, so the floor sits above
 * the artifact and at the bottom of the real range.
 */
const OVAL_OVERRIDE_PERCENT = 10;

/** Kp reported where no NOAA storm level reaches — the top of the scale. */
const UNREACHABLE_MIN_KP = 9;

export const getAuroraForecast = tool('noaa_spaceweather_get_aurora_forecast', {
  title: 'Get Aurora Forecast',
  description:
    'OVATION model aurora forecast for the next ~30–60 min: global grid of aurora probability ' +
    'percentages by latitude/longitude (1° resolution). With optional coordinates, returns the local ' +
    'aurora probability at the nearest grid point, the geomagnetic latitude those coordinates convert ' +
    'to, the minimum Kp and G level needed for aurora at that geomagnetic latitude, and a ' +
    'plain-language go/no-go verdict. Without coordinates, returns only global metadata. ' +
    'Data updates every ~5 minutes. Supply coordinates as geographic (WGS84); aurora bands are ' +
    'geomagnetic, and the tool converts between them.',
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
        geomagneticLatitude: z
          .number()
          .describe(
            'Centered-dipole geomagnetic latitude the requested coordinates convert to (degrees, −90 to 90). Aurora bands are geomagnetic, so this — not the geographic latitude — is what minKpRequired and the verdict are derived from. It can differ from the geographic latitude by up to ±9.2° in either direction.',
          ),
        gridLatitude: z.number().describe('Nearest OVATION grid latitude.'),
        gridLongitude: z.number().describe('Nearest OVATION grid longitude.'),
        auroraPercent: z
          .number()
          .describe('Aurora probability at the nearest grid point (0–100%).'),
        minKpRequired: z
          .number()
          .describe(
            'Minimum Kp for aurora at this geomagnetic latitude — the floor of the band, in SWPC thirds (4.67, 5.67, 6.67, 7.67, 9.00), or 0 inside the quiet-time auroral oval above 65°. Reported as 9 where no storm level reaches, which minGScale=null distinguishes from a genuine G5 threshold. The 60° G1 band is this server’s interpolation between the oval edge and NOAA’s G2 figure; the rest are the NOAA scales page figures.',
          ),
        minGScale: z
          .number()
          .nullable()
          .describe(
            'NOAA G level matching minKpRequired (1–5), 0 inside the quiet-time auroral oval where no storm is needed, and null below 40° geomagnetic where no storm level reaches.',
          ),
        verdict: z
          .string()
          .describe(
            'Plain-language visibility verdict at this geomagnetic latitude, e.g. "Good aurora chance (42%) — Kp≥6.67 (G3) needed at 51.2° geomagnetic latitude."',
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
      when: 'SWPC feed returns 5xx or 429, times out, or answers with a body that is not parseable JSON. Retried before failing.',
      retryable: true,
      recovery: 'Retry in 30–60 seconds; SWPC feeds occasionally lag during high-activity events.',
    },
    {
      reason: 'feed_moved',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'SWPC feed path returns a permanent 4xx (404, 410, 401, 403). Fails in one attempt.',
      retryable: false,
      recovery:
        'Retrying will not help — the SWPC feed path no longer resolves or no longer has the expected shape; the feed URL needs updating against SWPC current inventory.',
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
    // A local lookup needs the pair; one coordinate alone has nothing to look up.
    const { latitude: lat, longitude: lon } = input;
    if ((lat == null) !== (lon == null)) {
      throw ctx.fail('invalid_coordinates', 'Provide both latitude and longitude, or neither.', {
        ...ctx.recoveryFor('invalid_coordinates'),
      });
    }

    ctx.log.info('Fetching aurora forecast', { latitude: lat, longitude: lon });
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
    if (lat != null && lon != null) {
      const nearest = lookupGridPoint(grid, lat, lon);
      if (nearest) {
        // Aurora bands are geomagnetic; the caller supplies geographic coordinates.
        const geomLat = toGeomagneticLatitude(lat, lon);
        const geomText = geomLat.toFixed(1);
        const band = auroraBandForGeomagneticLatitude(geomLat);
        const minKp = band?.minKp ?? UNREACHABLE_MIN_KP;
        const pct = nearest.auroraPercent;
        const kpClause =
          band && band.minKp > 0
            ? ` Kp≥${band.minKp} (G${band.gScale}) needed at ${geomText}° geomagnetic.`
            : '';
        let verdict: string;
        // Below the G5 band's 40° edge no storm level reaches, so the ladder's
        // "possible with Kp≥9" framing would mislead (#9) — unless the grid point
        // itself reads high enough to be signal rather than model noise.
        if (!band) {
          verdict =
            pct >= OVAL_OVERRIDE_PERCENT
              ? `Aurora is normally not seen at ${geomText}° geomagnetic latitude, but the nearest grid point reads ${pct}% — an exceptional reading; only G5-class (Kp 9) storms push the oval this far equatorward.`
              : `Aurora not visible at ${geomText}° geomagnetic latitude (${lat}° geographic) — even G5 extreme storms (Kp 9) do not reach below 40° geomagnetic latitude. Travel toward higher geomagnetic latitudes to see aurora.`;
        } else if (pct >= 30) {
          verdict =
            minKp === 0
              ? `Good aurora chance (${pct}%) at ${geomText}° geomagnetic latitude — inside the auroral oval, no Kp minimum required, aurora possible now.`
              : `Good aurora chance (${pct}%) —${kpClause}`;
        } else if (pct >= 5) {
          verdict =
            minKp === 0
              ? `Low aurora chance (${pct}%) at this location — aurora activity is low despite the favorable geomagnetic latitude of ${geomText}°.`
              : `Low aurora chance (${pct}%) — conditions marginal.${kpClause}`;
        } else if (minKp === 0) {
          verdict = `Very low aurora probability (${pct}%) despite a favorable geomagnetic latitude of ${geomText}° — wait for elevated solar activity and higher Kp.`;
        } else {
          verdict = `Very low aurora probability (${pct}%) at this location.${kpClause} Travel toward higher geomagnetic latitudes or wait for elevated Kp.`;
        }

        localLookup = {
          requestedLatitude: lat,
          requestedLongitude: lon,
          geomagneticLatitude: Number(geomLat.toFixed(2)),
          gridLatitude: nearest.gridLat,
          gridLongitude: nearest.gridLon,
          auroraPercent: pct,
          minKpRequired: minKp,
          minGScale: band?.gScale ?? null,
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
      lines.push(`**Geomagnetic Latitude:** ${l.geomagneticLatitude}°`);
      lines.push(`**Aurora Probability:** ${l.auroraPercent}%`);
      lines.push(
        `**Min Kp Required:** ${l.minKpRequired} (${l.minGScale === null ? 'not reachable by any storm level' : `G${l.minGScale}`})`,
      );
      lines.push(`**Verdict:** ${l.verdict}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
