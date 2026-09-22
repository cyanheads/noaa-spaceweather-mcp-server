/**
 * @fileoverview Tests for the noaa_spaceweather_get_aurora_forecast tool.
 * @module tests/tools/get-aurora-forecast.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuroraForecastData } from '@/services/space-weather/types.js';

// Partial mock: stub the service accessor but keep the real aurora band table, which
// the tool reads for every Kp/G threshold these tests assert (#28). Stubbing it would
// test the stub, not the shared table.
vi.mock('@/services/space-weather/space-weather-service.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/space-weather/space-weather-service.js')>();
  return {
    ...actual,
    getSpaceWeatherService: vi.fn(),
  };
});

import { getAuroraForecast } from '@/mcp-server/tools/definitions/get-aurora-forecast.tool.js';
import { solarElevationDeg } from '@/services/space-weather/solar-position.js';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

const mockGetSpaceWeatherService = vi.mocked(getSpaceWeatherService);

/**
 * Build a minimal OVATION grid with a handful of points. Includes high-aurora
 * points at known polar latitudes and near-zero points at mid-latitudes.
 *
 * Every fixture that drives the probability ladder carries a forecast time at which
 * its requested coordinates are in full darkness (sun below −12°), so the daylight
 * gate leaves the ladder output as it was.
 */
function makeAuroraGrid(): AuroraForecastData {
  return {
    meta: {
      observationTime: '2026-06-04T07:30:00Z',
      forecastTime: '2026-06-04T08:00:00Z',
    },
    // [lon, lat, aurora%] triples. Keep a small grid covering Seattle (~47°N, -122°W)
    // and a high-aurora region at 70°N.
    grid: [
      { longitude: -122, latitude: 47, auroraPercent: 3 }, // near Seattle
      { longitude: -121, latitude: 48, auroraPercent: 2 },
      { longitude: 25, latitude: 70, auroraPercent: 85 }, // Scandinavia — global peak
      { longitude: 0, latitude: -70, auroraPercent: 60 }, // Antarctic
    ],
  };
}

