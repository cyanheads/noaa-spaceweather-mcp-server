/**
 * @fileoverview Wire-shape tests for the SWPC feed-failure error contract: every
 * upstream failure class must reach the client as a declared reason
 * (`feed_unavailable` or `feed_moved`) with the contract recovery hint on both
 * client surfaces, the feed path in `data`, and an unchanged attempt count.
 *
 * Seam: the real `SpaceWeatherService` and the real `withRetry` loop run, with only
 * `globalThis.fetch` stubbed, and the tool definitions are driven through
 * `runToolContract` so the assertions read the same `CallToolResult` a client gets.
 * The two existing seams cannot cover this — `tests/tools/*.tool.test.ts` mock the
 * whole service module, and `tests/services/space-weather-service.test.ts` replaces
 * `withRetry` with a pass-through, so neither the classification nor the retry loop
 * executes there.
 *
 * @module tests/services/feed-failure-contract.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAlerts } from '@/mcp-server/tools/definitions/get-alerts.tool.js';
import { getAuroraForecast } from '@/mcp-server/tools/definitions/get-aurora-forecast.tool.js';
import { getConditions } from '@/mcp-server/tools/definitions/get-conditions.tool.js';
import { getKpIndex } from '@/mcp-server/tools/definitions/get-kp-index.tool.js';
import { getSolarActivity } from '@/mcp-server/tools/definitions/get-solar-activity.tool.js';
import { getSolarWind } from '@/mcp-server/tools/definitions/get-solar-wind.tool.js';
import { initSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

/** The `CallToolResult` a client receives — the MCP SDK type, via the runner's own return. */
type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

const BASE_URL = 'https://services.swpc.noaa.gov';

const SCALES_PATH = '/products/noaa-scales.json';
const KP_OBSERVED_PATH = '/products/noaa-planetary-k-index.json';
const AURORA_PATH = '/json/ovation_aurora_latest.json';
const WIND_PATH = '/json/rtsw/rtsw_wind_1m.json';
const XRAY_PATH = '/json/goes/primary/xrays-7-day.json';
const ALERTS_PATH = '/products/alerts.json';

/**
 * A minimal valid body per feed path, so a case can fail exactly one feed and every
 * other feed the tool composes still succeeds — which is what makes the stubbed
 * fetch call count an attempt count for the path under test.
 */
const FEED_BODIES: Record<string, unknown> = {
  [SCALES_PATH]: {
    '0': {
      DateStamp: '2026-09-17',
      TimeStamp: '12:00:00',
      G: { Scale: '0', Text: 'none', Prob: null },
      R: { Scale: '0', Text: 'none', MinorProb: null, MajorProb: null },
      S: { Scale: '0', Text: 'none', Prob: null },
    },
  },
  [KP_OBSERVED_PATH]: [{ time_tag: '2026-09-17T00:00:00', Kp: 2, a_running: 5, station_count: 8 }],
  '/products/noaa-planetary-k-index-forecast.json': [
    { time_tag: '2026-09-17T03:00:00', kp: 2, observed: 'predicted', noaa_scale: null },
  ],
  [AURORA_PATH]: {
    'Observation Time': '2026-09-17T12:00:00Z',
    'Forecast Time': '2026-09-17T12:30:00Z',
    'Data Format': '[Longitude, Latitude, Aurora]',
    coordinates: [[0, 0, 0]],
  },
  [WIND_PATH]: [],
  '/json/rtsw/rtsw_mag_1m.json': [],
  [XRAY_PATH]: [],
  '/json/solar_probabilities.json': [],
  '/json/goes/primary/integral-protons-plot-3-day.json': [],
  '/json/solar_regions.json': [],
  [ALERTS_PATH]: [],
};

/** How the stub answers the path under test. */
type FeedFailure = (init: RequestInit | undefined) => Promise<Response>;

/** Non-OK HTTP response, the shape `fetchWithTimeout` maps to a status-coded error. */
function httpStatus(status: number, statusText?: string): FeedFailure {
  return () =>
    Promise.resolve(
      new Response('upstream error page', {
        status,
        ...(statusText ? { statusText } : {}),
      }),
    );
}

/** HTTP 200 carrying an arbitrary body — an unparseable payload or an HTML page. */
function body200(text: string, headers?: Record<string, string>): FeedFailure {
  return () => Promise.resolve(new Response(text, { status: 200, ...(headers && { headers }) }));
}

/** A transport-level failure, as `fetch` itself raises it. */
function networkError(): FeedFailure {
  return () => Promise.reject(new TypeError('fetch failed'));
}

