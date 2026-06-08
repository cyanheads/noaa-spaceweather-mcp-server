/**
 * @fileoverview Tests for the noaa_spaceweather_get_kp_index tool.
 * @module tests/tools/get-kp-index.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KpForecast, KpObservation } from '@/services/space-weather/types.js';

vi.mock('@/services/space-weather/space-weather-service.js', () => ({
  getSpaceWeatherService: vi.fn(),
}));

import { getKpIndex } from '@/mcp-server/tools/definitions/get-kp-index.tool.js';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

const mockGetSpaceWeatherService = vi.mocked(getSpaceWeatherService);

/** Build Kp observation records spanning the last N hours. */
function makeObservations(count: number, baseKp = 3): KpObservation[] {
  const now = new Date();
  return Array.from({ length: count }, (_, i) => {
    const t = new Date(now.getTime() - (count - i) * 3 * 60 * 60 * 1000);
    const kp = baseKp + (i % 3);
    return {
      timeTag: t.toISOString(),
      kp,
      gScale: kp >= 5 ? 1 : 0,
      auroraLatitude:
        kp >= 5
          ? 'Aurora possible to ~60° geomagnetic latitude'
          : 'No significant aurora expected at mid-latitudes',
      aRunning: null,
      stationCount: 10,
    };
  });
}

function makeForecasts(): KpForecast[] {
  const now = new Date();
  return Array.from({ length: 8 }, (_, i) => ({
    timeTag: new Date(now.getTime() + i * 3 * 60 * 60 * 1000).toISOString(),
    kp: 2 + i * 0.5,
    observed: i === 0 ? 'observed' : 'predicted',
    noaaScale: i >= 2 ? 'G1' : null,
  }));
}

/** Build a mixed feed with past 'observed' + future 'estimated'/'predicted' entries (realistic SWPC shape). */
function makeMixedForecastFeed(): KpForecast[] {
  const now = new Date();
  // 5 past "observed" entries (these should be filtered out)
  const past = Array.from({ length: 5 }, (_, i) => ({
    timeTag: new Date(now.getTime() - (5 - i) * 3 * 60 * 60 * 1000).toISOString(),
    kp: 2,
    observed: 'observed' as string,
    noaaScale: null,
  }));
  // 2 "estimated" + 4 "predicted" forward entries (these should be kept)
  const forward = [
    {
      timeTag: new Date(now.getTime() + 1 * 3 * 60 * 60 * 1000).toISOString(),
      kp: 3,
      observed: 'estimated',
      noaaScale: null,
    },
    {
      timeTag: new Date(now.getTime() + 2 * 3 * 60 * 60 * 1000).toISOString(),
      kp: 4,
      observed: 'estimated',
      noaaScale: 'G0',
    },
    {
      timeTag: new Date(now.getTime() + 3 * 3 * 60 * 60 * 1000).toISOString(),
      kp: 5,
      observed: 'predicted',
      noaaScale: 'G1',
    },
    {
      timeTag: new Date(now.getTime() + 4 * 3 * 60 * 60 * 1000).toISOString(),
      kp: 2,
      observed: 'predicted',
      noaaScale: null,
    },
  ];
  return [...past, ...forward];
}