describe('getAuroraForecast', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns global grid metadata without coordinates', async () => {
    const svc = { getAuroraForecast: vi.fn().mockResolvedValue(makeAuroraGrid()) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAuroraForecast.errors });
    const input = getAuroraForecast.input.parse({});
    const result = await getAuroraForecast.handler(input, ctx);

    expect(result.localLookup).toBeNull();
    expect(result.gridPointCount).toBe(4);
    expect(result.topAuroraPercent).toBe(85);
    expect(result.topAuroraRegion).toContain('70');
    expect(result.observationTime).toBe('2026-06-04T07:30:00Z');
    expect(result.forecastTime).toBe('2026-06-04T08:00:00Z');
  });

  it('finds nearest grid point for Seattle coordinates (47°N, -122°W)', async () => {
    const svc = { getAuroraForecast: vi.fn().mockResolvedValue(makeAuroraGrid()) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAuroraForecast.errors });
    const input = getAuroraForecast.input.parse({ latitude: 47.6, longitude: -122.3 });
    const result = await getAuroraForecast.handler(input, ctx);

    expect(result.localLookup).not.toBeNull();
    expect(result.localLookup!.requestedLatitude).toBe(47.6);
    expect(result.localLookup!.requestedLongitude).toBe(-122.3);
    // Nearest grid point should be (-122, 47) with 3% probability
    expect(result.localLookup!.auroraPercent).toBe(3);
    // At ~47° latitude, need Kp ~6+
    expect(result.localLookup!.minKpRequired).toBeGreaterThanOrEqual(5);
    // Low probability → low chance verdict
    expect(result.localLookup!.verdict).toMatch(/Very low|Low/);
  });

  it('throws invalid_coordinates when only latitude is provided', async () => {
    const svc = { getAuroraForecast: vi.fn().mockResolvedValue(makeAuroraGrid()) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAuroraForecast.errors });
    const input = { latitude: 47.6, longitude: undefined } as Parameters<
      typeof getAuroraForecast.handler
    >[0];
    await expect(getAuroraForecast.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_coordinates' },
    });
  });

  it('gives a "good chance" verdict near the auroral oval', async () => {
    // Build a grid with high aurora probability at ~70°N
    const highAuroraGrid: AuroraForecastData = {
      meta: { observationTime: '2026-12-04T21:30:00Z', forecastTime: '2026-12-04T22:00:00Z' },
      grid: [
        { longitude: 25, latitude: 70, auroraPercent: 80 },
        { longitude: 26, latitude: 70, auroraPercent: 75 },
      ],
    };
    const svc = { getAuroraForecast: vi.fn().mockResolvedValue(highAuroraGrid) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAuroraForecast.errors });
    const input = getAuroraForecast.input.parse({ latitude: 70, longitude: 25 });
    const result = await getAuroraForecast.handler(input, ctx);

    expect(result.localLookup).not.toBeNull();
    expect(result.localLookup!.auroraPercent).toBe(80);
    // minKp=0 at ≥65° lat — verdict should NOT say "Kp≥0 needed"
    expect(result.localLookup!.minKpRequired).toBe(0);
    expect(result.localLookup!.verdict).toMatch(/Good aurora chance/);
    expect(result.localLookup!.verdict).not.toContain('Kp≥0');
  });

  it('returns "not visible" verdict at equatorial latitude where minKp=9 (regression #9)', async () => {
    // At latitude 0 (equator), minKpForLatitude returns 9.
    // Even a G5 extreme storm does not reach below ~40° geographic latitude.
    // The verdict must not imply aurora is reachable.
    const equatorialGrid: AuroraForecastData = {
      meta: { observationTime: '2026-06-08T00:00:00Z', forecastTime: '2026-06-08T00:30:00Z' },
      grid: [
        { longitude: 0, latitude: 0, auroraPercent: 8 }, // OVATION artifact at equator
        { longitude: 1, latitude: 0, auroraPercent: 5 },
      ],
    };
    const svc = { getAuroraForecast: vi.fn().mockResolvedValue(equatorialGrid) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAuroraForecast.errors });
    const input = getAuroraForecast.input.parse({ latitude: 0, longitude: 0 });
    const result = await getAuroraForecast.handler(input, ctx);

    expect(result.localLookup).not.toBeNull();
    expect(result.localLookup!.minKpRequired).toBe(9);
    // Must NOT say "Kp≥9 needed" — that implies aurora is possible with extreme storms
    expect(result.localLookup!.verdict).not.toMatch(/Kp[≥>=]+9 needed/);
    // Must clearly state aurora is not visible at this latitude
    expect(result.localLookup!.verdict).toMatch(/not visible|not reach/i);
  });

  it('omits Kp threshold clause when minKpRequired=0 and probability is low (issue #3)', async () => {
    const highLatGrid: AuroraForecastData = {
      meta: { observationTime: '2026-12-04T17:30:00Z', forecastTime: '2026-12-04T18:00:00Z' },
      grid: [{ longitude: 18, latitude: 69, auroraPercent: 7 }], // 7% — low chance bracket
    };
    const svc = { getAuroraForecast: vi.fn().mockResolvedValue(highLatGrid) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAuroraForecast.errors });
    const input = getAuroraForecast.input.parse({ latitude: 69.6, longitude: 18.95 });
    const result = await getAuroraForecast.handler(input, ctx);

    expect(result.localLookup).not.toBeNull();
    expect(result.localLookup!.minKpRequired).toBe(0);
    // Must not contain "Kp≥0 needed" — that statement is trivially true and useless.
    expect(result.localLookup!.verdict).not.toContain('Kp≥0');
    expect(result.localLookup!.verdict).toMatch(/Low aurora chance/);
  });

  it('formats output with grid stats and local lookup section', () => {
    const output = {
      observationTime: '2026-06-04T14:30:00Z',
      forecastTime: '2026-06-04T15:00:00Z',
      localLookup: {
        requestedLatitude: 47.6,
        requestedLongitude: -122.3,
        geomagneticLatitude: 53.03,
        gridLatitude: 47,
        gridLongitude: -122,
        auroraPercent: 3,
        minKpRequired: 6.67,
        minGScale: 3,
        sunElevationDeg: -19.9,
        darkness: 'dark' as const,
        horizonMaxPercent: 2,
        horizonMaxLatitude: 48,
        horizonDistanceKm: 88,
        verdict: 'Very low aurora probability (3%) at this location. Kp≥6.67 needed.',
      },
      gridPointCount: 4,
      topAuroraPercent: 85,
      topAuroraRegion: '70°N, 25°E',
    };
    const blocks = getAuroraForecast.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Aurora Forecast');
    expect(text).toContain('85%');
    expect(text).toContain('70°N');
    expect(text).toContain('Local Forecast');
    expect(text).toContain('47.6°');
    expect(text).toContain('3%');
    expect(text).toContain('Very low aurora probability');
    // Every declared localLookup field reaches content[], not just structuredContent.
    expect(text).toContain('53.03');
    expect(text).toContain('6.67');
    expect(text).toContain('G3');
  });

  it('renders the unreachable band in format() without naming a G level', () => {
    const blocks = getAuroraForecast.format!({
      observationTime: '2026-06-08T09:00:00Z',
      forecastTime: '2026-06-08T09:30:00Z',
      localLookup: {
        requestedLatitude: 0,
        requestedLongitude: 0,
        geomagneticLatitude: 2.71,
        gridLatitude: 0,
        gridLongitude: 0,
        auroraPercent: 8,
        minKpRequired: 9,
        minGScale: null,
        sunElevationDeg: -66,
        darkness: 'dark' as const,
        horizonMaxPercent: 5,
        horizonMaxLatitude: 1,
        horizonDistanceKm: 111,
        verdict: 'Aurora not visible at 2.7° geomagnetic latitude.',
      },
      gridPointCount: 2,
      topAuroraPercent: 8,
      topAuroraRegion: '0°N, 0°E',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('2.71');
    expect(text).toMatch(/not reachable|unreachable|—/);
  });
});

