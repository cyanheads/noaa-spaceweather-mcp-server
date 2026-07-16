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
