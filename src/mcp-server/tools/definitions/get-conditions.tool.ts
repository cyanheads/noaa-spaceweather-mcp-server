/**
 * @fileoverview Tool: noaa_spaceweather_get_conditions — current space-weather snapshot.
 * @module mcp-server/tools/definitions/get-conditions
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';
import type { NoaaScaleEntry, NoaaScalesPeriod } from '@/services/space-weather/types.js';

// ── Output sub-schemas ──────────────────────────────────────────────────────

const ScaleSummarySchema = z
  .object({
    scale: z.number().describe('Level 0–5.'),
    text: z.string().describe('Descriptor, e.g. "Moderate"; "none" at level 0.'),
    label: z.string().describe('Label, e.g. "G2".'),
  })
  .describe('One NOAA scale level.');

const NullableScaleSchema = z
  .object({
    scale: z.number().nullable().describe('Whole-number level 0–5, or null when unissued.'),
    text: z.string().nullable().describe('Descriptor, or null when SWPC issued no level.'),
    label: z.string().nullable().describe('Label, e.g. "G2", or null when SWPC issued no level.'),
  })
  .describe('An NOAA scale entry. An unissued level has all three fields null.');

/**
 * SWPC issues R/S probabilities for forecast days. The R/S asymmetry is upstream's:
 * two probabilities for R, one for S.
 */
const RadioForecastSchema = z
  .object({
    scale: z
      .number()
      .nullable()
      .describe('R level 0–5; null when SWPC issued a probability, not a level.'),
    text: z.string().nullable().describe('R descriptor; null when no level was issued.'),
    label: z.string().nullable().describe('Label, e.g. "R1"; null when no level was issued.'),
    minorProbPercent: z
      .number()
      .nullable()
      .describe('Chance (%) of an R1–R2 blackout this day; null when none issued.'),
    majorProbPercent: z
      .number()
      .nullable()
      .describe('Chance (%) of an R3+ blackout this day; null when none issued.'),
  })
  .describe('Radio blackout outlook for one day.');

const RadiationForecastSchema = z
  .object({
    scale: z
      .number()
      .nullable()
      .describe('S level 0–5; null when SWPC issued a probability, not a level.'),
    text: z.string().nullable().describe('S descriptor; null when no level was issued.'),
    label: z.string().nullable().describe('Label, e.g. "S1"; null when no level was issued.'),
    probPercent: z
      .number()
      .nullable()
      .describe('Chance (%) of an S1+ radiation storm this day; null when none issued.'),
  })
  .describe('Radiation storm outlook for one day.');

const ForecastPeriodSchema = z
  .object({
    date: z.string().describe('Forecast date, e.g. "2026-06-04".'),
    G: NullableScaleSchema.describe('Forecast G level, or all null fields when unissued.'),
    R: RadioForecastSchema.describe('R outlook: a level, probabilities, or neither.'),
    S: RadiationForecastSchema.describe('S outlook: a level, a probability, or neither.'),
  })
  .describe('One forecast day.');

const ObservedMaximaSchema = z
  .object({
    date: z.string().describe('SWPC date stamp, e.g. "2026-06-03".'),
    G: ScaleSummarySchema.describe('Maximum observed G level over the past 24 hours.'),
    R: ScaleSummarySchema.describe('Maximum observed R level over the past 24 hours.'),
    S: ScaleSummarySchema.describe('Maximum observed S level over the past 24 hours.'),
  })
  .describe('Rolling 24-hour observed maxima.');

const DiscussionSchema = z
  .object({
    issued: z
      .string()
      .nullable()
      .describe('ISO 8601 UTC issue time from the ":Issued:" line; null when absent.'),
    sections: z
      .array(
        z
          .object({
            topic: z.string().describe('Section heading, e.g. "Solar Activity".'),
            summary: z
              .string()
              .nullable()
              .describe('Past-24 h summary text; null when the section has none.'),
            forecast: z
              .string()
              .nullable()
              .describe('Next-3-day forecast text; null when the section has none.'),
          })
          .describe('One topic section.'),
      )
      .describe('Topic sections, in product order.'),
  })
  .describe("SWPC forecaster's narrative behind the scales.");

// ── Normalization helpers ───────────────────────────────────────────────────

