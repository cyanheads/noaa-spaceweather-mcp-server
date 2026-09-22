/**
 * @fileoverview Tests for the noaa_spaceweather_get_solar_activity tool.
 * @module tests/tools/get-solar-activity.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  F107Observation,
  ProtonFlux,
  SolarProbabilities,
  SolarRegion,
  XrayFlare,
  XrayFlux,
} from '@/services/space-weather/types.js';
import { PUBLISHED_FLARE_CLASSES } from '../fixtures/swpc-xray-flares.js';

vi.mock('@/services/space-weather/space-weather-service.js', () => ({
  getSpaceWeatherService: vi.fn(),
}));

import { getSolarActivity } from '@/mcp-server/tools/definitions/get-solar-activity.tool.js';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

const mockGetSpaceWeatherService = vi.mocked(getSpaceWeatherService);

/**
 * Service double with all six composed feeds stubbed empty. Each case overrides
 * only the feeds it cares about, so a new feed on the handler doesn't have to be
 * threaded through every existing setup.
 */
function makeSvc(overrides: Record<string, unknown> = {}) {
  return {
    getXrayFlux: vi.fn().mockResolvedValue([]),
    getXrayFlares: vi.fn().mockResolvedValue([]),
    getF107: vi.fn().mockResolvedValue(null),
    getSolarProbabilities: vi.fn().mockResolvedValue([]),
    getProtonFlux: vi.fn().mockResolvedValue([]),
    getSolarRegions: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

/** Install a service double and return it for call assertions. */
function useSvc(overrides: Record<string, unknown> = {}) {
  const svc = makeSvc(overrides);
  mockGetSpaceWeatherService.mockReturnValue(svc as never);
  return svc;
}

function makeXrayReading(hoursAgo: number, flux = 1e-6): XrayFlux {
  return {
    timeTag: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
    satellite: 18,
    fluxWm2: flux,
    energy: '0.1-0.8nm',
  };
}

function makeProtonReading(flux: number): ProtonFlux {
  return {
    timeTag: new Date().toISOString(),
    satellite: 18,
    fluxPfu: flux,
    energy: '>=10 MeV',
  };
}

/** One flare event whose onset sits `hoursAgo` in the past. */
function makeFlare(hoursAgo: number, overrides: Partial<XrayFlare> = {}): XrayFlare {
  const begin = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
  return {
    beginTime: begin,
    maxTime: begin,
    endTime: begin,
    beginClass: 'B2.0',
    maxClass: 'B4.0',
    endClass: 'B2.5',
    peakFluxWm2: 4e-7,
    satellite: 18,
    ...overrides,
  };
}

const mockF107: F107Observation = {
  observedTime: '2026-09-16T20:00:00Z',
  fluxSfu: 100,
  ninetyDayMeanSfu: 126,
  reportingSchedule: 'Noon',
};

const mockProbabilities: SolarProbabilities[] = [
  {
    date: '2026-06-04',
    cClass1Day: 55,
    cClassProbability: 55,
    mClass1Day: 20,
    mClassProbability: 20,
    xClass1Day: 5,
    xClassProbability: 5,
    protons1Day: 5,
    protonEventProbability: 5,
  },
  {
    date: '2026-06-05',
    cClass1Day: 50,
    cClassProbability: 50,
    mClass1Day: 15,
    mClassProbability: 15,
    xClass1Day: 3,
    xClassProbability: 3,
    protons1Day: 3,
    protonEventProbability: 3,
  },
];

const mockRegion: SolarRegion = {
  region: 3782,
  latitude: 'N17',
  location: 'N17E47',
  spotClass: 'Ekc',
  numberSpots: 12,
  magClass: 'Beta-Gamma',
  areaMillionths: 480,
  firstObserved: '2026-05-29T07:15:15Z',
  cFlareCount: 3,
  mFlareCount: 1,
  xFlareCount: 0,
  cFlareProbability: 65,
  mFlareProbability: 30,
  xFlareProbability: 10,
  protonProbability: 5,
  observedDate: '2026-06-04',
};

/** A spotless region (plage) as the service maps it: every morphology field emptied. */
const spotlessRegion: SolarRegion = {
  region: 3780,
  latitude: 'S07',
  location: 'S07W82',
  spotClass: '',
  numberSpots: 0,
  magClass: '',
  areaMillionths: null,
  firstObserved: '2026-05-31T17:49:08Z',
  cFlareCount: 0,
  mFlareCount: 0,
  xFlareCount: 0,
  cFlareProbability: 1,
  mFlareProbability: 1,
  xFlareProbability: 1,
  protonProbability: 1,
  observedDate: '2026-06-04',
};

describe('getSolarActivity', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    // Restore real timers after the fake-timer boundary test (#17).
    vi.useRealTimers();
  });

  it('returns flare classification and S-scale for normal conditions', async () => {
    useSvc({
      getXrayFlux: vi.fn().mockResolvedValue([makeXrayReading(0.5, 1e-6)]), // C-class flux
      getSolarProbabilities: vi.fn().mockResolvedValue(mockProbabilities),
      getProtonFlux: vi.fn().mockResolvedValue([makeProtonReading(1)]), // S0 — below threshold
      getSolarRegions: vi.fn().mockResolvedValue([mockRegion]),
    });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const input = getSolarActivity.input.parse({ include_regions: true });
    const result = await getSolarActivity.handler(input, ctx);

    expect(result.latestXray).not.toBeNull();
    expect(result.latestXray!.flareClass).toBe('C');
    // fluxWm2 is now a formatted string in scientific notation (e.g. "1.0e-6 W/m²")
    expect(result.latestXray!.fluxWm2).toMatch(/e[-+]\d/);
    expect(result.latestXray!.fluxWm2).toContain('W/m²');
    expect(result.sScale).toBe(0);
    expect(result.sScaleText).toContain('No radiation storm');
    expect(result.activeRegions).toHaveLength(1);
    expect(result.activeRegions[0]!.region).toBe(3782);
    expect(result.probabilities).toHaveLength(2);
  });

  it('classifies X-class flare correctly (flux >= 1e-4)', async () => {
    useSvc({
      getXrayFlux: vi.fn().mockResolvedValue([makeXrayReading(0.1, 1.2e-4)]), // X1.2
    });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const input = getSolarActivity.input.parse({});
    const result = await getSolarActivity.handler(input, ctx);

    expect(result.latestXray!.flareClass).toBe('X');
  });

  it('derives S2 radiation storm from proton flux of 150 pfu', async () => {
    useSvc({
      getXrayFlux: vi.fn().mockResolvedValue([makeXrayReading(0.5, 1e-7)]),
      getProtonFlux: vi.fn().mockResolvedValue([makeProtonReading(150)]), // S2 range
    });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const input = getSolarActivity.input.parse({});
    const result = await getSolarActivity.handler(input, ctx);

    expect(result.sScale).toBe(2);
    expect(result.sScaleText).toContain('S2');
    expect(result.latestProton!.sScale).toBe(2);
    expect(result.latestProton!.fluxPfu).toBe(150);
  });

  it('skips solar regions when include_regions=false', async () => {
    const svc = useSvc({
      getXrayFlux: vi.fn().mockResolvedValue([makeXrayReading(0.5)]),
      getSolarProbabilities: vi.fn().mockResolvedValue(mockProbabilities),
      getProtonFlux: vi.fn().mockResolvedValue([makeProtonReading(0.1)]),
      getSolarRegions: vi.fn().mockResolvedValue([mockRegion]),
    });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const input = getSolarActivity.input.parse({ include_regions: false });
    const result = await getSolarActivity.handler(input, ctx);

    expect(result.activeRegions).toHaveLength(0);
    // getSolarRegions should NOT have been called
    expect(svc.getSolarRegions).not.toHaveBeenCalled();
  });

  it('handles empty feeds (null latestXray and latestProton)', async () => {
    useSvc();

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const input = getSolarActivity.input.parse({});
    const result = await getSolarActivity.handler(input, ctx);

    expect(result.latestXray).toBeNull();
    expect(result.latestProton).toBeNull();
    expect(result.sScale).toBe(0);
    expect(result.recentXray).toHaveLength(0);
  });

  it('formats output with flare class, S-scale, and region details', () => {
    const output = {
      latestXray: {
        timeTag: '2026-06-04T14:00:00Z',
        fluxWm2: '1.2e-4 W/m²',
        fluxWm2Value: 1.2e-4,
        flareClass: 'X',
        flareClassFull: 'X1.2',
        satellite: 18,
      },
      recentXray: [
        {
          timeTag: '2026-06-04T14:00:00Z',
          fluxWm2: '1.2e-4 W/m²',
          fluxWm2Value: 1.2e-4,
          flareClass: 'X',
          flareClassFull: 'X1.2',
          satellite: 18,
        },
      ],
      recentFlares: [
        {
          beginTime: '2026-06-04T13:50:00Z',
          maxTime: '2026-06-04T14:00:00Z',
          endTime: '2026-06-04T14:12:00Z',
          beginClass: 'M8.0',
          maxClass: 'X1.2',
          endClass: 'M5.0',
          peakFluxWm2: 1.2e-4,
          rScale: 3,
          satellite: 18,
        },
      ],
      f107: {
        observedTime: '2026-06-03T20:00:00Z',
        fluxSfu: 143,
        ninetyDayMeanSfu: 126,
        reportingSchedule: 'Noon',
      },
      probabilities: [
        {
          date: '2026-06-04',
          cClass1Day: 55,
          cClassProbability: 55,
          mClass1Day: 20,
          mClassProbability: 20,
          xClass1Day: 5,
          xClassProbability: 5,
          protons1Day: 5,
          protonEventProbability: 5,
        },
      ],
      latestProton: {
        timeTag: '2026-06-04T14:00:00Z',
        fluxPfu: 150,
        sScale: 2,
        energy: '>=10 MeV',
      },
      sScale: 2,
      sScaleText: 'S2 moderate radiation storm',
      activeRegions: [
        {
          region: 3782,
          location: 'N17E47',
          latitude: 'N17',
          spotClass: 'Ekc',
          numberSpots: 12,
          magClass: 'Beta-Gamma',
          areaMillionths: 480,
          firstObserved: '2026-05-29T07:15:15Z',
          cFlareCount: 3,
          mFlareCount: 1,
          xFlareCount: 0,
          cFlareProbability: 65,
          mFlareProbability: 30,
          xFlareProbability: 10,
          protonProbability: 5,
          observedDate: '2026-06-04',
        },
      ],
      fetchedAt: '2026-06-04T15:00:00.000Z',
    };
    const blocks = getSolarActivity.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('S2 moderate radiation storm');
    expect(text).toContain('X class');
    expect(text).toContain('150 pfu');
    expect(text).toContain('AR3782');
    expect(text).toContain('N17E47');
    expect(text).toContain('C=65%');
    // Every new field reaches content[] alongside structuredContent.
    expect(text).toContain('X1.2');
    expect(text).toContain('M8.0');
    expect(text).toContain('M5.0');
    expect(text).toContain('R3');
    expect(text).toContain('2026-06-04T13:50:00Z');
    expect(text).toContain('2026-06-04T14:12:00Z');
    expect(text).toContain('143 sfu');
    expect(text).toContain('126 sfu');
    expect(text).toContain('Noon');
    expect(text).toContain('2026-06-03T20:00:00Z');
    // The region's morphology line, rendered verbatim.
    expect(text).toContain('  Class: Ekc/Beta-Gamma | Spots: 12');
  });

  it('formats X-ray flux as scientific notation in content[] (issue #4)', async () => {
    // Verify the handler produces formatted strings in structuredContent.
    useSvc({
      getXrayFlux: vi.fn().mockResolvedValue([
        makeXrayReading(0.5, 9.167114285446587e-7), // B-class
        makeXrayReading(0.25, 0.0000013899084478907753), // C-class
      ]),
    });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const input = getSolarActivity.input.parse({});
    const result = await getSolarActivity.handler(input, ctx);

    // fluxWm2 must be formatted scientific notation, NOT raw full-precision float
    expect(result.latestXray!.fluxWm2).not.toMatch(/\d{10}/); // no 10+ digit precision
    expect(result.latestXray!.fluxWm2).toMatch(/^\d+\.\d+e[-+]\d+ W\/m²$/);

    const blocks = getSolarActivity.format!(result);
    const text = (blocks[0] as { text: string }).text;
    // format() just renders the pre-formatted string — no raw floats
    expect(text).not.toContain('9.167114285446587e-7 W/m²');
    expect(text).not.toContain('0.0000013899084478907753 W/m²');
    // Scientific notation with 2 significant digits appears in content[]
    expect(text).toContain('W/m²');
  });

  it('rounds proton flux to 3 significant figures, not a raw float (issue #8)', async () => {
    useSvc({
      // Full-precision IEEE-754 value as returned raw by the GOES feed.
      getProtonFlux: vi.fn().mockResolvedValue([makeProtonReading(0.2243340015411377)]),
    });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const input = getSolarActivity.input.parse({});
    const result = await getSolarActivity.handler(input, ctx);

    // fluxPfu stays a number, rounded to 3 sig figs — not the raw 16-digit float.
    expect(result.latestProton!.fluxPfu).toBe(0.224);
    expect(typeof result.latestProton!.fluxPfu).toBe('number');

    // The full-precision float must not leak into the rendered content[].
    const text = (getSolarActivity.format!(result)[0] as { text: string }).text;
    expect(text).not.toContain('0.2243340015411377');
    expect(text).toContain('0.224 pfu');
  });

  it('rounds large proton flux to 3 significant figures without scientific notation (issue #8)', async () => {
    useSvc({
      getProtonFlux: vi.fn().mockResolvedValue([makeProtonReading(1234.5678)]), // S3 range (≥1000)
    });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const input = getSolarActivity.input.parse({});
    const result = await getSolarActivity.handler(input, ctx);

    // toPrecision(3) on a large value rounds the magnitude but stays a plain number.
    expect(result.latestProton!.fluxPfu).toBe(1230);
    // S-scale is classified from the raw value, unaffected by display rounding.
    expect(result.latestProton!.sScale).toBe(3);
  });

  it('exposes date-neutral probability aliases alongside the *1Day fields (#16)', async () => {
    useSvc({
      getSolarProbabilities: vi.fn().mockResolvedValue(mockProbabilities),
    });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const input = getSolarActivity.input.parse({});
    const result = await getSolarActivity.handler(input, ctx);

    expect(result.probabilities).toHaveLength(mockProbabilities.length);
    for (const p of result.probabilities) {
      // date-neutral aliases mirror the legacy *1Day values
      expect(p.cClassProbability).toBe(p.cClass1Day);
      expect(p.mClassProbability).toBe(p.mClass1Day);
      expect(p.xClassProbability).toBe(p.xClass1Day);
      expect(p.protonEventProbability).toBe(p.protons1Day);
      // legacy fields still present (additive, non-breaking)
      expect(typeof p.cClass1Day).toBe('number');
      expect(typeof p.protons1Day).toBe('number');
    }
    // concrete values flow through from the fixture
    expect(result.probabilities[0]!.cClassProbability).toBe(55);
    expect(result.probabilities[0]!.protonEventProbability).toBe(5);
  });

  it('excludes an X-ray reading whose true time is just before the past-hour cutoff, where string compare would wrongly include it (#17)', async () => {
    vi.useFakeTimers();
    // Cutoff carries ms (toISOString); real X-ray timeTags never do. With now at
    // .500, the past-hour cutoff is 05:00:00.500Z and a real 05:00:00Z reading is
    // 500ms before it. Old string compare ('..00Z' >= '..00.500Z') → true (wrong);
    // epoch compare correctly excludes it.
    vi.setSystemTime(new Date('2026-06-24T06:00:00.500Z'));
    const boundaryTag = '2026-06-24T05:00:00Z'; // real no-ms shape, 500ms before the cutoff
    const insideTag = '2026-06-24T05:30:00Z'; // clearly within the past hour
    useSvc({
      getXrayFlux: vi.fn().mockResolvedValue([
        { timeTag: boundaryTag, satellite: 18, fluxWm2: 1e-6, energy: '0.1-0.8nm' },
        { timeTag: insideTag, satellite: 18, fluxWm2: 2e-6, energy: '0.1-0.8nm' },
      ]),
    });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const input = getSolarActivity.input.parse({});
    const result = await getSolarActivity.handler(input, ctx);

    const recentTimes = result.recentXray.map((r) => r.timeTag);
    expect(recentTimes).not.toContain(boundaryTag); // excluded: true time is before the cutoff
    expect(recentTimes).toContain(insideTag);
    expect(result.recentXray).toHaveLength(1);
  });
});

