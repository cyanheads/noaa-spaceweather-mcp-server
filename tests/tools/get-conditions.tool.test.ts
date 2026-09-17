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
  // Forecast R/S mirror the live feed: no level, a probability instead.
  const forecastEntry = (cat: 'R' | 'S', minorProb: number | null, majorProb: number | null) => ({
    category: cat,
    scale: null,
    text: null,
    minorProb,
    majorProb,
  });
  const period = (date: string) => ({
    date,
    time: '15:00:00',
    observedAt: `${date}T15:00:00Z`,
    G: makeEntry('G', gScale),
    R: makeEntry('R', rScale),
    S: makeEntry('S', sScale),
  });
  const forecastPeriod = (date: string) => ({
    date,
    time: '00:00:00',
    observedAt: `${date}T00:00:00Z`,
    G: makeEntry('G', gScale),
    R: forecastEntry('R', 5, 1),
    S: forecastEntry('S', 1, null),
  });
  return {
    today: period('2026-06-04'),
    forecast: [forecastPeriod('2026-06-05'), forecastPeriod('2026-06-06')],
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
      getForecastDiscussion: vi.fn(),
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
    expect(result.observedAt).toBe('2026-06-04T15:00:00Z');
    // Forecast R/S carry the probabilities SWPC issued and claim no level.
    expect(result.forecast[0]!.R.scale).toBeNull();
    expect(result.forecast[0]!.R.label).toBeNull();
    expect(result.forecast[0]!.R.minorProbPercent).toBe(5);
    expect(result.forecast[0]!.R.majorProbPercent).toBe(1);
    expect(result.forecast[0]!.S.scale).toBeNull();
    expect(result.forecast[0]!.S.probPercent).toBe(1);
    // Not requested, so the discussion product was never fetched.
    expect(result.discussion).toBeNull();
    expect(svc.getForecastDiscussion).not.toHaveBeenCalled();
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
      observedAt: '2026-06-04T15:00:00Z',
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
          R: { scale: null, text: null, label: null, minorProbPercent: 5, majorProbPercent: 1 },
          S: { scale: null, text: null, label: null, probPercent: 1 },
        },
      ],
      summary: 'Quiet conditions — no significant storms active.',
      discussion: null,
    };
    const blocks = getConditions.format!(result);
    expect(blocks[0]!.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('2026-06-04T15:00:00Z');
    expect(text).toContain('Quiet conditions');
    expect(text).toContain('G0');
    expect(text).toContain('3-Day Forecast');
    expect(text).toContain('G1');
    expect(text).toContain('R: 5% R1–R2, 1% R3+');
    expect(text).toContain('S: 1% S1+');
    // Total over a null discussion — no section is emitted for it.
    expect(text).not.toContain('Forecast Discussion');
  });

  it('normalizes "none" and empty text to "—" in format output (issue #5)', () => {
    const result = {
      observedAt: '2026-06-04T15:00:00Z',
      currentKp: 0,
      currentGScale: 0,
      auroraLatitude: 'No significant aurora expected at mid-latitudes',
      today: {
        G: { scale: 0, text: 'none', label: 'G0' }, // NOAA feed literal
        R: { scale: 0, text: '', label: 'R0' }, // empty string fallback
        S: { scale: 0, text: 'None', label: 'S0' }, // capitalised variant
      },
      forecast: [
        {
          date: '2026-06-05',
          G: { scale: 0, text: 'none', label: 'G0' },
          // A forecast day SWPC issued nothing at all for.
          R: {
            scale: null,
            text: null,
            label: null,
            minorProbPercent: null,
            majorProbPercent: null,
          },
          S: { scale: null, text: null, label: null, probPercent: null },
        },
      ],
      summary: 'Quiet conditions — no significant storms active.',
      discussion: null,
    };
    const blocks = getConditions.format!(result);
    const text = (blocks[0] as { text: string }).text;
    // All scale-0 entries should render as "—", never "none" or "None"
    expect(text).not.toContain('none');
    expect(text).not.toContain('None');
    expect(text).toMatch(/G0 \(scale 0\) —/);
    // A forecast day with no level and no probability reads as unknown, not level 0.
    expect(text).toContain('R: — | S: —');
  });

  it('includes forecast storm in summary when current conditions are quiet (issue #2)', async () => {
    // Today is quiet, but G3 forecast for the next day
    const scalesWithForecast: import('@/services/space-weather/types.js').NoaaScalesData = {
      today: {
        date: '2026-06-04',
        time: '15:00:00',
        observedAt: '2026-06-04T15:00:00Z',
        G: { category: 'G', scale: 0, text: '', minorProb: null, majorProb: null },
        R: { category: 'R', scale: 0, text: '', minorProb: null, majorProb: null },
        S: { category: 'S', scale: 0, text: '', minorProb: null, majorProb: null },
      },
      forecast: [
        {
          date: '2026-06-05',
          time: '00:00:00',
          observedAt: '2026-06-05T00:00:00Z',
          G: { category: 'G', scale: 3, text: 'Strong', minorProb: 60, majorProb: null },
          R: { category: 'R', scale: null, text: null, minorProb: 25, majorProb: 5 },
          S: { category: 'S', scale: null, text: null, minorProb: 10, majorProb: null },
        },
      ],
    };
    const svc = {
      getNoaaScales: vi.fn().mockResolvedValue(scalesWithForecast),
      getKpObserved: vi.fn().mockResolvedValue(makeKpObservations(1)),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);

    const ctx = createMockContext({ errors: getConditions.errors });
    const input = getConditions.input.parse({});
    const result = await getConditions.handler(input, ctx);

    expect(result.summary).toMatch(/Quiet now/);
    expect(result.summary).toMatch(/G3/);
    expect(result.summary).toMatch(/2026-06-05/);
  });
});

