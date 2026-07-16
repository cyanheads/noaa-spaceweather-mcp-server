/**
 * @fileoverview Tests for the noaa_spaceweather_get_solar_wind tool.
 * @module tests/tools/get-solar-wind.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SolarWindMag, SolarWindPlasma } from '@/services/space-weather/types.js';

vi.mock('@/services/space-weather/space-weather-service.js', () => ({
  getSpaceWeatherService: vi.fn(),
}));

import { getSolarWind } from '@/mcp-server/tools/definitions/get-solar-wind.tool.js';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

const mockGetSpaceWeatherService = vi.mocked(getSpaceWeatherService);

/** The service filters to the active spacecraft, so every record it returns names one. */
const SOURCE = 'SOLAR1';

function makePlasmaReading(hoursAgo: number, speed = 450): SolarWindPlasma {
  return {
    timeTag: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
    source: SOURCE,
    densityPerCm3: 5.2,
    speedKmS: speed,
    temperatureK: 80000,
  };
}

function makeMagReading(hoursAgo: number, bz = -5): SolarWindMag {
  return {
    timeTag: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
    source: SOURCE,
    bxGsm: 2,
    byGsm: -1,
    bzGsm: bz,
    bt: Math.sqrt(bz * bz + 4 + 1),
  };
}

/** Wire the mocked service to return the given series for one handler call. */
function mockService(plasma: SolarWindPlasma[], mag: SolarWindMag[]): void {
  mockGetSpaceWeatherService.mockReturnValue({
    getSolarWindPlasma: vi.fn().mockResolvedValue(plasma),
    getSolarWindMag: vi.fn().mockResolvedValue(mag),
  } as never);
}

