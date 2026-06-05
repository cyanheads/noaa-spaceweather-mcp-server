/**
 * @fileoverview Tests for the noaa_spaceweather_get_solar_activity tool.
 * @module tests/tools/get-solar-activity.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  { date: '2026-06-04', cClass1Day: 55, mClass1Day: 20, xClass1Day: 5, protons1Day: 5 },
  { date: '2026-06-05', cClass1Day: 50, mClass1Day: 15, xClass1Day: 3, protons1Day: 3 },
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
    expect(result.latestXray!.fluxWm2).toBe(1e-6);
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
        fluxWm2: 1.2e-4,
        flareClass: 'X',
        satellite: 18,
      },
      recentXray: [
        { timeTag: '2026-06-04T14:00:00Z', fluxWm2: 1.2e-4, flareClass: 'X', satellite: 18 },
      ],
      probabilities: [
        { date: '2026-06-04', cClass1Day: 55, mClass1Day: 20, xClass1Day: 5, protons1Day: 5 },
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
});