/**
 * The class-with-magnitude derivation on the X-ray flux readings, measured against
 * the flare feed's own published `max_class` values — the only ground truth
 * available, and the reason the rule has to be SWPC's truncation rather than
 * rounding: the same flare is otherwise reported two ways in one response.
 */
describe('getSolarActivity flare class with magnitude (#31)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  async function classFor(flux: number): Promise<string | null> {
    useSvc({ getXrayFlux: vi.fn().mockResolvedValue([makeXrayReading(0.1, flux)]) });
    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const result = await getSolarActivity.handler(getSolarActivity.input.parse({}), ctx);
    return result.latestXray!.flareClassFull;
  }

  it.each(PUBLISHED_FLARE_CLASSES)(
    'derives %s as the class SWPC published (%s)',
    async (flux, maxClass) => {
      expect(await classFor(flux)).toBe(maxClass);
    },
  );

  const BOUNDARY_CASES: [flux: number, expected: string | null][] = [
    // The precision snap: 4.9e-5 / 1e-5 evaluates to 4.8999999999999995, so a bare
    // floor() on the raw quotient reports M4.8 for a flux that is exactly M4.9.
    [4.9e-5, 'M4.9'],
    [9.9e-5, 'M9.9'],
    // Decade edge — rounding would promote this to a class that does not exist.
    [9.986e-7, 'B9.9'],
    [1e-8, 'A1.0'],
    [1e-7, 'B1.0'],
    [1e-6, 'C1.0'],
    [1e-5, 'M1.0'],
    [1e-4, 'X1.0'],
    // Only the letter saturates; the magnitude is unbounded above X.
    [1.5e-3, 'X15.0'],
    [2e-3, 'X20.0'],
    // Below the A1 floor there is no class to state: SWPC's scheme starts at A1.0, so
    // an "A0.9" would be a class string no SWPC product ever writes.
    [9.9e-9, null],
    [1e-9, null],
    // At or below zero no magnitude is defined — a floored sample, not a sub-A1 flare.
    [0, null],
    [-1e-7, null],
  ];

  it.each(BOUNDARY_CASES)('maps flux %s to %s', async (flux, expected) => {
    expect(await classFor(flux)).toBe(expected);
  });

  it('keeps flareClass a bare letter and adds the magnitude alongside it', async () => {
    useSvc({ getXrayFlux: vi.fn().mockResolvedValue([makeXrayReading(0.1, 5.5e-5)]) });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const result = await getSolarActivity.handler(getSolarActivity.input.parse({}), ctx);

    expect(result.latestXray!.flareClass).toBe('M');
    expect(result.latestXray!.flareClassFull).toBe('M5.5');
  });

  it('exposes the unformatted flux next to the display string on both series', async () => {
    useSvc({
      getXrayFlux: vi.fn().mockResolvedValue([makeXrayReading(0.1, 9.167114285446587e-7)]),
    });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const result = await getSolarActivity.handler(getSolarActivity.input.parse({}), ctx);

    expect(result.latestXray!.fluxWm2Value).toBe(9.167114285446587e-7);
    expect(result.latestXray!.fluxWm2).toBe('9.2e-7 W/m²');
    expect(result.recentXray[0]!.fluxWm2Value).toBe(9.167114285446587e-7);
    expect(result.recentXray[0]!.flareClassFull).toBe('B9.1');
  });

  it('reports a zero-flux reading as a null magnitude, never "A0.0"', async () => {
    useSvc({ getXrayFlux: vi.fn().mockResolvedValue([makeXrayReading(0.1, 0)]) });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const result = await getSolarActivity.handler(getSolarActivity.input.parse({}), ctx);

    expect(result.latestXray!.flareClassFull).toBeNull();
    expect(result.latestXray!.fluxWm2Value).toBe(0);
    const text = (getSolarActivity.format!(result)[0] as { text: string }).text;
    expect(text).not.toContain('A0.0');
  });
});