/** Join the present fragments of a phrase, so an absent descriptor leaves no gap. */
function joinWords(words: (string | null | undefined)[]): string {
  return words.filter((word): word is string => Boolean(word)).join(' ');
}

/** One level on {@link ScaleSummarySchema}'s shape. */
function scaleSummary(
  entry: NoaaScaleEntry,
  scale: number,
): { label: string; scale: number; text: string } {
  return { scale, text: entry.text ?? '', label: `${entry.category}${scale}` };
}

/** A latest observation or G forecast may carry no issued level. */
function scaleOrUnissued(entry: NoaaScaleEntry) {
  return entry.scale === null
    ? { scale: null, text: null, label: null }
    : scaleSummary(entry, entry.scale);
}

/**
 * The rolling 24-hour maxima are supplementary. Return null when a level is
 * unavailable. The shared feed clock does not give the time of any maximum.
 */
function observedMaxima(period: NoaaScalesPeriod | null) {
  if (!period) return null;
  const { G, R, S } = period;
  if (G.scale === null || R.scale === null || S.scale === null) return null;
  return {
    date: period.date,
    G: scaleSummary(G, G.scale),
    R: scaleSummary(R, R.scale),
    S: scaleSummary(S, S.scale),
  };
}

/**
 * Map the level half of a forecast R/S entry, preserving a null SWPC issued no level
 * for. `label` is null in lockstep with `scale` — there is no "R" string to build
 * without a number.
 */
function forecastLevel(entry: NoaaScaleEntry): {
  label: string | null;
  scale: number | null;
  text: string | null;
} {
  return {
    scale: entry.scale,
    text: entry.text,
    label: entry.scale === null ? null : `${entry.category}${entry.scale}`,
  };
}

/**
 * Render one forecast R/S cell for `format()`.
 *
 * The level and the probabilities render independently. Gating the probabilities on a
 * null level would leave them unrendered for a schema-valid combination — a day with
 * both — so a probability is shown whenever SWPC issued one. A day upstream issued
 * neither a level nor a probability for reads "—" rather than claiming level 0.
 */
function forecastCell(
  category: string,
  entry: { label: string | null; scale: number | null; text: string | null },
  probabilities: [percent: number | null, of: string][],
): string {
  const level = joinWords([
    entry.scale === null ? entry.label : `${entry.label ?? category} (scale ${entry.scale})`,
    // "none" alongside an explicit level 0 adds nothing.
    entry.text && entry.text.toLowerCase() !== 'none' ? entry.text : null,
  ]);
  const chances = probabilities
    .filter((probability): probability is [number, string] => probability[0] !== null)
    .map(([percent, of]) => `${percent}% ${of}`)
    .join(', ');
  return `${category}: ${escapeMarkdownInline([level, chances].filter(Boolean).join(' · ') || '—')}`;
}

/** The "G2 moderate geomagnetic storm" fragment for an in-progress storm, else null. */
function stormPhrase(entry: NoaaScaleEntry, phenomenon: string): string | null {
  if (entry.scale === null || entry.scale < 1) return null;
  return joinWords([`${entry.category}${entry.scale}`, entry.text?.toLowerCase(), phenomenon]);
}

// ── Tool ────────────────────────────────────────────────────────────────────

