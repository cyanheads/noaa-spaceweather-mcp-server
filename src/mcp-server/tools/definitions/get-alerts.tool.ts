/**
 * @fileoverview Tool: noaa_spaceweather_get_alerts — active SWPC alerts/watches/warnings.
 * @module mcp-server/tools/definitions/get-alerts
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

const AlertSchema = z
  .object({
    productId: z
      .string()
      .describe(
        'Short SWPC feed product ID, e.g. "K04W", "EF3A". See messageCode for the full code.',
      ),
    messageCode: z
      .string()
      .describe(
        'Full SWPC "Space Weather Message Code" parsed from the message body, e.g. "WARK04", "ALTEF3" — the code that drives product type, phenomenon, and level.',
      ),
    productType: z
      .enum(['Warning', 'Watch', 'Alert', 'Summary', 'Other'])
      .describe('Product classification derived from the code prefix.'),
    level: z
      .number()
      .describe(
        'NOAA scale level 0–5, read from the scale stated in the message body. 0 means the product states no NOAA scale (e.g. a K4 warning, below the G-scale; or a radio-burst alert, outside the scales) — not a severity of zero. See noaaScale for the scale letter.',
      ),
    noaaScale: z
      .string()
      .nullable()
      .describe(
        'NOAA scale stated in the message body, e.g. "G1", "R2", "S1"; null when the product states none.',
      ),
    cancelled: z
      .boolean()
      .describe(
        'True when this record cancels a previously issued product ("CANCEL WARNING:"/"CANCEL ALERT:" headline) rather than being in force. Always false when active_only=true, which excludes cancellations; set active_only=false to see them.',
      ),
    phenomenon: z
      .string()
      .describe(
        'Short phenomenon name derived from the body\'s NOAA scale letter, e.g. "Geomagnetic", "Radio Blackout", "Solar Radiation".',
      ),
    issueDatetime: z.string().describe('ISO 8601 issue datetime.'),
    validFrom: z
      .string()
      .nullable()
      .describe(
        'Validity-window start as ISO 8601 UTC, parsed from the message body ("Valid From" or "Begin Time"); null when the product carries no start line.',
      ),
    validTo: z
      .string()
      .nullable()
      .describe(
        'Validity-window end as ISO 8601 UTC, parsed from the message body ("Valid To", "Now Valid Until", or "End Time"); null when the product carries no end line.',
      ),
    message: z.string().describe('Full plain-text message body.'),
  })
  .describe('One SWPC alert, watch, warning, or summary.');

export const getAlerts = tool('noaa_spaceweather_get_alerts', {
  title: 'Get Space Weather Alerts',
  description:
    'Active SWPC alerts, watches, and warnings — parsed into structured records with product type, ' +
    'NOAA scale and level, issue time, validity window, and plain text. Covers geomagnetic storms, ' +
    'radio blackouts, and radiation storms. With active_only=false, also returns informational ' +
    'summaries, expired notices, and cancellations. max_age_hours controls how far back to look ' +
    '(default 48 h); the SWPC feed keeps all historical records and has no built-in expiry.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    active_only: z
      .boolean()
      .default(true)
      .describe(
        'When true (default), return only in-force Warnings, Watches, and Alerts; exclude Summaries, Other, expired products, and cancellation notices. Set false to return all products, including cancellations (flagged by the cancelled field).',
      ),
    max_age_hours: z
      .number()
      .min(1)
      .max(720)
      .default(48)
      .describe(
        'Maximum age of alerts to return, in hours (default 48). The SWPC feed retains all historical records — this window prevents returning weeks of historical notices as "active."',
      ),
  }),
  output: z.object({
    alerts: z.array(AlertSchema).describe('Matching SWPC alert/watch/warning records.'),
    totalCount: z.number().describe('Count of records in the alerts array.'),
    fetchedAt: z.string().describe('ISO 8601 timestamp of when this data was fetched.'),
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
    ctx.log.info('Fetching SWPC alerts', {
      active_only: input.active_only,
      max_age_hours: input.max_age_hours,
    });
    const svc = getSpaceWeatherService();
    const all = await svc.getAlerts(ctx);

    // Apply recency window first — the feed keeps all historical records with no
    // expiry; without this, active_only=true returns weeks of historical notices.
    // Compare as Date objects (epoch) — string comparison would silently fail when
    // issueDatetime and the ISO cutoff don't share the exact same format.
    const nowMs = Date.now();
    const cutoffMs = nowMs - input.max_age_hours * 60 * 60 * 1000;
    const recents = all.filter((a) => new Date(a.issueDatetime).getTime() >= cutoffMs);

    // active_only admits only in-force Warnings/Watches/Alerts. A product whose
    // parsed validTo has already elapsed is dropped; Watch/Alert notices carry no
    // validTo (point-in-time), and a validTo we cannot parse is treated as in-force
    // — both fall back to the recency window above, so an "active" query never
    // silently hides a warning whose end time is missing or unreadable.
    const filtered = input.active_only
      ? recents.filter((a) => {
          if (
            a.productType !== 'Warning' &&
            a.productType !== 'Watch' &&
            a.productType !== 'Alert'
          ) {
            return false;
          }
          // A cancellation carries the cancelled product's own type and no validity
          // window, so neither check above excludes it — it must be dropped explicitly.
          if (a.cancelled) return false;
          if (a.validTo === null) return true;
          const validToMs = new Date(a.validTo).getTime();
          return Number.isNaN(validToMs) || validToMs >= nowMs;
        })
      : recents;

    if (filtered.length === 0) {
      ctx.enrich.notice(
        input.active_only
          ? 'No active alerts, watches, or warnings. Set active_only=false to include summaries.'
          : 'No space weather products issued in the requested window.',
      );
    }

    return {
      alerts: filtered.map((a) => ({
        productId: a.productId,
        messageCode: a.messageCode,
        productType: a.productType,
        level: a.level,
        noaaScale: a.noaaScale,
        cancelled: a.cancelled,
        phenomenon: a.phenomenon,
        issueDatetime: a.issueDatetime,
        validFrom: a.validFrom,
        validTo: a.validTo,
        message: a.message,
      })),
      totalCount: filtered.length,
      fetchedAt: new Date().toISOString(),
    };
  },

  enrichment: {
    notice: z.string().optional().describe('Status notice when no alerts are active.'),
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## SWPC Space Weather Alerts — ${result.fetchedAt}`);
    lines.push(`**Total:** ${result.totalCount}`);
    if (result.alerts.length === 0) {
      lines.push('\n_No active alerts._');
    } else {
      for (const alert of result.alerts) {
        lines.push('');
        // Mark cancellations in the heading: they carry the cancelled product's own
        // type, so nothing else in the rendered record distinguishes them from one in force.
        const status = alert.cancelled ? ' · CANCELLED' : '';
        lines.push(
          `### [${alert.productType}${status}] ${alert.phenomenon} — ${alert.messageCode} (${alert.productId})`,
        );
        // Spell out a scale-less product rather than leaving a bare "Level: 0", which
        // reads as "calm" when it actually means the product states no NOAA scale.
        const scale = alert.noaaScale ? ` (${alert.noaaScale})` : ' (no NOAA scale)';
        lines.push(`**Issued:** ${alert.issueDatetime} | **Level:** ${alert.level}${scale}`);
        if (alert.validFrom) lines.push(`**Valid From:** ${alert.validFrom}`);
        if (alert.validTo) lines.push(`**Valid To:** ${alert.validTo}`);
        lines.push('');
        lines.push('```');
        lines.push(alert.message);
        lines.push('```');
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
