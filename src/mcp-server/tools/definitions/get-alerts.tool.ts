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
      .describe('Numeric severity level from the product code (0 when not applicable).'),
    phenomenon: z
      .string()
      .describe('Short phenomenon name, e.g. "Geomagnetic", "Radio Blackout", "Solar Radiation".'),
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
    'severity level, issue time, validity window, and plain text. Covers geomagnetic storms, radio ' +
    'blackouts, radiation storms, and aurora bulletins. With active_only=false, also returns ' +
    'informational summaries and expired notices. max_age_hours controls how far back to look ' +
    '(default 48 h); the SWPC feed keeps all historical records and has no built-in expiry.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    active_only: z
      .boolean()
      .default(true)
      .describe(
        'When true (default), return only Warnings, Watches, and Alerts; exclude Summaries and Other. Set false to return all products.',
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
        lines.push(
          `### [${alert.productType}] ${alert.phenomenon} — ${alert.messageCode} (${alert.productId})`,
        );
        lines.push(`**Issued:** ${alert.issueDatetime} | **Level:** ${alert.level}`);
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
