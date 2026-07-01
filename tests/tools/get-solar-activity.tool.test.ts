/**
 * @fileoverview Tests for the noaa_spaceweather_get_solar_activity tool.
 * @module tests/tools/get-solar-activity.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProtonFlux,
  SolarProbabilities,
  SolarRegion,
  XrayFlux,
} from '@/services/space-weather/types.js';

vi.mock('@/services/space-weather/space-weather-service.js', () => ({
  getSpaceWeatherService: vi.fn(),
}));

import { getSolarActivity } from '@/mcp-server/tools/definitions/get-solar-activity.tool.js';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

const mockGetSpaceWeatherService = vi.mocked(getSpaceWeatherService);

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
  cFlareProbability: 65,
  mFlareProbability: 30,
  xFlareProbability: 10,
  protonProbability: 5,
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
    const svc = {
      getXrayFlux: vi.fn().mockResolvedValue([makeXrayReading(0.5, 1e-6)]), // C-class flux
      getSolarProbabilities: vi.fn().mockResolvedValue(mockProbabilities),
      getProtonFlux: vi.fn().mockResolvedValue([makeProtonReading(1)]), // S0 — below threshold
      getSolarRegions: vi.fn().mockResolvedValue([mockRegion]),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

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
    const svc = {
      getXrayFlux: vi.fn().mockResolvedValue([makeXrayReading(0.1, 1.2e-4)]), // X1.2
      getSolarProbabilities: vi.fn().mockResolvedValue([]),
      getProtonFlux: vi.fn().mockResolvedValue([]),
      getSolarRegions: vi.fn().mockResolvedValue([]),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const input = getSolarActivity.input.parse({});
    const result = await getSolarActivity.handler(input, ctx);

    expect(result.latestXray!.flareClass).toBe('X');
  });

  it('derives S2 radiation storm from proton flux of 150 pfu', async () => {
    const svc = {
      getXrayFlux: vi.fn().mockResolvedValue([makeXrayReading(0.5, 1e-7)]),
      getSolarProbabilities: vi.fn().mockResolvedValue([]),
      getProtonFlux: vi.fn().mockResolvedValue([makeProtonReading(150)]), // S2 range
      getSolarRegions: vi.fn().mockResolvedValue([]),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const input = getSolarActivity.input.parse({});
    const result = await getSolarActivity.handler(input, ctx);

    expect(result.sScale).toBe(2);
    expect(result.sScaleText).toContain('S2');
    expect(result.latestProton!.sScale).toBe(2);
    expect(result.latestProton!.fluxPfu).toBe(150);
  });

  it('skips solar regions when include_regions=false', async () => {
    const svc = {
      getXrayFlux: vi.fn().mockResolvedValue([makeXrayReading(0.5)]),
      getSolarProbabilities: vi.fn().mockResolvedValue(mockProbabilities),
      getProtonFlux: vi.fn().mockResolvedValue([makeProtonReading(0.1)]),
      getSolarRegions: vi.fn().mockResolvedValue([mockRegion]),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const input = getSolarActivity.input.parse({ include_regions: false });
    const result = await getSolarActivity.handler(input, ctx);

    expect(result.activeRegions).toHaveLength(0);
    // getSolarRegions should NOT have been called
    expect(svc.getSolarRegions).not.toHaveBeenCalled();
  });

  it('handles empty feeds (null latestXray and latestProton)', async () => {
    const svc = {
      getXrayFlux: vi.fn().mockResolvedValue([]),
      getSolarProbabilities: vi.fn().mockResolvedValue([]),
      getProtonFlux: vi.fn().mockResolvedValue([]),
      getSolarRegions: vi.fn().mockResolvedValue([]),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

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
        flareClass: 'X',
        satellite: 18,
      },
      recentXray: [
        { timeTag: '2026-06-04T14:00:00Z', fluxWm2: '1.2e-4 W/m²', flareClass: 'X', satellite: 18 },
      ],
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
  });

  it('formats X-ray flux as scientific notation in content[] (issue #4)', async () => {
    // Verify the handler produces formatted strings in structuredContent.
    const svc = {
      getXrayFlux: vi.fn().mockResolvedValue([
        makeXrayReading(0.5, 9.167114285446587e-7), // B-class
        makeXrayReading(0.25, 0.0000013899084478907753), // C-class
      ]),
      getSolarProbabilities: vi.fn().mockResolvedValue([]),
      getProtonFlux: vi.fn().mockResolvedValue([]),
      getSolarRegions: vi.fn().mockResolvedValue([]),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

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
    const svc = {
      getXrayFlux: vi.fn().mockResolvedValue([]),
      getSolarProbabilities: vi.fn().mockResolvedValue([]),
      // Full-precision IEEE-754 value as returned raw by the GOES feed.
      getProtonFlux: vi.fn().mockResolvedValue([makeProtonReading(0.2243340015411377)]),
      getSolarRegions: vi.fn().mockResolvedValue([]),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

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
    const svc = {
      getXrayFlux: vi.fn().mockResolvedValue([]),
      getSolarProbabilities: vi.fn().mockResolvedValue([]),
      getProtonFlux: vi.fn().mockResolvedValue([makeProtonReading(1234.5678)]), // S3 range (≥1000)
      getSolarRegions: vi.fn().mockResolvedValue([]),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const input = getSolarActivity.input.parse({});
    const result = await getSolarActivity.handler(input, ctx);

    // toPrecision(3) on a large value rounds the magnitude but stays a plain number.
    expect(result.latestProton!.fluxPfu).toBe(1230);
    // S-scale is classified from the raw value, unaffected by display rounding.
    expect(result.latestProton!.sScale).toBe(3);
  });

  it('exposes date-neutral probability aliases alongside the *1Day fields (#16)', async () => {
    const svc = {
      getXrayFlux: vi.fn().mockResolvedValue([]),
      getSolarProbabilities: vi.fn().mockResolvedValue(mockProbabilities),
      getProtonFlux: vi.fn().mockResolvedValue([]),
      getSolarRegions: vi.fn().mockResolvedValue([]),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

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
    const svc = {
      getXrayFlux: vi.fn().mockResolvedValue([
        { timeTag: boundaryTag, satellite: 18, fluxWm2: 1e-6, energy: '0.1-0.8nm' },
        { timeTag: insideTag, satellite: 18, fluxWm2: 2e-6, energy: '0.1-0.8nm' },
      ]),
      getSolarProbabilities: vi.fn().mockResolvedValue([]),
      getProtonFlux: vi.fn().mockResolvedValue([]),
      getSolarRegions: vi.fn().mockResolvedValue([]),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getSolarActivity.errors });
    const input = getSolarActivity.input.parse({});
    const result = await getSolarActivity.handler(input, ctx);

    const recentTimes = result.recentXray.map((r) => r.timeTag);
    expect(recentTimes).not.toContain(boundaryTag); // excluded: true time is before the cutoff
    expect(recentTimes).toContain(insideTag);
    expect(result.recentXray).toHaveLength(1);
  });
});