describe('getKpIndex', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns observed + forecast within window_days=1 (default)', async () => {
    const observations = makeObservations(8, 3);
    const forecasts = makeForecasts();
    const svc = {
      getKpObserved: vi.fn().mockResolvedValue(observations),
      getKpForecast: vi.fn().mockResolvedValue(forecasts),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getKpIndex.errors });
    const input = getKpIndex.input.parse({ window_days: 1 });
    const result = await getKpIndex.handler(input, ctx);

    expect(result.observed.length).toBeGreaterThan(0);
    // forecast[] excludes 'observed' entries — makeForecasts() has 1 observed entry,
    // so the result is forecasts.length - 1.
    const expectedForwardCount = forecasts.filter((f) => f.observed !== 'observed').length;
    expect(result.forecast).toHaveLength(expectedForwardCount);
    expect(result.currentKp).toBeGreaterThanOrEqual(0);
    expect(result.currentGScale).toBeGreaterThanOrEqual(0);
    expect(result.observedCount).toBe(result.observed.length);
    // gLabel must be derived from gScale
    for (const r of result.observed) {
      expect(r.gLabel).toBe(`G${r.gScale}`);
    }
  });

  it('extends window to 7 days when requested', async () => {
    // Put observations spread over 7 days
    const observations = Array.from({ length: 56 }, (_, i) => {
      const t = new Date(Date.now() - i * 3 * 60 * 60 * 1000);
      return {
        timeTag: t.toISOString(),
        kp: 2,
        gScale: 0,
        auroraLatitude: 'No significant aurora expected at mid-latitudes',
        aRunning: null,
        stationCount: 10,
      };
    });
    const svc = {
      getKpObserved: vi.fn().mockResolvedValue(observations),
      getKpForecast: vi.fn().mockResolvedValue([]),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getKpIndex.errors });
    const input = getKpIndex.input.parse({ window_days: 7 });
    const result = await getKpIndex.handler(input, ctx);

    // Should return more observations for 7 days vs 1 day
    expect(result.observedCount).toBeGreaterThan(0);
    expect(result.observed.length).toBe(result.observedCount);
  });

  it('forecast[] contains only forward-looking entries (estimated/predicted), not observed history (regression #7)', async () => {
    const observations = makeObservations(8, 3);
    const mixedFeed = makeMixedForecastFeed();
    const svc = {
      getKpObserved: vi.fn().mockResolvedValue(observations),
      getKpForecast: vi.fn().mockResolvedValue(mixedFeed),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getKpIndex.errors });
    const input = getKpIndex.input.parse({ window_days: 1 });
    const result = await getKpIndex.handler(input, ctx);

    // No "observed" status entries should be in the forecast array
    expect(result.forecast.every((f) => f.observed !== 'observed')).toBe(true);
    // Only the 4 forward-looking entries should remain (2 estimated + 2 predicted)
    expect(result.forecast).toHaveLength(4);
    // All forecast entries carry both G-scale representations
    for (const f of result.forecast) {
      expect(typeof f.gScale).toBe('number');
      expect(f.gLabel).toBe(`G${f.gScale}`);
      expect(f.noaaScale !== undefined).toBe(true); // noaaScale preserved (may be null)
    }
  });

  it('forecast[] gScale and gLabel are consistent with kp value (regression #7)', async () => {
    const observations = makeObservations(2, 2);
    const forecasts: KpForecast[] = [
      {
        timeTag: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        kp: 5,
        observed: 'predicted',
        noaaScale: 'G1',
      },
      {
        timeTag: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
        kp: 7,
        observed: 'predicted',
        noaaScale: 'G3',
      },
      {
        timeTag: new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString(),
        kp: 9,
        observed: 'predicted',
        noaaScale: 'G5',
      },
    ];
    const svc = {
      getKpObserved: vi.fn().mockResolvedValue(observations),
      getKpForecast: vi.fn().mockResolvedValue(forecasts),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getKpIndex.errors });
    const input = getKpIndex.input.parse({ window_days: 1 });
    const result = await getKpIndex.handler(input, ctx);

    const [f1, f2, f3] = result.forecast;
    expect(f1!.gScale).toBe(1);
    expect(f1!.gLabel).toBe('G1');
    expect(f2!.gScale).toBe(3);
    expect(f2!.gLabel).toBe('G3');
    expect(f3!.gScale).toBe(5);
    expect(f3!.gLabel).toBe('G5');
  });

  it('rejects window_days out of range via Zod validation', () => {
    // window_days is constrained to 1–7 by .min(1).max(7); Zod throws before the handler runs.
    expect(() => getKpIndex.input.parse({ window_days: 0 })).toThrow();
    expect(() => getKpIndex.input.parse({ window_days: 8 })).toThrow();
  });

  it('defaults currentKp to 0 when no observations in window', async () => {
    // All observations older than the window
    const oldObservation = {
      timeTag: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      kp: 5,
      gScale: 1,
      auroraLatitude: 'Aurora possible to ~60° geomagnetic latitude',
      aRunning: null,
      stationCount: 10,
    };
    const svc = {
      getKpObserved: vi.fn().mockResolvedValue([oldObservation]),
      getKpForecast: vi.fn().mockResolvedValue([]),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getKpIndex.errors });
    const input = getKpIndex.input.parse({ window_days: 1 });
    const result = await getKpIndex.handler(input, ctx);

    expect(result.observedCount).toBe(0);
    expect(result.currentKp).toBe(0);
    expect(result.currentGScale).toBe(0);
  });

  it('formats output with Kp header and both series', () => {
    const output = {
      observed: [
        {
          timeTag: '2026-06-04T12:00:00Z',
          kp: 5,
          gScale: 1,
          gLabel: 'G1',
          auroraLatitude: 'Aurora possible to ~60° geomagnetic latitude',
        },
      ],
      forecast: [
        {
          timeTag: '2026-06-04T15:00:00Z',
          kp: 3,
          observed: 'predicted',
          noaaScale: null,
          gScale: 0,
          gLabel: 'G0',
        },
      ],
      currentKp: 5,
      currentGScale: 1,
      auroraLatitude: 'Aurora possible to ~60° geomagnetic latitude',
      observedCount: 1,
    };
    const blocks = getKpIndex.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Kp 5');
    expect(text).toContain('G1');
    expect(text).toContain('Forecast');
    expect(text).toContain('Aurora possible to ~60°');
  });
});
