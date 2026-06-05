/**
 * @fileoverview Tool: noaa_spaceweather_get_kp_index — planetary K-index time series.
 * @module mcp-server/tools/definitions/get-kp-index
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

const KpObsSchema = z
  .object({
    timeTag: z.string().describe('ISO 8601 3-hour interval time tag.'),
    kp: z.number().describe('Kp index value 0–9.'),
    gScale: z.number().describe('NOAA G-scale equivalent (0–5).'),
    gLabel: z.string().describe('NOAA G-scale label, e.g. "G0", "G3".'),
    auroraLatitude: z.string().describe('Aurora visibility guidance for this Kp level.'),
  })
  .describe('One observed Kp 3-hour interval reading.');

const KpForecastSchema = z
  .object({
    timeTag: z.string().describe('ISO 8601 time tag for the forecast interval.'),
    kp: z.number().describe('Forecasted Kp value.'),
    observed: z
      .string()
      .describe('"observed" for confirmed readings, "predicted" for forecast points.'),
    noaaScale: z
      .string()
      .nullable()
      .describe('NOAA scale string, e.g. "G1", null when not available.'),
  })
  .describe('One Kp forecast interval.');

export const getKpIndex = tool('noaa_spaceweather_get_kp_index', {
  title: 'Get Kp Index',
  description:
    'Planetary K-index (0–9 geomagnetic activity scale) — recent observed 3-hour values with their ' +
    'NOAA G-scale equivalents and aurora-latitude guidance, plus the 3-day Kp forecast series. ' +
    'Kp is the primary driver of aurora visibility and geomagnetic storm severity: Kp≥5 is G1, Kp≥7 ' +
    'is G3 (aurora to ~50°), Kp≥9 is G5 extreme. Use noaa_spaceweather_get_conditions for a ' +
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
    observed: z
      .array(KpObsSchema)
      .describe('Observed Kp readings within the requested window, oldest first.'),
    forecast: z.array(KpForecastSchema).describe('3-day Kp forecast series.'),
    currentKp: z.number().describe('Latest observed Kp value.'),
    currentGScale: z.number().describe('NOAA G-scale for current Kp.'),
    auroraLatitude: z.string().describe('Aurora visibility guidance for current conditions.'),
    observedCount: z
      .number()
      .describe('Number of Kp observations in the observed array, matching the requested window.'),
  }),

  errors: [
    {
      reason: 'feed_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'SWPC endpoint returns non-OK status or times out after retries.',
      retryable: true,
      recovery: 'Retry in 30–60 seconds; SWPC feeds occasionally lag during high-activity events.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching Kp index', { window_days: input.window_days });
    const svc = getSpaceWeatherService();
    const [allObs, forecast] = await Promise.all([svc.getKpObserved(ctx), svc.getKpForecast(ctx)]);

    // Slice to the requested window
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - input.window_days);
    const cutoffIso = cutoff.toISOString();
    const observed = allObs.filter((r) => r.timeTag >= cutoffIso);

    const latest = observed.length > 0 ? observed[observed.length - 1] : null;
    const currentKp = latest?.kp ?? 0;
    const currentGScale = latest?.gScale ?? 0;
    const auroraLatitude =
      latest?.auroraLatitude ?? 'No significant aurora expected at mid-latitudes';

    return {
      observed: observed.map((r) => ({
        timeTag: r.timeTag,
        kp: r.kp,
        gScale: r.gScale,
        gLabel: `G${r.gScale}`,
        auroraLatitude: r.auroraLatitude,
      })),
      forecast: forecast.map((r) => ({
        timeTag: r.timeTag,
        kp: r.kp,
        observed: r.observed,
        noaaScale: r.noaaScale,
      })),
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
      lines.push('### 3-Day Forecast');
      for (const r of result.forecast) {
        const scale = r.noaaScale ? ` (${r.noaaScale})` : '';
        lines.push(`- ${r.timeTag}: Kp ${r.kp}${scale} [${r.observed}]`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