/** A peer that never answers, so only the client-side deadline ends the exchange. */
function noAnswer(): FeedFailure {
  return (init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
}

/** Aborts the caller's signal on the first request, then never answers. */
function abortCaller(controller: AbortController): FeedFailure {
  return (init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      controller.abort();
    });
}

let fetchCalls: string[] = [];
const realFetch = globalThis.fetch;

/** Route every SWPC path to its valid body, and `targetPath` to `failure`. */
function installFetch(targetPath: string, failure: FeedFailure): void {
  fetchCalls = [];
  globalThis.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push(url);
    const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
    if (path === targetPath) return failure(init);
    const known = FEED_BODIES[path];
    if (known === undefined) return Promise.reject(new Error(`Unstubbed SWPC path: ${path}`));
    return Promise.resolve(Response.json(known));
  }) as unknown as typeof globalThis.fetch;
}

/** Stubbed requests for one feed path — the attempt count the retry loop actually made. */
function attemptsFor(targetPath: string): number {
  return fetchCalls.filter((url) => url.endsWith(targetPath)).length;
}

type ToolErrorEnvelope = {
  code: number;
  message: string;
  data?: Record<string, unknown> | undefined;
};

/** The `structuredContent.error` surface, asserted to be present. */
function errorOf(result: ToolResult): ToolErrorEnvelope {
  expect(result.isError).toBe(true);
  const structured = result.structuredContent as { error?: ToolErrorEnvelope } | undefined;
  expect(structured?.error).toBeDefined();
  return structured?.error as ToolErrorEnvelope;
}

/** The `content[]` surface format()-only clients read. */
function textOf(result: ToolResult): string {
  return (result.content?.[0] as { text?: string } | undefined)?.text ?? '';
}

/** The recovery string a definition declares for `reason` — the contract, not a copy. */
function declaredRecovery(
  definition: { errors?: readonly { reason: string; recovery: string }[] | undefined },
  reason: string,
): string {
  const entry = definition.errors?.find((candidate) => candidate.reason === reason);
  expect(entry, `contract entry for ${reason}`).toBeDefined();
  return entry?.recovery as string;
}

/**
 * Run a tool against a stubbed feed failure. Retried classes spend ~7 s of backoff and
 * the client deadline 15 s per attempt, so the fake clock is advanced past the whole
 * budget rather than slowing the suite or loosening `fetchFeed`'s real configuration.
 */
