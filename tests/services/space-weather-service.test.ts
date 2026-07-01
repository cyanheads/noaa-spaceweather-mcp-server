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

    // Verify messageCode carries the full parsed Space Weather Message Code (#14)
    expect(alerts[0]!.messageCode).toBe('WARK04');
    expect(alerts[1]!.messageCode).toBe('WATA50');
    expect(alerts[2]!.messageCode).toBe('ALTK04');
    expect(alerts[3]!.messageCode).toBe('SUMSUD');

    // Verify phenomenon parsed from message code suffix
    expect(alerts[0]!.phenomenon).toBe('Geomagnetic'); // WARK04 → core='K04' → Geomagnetic

    // Verify level parsed from numeric suffix of the full code
    expect(alerts[0]!.level).toBe(4); // WARK04 → 04

    // Verify validFrom/validTo extracted and normalized to ISO 8601 UTC
    expect(alerts[0]!.validFrom).toBe('2026-06-05T04:34:00Z');
    expect(alerts[0]!.validTo).toBe('2026-06-06T03:00:00Z');

    // Verify space-separated issue datetime (with fractional seconds) normalized to UTC (#13)
    expect(alerts[0]!.issueDatetime).toBe('2026-06-05T04:35:00.000Z');
  });

  it('parses the validity window from every SWPC label variant, normalized to ISO 8601 (#10)', async () => {
    const rawAlerts = [
      {
        // Extended Warning — expiry under "Now Valid Until:", not "Valid To:".
        product_id: 'K04W',
        issue_datetime: '2026-06-13 23:56:00.000',
        message:
          'Space Weather Message Code: WARK04\r\nSerial Number: 5365\r\nIssue Time: 2026 Jun 13 2356 UTC\r\n\r\nEXTENDED WARNING: Geomagnetic K-index of 4 expected\r\nExtension to Serial Number: 5364\r\nValid From: 2026 Jun 13 0126 UTC\r\nNow Valid Until: 2026 Jun 14 0600 UTC\r\nWarning Condition: Persistence\r\n',
      },
      {
        // Summary — event window under "Begin Time:" / "End Time:"; "Maximum Time:" ignored.
        product_id: 'XM5S',
        issue_datetime: '2026-06-21 19:48:00.000',
        message:
          'Space Weather Message Code: SUMXM5\r\nSerial Number: 319\r\nIssue Time: 2026 Jun 21 1948 UTC\r\n\r\nSUMMARY: X-ray Event exceeded M5\r\nBegin Time: 2026 Jun 21 1917 UTC\r\nMaximum Time: 2026 Jun 21 1929 UTC\r\nEnd Time: 2026 Jun 21 1935 UTC\r\nXray Class: M6.8\r\n',
      },
      {
        // Alert with onset only — "Begin Time:" present, no end line → validTo null.
        product_id: 'TIIA',
        issue_datetime: '2026-06-21 19:51:00.000',
        message:
          'Space Weather Message Code: ALTTP2\r\nSerial Number: 1507\r\nIssue Time: 2026 Jun 21 1951 UTC\r\n\r\nALERT: Type II Radio Emission\r\nBegin Time: 2026 Jun 21 1932 UTC\r\nEstimate Velocity: 380 km/s\r\n',
      },
      {
        // Cancellation — no validity window; "Original Issue Time" must NOT read as a start.
        product_id: 'TIIA',
        issue_datetime: '2026-06-20 04:06:00.000',
        message:
          'Space Weather Message Code: ALTTP2\r\nSerial Number: 1505\r\nIssue Time: 2026 Jun 20 0406 UTC\r\n\r\nCANCEL ALERT: Type II Radio Emission\r\nCancel Serial Number: 1504\r\nOriginal Issue Time: 2026 Jun 20 0403 UTC\r\n',
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(rawAlerts));

    const svc = makeService();
    const ctx = createMockContext();
    const alerts = await svc.getAlerts(ctx as never);

    // Extended Warning — "Now Valid Until:" populates validTo (was always null before #10).
    expect(alerts[0]!.validFrom).toBe('2026-06-13T01:26:00Z');
    expect(alerts[0]!.validTo).toBe('2026-06-14T06:00:00Z');

    // Summary — "Begin Time:" / "End Time:" populate the window; "Maximum Time:" is not read.
    expect(alerts[1]!.validFrom).toBe('2026-06-21T19:17:00Z');
    expect(alerts[1]!.validTo).toBe('2026-06-21T19:35:00Z');

    // Alert with onset only — start populated, end stays null.
    expect(alerts[2]!.validFrom).toBe('2026-06-21T19:32:00Z');
    expect(alerts[2]!.validTo).toBeNull();

    // Cancellation — no validity lines; "Original Issue Time" is not a start.
    expect(alerts[3]!.validFrom).toBeNull();
    expect(alerts[3]!.validTo).toBeNull();
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
    // messageCode falls back to the short feed ID when no message-code line exists (#14)
    expect(alerts[0]!.messageCode).toBe('OTHER');
  });

  it('normalizes a space-separated issue datetime without fractional seconds to explicit UTC (#13)', async () => {
    const rawAlerts = [
      {
        product_id: 'K04W',
        issue_datetime: '2026-06-06 22:11:17', // space-separated, no milliseconds, no Z
        message: 'Space Weather Message Code: WARK04\r\nIssue Time: 2026 Jun 06 2211 UTC\r\n',
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(rawAlerts));

    const svc = makeService();
    const ctx = createMockContext();
    const alerts = await svc.getAlerts(ctx as never);

    expect(alerts[0]!.issueDatetime).toBe('2026-06-06T22:11:17Z');
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

describe('SpaceWeatherService Kp feeds (timeTag normalization #13)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('normalizes T-separated (no-Z) observed Kp time tags to explicit UTC', async () => {
    // Live Kp feed shape: "YYYY-MM-DDTHH:MM:SS" — T-separated but no trailing Z.
    const raw = [
      { time_tag: '2026-06-23T00:00:00', Kp: 2, a_running: 5, station_count: 8 },
      { time_tag: '2026-06-23T03:00:00', Kp: 3, a_running: 7, station_count: 8 },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));

    const svc = makeService();
    const ctx = createMockContext();
    const obs = await svc.getKpObserved(ctx as never);

    expect(obs[0]!.timeTag).toBe('2026-06-23T00:00:00Z');
    expect(obs[1]!.timeTag).toBe('2026-06-23T03:00:00Z');
    expect(obs.every((o) => o.timeTag.endsWith('Z'))).toBe(true);
  });

  it('leaves an already-Z observed Kp time tag unchanged (idempotent)', async () => {
    const raw = [{ time_tag: '2026-06-28T00:00:00Z', Kp: 2, a_running: 5, station_count: 8 }];
    mockFetch.mockResolvedValue(makeResponse(raw));

    const svc = makeService();
    const ctx = createMockContext();
    const obs = await svc.getKpObserved(ctx as never);

    expect(obs[0]!.timeTag).toBe('2026-06-28T00:00:00Z');
  });

  it('normalizes T-separated (no-Z) forecast Kp time tags to explicit UTC', async () => {
    const raw = [
      { time_tag: '2026-06-28T03:00:00', kp: 3.67, observed: 'estimated', noaa_scale: null },
      { time_tag: '2026-06-28T06:00:00', kp: 4, observed: 'predicted', noaa_scale: 'G0' },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));

    const svc = makeService();
    const ctx = createMockContext();
    const fc = await svc.getKpForecast(ctx as never);

    expect(fc[0]!.timeTag).toBe('2026-06-28T03:00:00Z');
    expect(fc[1]!.timeTag).toBe('2026-06-28T06:00:00Z');
    expect(fc.every((f) => f.timeTag.endsWith('Z'))).toBe(true);
  });
});