/**
 * Geomagnetic latitudes are the centered-dipole conversion against the IGRF-14
 * pole for epoch 2025.0 (80.789°N, 72.763°W), the same figures the issue derived
 * from the degree-1 Gauss coefficients.
 */
describe('getAuroraForecast geomagnetic latitude (#28)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /**
   * A grid whose single point sits exactly on the requested coordinate. 04:40Z is
   * full dark at Denver, San Francisco, and (0, 0) alike.
   */
  function gridAt(lat: number, lon: number, auroraPercent: number): AuroraForecastData {
    return {
      meta: { observationTime: '2026-09-17T04:10:00Z', forecastTime: '2026-09-17T04:40:00Z' },
      grid: [{ latitude: Math.round(lat), longitude: Math.round(lon), auroraPercent }],
    };
  }

  async function lookup(lat: number, lon: number, auroraPercent = 1) {
    const svc = { getAuroraForecast: vi.fn().mockResolvedValue(gridAt(lat, lon, auroraPercent)) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: getAuroraForecast.errors });
    const input = getAuroraForecast.input.parse({ latitude: lat, longitude: lon });
    const result = await getAuroraForecast.handler(input, ctx);
    return result.localLookup!;
  }

  const CONVERSION_CASES: [
    name: string,
    lat: number,
    lon: number,
    geomagnetic: number,
    minKp: number,
    minGScale: number | null,
  ][] = [
    ['Denver', 39.74, -104.99, 47.32, 7.67, 4],
    ['San Francisco', 37.77, -122.42, 43.35, 9.0, 5],
    ['Seattle', 47.61, -122.33, 53.03, 6.67, 3],
    ['Hobart', -42.88, 147.33, -49.59, 7.67, 4],
    ['Moscow', 55.75, 37.62, 51.7, 6.67, 3],
  ];

  it.each(CONVERSION_CASES)(
    'converts %s to geomagnetic latitude and reports the matching band floor',
    async (_name, lat, lon, geomagnetic, minKp, minGScale) => {
      const l = await lookup(lat, lon);

      expect(l.geomagneticLatitude).toBeCloseTo(geomagnetic, 1);
      expect(l.minKpRequired).toBe(minKp);
      expect(l.minGScale).toBe(minGScale);
    },
  );

  it('no longer tells Denver and San Francisco that aurora is impossible', async () => {
    for (const [lat, lon] of [
      [39.74, -104.99],
      [37.77, -122.42],
    ]) {
      const l = await lookup(lat!, lon!);
      expect(l.verdict).not.toMatch(/not visible/i);
    }
  });

  it('raises the threshold where geomagnetic latitude is lower than geographic (Moscow)', async () => {
    // Moscow's geomagnetic latitude is ~4° below its geographic one, so reading the
    // geographic value under-stated the Kp needed.
    const l = await lookup(55.75, 37.62);
    expect(l.geomagneticLatitude).toBeLessThan(55.75);
    expect(l.minKpRequired).toBeGreaterThan(4);
  });

  it('reports the unreachable band below 40° geomagnetic', async () => {
    const l = await lookup(0, 0);
    expect(Math.abs(l.geomagneticLatitude)).toBeLessThan(40);
    expect(l.minGScale).toBeNull();
    expect(l.minKpRequired).toBe(9);
  });

  it('yields the "not visible" verdict to a grid point reading 10% or more', async () => {
    // Below 40° geomagnetic the verdict is normally "not visible"; a real oval
    // reading (≥10%) is signal rather than the 8% artifact #9 pinned.
    const artifact = await lookup(0, 0, 8);
    const real = await lookup(0, 0, 10);

    expect(artifact.verdict).toMatch(/not visible/i);
    expect(real.verdict).not.toMatch(/not visible/i);
    expect(real.verdict).toContain('10%');
  });
});

/**
 * The exact verdict every branch of the probability ladder produces in full darkness.
 * The daylight gate (#36) must leave these byte-identical: a `dark` sky adds no
 * caveat, and a single-cell grid has nothing poleward to add a horizon clause.
 */
