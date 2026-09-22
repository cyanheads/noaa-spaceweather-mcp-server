/**
 * @fileoverview Service-level tests for SpaceWeatherService — exercises the raw feed
 * parsing logic that tool-level tests skip (tool tests mock the whole service).
 * @module tests/services/space-weather-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The signal the pass-through `withRetry` hands its one attempt, so a test can check
 * the request carries the attempt's signal rather than the handler's.
 */
const { ATTEMPT_SIGNAL } = vi.hoisted(() => ({ ATTEMPT_SIGNAL: new AbortController().signal }));

// Mock the framework fetch utility so tests run without a live SWPC endpoint. The retry
// loop itself runs for real in tests/services/feed-failure-contract.test.ts.
vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  fetchWithTimeout: vi.fn(),
  withRetry: vi.fn(
    async (fn: (attempt: { remainingMs: number; signal: AbortSignal }) => Promise<unknown>) =>
      fn({ signal: ATTEMPT_SIGNAL, remainingMs: Number.POSITIVE_INFINITY }),
  ),
}));

import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { kpToGScale, SpaceWeatherService } from '@/services/space-weather/space-weather-service.js';
import { SWPC_DISCUSSION } from '../fixtures/swpc-discussion.js';
import { SWPC_F107_FEED, SWPC_XRAY_FLARE_FEED } from '../fixtures/swpc-xray-flares.js';

const mockFetch = vi.mocked(fetchWithTimeout);

function makeService(version = '0.0.0-test'): SpaceWeatherService {
  // Only mcpServerVersion is read (to build the SWPC User-Agent); the rest of
  // AppConfig is irrelevant to this keyless feed client.
  return new SpaceWeatherService({ mcpServerVersion: version } as never, {} as never);
}