/**
 * The live `noaa-scales.json` shape for a forecast period: SWPC issues no R/S level
 * for a future day, so `Scale`/`Text` are null and the probability fields carry the
 * forecast instead. Key "1" repeats key "0"'s DateStamp — the series opens on today.
 */
function makeProbabilityForecastScales(): NoaaScalesData {
  const observed = (category: 'G' | 'R' | 'S') => ({
    category,
    scale: 0,
    text: 'none',
    minorProb: null,
    majorProb: null,
  });
  return {
    today: {
      date: '2026-09-17',
      time: '17:13:00',
      observedAt: '2026-09-17T17:13:00Z',
      G: observed('G'),
      R: observed('R'),
      S: observed('S'),
    },
    forecast: [
      {
        date: '2026-09-17',
        time: '17:13:00',
        observedAt: '2026-09-17T17:13:00Z',
        G: { category: 'G', scale: 1, text: 'minor', minorProb: null, majorProb: null },
        R: { category: 'R', scale: null, text: null, minorProb: 5, majorProb: 1 },
        S: { category: 'S', scale: null, text: null, minorProb: 1, majorProb: null },
      },
      {
        date: '2026-09-18',
        time: '00:00:00',
        observedAt: '2026-09-18T00:00:00Z',
        G: { category: 'G', scale: 0, text: 'none', minorProb: null, majorProb: null },
        R: { category: 'R', scale: null, text: null, minorProb: 5, majorProb: 1 },
        S: { category: 'S', scale: null, text: null, minorProb: 1, majorProb: null },
      },
      {
        date: '2026-09-19',
        time: '00:00:00',
        observedAt: '2026-09-19T00:00:00Z',
        G: { category: 'G', scale: 0, text: 'none', minorProb: null, majorProb: null },
        R: { category: 'R', scale: null, text: null, minorProb: null, majorProb: null },
        S: { category: 'S', scale: null, text: null, minorProb: null, majorProb: null },
      },
    ],
  };
}

