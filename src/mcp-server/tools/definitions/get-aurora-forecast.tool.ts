/**
 * @fileoverview Tool: noaa_spaceweather_get_aurora_forecast — OVATION aurora probability grid.
 * @module mcp-server/tools/definitions/get-aurora-forecast
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  DARKNESS_STATES,
  type Darkness,
  darknessFor,
  solarElevationDeg,
} from '@/services/space-weather/solar-position.js';
import {
  type AuroraBand,
  auroraBandForGeomagneticLatitude,
  getSpaceWeatherService,
} from '@/services/space-weather/space-weather-service.js';
import type { AuroraGridPoint } from '@/services/space-weather/types.js';

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

/**
 * How far away bright aurora can still be seen low on the horizon. SWPC's 30-minute
 * forecast page: aurora "can be observed from as much as a 1000 km away when the
 * aurora is bright".
 */
const HORIZON_RADIUS_KM = 1000;

/** Longitude half-width of the poleward scan — the cells roughly due north or south. */
const HORIZON_LONGITUDE_WINDOW_DEG = 2;

/**
 * Horizon reading at which the verdict mentions it. The 1000 km figure applies to
 * bright aurora, so the clause keeps the floor this tool already treats as real oval
 * signal rather than model noise — the same value, for the same reason, as
 * {@link OVAL_OVERRIDE_PERCENT}, not the ladder's 5% "Low chance" boundary.
 */
const HORIZON_CLAUSE_MIN_PERCENT = OVAL_OVERRIDE_PERCENT;

const EARTH_MEAN_RADIUS_KM = 6371;

/** Great-circle (haversine) distance between two geographic points, in km. */
function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MEAN_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The strongest aurora reading in the poleward scan window. */
interface HorizonReading {
  distanceKm: number;
  latitude: number;
  percent: number;
}

/**
 * Scan the cells strictly poleward of `gridLat` — toward the pole nearer the
 * requested latitude — within ±2° of the requested longitude and 1000 km of the
 * requested point, and return the highest reading. A tie goes to the nearer cell.
 * Null when no cell lies in the window, which on the full grid means `gridLat` is a
 * pole.
 */
function scanPoleward(
  grid: readonly AuroraGridPoint[],
  lat: number,
  lon: number,
  gridLat: number,
): HorizonReading | null {
  const northward = lat >= 0;
  let best: AuroraGridPoint | null = null;
  let bestKm = Infinity;
  for (const pt of grid) {
    const poleward = northward ? pt.latitude > gridLat : pt.latitude < gridLat;
    if (!poleward) continue;
    if (Math.abs(longitudeDelta(pt.longitude, lon)) > HORIZON_LONGITUDE_WINDOW_DEG) continue;
    const km = greatCircleKm(lat, lon, pt.latitude, pt.longitude);
    if (km > HORIZON_RADIUS_KM) continue;
    const stronger = !best || pt.auroraPercent > best.auroraPercent;
    const nearerTie = best?.auroraPercent === pt.auroraPercent && km < bestKm;
    if (stronger || nearerTie) {
      best = pt;
      bestKm = km;
    }
  }
  return best
    ? { percent: best.auroraPercent, latitude: best.latitude, distanceKm: Math.round(bestKm) }
    : null;
}

/**
 * The verdict on the overhead reading alone: the probability ladder, keyed on the
 * nearest cell's probability and the geomagnetic band.
 */