describe('getSolarWind', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns plasma and mag series within default 3-hour window', async () => {
    mockService(
      [
        makePlasmaReading(5), // outside default window
        makePlasmaReading(2), // inside
        makePlasmaReading(1), // inside
      ],
      [
        makeMagReading(5), // outside
        makeMagReading(2), // inside
        makeMagReading(1), // inside
      ],
    );

    const ctx = createMockContext({ errors: getSolarWind.errors });
    const input = getSolarWind.input.parse({ window_hours: 3 });
    const result = await getSolarWind.handler(input, ctx);

    expect(result.plasmaCount).toBe(2);
    expect(result.magCount).toBe(2);
    expect(result.latestPlasma).not.toBeNull();
    expect(result.latestPlasma!.speedKmS).toBe(450);
    expect(result.latestMag).not.toBeNull();

    // A populated window explains nothing — no notice.
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('reports the spacecraft the feed named rather than a hardcoded satellite', async () => {
    mockService([makePlasmaReading(1)], [makeMagReading(1)]);

    const ctx = createMockContext({ errors: getSolarWind.errors });
    const input = getSolarWind.input.parse({ window_hours: 3 });
    const result = await getSolarWind.handler(input, ctx);

    expect(result.latestPlasma!.source).toBe('SOLAR1');
    expect(result.latestMag!.source).toBe('SOLAR1');
    expect(result.plasma[0]!.source).toBe('SOLAR1');

    const text = (getSolarWind.format!(result)[0] as { text: string }).text;
    expect(text).toContain('SOLAR1');
    expect(text).not.toContain('DSCOVR');
  });

  it('derives bzStatus from the latest Bz reading', async () => {
    // Southward Bz driving storm conditions
    mockService([makePlasmaReading(1)], [makeMagReading(1, -15)]);

    const ctx = createMockContext({ errors: getSolarWind.errors });
    const input = getSolarWind.input.parse({ window_hours: 3 });
    const result = await getSolarWind.handler(input, ctx);

    expect(result.bzStatus).toContain('-15');
    expect(result.bzStatus).toMatch(/storm-driving/i);
  });

  it('handles fill-value null fields in plasma records (sparse upstream)', async () => {
    const sparseReading: SolarWindPlasma = {
      timeTag: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      source: SOURCE,
      densityPerCm3: null, // fill-value omitted by service
      speedKmS: null,
      temperatureK: null,
    };
    mockService([sparseReading], []);

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
        source: SOURCE,
        densityPerCm3: 4.0,
        speedKmS: 400,
        temperatureK: 70000,
      },
      {
        timeTag: oneHourAgo.toISOString(), // inside 3-hour window
        source: SOURCE,
        densityPerCm3: 5.0,
        speedKmS: 450,
        temperatureK: 80000,
      },
    ];
    const magData: SolarWindMag[] = [
      {
        timeTag: fiveHoursAgo.toISOString(),
        source: SOURCE,
        bxGsm: 1,
        byGsm: 1,
        bzGsm: -2,
        bt: 2.4,
      },
      { timeTag: oneHourAgo.toISOString(), source: SOURCE, bxGsm: 1, byGsm: 1, bzGsm: -8, bt: 8.1 },
    ];
    mockService(plasmaData, magData);

    const ctx = createMockContext({ errors: getSolarWind.errors });
    const input = getSolarWind.input.parse({ window_hours: 3 });
    const result = await getSolarWind.handler(input, ctx);

    // Only the record within the window should be returned
    expect(result.plasmaCount).toBe(1);
    expect(result.magCount).toBe(1);
    expect(result.latestPlasma!.speedKmS).toBe(450);
    expect(result.bzStatus).toContain('-8');
  });

  it('reports feed freshness and notices when the window is empty but the feed has older records', async () => {
    // The RTSW feed spans ~24h; a 3-hour window over a feed whose newest record is
    // 5 hours old is empty. Without freshness reporting this is indistinguishable
    // from genuinely quiet solar wind.
    const stalePlasma = makePlasmaReading(5);
    const staleMag = makeMagReading(5);
    mockService([makePlasmaReading(9), stalePlasma], [makeMagReading(9), staleMag]);

    const ctx = createMockContext({ errors: getSolarWind.errors });
    const input = getSolarWind.input.parse({ window_hours: 3 });
    const result = await getSolarWind.handler(input, ctx);

    // Window is empty...
    expect(result.plasmaCount).toBe(0);
    expect(result.magCount).toBe(0);
    expect(result.latestPlasma).toBeNull();
    expect(result.latestMag).toBeNull();

    // ...but the feed's own newest records are reported, so "quiet" is distinguishable from "stale".
    expect(result.latestFeedPlasmaTime).toBe(stalePlasma.timeTag);
    expect(result.latestFeedMagTime).toBe(staleMag.timeTag);
    expect(result.feedStalenessHours).toBeGreaterThan(4.9);
    expect(result.feedStalenessHours).toBeLessThan(5.1);

    // A single notice names both feeds' newest records (the field is last-wins).
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('plasma');
    expect(notice).toContain('magnetic field');
    expect(notice).toContain(stalePlasma.timeTag);
    expect(notice).toContain('3-hour window');

    // Freshness reaches content[] too, near the Bz status.
    const text = (getSolarWind.format!(result)[0] as { text: string }).text;
    expect(text).toContain(stalePlasma.timeTag);
    expect(text).toMatch(/Feed staleness/i);
  });

  it('says so when the feed carries no active-spacecraft records at all', async () => {
    mockService([], []);

    const ctx = createMockContext({ errors: getSolarWind.errors });
    const input = getSolarWind.input.parse({ window_hours: 3 });
    const result = await getSolarWind.handler(input, ctx);

    expect(result.latestFeedPlasmaTime).toBeNull();
    expect(result.latestFeedMagTime).toBeNull();
    expect(result.feedStalenessHours).toBeNull();

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toMatch(/no plasma readings from an active spacecraft/i);
    expect(notice).toMatch(/no magnetic field readings from an active spacecraft/i);
  });

  it('reports freshness even when the window is populated', async () => {
    mockService([makePlasmaReading(1)], [makeMagReading(1)]);

    const ctx = createMockContext({ errors: getSolarWind.errors });
    const input = getSolarWind.input.parse({ window_hours: 3 });
    const result = await getSolarWind.handler(input, ctx);

    expect(result.latestFeedPlasmaTime).not.toBeNull();
    expect(result.feedStalenessHours).toBeGreaterThan(0.9);
    expect(result.feedStalenessHours).toBeLessThan(1.1);
  });

  it('formats output with Bz status and series', () => {
    const output = {
      plasma: [
        {
          timeTag: '2026-06-04T14:00:00Z',
          source: SOURCE,
          densityPerCm3: 5.2,
          speedKmS: 450,
          temperatureK: 80000,
        },
      ],
      mag: [
        {
          timeTag: '2026-06-04T14:00:00Z',
          source: SOURCE,
          bxGsm: 2,
          byGsm: -1,
          bzGsm: -15,
          bt: 15.2,
        },
      ],
      latestPlasma: {
        timeTag: '2026-06-04T14:00:00Z',
        source: SOURCE,
        densityPerCm3: 5.2,
        speedKmS: 450,
        temperatureK: 80000,
      },
      latestMag: {
        timeTag: '2026-06-04T14:00:00Z',
        source: SOURCE,
        bxGsm: 2,
        byGsm: -1,
        bzGsm: -15,
        bt: 15.2,
      },
      bzStatus: 'Southward Bz -15 nT — storm-driving conditions.',
      plasmaCount: 1,
      magCount: 1,
      latestFeedPlasmaTime: '2026-06-04T14:00:00Z',
      latestFeedMagTime: '2026-06-04T14:00:00Z',
      feedStalenessHours: 0.5,
    };
    const blocks = getSolarWind.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Southward Bz -15');
    expect(text).toContain('450 km/s');
    expect(text).toContain('5.2 n/cm³');
    expect(text).toContain('Bz (GSM): -15 nT');
    expect(text).toContain('SOLAR1');
    expect(text).toContain('0.5 h behind real time');
  });

  it('renders a zero-hour staleness rather than dropping the line on a falsy value', () => {
    const output = {
      plasma: [],
      mag: [],
      latestPlasma: null,
      latestMag: null,
      bzStatus: 'Bz data unavailable.',
      plasmaCount: 0,
      magCount: 0,
      latestFeedPlasmaTime: '2026-06-04T14:00:00Z',
      latestFeedMagTime: '2026-06-04T14:00:00Z',
      feedStalenessHours: 0,
    };
    const text = (getSolarWind.format!(output)[0] as { text: string }).text;
    expect(text).toContain('0 h behind real time');
  });
});
