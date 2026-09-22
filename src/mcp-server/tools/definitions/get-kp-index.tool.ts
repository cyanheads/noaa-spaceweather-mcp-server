/**
 * @fileoverview Tool: noaa_spaceweather_get_kp_index — planetary K-index time series.
 * @module mcp-server/tools/definitions/get-kp-index
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getSpaceWeatherService,
  kpToGScale,
} from '@/services/space-weather/space-weather-service.js';

const KpObsSchema = z
  .object({
    timeTag: z.string().describe('ISO 8601 3-hour interval time tag.'),
    kp: z.number().describe('Kp value (0–9).'),
    gScale: z.number().describe('G level (0–5) for this Kp; G1 starts at 4.67, G5 at 9.'),
    gLabel: z.string().describe('G label, e.g. "G3".'),
    auroraLatitude: z.string().describe('Aurora guidance for this Kp, in geomagnetic latitude.'),
  })
  .describe('One observed 3-hour Kp interval.');

const KpForecastSchema = z
  .object({
    timeTag: z.string().describe('ISO 8601 forecast interval time tag.'),
    kp: z.number().describe('Forecast Kp value (0–9).'),
    observed: z.string().describe('"estimated" (near-real-time model) or "predicted".'),
    noaaScale: z
      .string()
      .nullable()
      .describe('NOAA scale the feed states, e.g. "G1"; null when none.'),
    gScale: z.number().describe('G level (0–5) derived from kp; matches noaaScale when stated.'),
    gLabel: z.string().describe('G label, e.g. "G3".'),
  })
  .describe('One Kp forecast interval.');

export const getKpIndex = tool('noaa_spaceweather_get_kp_index', {
  title: 'Get Kp Index',
  description:
    'Planetary K-index (0–9 geomagnetic activity scale) — recent observed 3-hour values with their ' +
    'NOAA G-scale equivalents and aurora-latitude guidance, plus the 3-day Kp forecast series. ' +
    'Kp is the primary driver of aurora visibility and geomagnetic storm severity. SWPC reports Kp ' +
    'in thirds and starts each G level at that level’s "minus" value: Kp 4.67 (5−) is G1, Kp 6.67 ' +
    '(7−) is G3 (aurora to ~50° geomagnetic), Kp 8.67 (9−) is still G4, and only Kp 9 is G5 extreme. ' +
    'Use noaa_spaceweather_get_conditions for a ' +
    'combined snapshot including storm scales; use this tool when you need the Kp time series or ' +
    'forecast detail.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    window_days: z
      .number()
      .int()
      .min(1)
      .max(7)
      .default(1)
      .describe(
        'Number of past days of observed Kp to return (1–7, default 1). Larger windows show trend context.',
      ),
  }),
  output: z.object({
    observed: z.array(KpObsSchema).describe('Observed Kp in the window, oldest first.'),
    forecast: z
      .array(KpForecastSchema)
      .describe('Kp forecast series: estimated and predicted entries, no observed history.'),
    currentKp: z.number().describe('Latest observed Kp; 0 when the window has none.'),
    currentGScale: z.number().describe('G level (0–5) for currentKp.'),
    auroraLatitude: z.string().describe('Aurora guidance for currentKp.'),
    observedCount: z.number().describe('Entries in observed.'),
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
      when: 'SWPC feed path returns a permanent 4xx (404, 410, 401, 403). Fails in one attempt.',
      retryable: false,
      thrownBy: 'service',
      recovery:
        'Retrying will not help — the SWPC feed path no longer resolves or no longer has the expected shape; the feed URL needs updating against SWPC current inventory.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching Kp index', { window_days: input.window_days });
    const svc = getSpaceWeatherService();
    const [allObs, forecast] = await Promise.all([svc.getKpObserved(ctx), svc.getKpForecast(ctx)]);

    // Slice to the requested window. Compare epochs, not raw ISO strings: Kp
    // timeTags carry no fractional seconds while toISOString() always emits
    // .mmm, so lexicographic >= disagrees with true chronology at the window
    // boundary (same class of bug already fixed in get-alerts, #6).
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - input.window_days);
    const cutoffMs = cutoff.getTime();
    const observed = allObs.filter((r) => new Date(r.timeTag).getTime() >= cutoffMs);

    const latest = observed.length > 0 ? observed[observed.length - 1] : null;
    const currentKp = latest?.kp ?? 0;
    const currentGScale = latest?.gScale ?? 0;
    const auroraLatitude =
      latest?.auroraLatitude ?? 'No significant aurora expected at mid-latitudes';

    // Filter forecast to forward-looking entries only — the SWPC feed embeds historical
    // "observed" readings alongside the actual forecast tail; including them contradicts
    // the "forecast" label and misleads callers reading past Kp as predictions.
    const forwardForecast = forecast.filter((r) => r.observed !== 'observed');

    return {
      observed: observed.map((r) => ({
        timeTag: r.timeTag,
        kp: r.kp,
        gScale: r.gScale,
        gLabel: `G${r.gScale}`,
        auroraLatitude: r.auroraLatitude,
      })),
      forecast: forwardForecast.map((r) => {
        const gScale = kpToGScale(r.kp);
        return {
          timeTag: r.timeTag,
          kp: r.kp,
          observed: r.observed,
          noaaScale: r.noaaScale,
          gScale,
          gLabel: `G${gScale}`,
        };
      }),
      currentKp,
      currentGScale,
      auroraLatitude,
      observedCount: observed.length,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push('## Kp Index');
    lines.push(`**Current Kp:** ${result.currentKp} (G${result.currentGScale})`);
    lines.push(`**Aurora:** ${result.auroraLatitude}`);
    lines.push(`**Observed readings:** ${result.observedCount}`);
    if (result.observed.length > 0) {
      lines.push('');
      lines.push('### Recent Observed Values');
      for (const r of result.observed) {
        lines.push(
          `- ${r.timeTag}: Kp ${r.kp} | G-scale ${r.gScale} (${r.gLabel}) — ${r.auroraLatitude}`,
        );
      }
    }
    if (result.forecast.length > 0) {
      lines.push('');
      lines.push('### Forecast');
      for (const r of result.forecast) {
        const scale = r.noaaScale ? ` (${r.noaaScale})` : '';
        lines.push(
          `- ${r.timeTag}: Kp ${r.kp} | G-scale ${r.gScale} (${r.gLabel})${scale} [${r.observed}]`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
