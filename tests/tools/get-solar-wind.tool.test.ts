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

/**
 * `count` plasma records at the feed's 1-minute cadence, oldest first, the
 * newest one minute ago — the shape the service hands the handler.
 */
function makePlasmaMinuteSeries(
  count: number,
  speedAt: (index: number) => number | null,
): SolarWindPlasma[] {
  const oldestMs = Date.now() - count * 60_000;
  return Array.from({ length: count }, (_, i) => ({
    timeTag: new Date(oldestMs + i * 60_000).toISOString(),
    source: SOURCE,
    densityPerCm3: 5.2,
    speedKmS: speedAt(i),
    temperatureK: 80000,
  }));
}

/** The mag counterpart of {@link makePlasmaMinuteSeries}. */
function makeMagMinuteSeries(
  count: number,
  bzAt: (index: number) => number | null,
): SolarWindMag[] {
  const oldestMs = Date.now() - count * 60_000;
  return Array.from({ length: count }, (_, i) => {
    const bz = bzAt(i);
    return {
      timeTag: new Date(oldestMs + i * 60_000).toISOString(),
      source: SOURCE,
      bxGsm: 2,
      byGsm: -1,
      bzGsm: bz,
      bt: bz === null ? null : Math.sqrt(bz * bz + 5),
    };
  });
}

/** Render a handler result through `format()` and return the text block. */
function formatText(result: Parameters<NonNullable<typeof getSolarWind.format>>[0]): string {
  return (getSolarWind.format!(result)[0] as { text: string }).text;
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

  it('returns every windowed record, newest last, one rendered line each', async () => {
    // Characterization of the unreduced contract: a window under the bound is
    // returned whole, in feed order, and each series ends on the record the
    // matching latest* field reports.
    const plasma = makePlasmaMinuteSeries(40, () => 450);
    const mag = makeMagMinuteSeries(40, (i) => -1 - (i % 4));
    mockService(plasma, mag);

    const ctx = createMockContext({ errors: getSolarWind.errors });
    const input = getSolarWind.input.parse({ window_hours: 3 });
    const result = await getSolarWind.handler(input, ctx);

    expect(result.plasmaCount).toBe(40);
    expect(result.magCount).toBe(40);
    expect(result.plasma).toEqual(plasma);
    expect(result.mag).toEqual(mag);
    expect(result.plasma.at(-1)).toEqual(result.latestPlasma);
    expect(result.mag.at(-1)).toEqual(result.latestMag);

    const text = formatText(result);
    expect(text.split('\n').filter((line) => line.includes('Bz=')).length).toBe(40);
    expect(text.split('\n').filter((line) => line.includes('speed=')).length).toBe(40);
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
      bzMinInWindow: -15,
      bzMinTimeTag: '2026-06-04T14:00:00Z',
      bzSouthMinutesInWindow: 1,
      speedMaxInWindow: 450,
      speedMaxTimeTag: '2026-06-04T14:00:00Z',
      densityMaxInWindow: 5.2,
      btMaxInWindow: 15.2,
    };
    const blocks = getSolarWind.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Southward Bz -15');
    expect(text).toContain('450 km/s');
    expect(text).toContain('5.2 n/cm³');
    expect(text).toContain('Bz (GSM): -15 nT');
    expect(text).toContain('SOLAR1');
    expect(text).toContain('0.5 h behind real time');
    expect(text).toContain('Minimum Bz in window:** -15 nT at 2026-06-04T14:00:00Z');
    expect(text).toContain('Southward Bz in window:** 1 min');
    expect(text).toContain('Maximum speed in window:** 450 km/s at 2026-06-04T14:00:00Z');
    expect(text).toContain('Maximum density in window:** 5.2 n/cm³');
    expect(text).toContain('Maximum Bt in window:** 15.2 nT');
    // Both series are present, so nothing reads as omitted.
    expect(text).not.toContain('series not included');
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
      bzMinInWindow: null,
      bzMinTimeTag: null,
      bzSouthMinutesInWindow: 0,
      speedMaxInWindow: null,
      speedMaxTimeTag: null,
      densityMaxInWindow: null,
      btMaxInWindow: null,
    };
    const text = (getSolarWind.format!(output)[0] as { text: string }).text;
    expect(text).toContain('0 h behind real time');
    expect(text).toContain('Minimum Bz in window:** N/A');
    // Every window statistic renders its null/zero branch rather than dropping the line.
    expect(text).toContain('Southward Bz in window:** 0 min');
    expect(text).toContain('Maximum speed in window:** N/A');
    expect(text).toContain('Maximum density in window:** N/A | **Maximum Bt in window:** N/A');
    // An empty window is not an omitted series.
    expect(text).not.toContain('series not included');
    expect(text).not.toMatch(/null|undefined|NaN/);
  });
});