function makeResponse(body: unknown): Response {
  return {
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

/**
 * Response carrying a body verbatim. `makeResponse` serializes through
 * `JSON.stringify`, which emits `null` for every non-finite number, so it cannot
 * express the bare `NaN` / `Infinity` tokens SWPC occasionally sends (#25).
 */
function makeRawResponse(body: string): Response {
  return {
    text: () => Promise.resolve(body),
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

    // Phenomenon comes from the body's scale letter, falling back to the code (#18).
    expect(alerts[0]!.phenomenon).toBe('Geomagnetic'); // WARK04 → no scale line → code core 'K04'
    expect(alerts[1]!.phenomenon).toBe('Geomagnetic'); // WATA50 → headline "Category G3"

    // Level comes from the body's scale, never the code's numeric suffix (#18).
    expect(alerts[0]!.level).toBe(0); // WARK04 → no scale; K4 sits below the G-scale
    expect(alerts[1]!.level).toBe(3); // WATA50 → "Category G3", not the A-index 50

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
      {
        // Watch — no validity label at all; the end comes from the predicted-day list,
        // whose last non-None day is Sep 17, so the Watch runs to the end of that day.
        product_id: 'A20F',
        issue_datetime: '2026-09-15 17:37:51.220',
        message:
          'Space Weather Message Code: WATA20\r\nSerial Number: 1125\r\nIssue Time: 2026 Sep 15 1737 UTC\r\n\r\nWATCH: Geomagnetic Storm Category G1 Predicted \nHighest Storm Level Predicted by Day:\nSep 16:  G1 (Minor)   Sep 17:  G1 (Minor)   Sep 18:  None (Below G1)   \nTHIS SUPERSEDES ANY/ALL PRIOR WATCHES IN EFFECT\nComment: \n',
      },
      {
        // Watch cancellation — "Cancelled Level Predicted:" is a different header with
        // whitespace before each day's colon. It must never be read as a validity end.
        product_id: 'A30F',
        issue_datetime: '2026-09-09 21:01:32.307',
        message:
          'Space Weather Message Code: WATA30\r\nSerial Number: 282\r\nIssue Time: 2026 Sep 09 2101 UTC\r\n\r\nCANCEL WATCH: Geomagnetic Storm Category G2 Predicted \nCancel Serial Number: 281\nOriginal Issue Time: 2026 Sep 08 1702 UTC\nCancelled Level Predicted:\nSep 08  : None (Bellow G1)  Sep 09  : None (Bellow G1)  Sep 10  : None (Bellow G1)  \nConditions no longer warrant watch criteria.\n',
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

    // Watch — no validity label, so the end is derived from the predicted-day list:
    // the end of the last day forecasting a storm, not of the trailing None day.
    expect(alerts[4]!.validFrom).toBeNull();
    expect(alerts[4]!.validTo).toBe('2026-09-18T00:00:00Z');

    // Watch cancellation — "Cancelled Level Predicted:" yields no end.
    expect(alerts[5]!.validFrom).toBeNull();
    expect(alerts[5]!.validTo).toBeNull();
  });

  /**
   * A Watch states its coverage only as a per-day storm outlook, so the end instant
   * is derived rather than read off a label. Bodies are live-shaped: one header line
   * followed by one line of "<Mon> <DD>:  <Level> (<Descriptor>)" entries.
   */
  const DAY_LIST_CASES: {
    name: string;
    issueDatetime: string;
    issueTime: string;
    days: string;
    validTo: string | null;
  }[] = [
    {
      name: 'trailing None day is a forecast of quiet, not coverage',
      issueDatetime: '2026-09-15 17:37:51.220',
      issueTime: '2026 Sep 15 1737 UTC',
      days: 'Sep 16:  G1 (Minor)   Sep 17:  G1 (Minor)   Sep 18:  None (Below G1)   ',
      validTo: '2026-09-18T00:00:00Z',
    },
    {
      name: 'day list ending on a storm day runs to the end of that day',
      issueDatetime: '2026-09-15 17:37:51.220',
      issueTime: '2026 Sep 15 1737 UTC',
      days: 'Sep 16:  G1 (Minor)   Sep 17:  G1 (Minor)   Sep 18:  G2 (Moderate)   ',
      validTo: '2026-09-19T00:00:00Z',
    },
    {
      name: 'leading None days do not shorten the window',
      issueDatetime: '2026-07-10 19:46:00.000',
      issueTime: '2026 Jul 10 1946 UTC',
      days: 'Jul 11:  None (Below G1)   Jul 12:  G1 (Minor)   Jul 13:  None (Below G1)   ',
      validTo: '2026-07-13T00:00:00Z',
    },
    {
      name: 'an all-None list forecasts no storm at all',
      issueDatetime: '2026-07-10 19:46:00.000',
      issueTime: '2026 Jul 10 1946 UTC',
      days: 'Jul 11:  None (Below G1)   Jul 12:  None (Below G1)   Jul 13:  None (Below G1)   ',
      validTo: null,
    },
    {
      name: 'a December Watch listing January days rolls the year forward',
      issueDatetime: '2026-12-30 18:12:00.000',
      issueTime: '2026 Dec 30 1812 UTC',
      days: 'Dec 31:  G1 (Minor)   Jan 01:  G2 (Moderate)   Jan 02:  None (Below G1)   ',
      validTo: '2027-01-02T00:00:00Z',
    },
    {
      name: 'a year rollover with the storm day left in December stays in that year',
      issueDatetime: '2026-12-30 18:12:00.000',
      issueTime: '2026 Dec 30 1812 UTC',
      days: 'Dec 31:  G1 (Minor)   Jan 01:  None (Below G1)   Jan 02:  None (Below G1)   ',
      validTo: '2027-01-01T00:00:00Z',
    },
  ];

  it('derives a Watch validity end from the last non-None predicted day', async () => {
    mockFetch.mockResolvedValue(
      makeResponse(
        DAY_LIST_CASES.map((c, i) => ({
          product_id: 'A20F',
          issue_datetime: c.issueDatetime,
          message: `Space Weather Message Code: WATA20\r\nSerial Number: ${1100 + i}\r\nIssue Time: ${c.issueTime}\r\n\r\nWATCH: Geomagnetic Storm Category G1 Predicted \nHighest Storm Level Predicted by Day:\n${c.days}\nTHIS SUPERSEDES ANY/ALL PRIOR WATCHES IN EFFECT\nComment: \n`,
        })),
      ),
    );

    const svc = makeService();
    const ctx = createMockContext();
    const alerts = await svc.getAlerts(ctx as never);

    expect(alerts.map((a) => a.validTo)).toEqual(DAY_LIST_CASES.map((c) => c.validTo));
  });

  it('never lets a derived day-list end override a stated validity label', async () => {
    // A Watch carrying both a label and a day list must keep the label: SWPC states
    // the window directly when it has one, and the derivation is the fallback.
    const rawAlerts = [
      {
        product_id: 'A50F',
        issue_datetime: '2026-06-03 14:52:00.000',
        message:
          'Space Weather Message Code: WATA50\r\nSerial Number: 98\r\nIssue Time: 2026 Jun 03 1452 UTC\r\n\r\nWATCH: Geomagnetic Storm Category G3 Predicted\nValid From: 2026 Jun 03 1452 UTC\nValid To: 2026 Jun 07 0000 UTC\nHighest Storm Level Predicted by Day:\nJun 03:  G3 (Strong)   Jun 04:  G1 (Minor)   Jun 05:  None (Below G1)   \n',
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(rawAlerts));

    const svc = makeService();
    const ctx = createMockContext();
    const alerts = await svc.getAlerts(ctx as never);

    expect(alerts[0]!.validTo).toBe('2026-06-07T00:00:00Z');
  });

  it('parses the record own serial number, never a referenced one', async () => {
    const rawAlerts = [
      {
        // Plain record — its own serial and nothing else.
        product_id: 'K05W',
        issue_datetime: '2026-07-12 14:11:00.000',
        message:
          'Space Weather Message Code: WARK05\r\nSerial Number: 2249\r\nIssue Time: 2026 Jul 12 1411 UTC\r\n\r\nWARNING: Geomagnetic K-index of 5 expected \nValid From: 2026 Jul 12 1410 UTC\nValid To: 2026 Jul 13 2100 UTC\n',
      },
      {
        // Cancellation — "Cancel Serial Number" names its target, not itself.
        product_id: 'K05W',
        issue_datetime: '2026-07-12 21:01:57.203',
        message:
          'Space Weather Message Code: WARK05\r\nSerial Number: 2250\r\nIssue Time: 2026 Jul 12 2101 UTC\r\n\r\nCANCEL WARNING: Geomagnetic K-index of 5 expected \nCancel Serial Number: 2249\nOriginal Issue Time: 2026 Jul 12 1411 UTC\n',
      },
      {
        // Continuation — "Continuation of Serial Number" is a link, not this serial.
        product_id: 'EF3A',
        issue_datetime: '2026-07-07 05:07:12.617',
        message:
          'Space Weather Message Code: ALTEF3\r\nSerial Number: 3711\r\nIssue Time: 2026 Jul 07 0507 UTC\r\n\r\nCONTINUED ALERT: Electron 2MeV Integral Flux exceeded 1000pfu\nContinuation of Serial Number: 3710\n',
      },
      {
        // Extension — same, under the other link label.
        product_id: 'K04W',
        issue_datetime: '2026-07-15 08:53:00.000',
        message:
          'Space Weather Message Code: WARK04\r\nSerial Number: 5387\r\nIssue Time: 2026 Jul 15 0853 UTC\r\n\r\nEXTENDED WARNING: Geomagnetic K-index of 4 expected\nExtension to Serial Number: 5386\nNow Valid Until: 2026 Jul 15 1500 UTC\n',
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(rawAlerts));

    const svc = makeService();
    const ctx = createMockContext();
    const alerts = await svc.getAlerts(ctx as never);

    expect(alerts.map((a) => a.serialNumber)).toEqual(['2249', '2250', '3711', '5387']);
    // Only the cancellation links a cancelled serial; a continuation or extension link
    // means the product is still in force and must never read as one.
    expect(alerts.map((a) => a.cancelsSerialNumber)).toEqual([null, '2249', null, null]);
    expect(alerts[1]!.cancelsOriginalIssueDatetime).toBe('2026-07-12T14:11:00Z');
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
    // A body carrying no "Serial Number:" line has no serial to expose — the feed
    // offers no substitute, so it stays null rather than borrowing the product ID.
    expect(alerts[0]!.serialNumber).toBeNull();
  });

  /**
   * Bodies are excerpted verbatim from the live /products/alerts.json feed, trimmed of
   * the boilerplate "Potential Impacts" tail no parser reads. Together they cover every
   * message code the feed currently carries.
   */
  const DERIVATION_CASES: {
    code: string;
    productId: string;
    body: string;
    level: number;
    noaaScale: string | null;
    phenomenon: string;
  }[] = [
    {
      // Suffix "EF3" is an electron-flux threshold ID, not a severity.
      code: 'ALTEF3',
      productId: 'EF3A',
      body: 'Space Weather Message Code: ALTEF3\r\nSerial Number: 3716\r\nIssue Time: 2026 Jul 13 1027 UTC\r\n\r\nCONTINUED ALERT: Electron 2MeV Integral Flux exceeded 1000pfu\nContinuation of Serial Number: 3715\nBegin Time: 2026 Jul 10 1126 UTC\n',
      level: 0,
      noaaScale: null,
      phenomenon: 'Space Weather',
    },
    {
      // K4 is below the G-scale, so SWPC states no scale. The retained "NOAA Space
      // Weather Scale descriptions" boilerplate must not be mistaken for a scale line.
      code: 'ALTK04',
      productId: 'K04A',
      body: 'Space Weather Message Code: ALTK04\r\nSerial Number: 2675\r\nIssue Time: 2026 Jul 15 0558 UTC\r\n\r\nALERT: Geomagnetic K-index of 4 \nThreshold Reached: 2026 Jul 15 0554 UTC\nActive Warning: YES\r\n\r\nNOAA Space Weather Scale descriptions can be found at\r\nwww.swpc.noaa.gov/noaa-scales-explanation\r\n',
      level: 0,
      noaaScale: null,
      phenomenon: 'Geomagnetic',
    },
    {
      // "Noaa Scale:" — the lowercase label variant SWPC emits alongside "NOAA Scale:".
      code: 'ALTK05',
      productId: 'K05A',
      body: 'Space Weather Message Code: ALTK05\r\nSerial Number: 2039\r\nIssue Time: 2026 Jul 12 1503 UTC\r\n\r\nALERT: Geomagnetic K-index of 5 \nThreshold Reached: 2026 Jul 12 1459 UTC\nActive Warning: YES\nNoaa Scale: G1 - Minor\nComment: \r\n',
      level: 1,
      noaaScale: 'G1',
      phenomenon: 'Geomagnetic',
    },
    {
      code: 'ALTK06',
      productId: 'K06A',
      body: 'Space Weather Message Code: ALTK06\r\nSerial Number: 723\r\nIssue Time: 2026 Jul 04 1700 UTC\r\n\r\nALERT: Geomagnetic K-index of 6 \nNoaa Scale: G2 - Moderate\nComment: \r\n',
      level: 2,
      noaaScale: 'G2',
      phenomenon: 'Geomagnetic',
    },
    {
      code: 'ALTK07',
      productId: 'K07A',
      body: 'Space Weather Message Code: ALTK07\r\nSerial Number: 218\r\nIssue Time: 2026 Jul 04 0509 UTC\r\n\r\nALERT: Geomagnetic K-index of 7 \nNoaa Scale: G3 - Strong\nComment: \r\n\nNOAA Scale: G3 - Strong',
      level: 3,
      noaaScale: 'G3',
      phenomenon: 'Geomagnetic',
    },
    {
      // Suffix "TP2" is radio-burst Type II, not a severity.
      code: 'ALTTP2',
      productId: 'TIIA',
      body: 'Space Weather Message Code: ALTTP2\r\nSerial Number: 1515\r\nIssue Time: 2026 Jul 12 0211 UTC\r\n\r\nALERT: Type II Radio Emission \nBegin Time: 2026 Jul 12 0135 UTC\nEstimate Velocity: 678 km/s\n',
      level: 0,
      noaaScale: null,
      phenomenon: 'Space Weather',
    },
    {
      // Suffix "TP4" is radio-burst Type IV, not a severity.
      code: 'ALTTP4',
      productId: 'TIVA',
      body: 'Space Weather Message Code: ALTTP4\r\nSerial Number: 714\r\nIssue Time: 2026 Jul 12 0212 UTC\r\n\r\nALERT: Type IV Radio Emission \nBegin Time: 2026 Jul 12 0053 UTC\n',
      level: 0,
      noaaScale: null,
      phenomenon: 'Space Weather',
    },
    {
      // The code carries no digits at all; the scale line is the only severity signal.
      code: 'ALTXMF',
      productId: 'XM5A',
      body: 'Space Weather Message Code: ALTXMF\r\nSerial Number: 539\r\nIssue Time: 2026 Jul 05 1800 UTC\r\n\r\nALERT: X-Ray Flux exceeded M5 \nThreshold Reached: 2026 Jul 05 1758 UTC\nNoaa Scale: R2 - Moderate\nComment: \r\n',
      level: 2,
      noaaScale: 'R2',
      phenomenon: 'Radio Blackout',
    },
    {
      // Suffix "10R" is the 10cm wavelength, not a severity.
      code: 'SUM10R',
      productId: 'BHIS',
      body: 'Space Weather Message Code: SUM10R\r\nSerial Number: 922\r\nIssue Time: 2026 Jul 04 2115 UTC\r\n\r\nSUMMARY: 10cm Radio Burst \nBegin Time: 2026 Jul 04 2040 UTC\nPeak Flux: 890 sfu\n',
      level: 0,
      noaaScale: null,
      phenomenon: 'Space Weather',
    },
    {
      code: 'SUMX01',
      productId: 'XX0S',
      body: 'Space Weather Message Code: SUMX01\r\nSerial Number: 220\r\nIssue Time: 2026 Jul 04 2116 UTC\r\n\r\nSUMMARY: X-ray Event exceeded X1 \nXray Class: X1.3\nNoaa Scale: R3 - Strong\nComment: \r\n',
      level: 3,
      noaaScale: 'R3',
      phenomenon: 'Radio Blackout',
    },
    {
      code: 'SUMXM5',
      productId: 'XM5S',
      body: 'Space Weather Message Code: SUMXM5\r\nSerial Number: 324\r\nIssue Time: 2026 Jul 05 1809 UTC\r\n\r\nSUMMARY: X-ray Event exceeded M5 \nXray Class: M5.5\nNoaa Scale: R2 - Moderate\nComment: \r\n',
      level: 2,
      noaaScale: 'R2',
      phenomenon: 'Radio Blackout',
    },
    {
      // EXTENDED means still in force, and K4 states no scale.
      code: 'WARK04',
      productId: 'K04W',
      body: 'Space Weather Message Code: WARK04\r\nSerial Number: 5387\r\nIssue Time: 2026 Jul 15 0853 UTC\r\n\r\nEXTENDED WARNING: Geomagnetic K-index of 4 expected\nExtension to Serial Number: 5386\nValid From: 2026 Jul 15 0143 UTC\nNow Valid Until: 2026 Jul 15 1500 UTC\n',
      level: 0,
      noaaScale: null,
      phenomenon: 'Geomagnetic',
    },
    {
      code: 'WARK05',
      productId: 'K05W',
      body: 'Space Weather Message Code: WARK05\r\nSerial Number: 2249\r\nIssue Time: 2026 Jul 12 1411 UTC\r\n\r\nWARNING: Geomagnetic K-index of 5 expected \nValid From: 2026 Jul 12 1410 UTC\nValid To: 2026 Jul 13 2100 UTC\nNoaa Scale: G1 - Minor\nComment: \r\n',
      level: 1,
      noaaScale: 'G1',
      phenomenon: 'Geomagnetic',
    },
    {
      code: 'WARK06',
      productId: 'K06W',
      body: 'Space Weather Message Code: WARK06\r\nSerial Number: 665\r\nIssue Time: 2026 Jul 04 1357 UTC\r\n\r\nWARNING: Geomagnetic K-index of 6 expected \nNoaa Scale: G2 - Moderate\nComment: \r\n',
      level: 2,
      noaaScale: 'G2',
      phenomenon: 'Geomagnetic',
    },
    {
      code: 'WARK07',
      productId: 'K07W',
      body: 'Space Weather Message Code: WARK07\r\nSerial Number: 151\r\nIssue Time: 2026 Jul 04 0501 UTC\r\n\r\nWARNING: Geomagnetic K-index of 7 or greater expected \nNoaa Scale: G3 - Greater\nComment: \r\n',
      level: 3,
      noaaScale: 'G3',
      phenomenon: 'Geomagnetic',
    },
    {
      // The code's "PX1" suffix reads as level 1 by coincidence; the S1 scale is the
      // only reason this is Solar Radiation rather than the code-shaped "Space Weather".
      code: 'WARPX1',
      productId: 'P11W',
      body: 'Space Weather Message Code: WARPX1\r\nSerial Number: 626\r\nIssue Time: 2026 Jun 30 1600 UTC\r\n\r\nWARNING: Proton 10MeV Integral Flux above 10pfu expected \nValid From: 2026 Jun 30 1600 UTC\nNoaa Scale: S1 - Minor\nComment: \r\n',
      level: 1,
      noaaScale: 'S1',
      phenomenon: 'Solar Radiation',
    },
    {
      // "SUD" is Sudden Impulse — a geomagnetic product. Its leading S must not read
      // as the solar-radiation scale letter.
      code: 'WARSUD',
      productId: 'SGIW',
      body: 'Space Weather Message Code: WARSUD\r\nSerial Number: 256\r\nIssue Time: 2026 Jul 03 1138 UTC\r\n\r\nWARNING: Geomagnetic Sudden Impulse expected \nValid From: 2026 Jul 03 1157 UTC\nIp Shock: 2026-07-03 11:20\n',
      level: 0,
      noaaScale: null,
      phenomenon: 'Geomagnetic',
    },
    {
      // A-index watches state "Category G<n>" and carry no "NOAA Scale:" line at all.
      code: 'WATA20',
      productId: 'A20F',
      body: 'Space Weather Message Code: WATA20\r\nSerial Number: 1115\r\nIssue Time: 2026 Jul 10 1946 UTC\r\n\r\nWATCH: Geomagnetic Storm Category G1 Predicted \nHighest Storm Level Predicted by Day:\nJul 11:  None (Below G1)   Jul 12:  G1 (Minor)   Jul 13:  None (Below G1)   \n',
      level: 1,
      noaaScale: 'G1',
      phenomenon: 'Geomagnetic',
    },
    {
      // The per-day outlook line trails a lower G1; the headline Category must win.
      code: 'WATA30',
      productId: 'A30F',
      body: 'Space Weather Message Code: WATA30\r\nSerial Number: 278\r\nIssue Time: 2026 Jul 03 1123 UTC\r\n\r\nWATCH: Geomagnetic Storm Category G2 Predicted \nHighest Storm Level Predicted by Day:\nJul 03:  G2 (Moderate)   Jul 04:  G2 (Moderate)   Jul 05:  G1 (Minor)   \n',
      level: 2,
      noaaScale: 'G2',
      phenomenon: 'Geomagnetic',
    },
  ];

  it('derives level, noaaScale, and phenomenon from the message body for every live message code (#18)', async () => {
    mockFetch.mockResolvedValue(
      makeResponse(
        DERIVATION_CASES.map((c) => ({
          product_id: c.productId,
          issue_datetime: '2026-07-15 00:00:00.000',
          message: c.body,
        })),
      ),
    );

    const svc = makeService();
    const ctx = createMockContext();
    const alerts = await svc.getAlerts(ctx as never);

    expect(
      alerts.map((a) => ({
        code: a.messageCode,
        level: a.level,
        noaaScale: a.noaaScale,
        phenomenon: a.phenomenon,
      })),
    ).toEqual(
      DERIVATION_CASES.map((c) => ({
        code: c.code,
        level: c.level,
        noaaScale: c.noaaScale,
        phenomenon: c.phenomenon,
      })),
    );
  });

  it('reads a scale label glued onto correction prose with no line break (#18)', async () => {
    // Verbatim live WARPX1 cancellation: SWPC ran the explanation straight into the
    // label. A line-anchored scale regex misses it, and WARPX1 has no K-index suffix
    // to fall back on, so the level would silently drop to 0 and the phenomenon to
    // the code-shaped "Space Weather".
    const rawAlerts = [
      {
        product_id: 'P11W',
        issue_datetime: '2026-06-30 16:36:36.953',
        message:
          'Space Weather Message Code: WARPX1\r\nSerial Number: 627\r\nIssue Time: 2026 Jun 30 1636 UTC\r\n\r\nCANCEL WARNING: Proton 10MeV Integral Flux above 10pfu expected \nCancel Serial Number: 626\nOriginal Issue Time: 2026 Jun 30 1600 UTC\nConditions no longer justify warning.\r\n\nConditions no longer justify warning.NOAA Scale: S1 - Minor',
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(rawAlerts));

    const svc = makeService();
    const ctx = createMockContext();
    const alerts = await svc.getAlerts(ctx as never);

    expect(alerts[0]!.noaaScale).toBe('S1');
    expect(alerts[0]!.level).toBe(1);
    expect(alerts[0]!.phenomenon).toBe('Solar Radiation');
  });

  it('flags cancellations per record and never EXTENDED/CONTINUED continuations (#19)', async () => {
    // Verbatim live ALTEF3 sequence: the same message code went CONTINUED → CANCEL →
    // CONTINUED inside four minutes, so cancellation cannot be cached per code.
    const rawAlerts = [
      {
        product_id: 'EF3A',
        issue_datetime: '2026-07-07 05:03:30.530',
        message:
          'Space Weather Message Code: ALTEF3\r\nSerial Number: 3709\r\nIssue Time: 2026 Jul 07 0503 UTC\r\n\r\nCONTINUED ALERT: Electron 2MeV Integral Flux exceeded 1000pfu\nContinuation of Serial Number: 3708\n',
      },
      {
        product_id: 'EF3A',
        issue_datetime: '2026-07-07 05:06:59.600',
        message:
          'Space Weather Message Code: ALTEF3\r\nSerial Number: 3710\r\nIssue Time: 2026 Jul 07 0506 UTC\r\n\r\nCANCEL ALERT: Electron 2MeV Integral Flux exceeded 1000pfu \nCancel Serial Number: 3709\nOriginal Issue Time: 2026 Jul 07 0503 UTC\nIncorrect maximum value for yesterday.\n',
      },
      {
        product_id: 'EF3A',
        issue_datetime: '2026-07-07 05:07:12.617',
        message:
          'Space Weather Message Code: ALTEF3\r\nSerial Number: 3711\r\nIssue Time: 2026 Jul 07 0507 UTC\r\n\r\nCONTINUED ALERT: Electron 2MeV Integral Flux exceeded 1000pfu\nContinuation of Serial Number: 3710\n',
      },
      {
        // CANCEL WARNING — the other live cancellation headline. A predicate keyed on
        // "WARNING" alone misses the ALERT cases above; one keyed on "ALERT" misses this.
        product_id: 'K05W',
        issue_datetime: '2026-07-12 21:01:57.203',
        message:
          'Space Weather Message Code: WARK05\r\nSerial Number: 2250\r\nIssue Time: 2026 Jul 12 2101 UTC\r\n\r\nCANCEL WARNING: Geomagnetic K-index of 5 expected \nCancel Serial Number: 2249\nOriginal Issue Time: 2026 Jul 12 1411 UTC\nShould have only been valid until 12/2100 UTC.NOAA Scale: G1 - Minor',
      },
      {
        // EXTENDED means the warning is still in force — the opposite of cancelled.
        product_id: 'K04W',
        issue_datetime: '2026-07-15 08:53:00.000',
        message:
          'Space Weather Message Code: WARK04\r\nSerial Number: 5387\r\nIssue Time: 2026 Jul 15 0853 UTC\r\n\r\nEXTENDED WARNING: Geomagnetic K-index of 4 expected\nExtension to Serial Number: 5386\nNow Valid Until: 2026 Jul 15 1500 UTC\n',
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(rawAlerts));

    const svc = makeService();
    const ctx = createMockContext();
    const alerts = await svc.getAlerts(ctx as never);

    expect(alerts.map((a) => a.cancelled)).toEqual([false, true, false, true, false]);
    // Every record shares a code with a differently-flagged neighbour.
    expect(alerts.filter((a) => a.messageCode === 'ALTEF3').map((a) => a.cancelled)).toEqual([
      false,
      true,
      false,
    ]);
    // Only the two cancellations link a cancelled serial. The CONTINUED and EXTENDED
    // records carry "Continuation of"/"Extension to" links, which mean the opposite.
    expect(alerts.map((a) => a.cancelsSerialNumber)).toEqual([null, '3709', null, '2249', null]);
  });

  it('marks the supersede line only on the records that carry it', async () => {
    // Every in-force Watch carries the line; the cancellation that removes one does
    // not, and no non-Watch product does. Keying supersede on the message code
    // instead of the line would sweep in the cancellation and the Warning below.
    const rawAlerts = [
      {
        product_id: 'A20F',
        issue_datetime: '2026-09-15 17:37:51.220',
        message:
          'Space Weather Message Code: WATA20\r\nSerial Number: 1125\r\nIssue Time: 2026 Sep 15 1737 UTC\r\n\r\nWATCH: Geomagnetic Storm Category G1 Predicted \nHighest Storm Level Predicted by Day:\nSep 16:  G1 (Minor)   Sep 17:  G1 (Minor)   Sep 18:  None (Below G1)   \nTHIS SUPERSEDES ANY/ALL PRIOR WATCHES IN EFFECT\n',
      },
      {
        product_id: 'A30F',
        issue_datetime: '2026-09-09 21:01:32.307',
        message:
          'Space Weather Message Code: WATA30\r\nSerial Number: 282\r\nIssue Time: 2026 Sep 09 2101 UTC\r\n\r\nCANCEL WATCH: Geomagnetic Storm Category G2 Predicted \nCancel Serial Number: 281\nOriginal Issue Time: 2026 Sep 08 1702 UTC\nCancelled Level Predicted:\nSep 08  : None (Bellow G1)  Sep 09  : None (Bellow G1)  Sep 10  : None (Bellow G1)  \n',
      },
      {
        product_id: 'K05W',
        issue_datetime: '2026-09-12 14:11:00.000',
        message:
          'Space Weather Message Code: WARK05\r\nSerial Number: 5405\r\nIssue Time: 2026 Sep 12 1411 UTC\r\n\r\nWARNING: Geomagnetic K-index of 5 expected \nValid To: 2026 Sep 13 2100 UTC\n',
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(rawAlerts));

    const svc = makeService();
    const ctx = createMockContext();
    const alerts = await svc.getAlerts(ctx as never);

    expect(alerts.map((a) => a.supersedes)).toEqual([true, false, false]);
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

describe('SpaceWeatherService.getSolarWindPlasma (RTSW)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('maps RTSW object fields, keeps only the active spacecraft, and orders oldest-first', async () => {
    // Verbatim records from https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json.
    // The feed interleaves spacecraft and serves newest-first. The ACE record is the
    // newest row in the feed but is NOT the active source — taking it would report
    // another spacecraft's measurements as the current solar wind.
    const raw = [
      {
        time_tag: '2026-07-16T05:01:00',
        active: false,
        source: 'ACE',
        proton_speed: 448.32,
        proton_temperature: 108891,
        proton_density: 1.09,
        proton_sample_size: 1,
        alpha_speed: null,
        max_data_flag: 0,
        overall_quality: 0,
      },
      {
        time_tag: '2026-07-16T05:00:00',
        active: true,
        source: 'SOLAR1',
        proton_speed: 475.4,
        proton_temperature: 304713,
        proton_density: 4.95,
        proton_sample_size: 1,
        alpha_speed: null,
        max_data_flag: 0,
        overall_quality: 0,
      },
      {
        time_tag: '2026-07-16T04:59:00',
        active: true,
        source: 'SOLAR1',
        proton_speed: 476.2,
        proton_temperature: 289624,
        proton_density: 5.0,
        proton_sample_size: 1,
        alpha_speed: null,
        max_data_flag: 0,
        overall_quality: 0,
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));

    const svc = makeService();
    const ctx = createMockContext();
    const plasma = await svc.getSolarWindPlasma(ctx as never);

    // Reads the RTSW feed, not the removed /products/solar-wind/ path.
    expect(mockFetch.mock.calls[0]![0]).toBe(
      'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json',
    );

    // Inactive ACE row dropped, both SOLAR1 rows kept.
    expect(plasma).toHaveLength(2);
    expect(plasma.every((p) => p.source === 'SOLAR1')).toBe(true);

    // Oldest-first, despite the feed serving newest-first.
    expect(plasma[0]!.timeTag).toBe('2026-07-16T04:59:00Z');
    expect(plasma[1]!.timeTag).toBe('2026-07-16T05:00:00Z');

    // Newest active record is last — the shape the tool reads for `latestPlasma`.
    expect(plasma.at(-1)!.speedKmS).toBe(475.4);
    expect(plasma.at(-1)!.densityPerCm3).toBe(4.95);
    expect(plasma.at(-1)!.temperatureK).toBe(304713);
  });

  it('returns an empty series when no record is from an active spacecraft', async () => {
    const raw = [
      {
        time_tag: '2026-07-16T05:01:00',
        active: false,
        source: 'ACE',
        proton_speed: 448.32,
        proton_temperature: 108891,
        proton_density: 1.09,
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));

    const svc = makeService();
    const ctx = createMockContext();

    expect(await svc.getSolarWindPlasma(ctx as never)).toEqual([]);
  });

  it('returns null for a missing measurement rather than fabricating a value', async () => {
    const raw = [
      {
        time_tag: '2026-07-16T05:00:00',
        active: true,
        source: 'SOLAR1',
        proton_speed: null,
        proton_temperature: null,
        proton_density: null,
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));

    const svc = makeService();
    const ctx = createMockContext();
    const plasma = await svc.getSolarWindPlasma(ctx as never);

    expect(plasma[0]!.densityPerCm3).toBeNull();
    expect(plasma[0]!.speedKmS).toBeNull();
    expect(plasma[0]!.temperatureK).toBeNull();
    expect(plasma[0]!.source).toBe('SOLAR1');
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

  /**
   * A live record shape (2026-09-22), including a spotless region: SWPC nulls
   * `area`, `spot_class`, `number_spots`, and `mag_class` together for one. The
   * whole mapped record is pinned, not sampled.
   */
  it('maps every field of a spotted and a spotless region, most recent date only', async () => {
    const raw = [
      {
        observed_date: '2026-09-22',
        region: 4536,
        latitude: 3,
        longitude: -13,
        location: 'N03W13',
        area: 60,
        spot_class: 'Dsi',
        number_spots: 10,
        mag_class: 'B',
        c_xray_events: 2,
        m_xray_events: 0,
        x_xray_events: 0,
        c_flare_probability: 40,
        m_flare_probability: 5,
        x_flare_probability: 1,
        proton_probability: 1,
        first_date: '2026-09-21T07:29:27',
      },
      {
        observed_date: '2026-09-22',
        region: 4532,
        latitude: -7,
        longitude: 82,
        location: 'S07W82',
        area: null,
        spot_class: null,
        number_spots: null,
        mag_class: null,
        c_xray_events: 0,
        m_xray_events: 0,
        x_xray_events: 0,
        c_flare_probability: 1,
        m_flare_probability: 1,
        x_flare_probability: 1,
        proton_probability: 1,
        first_date: '2026-09-19T17:49:08',
      },
      {
        // An older observation of the same region — not currently active.
        observed_date: '2026-09-21',
        region: 4536,
        latitude: 3,
        longitude: -1,
        location: 'N03W01',
        area: 40,
        spot_class: 'Cso',
        number_spots: 6,
        mag_class: 'B',
        c_xray_events: 1,
        m_xray_events: 1,
        x_xray_events: 0,
        c_flare_probability: 30,
        m_flare_probability: 5,
        x_flare_probability: 1,
        proton_probability: 1,
        first_date: '2026-09-21T07:29:27',
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));

    const regions = await makeService().getSolarRegions(createMockContext() as never);

    expect(regions).toEqual([
      {
        observedDate: '2026-09-22',
        region: 4536,
        latitude: 'N03',
        location: 'N03W13',
        spotClass: 'Dsi',
        numberSpots: 10,
        magClass: 'B',
        // #39: same-day flare tallies, area, and first-seen time, mapped straight through.
        areaMillionths: 60,
        cFlareCount: 2,
        mFlareCount: 0,
        xFlareCount: 0,
        firstObserved: '2026-09-21T07:29:27Z',
        cFlareProbability: 40,
        mFlareProbability: 5,
        xFlareProbability: 1,
        protonProbability: 1,
      },
      {
        observedDate: '2026-09-22',
        region: 4532,
        latitude: 'S07',
        location: 'S07W82',
        spotClass: '',
        numberSpots: 0,
        magClass: '',
        // A spotless region has no area — null, never a fabricated 0.
        areaMillionths: null,
        cFlareCount: 0,
        mFlareCount: 0,
        xFlareCount: 0,
        firstObserved: '2026-09-19T17:49:08Z',
        cFlareProbability: 1,
        mFlareProbability: 1,
        xFlareProbability: 1,
        protonProbability: 1,
      },
    ]);
  });

  it("reads each region's counts from its own most-recent record, not an older day's (#39)", async () => {
    const record = (observedDate: string, cEvents: number, mEvents: number) => ({
      observed_date: observedDate,
      region: 4536,
      latitude: 3,
      longitude: -13,
      location: 'N03W13',
      area: 60,
      spot_class: 'Dsi',
      number_spots: 10,
      mag_class: 'B',
      c_xray_events: cEvents,
      m_xray_events: mEvents,
      x_xray_events: 0,
      c_flare_probability: 40,
      m_flare_probability: 5,
      x_flare_probability: 1,
      proton_probability: 1,
      first_date: '2026-09-21T07:29:27',
    });
    // Reverse-chrono, as the feed serves it: today's tally first, yesterday's after.
    mockFetch.mockResolvedValue(
      makeResponse([record('2026-09-22', 2, 0), record('2026-09-21', 5, 1)]),
    );

    const regions = await makeService().getSolarRegions(createMockContext() as never);

    expect(regions).toHaveLength(1);
    expect(regions[0]!.cFlareCount).toBe(2);
    expect(regions[0]!.mFlareCount).toBe(0);
  });
});

describe('SpaceWeatherService.getSolarWindMag (RTSW)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('parses Bz/Bt/Bx/By from the active spacecraft only, orders oldest-first, and normalizes time tags', async () => {
    // Verbatim records from https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json.
    // The inactive IMAP row shares the active row's exact timestamp but reports a
    // different Bz — reading the wrong row silently reports the wrong storm driver.
    const raw = [
      {
        time_tag: '2026-07-16T05:00:00',
        active: false,
        source: 'IMAP',
        bt: 6.84,
        bx_gsm: -3.3,
        by_gsm: 5.46,
        bz_gsm: 2.41,
        max_data_flag: 0,
        overall_quality: 0,
      },
      {
        time_tag: '2026-07-16T05:00:00',
        active: true,
        source: 'SOLAR1',
        bt: 5.97,
        bx_gsm: -2.7,
        by_gsm: 4.99,
        bz_gsm: 1.84,
        max_data_flag: -9999,
        overall_quality: 0,
      },
      {
        time_tag: '2026-07-16T04:59:00',
        active: true,
        source: 'SOLAR1',
        bt: 6.0,
        bx_gsm: -2.31,
        by_gsm: 5.12,
        bz_gsm: 2.11,
        max_data_flag: -9999,
        overall_quality: 0,
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));

    const svc = makeService();
    const ctx = createMockContext();
    const mag = await svc.getSolarWindMag(ctx as never);

    expect(mockFetch.mock.calls[0]![0]).toBe(
      'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json',
    );

    expect(mag).toHaveLength(2);
    expect(mag.every((m) => m.source === 'SOLAR1')).toBe(true);

    // Oldest-first, despite the feed serving newest-first.
    expect(mag[0]!.timeTag).toBe('2026-07-16T04:59:00Z');
    expect(mag[1]!.timeTag).toBe('2026-07-16T05:00:00Z');

    // The active row's Bz, not the co-timestamped IMAP row's 2.41.
    const latest = mag.at(-1)!;
    expect(latest.bzGsm).toBe(1.84);
    expect(latest.bt).toBe(5.97);
    expect(latest.bxGsm).toBe(-2.7);
    expect(latest.byGsm).toBe(4.99);

    // max_data_flag is -9999 on live active rows; it must not null out the vector.
    expect(latest.bzGsm).not.toBeNull();
  });
});

describe('SpaceWeatherService.getXrayFlux', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /**
   * Characterization of the mapping, written against the 7-day feed it read before
   * the 6-hour swap: the two feeds are byte-identical per record, so every assertion
   * here must hold unchanged after the path moves. Only the requested URL changes.
   */
  it('keeps only the long channel, maps each field verbatim, and preserves feed order', async () => {
    // Verbatim records from the GOES primary X-ray feed, both energy channels
    // interleaved at the same time tags, as upstream serves them.
    const raw = [
      {
        time_tag: '2026-09-17T17:08:00Z',
        satellite: 18,
        flux: 2.2630203488915868e-8,
        observed_flux: 2.2630203488915868e-8,
        electron_correction: 0,
        electron_contaminaton: false,
        energy: '0.05-0.4nm',
      },
      {
        time_tag: '2026-09-17T17:08:00Z',
        satellite: 18,
        flux: 2.4466430659231264e-7,
        observed_flux: 2.841615867055225e-7,
        electron_correction: 3.949726234964146e-8,
        electron_contaminaton: false,
        energy: '0.1-0.8nm',
      },
      {
        time_tag: '2026-09-17T17:09:00Z',
        satellite: 18,
        flux: 2.5e-7,
        observed_flux: 2.9e-7,
        electron_correction: 4e-8,
        electron_contaminaton: false,
        energy: '0.1-0.8nm',
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));

    const xray = await makeService().getXrayFlux(createMockContext() as never);

    expect(xray).toEqual([
      {
        timeTag: '2026-09-17T17:08:00Z',
        satellite: 18,
        fluxWm2: 2.4466430659231264e-7,
        energy: '0.1-0.8nm',
      },
      {
        timeTag: '2026-09-17T17:09:00Z',
        satellite: 18,
        fluxWm2: 2.5e-7,
        energy: '0.1-0.8nm',
      },
    ]);
  });

  it('returns an empty series when the feed carries no long-channel record', async () => {
    mockFetch.mockResolvedValue(
      makeResponse([
        { time_tag: '2026-09-17T17:08:00Z', satellite: 18, flux: 1e-8, energy: '0.05-0.4nm' },
      ]),
    );

    expect(await makeService().getXrayFlux(createMockContext() as never)).toEqual([]);
  });

  it('reads the 6-hour feed, not the 7-day one', async () => {
    // The tool slices the past hour from this series, and the 6-hour feed's records
    // are byte-identical to the newest 710 of the 7-day feed — same channels, same
    // 1-minute cadence, same newest timestamp — for ~4.36 MB less per call.
    mockFetch.mockResolvedValue(makeResponse([]));

    await makeService().getXrayFlux(createMockContext() as never);

    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      'https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json',
    );
  });
});

describe('SpaceWeatherService.getXrayFlares (#31)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('requests the 7-day flare feed', async () => {
    mockFetch.mockResolvedValue(makeResponse([]));

    await makeService().getXrayFlares(createMockContext() as never);

    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      'https://services.swpc.noaa.gov/json/goes/primary/xray-flares-7-day.json',
    );
  });

  it('maps one discrete flare event, reading every class as SWPC published it', async () => {
    mockFetch.mockResolvedValue(makeResponse([SWPC_XRAY_FLARE_FEED[0]]));

    const flares = await makeService().getXrayFlares(createMockContext() as never);

    // The unmapped keys — max_ratio, max_ratio_time, current_int_xrlong (an
    // *integrated* flux four decades above the peak) — must not reach the output.
    expect(flares).toEqual([
      {
        beginTime: '2026-09-10T20:00:00Z',
        maxTime: '2026-09-10T20:07:00Z',
        endTime: '2026-09-10T20:12:00Z',
        beginClass: 'B4.2',
        maxClass: 'B8.1',
        endClass: 'B6.0',
        peakFluxWm2: 8.120343295558996e-7,
        satellite: 18,
      },
    ]);
  });

  it('carries a null max_ratio through without touching the mapped fields', async () => {
    mockFetch.mockResolvedValue(makeResponse([SWPC_XRAY_FLARE_FEED[2]]));

    const flares = await makeService().getXrayFlares(createMockContext() as never);

    expect(flares[0]!.maxClass).toBe('B3.4');
    expect(flares[0]!.peakFluxWm2).toBe(3.453629631167132e-7);
    expect(flares[0]!.endClass).toBe('B2.9');
  });

  it('reports an in-progress flare decay as null rather than inventing one', async () => {
    // SWPC publishes the record at onset (time_tag equals begin_time on every
    // record), so a flare still in progress has no decay time or class yet.
    mockFetch.mockResolvedValue(
      makeResponse([
        {
          ...SWPC_XRAY_FLARE_FEED[3],
          end_time: null,
          end_class: null,
        },
      ]),
    );

    const flares = await makeService().getXrayFlares(createMockContext() as never);

    expect(flares[0]!.endTime).toBeNull();
    expect(flares[0]!.endClass).toBeNull();
    expect(flares[0]!.maxTime).toBe('2026-09-17T12:16:00Z');
  });

  it('orders events oldest-first even when upstream serves them newest-first', async () => {
    // Upstream serves oldest-first today; ordering is an invariant of the domain
    // type, as it is for the solar-wind series, not an accident of the feed.
    mockFetch.mockResolvedValue(makeResponse([...SWPC_XRAY_FLARE_FEED].reverse()));

    const flares = await makeService().getXrayFlares(createMockContext() as never);

    expect(flares.map((f) => f.beginTime)).toEqual([
      '2026-09-10T20:00:00Z',
      '2026-09-12T16:18:00Z',
      '2026-09-16T11:46:00Z',
      '2026-09-17T12:08:00Z',
    ]);
  });

  it('returns an empty series for an empty feed', async () => {
    mockFetch.mockResolvedValue(makeResponse([]));

    expect(await makeService().getXrayFlares(createMockContext() as never)).toEqual([]);
  });
});

