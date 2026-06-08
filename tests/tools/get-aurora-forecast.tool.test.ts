/**
 * @fileoverview Tests for the noaa_spaceweather_get_aurora_forecast tool.
 * @module tests/tools/get-aurora-forecast.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuroraForecastData } from '@/services/space-weather/types.js';

vi.mock('@/services/space-weather/space-weather-service.js', () => ({
  getSpaceWeatherService: vi.fn(),
}));

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
      code: JsonRpcErrorCode.InvalidParams,
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
        gridLatitude: 47,
        gridLongitude: -122,
        auroraPercent: 3,
        minKpRequired: 6,
        verdict: 'Very low aurora probability (3%) at this location. Kp≥6 needed.',
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
  });
});