describe('getSolarWind series resolution', () => {
  /** A record at this index is the reduction's hardest case — see the min-Bz test. */
  const EXTREME_INDEX = 301;
  const EXTREME_BZ = -18.4;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('bounds each series to 200 real records and keeps the newest record last', async () => {
    const plasma = makePlasmaMinuteSeries(600, (i) => 400 + (i % 7));
    const mag = makeMagMinuteSeries(600, (i) => -1 - (i % 5));
    mockService(plasma, mag);

    const ctx = createMockContext({ errors: getSolarWind.errors });
    const input = getSolarWind.input.parse({ window_hours: 24 });
    const result = await getSolarWind.handler(input, ctx);

    expect(result.magCount).toBe(result.mag.length);
    expect(result.plasmaCount).toBe(result.plasma.length);
    expect(result.mag.length).toBeLessThanOrEqual(200);
    expect(result.plasma.length).toBeLessThanOrEqual(200);
    expect(result.mag.length).toBeLessThan(600);

    // Every emitted record is a real upstream record, not a synthesized average.
    const magByTag = new Map(mag.map((r) => [r.timeTag, r]));
    for (const emitted of result.mag) expect(emitted).toEqual(magByTag.get(emitted.timeTag));
    const plasmaByTag = new Map(plasma.map((r) => [r.timeTag, r]));
    for (const emitted of result.plasma) expect(emitted).toEqual(plasmaByTag.get(emitted.timeTag));

    // Oldest-first is preserved, and the tail is the newest windowed record.
    const tags = result.mag.map((r) => Date.parse(r.timeTag));
    expect(tags).toEqual([...tags].sort((a, b) => a - b));
    expect(result.mag.at(-1)).toEqual(result.latestMag);
    expect(result.mag.at(-1)!.timeTag).toBe(mag.at(-1)!.timeTag);
    expect(result.plasma.at(-1)).toEqual(result.latestPlasma);

    // Per-series reduction reporting, in one notice alongside the existing array.
    const enrichment = getEnrichment(ctx);
    expect(enrichment.magWindowRecords).toBe(600);
    expect(enrichment.plasmaWindowRecords).toBe(600);
    expect(enrichment.magBucketRecords).toBeGreaterThan(1);
    expect(enrichment.plasmaBucketRecords).toBeGreaterThan(1);
    expect(enrichment.notice).toMatch(/resolution/i);
    expect(enrichment.notice).toContain('plasma');
    expect(enrichment.notice).toContain('magnetic field');
  });

  it('reports the full-window minimum Bz and emits that record even between samples', async () => {
    // The extreme sits inside a bucket rather than on its leading edge, so a raw
    // index stride steps over it — the case the per-bucket minimum exists for.
    const plasma = makePlasmaMinuteSeries(600, (i) => 400 + (i % 7));
    const mag = makeMagMinuteSeries(600, (i) => (i === EXTREME_INDEX ? EXTREME_BZ : -1 - (i % 5)));
    mockService(plasma, mag);

    const ctx = createMockContext({ errors: getSolarWind.errors });
    const input = getSolarWind.input.parse({ window_hours: 24 });
    const result = await getSolarWind.handler(input, ctx);

    expect(result.bzMinInWindow).toBe(EXTREME_BZ);
    expect(result.bzMinTimeTag).toBe(mag[EXTREME_INDEX]!.timeTag);

    // A stride starting at each bucket's first record would have missed it.
    const bucketRecords = getEnrichment(ctx).magBucketRecords as number;
    expect(bucketRecords).toBeGreaterThan(1);
    expect(EXTREME_INDEX % bucketRecords).not.toBe(0);

    // The emitted series itself carries the extreme record, not just the summary.
    expect(result.mag.map((r) => r.timeTag)).toContain(mag[EXTREME_INDEX]!.timeTag);
    const emittedMin = Math.min(...result.mag.map((r) => r.bzGsm ?? Number.POSITIVE_INFINITY));
    expect(emittedMin).toBe(EXTREME_BZ);

    const text = formatText(result);
    expect(text).toContain(`Minimum Bz in window:** ${EXTREME_BZ} nT at ${result.bzMinTimeTag}`);
    expect(text).toContain(`Bz=${EXTREME_BZ} nT`);
  });

  it('returns every record and no reduction reporting at full resolution', async () => {
    const plasma = makePlasmaMinuteSeries(600, (i) => 400 + (i % 7));
    const mag = makeMagMinuteSeries(600, (i) => (i === EXTREME_INDEX ? EXTREME_BZ : -1 - (i % 5)));
    mockService(plasma, mag);

    const ctx = createMockContext({ errors: getSolarWind.errors });
    const input = getSolarWind.input.parse({ window_hours: 24, resolution: 'full' });
    const result = await getSolarWind.handler(input, ctx);

    expect(result.plasmaCount).toBe(600);
    expect(result.magCount).toBe(600);
    expect(result.plasma).toEqual(plasma);
    expect(result.mag).toEqual(mag);
    expect(result.bzMinInWindow).toBe(EXTREME_BZ);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeUndefined();
    expect(enrichment.magBucketRecords).toBeUndefined();
    expect(enrichment.magWindowRecords).toBeUndefined();
  });

  it('derives the headline fields identically with and without reduction', async () => {
    const plasma = makePlasmaMinuteSeries(600, (i) => 400 + (i % 7));
    const mag = makeMagMinuteSeries(600, (i) => (i === EXTREME_INDEX ? EXTREME_BZ : -1 - (i % 5)));
    mockService(plasma, mag);

    const reduced = await getSolarWind.handler(
      getSolarWind.input.parse({ window_hours: 24 }),
      createMockContext({ errors: getSolarWind.errors }),
    );
    const full = await getSolarWind.handler(
      getSolarWind.input.parse({ window_hours: 24, resolution: 'full' }),
      createMockContext({ errors: getSolarWind.errors }),
    );

    expect(reduced.latestPlasma).toEqual(full.latestPlasma);
    expect(reduced.latestMag).toEqual(full.latestMag);
    expect(reduced.bzStatus).toBe(full.bzStatus);
    expect(reduced.bzMinInWindow).toBe(full.bzMinInWindow);
    expect(reduced.bzMinTimeTag).toBe(full.bzMinTimeTag);
    expect(reduced.latestFeedPlasmaTime).toBe(full.latestFeedPlasmaTime);
    expect(reduced.latestFeedMagTime).toBe(full.latestFeedMagTime);
  });

  it('is byte-identical to full resolution when the window is inside the bound', async () => {
    // 150 minute-cadence records sit under the 200-record bound, so the default
    // call must reduce nothing — no rewritten series and no enrichment trailer.
    const plasma = makePlasmaMinuteSeries(150, (i) => 400 + (i % 7));
    const mag = makeMagMinuteSeries(150, (i) => -1 - (i % 5));
    mockService(plasma, mag);

    const reducedCtx = createMockContext({ errors: getSolarWind.errors });
    const reduced = await getSolarWind.handler(
      getSolarWind.input.parse({ window_hours: 3 }),
      reducedCtx,
    );
    const full = await getSolarWind.handler(
      getSolarWind.input.parse({ window_hours: 3, resolution: 'full' }),
      createMockContext({ errors: getSolarWind.errors }),
    );

    expect(JSON.stringify(reduced)).toBe(JSON.stringify(full));
    expect(formatText(reduced)).toBe(formatText(full));
    expect(reduced.magCount).toBe(150);

    const enrichment = getEnrichment(reducedCtx);
    expect(enrichment.notice).toBeUndefined();
    expect(enrichment.magBucketRecords).toBeUndefined();
    expect(enrichment.plasmaBucketRecords).toBeUndefined();
    expect(enrichment.magWindowRecords).toBeUndefined();
    expect(enrichment.plasmaWindowRecords).toBeUndefined();
  });

  it('reduces one record past the bound and leaves the bound itself untouched', async () => {
    const atBound = makeMagMinuteSeries(200, (i) => -1 - (i % 5));
    mockService(
      makePlasmaMinuteSeries(200, () => 450),
      atBound,
    );

    const atBoundCtx = createMockContext({ errors: getSolarWind.errors });
    const atBoundResult = await getSolarWind.handler(
      getSolarWind.input.parse({ window_hours: 24 }),
      atBoundCtx,
    );
    expect(atBoundResult.magCount).toBe(200);
    expect(atBoundResult.mag).toEqual(atBound);
    expect(getEnrichment(atBoundCtx).magBucketRecords).toBeUndefined();

    const pastBound = makeMagMinuteSeries(201, (i) => -1 - (i % 5));
    mockService(
      makePlasmaMinuteSeries(201, () => 450),
      pastBound,
    );

    const pastBoundCtx = createMockContext({ errors: getSolarWind.errors });
    const pastBoundResult = await getSolarWind.handler(
      getSolarWind.input.parse({ window_hours: 24 }),
      pastBoundCtx,
    );
    expect(pastBoundResult.magCount).toBeLessThan(201);
    expect(pastBoundResult.magCount).toBeLessThanOrEqual(200);
    expect(pastBoundResult.mag.at(-1)!.timeTag).toBe(pastBound.at(-1)!.timeTag);
    // Both series are one past the bound here, so both report the same reduction.
    expect(getEnrichment(pastBoundCtx).magWindowRecords).toBe(201);
    expect(getEnrichment(pastBoundCtx).magBucketRecords).toBe(2);
    expect(getEnrichment(pastBoundCtx).plasmaWindowRecords).toBe(201);
    expect(getEnrichment(pastBoundCtx).plasmaBucketRecords).toBe(2);
  });

  it('reduces each series on its own length and reports a bucket of one for the untouched one', async () => {
    // The live feeds disagree on length (1,399 plasma vs 1,417 mag on one call), so
    // each series carries its own factor — and one can cross the bound while the
    // other does not.
    const plasma = makePlasmaMinuteSeries(150, () => 450);
    const mag = makeMagMinuteSeries(600, (i) => -1 - (i % 5));
    mockService(plasma, mag);

    const ctx = createMockContext({ errors: getSolarWind.errors });
    const result = await getSolarWind.handler(getSolarWind.input.parse({ window_hours: 24 }), ctx);

    // The short series is returned whole; the long one is bounded.
    expect(result.plasma).toEqual(plasma);
    expect(result.plasmaCount).toBe(150);
    expect(result.magCount).toBeLessThanOrEqual(200);
    expect(result.magCount).toBeLessThan(600);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.plasmaBucketRecords).toBe(1);
    expect(enrichment.plasmaWindowRecords).toBe(150);
    expect(enrichment.magWindowRecords).toBe(600);

    // The reported bucket size is the real one: 599 older records over at most 199
    // buckets is 4 records each, and the notice states that number rather than an
    // effective ratio derived from the emitted count.
    const bucketRecords = enrichment.magBucketRecords as number;
    expect(bucketRecords).toBe(4);
    expect(result.magCount).toBe(Math.ceil(599 / bucketRecords) + 1);
    const notice = enrichment.notice as string;
    expect(notice).toContain(`magnetic field 600 → ${result.magCount} records (one per 4)`);
    // Only the reduced series is named — the untouched one has nothing to report.
    expect(notice).not.toContain('plasma 150');
  });

  it('nulls the minimum Bz when every reading in the window is null', async () => {
    const mag = makeMagMinuteSeries(300, () => null);
    mockService(
      makePlasmaMinuteSeries(300, () => 450),
      mag,
    );

    const ctx = createMockContext({ errors: getSolarWind.errors });
    const result = await getSolarWind.handler(getSolarWind.input.parse({ window_hours: 24 }), ctx);

    expect(result.bzMinInWindow).toBeNull();
    expect(result.bzMinTimeTag).toBeNull();
    expect(result.bzStatus).toMatch(/unavailable/i);
    // Reduction still emits real records from an all-null bucket.
    expect(result.magCount).toBeLessThanOrEqual(200);
    const magByTag = new Map(mag.map((r) => [r.timeTag, r]));
    for (const emitted of result.mag) expect(emitted).toEqual(magByTag.get(emitted.timeTag));
    expect(result.mag.at(-1)).toEqual(result.latestMag);
    expect(formatText(result)).toContain('Minimum Bz in window:** N/A');
  });

  it('nulls the minimum Bz on an empty window and still renders the line', async () => {
    mockService([makePlasmaReading(9)], [makeMagReading(9)]);

    const ctx = createMockContext({ errors: getSolarWind.errors });
    const result = await getSolarWind.handler(getSolarWind.input.parse({ window_hours: 3 }), ctx);

    expect(result.magCount).toBe(0);
    expect(result.bzMinInWindow).toBeNull();
    expect(result.bzMinTimeTag).toBeNull();
    expect(formatText(result)).toContain('Minimum Bz in window:** N/A');
    // The empty-window advisory is unchanged when nothing was reduced.
    expect(getEnrichment(ctx).notice).not.toMatch(/resolution/i);
  });

  it('rejects a resolution outside the declared enum and defaults to reduced', () => {
    expect(getSolarWind.input.parse({}).resolution).toBe('reduced');
    expect(getSolarWind.input.parse({ window_hours: 3 }).resolution).toBe('reduced');
    expect(getSolarWind.input.parse({ resolution: 'summary' }).resolution).toBe('summary');
    expect(() => getSolarWind.input.parse({ resolution: 'coarse' })).toThrow();
    expect(() => getSolarWind.input.parse({ resolution: 'Summary' })).toThrow();
    expect(() => getSolarWind.input.parse({ resolution: '' })).toThrow();
    expect(() => getSolarWind.input.parse({ resolution: 200 })).toThrow();
  });
});