describe('getSolarActivity recentFlares (#31)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the flare events inside the default 24-hour window, oldest first', async () => {
    useSvc({
      getXrayFlares: vi.fn().mockResolvedValue([
        makeFlare(48, { maxClass: 'B2.1' }), // outside the default window
        makeFlare(12, { maxClass: 'C3.4' }),
        makeFlare(2, { maxClass: 'M1.1' }),
      ]),
    });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const input = getSolarActivity.input.parse({});
    const result = await getSolarActivity.handler(input, ctx);

    expect(result.recentFlares.map((f) => f.maxClass)).toEqual(['C3.4', 'M1.1']);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('widens to the full feed retention at flare_hours=168', async () => {
    useSvc({
      getXrayFlares: vi
        .fn()
        .mockResolvedValue([
          makeFlare(160, { maxClass: 'B8.1' }),
          makeFlare(2, { maxClass: 'B3.2' }),
        ]),
    });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const input = getSolarActivity.input.parse({ flare_hours: 168 });
    const result = await getSolarActivity.handler(input, ctx);

    expect(result.recentFlares.map((f) => f.maxClass)).toEqual(['B8.1', 'B3.2']);
  });

  it('excludes a flare whose true onset is just before the window cutoff, where string compare would include it', async () => {
    vi.useFakeTimers();
    // Same class of bug as #17: the cutoff carries milliseconds and the feed's
    // begin_time does not, so a lexicographic compare reads a 500 ms-old exclusion
    // as inside the window.
    vi.setSystemTime(new Date('2026-09-17T12:00:00.500Z'));
    const boundaryOnset = '2026-09-17T11:00:00Z'; // 500 ms before the 1-hour cutoff
    const insideOnset = '2026-09-17T11:30:00Z';
    useSvc({
      getXrayFlares: vi
        .fn()
        .mockResolvedValue([
          makeFlare(0, { beginTime: boundaryOnset, maxClass: 'B1.1' }),
          makeFlare(0, { beginTime: insideOnset, maxClass: 'B2.2' }),
        ]),
    });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const input = getSolarActivity.input.parse({ flare_hours: 1 });
    const result = await getSolarActivity.handler(input, ctx);

    expect(result.recentFlares.map((f) => f.beginTime)).toEqual([insideOnset]);
  });

  it('carries the peak flux, the classes as published, and the R-scale for each event', async () => {
    useSvc({
      getXrayFlares: vi.fn().mockResolvedValue([
        makeFlare(1, {
          beginClass: 'M8.0',
          maxClass: 'X1.2',
          endClass: 'M5.0',
          peakFluxWm2: 1.2e-4,
        }),
      ]),
    });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const result = await getSolarActivity.handler(getSolarActivity.input.parse({}), ctx);

    expect(result.recentFlares[0]).toMatchObject({
      beginClass: 'M8.0',
      maxClass: 'X1.2',
      endClass: 'M5.0',
      peakFluxWm2: 1.2e-4,
      rScale: 3,
      satellite: 18,
    });
  });

  it('passes an in-progress flare through with null decay fields', async () => {
    useSvc({
      getXrayFlares: vi
        .fn()
        .mockResolvedValue([makeFlare(1, { endTime: null, endClass: null, maxClass: 'C1.9' })]),
    });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const result = await getSolarActivity.handler(getSolarActivity.input.parse({}), ctx);

    expect(result.recentFlares[0]!.endTime).toBeNull();
    expect(result.recentFlares[0]!.endClass).toBeNull();
    const text = (getSolarActivity.format!(result)[0] as { text: string }).text;
    expect(text).toContain('in progress');
  });

  /** NOAA states the R levels as flux floors on its scales page. */
  const R_SCALE_CASES: [peakFlux: number, rScale: number][] = [
    [9.9e-6, 0], // below M1 — no radio blackout level
    [1e-5, 1],
    [4.9e-5, 1],
    [5e-5, 2],
    [9.9e-5, 2],
    [1e-4, 3],
    [9.9e-4, 3],
    [1e-3, 4],
    [1.9e-3, 4],
    [2e-3, 5],
    [5e-3, 5],
    [0, 0],
  ];

  it.each(R_SCALE_CASES)('maps a peak flux of %s to R%s', async (peakFluxWm2, rScale) => {
    useSvc({
      getXrayFlares: vi.fn().mockResolvedValue([makeFlare(1, { peakFluxWm2 })]),
    });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const result = await getSolarActivity.handler(getSolarActivity.input.parse({}), ctx);

    expect(result.recentFlares[0]!.rScale).toBe(rScale);
  });

  it('names the newest flare the feed carries when the window comes back empty', async () => {
    useSvc({
      getXrayFlares: vi
        .fn()
        .mockResolvedValue([
          makeFlare(100, { maxClass: 'B8.1' }),
          makeFlare(48, { maxClass: 'C2.5', beginTime: '2026-09-15T04:00:00Z' }),
        ]),
    });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const input = getSolarActivity.input.parse({ flare_hours: 6 });
    const result = await getSolarActivity.handler(input, ctx);

    expect(result.recentFlares).toHaveLength(0);
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('6-hour window');
    expect(notice).toContain('C2.5');
    expect(notice).toContain('2026-09-15T04:00:00Z');
  });

  it('says the feed carried no flare events at all when it is empty', async () => {
    useSvc({ getXrayFlares: vi.fn().mockResolvedValue([]) });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const result = await getSolarActivity.handler(getSolarActivity.input.parse({}), ctx);

    expect(result.recentFlares).toHaveLength(0);
    expect(getEnrichment(ctx).notice).toBe('The feed returned no flare events.');
  });

  it('rejects a flare_hours outside the feed retention, and defaults to 24', () => {
    expect(getSolarActivity.input.parse({}).flare_hours).toBe(24);
    expect(getSolarActivity.input.parse({ flare_hours: 168 }).flare_hours).toBe(168);
    expect(() => getSolarActivity.input.parse({ flare_hours: 0 })).toThrow();
    expect(() => getSolarActivity.input.parse({ flare_hours: 169 })).toThrow();
    expect(() => getSolarActivity.input.parse({ flare_hours: 1.5 })).toThrow();
  });
});

