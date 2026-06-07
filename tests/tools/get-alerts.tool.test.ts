/**
 * @fileoverview Tests for the noaa_spaceweather_get_alerts tool.
 * @module tests/tools/get-alerts.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpaceWeatherAlert } from '@/services/space-weather/types.js';

vi.mock('@/services/space-weather/space-weather-service.js', () => ({
  getSpaceWeatherService: vi.fn(),
}));

import { getAlerts } from '@/mcp-server/tools/definitions/get-alerts.tool.js';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

const mockGetSpaceWeatherService = vi.mocked(getSpaceWeatherService);

function makeAlert(overrides: Partial<SpaceWeatherAlert> = {}): SpaceWeatherAlert {
  return {
    productId: 'WARK04',
    productType: 'Warning',
    level: 4,
    issueDatetime: '2026-06-04T12:00:00Z',
    message: 'Geomagnetic K-index of 4 expected.',
    phenomenon: 'Geomagnetic',
    validFrom: '2026 Jun 04 1200 UTC',
    validTo: '2026 Jun 04 2359 UTC',
    ...overrides,
  };
}

describe('getAlerts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns active alerts filtered to Warning/Watch/Alert when active_only=true', async () => {
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    const alerts: SpaceWeatherAlert[] = [
      makeAlert({ productType: 'Warning', issueDatetime: recent }),
      makeAlert({
        productId: 'SUMS',
        productType: 'Summary',
        phenomenon: 'Space Weather',
        issueDatetime: recent,
      }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: true });
    const result = await getAlerts.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.alerts[0]!.productType).toBe('Warning');
    expect(result.alerts.every((a) => a.productType !== 'Summary')).toBe(true);
  });

  it('excludes alerts older than max_age_hours', async () => {
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(); // 72h ago
    const alerts: SpaceWeatherAlert[] = [
      makeAlert({ productType: 'Warning', issueDatetime: recent }),
      makeAlert({ productType: 'Watch', issueDatetime: old }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: true, max_age_hours: 48 });
    const result = await getAlerts.handler(input, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.alerts[0]!.issueDatetime).toBe(recent);
  });

  it('respects max_age_hours=720 to return all historical alerts', async () => {
    const old = new Date(Date.now() - 500 * 60 * 60 * 1000).toISOString(); // 500h ago
    const alerts: SpaceWeatherAlert[] = [makeAlert({ productType: 'Warning', issueDatetime: old })];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: false, max_age_hours: 720 });
    const result = await getAlerts.handler(input, ctx);

    expect(result.totalCount).toBe(1);
  });

  it('returns all products when active_only=false', async () => {
    const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    const alerts: SpaceWeatherAlert[] = [
      makeAlert({ productType: 'Warning', issueDatetime: recent }),
      makeAlert({
        productId: 'SUMS',
        productType: 'Summary',
        phenomenon: 'Space Weather',
        issueDatetime: recent,
      }),
      makeAlert({ productId: 'ALTK07', productType: 'Alert', level: 7, issueDatetime: recent }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: false });
    const result = await getAlerts.handler(input, ctx);

    expect(result.totalCount).toBe(3);
    expect(result.alerts.some((a) => a.productType === 'Summary')).toBe(true);
  });

  it('populates fetchedAt with an ISO timestamp', async () => {
    const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    const svc = { getAlerts: vi.fn().mockResolvedValue([makeAlert({ issueDatetime: recent })]) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({});
    const result = await getAlerts.handler(input, ctx);

    expect(() => new Date(result.fetchedAt)).not.toThrow();
    expect(new Date(result.fetchedAt).getFullYear()).toBeGreaterThan(2000);
  });

  it('returns empty alerts array when feed has no products', async () => {
    const svc = { getAlerts: vi.fn().mockResolvedValue([]) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({});
    const result = await getAlerts.handler(input, ctx);

    expect(result.totalCount).toBe(0);
    expect(result.alerts).toHaveLength(0);
  });

  it('formats output with alert details', () => {
    const output = {
      alerts: [
        {
          productId: 'WARK04',
          productType: 'Warning' as const,
          level: 4,
          phenomenon: 'Geomagnetic',
          issueDatetime: '2026-06-04T12:00:00Z',
          validFrom: '2026 Jun 04 1200 UTC',
          validTo: '2026 Jun 04 2359 UTC',
          message: 'K-index of 4 expected.',
        },
      ],
      totalCount: 1,
      fetchedAt: '2026-06-04T15:00:00.000Z',
    };
    const blocks = getAlerts.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Warning');
    expect(text).toContain('Geomagnetic');
    expect(text).toContain('WARK04');
    expect(text).toContain('K-index of 4 expected.');
    expect(text).toContain('**Total:** 1');
  });
});