describe('SpaceWeatherService.getF107 (#31)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('requests the F10.7 feed', async () => {
    mockFetch.mockResolvedValue(makeResponse([]));

    await makeService().getF107(createMockContext() as never);

    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      'https://services.swpc.noaa.gov/json/f107_cm_flux.json',
    );
  });

  it('takes the latest Noon report, not the newest record, and normalizes its Z-less tag', async () => {
    // The feed's index-0 record is that day's 22:00 Afternoon report. SWPC's own
    // one-value summary reported the 20:00 Noon record instead, and Noon is the
    // only schedule carrying ninety_day_mean.
    mockFetch.mockResolvedValue(makeResponse(SWPC_F107_FEED));

    const f107 = await makeService().getF107(createMockContext() as never);

    expect(f107).toEqual({
      observedTime: '2026-09-16T20:00:00Z',
      fluxSfu: 100,
      ninetyDayMeanSfu: 126,
      reportingSchedule: 'Noon',
    });
  });

  it('picks the newest Noon report regardless of the order the feed serves', async () => {
    mockFetch.mockResolvedValue(makeResponse([...SWPC_F107_FEED].reverse()));

    const f107 = await makeService().getF107(createMockContext() as never);

    expect(f107?.observedTime).toBe('2026-09-16T20:00:00Z');
    expect(f107?.ninetyDayMeanSfu).toBe(126);
  });

  it('reports a Noon record carrying no 90-day mean as null', async () => {
    mockFetch.mockResolvedValue(
      makeResponse([
        {
          time_tag: '2026-09-16T20:00:00',
          frequency: 2800,
          flux: 100,
          reporting_schedule: 'Noon',
          avg_begin_date: null,
          ninety_day_mean: null,
          rec_count: null,
        },
      ]),
    );

    const f107 = await makeService().getF107(createMockContext() as never);

    expect(f107?.fluxSfu).toBe(100);
    expect(f107?.ninetyDayMeanSfu).toBeNull();
  });

  it('returns null when the feed carries no record at all', async () => {
    mockFetch.mockResolvedValue(makeResponse([]));

    expect(await makeService().getF107(createMockContext() as never)).toBeNull();
  });

  it('returns null when the feed carries no Noon report', async () => {
    mockFetch.mockResolvedValue(
      makeResponse(SWPC_F107_FEED.filter((r) => r.reporting_schedule !== 'Noon')),
    );

    expect(await makeService().getF107(createMockContext() as never)).toBeNull();
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

describe('SpaceWeatherService User-Agent (#15)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('derives the SWPC User-Agent from the injected server version, not a hardcoded release', async () => {
    mockFetch.mockResolvedValue(makeResponse([]));

    const svc = makeService('9.9.9');
    const ctx = createMockContext();
    await svc.getKpObserved(ctx as never);

    // fetchWithTimeout(url, timeoutMs, reqCtx, { signal, headers }) — options is arg 4.
    const opts = mockFetch.mock.calls[0]![3] as { headers: Record<string, string> };
    const ua = opts.headers['User-Agent']!;

    // Tracks the running version rather than the stale hardcoded 0.1.1.
    expect(ua).toBe(
      'noaa-spaceweather-mcp-server/9.9.9 (github.com/cyanheads/noaa-spaceweather-mcp-server)',
    );
    expect(ua).not.toContain('0.1.1');
    // Product token and contact URL are preserved; only the version is dynamic.
    expect(ua.startsWith('noaa-spaceweather-mcp-server/9.9.9')).toBe(true);
    expect(ua).toContain('(github.com/cyanheads/noaa-spaceweather-mcp-server)');
  });

  it("threads the retry attempt's signal into the request, not the handler's (#41)", async () => {
    mockFetch.mockResolvedValue(makeResponse([]));
    const ctx = createMockContext();

    await makeService().getKpObserved(ctx as never);

    const opts = mockFetch.mock.calls[0]![3] as { signal: AbortSignal };
    expect(opts.signal).toBe(ATTEMPT_SIGNAL);
    expect(opts.signal).not.toBe(ctx.signal);
  });
});

