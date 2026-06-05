/**
 * @fileoverview Tests for the noaa_spaceweather_get_solar_wind tool.
 * @module tests/tools/get-solar-wind.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SolarWindMag, SolarWindPlasma } from '@/services/space-weather/types.js';

vi.mock('@/services/space-weather/space-weather-service.js', () => ({
  getSpaceWeatherService: vi.fn(),
}));

import { getSolarWind } from '@/mcp-server/tools/definitions/get-solar-wind.tool.js';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

const mockGetSpaceWeatherService = vi.mocked(getSpaceWeatherService);

function makePlasmaReading(hoursAgo: number, speed = 450): SolarWindPlasma {
  return {
    timeTag: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
    densityPerCm3: 5.2,
    speedKmS: speed,
    temperatureK: 80000,
  };
}

function makeMagReading(hoursAgo: number, bz = -5): SolarWindMag {
  return {
    timeTag: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
    bxGsm: 2,
    byGsm: -1,
    bzGsm: bz,
    bt: Math.sqrt(bz * bz + 4 + 1),
  };
}

describe('getSolarWind', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns plasma and mag series within default 3-hour window', async () => {
    const plasmaData = [
      makePlasmaReading(5), // outside default window
      makePlasmaReading(2), // inside
      makePlasmaReading(1), // inside
    ];
    const magData = [
      makeMagReading(5), // outside
      makeMagReading(2), // inside
      makeMagReading(1), // inside
    ];
    const svc = {
      getSolarWindPlasma: vi.fn().mockResolvedValue(plasmaData),
      getSolarWindMag: vi.fn().mockResolvedValue(magData),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getSolarWind.errors });
    const input = getSolarWind.input.parse({ window_hours: 3 });
    const result = await getSolarWind.handler(input, ctx);

    expect(result.plasmaCount).toBe(2);
    expect(result.magCount).toBe(2);
    expect(result.latestPlasma).not.toBeNull();
    expect(result.latestPlasma!.speedKmS).toBe(450);
    expect(result.latestMag).not.toBeNull();
  });

  it('derives bzStatus from the latest Bz reading', async () => {
    // Southward Bz driving storm conditions
    const svc = {
      getSolarWindPlasma: vi.fn().mockResolvedValue([makePlasmaReading(1)]),
      getSolarWindMag: vi.fn().mockResolvedValue([makeMagReading(1, -15)]),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getSolarWind.errors });
    const input = getSolarWind.input.parse({ window_hours: 3 });
    const result = await getSolarWind.handler(input, ctx);

    expect(result.bzStatus).toContain('-15');
    expect(result.bzStatus).toMatch(/storm-driving/i);
  });

  it('handles fill-value null fields in plasma records (sparse upstream)', async () => {
    const sparseReading: SolarWindPlasma = {
      timeTag: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      densityPerCm3: null, // fill-value omitted by service
      speedKmS: null,
      temperatureK: null,
    };
    const svc = {
      getSolarWindPlasma: vi.fn().mockResolvedValue([sparseReading]),
      getSolarWindMag: vi.fn().mockResolvedValue([]),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getSolarWind.errors });
    const input = getSolarWind.input.parse({ window_hours: 3 });
    const result = await getSolarWind.handler(input, ctx);

    expect(result.latestPlasma).not.toBeNull();
    expect(result.latestPlasma!.speedKmS).toBeNull();
    expect(result.latestPlasma!.densityPerCm3).toBeNull();
    expect(result.bzStatus).toMatch(/unavailable/i);
  });

  it('rejects window_hours out of range via Zod validation', () => {
    // window_hours is constrained to 1–168 by .min(1).max(168); Zod throws before the handler runs.
    expect(() => getSolarWind.input.parse({ window_hours: 0 })).toThrow();
    expect(() => getSolarWind.input.parse({ window_hours: 200 })).toThrow();
  });

  it('correctly windows records — service normalizes SWPC time tags to ISO 8601 UTC', async () => {
    // The service layer normalizes SWPC space-separated tags ("2026-06-05 07:01:00.000")
    // to ISO 8601 UTC ("2026-06-05T07:01:00.000Z") before the handler sees them.
    // After normalization, ISO string comparison is safe for windowing.
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);
    const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000);

    // Service returns already-normalized ISO 8601 UTC tags (the service normalizes before returning)
    const plasmaData: SolarWindPlasma[] = [
      {
        timeTag: fiveHoursAgo.toISOString(), // outside 3-hour window
        densityPerCm3: 4.0,
        speedKmS: 400,
        temperatureK: 70000,
      },
      {
        timeTag: oneHourAgo.toISOString(), // inside 3-hour window
        densityPerCm3: 5.0,
        speedKmS: 450,
        temperatureK: 80000,
      },
    ];
    const magData: SolarWindMag[] = [
      { timeTag: fiveHoursAgo.toISOString(), bxGsm: 1, byGsm: 1, bzGsm: -2, bt: 2.4 },
      { timeTag: oneHourAgo.toISOString(), bxGsm: 1, byGsm: 1, bzGsm: -8, bt: 8.1 },
    ];
    const svc = {
      getSolarWindPlasma: vi.fn().mockResolvedValue(plasmaData),
      getSolarWindMag: vi.fn().mockResolvedValue(magData),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getSolarWind.errors });
    const input = getSolarWind.input.parse({ window_hours: 3 });
    const result = await getSolarWind.handler(input, ctx);

    // Only the record within the window should be returned
    expect(result.plasmaCount).toBe(1);
    expect(result.magCount).toBe(1);
    expect(result.latestPlasma!.speedKmS).toBe(450);
    expect(result.bzStatus).toContain('-8');
  });

  it('formats output with Bz status and series', () => {
    const output = {
      plasma: [
        { timeTag: '2026-06-04T14:00:00Z', densityPerCm3: 5.2, speedKmS: 450, temperatureK: 80000 },
      ],
      mag: [{ timeTag: '2026-06-04T14:00:00Z', bxGsm: 2, byGsm: -1, bzGsm: -15, bt: 15.2 }],
      latestPlasma: {
        timeTag: '2026-06-04T14:00:00Z',
        densityPerCm3: 5.2,
        speedKmS: 450,
        temperatureK: 80000,
      },
      latestMag: { timeTag: '2026-06-04T14:00:00Z', bxGsm: 2, byGsm: -1, bzGsm: -15, bt: 15.2 },
      bzStatus: 'Southward Bz -15 nT — storm-driving conditions.',
      plasmaCount: 1,
      magCount: 1,
    };
    const blocks = getSolarWind.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Southward Bz -15');
    expect(text).toContain('450 km/s');
    expect(text).toContain('5.2 n/cm³');
    expect(text).toContain('Bz (GSM): -15 nT');
  });
});
