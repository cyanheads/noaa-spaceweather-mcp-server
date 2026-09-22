/**
 * @fileoverview Tool: noaa_spaceweather_get_conditions — current space-weather snapshot.
 * @module mcp-server/tools/definitions/get-conditions
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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

/**
 * SWPC issues no R or S *level* for a future day — it issues a probability. So the
 * forecast entries carry a nullable scale alongside the probabilities, while `today`
 * and `forecast[].G` keep {@link ScaleSummarySchema}: those do carry a real level.
 * The R/S asymmetry is upstream's — two probabilities for R, one for S.
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
    G: ScaleSummarySchema.describe('Forecast G level.'),
    R: RadioForecastSchema.describe('R outlook: a level, probabilities, or neither.'),
    S: RadiationForecastSchema.describe('S outlook: a level, a probability, or neither.'),
  })
  .describe('One forecast day.');

const YesterdaySchema = z
  .object({
    date: z.string().describe('Previous UTC day, e.g. "2026-06-03".'),
    G: ScaleSummarySchema.describe('Assessed G level.'),
    R: ScaleSummarySchema.describe('Assessed R level.'),
    S: ScaleSummarySchema.describe('Assessed S level.'),
  })
  .describe('Levels SWPC assessed for the previous UTC day.');

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

/**
 * Map a level-carrying entry onto {@link ScaleSummarySchema}, which declares `scale` as
 * a plain number: today's period and every forecast G entry do carry a real `Scale`
 * upstream.
 *
 * A null one is not resolved to 0. That is the claim #23 removed from the forecast R/S
 * — "level 0, no storm" is a different statement from "SWPC issued no level" — and it
 * would read the same way here, on a surface with no probability to fall back to. The
 * period instead reports the shape break it is, on the reason the tool already declares
 * for a feed that answers without its documented shape.
 */
function observedScale(
  entry: NoaaScaleEntry,
  period: string,
  fail: (message: string) => Error,
): { label: string; scale: number; text: string } {
  if (entry.scale === null)
    throw fail(`SWPC scales feed issued no ${entry.category} level for the ${period} period.`);
  return scaleSummary(entry, entry.scale);
}

/**
 * The previous UTC day's assessed levels, from the period's `date` and its three
 * `Scale`/`Text` pairs only. `time`/`observedAt` are never read: on this key they are
 * the feed's generation clock, not an observation time.
 *
 * Null when the feed carries no such period, and also when it carries one missing a
 * level. Unlike today's period — the snapshot's core, where a missing level fails the
 * call as `feed_moved` — this one is supplementary, and a break in it must not take down
 * today and the forecast with it. Null is never resolved to level 0.
 */