describe('SpaceWeatherService.getSolarProbabilities (#16)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('expands the latest entry into a 3-day outlook with date-neutral aliases mirroring the *1Day fields', async () => {
    const raw = [
      {
        date: '2026-06-04T00:00:00',
        c_class_1_day: 99,
        c_class_2_day: 80,
        c_class_3_day: 70,
        m_class_1_day: 50,
        m_class_2_day: 40,
        m_class_3_day: 30,
        x_class_1_day: 10,
        x_class_2_day: 8,
        x_class_3_day: 5,
        '10mev_protons_1_day': 5,
        '10mev_protons_2_day': 4,
        '10mev_protons_3_day': 3,
      },
      // Older archive entry — must be ignored; only index 0 drives the outlook.
      {
        date: '2026-06-03T00:00:00',
        c_class_1_day: 1,
        m_class_1_day: 1,
        x_class_1_day: 1,
        '10mev_protons_1_day': 1,
      },
    ];
    mockFetch.mockResolvedValue(makeResponse(raw));

    const svc = makeService();
    const ctx = createMockContext();
    const probs = await svc.getSolarProbabilities(ctx as never);

    expect(probs).toHaveLength(3);

    // Every record carries date-neutral aliases equal to the legacy *1Day fields,
    // and the legacy fields remain present (additive, non-breaking).
    for (const p of probs) {
      expect(p.cClassProbability).toBe(p.cClass1Day);
      expect(p.mClassProbability).toBe(p.mClass1Day);
      expect(p.xClassProbability).toBe(p.xClass1Day);
      expect(p.protonEventProbability).toBe(p.protons1Day);
      expect(typeof p.cClass1Day).toBe('number');
      expect(typeof p.protons1Day).toBe('number');
    }

    // Day 0 pulls the _1_day columns, day 1 the _2_day, day 2 the _3_day.
    expect(probs[0]!.cClassProbability).toBe(99);
    expect(probs[0]!.protonEventProbability).toBe(5);
    expect(probs[1]!.cClassProbability).toBe(80);
    expect(probs[1]!.mClassProbability).toBe(40);
    expect(probs[2]!.cClassProbability).toBe(70);
    expect(probs[2]!.protonEventProbability).toBe(3);

    // Dates advance one day per record; day 0 is the base date.
    expect(probs[0]!.date).toBe('2026-06-04T00:00:00.000Z');
    expect(new Date(probs[1]!.date).getTime() - new Date(probs[0]!.date).getTime()).toBe(
      86_400_000,
    );
    expect(new Date(probs[2]!.date).getTime() - new Date(probs[1]!.date).getTime()).toBe(
      86_400_000,
    );
  });
});