describe('getAuroraForecast ladder output in full darkness', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const LADDER_CASES: [
    branch: string,
    lat: number,
    lon: number,
    auroraPercent: number,
    forecastTime: string,
    verdict: string,
  ][] = [
    [
      'oval, good chance',
      70,
      25,
      80,
      '2026-12-04T22:00:00Z',
      'Good aurora chance (80%) at 67.0° geomagnetic latitude — inside the auroral oval, no Kp minimum required, aurora possible now.',
    ],
    [
      'oval, low chance',
      69.6,
      18.95,
      7,
      '2026-12-04T18:00:00Z',
      'Low aurora chance (7%) at this location — aurora activity is low despite the favorable geomagnetic latitude of 67.4°.',
    ],
    [
      'oval, very low',
      70,
      25,
      2,
      '2026-12-04T22:00:00Z',
      'Very low aurora probability (2%) despite a favorable geomagnetic latitude of 67.0° — wait for elevated solar activity and higher Kp.',
    ],
    [
      'banded, good chance',
      47.6,
      -122.3,
      40,
      '2026-06-04T08:00:00Z',
      'Good aurora chance (40%) — Kp≥6.67 (G3) needed at 53.0° geomagnetic.',
    ],
    [
      'banded, low chance',
      47.6,
      -122.3,
      12,
      '2026-06-04T08:00:00Z',
      'Low aurora chance (12%) — conditions marginal. Kp≥6.67 (G3) needed at 53.0° geomagnetic.',
    ],
    [
      'banded, very low',
      47.6,
      -122.3,
      3,
      '2026-06-04T08:00:00Z',
      'Very low aurora probability (3%) at this location. Kp≥6.67 (G3) needed at 53.0° geomagnetic. Travel toward higher geomagnetic latitudes or wait for elevated Kp.',
    ],
    [
      'below 40° geomagnetic, artifact',
      0,
      0,
      8,
      '2026-06-08T00:30:00Z',
      'Aurora not visible at 2.7° geomagnetic latitude (0° geographic) — even G5 extreme storms (Kp 9) do not reach below 40° geomagnetic latitude. Travel toward higher geomagnetic latitudes to see aurora.',
    ],
    [
      'below 40° geomagnetic, override',
      0,
      0,
      10,
      '2026-06-08T00:30:00Z',
      'Aurora is normally not seen at 2.7° geomagnetic latitude, but the nearest grid point reads 10% — an exceptional reading; only G5-class (Kp 9) storms push the oval this far equatorward.',
    ],
  ];

  it.each(LADDER_CASES)('%s', async (_branch, lat, lon, auroraPercent, forecastTime, verdict) => {
    const grid: AuroraForecastData = {
      meta: { observationTime: forecastTime, forecastTime },
      grid: [{ latitude: Math.round(lat), longitude: Math.round(lon), auroraPercent }],
    };
    const svc = { getAuroraForecast: vi.fn().mockResolvedValue(grid) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAuroraForecast.errors });
    const input = getAuroraForecast.input.parse({ latitude: lat, longitude: lon });
    const result = await getAuroraForecast.handler(input, ctx);

    expect(result.localLookup!.verdict).toBe(verdict);
  });
});

describe('getAuroraForecast antimeridian wrap (#28)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /**
   * The normalized OVATION grid runs −179..180, so there is a +180 column and no
   * −180 one. A raw longitude difference lands a request just west of the
   * antimeridian on the wrong cell.
   */
  const wrapGrid: AuroraForecastData = {
    meta: { observationTime: '2026-09-17T15:23:00Z', forecastTime: '2026-09-17T15:53:00Z' },
    grid: [
      { longitude: 180, latitude: 51, auroraPercent: 42 }, // 0.2° away
      { longitude: -179, latitude: 51, auroraPercent: 7 }, // 0.8° away
    ],
  };

  it('picks the nearest cell across the antimeridian for a request at −179.8°', async () => {
    const svc = { getAuroraForecast: vi.fn().mockResolvedValue(wrapGrid) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAuroraForecast.errors });
    const input = getAuroraForecast.input.parse({ latitude: 51, longitude: -179.8 });
    const result = await getAuroraForecast.handler(input, ctx);

    expect(result.localLookup!.gridLongitude).toBe(180);
    expect(result.localLookup!.auroraPercent).toBe(42);
  });

  it('picks the nearest cell across the antimeridian for a request at +179.8°', async () => {
    const svc = { getAuroraForecast: vi.fn().mockResolvedValue(wrapGrid) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAuroraForecast.errors });
    const input = getAuroraForecast.input.parse({ latitude: 51, longitude: 179.8 });
    const result = await getAuroraForecast.handler(input, ctx);

    expect(result.localLookup!.gridLongitude).toBe(180);
  });

  it('maps an exact +180° request onto the grid’s 180 column', async () => {
    const svc = { getAuroraForecast: vi.fn().mockResolvedValue(wrapGrid) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAuroraForecast.errors });
    const input = getAuroraForecast.input.parse({ latitude: 51, longitude: 180 });
    const result = await getAuroraForecast.handler(input, ctx);

    expect(result.localLookup!.gridLongitude).toBe(180);
  });
});