async function callWithFailure(
  definition: Parameters<typeof runToolContract>[0],
  input: Parameters<typeof runToolContract>[1],
  targetPath: string,
  failure: FeedFailure,
  options?: Parameters<typeof runToolContract>[2],
): Promise<ToolResult> {
  installFetch(targetPath, failure);
  const pending = runToolContract(definition, input, options);
  await vi.advanceTimersByTimeAsync(300_000);
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers();
  initSpaceWeatherService({ mcpServerVersion: '0.0.0-test' } as never, {} as never);
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('feed failure classification by upstream failure class', () => {
  const HTTP_CASES: {
    label: string;
    status: number;
    statusText?: string;
    reason: 'feed_moved' | 'feed_unavailable';
    attempts: number;
  }[] = [
    { label: '404', status: 404, statusText: 'Not Found', reason: 'feed_moved', attempts: 1 },
    { label: '410', status: 410, reason: 'feed_moved', attempts: 1 },
    { label: '401', status: 401, reason: 'feed_moved', attempts: 1 },
    { label: '403', status: 403, reason: 'feed_moved', attempts: 1 },
    { label: '400', status: 400, reason: 'feed_moved', attempts: 1 },
    { label: '415', status: 415, reason: 'feed_moved', attempts: 1 },
    { label: '422', status: 422, reason: 'feed_moved', attempts: 1 },
    { label: '409', status: 409, reason: 'feed_moved', attempts: 1 },
    // A 4xx the framework classifies as Timeout and retries, so it belongs with the
    // transient set — labelling it feed_moved would claim one attempt after four.
    { label: '408', status: 408, reason: 'feed_unavailable', attempts: 4 },
    { label: '425', status: 425, reason: 'feed_unavailable', attempts: 4 },
    { label: '429', status: 429, reason: 'feed_unavailable', attempts: 4 },
    { label: '500', status: 500, reason: 'feed_unavailable', attempts: 4 },
    { label: '502', status: 502, reason: 'feed_unavailable', attempts: 4 },
    {
      label: '503',
      status: 503,
      statusText: 'Service Unavailable',
      reason: 'feed_unavailable',
      attempts: 4,
    },
    { label: '504', status: 504, reason: 'feed_unavailable', attempts: 4 },
  ];

  it.each(HTTP_CASES)(
    'HTTP $label carries $reason as ServiceUnavailable in $attempts attempt(s)',
    async ({ status, statusText, reason, attempts }) => {
      const result = await callWithFailure(
        getAlerts,
        {},
        ALERTS_PATH,
        httpStatus(status, statusText),
      );
      const error = errorOf(result);
      const hint = declaredRecovery(getAlerts, reason);

      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data?.reason).toBe(reason);
      expect(error.data?.recovery).toEqual({ hint });
      expect(textOf(result)).toContain(`Recovery: ${hint}`);
      expect(error.data?.path).toBe(ALERTS_PATH);
      expect(error.data?.status).toBe(status);
      if (statusText) expect(error.data?.statusText).toBe(statusText);

      expect(attemptsFor(ALERTS_PATH)).toBe(attempts);
      if (attempts > 1) expect(error.data?.retryAttempts).toBe(attempts);
      else expect(error.data?.retryAttempts).toBeUndefined();
    },
  );

  it('keeps the upstream Retry-After hint on a retried 429', async () => {
    const result = await callWithFailure(getAlerts, {}, ALERTS_PATH, () =>
      Promise.resolve(new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })),
    );
    const error = errorOf(result);

    expect(error.data?.reason).toBe('feed_unavailable');
    expect(error.data?.retryAfter).toBe('2');
    expect(attemptsFor(ALERTS_PATH)).toBe(4);
  });

  it('classifies a transport-level network error as feed_unavailable with the feed path', async () => {
    const result = await callWithFailure(getSolarWind, {}, WIND_PATH, networkError());
    const error = errorOf(result);
    const hint = declaredRecovery(getSolarWind, 'feed_unavailable');

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('feed_unavailable');
    expect(error.data?.recovery).toEqual({ hint });
    expect(textOf(result)).toContain(`Recovery: ${hint}`);
    expect(error.data?.path).toBe(WIND_PATH);
    expect(error.data?.retryAttempts).toBe(4);
    expect(attemptsFor(WIND_PATH)).toBe(4);
  });

  it('classifies the client-side fetch deadline as feed_unavailable', async () => {
    const result = await callWithFailure(getKpIndex, {}, KP_OBSERVED_PATH, noAnswer());
    const error = errorOf(result);

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('feed_unavailable');
    expect(error.data?.path).toBe(KP_OBSERVED_PATH);
    expect(error.data?.retryAttempts).toBe(4);
    expect(attemptsFor(KP_OBSERVED_PATH)).toBe(4);
  });

  it('classifies an unparseable JSON body as feed_unavailable', async () => {
    const result = await callWithFailure(getAlerts, {}, ALERTS_PATH, body200('{"not valid json'));
    const error = errorOf(result);
    const hint = declaredRecovery(getAlerts, 'feed_unavailable');

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('feed_unavailable');
    expect(error.data?.recovery).toEqual({ hint });
    expect(textOf(result)).toContain(`Recovery: ${hint}`);
    expect(error.data?.path).toBe(ALERTS_PATH);
    expect(error.data?.retryAttempts).toBe(4);
    expect(attemptsFor(ALERTS_PATH)).toBe(4);
  });

  it('classifies an HTML body served as 200 as feed_unavailable', async () => {
    const result = await callWithFailure(
      getSolarActivity,
      {},
      XRAY_PATH,
      body200('<!DOCTYPE html><html><body>429</body></html>', { 'content-type': 'text/html' }),
    );
    const error = errorOf(result);

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('feed_unavailable');
    expect(error.data?.path).toBe(XRAY_PATH);
    expect(error.data?.retryAttempts).toBe(4);
    expect(attemptsFor(XRAY_PATH)).toBe(4);
  });

  it('classifies the scales feed missing key "0" as feed_moved in one attempt', async () => {
    const result = await callWithFailure(getConditions, {}, SCALES_PATH, () =>
      Promise.resolve(Response.json({ '1': FEED_BODIES[SCALES_PATH] })),
    );
    const error = errorOf(result);
    const hint = declaredRecovery(getConditions, 'feed_moved');

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('feed_moved');
    expect(error.data?.recovery).toEqual({ hint });
    expect(textOf(result)).toContain(`Recovery: ${hint}`);
    expect(error.data?.path).toBe(SCALES_PATH);
    // The diagnostic listing of the keys the feed did carry survives the enrichment.
    expect(error.data?.available).toEqual(['1']);
    expect(attemptsFor(SCALES_PATH)).toBe(1);
  });
});