describe('getConditions forecast R/S probabilities (#23)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  async function run() {
    const svc = {
      getNoaaScales: vi.fn().mockResolvedValue(makeProbabilityForecastScales()),
      getKpObserved: vi.fn().mockResolvedValue(makeKpObservations(1)),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: getConditions.errors });
    return getConditions.handler(getConditions.input.parse({}), ctx);
  }

  it('reports a null R/S scale and the issued probabilities in structuredContent', async () => {
    const result = await run();

    expect(result.forecast[0]!.R).toEqual({
      scale: null,
      text: null,
      label: null,
      minorProbPercent: 5,
      majorProbPercent: 1,
    });
    expect(result.forecast[0]!.S).toEqual({
      scale: null,
      text: null,
      label: null,
      probPercent: 1,
    });
    // G keeps its existing shape — it carries a real forecast level.
    expect(result.forecast[0]!.G).toEqual({ scale: 1, text: 'minor', label: 'G1' });
  });

  it('carries the probabilities on every forecast day, not only the first', async () => {
    const result = await run();

    expect(result.forecast).toHaveLength(3);
    expect(result.forecast[1]!.R.minorProbPercent).toBe(5);
    expect(result.forecast[1]!.S.probPercent).toBe(1);
    // Day three has neither a scale nor a probability upstream.
    expect(result.forecast[2]!.R.minorProbPercent).toBeNull();
    expect(result.forecast[2]!.R.scale).toBeNull();
    expect(result.forecast[2]!.S.probPercent).toBeNull();
  });

  it('emits observedAt as ISO 8601 UTC', async () => {
    const result = await run();

    expect(result.observedAt).toBe('2026-09-17T17:13:00Z');
  });

  it('says "today" rather than naming today as a future forecast day', async () => {
    const result = await run();

    expect(result.summary).toMatch(/Quiet now/);
    expect(result.summary).toMatch(/G1/);
    expect(result.summary).toMatch(/today/i);
    expect(result.summary).not.toContain('2026-09-17');
  });

  it('renders every non-null probability in format output', async () => {
    const result = await run();
    const text = (getConditions.format!(result)[0] as { text: string }).text;

    expect(text).toContain('2026-09-17T17:13:00Z');
    expect(text).toContain('R: 5% R1–R2, 1% R3+');
    expect(text).toContain('S: 1% S1+');
  });

  it('never claims a forecast R/S level upstream left null', async () => {
    const result = await run();
    const text = (getConditions.format!(result)[0] as { text: string }).text;
    // Scoped to the forecast block — today's observed R0/S0 are a real level 0.
    const forecastBlock = text.slice(text.indexOf('### 3-Day Forecast'));

    expect(forecastBlock).not.toContain('R0');
    expect(forecastBlock).not.toContain('S0');
    // Day three: upstream issued neither a level nor a probability for R or S.
    expect(forecastBlock).toContain('R: — | S: —');
    // G does carry a real forecast level and still renders one.
    expect(forecastBlock).toContain('G1 (scale 1)');
  });

  it('renders a day carrying both a level and a probability', async () => {
    const result = await run();
    result.forecast[0]!.R = {
      scale: 1,
      text: 'minor',
      label: 'R1',
      minorProbPercent: 30,
      majorProbPercent: 5,
    };
    const text = (getConditions.format!(result)[0] as { text: string }).text;

    // Both halves render — gating the probabilities on a null level would hide them.
    expect(text).toContain('R: R1 (scale 1) minor · 30% R1–R2, 5% R3+');
  });
});

/**
 * The three level-carrying surfaces — today's R/S/G and each forecast day's G — are
 * the ones whose schema declares a non-null `scale`. SWPC populates a real `Scale` on
 * all of them, so a null there is upstream answering without the shape the product is
 * documented to have, and the tool reports it as one instead of resolving it to level
 * 0 — the claim #23 removed from the forecast R/S.
 */
describe('getConditions level-carrying scales are never inferred (#23)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function runWith(scales: NoaaScalesData) {
    mockGetSpaceWeatherService.mockReturnValue({
      getNoaaScales: vi.fn().mockResolvedValue(scales),
      getKpObserved: vi.fn().mockResolvedValue(makeKpObservations(1)),
    } as never);
    const ctx = createMockContext({ errors: getConditions.errors });
    return getConditions.handler(getConditions.input.parse({}), ctx);
  }

  it.each(['G', 'R', 'S'] as const)(
    "reports a null %s level on today's period as a shape break, not level 0",
    async (category) => {
      const scales = makeScalesData();
      scales.today[category] = { ...scales.today[category], scale: null, text: null };

      await expect(runWith(scales)).rejects.toMatchObject({
        data: { reason: 'feed_moved', retryable: false },
      });
    },
  );

  it('reports a null forecast G level as a shape break, not a quiet day', async () => {
    const scales = makeScalesData();
    scales.forecast[0]!.G = { ...scales.forecast[0]!.G, scale: null, text: null };

    await expect(runWith(scales)).rejects.toMatchObject({
      data: { reason: 'feed_moved', retryable: false },
    });
  });

  it('names the period and category so the break is diagnosable', async () => {
    const scales = makeScalesData();
    scales.forecast[1]!.G = { ...scales.forecast[1]!.G, scale: null, text: null };

    await expect(runWith(scales)).rejects.toMatchObject({
      message: expect.stringContaining('2026-06-06'),
    });
  });
});