describe('getSolarActivity F10.7 (#31)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reports the daily F10.7 index with its observation time and 90-day mean', async () => {
    useSvc({ getF107: vi.fn().mockResolvedValue(mockF107) });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const result = await getSolarActivity.handler(getSolarActivity.input.parse({}), ctx);

    expect(result.f107).toEqual({
      observedTime: '2026-09-16T20:00:00Z',
      fluxSfu: 100,
      ninetyDayMeanSfu: 126,
      reportingSchedule: 'Noon',
    });

    const text = (getSolarActivity.format!(result)[0] as { text: string }).text;
    expect(text).toContain('100 sfu');
    expect(text).toContain('126 sfu');
    expect(text).toContain('2026-09-16T20:00:00Z');
    expect(text).toContain('Noon');
  });

  it('renders a null 90-day mean without inventing a figure', async () => {
    useSvc({
      getF107: vi.fn().mockResolvedValue({ ...mockF107, ninetyDayMeanSfu: null }),
    });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const result = await getSolarActivity.handler(getSolarActivity.input.parse({}), ctx);

    expect(result.f107!.ninetyDayMeanSfu).toBeNull();
    const text = (getSolarActivity.format!(result)[0] as { text: string }).text;
    expect(text).toContain('100 sfu');
    // The label itself has to go, not just the figure: a fixture with the mean nulled
    // carries no number to leak, so only the absent label and an absent "null" prove
    // the branch — an unconditional render would print "90-day mean: null sfu".
    expect(text).not.toContain('90-day mean');
    expect(text).not.toMatch(/null|undefined|NaN/);
  });

  it('reports null when the feed carries no F10.7 record', async () => {
    useSvc({ getF107: vi.fn().mockResolvedValue(null) });

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const result = await getSolarActivity.handler(getSolarActivity.input.parse({}), ctx);

    expect(result.f107).toBeNull();
    const text = (getSolarActivity.format!(result)[0] as { text: string }).text;
    expect(text).not.toContain('sfu');
  });
});