describe('SpaceWeatherService.getSolarProbabilities DST safety (#22)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Minimal feed row — only `date` and the day-one columns matter to these cases. */
  function makeProbsFeed(date: string) {
    return [
      {
        date,
        c_class_1_day: 10,
        c_class_2_day: 20,
        c_class_3_day: 30,
        m_class_1_day: 1,
        m_class_2_day: 2,
        m_class_3_day: 3,
        x_class_1_day: 1,
        x_class_2_day: 1,
        x_class_3_day: 1,
        '10mev_protons_1_day': 1,
        '10mev_protons_2_day': 1,
        '10mev_protons_3_day': 1,
      },
    ];
  }

  async function datesFor(tz: string, feedDate: string): Promise<string[]> {
    vi.stubEnv('TZ', tz);
    mockFetch.mockResolvedValue(makeResponse(makeProbsFeed(feedDate)));
    const probs = await makeService().getSolarProbabilities(createMockContext() as never);
    return probs.map((p) => p.date);
  }

  it('emits three midnight-UTC days across a spring-forward transition in a DST-observing zone', async () => {
    // 2026-03-08 is the US spring-forward date; the 3-day window spans it.
    expect(await datesFor('America/Los_Angeles', '2026-03-07T00:00:00')).toEqual([
      '2026-03-07T00:00:00.000Z',
      '2026-03-08T00:00:00.000Z',
      '2026-03-09T00:00:00.000Z',
    ]);
  });

  it('emits three midnight-UTC days across a fall-back transition in a DST-observing zone', async () => {
    // 2026-11-01 is the US fall-back date.
    expect(await datesFor('America/Los_Angeles', '2026-11-01T00:00:00')).toEqual([
      '2026-11-01T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
      '2026-11-03T00:00:00.000Z',
    ]);
  });

  it('emits the same dates under UTC as under a DST-observing zone (baseline regression)', async () => {
    const utcSpring = await datesFor('UTC', '2026-03-07T00:00:00');
    const utcFall = await datesFor('UTC', '2026-11-01T00:00:00');

    expect(utcSpring).toEqual([
      '2026-03-07T00:00:00.000Z',
      '2026-03-08T00:00:00.000Z',
      '2026-03-09T00:00:00.000Z',
    ]);
    expect(utcFall).toEqual([
      '2026-11-01T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
      '2026-11-03T00:00:00.000Z',
    ]);
  });

  it('holds the day-0-is-the-feed-row-date and distinct-calendar-day invariants in a southern-hemisphere DST zone', async () => {
    // Sydney shifts the opposite way from Los Angeles; both must produce the same UTC days.
    const dates = await datesFor('Australia/Sydney', '2026-04-04T00:00:00');

    expect(dates).toHaveLength(3);
    expect(dates[0]).toBe('2026-04-04T00:00:00.000Z'); // never the feed date plus one
    expect(new Set(dates.map((d) => d.slice(0, 10))).size).toBe(3); // no duplicated calendar day
    expect(dates.every((d) => d.endsWith('T00:00:00.000Z'))).toBe(true);
  });
});