function overheadVerdict(
  pct: number,
  band: AuroraBand | null,
  geomLat: number,
  lat: number,
): string {
  const geomText = geomLat.toFixed(1);
  const minKp = band?.minKp ?? UNREACHABLE_MIN_KP;
  const kpClause =
    band && band.minKp > 0
      ? ` Kp≥${band.minKp} (G${band.gScale}) needed at ${geomText}° geomagnetic.`
      : '';
  // Below the G5 band's 40° edge no storm level reaches, so the ladder's
  // "possible with Kp≥9" framing would mislead (#9) — unless the grid point
  // itself reads high enough to be signal rather than model noise.
  if (!band) {
    return pct >= OVAL_OVERRIDE_PERCENT
      ? `Aurora is normally not seen at ${geomText}° geomagnetic latitude, but the nearest grid point reads ${pct}% — an exceptional reading; only G5-class (Kp 9) storms push the oval this far equatorward.`
      : `Aurora not visible at ${geomText}° geomagnetic latitude (${lat}° geographic) — even G5 extreme storms (Kp 9) do not reach below 40° geomagnetic latitude. Travel toward higher geomagnetic latitudes to see aurora.`;
  }
  if (pct >= 30) {
    return minKp === 0
      ? `Good aurora chance (${pct}%) at ${geomText}° geomagnetic latitude — inside the auroral oval, no Kp minimum required, aurora possible now.`
      : `Good aurora chance (${pct}%) —${kpClause}`;
  }
  if (pct >= 5) {
    return minKp === 0
      ? `Low aurora chance (${pct}%) at this location — aurora activity is low despite the favorable geomagnetic latitude of ${geomText}°.`
      : `Low aurora chance (${pct}%) — conditions marginal.${kpClause}`;
  }
  if (minKp === 0) {
    return `Very low aurora probability (${pct}%) despite a favorable geomagnetic latitude of ${geomText}° — wait for elevated solar activity and higher Kp.`;
  }
  return `Very low aurora probability (${pct}%) at this location.${kpClause} Travel toward higher geomagnetic latitudes or wait for elevated Kp.`;
}

/**
 * The full verdict. Darkness at the requested coordinates is checked first: in
 * daylight aurora cannot be seen, so the verdict says so and no probability — overhead
 * or on the horizon — is offered. Otherwise the overhead verdict leads, a horizon
 * clause follows when the poleward reading is real signal and beats the overhead one,
 * and twilight closes with a brightness caveat.
 */
function buildVerdict(opts: {
  band: AuroraBand | null;
  darkness: Darkness;
  geomLat: number;
  horizon: HorizonReading | null;
  lat: number;
  pct: number;
  sunElevation: number;
}): string {
  const { band, darkness, geomLat, horizon, lat, pct, sunElevation } = opts;
  if (darkness === 'day') {
    return `Not visible — daylight at the forecast time (sun ${sunElevation}° above the horizon); aurora cannot be seen while the sun is up.`;
  }
  const clauses = [overheadVerdict(pct, band, geomLat, lat)];
  if (horizon && horizon.percent >= HORIZON_CLAUSE_MIN_PERCENT && horizon.percent > pct) {
    const direction = lat >= 0 ? 'north' : 'south';
    clauses.push(
      `${pct}% overhead; ${horizon.percent}% about ${horizon.distanceKm} km ${direction} — aurora may be visible low on the ${direction}ern horizon.`,
    );
  }
  if (darkness !== 'dark') {
    const phase = darkness === 'civil_twilight' ? 'Civil' : 'Nautical';
    clauses.push(
      `${phase} twilight at the forecast time (sun ${Math.abs(sunElevation)}° below the horizon) — only bright aurora will show.`,
    );
  }
  return clauses.join(' ');
}