describe('getSolarActivity per-region flare counts, area, and first-seen time (#39)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  async function runWithRegions(regions: SolarRegion[]) {
    useSvc({ getSolarRegions: vi.fn().mockResolvedValue(regions) });
    const ctx = createMockContext({ errors: getSolarActivity.errors });
    return getSolarActivity.handler(getSolarActivity.input.parse({}), ctx);
  }

  /** The rendered block for one region, from its heading to the next region's. */
  function regionBlock(text: string, region: number): string {
    const start = text.indexOf(`**AR${region}**`);
    const next = text.indexOf('**AR', start + 1);
    return text.slice(start, next === -1 ? undefined : next);
  }

  it('carries the counts, area, and first-seen time on every region in structuredContent', async () => {
    const result = await runWithRegions([mockRegion, spotlessRegion]);

    expect(result.activeRegions).toHaveLength(2);
    expect(result.activeRegions[0]).toMatchObject({
      region: 3782,
      cFlareCount: 3,
      mFlareCount: 1,
      xFlareCount: 0,
      areaMillionths: 480,
      firstObserved: '2026-05-29T07:15:15Z',
    });
    // Past the first region — the spotless one keeps its null area.
    expect(result.activeRegions[1]).toMatchObject({
      region: 3780,
      cFlareCount: 0,
      areaMillionths: null,
      firstObserved: '2026-05-31T17:49:08Z',
    });
    expect(getSolarActivity.output.parse(result).activeRegions).toEqual(result.activeRegions);
  });

  it('renders the same-day counts, area, and first-seen time in content[]', async () => {
    const result = await runWithRegions([mockRegion]);
    const block = regionBlock((getSolarActivity.format!(result)[0] as { text: string }).text, 3782);

    expect(block).toContain('First observed: 2026-05-29T07:15:15Z');
    expect(block).toContain(
      'Class: Ekc/Beta-Gamma | Spots: 12 | Area: 480 millionths of the hemisphere',
    );
    expect(block).toContain('Flares on 2026-06-04: C=3 M=1 X=0');
    // The probabilities are labelled as the following day's, apart from the tallies.
    expect(block).toContain('Flare probability, following day: C=65% M=30% X=10% Proton=5%');
  });

  it('renders a spotless region as plage, not an empty class', async () => {
    const result = await runWithRegions([mockRegion, spotlessRegion]);
    const block = regionBlock((getSolarActivity.format!(result)[0] as { text: string }).text, 3780);

    expect(block).toContain('Class: no spots (plage) | Area: none');
    expect(block).not.toContain('Class: /');
    expect(block).not.toContain('Spots: 0');
    expect(block).not.toMatch(/null|undefined|NaN/);
    // Its counts still render: zero is a real tally here.
    expect(block).toContain('Flares on 2026-06-04: C=0 M=0 X=0');
  });

  it('keeps an empty region list and include_regions=false unchanged', async () => {
    const empty = await runWithRegions([]);
    expect(empty.activeRegions).toEqual([]);
    expect((getSolarActivity.format!(empty)[0] as { text: string }).text).not.toContain(
      'Active Solar Regions',
    );

    const svc = useSvc({ getSolarRegions: vi.fn().mockResolvedValue([mockRegion]) });
    const skipped = await getSolarActivity.handler(
      getSolarActivity.input.parse({ include_regions: false }),
      createMockContext({ errors: getSolarActivity.errors }),
    );
    expect(skipped.activeRegions).toEqual([]);
    expect(svc.getSolarRegions).not.toHaveBeenCalled();
  });
});