/** Run a local lookup against `grid` and return the lookup payload. */
async function localLookupFor(grid: AuroraForecastData, latitude: number, longitude: number) {
  const svc = { getAuroraForecast: vi.fn().mockResolvedValue(grid) };
  mockGetSpaceWeatherService.mockReturnValue(svc as never);
  const ctx = createMockContext({ errors: getAuroraForecast.errors });
  const input = getAuroraForecast.input.parse({ latitude, longitude });
  const result = await getAuroraForecast.handler(input, ctx);
  return result.localLookup!;
}

/** A grid of `cells` valid at `forecastTime`. */
function gridOf(
  forecastTime: string,
  cells: [latitude: number, longitude: number, auroraPercent: number][],
): AuroraForecastData {
  return {
    meta: { observationTime: forecastTime, forecastTime },
    grid: cells.map(([latitude, longitude, auroraPercent]) => ({
      latitude,
      longitude,
      auroraPercent,
    })),
  };
}

const DAYLIGHT_VERDICT = /^not visible — daylight at the forecast time/i;
const TWILIGHT_CAVEAT = 'only bright aurora will show';

/** Seattle's Sep 22–23 evening: the sun sets ~02:07Z and passes −18° by ~03:50Z. */
const SEATTLE = { latitude: 47.6, longitude: -122.3 } as const;
const SEATTLE_BANDED_LOW =
  'Low aurora chance (12%) — conditions marginal. Kp≥6.67 (G3) needed at 53.0° geomagnetic.';