describe('getSolarWind resolution="summary" and window statistics (#38)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /** Every field `summary` must report identically to the series-carrying resolutions. */
  const HEADLINE_FIELDS = [
    'latestPlasma',
    'latestMag',
    'bzStatus',
    'bzMinInWindow',
    'bzMinTimeTag',
    'bzSouthMinutesInWindow',
    'speedMaxInWindow',
    'speedMaxTimeTag',
    'densityMaxInWindow',
    'btMaxInWindow',
    'latestFeedPlasmaTime',
    'latestFeedMagTime',
  ] as const;

  /** Index of the lone window extreme on each channel — mid-bucket under a reduction. */
  const PEAK_INDEX = 301;

  /**
   * A 600-record window whose every extreme sits on one record inside a bucket, with
   * a southward run, a null reading, and ordinary values around it.
   */
  function makeStormWindow() {
    const plasma = makePlasmaMinuteSeries(600, (i) => (i === PEAK_INDEX ? 812.4 : 400 + (i % 7)));
    plasma[PEAK_INDEX] = { ...plasma[PEAK_INDEX]!, densityPerCm3: 31.5 };
    plasma[10] = { ...plasma[10]!, speedKmS: null, densityPerCm3: null };
    const mag = makeMagMinuteSeries(600, (i) =>
      i === PEAK_INDEX ? -22.1 : i >= 500 && i < 540 ? -3 : i === 20 ? null : 2,
    );
    return { plasma, mag };
  }

  async function run(input: Record<string, unknown>) {
    const ctx = createMockContext({ errors: getSolarWind.errors });
    const result = await getSolarWind.handler(getSolarWind.input.parse(input), ctx);
    return { ctx, result };
  }

  it('returns empty series and every headline field identical to reduced and full', async () => {
    const { plasma, mag } = makeStormWindow();
    mockService(plasma, mag);

    const summary = await run({ window_hours: 24, resolution: 'summary' });
    const reduced = await run({ window_hours: 24, resolution: 'reduced' });
    const full = await run({ window_hours: 24, resolution: 'full' });

    expect(summary.result.plasma).toEqual([]);
    expect(summary.result.mag).toEqual([]);
    for (const field of HEADLINE_FIELDS) {
      expect(summary.result[field], field).toEqual(full.result[field]);
      expect(reduced.result[field], field).toEqual(full.result[field]);
    }
    expect(getSolarWind.output.parse(summary.result)).toEqual(summary.result);
  });

  it('computes the window extremes from every record, not from the emitted buckets', async () => {
    const { plasma, mag } = makeStormWindow();
    mockService(plasma, mag);

    const { ctx, result } = await run({ window_hours: 24, resolution: 'reduced' });

    // The peaks sit mid-bucket, so a stride over the buckets' leading records misses them.
    const plasmaBucket = getEnrichment(ctx).plasmaBucketRecords as number;
    expect(plasmaBucket).toBeGreaterThan(1);
    expect(PEAK_INDEX % plasmaBucket).not.toBe(0);
    expect(result.speedMaxInWindow).toBe(812.4);
    expect(result.speedMaxTimeTag).toBe(plasma[PEAK_INDEX]!.timeTag);
    expect(result.densityMaxInWindow).toBe(31.5);
    expect(result.btMaxInWindow).toBe(Math.sqrt(22.1 * 22.1 + 5));
    // 40 minutes of the -3 nT run plus the single -22.1 nT record.
    expect(result.bzSouthMinutesInWindow).toBe(41);
  });

  it('reports the true window record counts under summary, not the empty arrays', async () => {
    const { plasma, mag } = makeStormWindow();
    mockService(plasma, mag.slice(0, 590));

    const { ctx, result } = await run({ window_hours: 24, resolution: 'summary' });

    expect(result.plasmaCount).toBe(600);
    expect(result.magCount).toBe(590);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.plasmaWindowRecords).toBe(600);
    expect(enrichment.magWindowRecords).toBe(590);
    // No bucketing ran, so no bucket size is claimed.
    expect(enrichment.plasmaBucketRecords).toBeUndefined();
    expect(enrichment.magBucketRecords).toBeUndefined();
    expect(enrichment.notice).toContain('resolution="summary"');
    expect(enrichment.notice).toContain('600 plasma and 590 magnetic field records');
    expect(enrichment.notice).not.toMatch(/bounded to/);
  });

  it('counts southward minutes by record, adding nothing across a gap in a southward run', async () => {
    // Minutes 0–4 and 8–11 are southward; the feed skipped 5–7 mid-run, then Bz turned
    // north. A wall-clock span would claim 12 southward minutes; the records show 9.
    const baseMs = Date.now() - 30 * 60_000;
    const minutes = [0, 1, 2, 3, 4, 8, 9, 10, 11, 12, 13, 14];
    const mag: SolarWindMag[] = minutes.map((minute) => {
      const bz = minute <= 11 ? -4 : 3;
      return {
        timeTag: new Date(baseMs + minute * 60_000).toISOString(),
        source: SOURCE,
        bxGsm: 1,
        byGsm: 1,
        bzGsm: bz,
        bt: 5,
      };
    });
    // A null Bz inside the run is a missing reading, not a southward minute.
    mag.splice(3, 0, {
      ...mag[2]!,
      timeTag: new Date(baseMs + 3.5 * 60_000).toISOString(),
      bzGsm: null,
    });
    mockService([], mag);

    for (const resolution of ['summary', 'reduced', 'full']) {
      const { result } = await run({ window_hours: 1, resolution });
      expect(result.bzSouthMinutesInWindow, resolution).toBe(9);
    }
  });

  it('reports nulls and zero on an empty window, an all-null window, and a northward one', async () => {
    mockService([makePlasmaReading(9)], [makeMagReading(9)]);
    const empty = await run({ window_hours: 3, resolution: 'summary' });
    expect(empty.result).toMatchObject({
      plasmaCount: 0,
      magCount: 0,
      bzSouthMinutesInWindow: 0,
      speedMaxInWindow: null,
      speedMaxTimeTag: null,
      densityMaxInWindow: null,
      btMaxInWindow: null,
    });

    mockService(
      makePlasmaMinuteSeries(30, () => null).map((r) => ({ ...r, densityPerCm3: null })),
      makeMagMinuteSeries(30, () => null),
    );
    const allNull = await run({ window_hours: 3, resolution: 'summary' });
    expect(allNull.result).toMatchObject({
      plasmaCount: 30,
      magCount: 30,
      bzSouthMinutesInWindow: 0,
      speedMaxInWindow: null,
      speedMaxTimeTag: null,
      densityMaxInWindow: null,
      btMaxInWindow: null,
    });

    mockService(
      makePlasmaMinuteSeries(30, () => 420),
      makeMagMinuteSeries(30, () => 4),
    );
    const northward = await run({ window_hours: 3, resolution: 'summary' });
    expect(northward.result.bzSouthMinutesInWindow).toBe(0);
    expect(northward.result.speedMaxInWindow).toBe(420);
  });

  it('renders every headline field and the omitted series in content[]', async () => {
    const { plasma, mag } = makeStormWindow();
    mockService(plasma, mag);

    const { result } = await run({ window_hours: 24, resolution: 'summary' });
    const text = formatText(result);

    expect(text).toContain(`Minimum Bz in window:** -22.1 nT at ${mag[PEAK_INDEX]!.timeTag}`);
    expect(text).toContain('Southward Bz in window:** 41 min');
    expect(text).toContain(
      `Maximum speed in window:** 812.4 km/s at ${plasma[PEAK_INDEX]!.timeTag}`,
    );
    expect(text).toContain('Maximum density in window:** 31.5 n/cm³');
    expect(text).toContain(`Maximum Bt in window:** ${Math.sqrt(22.1 * 22.1 + 5)} nT`);
    expect(text).toContain(
      '**Plasma readings:** 600 | **Mag readings:** 600 — in the window; series not included',
    );
    expect(text).toContain('### Latest Plasma');
    expect(text).toContain('### Latest Magnetic Field');
    expect(text).not.toContain('Time Series');
  });

  it('stays at the headline size whatever the window, and far under the reduced response', async () => {
    // A full live-feed day: ~1,400 records per series.
    const plasma = makePlasmaMinuteSeries(1_400, (i) => 400 + (i % 97));
    const mag = makeMagMinuteSeries(1_400, (i) => -5 + (i % 11));
    mockService(plasma, mag);

    const oneHour = await run({ window_hours: 1, resolution: 'summary' });
    const week = await run({ window_hours: 168, resolution: 'summary' });
    const reducedWeek = await run({ window_hours: 168, resolution: 'reduced' });

    const bytes = (value: unknown) => JSON.stringify(value).length;
    expect(bytes(oneHour.result)).toBeLessThan(2_000);
    expect(bytes(week.result)).toBeLessThan(2_000);
    // The two differ only in the digits of their counts and extremes' time tags.
    expect(Math.abs(bytes(week.result) - bytes(oneHour.result))).toBeLessThan(100);
    expect(bytes(reducedWeek.result)).toBeGreaterThan(20 * bytes(week.result));
    expect(formatText(week.result).length).toBeLessThan(2_500);
  });
});