export const getAuroraForecast = tool('noaa_spaceweather_get_aurora_forecast', {
  title: 'Get Aurora Forecast',
  description:
    'OVATION model aurora forecast for the next ~30–60 min: global grid of aurora probability ' +
    'percentages by latitude/longitude (1° resolution). With optional coordinates, returns the local ' +
    'aurora probability at the nearest grid point, the geomagnetic latitude those coordinates convert ' +
    'to, the minimum Kp and G level needed for aurora at that geomagnetic latitude, the sun’s ' +
    'elevation there at the forecast time (aurora is not visible in daylight), the strongest aurora ' +
    'within 1000 km poleward (visible low on the horizon when bright), and a plain-language ' +
    'go/no-go verdict. Without coordinates, returns only global metadata. ' +
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
        sunElevationDeg: z
          .number()
          .describe(
            'Geometric solar elevation at the requested coordinates at forecastTime, in degrees (−90 to 90, rounded to 0.1°, no refraction correction). Negative when the sun is below the horizon.',
          ),
        darkness: z
          .enum(DARKNESS_STATES)
          .describe(
            'Sky darkness at the requested coordinates at forecastTime, from sunElevationDeg: day at 0° and above, civil_twilight from −6° up to 0°, nautical_twilight from −12° up to −6°, dark below −12°.',
          ),
        horizonMaxPercent: z
          .number()
          .nullable()
          .describe(
            'Highest aurora probability (0–100%) among grid cells poleward of gridLatitude, within ±2° longitude and 1000 km of the requested point. Null when no grid cell lies in that window, which on the full grid happens only when gridLatitude is ±90.',
          ),
        horizonMaxLatitude: z
          .number()
          .nullable()
          .describe(
            'Grid latitude of the cell carrying horizonMaxPercent (degrees); the nearest such cell when several tie. Null when horizonMaxPercent is null.',
          ),
        horizonDistanceKm: z
          .number()
          .nullable()
          .describe(
            'Great-circle distance from the requested point to the cell carrying horizonMaxPercent, in km. Null when horizonMaxPercent is null.',
          ),
        verdict: z
          .string()
          .describe(
            'Plain-language visibility verdict for the requested coordinates at forecastTime, e.g. "Good aurora chance (42%) — Kp≥6.67 (G3) needed at 51.2° geomagnetic." Opens "Not visible — daylight" when darkness is day.',
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
      thrownBy: 'service',
      recovery: 'Retry in 30–60 seconds; SWPC feeds occasionally lag during high-activity events.',
    },
    {
      reason: 'feed_moved',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'SWPC feed path returns a permanent 4xx (404, 410, 401, 403), or a coordinate lookup finds no parseable Forecast Time in the feed. Fails in one attempt.',
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
      // Whether the sun is up at the requested point is judged at the forecast time,
      // so a feed without one leaves nothing to judge the verdict against.
      const forecastAt = new Date(aurora.meta.forecastTime);
      if (Number.isNaN(forecastAt.getTime())) {
        throw ctx.fail(
          'feed_moved',
          'OVATION feed carried no parseable Forecast Time; the daylight check at the requested coordinates needs it.',
          { forecastTime: aurora.meta.forecastTime, ...ctx.recoveryFor('feed_moved') },
        );
      }

      const nearest = lookupGridPoint(grid, lat, lon);
      if (nearest) {
        // Aurora bands are geomagnetic; the caller supplies geographic coordinates.
        const geomLat = toGeomagneticLatitude(lat, lon);
        const band = auroraBandForGeomagneticLatitude(geomLat);
        const pct = nearest.auroraPercent;
        // Darkness is classified from the reported 0.1° value so the two fields agree
        // at a boundary; `|| 0` folds a rounded −0 into 0.
        const sunElevation = Math.round(solarElevationDeg(forecastAt, lat, lon) * 10) / 10 || 0;
        const darkness = darknessFor(sunElevation);
        const horizon = scanPoleward(grid, lat, lon, nearest.gridLat);

        localLookup = {
          requestedLatitude: lat,
          requestedLongitude: lon,
          geomagneticLatitude: Number(geomLat.toFixed(2)),
          gridLatitude: nearest.gridLat,
          gridLongitude: nearest.gridLon,
          auroraPercent: pct,
          minKpRequired: band?.minKp ?? UNREACHABLE_MIN_KP,
          minGScale: band?.gScale ?? null,
          sunElevationDeg: sunElevation,
          darkness,
          horizonMaxPercent: horizon?.percent ?? null,
          horizonMaxLatitude: horizon?.latitude ?? null,
          horizonDistanceKm: horizon?.distanceKm ?? null,
          verdict: buildVerdict({ band, darkness, geomLat, horizon, lat, pct, sunElevation }),
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
      lines.push(`**Sun Elevation:** ${l.sunElevationDeg}° at forecast time (${l.darkness})`);
      lines.push(
        `**Horizon (≤1000 km poleward):** ${
          l.horizonMaxPercent === null
            ? 'none — no grid cell lies in the poleward scan window'
            : `${l.horizonMaxPercent}% at ${l.horizonMaxLatitude}° latitude, ${l.horizonDistanceKm} km away`
        }`,
      );
      lines.push(`**Verdict:** ${l.verdict}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