describe('fail-fast and neighbouring-error regressions', () => {
  it('spends exactly one upstream attempt on a 404, a 403, and the missing-key case', async () => {
    const notFound = await callWithFailure(getAlerts, {}, ALERTS_PATH, httpStatus(404));
    expect(errorOf(notFound).data?.reason).toBe('feed_moved');
    expect(attemptsFor(ALERTS_PATH)).toBe(1);

    const forbidden = await callWithFailure(getAlerts, {}, ALERTS_PATH, httpStatus(403));
    expect(errorOf(forbidden).data?.reason).toBe('feed_moved');
    expect(attemptsFor(ALERTS_PATH)).toBe(1);

    const missingKey = await callWithFailure(getConditions, {}, SCALES_PATH, () =>
      Promise.resolve(Response.json({ '2': FEED_BODIES[SCALES_PATH] })),
    );
    expect(errorOf(missingKey).data?.reason).toBe('feed_moved');
    expect(attemptsFor(SCALES_PATH)).toBe(1);
  });

  it('leaves a caller abort as RequestCancelled with no declared reason', async () => {
    const controller = new AbortController();
    const result = await callWithFailure(getSolarWind, {}, WIND_PATH, abortCaller(controller), {
      context: { signal: controller.signal },
    });
    const error = errorOf(result);

    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error.data?.reason).toBeUndefined();
    expect(error.data?.recovery).toBeUndefined();
    expect(textOf(result)).not.toContain('Recovery:');
    expect(attemptsFor(WIND_PATH)).toBe(1);
  });

  it('leaves the invalid_coordinates path untouched', async () => {
    installFetch(AURORA_PATH, httpStatus(500));
    const result = await runToolContract(getAuroraForecast, { latitude: 47.6 });
    const error = errorOf(result);
    const hint = declaredRecovery(getAuroraForecast, 'invalid_coordinates');

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_coordinates');
    expect(error.data?.recovery).toEqual({ hint });
    expect(textOf(result)).toContain(`Recovery: ${hint}`);
    // The coordinate check runs before any feed call.
    expect(attemptsFor(AURORA_PATH)).toBe(0);
  });
});

describe('contract reachability across the tool surface', () => {
  const TOOLS: {
    name: string;
    definition: Parameters<typeof runToolContract>[0];
    path: string;
  }[] = [
    { name: 'noaa_spaceweather_get_conditions', definition: getConditions, path: SCALES_PATH },
    { name: 'noaa_spaceweather_get_kp_index', definition: getKpIndex, path: KP_OBSERVED_PATH },
    {
      name: 'noaa_spaceweather_get_aurora_forecast',
      definition: getAuroraForecast,
      path: AURORA_PATH,
    },
    { name: 'noaa_spaceweather_get_solar_wind', definition: getSolarWind, path: WIND_PATH },
    { name: 'noaa_spaceweather_get_solar_activity', definition: getSolarActivity, path: XRAY_PATH },
    { name: 'noaa_spaceweather_get_alerts', definition: getAlerts, path: ALERTS_PATH },
  ];

  it.each(TOOLS)('$name produces feed_moved on the wire', async ({ definition, path }) => {
    const result = await callWithFailure(definition, {}, path, httpStatus(404, 'Not Found'));
    const error = errorOf(result);
    const hint = declaredRecovery(definition, 'feed_moved');

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('feed_moved');
    expect(error.data?.recovery).toEqual({ hint });
    expect(textOf(result)).toContain(`Recovery: ${hint}`);
    expect(error.data?.path).toBe(path);
    expect(attemptsFor(path)).toBe(1);
  });

  it.each(TOOLS)('$name produces feed_unavailable on the wire', async ({ definition, path }) => {
    const result = await callWithFailure(
      definition,
      {},
      path,
      httpStatus(503, 'Service Unavailable'),
    );
    const error = errorOf(result);
    const hint = declaredRecovery(definition, 'feed_unavailable');

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('feed_unavailable');
    expect(error.data?.recovery).toEqual({ hint });
    expect(textOf(result)).toContain(`Recovery: ${hint}`);
    expect(error.data?.path).toBe(path);
    expect(error.data?.retryAttempts).toBe(4);
    expect(attemptsFor(path)).toBe(4);
  });

  it('gives the two feed reasons opposite retry guidance on every tool', () => {
    for (const { definition } of TOOLS) {
      const unavailable = definition.errors?.find((e) => e.reason === 'feed_unavailable');
      const moved = definition.errors?.find((e) => e.reason === 'feed_moved');

      expect(unavailable?.retryable).toBe(true);
      expect(moved?.retryable).toBe(false);
      expect(unavailable?.recovery).toMatch(/retry/i);
      expect(moved?.recovery).toMatch(/will not help/i);
      expect(moved?.recovery).not.toBe(unavailable?.recovery);
    }
  });
});
