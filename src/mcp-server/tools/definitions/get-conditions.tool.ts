/**
 * @fileoverview Tool: noaa_spaceweather_get_conditions — current space-weather snapshot.
 * @module mcp-server/tools/definitions/get-conditions
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

// ── Output sub-schemas ──────────────────────────────────────────────────────

const ScaleSummarySchema = z
  .object({
    scale: z.number().describe('Storm scale level 0–5.'),
    text: z
      .string()
      .describe('Human-readable scale descriptor, e.g. "Moderate". Empty when scale is 0.'),
    label: z.string().describe('NOAA scale string, e.g. "G2", "R1", "S0".'),
  })
  .describe('Current level and label for one NOAA storm scale category.');

const ForecastPeriodSchema = z
  .object({
    date: z.string().describe('Forecast date string.'),
    G: ScaleSummarySchema.describe('Geomagnetic storm scale for this day.'),
    R: ScaleSummarySchema.describe('Radio blackout scale for this day.'),
    S: ScaleSummarySchema.describe('Solar radiation storm scale for this day.'),
  })
  .describe('3-day NOAA scale forecast for one calendar day.');

// ── Tool ────────────────────────────────────────────────────────────────────

export const getConditions = tool('noaa_spaceweather_get_conditions', {
  title: 'Get Space Weather Conditions',
  description:
    'Current space-weather snapshot: NOAA R/S/G storm scales (today + 3-day forecast), latest Kp ' +
    'index with its G-scale equivalent and aurora-visibility latitude, and a plain-language status ' +
    'summary. The quickest way to answer "is anything happening right now?" — use before deciding ' +
    'whether to drill into solar wind (noaa_spaceweather_get_solar_wind), aurora ' +
    '(noaa_spaceweather_get_aurora_forecast), or alert details (noaa_spaceweather_get_alerts).',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({}),
  output: z.object({
    observedAt: z
      .string()
      .describe(
        'UTC date and time of the NOAA scales data period this snapshot reflects, e.g. "2026-06-04 15:00:00".',
      ),
    currentKp: z.number().describe('Latest observed planetary K-index (0–9).'),
    currentGScale: z.number().describe('NOAA G-scale equivalent for current Kp (0–5).'),
    auroraLatitude: z
      .string()
      .describe(
        'Aurora visibility guidance for current conditions, e.g. "Aurora possible to ~55° geomagnetic latitude".',
      ),
    today: z
      .object({
        G: ScaleSummarySchema.describe("Today's geomagnetic storm scale."),
        R: ScaleSummarySchema.describe("Today's radio blackout scale."),
        S: ScaleSummarySchema.describe("Today's solar radiation storm scale."),
      })
      .describe('Current observed NOAA storm scales for today.'),
    forecast: z.array(ForecastPeriodSchema).describe('3-day NOAA scale forecast (next 1–3 days).'),
    summary: z
      .string()
      .describe(
        'Plain-language status summary suitable for display, e.g. "Quiet conditions" or "G2 moderate geomagnetic storm in progress."',
      ),
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

  async handler(_input, ctx) {
    ctx.log.info('Fetching current space weather conditions');
    const svc = getSpaceWeatherService();

    const [scales, kpObs] = await Promise.all([svc.getNoaaScales(ctx), svc.getKpObserved(ctx)]);

    // Latest Kp is the last element of the observed array
    const latestKp = kpObs.length > 0 ? kpObs[kpObs.length - 1] : null;
    const currentKp = latestKp?.kp ?? 0;
    const currentGScale = latestKp?.gScale ?? 0;
    const auroraLatitude =
      latestKp?.auroraLatitude ?? 'No significant aurora expected at mid-latitudes';

    const today = scales.today;

    // Build summary — incorporate both current conditions and notable forecast activity.
    const parts: string[] = [];
    if (today.G.scale >= 1)
      parts.push(`G${today.G.scale} ${today.G.text.toLowerCase()} geomagnetic storm`);
    if (today.R.scale >= 1)
      parts.push(`R${today.R.scale} ${today.R.text.toLowerCase()} radio blackout`);
    if (today.S.scale >= 1)
      parts.push(`S${today.S.scale} ${today.S.text.toLowerCase()} solar radiation storm`);

    let summary: string;
    if (parts.length > 0) {
      summary =
        parts.map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p)).join('; ') +
        ' in progress.';
    } else {
      // Check forecast for upcoming elevated activity — pick the highest G-scale day.
      let peakScale = 0;
      let peakDate = '';
      for (const p of scales.forecast) {
        if (p.G.scale > peakScale) {
          peakScale = p.G.scale;
          peakDate = p.date;
        }
      }
      summary =
        peakScale >= 1
          ? `Quiet now — G${peakScale} ${scales.forecast.find((p) => p.date === peakDate)?.G.text.toLowerCase()} geomagnetic storm forecast for ${peakDate}.`
          : 'Quiet conditions — no significant storms active.';
    }

    return {
      observedAt: `${today.date} ${today.time}`,
      currentKp,
      currentGScale,
      auroraLatitude,
      today: {
        G: { scale: today.G.scale, text: today.G.text, label: `G${today.G.scale}` },
        R: { scale: today.R.scale, text: today.R.text, label: `R${today.R.scale}` },
        S: { scale: today.S.scale, text: today.S.text, label: `S${today.S.scale}` },
      },
      forecast: scales.forecast.map((p) => ({
        date: p.date,
        G: { scale: p.G.scale, text: p.G.text, label: `G${p.G.scale}` },
        R: { scale: p.R.scale, text: p.R.text, label: `R${p.R.scale}` },
        S: { scale: p.S.scale, text: p.S.text, label: `S${p.S.scale}` },
      })),
      summary,
    };
  },

  format: (result) => {
    /** Normalize scale text: empty string or NOAA's literal "none" → "—". */
    const scaleText = (t: string) => (t && t.toLowerCase() !== 'none' ? t : '—');

    const lines: string[] = [];
    lines.push(`## Space Weather Conditions — ${result.observedAt} UTC`);
    lines.push('');
    lines.push(`**Summary:** ${result.summary}`);
    lines.push('');
    lines.push(
      `**Current Kp:** ${result.currentKp} | **G-scale:** ${result.currentGScale} — ${result.auroraLatitude}`,
    );
    lines.push('');
    lines.push('### Today');
    lines.push(
      `- **Geomagnetic (G):** ${result.today.G.label} (scale ${result.today.G.scale}) ${scaleText(result.today.G.text)}`,
    );
    lines.push(
      `- **Radio Blackout (R):** ${result.today.R.label} (scale ${result.today.R.scale}) ${scaleText(result.today.R.text)}`,
    );
    lines.push(
      `- **Solar Radiation (S):** ${result.today.S.label} (scale ${result.today.S.scale}) ${scaleText(result.today.S.text)}`,
    );
    if (result.forecast.length > 0) {
      lines.push('');
      lines.push('### 3-Day Forecast');
      for (const day of result.forecast) {
        lines.push(
          `**${day.date}:** ${day.G.label} (scale ${day.G.scale}) ${scaleText(day.G.text)} | ${day.R.label} (scale ${day.R.scale}) ${scaleText(day.R.text)} | ${day.S.label} (scale ${day.S.scale}) ${scaleText(day.S.text)}`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
