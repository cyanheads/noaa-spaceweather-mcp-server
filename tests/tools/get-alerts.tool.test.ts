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
    productId: 'K04W',
    messageCode: 'WARK04',
    productType: 'Warning',
    // WARK04 states no NOAA scale — K4 sits below the G-scale — so level is 0 (#18).
    level: 0,
    noaaScale: null,
    cancelled: false,
    issueDatetime: '2026-06-04T12:00:00Z',
    message: 'Geomagnetic K-index of 4 expected.',
    phenomenon: 'Geomagnetic',
    validFrom: '2026-06-04T12:00:00Z',
    // Default to a still-in-force window so active_only tests that don't target
    // validTo aren't dropped by the elapsed-validity filter (regression #12).
    validTo: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
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

  it('active_only=true drops expired-validTo Warnings but keeps future and null-validTo products (regression #12)', async () => {
    const recentIssue = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago, within window
    const expiredValidTo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // elapsed 1h ago
    const futureValidTo = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(); // in force 6h more
    const alerts: SpaceWeatherAlert[] = [
      // Warning already expired — must be excluded despite a recent issue time.
      makeAlert({
        productId: 'EXPW',
        messageCode: 'WARK04',
        productType: 'Warning',
        issueDatetime: recentIssue,
        validTo: expiredValidTo,
      }),
      // Warning still in force — must be kept.
      makeAlert({
        productId: 'FUTW',
        messageCode: 'WARK05',
        productType: 'Warning',
        issueDatetime: recentIssue,
        validTo: futureValidTo,
      }),
      // Watch with no validTo (point-in-time notice) — recency window is its only
      // filter, so it is kept.
      makeAlert({
        productId: 'NULW',
        messageCode: 'WATA50',
        productType: 'Watch',
        level: 3,
        noaaScale: 'G3',
        issueDatetime: recentIssue,
        validFrom: null,
        validTo: null,
      }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: true, max_age_hours: 48 });
    const result = await getAlerts.handler(input, ctx);

    const ids = result.alerts.map((a) => a.productId);
    expect(ids).not.toContain('EXPW'); // expired validTo excluded
    expect(ids).toContain('FUTW'); // future validTo kept
    expect(ids).toContain('NULW'); // null validTo within recency window kept
    expect(result.totalCount).toBe(2);
  });

  it('active_only=true keeps a Warning whose validTo is unparseable rather than dropping it (regression #12)', async () => {
    const recentIssue = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago, within window
    const alerts: SpaceWeatherAlert[] = [
      // parseValidity falls back to raw upstream text when a validity line fails the
      // strict SWPC datetime regex, so validTo can be prose Date cannot parse
      // (getTime() → NaN). An "active" query must not silently drop an in-force
      // warning whose end time it cannot read.
      makeAlert({
        productId: 'RAWW',
        messageCode: 'WARK04',
        productType: 'Warning',
        issueDatetime: recentIssue,
        validTo: 'until further notice',
      }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: true, max_age_hours: 48 });
    const result = await getAlerts.handler(input, ctx);

    expect(result.alerts.map((a) => a.productId)).toContain('RAWW');
    expect(result.totalCount).toBe(1);
  });

  it('active_only=true excludes cancellation notices (regression #19)', async () => {
    const recentIssue = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const alerts: SpaceWeatherAlert[] = [
      // A cancellation keeps the cancelled product's own type and carries no validity
      // window, so neither the productType nor the elapsed-validTo check excludes it.
      makeAlert({
        productId: 'K05W',
        messageCode: 'WARK05',
        productType: 'Warning',
        level: 1,
        noaaScale: 'G1',
        cancelled: true,
        issueDatetime: recentIssue,
        validFrom: null,
        validTo: null,
      }),
      // Cancelled Alerts must drop too — a predicate keyed on Warnings alone misses these.
      makeAlert({
        productId: 'EF3A',
        messageCode: 'ALTEF3',
        productType: 'Alert',
        phenomenon: 'Space Weather',
        cancelled: true,
        issueDatetime: recentIssue,
        validFrom: null,
        validTo: null,
      }),
      // In-force Warning with the same shape — kept.
      makeAlert({
        productId: 'K06W',
        messageCode: 'WARK06',
        productType: 'Warning',
        level: 2,
        noaaScale: 'G2',
        issueDatetime: recentIssue,
        validFrom: null,
        validTo: null,
      }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: true, max_age_hours: 720 });
    const result = await getAlerts.handler(input, ctx);

    expect(result.alerts.map((a) => a.productId)).toEqual(['K06W']);
    expect(result.alerts.every((a) => !a.cancelled)).toBe(true);
    expect(result.totalCount).toBe(1);
  });

  it('active_only=false returns cancellations, flagged (regression #19)', async () => {
    const recentIssue = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const alerts: SpaceWeatherAlert[] = [
      makeAlert({
        productId: 'K05W',
        messageCode: 'WARK05',
        cancelled: true,
        issueDatetime: recentIssue,
        validTo: null,
      }),
      makeAlert({ productId: 'K06W', messageCode: 'WARK06', issueDatetime: recentIssue }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: false });
    const result = await getAlerts.handler(input, ctx);

    expect(result.totalCount).toBe(2);
    expect(result.alerts.find((a) => a.productId === 'K05W')!.cancelled).toBe(true);
    expect(result.alerts.find((a) => a.productId === 'K06W')!.cancelled).toBe(false);
  });

  it('active_only=true drops only the cancelled record of a code that flips (regression #19)', async () => {
    // The live feed cycles a single code CONTINUED → CANCEL → CONTINUED within minutes,
    // so filtering must be per record: cancelling by message code would wrongly drop the
    // in-force records either side of the cancellation.
    const t = (minsAgo: number) => new Date(Date.now() - minsAgo * 60 * 1000).toISOString();
    const alerts: SpaceWeatherAlert[] = [
      makeAlert({
        productId: 'EF3A-a',
        messageCode: 'ALTEF3',
        productType: 'Alert',
        issueDatetime: t(30),
        validTo: null,
      }),
      makeAlert({
        productId: 'EF3A-b',
        messageCode: 'ALTEF3',
        productType: 'Alert',
        cancelled: true,
        issueDatetime: t(26),
        validTo: null,
      }),
      makeAlert({
        productId: 'EF3A-c',
        messageCode: 'ALTEF3',
        productType: 'Alert',
        issueDatetime: t(25),
        validTo: null,
      }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: true });
    const result = await getAlerts.handler(input, ctx);

    expect(result.alerts.map((a) => a.productId)).toEqual(['EF3A-a', 'EF3A-c']);
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

  it('includes alerts whose issueDatetime shares the cutoff calendar date (regression #6)', async () => {
    // Simulate the bug: an alert issued 35h ago on the cutoff's calendar date was silently
    // dropped because string comparison treated space-separated "2026-06-06 22:11:17" as
    // less than the ISO cutoff "2026-06-06T..." (space 0x20 < T 0x54).
    // The service now normalizes to ISO 8601, so the handler receives an ISO string and
    // must compare it correctly as a Date.
    const hoursAgo35 = new Date(Date.now() - 35 * 60 * 60 * 1000).toISOString();
    const hoursAgo2 = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const alerts: SpaceWeatherAlert[] = [
      makeAlert({ productType: 'Watch', issueDatetime: hoursAgo35 }), // should be included at 48h window
      makeAlert({ productType: 'Warning', issueDatetime: hoursAgo2 }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: true, max_age_hours: 48 });
    const result = await getAlerts.handler(input, ctx);

    // Both alerts are within the 48h window; both must be returned.
    expect(result.totalCount).toBe(2);
    expect(result.alerts.some((a) => a.issueDatetime === hoursAgo35)).toBe(true);
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
      makeAlert({
        productId: 'K07A',
        messageCode: 'ALTK07',
        productType: 'Alert',
        level: 3,
        noaaScale: 'G3',
        issueDatetime: recent,
      }),
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
          productId: 'K05W',
          messageCode: 'WARK05',
          productType: 'Warning' as const,
          level: 1,
          noaaScale: 'G1',
          cancelled: false,
          phenomenon: 'Geomagnetic',
          issueDatetime: '2026-06-04T12:00:00Z',
          validFrom: '2026-06-04T12:00:00Z',
          validTo: '2026-06-04T23:59:00Z',
          message: 'K-index of 5 expected.',
        },
      ],
      totalCount: 1,
      fetchedAt: '2026-06-04T15:00:00.000Z',
    };
    const blocks = getAlerts.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Warning');
    expect(text).toContain('Geomagnetic');
    expect(text).toContain('WARK05'); // full message code
    expect(text).toContain('K05W'); // short feed ID
    expect(text).toContain('K-index of 5 expected.');
    expect(text).toContain('**Total:** 1');
    // The scale letter rides alongside the numeric level; clients that render only
    // content[] must not lose it (#18).
    expect(text).toContain('**Level:** 1 (G1)');
    expect(text).not.toContain('CANCELLED');
  });

  it('format marks cancellations and spells out a scale-less product (#18, #19)', () => {
    const output = {
      alerts: [
        {
          productId: 'EF3A',
          messageCode: 'ALTEF3',
          productType: 'Alert' as const,
          level: 0,
          noaaScale: null,
          cancelled: true,
          phenomenon: 'Space Weather',
          issueDatetime: '2026-07-07T05:06:59Z',
          validFrom: null,
          validTo: null,
          message: 'CANCEL ALERT: Electron 2MeV Integral Flux exceeded 1000pfu',
        },
      ],
      totalCount: 1,
      fetchedAt: '2026-07-07T06:00:00.000Z',
    };
    const text = (getAlerts.format!(output)[0] as { text: string }).text;

    // A cancellation keeps its original product type, so the heading is the only place
    // a content[]-only client can learn it is not in force.
    expect(text).toContain('[Alert · CANCELLED]');
    // A bare "Level: 0" reads as calm; it must say the product states no scale.
    expect(text).toContain('**Level:** 0 (no NOAA scale)');
  });
});