const DISCUSSION = {
  issued: '2026-09-17T12:30:00Z',
  sections: [
    {
      topic: 'Solar Activity',
      summary: 'Solar activity continued at very low levels.',
      forecast: 'Very low levels are expected through 19 Sep.',
    },
    {
      topic: 'Geospace',
      summary: 'The geomagnetic field was quiet.',
      forecast: 'Active to G1 (Minor) storm levels are likely on 17 Sep.',
    },
  ],
};

describe('getConditions include_discussion (#32)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function mockService() {
    const svc = {
      getNoaaScales: vi.fn().mockResolvedValue(makeScalesData()),
      getKpObserved: vi.fn().mockResolvedValue(makeKpObservations(1)),
      getForecastDiscussion: vi.fn().mockResolvedValue(DISCUSSION),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);
    return svc;
  }

  it('defaults to false and leaves discussion null', () => {
    expect(getConditions.input.parse({})).toEqual({ include_discussion: false });
  });

  it('rejects a non-boolean include_discussion at the schema', () => {
    expect(() => getConditions.input.parse({ include_discussion: 'yes' })).toThrow();
  });

  it('fetches and returns the discussion when asked', async () => {
    const svc = mockService();
    const ctx = createMockContext({ errors: getConditions.errors });

    const result = await getConditions.handler(
      getConditions.input.parse({ include_discussion: true }),
      ctx,
    );

    expect(svc.getForecastDiscussion).toHaveBeenCalledTimes(1);
    expect(result.discussion?.issued).toBe('2026-09-17T12:30:00Z');
    expect(result.discussion?.sections).toHaveLength(2);
    // Past the first element — the nested array is walked, not just sampled.
    expect(result.discussion?.sections[1]?.topic).toBe('Geospace');
    expect(result.discussion?.sections[1]?.forecast).toContain('G1 (Minor)');
  });

  it('renders the issue time and every section in format output', async () => {
    mockService();
    const ctx = createMockContext({ errors: getConditions.errors });
    const result = await getConditions.handler(
      getConditions.input.parse({ include_discussion: true }),
      ctx,
    );

    const text = (getConditions.format!(result)[0] as { text: string }).text;

    expect(text).toContain('SWPC Forecast Discussion');
    expect(text).toContain('Issued 2026-09-17T12:30:00Z');
    expect(text).toContain('**Solar Activity**');
    expect(text).toContain('Solar activity continued at very low levels.');
    expect(text).toContain('Very low levels are expected through 19 Sep.');
    expect(text).toContain('**Geospace**');
    expect(text).toContain('Active to G1 (Minor) storm levels are likely on 17 Sep.');
  });

  it('format is total over a null summary, forecast, and issue time', async () => {
    mockService();
    const ctx = createMockContext({ errors: getConditions.errors });
    const result = await getConditions.handler(
      getConditions.input.parse({ include_discussion: true }),
      ctx,
    );
    result.discussion = {
      issued: null,
      sections: [
        { topic: 'Solar Activity', summary: 'Quiet.', forecast: null },
        { topic: 'Solar Wind', summary: null, forecast: 'Elevated speeds likely.' },
        { topic: 'Geospace', summary: null, forecast: null },
      ],
    };

    const text = (getConditions.format!(result)[0] as { text: string }).text;

    expect(text).toContain('Issue time not stated in the product.');
    expect(text).toContain('_Past 24 h:_ Quiet.');
    expect(text).toContain('_Forecast:_ Elevated speeds likely.');
    expect(text).toContain('No text in this section.');
  });

  it('surfaces a discussion-feed failure as the declared reason', async () => {
    const svc = {
      getNoaaScales: vi.fn().mockResolvedValue(makeScalesData()),
      getKpObserved: vi.fn().mockResolvedValue(makeKpObservations(1)),
      getForecastDiscussion: vi.fn().mockRejectedValue(
        Object.assign(new Error('discussion feed gone'), {
          data: { reason: 'feed_moved', path: '/text/discussion.txt' },
        }),
      ),
    };
    mockGetSpaceWeatherService.mockReturnValue(svc as never);
    const ctx = createMockContext({ errors: getConditions.errors });

    await expect(
      getConditions.handler(getConditions.input.parse({ include_discussion: true }), ctx),
    ).rejects.toMatchObject({ data: { reason: 'feed_moved', path: '/text/discussion.txt' } });
  });
});