describe('kpToGScale thresholds (#27)', () => {
  /**
   * SWPC publishes Kp in thirds and starts each G level at that level's "minus"
   * value, so the four minus-thirds below are the values that previously came back
   * one level low. 8.67 (9−) is G4 per the NOAA scales page, not G5.
   */
  const BOUNDARY_CASES: [kp: number, gScale: number][] = [
    [4.33, 0],
    [4.67, 1],
    [5.33, 1],
    [5.67, 2],
    [6.33, 2],
    [6.67, 3],
    [7.33, 3],
    [7.67, 4],
    [8.33, 4],
    [8.67, 4],
    [9.0, 5],
  ];

  it.each(BOUNDARY_CASES)('maps Kp %s to G%s', (kp, gScale) => {
    expect(kpToGScale(kp)).toBe(gScale);
  });

  it('resolves every integer K value exactly as before (alert-path regression)', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(kpToGScale)).toEqual([0, 0, 0, 0, 0, 1, 2, 3, 4, 5]);
  });
});

describe('SpaceWeatherService.getNoaaScales normalization', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /**
   * Today's period (feed key "0") is an observation: SWPC populates a real `Scale`
   * and `Text` on all three categories and leaves every probability null. This
   * characterization pins that mapping — it is the half of the normalizer the
   * forecast-period fix must leave byte-identical.
   */
  it('maps the observed period straight through, scales as numbers and probabilities null', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        '0': {
          DateStamp: '2026-09-17',
          TimeStamp: '17:13:00',
          R: { Scale: '0', Text: 'none', MinorProb: null, MajorProb: null },
          S: { Scale: '0', Text: 'none', Prob: null },
          G: { Scale: '0', Text: 'none' },
        },
      }),
    );

    const scales = await makeService().getNoaaScales(createMockContext() as never);

    expect(scales.today.date).toBe('2026-09-17');
    expect(scales.today.time).toBe('17:13:00');
    expect(scales.today.G).toEqual({
      category: 'G',
      scale: 0,
      text: 'none',
      minorProb: null,
      majorProb: null,
    });
    expect(scales.today.R).toEqual({
      category: 'R',
      scale: 0,
      text: 'none',
      minorProb: null,
      majorProb: null,
    });
    expect(scales.today.S).toEqual({
      category: 'S',
      scale: 0,
      text: 'none',
      minorProb: null,
      majorProb: null,
    });
    expect(scales.forecast).toEqual([]);
    // The feed's key set is not guaranteed; without key "-1" there is no previous day.
    expect(scales.yesterday).toBeNull();
  });

  it('reads a non-zero observed scale and its descriptor as issued', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        '0': {
          DateStamp: '2026-09-17',
          TimeStamp: '17:13:00',
          R: { Scale: '2', Text: 'moderate', MinorProb: null, MajorProb: null },
          S: { Scale: '1', Text: 'minor', Prob: null },
          G: { Scale: '3', Text: 'strong' },
        },
      }),
    );

    const { today } = await makeService().getNoaaScales(createMockContext() as never);

    expect(today.G.scale).toBe(3);
    expect(today.G.text).toBe('strong');
    expect(today.R.scale).toBe(2);
    expect(today.S.scale).toBe(1);
  });

  it('collects forecast periods from keys "1"–"3" in order and keeps key "-1" out of them', async () => {
    const forecastPeriod = (date: string, gScale: string) => ({
      DateStamp: date,
      TimeStamp: '00:00:00',
      R: { Scale: null, Text: null, MinorProb: '5', MajorProb: '1' },
      S: { Scale: null, Text: null, Prob: '1' },
      G: { Scale: gScale, Text: gScale === '0' ? 'none' : 'minor' },
    });
    mockFetch.mockResolvedValue(
      makeResponse({
        '-1': {
          DateStamp: '2026-09-16',
          TimeStamp: '17:13:00',
          R: { Scale: '0', Text: 'none', MinorProb: null, MajorProb: null },
          S: { Scale: '0', Text: 'none', Prob: null },
          G: { Scale: '0', Text: 'none' },
        },
        '0': {
          DateStamp: '2026-09-17',
          TimeStamp: '17:13:00',
          R: { Scale: '0', Text: 'none', MinorProb: null, MajorProb: null },
          S: { Scale: '0', Text: 'none', Prob: null },
          G: { Scale: '0', Text: 'none' },
        },
        '1': forecastPeriod('2026-09-17', '1'),
        '2': forecastPeriod('2026-09-18', '0'),
        '3': forecastPeriod('2026-09-19', '0'),
      }),
    );

    const { today, forecast } = await makeService().getNoaaScales(createMockContext() as never);

    // The forecast series opens on today's own calendar day — key "1" repeats key "0"'s DateStamp.
    expect(forecast.map((p) => p.date)).toEqual(['2026-09-17', '2026-09-18', '2026-09-19']);
    expect(forecast[0]!.date).toBe(today.date);
    expect(forecast.map((p) => p.date)).not.toContain('2026-09-16');
  });

  /**
   * Key "-1" is the previous UTC day in key "0"'s shape — levels populated, probabilities
   * null — captured live on 2026-09-22. Its TimeStamp matches key "0"'s: it is the feed's
   * generation clock, not an observation time for that day.
   */
  it('reads key "-1" into yesterday with its own date and levels (#34)', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        '-1': {
          DateStamp: '2026-09-21',
          TimeStamp: '22:38:00',
          R: { Scale: '1', Text: 'minor', MinorProb: null, MajorProb: null },
          S: { Scale: '0', Text: 'none', Prob: null },
          G: { Scale: '2', Text: 'moderate' },
        },
        '0': {
          DateStamp: '2026-09-22',
          TimeStamp: '22:38:00',
          R: { Scale: '0', Text: 'none', MinorProb: null, MajorProb: null },
          S: { Scale: '0', Text: 'none', Prob: null },
          G: { Scale: '0', Text: 'none' },
        },
      }),
    );

    const { yesterday, today } = await makeService().getNoaaScales(createMockContext() as never);

    expect(yesterday?.date).toBe('2026-09-21');
    expect(yesterday?.G).toEqual({
      category: 'G',
      scale: 2,
      text: 'moderate',
      minorProb: null,
      majorProb: null,
    });
    expect(yesterday?.R).toEqual({
      category: 'R',
      scale: 1,
      text: 'minor',
      minorProb: null,
      majorProb: null,
    });
    expect(yesterday?.S.scale).toBe(0);
    // Reading the extra key leaves today exactly as it was.
    expect(today.date).toBe('2026-09-22');
    expect(today.G.scale).toBe(0);
    expect(today.R.scale).toBe(0);
  });

  it('carries a null level on key "-1" through as null rather than level 0 (#34)', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        '-1': {
          DateStamp: '2026-09-21',
          TimeStamp: '22:38:00',
          R: { Scale: null, Text: null, MinorProb: null, MajorProb: null },
          S: { Scale: '0', Text: 'none', Prob: null },
          G: { Scale: '0', Text: 'none' },
        },
        '0': {
          DateStamp: '2026-09-22',
          TimeStamp: '22:38:00',
          R: { Scale: '0', Text: 'none', MinorProb: null, MajorProb: null },
          S: { Scale: '0', Text: 'none', Prob: null },
          G: { Scale: '0', Text: 'none' },
        },
      }),
    );

    const { yesterday } = await makeService().getNoaaScales(createMockContext() as never);

    expect(yesterday?.R.scale).toBeNull();
    expect(yesterday?.R.text).toBeNull();
  });

  /**
   * SWPC issues no R/S *level* for a future day — it issues a probability. The feed
   * says so with `Scale: null` / `Text: null` alongside a populated `MinorProb` /
   * `MajorProb` (R) or `Prob` (S), and the normalizer must carry that null through
   * rather than resolving it to level 0 (#23).
   */
  it('preserves a null forecast R/S scale and parses the probabilities SWPC issued (#23)', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        '0': {
          DateStamp: '2026-09-17',
          TimeStamp: '17:13:00',
          R: { Scale: '0', Text: 'none', MinorProb: null, MajorProb: null },
          S: { Scale: '0', Text: 'none', Prob: null },
          G: { Scale: '0', Text: 'none' },
        },
        '1': {
          DateStamp: '2026-09-17',
          TimeStamp: '17:13:00',
          R: { Scale: null, Text: null, MinorProb: '5', MajorProb: '1' },
          S: { Scale: null, Text: null, Prob: '1' },
          G: { Scale: '1', Text: 'minor' },
        },
      }),
    );

    const { today, forecast } = await makeService().getNoaaScales(createMockContext() as never);

    expect(forecast[0]!.R).toEqual({
      category: 'R',
      scale: null,
      text: null,
      minorProb: 5,
      majorProb: 1,
    });
    expect(forecast[0]!.S).toEqual({
      category: 'S',
      scale: null,
      text: null,
      minorProb: 1,
      majorProb: null,
    });
    // G does carry a real forecast level, so it is unaffected.
    expect(forecast[0]!.G.scale).toBe(1);
    expect(forecast[0]!.G.text).toBe('minor');
    // Today's observed zeros are a real level 0 and must not be confused with the nulls.
    expect(today.R.scale).toBe(0);
    expect(today.S.scale).toBe(0);
  });

  it('normalizes an unparseable probability to null rather than zero (#23)', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        '0': {
          DateStamp: '2026-09-17',
          TimeStamp: '17:13:00',
          R: { Scale: '0', Text: 'none', MinorProb: null, MajorProb: null },
          S: { Scale: '0', Text: 'none', Prob: null },
          G: { Scale: '0', Text: 'none' },
        },
        '1': {
          DateStamp: '2026-09-18',
          TimeStamp: '00:00:00',
          R: { Scale: null, Text: null, MinorProb: 'n/a', MajorProb: '' },
          S: { Scale: null, Text: null, Prob: 'unknown' },
          G: { Scale: '0', Text: 'none' },
        },
      }),
    );

    const { forecast } = await makeService().getNoaaScales(createMockContext() as never);

    expect(forecast[0]!.R.minorProb).toBeNull();
    expect(forecast[0]!.R.majorProb).toBeNull();
    expect(forecast[0]!.S.minorProb).toBeNull();
  });

  it('carries a G probability through when the feed ever supplies one (#23)', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({
        '0': {
          DateStamp: '2026-09-17',
          TimeStamp: '17:13:00',
          R: { Scale: '0', Text: 'none', MinorProb: null, MajorProb: null },
          S: { Scale: '0', Text: 'none', Prob: null },
          G: { Scale: '0', Text: 'none' },
        },
        '1': {
          DateStamp: '2026-09-18',
          TimeStamp: '00:00:00',
          R: { Scale: null, Text: null, MinorProb: '5', MajorProb: '1' },
          S: { Scale: null, Text: null, Prob: '1' },
          G: { Scale: null, Text: null, Prob: '35' },
        },
      }),
    );

    const { forecast } = await makeService().getNoaaScales(createMockContext() as never);

    expect(forecast[0]!.G.scale).toBeNull();
    expect(forecast[0]!.G.text).toBeNull();
    expect(forecast[0]!.G.minorProb).toBe(35);
  });
});

