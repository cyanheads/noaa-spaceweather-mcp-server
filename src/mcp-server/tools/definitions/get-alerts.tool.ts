/**
 * @fileoverview Tool: noaa_spaceweather_get_alerts — active SWPC alerts/watches/warnings.
 * @module mcp-server/tools/definitions/get-alerts
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

const AlertSchema = z
  .object({
    productId: z.string().describe('SWPC product code, e.g. "WARK04", "ALTK07".'),
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
      .describe('Validity start parsed from the message body, null if not found.'),
    validTo: z
      .string()
      .nullable()
      .describe('Validity end parsed from the message body, null if not found.'),
    message: z.string().describe('Full plain-text message body.'),
  })
  .describe('One SWPC alert, watch, warning, or summary.');

export const getAlerts = tool('noaa_spaceweather_get_alerts', {
  title: 'Get Space Weather Alerts',
  description:
    'Active SWPC alerts, watches, and warnings — parsed into structured records with product type, ' +
    'severity level, issue time, validity window, and plain text. Covers geomagnetic storms, radio ' +
    'blackouts, radiation storms, and aurora bulletins. With active_only=false, also returns ' +
    'informational summaries and expired notices.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    active_only: z
      .boolean()
      .default(true)
      .describe(
        'When true (default), return only Warnings, Watches, and Alerts; exclude Summaries and Other. Set false to return all products.',
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
    ctx.log.info('Fetching SWPC alerts', { active_only: input.active_only });
    const svc = getSpaceWeatherService();
    const all = await svc.getAlerts(ctx);

    const filtered = input.active_only
      ? all.filter(
          (a) =>
            a.productType === 'Warning' || a.productType === 'Watch' || a.productType === 'Alert',
        )
      : all;

    if (filtered.length === 0) {
      ctx.enrich.notice(
        input.active_only
          ? 'No active alerts, watches, or warnings. Set active_only=false to include summaries.'
          : 'No space weather products currently issued.',
      );
    }

    return {
      alerts: filtered.map((a) => ({
        productId: a.productId,
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
        lines.push(`### [${alert.productType}] ${alert.phenomenon} — ${alert.productId}`);
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
