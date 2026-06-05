/**
 * @fileoverview Service-level tests for SpaceWeatherService — exercises the raw feed
 * parsing logic that tool-level tests skip (tool tests mock the whole service).
 * @module tests/services/space-weather-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the framework fetch utility so tests run without a live SWPC endpoint.
vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  fetchWithTimeout: vi.fn(),
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { SpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

const mockFetch = vi.mocked(fetchWithTimeout);

function makeService(): SpaceWeatherService {
  return new SpaceWeatherService({} as never, {} as never);
}

function makeResponse(body: unknown): Response {
  return {
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('SpaceWeatherService.getAlerts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('parses product type from message-body code, not from product_id', async () => {
    // Real feed shape: product_id is a short code like "K04W";
    // the full type prefix (WAR/WAT/ALT/SUM) is in the message body.
    const rawAlerts = [
      {
        product_id: 'K04W',
        issue_datetime: '2026-06-05 04:35:00.000',
        message:
          'Space Weather Message Code: WARK04\r\nSerial Number: 5359\r\nIssue Time: 2026 Jun 05 0435 UTC\r\n\r\nWARNING: Geomagnetic K-index of 4 expected\r\nValid From: 2026 Jun 05 0434 UTC\r\nValid To: 2026 Jun 06 0300 UTC\r\n',
      },
      {
        product_id: 'A50F',
        issue_datetime: '2026-06-03 14:52:00.000',
        message:
          'Space Weather Message Code: WATA50\r\nSerial Number: 98\r\nIssue Time: 2026 Jun 03 1452 UTC\r\n\r\nWATCH: Geomagnetic Storm Category G3 Predicted\r\nValid From: 2026 Jun 03 1452 UTC\r\nValid To: 2026 Jun 07 0000 UTC\r\n',
      },
      {
        product_id: 'K04A',
        issue_datetime: '2026-05-30 20:36:00.000',
        message:
          'Space Weather Message Code: ALTK04\r\nSerial Number: 2663\r\nIssue Time: 2026 May 30 2036 UTC\r\n\r\nALERT: Geomagnetic K-index of 4\r\n',
      },
      {
        product_id: 'MSIS',
        issue_datetime: '2026-06-05 05:13:00.000',
        message:
          'Space Weather Message Code: SUMSUD\r\nSerial Number: 300\r\nIssue Time: 2026 Jun 05 0513 UTC\r\n\r\nSUMMARY: Geomagnetic Sudden Impulse\r\n',
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(rawAlerts));

    const svc = makeService();
    const ctx = createMockContext();
    const alerts = await svc.getAlerts(ctx as never);

    // Verify product type correctly parsed from message-body code
    expect(alerts[0]!.productType).toBe('Warning');
    expect(alerts[1]!.productType).toBe('Watch');
    expect(alerts[2]!.productType).toBe('Alert');
    expect(alerts[3]!.productType).toBe('Summary');

    // Verify productId preserves original short code
    expect(alerts[0]!.productId).toBe('K04W');

    // Verify phenomenon parsed from message code suffix
    expect(alerts[0]!.phenomenon).toBe('Geomagnetic'); // WARK04 → core='K04' → Geomagnetic

    // Verify level parsed from numeric suffix of the full code
    expect(alerts[0]!.level).toBe(4); // WARK04 → 04

    // Verify validFrom/validTo extracted
    expect(alerts[0]!.validFrom).toBe('2026 Jun 05 0434 UTC');
    expect(alerts[0]!.validTo).toBe('2026 Jun 06 0300 UTC');
  });

  it('falls back to product_id parsing when message has no message-code line', async () => {
    const rawAlerts = [
      {
        product_id: 'OTHER',
        issue_datetime: '2026-06-05 00:00:00.000',
        message: 'Some advisory without a standard header.',
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(rawAlerts));

    const svc = makeService();
    const ctx = createMockContext();
    const alerts = await svc.getAlerts(ctx as never);

    // Falls back to product_id — "OTHER" doesn't match any prefix → 'Other'
    expect(alerts[0]!.productType).toBe('Other');
  });
});

describe('SpaceWeatherService.getSolarWindPlasma (array-of-arrays)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('normalizes array-of-arrays feed: header row becomes field names, data rows become objects; space-separated time tags become ISO 8601 UTC', async () => {
    // SWPC plasma feed uses "YYYY-MM-DD HH:MM:SS.mmm" (space separator, no Z).
    // Service must normalize these to "YYYY-MM-DDTHH:MM:SS.mmmZ" to prevent
    // Node.js from interpreting them as local time during Date parsing.
    const raw = [
      ['time_tag', 'density', 'speed', 'temperature'],
      ['2026-06-05 06:00:00.000', '5.2', '420.1', '80000'],
      ['2026-06-05 06:01:00.000', '5.5', '421.0', '81000'],
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));

    const svc = makeService();
    const ctx = createMockContext();
    const plasma = await svc.getSolarWindPlasma(ctx as never);

    // Must have 2 data rows, not 3 (header row must NOT appear as a data row)
    expect(plasma).toHaveLength(2);
    // Time tags must be normalized to ISO 8601 UTC
    expect(plasma[0]!.timeTag).toBe('2026-06-05T06:00:00.000Z');
    expect(plasma[0]!.densityPerCm3).toBe(5.2);
    expect(plasma[0]!.speedKmS).toBe(420.1);
    expect(plasma[0]!.temperatureK).toBe(80000);
  });

  it('returns null for fill-value (-9999) fields', async () => {
    const raw = [
      ['time_tag', 'density', 'speed', 'temperature'],
      ['2026-06-05 06:00:00.000', '-9999.0', '-9999.0', '-9999.0'], // fill values
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));

    const svc = makeService();
    const ctx = createMockContext();
    const plasma = await svc.getSolarWindPlasma(ctx as never);

    expect(plasma[0]!.densityPerCm3).toBeNull();
    expect(plasma[0]!.speedKmS).toBeNull();
    expect(plasma[0]!.temperatureK).toBeNull();
  });
});

describe('SpaceWeatherService.getSolarRegions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('normalizes numeric latitude to heliographic string (live feed returns integers, not strings)', async () => {
    // Live feed returns latitude as a bare integer (e.g. 17), not "N17" as
    // originally specified — the service must convert to heliographic string.
    const raw = [
      {
        observed_date: '2026-06-04',
        region: 4462,
        latitude: 17, // numeric — should become "N17"
        longitude: 47, // numeric longitude (not used in output directly)
        location: 'N17E47',
        area: 40,
        spot_class: 'Dao',
        number_spots: 12,
        mag_class: 'B',
        c_flare_probability: 25,
        m_flare_probability: 5,
        x_flare_probability: 1,
        proton_probability: 1,
      },
      {
        observed_date: '2026-06-04',
        region: 4461,
        latitude: -12, // southern hemisphere — should become "S12"
        longitude: 100,
        location: 'S12W100',
        area: 20,
        spot_class: 'Bxo',
        number_spots: 5,
        mag_class: 'A',
        c_flare_probability: 5,
        m_flare_probability: 1,
        x_flare_probability: 0,
        proton_probability: 0,
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));

    const svc = makeService();
    const ctx = createMockContext();
    const regions = await svc.getSolarRegions(ctx as never);

    expect(regions[0]!.latitude).toBe('N17');
    expect(regions[1]!.latitude).toBe('S12');
    expect(regions[0]!.region).toBe(4462);
    expect(regions[0]!.location).toBe('N17E47');
    expect(regions[0]!.cFlareProbability).toBe(25);
  });
});

describe('SpaceWeatherService.getSolarWindMag (array-of-arrays)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('normalizes mag feed header row and parses all Bz/Bt/Bx/By fields; normalizes space-separated time tags', async () => {
    const raw = [
      ['time_tag', 'bx_gsm', 'by_gsm', 'bz_gsm', 'lon_gsm', 'lat_gsm', 'bt'],
      ['2026-06-05 06:00:00.000', '1.1', '2.2', '-8.5', '10.0', '5.0', '9.0'],
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));

    const svc = makeService();
    const ctx = createMockContext();
    const mag = await svc.getSolarWindMag(ctx as never);

    expect(mag).toHaveLength(1);
    expect(mag[0]!.timeTag).toBe('2026-06-05T06:00:00.000Z'); // normalized from space-separated
    expect(mag[0]!.bxGsm).toBe(1.1);
    expect(mag[0]!.byGsm).toBe(2.2);
    expect(mag[0]!.bzGsm).toBe(-8.5);
    expect(mag[0]!.bt).toBe(9.0);
  });
});