describe('SpaceWeatherService.getForecastDiscussion (#32)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /** The text product comes back verbatim — no JSON parse on this path. */
  function serveDiscussion(body: string): void {
    mockFetch.mockResolvedValue(makeRawResponse(body));
  }

  it('reads the issue time from the product body, not from HTTP freshness', async () => {
    serveDiscussion(SWPC_DISCUSSION);

    const discussion = await makeService().getForecastDiscussion(createMockContext() as never);

    expect(discussion.issued).toBe('2026-09-17T12:30:00Z');
  });

  it('requests the discussion product path', async () => {
    serveDiscussion(SWPC_DISCUSSION);

    await makeService().getForecastDiscussion(createMockContext() as never);

    expect(mockFetch.mock.calls[0]?.[0]).toBe('https://services.swpc.noaa.gov/text/discussion.txt');
  });

  it('splits every topic section in product order', async () => {
    serveDiscussion(SWPC_DISCUSSION);

    const { sections } = await makeService().getForecastDiscussion(createMockContext() as never);

    expect(sections.map((s) => s.topic)).toEqual([
      'Solar Activity',
      'Energetic Particle',
      'Solar Wind',
      'Geospace',
    ]);
    // Every section on this product carries both blocks.
    expect(sections.every((s) => s.summary !== null && s.forecast !== null)).toBe(true);
  });

  it('keeps a multi-paragraph summary whole rather than truncating at the blank line', async () => {
    serveDiscussion(SWPC_DISCUSSION);

    const { sections } = await makeService().getForecastDiscussion(createMockContext() as never);
    const solarActivity = sections[0]!;

    expect(solarActivity.summary).toContain('long-duration B7.9 flare at 16/2345 UTC');
    // The second paragraph sits past a blank line and must survive it.
    expect(solarActivity.summary).toContain('No Earth-directed CMEs were observed');
    expect(solarActivity.summary).toContain('\n\n');
    // The block ends at the next ".Forecast..." header — its text is a separate field.
    expect(solarActivity.summary).not.toContain('expected to remain at very low levels');
    expect(solarActivity.forecast).toContain('expected to remain at very low levels');
  });

  it('reads a section past the first, not just the leading one', async () => {
    serveDiscussion(SWPC_DISCUSSION);

    const { sections } = await makeService().getForecastDiscussion(createMockContext() as never);

    expect(sections[2]!.topic).toBe('Solar Wind');
    expect(sections[2]!.summary).toContain('negative polarity coronal hole');
    expect(sections[3]!.topic).toBe('Geospace');
    expect(sections[3]!.forecast).toContain('G1 (Minor) storm');
    // The last section's forecast runs to the end of the product.
    expect(sections[3]!.forecast).toContain('as enhancements wane.');
  });

  it('resolves a section with no ".Forecast..." block to a null forecast', async () => {
    serveDiscussion(
      [
        ':Product: Forecast Discussion',
        ':Issued: 2026 Sep 17 1230 UTC',
        '#',
        'Solar Activity',
        '',
        '.24 hr Summary...',
        'Very low levels throughout the period.',
        '',
        'Geospace',
        '',
        '.24 hr Summary...',
        'The geomagnetic field was quiet.',
        '',
        '.Forecast...',
        'Unsettled conditions are likely.',
        '',
      ].join('\n'),
    );

    const { sections } = await makeService().getForecastDiscussion(createMockContext() as never);

    expect(sections).toHaveLength(2);
    expect(sections[0]!.topic).toBe('Solar Activity');
    expect(sections[0]!.summary).toBe('Very low levels throughout the period.');
    expect(sections[0]!.forecast).toBeNull();
    expect(sections[1]!.forecast).toBe('Unsettled conditions are likely.');
  });

  it('resolves an empty ".24 hr Summary..." block to a null summary', async () => {
    serveDiscussion(
      [
        ':Issued: 2026 Sep 17 1230 UTC',
        'Geospace',
        '',
        '.24 hr Summary...',
        '',
        '.Forecast...',
        'Unsettled conditions are likely.',
      ].join('\n'),
    );

    const { sections } = await makeService().getForecastDiscussion(createMockContext() as never);

    expect(sections[0]!.summary).toBeNull();
    expect(sections[0]!.forecast).toBe('Unsettled conditions are likely.');
  });

  it('falls back to the raw ":Issued:" text when it is not the SWPC datetime shape', async () => {
    serveDiscussion(
      [':Issued: sometime tuesday', 'Geospace', '', '.24 hr Summary...', 'Quiet.'].join('\n'),
    );

    const discussion = await makeService().getForecastDiscussion(createMockContext() as never);

    expect(discussion.issued).toBe('sometime tuesday');
  });

  it('reports null rather than a time when the product carries no ":Issued:" line', async () => {
    serveDiscussion(['Geospace', '', '.24 hr Summary...', 'Quiet.'].join('\n'));

    const discussion = await makeService().getForecastDiscussion(createMockContext() as never);

    expect(discussion.issued).toBeNull();
    expect(discussion.sections).toHaveLength(1);
  });

  it('never reads a body prose line as a topic heading', async () => {
    // "No Earth-directed CMEs..." is an unprefixed line inside a summary block, and a
    // naive unprefixed-line scan would open a section on it.
    serveDiscussion(SWPC_DISCUSSION);

    const { sections } = await makeService().getForecastDiscussion(createMockContext() as never);

    expect(sections).toHaveLength(4);
    expect(sections.map((s) => s.topic)).not.toContain('No Earth-directed CMEs were observed in');
  });

  it('rejects a plain-text body with neither an issue line nor a topic section as feed_moved', async () => {
    serveDiscussion('Service temporarily unavailable. Please try later.\n');

    await expect(
      makeService().getForecastDiscussion(createMockContext() as never),
    ).rejects.toMatchObject({
      data: { reason: 'feed_moved', retryable: false, path: '/text/discussion.txt' },
    });
  });

  it('rejects a product carrying an issue line but no topic section as feed_moved', async () => {
    // The sections are the product. ":Issued:" heads every SWPC text product, so it
    // cannot tell this one from any other — a body carrying it and nothing else is a
    // shape break, not a discussion with no topics.
    serveDiscussion(
      [
        ':Product: 3-Day Forecast',
        ':Issued: 2026 Sep 17 1230 UTC',
        '# Prepared by the U.S. Dept. of Commerce, NOAA, Space Weather Prediction Center',
        '#',
        'A. NOAA Geomagnetic Activity Observation and Forecast',
        '',
      ].join('\n'),
    );

    await expect(
      makeService().getForecastDiscussion(createMockContext() as never),
    ).rejects.toMatchObject({
      data: { reason: 'feed_moved', retryable: false, path: '/text/discussion.txt' },
    });
  });

  it('rejects an HTML body on the text path as feed_unavailable', async () => {
    serveDiscussion('<!DOCTYPE html><html><body>429 Too Many Requests</body></html>');

    await expect(
      makeService().getForecastDiscussion(createMockContext() as never),
    ).rejects.toMatchObject({
      message: expect.stringContaining('SWPC product returned HTML instead of text'),
      data: { reason: 'feed_unavailable', path: '/text/discussion.txt' },
    });
  });
});