export const getConditions = tool('noaa_spaceweather_get_conditions', {
  title: 'Get Space Weather Conditions',
  description:
    'NOAA R/S/G storm-scale snapshot: latest observations, rolling 24-hour observed maxima, and the 3-day forecast. Includes latest Kp, its G-scale equivalent, aurora-visibility latitude, and a plain-language summary. Request the optional SWPC Forecast Discussion for context. For details, use noaa_spaceweather_get_solar_wind, noaa_spaceweather_get_aurora_forecast, or noaa_spaceweather_get_alerts.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    include_discussion: z
      .boolean()
      .default(false)
      .describe(
        "Also fetch SWPC's forecaster-written Forecast Discussion, which explains why the forecast looks the way it does (CME versus coronal-hole stream, expected arrival). Costs one extra upstream request.",
      ),
  }),
  output: z.object({
    observedAt: z
      .string()
      .describe('ISO 8601 UTC stamp for the latest scales period, e.g. "2026-06-04T15:00:00Z".'),
    currentKp: z.number().describe('Latest observed planetary K-index (0–9).'),
    currentGScale: z.number().describe('G level (0–5) for currentKp.'),
    auroraLatitude: z
      .string()
      .describe(
        'Aurora guidance for currentKp, e.g. "Aurora possible to ~55° geomagnetic latitude".',
      ),
    yesterday: ObservedMaximaSchema.nullable().describe(
      'R/S/G rolling 24-hour observed maxima with their SWPC date stamp. Null when the period or a level is unavailable.',
    ),
    today: z
      .object({
        G: NullableScaleSchema.describe(
          'Latest observed G level, or all null fields when unissued.',
        ),
        R: NullableScaleSchema.describe(
          'Latest observed R level, or all null fields when unissued.',
        ),
        S: NullableScaleSchema.describe(
          'Latest observed S level, or all null fields when unissued.',
        ),
      })
      .describe('Latest observed R/S/G levels.'),
    forecast: z
      .array(ForecastPeriodSchema)
      .describe('3-day scale forecast, oldest first; starts with today (the date of observedAt).'),
    summary: z
      .string()
      .describe('Plain-language status, e.g. "G2 moderate geomagnetic storm in progress."'),
    discussion: DiscussionSchema.nullable().describe(
      'SWPC Forecast Discussion; null unless include_discussion is true.',
    ),
  }),

  errors: [
    {
      reason: 'feed_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'SWPC feed returns 5xx or 429, times out, or answers with a body that is not parseable JSON. Retried for up to 45 seconds in total before failing.',
      retryable: true,
      thrownBy: 'service',
      recovery: 'Retry in 30–60 seconds; SWPC feeds occasionally lag during high-activity events.',
    },
    {
      reason: 'feed_moved',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'SWPC feed returns a permanent 4xx, the scales feed lacks its latest observed period (key "0") or carries a malformed required scale field, or the forecast discussion has no topic section. Fails in one attempt.',
      retryable: false,
      recovery:
        'Retrying will not help — the SWPC feed path no longer resolves or no longer has the expected shape; the feed URL needs updating against SWPC current inventory.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching current space weather conditions', {
      includeDiscussion: input.include_discussion,
    });
    const svc = getSpaceWeatherService();

    const [scales, kpObs, discussion] = await Promise.all([
      svc.getNoaaScales(ctx),
      svc.getKpObserved(ctx),
      input.include_discussion ? svc.getForecastDiscussion(ctx) : null,
    ]);

    // Latest Kp is the last element of the observed array
    const latestKp = kpObs.length > 0 ? kpObs[kpObs.length - 1] : null;
    const currentKp = latestKp?.kp ?? 0;
    const currentGScale = latestKp?.gScale ?? 0;
    const auroraLatitude =
      latestKp?.auroraLatitude ?? 'No significant aurora expected at mid-latitudes';

    const today = scales.today;

    // Build summary — incorporate both current conditions and notable forecast activity.
    const parts = [
      stormPhrase(today.G, 'geomagnetic storm'),
      stormPhrase(today.R, 'radio blackout'),
      stormPhrase(today.S, 'solar radiation storm'),
    ].filter((phrase): phrase is string => phrase !== null);

    // Track the peak directly because forecast day one shares the observation date.
    let peak: { date: string; scale: number; text: string | null } | null = null;
    for (const p of scales.forecast) {
      if (p.G.scale !== null && p.G.scale > (peak?.scale ?? 0)) {
        peak = { date: p.date, scale: p.G.scale, text: p.G.text };
      }
    }
    const outlook = peak
      ? `${joinWords([`G${peak.scale}`, peak.text?.toLowerCase(), 'geomagnetic storm'])} forecast for ${peak.date === today.date ? 'today' : peak.date}.`
      : '';
    const unissued = [today.G, today.R, today.S].filter((entry) => entry.scale === null).length;
    const summaryParts: string[] = [];
    if (parts.length > 0) {
      summaryParts.push(`${parts.join('; ')} in progress.`);
    }
    if (unissued === 3) summaryParts.push('Latest NOAA scale observations are unavailable.');
    else if (unissued > 0) summaryParts.push('Latest NOAA scale observations are incomplete.');
    if (summaryParts.length === 0) {
      summaryParts.push(
        outlook ? `Quiet now — ${outlook}` : 'Quiet conditions — no significant storms active.',
      );
    } else if (outlook) {
      summaryParts.push(outlook);
    }

    return {
      observedAt: today.observedAt,
      currentKp,
      currentGScale,
      auroraLatitude,
      yesterday: observedMaxima(scales.yesterday),
      today: {
        G: scaleOrUnissued(today.G),
        R: scaleOrUnissued(today.R),
        S: scaleOrUnissued(today.S),
      },
      forecast: scales.forecast.map((p) => ({
        date: p.date,
        G: scaleOrUnissued(p.G),
        R: {
          ...forecastLevel(p.R),
          minorProbPercent: p.R.minorProb,
          majorProbPercent: p.R.majorProb,
        },
        S: {
          ...forecastLevel(p.S),
          // SWPC gives S a single "Prob"; the service parks it in minorProb.
          probPercent: p.S.minorProb,
        },
      })),
      summary: summaryParts.join(' '),
      discussion,
    };
  },

  format: (result) => {
    /** Normalize scale text: empty string or NOAA's literal "none" → "—". */
    const scaleText = (t: string | null) =>
      escapeMarkdownInline(t && t.toLowerCase() !== 'none' ? t : '—');
    const levelText = (level: typeof result.today.G) =>
      `${escapeMarkdownInline(level.label ?? '')} (scale ${level.scale}) ${scaleText(level.text)}`;
    /** The three G/R/S lines of one level-carrying period. */
    const levelLines = (period: typeof result.today) =>
      (
        [
          ['Geomagnetic (G)', period.G],
          ['Radio Blackout (R)', period.R],
          ['Solar Radiation (S)', period.S],
        ] as const
      ).map(
        ([name, level]) =>
          `- **${name}:** ${level.scale === null ? 'Not issued' : levelText(level)}`,
      );

    const lines: string[] = [];
    lines.push('## Space Weather Conditions');
    lines.push(`**Observed:** ${escapeMarkdownInline(result.observedAt)} UTC`);
    lines.push('');
    lines.push(`**Summary:** ${escapeMarkdownInline(result.summary)}`);
    lines.push('');
    lines.push(
      `**Current Kp:** ${result.currentKp} | **G-scale:** ${result.currentGScale} — ${escapeMarkdownInline(result.auroraLatitude)}`,
    );
    lines.push('');
    lines.push('### 24-Hour Observed Maxima');
    if (result.yesterday) {
      lines.push(`**SWPC date stamp:** ${escapeMarkdownInline(result.yesterday.date)}`);
      lines.push(...levelLines(result.yesterday));
    } else {
      lines.push('_24-hour observed maxima are unavailable._');
    }
    lines.push('');
    lines.push('### Latest Observed');
    lines.push(...levelLines(result.today));
    if (result.forecast.length > 0) {
      lines.push('');
      lines.push('### 3-Day Forecast (starts today)');
      for (const day of result.forecast) {
        const cells = [
          day.G.scale === null ? 'G: Not issued' : levelText(day.G),
          forecastCell('R', day.R, [
            [day.R.minorProbPercent, 'R1–R2'],
            [day.R.majorProbPercent, 'R3+'],
          ]),
          forecastCell('S', day.S, [[day.S.probPercent, 'S1+']]),
        ];
        lines.push(`**${escapeMarkdownInline(day.date)}:** ${cells.join(' | ')}`);
      }
    }
    if (result.discussion) {
      lines.push('');
      lines.push('### SWPC Forecast Discussion');
      lines.push(
        result.discussion.issued === null
          ? '_Issue time not stated in the product._'
          : `_Issued ${escapeMarkdownInline(result.discussion.issued)}_`,
      );
      for (const section of result.discussion.sections) {
        lines.push('');
        lines.push(`**${escapeMarkdownInline(section.topic)}**`);
        if (section.summary) lines.push(`_Past 24 h:_ ${escapeMarkdownInline(section.summary)}`);
        if (section.forecast) lines.push(`_Forecast:_ ${escapeMarkdownInline(section.forecast)}`);
        if (!section.summary && !section.forecast) lines.push('_No text in this section._');
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