function assessedYesterday(period: NoaaScalesPeriod | null) {
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
  return `${category}: ${[level, chances].filter(Boolean).join(' · ') || '—'}`;
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
    'Current space-weather snapshot: NOAA R/S/G storm scales (the previous UTC day, today, and the 3-day forecast), latest Kp ' +
    'index with its G-scale equivalent and aurora-visibility latitude, and a plain-language status ' +
    'summary. Optionally includes the SWPC forecast discussion explaining what is driving the ' +
    'forecast. The quickest way to answer "is anything happening right now?" — use before deciding ' +
    'whether to drill into solar wind (noaa_spaceweather_get_solar_wind), aurora ' +
    '(noaa_spaceweather_get_aurora_forecast), or alert details (noaa_spaceweather_get_alerts).',
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
      .describe('ISO 8601 UTC time of the scales data period, e.g. "2026-06-04T15:00:00Z".'),
    currentKp: z.number().describe('Latest observed planetary K-index (0–9).'),
    currentGScale: z.number().describe('G level (0–5) for currentKp.'),
    auroraLatitude: z
      .string()
      .describe(
        'Aurora guidance for currentKp, e.g. "Aurora possible to ~55° geomagnetic latitude".',
      ),
    yesterday: YesterdaySchema.nullable().describe(
      'R/S/G levels assessed for the previous UTC day (a date, no time). Null when the feed lacks that period or a level; null never means level 0.',
    ),
    today: z
      .object({
        G: ScaleSummarySchema.describe("Today's G level."),
        R: ScaleSummarySchema.describe("Today's R level."),
        S: ScaleSummarySchema.describe("Today's S level."),
      })
      .describe('Observed R/S/G levels for today.'),
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
      when: 'SWPC feed path returns a permanent 4xx (404, 410, 401, 403), or a feed answers without the shape it is documented to have — the scales feed no longer carrying its "0" (today) period, or the forecast discussion carrying no topic section. Fails in one attempt.',
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

    let summary: string;
    if (parts.length > 0) {
      summary =
        parts.map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p)).join('; ') +
        ' in progress.';
    } else {
      // Check the forecast for upcoming elevated activity — the highest G-scale day.
      // The descriptor rides along with the peak instead of being looked up by date
      // afterwards: the series opens on today, so a date does not identify a period.
      let peak: { date: string; scale: number; text: string | null } | null = null;
      for (const p of scales.forecast) {
        if (p.G.scale !== null && p.G.scale > (peak?.scale ?? 0)) {
          peak = { date: p.date, scale: p.G.scale, text: p.G.text };
        }
      }
      // The series starts with today, so naming its date would read as a future day.
      const when = peak === null || peak.date === today.date ? 'today' : peak.date;
      summary =
        peak === null
          ? 'Quiet conditions — no significant storms active.'
          : `Quiet now — ${joinWords([`G${peak.scale}`, peak.text?.toLowerCase(), 'geomagnetic storm'])} forecast for ${when}.`;
    }

    /** A missing level is a feed shape break — see {@link observedScale}. */
    const failOnMissingLevel = (message: string) =>
      ctx.fail('feed_moved', message, ctx.recoveryFor('feed_moved'));

    return {
      observedAt: today.observedAt,
      currentKp,
      currentGScale,
      auroraLatitude,
      yesterday: assessedYesterday(scales.yesterday),
      today: {
        G: observedScale(today.G, 'today', failOnMissingLevel),
        R: observedScale(today.R, 'today', failOnMissingLevel),
        S: observedScale(today.S, 'today', failOnMissingLevel),
      },
      forecast: scales.forecast.map((p) => ({
        date: p.date,
        G: observedScale(p.G, `${p.date} forecast`, failOnMissingLevel),
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
      summary,
      discussion,
    };
  },

  format: (result) => {
    /** Normalize scale text: empty string or NOAA's literal "none" → "—". */
    const scaleText = (t: string) => (t && t.toLowerCase() !== 'none' ? t : '—');
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
          `- **${name}:** ${level.label} (scale ${level.scale}) ${scaleText(level.text)}`,
      );

    const lines: string[] = [];
    lines.push(`## Space Weather Conditions — ${result.observedAt} UTC`);
    lines.push('');
    lines.push(`**Summary:** ${result.summary}`);
    lines.push('');
    lines.push(
      `**Current Kp:** ${result.currentKp} | **G-scale:** ${result.currentGScale} — ${result.auroraLatitude}`,
    );
    lines.push('');
    if (result.yesterday) {
      lines.push(`### Yesterday (${result.yesterday.date}, assessed)`);
      lines.push(...levelLines(result.yesterday));
    } else {
      lines.push('### Yesterday');
      lines.push('_The scales feed carried no assessed levels for the previous UTC day._');
    }
    lines.push('');
    lines.push('### Today');
    lines.push(...levelLines(result.today));
    if (result.forecast.length > 0) {
      lines.push('');
      lines.push('### 3-Day Forecast (starts today)');
      for (const day of result.forecast) {
        const cells = [
          `${day.G.label} (scale ${day.G.scale}) ${scaleText(day.G.text)}`,
          forecastCell('R', day.R, [
            [day.R.minorProbPercent, 'R1–R2'],
            [day.R.majorProbPercent, 'R3+'],
          ]),
          forecastCell('S', day.S, [[day.S.probPercent, 'S1+']]),
        ];
        lines.push(`**${day.date}:** ${cells.join(' | ')}`);
      }
    }
    if (result.discussion) {
      lines.push('');
      lines.push('### SWPC Forecast Discussion');
      lines.push(
        result.discussion.issued === null
          ? '_Issue time not stated in the product._'
          : `_Issued ${result.discussion.issued}_`,
      );
      for (const section of result.discussion.sections) {
        lines.push('');
        lines.push(`**${section.topic}**`);
        if (section.summary) lines.push(`_Past 24 h:_ ${section.summary}`);
        if (section.forecast) lines.push(`_Forecast:_ ${section.forecast}`);
        if (!section.summary && !section.forecast) lines.push('_No text in this section._');
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
