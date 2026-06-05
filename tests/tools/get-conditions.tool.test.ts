/**
 * @fileoverview Tests for the noaa_spaceweather_get_conditions tool.
 * @module tests/tools/get-conditions.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KpObservation, NoaaScalesData } from '@/services/space-weather/types.js';

// Must be hoisted before any imports that reference the service module
vi.mock('@/services/space-weather/space-weather-service.js', () => ({
  getSpaceWeatherService: vi.fn(),
}));

import { getConditions } from '@/mcp-server/tools/definitions/get-conditions.tool.js';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

const mockGetSpaceWeatherService = vi.mocked(getSpaceWeatherService);

function makeScalesData(gScale = 0, rScale = 0, sScale = 0): NoaaScalesData {
  const makeEntry = (cat: 'G' | 'R' | 'S', scale: number) => ({
    category: cat,
    scale,
    text: scale === 0 ? '' : scale === 1 ? 'Minor' : 'Moderate',
    minorProb: null,
    majorProb: null,
  });
  const period = (date: string) => ({
    date,
    time: '15:00:00',
    G: makeEntry('G', gScale),
    R: makeEntry('R', rScale),
    S: makeEntry('S', sScale),
  });
  return {
    today: period('2026-06-04'),
    forecast: [period('2026-06-05'), period('2026-06-06')],
  };
}

function makeKpObservations(kp = 0): KpObservation[] {
  return [
    {
      timeTag: '2026-06-04T12:00:00Z',
      kp,
      gScale: kp >= 5 ? 1 : 0,
      auroraLatitude:
        kp >= 5
          ? 'Aurora possible to ~60° geomagnetic latitude'
          : 'No significant aurora expected at mid-latitudes',
      aRunning: null,
      stationCount: 12,
    },
  ];
}

describe('getConditions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns quiet-conditions snapshot when no storms active', async () => {
    const svc = {
      getNoaaScales: vi.fn().mockResolvedValue(makeScalesData()),
      getKpObserved: vi.fn().mockResolvedValue(makeKpObservations(1)),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getConditions.errors });
    const input = getConditions.input.parse({});
    const result = await getConditions.handler(input, ctx);

    expect(result.currentKp).toBe(1);
    expect(result.currentGScale).toBe(0);
    expect(result.summary).toBe('Quiet conditions — no significant storms active.');
    expect(result.today.G.scale).toBe(0);
    expect(result.today.R.scale).toBe(0);
    expect(result.today.S.scale).toBe(0);
    expect(result.forecast).toHaveLength(2);
    expect(result.observedAt).toContain('2026-06-04');
  });

  it('builds storm summary when G-scale and R-scale are active', async () => {
    const svc = {
      getNoaaScales: vi.fn().mockResolvedValue(makeScalesData(2, 1, 0)),
      getKpObserved: vi.fn().mockResolvedValue(makeKpObservations(6)),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getConditions.errors });
    const input = getConditions.input.parse({});
    const result = await getConditions.handler(input, ctx);

    expect(result.summary).toMatch(/G2/);
    expect(result.summary).toMatch(/R1/);
    expect(result.summary).toMatch(/in progress/);
    expect(result.today.G.scale).toBe(2);
    expect(result.today.G.label).toBe('G2');
  });

  it('falls back to defaults when Kp observation list is empty', async () => {
    const svc = {
      getNoaaScales: vi.fn().mockResolvedValue(makeScalesData()),
      getKpObserved: vi.fn().mockResolvedValue([]),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getConditions.errors });
    const input = getConditions.input.parse({});
    const result = await getConditions.handler(input, ctx);

    expect(result.currentKp).toBe(0);
    expect(result.currentGScale).toBe(0);
    expect(result.auroraLatitude).toBe('No significant aurora expected at mid-latitudes');
  });

  it('formats output with all required sections', () => {
    const result = {
      observedAt: '2026-06-04 15:00:00',
      currentKp: 3,
      currentGScale: 0,
      auroraLatitude: 'No significant aurora expected at mid-latitudes',
      today: {
        G: { scale: 0, text: '', label: 'G0' },
        R: { scale: 0, text: '', label: 'R0' },
        S: { scale: 0, text: '', label: 'S0' },
      },
      forecast: [
        {
          date: '2026-06-05',
          G: { scale: 1, text: 'Minor', label: 'G1' },
          R: { scale: 0, text: '', label: 'R0' },
          S: { scale: 0, text: '', label: 'S0' },
        },
      ],
      summary: 'Quiet conditions — no significant storms active.',
    };
    const blocks = getConditions.format!(result);
    expect(blocks[0]!.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('2026-06-04 15:00:00');
    expect(text).toContain('Quiet conditions');
    expect(text).toContain('G0');
    expect(text).toContain('3-Day Forecast');
    expect(text).toContain('G1');
  });
});