describe('getAuroraForecast daylight gate (#36)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reports daylight instead of a probability at (−64, 157), sun 19.6° up', async () => {
    const l = await localLookupFor(gridOf('2026-09-22T22:45:00Z', [[-64, 157, 5]]), -64, 157);

    expect(l.sunElevationDeg).toBe(19.6);
    expect(l.darkness).toBe('day');
    expect(l.auroraPercent).toBe(5);
    expect(l.verdict).toMatch(DAYLIGHT_VERDICT);
    expect(l.verdict).not.toMatch(/%/);
    expect(l.verdict).not.toMatch(/Kp/);
  });

  it('never reaches the ladder in daylight, even at an oval reading that would say "Good chance"', async () => {
    // (70, 25) on 2026-06-04 is inside the midnight-sun season: sunlit at every hour.
    const l = await localLookupFor(gridOf('2026-06-04T15:00:00Z', [[70, 25, 80]]), 70, 25);

    expect(l.darkness).toBe('day');
    expect(l.verdict).toMatch(DAYLIGHT_VERDICT);
    expect(l.verdict).not.toMatch(/Good aurora chance|%|Kp/);
  });

  it('keeps the ladder and adds the bright-aurora caveat in civil twilight', async () => {
    const l = await localLookupFor(
      gridOf('2026-09-23T02:20:00Z', [[47, -122, 12]]),
      SEATTLE.latitude,
      SEATTLE.longitude,
    );

    expect(l.darkness).toBe('civil_twilight');
    expect(l.sunElevationDeg).toBeCloseTo(-3.1, 1);
    expect(l.verdict.startsWith(SEATTLE_BANDED_LOW)).toBe(true);
    expect(l.verdict).toContain('Civil twilight');
    expect(l.verdict).toContain(TWILIGHT_CAVEAT);
  });

  it('keeps the ladder and adds the bright-aurora caveat in nautical twilight', async () => {
    const l = await localLookupFor(
      gridOf('2026-09-23T02:50:00Z', [[47, -122, 12]]),
      SEATTLE.latitude,
      SEATTLE.longitude,
    );

    expect(l.darkness).toBe('nautical_twilight');
    expect(l.sunElevationDeg).toBeCloseTo(-8.1, 1);
    expect(l.verdict.startsWith(SEATTLE_BANDED_LOW)).toBe(true);
    expect(l.verdict).toContain('Nautical twilight');
    expect(l.verdict).toContain(TWILIGHT_CAVEAT);
  });

  it('leaves the ladder output unchanged in full dark', async () => {
    const l = await localLookupFor(
      gridOf('2026-09-23T04:00:00Z', [[47, -122, 12]]),
      SEATTLE.latitude,
      SEATTLE.longitude,
    );

    expect(l.darkness).toBe('dark');
    expect(l.sunElevationDeg).toBeLessThan(-12);
    expect(l.verdict).toBe(SEATTLE_BANDED_LOW);
  });

  it('reads polar day at 78°N near the June solstice at local midnight', async () => {
    const l = await localLookupFor(gridOf('2026-06-20T23:00:00Z', [[78, 15, 80]]), 78, 15);

    expect(l.darkness).toBe('day');
    expect(l.sunElevationDeg).toBeGreaterThan(0);
    expect(l.verdict).toMatch(DAYLIGHT_VERDICT);
    expect(l.verdict).not.toMatch(/%/);
  });

  it('reads polar night at 80°N near the December solstice at local noon, ladder unaffected', async () => {
    const l = await localLookupFor(gridOf('2026-12-21T11:00:00Z', [[80, 15, 80]]), 80, 15);

    expect(l.darkness).toBe('dark');
    expect(l.sunElevationDeg).toBeLessThan(-12);
    expect(l.verdict).toMatch(
      /^Good aurora chance \(80%\) at [\d.]+° geomagnetic latitude — inside/,
    );
    expect(l.verdict).not.toContain(TWILIGHT_CAVEAT);
  });

  it('reads 78°N at December-solstice local noon as nautical twilight, not dark', async () => {
    // Noon elevation there is 90 − 78 − 23.4 ≈ −11.4°, above the −12° dark edge.
    const l = await localLookupFor(gridOf('2026-12-21T11:00:00Z', [[78, 15, 80]]), 78, 15);

    expect(l.sunElevationDeg).toBeCloseTo(-11.4, 1);
    expect(l.darkness).toBe('nautical_twilight');
    expect(l.verdict).toMatch(/^Good aurora chance \(80%\)/);
    expect(l.verdict).toContain(TWILIGHT_CAVEAT);
  });

  /**
   * The instant on Seattle's Sep 22–23 evening at which the raw solar elevation equals
   * `target`, by bisection over the tool's own solar-position function. The sun is
   * strictly descending across the window, so the crossing is unique.
   */
  function instantAtElevation(target: number): string {
    let lo = Date.parse('2026-09-23T01:00:00Z');
    let hi = Date.parse('2026-09-23T04:00:00Z');
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (solarElevationDeg(new Date(mid), SEATTLE.latitude, SEATTLE.longitude) > target) lo = mid;
      else hi = mid;
    }
    return new Date(hi).toISOString();
  }

  it.each([
    [0, 'day'],
    [-6, 'civil_twilight'],
    [-12, 'nautical_twilight'],
  ] as const)(
    'resolves sunElevationDeg exactly %s to the brighter state (%s)',
    async (target, darkness) => {
      const l = await localLookupFor(
        gridOf(instantAtElevation(target), [[47, -122, 12]]),
        SEATTLE.latitude,
        SEATTLE.longitude,
      );

      expect(l.sunElevationDeg).toBe(target);
      expect(l.darkness).toBe(darkness);
    },
  );

  it.each([
    [-0.1, 'civil_twilight'],
    [-6.1, 'nautical_twilight'],
    [-12.1, 'dark'],
  ] as const)(
    'resolves sunElevationDeg %s, one step past a boundary, to %s',
    async (target, darkness) => {
      const l = await localLookupFor(
        gridOf(instantAtElevation(target), [[47, -122, 12]]),
        SEATTLE.latitude,
        SEATTLE.longitude,
      );

      expect(l.sunElevationDeg).toBe(target);
      expect(l.darkness).toBe(darkness);
    },
  );

  it('fails with feed_moved when the feed carries no parseable forecast time for a local lookup', async () => {
    const grid = gridOf('', [[47, -122, 12]]);
    const svc = { getAuroraForecast: vi.fn().mockResolvedValue(grid) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: getAuroraForecast.errors });
    const input = getAuroraForecast.input.parse({ latitude: 47.6, longitude: -122.3 });

    await expect(getAuroraForecast.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'feed_moved' },
    });
  });

  it('still answers the global-metadata call when the forecast time is missing', async () => {
    const svc = { getAuroraForecast: vi.fn().mockResolvedValue(gridOf('', [[47, -122, 12]])) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: getAuroraForecast.errors });
    const result = await getAuroraForecast.handler(getAuroraForecast.input.parse({}), ctx);

    expect(result.localLookup).toBeNull();
    expect(result.topAuroraPercent).toBe(12);
  });
});

