/**
 * @fileoverview Tests for the noaa_spaceweather_get_alerts tool.
 * @module tests/tools/get-alerts.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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
    cancelsSerialNumber: null,
    cancelsOriginalIssueDatetime: null,
    serialNumber: '5359',
    supersedes: false,
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

/** Sum of every per-reason exclusion count on an enrichment payload. */
function excludedTotal(enrichment: Record<string, unknown>): number {
  const counts = enrichment.exclusions as Record<string, number> | undefined;
  return counts ? Object.values(counts).reduce((sum, n) => sum + n, 0) : 0;
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
      // Watch whose body states no end and whose predicted-day list yielded none
      // (an all-None outlook) — nothing says it has finished, so it is kept.
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
    // in-force records either side of the cancellation. The cancellation names serial
    // 3709, so that record drops and the later 3711 survives under the same code.
    const t = (minsAgo: number) => new Date(Date.now() - minsAgo * 60 * 1000).toISOString();
    const firstIssue = t(30);
    const alerts: SpaceWeatherAlert[] = [
      // Earlier record under the same code with a serial the cancellation does not name —
      // a cancellation resolves to one target, so this must survive alongside the later one.
      makeAlert({
        productId: 'EF3A-pre',
        messageCode: 'ALTEF3',
        productType: 'Alert',
        serialNumber: '3708',
        issueDatetime: t(35),
        validTo: null,
      }),
      makeAlert({
        productId: 'EF3A-a',
        messageCode: 'ALTEF3',
        productType: 'Alert',
        serialNumber: '3709',
        issueDatetime: firstIssue,
        validTo: null,
      }),
      makeAlert({
        productId: 'EF3A-b',
        messageCode: 'ALTEF3',
        productType: 'Alert',
        cancelled: true,
        serialNumber: '3710',
        cancelsSerialNumber: '3709',
        cancelsOriginalIssueDatetime: firstIssue,
        issueDatetime: t(26),
        validTo: null,
      }),
      // Continuation of the cancelled serial — a link, never a cancellation.
      makeAlert({
        productId: 'EF3A-c',
        messageCode: 'ALTEF3',
        productType: 'Alert',
        serialNumber: '3711',
        issueDatetime: t(25),
        validTo: null,
      }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: true });
    const result = await getAlerts.handler(input, ctx);

    // Per record, never per code: only the named serial and the cancellation itself go,
    // leaving the in-force records on both sides of the cancellation.
    expect(result.alerts.map((a) => a.productId)).toEqual(['EF3A-pre', 'EF3A-c']);
  });

  it('active_only=true drops a product a later record cancels by serial, future validTo and all', async () => {
    const t = (minsAgo: number) => new Date(Date.now() - minsAgo * 60 * 1000).toISOString();
    const futureValidTo = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const originalIssue = t(60);
    const alerts: SpaceWeatherAlert[] = [
      // Warning whose own end has not passed — only the cancellation naming it can drop it.
      makeAlert({
        productId: 'K05W',
        messageCode: 'WARK05',
        serialNumber: '2249',
        issueDatetime: originalIssue,
        validTo: futureValidTo,
      }),
      makeAlert({
        productId: 'K05W-cancel',
        messageCode: 'WARK05',
        cancelled: true,
        serialNumber: '2250',
        cancelsSerialNumber: '2249',
        cancelsOriginalIssueDatetime: originalIssue,
        issueDatetime: t(10),
        validTo: null,
      }),
      // Same serial under a different message code — serials are per-code counters,
      // so this record is untouched by that cancellation.
      makeAlert({
        productId: 'K04W',
        messageCode: 'WARK04',
        serialNumber: '2249',
        issueDatetime: originalIssue,
        validTo: futureValidTo,
      }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: true });
    const result = await getAlerts.handler(input, ctx);

    expect(result.alerts.map((a) => a.productId)).toEqual(['K04W']);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.exclusions).toMatchObject({ cancelledBySerial: 1, cancellationRecord: 1 });
  });

  it('cancels the reissue the Original Issue Time names when a serial repeats in a code', async () => {
    // SWPC reuses a serial within a code on a corrected reissue, so the serial alone is
    // ambiguous; "Original Issue Time:" is what picks the record the cancellation means.
    const t = (minsAgo: number) => new Date(Date.now() - minsAgo * 60 * 1000).toISOString();
    const firstIssue = t(600);
    const alerts: SpaceWeatherAlert[] = [
      makeAlert({
        productId: 'A30F-first',
        messageCode: 'WATA30',
        productType: 'Watch',
        serialNumber: '280',
        issueDatetime: firstIssue,
        validTo: null,
      }),
      makeAlert({
        productId: 'A30F-corrected',
        messageCode: 'WATA30',
        productType: 'Watch',
        serialNumber: '280',
        issueDatetime: t(500),
        validTo: null,
      }),
      makeAlert({
        productId: 'A30F-cancel',
        messageCode: 'WATA30',
        productType: 'Watch',
        cancelled: true,
        serialNumber: '282',
        cancelsSerialNumber: '280',
        cancelsOriginalIssueDatetime: firstIssue,
        issueDatetime: t(10),
        validTo: null,
      }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: true, max_age_hours: 720 });
    const result = await getAlerts.handler(input, ctx);

    expect(result.alerts.map((a) => a.productId)).toEqual(['A30F-corrected']);
  });

  it('excludes products older than max_age_hours once nothing keeps them in force', async () => {
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(); // 72h ago
    const elapsed = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // ended 24h ago
    const alerts: SpaceWeatherAlert[] = [
      makeAlert({ productId: 'RECW', productType: 'Warning', issueDatetime: recent }),
      // Issued outside the window with an end that has already passed — nothing in the
      // feed says it is still in force, so the window is what drops it.
      makeAlert({
        productId: 'OLDW',
        productType: 'Warning',
        issueDatetime: old,
        validTo: elapsed,
      }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: true, max_age_hours: 48 });
    const result = await getAlerts.handler(input, ctx);

    expect(result.alerts.map((a) => a.productId)).toEqual(['RECW']);
    expect(getEnrichment(ctx).exclusions).toMatchObject({ agedOut: 1 });
  });

  it('active_only=true keeps a Watch whose last storm day has not ended, however old the issue', async () => {
    // max_age_hours bounds how far back to look for candidates; it is not itself a
    // statement about whether a product is in force (the 48 h default would otherwise
    // drop a Watch hours before the storm day it forecasts finishes).
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const futureEnd = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const alerts: SpaceWeatherAlert[] = [
      makeAlert({
        productId: 'A20F',
        messageCode: 'WATA20',
        productType: 'Watch',
        level: 1,
        noaaScale: 'G1',
        serialNumber: '1125',
        issueDatetime: old,
        validFrom: null,
        validTo: futureEnd,
      }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: true, max_age_hours: 48 });
    const result = await getAlerts.handler(input, ctx);

    expect(result.alerts.map((a) => a.productId)).toEqual(['A20F']);
    expect(getEnrichment(ctx).exclusions).toBeUndefined();
  });

  it('active_only=false cuts at exactly max_age_hours, future validity end or not', async () => {
    // The recency override belongs to the in-force question. With active_only=false the
    // window is a literal history window and must not be widened by it.
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const futureEnd = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const alerts: SpaceWeatherAlert[] = [
      makeAlert({
        productId: 'A20F',
        messageCode: 'WATA20',
        productType: 'Watch',
        issueDatetime: old,
        validTo: futureEnd,
      }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: false, max_age_hours: 48 });
    const result = await getAlerts.handler(input, ctx);

    expect(result.totalCount).toBe(0);
  });

  it('active_only=true drops a Watch whose last storm day has ended, inside the window or not', async () => {
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const elapsedEnd = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const alerts: SpaceWeatherAlert[] = [
      makeAlert({
        productId: 'A20F',
        messageCode: 'WATA20',
        productType: 'Watch',
        issueDatetime: recent,
        validFrom: null,
        validTo: elapsedEnd,
      }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: true, max_age_hours: 48 });
    const result = await getAlerts.handler(input, ctx);

    expect(result.totalCount).toBe(0);
    expect(getEnrichment(ctx).exclusions).toMatchObject({ validityElapsed: 1 });
  });

  it('active_only=true keeps only the newest record carrying the supersede line, across codes', async () => {
    // The line says any and all prior watches, and the live products are sequential
    // revisions of one three-day forecast — scoping the rule per message code returns
    // two conflicting outlooks for the same day.
    const t = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
    const futureEnd = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const watch = (productId: string, messageCode: string, hoursAgo: number) =>
      makeAlert({
        productId,
        messageCode,
        productType: 'Watch',
        supersedes: true,
        issueDatetime: t(hoursAgo),
        validFrom: null,
        validTo: futureEnd,
      });
    const alerts: SpaceWeatherAlert[] = [
      watch('A20F-new', 'WATA20', 2),
      watch('A20F-old', 'WATA20', 30),
      watch('A30F-old', 'WATA30', 20),
      // A Watch carrying no supersede line — same product class as the three above, so
      // only the line separates it from them, and this rule must not touch it.
      makeAlert({
        productId: 'A30F-no-line',
        messageCode: 'WATA30',
        productType: 'Watch',
        issueDatetime: t(3),
        validFrom: null,
        validTo: futureEnd,
      }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: true, max_age_hours: 720 });
    const result = await getAlerts.handler(input, ctx);

    expect(result.alerts.map((a) => a.productId).sort()).toEqual(['A20F-new', 'A30F-no-line']);
    expect(getEnrichment(ctx).exclusions).toMatchObject({ superseded: 2 });
  });

  it('does not let a record with an unreadable issue time win the supersede comparison', async () => {
    // A record whose issue_datetime the feed omitted reaches the handler as "Z" — what
    // normalizeSwpcTime() emits for an empty value — which Date.parse reads as NaN. Every
    // "newer than" comparison against NaN is false, so an unseeded reduce would leave that
    // record standing as the newest carrier and supersede both genuine Watches behind it.
    const t = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
    const futureEnd = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const watch = (productId: string, issueDatetime: string) =>
      makeAlert({
        productId,
        messageCode: 'WATA20',
        productType: 'Watch',
        supersedes: true,
        issueDatetime,
        validFrom: null,
        // A future end keeps it out of the aged-out branch, so the supersede rule is the
        // only thing deciding which of the three survives.
        validTo: futureEnd,
      });
    const alerts: SpaceWeatherAlert[] = [
      watch('A20F-undated', 'Z'),
      watch('A20F-old', t(20)),
      watch('A20F-new', t(2)),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: true, max_age_hours: 720 });
    const result = await getAlerts.handler(input, ctx);

    // The newest readable carrier is the one in force; the undated record sorts oldest.
    expect(result.alerts.map((a) => a.productId)).toEqual(['A20F-new']);
    expect(getEnrichment(ctx).exclusions).toMatchObject({ superseded: 2 });
  });

  it('attributes every excluded record to one reason, summing with the returned set', async () => {
    const t = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
    const futureEnd = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const elapsedEnd = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const targetIssue = t(2);
    const alerts: SpaceWeatherAlert[] = [
      // Returned.
      makeAlert({ productId: 'KEEP', issueDatetime: t(1), validTo: futureEnd }),
      // agedOut — outside the window with nothing holding it in force.
      makeAlert({ productId: 'AGED', issueDatetime: t(100), validTo: elapsedEnd }),
      // productType — a Summary is never in force.
      makeAlert({
        productId: 'SUMS',
        productType: 'Summary',
        phenomenon: 'Space Weather',
        issueDatetime: t(1),
      }),
      // cancellationRecord — the cancellation itself.
      makeAlert({
        productId: 'CANC',
        messageCode: 'WARK05',
        cancelled: true,
        serialNumber: '2250',
        cancelsSerialNumber: '2249',
        cancelsOriginalIssueDatetime: targetIssue,
        issueDatetime: t(1),
        validTo: null,
      }),
      // validityElapsed — inside the window, own end already passed.
      makeAlert({ productId: 'ENDD', issueDatetime: t(1), validTo: elapsedEnd }),
      // cancelledBySerial — named by CANC above.
      makeAlert({
        productId: 'TARG',
        messageCode: 'WARK05',
        serialNumber: '2249',
        issueDatetime: targetIssue,
        validTo: futureEnd,
      }),
      // superseded — older of two supersede-line carriers.
      makeAlert({
        productId: 'SUP-old',
        messageCode: 'WATA20',
        productType: 'Watch',
        supersedes: true,
        issueDatetime: t(5),
        validTo: futureEnd,
      }),
      makeAlert({
        productId: 'SUP-new',
        messageCode: 'WATA20',
        productType: 'Watch',
        supersedes: true,
        issueDatetime: t(2),
        validTo: futureEnd,
      }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: true, max_age_hours: 48 });
    const result = await getAlerts.handler(input, ctx);

    expect(result.alerts.map((a) => a.productId).sort()).toEqual(['KEEP', 'SUP-new']);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.exclusions).toEqual({
      agedOut: 1,
      productType: 1,
      cancellationRecord: 1,
      validityElapsed: 1,
      cancelledBySerial: 1,
      superseded: 1,
    });
    // Every record the feed offered is either returned or attributed exactly once.
    expect(excludedTotal(enrichment) + result.totalCount).toBe(alerts.length);
  });

  it('attributes a stale-and-replaced record to the replacement, not to elapsed validity', async () => {
    // The overlap the live feed always produces: a superseded Watch has normally
    // outlived its own forecast days too, and a cancelled product's window has usually
    // closed by the time anyone asks. Ranking elapsed validity first would report the
    // whole Watch chain as merely stale and never say a newer forecast replaced it.
    const t = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
    const elapsedEnd = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const futureEnd = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const targetIssue = t(40);
    const alerts: SpaceWeatherAlert[] = [
      // Superseded AND elapsed.
      makeAlert({
        productId: 'A20F-old',
        messageCode: 'WATA20',
        productType: 'Watch',
        supersedes: true,
        issueDatetime: t(30),
        validTo: elapsedEnd,
      }),
      makeAlert({
        productId: 'A20F-new',
        messageCode: 'WATA20',
        productType: 'Watch',
        supersedes: true,
        issueDatetime: t(2),
        validTo: futureEnd,
      }),
      // Cancelled by serial AND elapsed.
      makeAlert({
        productId: 'K05W',
        messageCode: 'WARK05',
        serialNumber: '2249',
        issueDatetime: targetIssue,
        validTo: elapsedEnd,
      }),
      makeAlert({
        productId: 'K05W-cancel',
        messageCode: 'WARK05',
        cancelled: true,
        serialNumber: '2250',
        cancelsSerialNumber: '2249',
        cancelsOriginalIssueDatetime: targetIssue,
        issueDatetime: t(1),
        validTo: null,
      }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: true, max_age_hours: 720 });
    const result = await getAlerts.handler(input, ctx);

    expect(result.alerts.map((a) => a.productId)).toEqual(['A20F-new']);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.exclusions).toMatchObject({
      superseded: 1,
      cancelledBySerial: 1,
      cancellationRecord: 1,
      validityElapsed: 0,
    });
    expect(excludedTotal(enrichment) + result.totalCount).toBe(alerts.length);
  });

  it('echoes the applied window under active_only=true and emits no counts when nothing is filtered', async () => {
    const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const svc = { getAlerts: vi.fn().mockResolvedValue([makeAlert({ issueDatetime: recent })]) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: true, max_age_hours: 12 });
    await getAlerts.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.appliedWindowHours).toBe(12);
    expect(new Date(enrichment.appliedCutoff as string).getTime()).toBeLessThan(Date.now());
    expect(enrichment.exclusions).toBeUndefined();
  });

  it('emits no window echo or exclusion counts under active_only=false', async () => {
    const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const alerts: SpaceWeatherAlert[] = [
      makeAlert({ issueDatetime: recent }),
      makeAlert({ productId: 'SUMS', productType: 'Summary', issueDatetime: recent }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const input = getAlerts.input.parse({ active_only: false });
    await getAlerts.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.exclusions).toBeUndefined();
    expect(enrichment.appliedWindowHours).toBeUndefined();
    expect(enrichment.appliedCutoff).toBeUndefined();
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

  it('states an empty result differently per active_only, on both surfaces', async () => {
    // The rendered line and the notice are the two halves of the same answer; a request
    // that was not scoped to in-force products must not be reported as if it were.
    const svc = { getAlerts: vi.fn().mockResolvedValue([]) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const activeCtx = createMockContext({ errors: getAlerts.errors });
    const activeResult = await getAlerts.handler(
      getAlerts.input.parse({ active_only: true }),
      activeCtx,
    );
    const allCtx = createMockContext({ errors: getAlerts.errors });
    const allResult = await getAlerts.handler(
      getAlerts.input.parse({ active_only: false }),
      allCtx,
    );

    // structuredContent — the enrichment notice rides here alongside the domain fields.
    const activeNotice = getEnrichment(activeCtx).notice as string;
    const allNotice = getEnrichment(allCtx).notice as string;
    expect(activeNotice).not.toBe(allNotice);
    expect(activeNotice).toContain('active');
    expect(allNotice).not.toContain('active');

    // content[] — format() renders the same distinction for clients that read only text.
    const activeText = (getAlerts.format!(activeResult)[0] as { text: string }).text;
    const allText = (getAlerts.format!(allResult)[0] as { text: string }).text;
    expect(activeText).toContain('_No active alerts._');
    expect(allText).not.toContain('_No active alerts._');
    expect(allText).toContain('requested window');
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
          serialNumber: '2249',
          phenomenon: 'Geomagnetic',
          issueDatetime: '2026-06-04T12:00:00Z',
          validFrom: '2026-06-04T12:00:00Z',
          validTo: '2026-06-04T23:59:00Z',
          message: 'K-index of 5 expected.',
        },
      ],
      totalCount: 1,
      activeOnly: true,
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
    // The serial is what makes a cancellation or continuation link navigable, so a
    // content[]-only client needs it too.
    expect(text).toContain('2249');
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
          serialNumber: null,
          phenomenon: 'Space Weather',
          issueDatetime: '2026-07-07T05:06:59Z',
          validFrom: null,
          validTo: null,
          message: 'CANCEL ALERT: Electron 2MeV Integral Flux exceeded 1000pfu',
        },
      ],
      totalCount: 1,
      activeOnly: false,
      fetchedAt: '2026-07-07T06:00:00.000Z',
    };
    const text = (getAlerts.format!(output)[0] as { text: string }).text;

    // A cancellation keeps its original product type, so the heading is the only place
    // a content[]-only client can learn it is not in force.
    expect(text).toContain('[Alert · CANCELLED]');
    // A bare "Level: 0" reads as calm; it must say the product states no scale.
    expect(text).toContain('**Level:** 0 (no NOAA scale)');
  });

  it('exposes the serial number on every returned record', async () => {
    const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const alerts: SpaceWeatherAlert[] = [
      makeAlert({ productId: 'K05W', serialNumber: '2249', issueDatetime: recent }),
      // A body with no "Serial Number:" line carries null rather than a stand-in.
      makeAlert({ productId: 'NOSN', serialNumber: null, issueDatetime: recent }),
    ];
    const svc = { getAlerts: vi.fn().mockResolvedValue(alerts) };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getAlerts.errors });
    const result = await getAlerts.handler(getAlerts.input.parse({}), ctx);

    expect(result.alerts.map((a) => a.serialNumber)).toEqual(['2249', null]);
  });
});