describe('SpaceWeatherService.fetchFeed body handling (#25)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('treats a bare NaN in a numeric value position as missing data, keeping sibling fields', async () => {
    mockFetch.mockResolvedValue(
      makeRawResponse(
        '[{"active":true,"proton_speed":NaN,"proton_density":5.1,"proton_temperature":90000,"source":"SOLAR1","time_tag":"2026-08-11 00:00:00.000"}]',
      ),
    );

    const plasma = await makeService().getSolarWindPlasma(createMockContext() as never);

    expect(plasma[0]!.speedKmS).toBeNull();
    expect(plasma[0]!.densityPerCm3).toBe(5.1);
    expect(plasma[0]!.temperatureK).toBe(90000);
    expect(plasma[0]!.timeTag).toBe('2026-08-11T00:00:00.000Z');
  });

  it('applies the same tolerance to a feed outside the solar-wind path', async () => {
    // The Kp feed proves the repair lives in fetchFeed, not in an RTSW-specific mapper.
    mockFetch.mockResolvedValue(
      makeRawResponse(
        '[{"time_tag":"2026-06-23T00:00:00","Kp":3,"a_running":Infinity,"station_count":-Infinity}]',
      ),
    );

    const obs = await makeService().getKpObserved(createMockContext() as never);

    expect(obs[0]!.kp).toBe(3);
    expect(obs[0]!.aRunning).toBeNull();
    expect(obs[0]!.stationCount).toBeNull();
  });

  it('leaves NaN inside a quoted string value exactly as it is', async () => {
    mockFetch.mockResolvedValue(
      makeRawResponse(
        '[{"active":true,"source":"speed: NaN reported","proton_speed":NaN,"proton_density":5.1,"proton_temperature":90000,"time_tag":"2026-08-11 00:00:00.000"}]',
      ),
    );

    const plasma = await makeService().getSolarWindPlasma(createMockContext() as never);

    expect(plasma[0]!.source).toBe('speed: NaN reported');
    expect(plasma[0]!.speedKmS).toBeNull();
  });

  it('leaves NaN inside a key name exactly as it is', async () => {
    // The scales feed reports its own keys back when "0" is absent, so a key name
    // surviving the repair is observable through the public method.
    mockFetch.mockResolvedValue(
      makeRawResponse('{"NaN_diagnostics":{"note":"sensor NaN"},"9":{"DateStamp":NaN}}'),
    );

    // Integer-like keys enumerate first, so "9" precedes the diagnostics key.
    await expect(makeService().getNoaaScales(createMockContext() as never)).rejects.toMatchObject({
      data: { available: ['9', 'NaN_diagnostics'] },
    });
  });

  it('still fails an ordinarily malformed body on the service-unavailable path', async () => {
    // Truncated array — no non-finite token, so the repair never applies.
    mockFetch.mockResolvedValue(makeRawResponse('[{"active":true,"proton_speed":475.4'));

    await expect(
      makeService().getSolarWindPlasma(createMockContext() as never),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        'Failed to parse SWPC feed JSON from /json/rtsw/rtsw_wind_1m.json.',
      ),
      data: { path: '/json/rtsw/rtsw_wind_1m.json' },
    });
  });

  it('still fails a body whose only non-finite tokens sit inside strings and cannot repair it', async () => {
    // Quoted NaN is left alone, so the trailing comma remains the fatal error.
    mockFetch.mockResolvedValue(makeRawResponse('[{"source":"NaN","active":true,}]'));

    await expect(
      makeService().getSolarWindPlasma(createMockContext() as never),
    ).rejects.toMatchObject({
      data: { path: '/json/rtsw/rtsw_wind_1m.json' },
    });
  });

  it('parses a valid body to the identical result', async () => {
    const body =
      '[{"active":true,"source":"SOLAR1","proton_speed":475.4,"proton_density":4.95,"proton_temperature":304713,"time_tag":"2026-07-16T05:00:00"}]';
    mockFetch.mockResolvedValue(makeRawResponse(body));

    const plasma = await makeService().getSolarWindPlasma(createMockContext() as never);

    expect(plasma).toEqual([
      {
        timeTag: '2026-07-16T05:00:00Z',
        source: 'SOLAR1',
        densityPerCm3: 4.95,
        speedKmS: 475.4,
        temperatureK: 304713,
      },
    ]);
  });

  it('still rejects an HTML error page before any JSON repair is attempted', async () => {
    mockFetch.mockResolvedValue(makeRawResponse('<!DOCTYPE html><html><body>429</body></html>'));

    await expect(
      makeService().getSolarWindPlasma(createMockContext() as never),
    ).rejects.toMatchObject({
      message: expect.stringContaining('SWPC feed returned HTML instead of JSON'),
    });
  });
});