describe('getAuroraForecast horizon view (#37)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /** Full dark at Seattle. */
  const DARK = '2026-09-23T04:00:00Z';
  const SEATTLE_VERY_LOW_0 =
    'Very low aurora probability (0%) at this location. Kp≥6.67 (G3) needed at 53.0° geomagnetic. Travel toward higher geomagnetic latitudes or wait for elevated Kp.';

  /**
   * 0% overhead with a 34% cell ~6° poleward, plus a decoy outside each edge of the
   * scan window: past ±2° longitude, past 1000 km, on the nearest grid latitude's own
   * row, and equatorward. Several rows sit inside the window, so the maximum is found
   * past the first poleward row.
   */
  const HORIZON_CELLS: [number, number, number][] = [
    [48, -122, 0], // nearest cell — the overhead reading
    [49, -122, 1],
    [50, -123, 5],
    [53, -122, 34], // the expected horizon maximum, 601 km north
    [55, -122, 20],
    [53, -125, 90], // 2.7° west — outside the ±2° longitude window
    [57, -122, 95], // 1045 km — past the 1000 km radius
    [48, -121, 99], // the nearest grid latitude's own row — not strictly poleward
    [47, -122, 99], // equatorward
  ];

  it('reports the strongest cell within 1000 km poleward and adds the horizon clause', async () => {
    const l = await localLookupFor(
      gridOf(DARK, HORIZON_CELLS),
      SEATTLE.latitude,
      SEATTLE.longitude,
    );

    expect(l.auroraPercent).toBe(0);
    expect(l.horizonMaxPercent).toBe(34);
    expect(l.horizonMaxLatitude).toBe(53);
    expect(l.horizonDistanceKm).toBe(601);
    expect(l.verdict).toBe(
      `${SEATTLE_VERY_LOW_0} 0% overhead; 34% about 601 km north — aurora may be visible low on the northern horizon.`,
    );
  });

  it('scans both sides of the antimeridian from a request at longitude 179.5', async () => {
    const DARK_AT_179 = '2026-12-21T12:00:00Z';
    const base: [number, number, number][] = [
      [60, 180, 0],
      [62, -178, 80], // +2.5° across the seam — outside the window
      [62, 177, 80], // −2.5° — outside the window
    ];

    const east = await localLookupFor(
      gridOf(DARK_AT_179, [...base, [63, -179, 30], [62, 178, 25]]),
      60,
      179.5,
    );
    expect(east.horizonMaxPercent).toBe(30);
    expect(east.horizonMaxLatitude).toBe(63);
    expect(east.horizonDistanceKm).toBe(343);

    const west = await localLookupFor(
      gridOf(DARK_AT_179, [...base, [63, -179, 30], [62, 178, 45]]),
      60,
      179.5,
    );
    expect(west.horizonMaxPercent).toBe(45);
    expect(west.horizonMaxLatitude).toBe(62);
    expect(west.horizonDistanceKm).toBe(237);
  });

  it('resolves poleward by the sign of the requested latitude, not the nearest grid cell', async () => {
    // −0.4 rounds to the 0° grid row, whose sign would say "north".
    const l = await localLookupFor(
      gridOf('2026-09-17T23:00:00Z', [
        [0, 10, 0],
        [-3, 10, 15],
        [3, 10, 40],
      ]),
      -0.4,
      10,
    );

    expect(l.gridLatitude).toBe(0);
    expect(l.horizonMaxPercent).toBe(15);
    expect(l.horizonMaxLatitude).toBe(-3);
    expect(l.horizonDistanceKm).toBe(289);
    expect(l.verdict).toContain(
      '0% overhead; 15% about 289 km south — aurora may be visible low on the southern horizon.',
    );
  });

  it.each([
    [89.8, '2026-12-21T12:00:00Z', 90, 89],
    [-89.8, '2026-06-21T12:00:00Z', -90, -89],
  ])(
    'reports no horizon cell when the nearest grid latitude is the pole (%s°)',
    async (lat, forecastTime, poleRow, nextRow) => {
      const l = await localLookupFor(
        gridOf(forecastTime, [
          [poleRow, 0, 12],
          [nextRow, 0, 50],
        ]),
        lat,
        0,
      );

      expect(l.gridLatitude).toBe(poleRow);
      expect(l.horizonMaxPercent).toBeNull();
      expect(l.horizonMaxLatitude).toBeNull();
      expect(l.horizonDistanceKm).toBeNull();
      expect(l.verdict).not.toMatch(/overhead|horizon/);
    },
  );

  it('reports a poleward maximum below 10% without adding the clause', async () => {
    const l = await localLookupFor(
      gridOf(DARK, [
        [47, -122, 0],
        [52, -122, 9],
      ]),
      SEATTLE.latitude,
      SEATTLE.longitude,
    );

    expect(l.horizonMaxPercent).toBe(9);
    expect(l.horizonMaxLatitude).toBe(52);
    expect(l.verdict).toBe(SEATTLE_VERY_LOW_0);
  });

  it.each([
    ['below', 40, 30],
    ['equal to', 15, 15],
  ])(
    'reports a poleward maximum %s the overhead reading without adding the clause',
    async (_relation, overhead, horizon) => {
      const l = await localLookupFor(
        gridOf(DARK, [
          [47, -122, overhead],
          [52, -122, horizon],
        ]),
        SEATTLE.latitude,
        SEATTLE.longitude,
      );

      expect(l.horizonMaxPercent).toBe(horizon);
      expect(l.verdict).not.toMatch(/overhead|horizon/);
    },
  );

  it('breaks a tie on horizonMaxPercent toward the nearest cell', async () => {
    for (const cells of [
      [
        [50, -122, 25],
        [52, -122, 25],
      ],
      [
        [52, -122, 25],
        [50, -122, 25],
      ],
    ] as [number, number, number][][]) {
      const l = await localLookupFor(
        gridOf(DARK, [[47, -122, 0], ...cells]),
        SEATTLE.latitude,
        SEATTLE.longitude,
      );

      expect(l.horizonMaxLatitude).toBe(50);
      expect(l.horizonDistanceKm).toBe(268);
    }
  });

  it('never appends the horizon clause in daylight, though the fields still report it', async () => {
    const l = await localLookupFor(
      gridOf('2026-09-22T22:45:00Z', HORIZON_CELLS),
      SEATTLE.latitude,
      SEATTLE.longitude,
    );

    expect(l.darkness).toBe('day');
    expect(l.horizonMaxPercent).toBe(34);
    expect(l.verdict).toMatch(DAYLIGHT_VERDICT);
    expect(l.verdict).not.toMatch(/%|overhead|km|northern horizon/);
  });

  it('orders the verdict as ladder, horizon clause, then twilight caveat', async () => {
    const l = await localLookupFor(
      gridOf('2026-09-23T02:50:00Z', HORIZON_CELLS),
      SEATTLE.latitude,
      SEATTLE.longitude,
    );

    expect(l.darkness).toBe('nautical_twilight');
    const horizonAt = l.verdict.indexOf('34% about 601 km north');
    const caveatAt = l.verdict.indexOf(TWILIGHT_CAVEAT);
    expect(l.verdict.startsWith(SEATTLE_VERY_LOW_0)).toBe(true);
    expect(horizonAt).toBeGreaterThan(SEATTLE_VERY_LOW_0.length - 1);
    expect(caveatAt).toBeGreaterThan(horizonAt);
  });

  it('adds the horizon clause below 40° geomagnetic, after the "not visible" framing', async () => {
    const l = await localLookupFor(
      gridOf('2026-06-08T00:30:00Z', [
        [0, 0, 0],
        [4, 1, 22],
      ]),
      0,
      0,
    );

    expect(l.minGScale).toBeNull();
    expect(l.verdict).toMatch(/^Aurora not visible at 2\.7° geomagnetic latitude/);
    expect(l.verdict).toContain('0% overhead; 22% about');
  });
});

