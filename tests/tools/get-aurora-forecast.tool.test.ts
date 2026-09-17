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
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

const mockGetSpaceWeatherService = vi.mocked(getSpaceWeatherService);

/**
 * Build a minimal OVATION grid with a handful of points. Includes high-aurora
 * points at known polar latitudes and near-zero points at mid-latitudes.
 */
function makeAuroraGrid(): AuroraForecastData {
  return {
    meta: {
      observationTime: '2026-06-04T14:30:00Z',
      forecastTime: '2026-06-04T15:00:00Z',
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
    expect(result.observationTime).toBe('2026-06-04T14:30:00Z');
    expect(result.forecastTime).toBe('2026-06-04T15:00:00Z');
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
      meta: { observationTime: '2026-06-04T14:30:00Z', forecastTime: '2026-06-04T15:00:00Z' },
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
      meta: { observationTime: '2026-06-08T09:00:00Z', forecastTime: '2026-06-08T09:30:00Z' },
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
      meta: { observationTime: '2026-06-04T14:30:00Z', forecastTime: '2026-06-04T15:00:00Z' },
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

  /** A grid whose single point sits exactly on the requested coordinate. */
  function gridAt(lat: number, lon: number, auroraPercent: number): AuroraForecastData {
    return {
      meta: { observationTime: '2026-09-17T15:23:00Z', forecastTime: '2026-09-17T15:53:00Z' },
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