describe('getAuroraForecast format() for the darkness and horizon fields', () => {
  const BASE = {
    observationTime: '2026-09-23T03:30:00Z',
    forecastTime: '2026-09-23T04:00:00Z',
    gridPointCount: 9,
    topAuroraPercent: 99,
    topAuroraRegion: '47°N, 121°W',
  };
  const LOOKUP = {
    requestedLatitude: 47.6,
    requestedLongitude: -122.3,
    geomagneticLatitude: 53.03,
    gridLatitude: 47,
    gridLongitude: -122,
    auroraPercent: 0,
    minKpRequired: 6.67,
    minGScale: 3,
    verdict: 'Very low aurora probability (0%) at this location.',
  };

  type Output = Parameters<NonNullable<typeof getAuroraForecast.format>>[0];

  function textOf(localLookup: NonNullable<Output['localLookup']>): string {
    const blocks = getAuroraForecast.format!({ ...BASE, localLookup });
    return (blocks[0] as { text: string }).text;
  }

  it('renders the sun elevation, darkness state, and horizon reading', () => {
    const text = textOf({
      ...LOOKUP,
      sunElevationDeg: -8.1,
      darkness: 'nautical_twilight',
      horizonMaxPercent: 34,
      horizonMaxLatitude: 53,
      horizonDistanceKm: 601,
    });

    expect(text).toContain('-8.1°');
    expect(text).toContain('nautical_twilight');
    expect(text).toContain('34%');
    expect(text).toContain('53°');
    expect(text).toContain('601 km');
  });

  it('renders a missing horizon reading as absent rather than as 0%', () => {
    const text = textOf({
      ...LOOKUP,
      sunElevationDeg: -23.2,
      darkness: 'dark',
      horizonMaxPercent: null,
      horizonMaxLatitude: null,
      horizonDistanceKm: null,
    });

    expect(text).toMatch(/Horizon[^\n]*no grid cell/i);
    expect(text).not.toMatch(/Horizon[^\n]*0%/);
  });
});
