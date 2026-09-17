/**
 * @fileoverview Tool: noaa_spaceweather_get_alerts — active SWPC alerts/watches/warnings.
 * @module mcp-server/tools/definitions/get-alerts
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';
import type { SpaceWeatherAlert } from '@/services/space-weather/types.js';

/**
 * Why a record was left out of an `active_only=true` result, in the precedence order a
 * record is attributed to — each record is counted under the first reason that fires, so
 * the counts partition the feed rather than overlapping.
 *
 * The window leads because it decides which records were candidates at all, and product
 * type follows because a Summary is never in force whatever its body says. Then the
 * reasons that name a *replacement* — this record is itself a cancellation, a later
 * record cancelled it, a later record superseded it — and only last the generic
 * "its stated end passed".
 *
 * That ordering is deliberate: a superseded Watch has usually outlived its own forecast
 * days too, so ranking elapsed validity higher would report the whole Watch chain as
 * merely stale and never mention that a newer forecast replaced it. The specific reason
 * is the one a caller can act on — it points at a successor record.
 */
const EXCLUSION_REASONS = [
  'agedOut',
  'productType',
  'cancellationRecord',
  'cancelledBySerial',
  'superseded',
  'validityElapsed',
] as const;

type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/** Product types that can be in force; everything else is informational or unparsed. */
const IN_FORCE_TYPES: ReadonlySet<SpaceWeatherAlert['productType']> = new Set([
  'Warning',
  'Watch',
  'Alert',
]);

/**
 * The record's stated end as an epoch, or null when nothing usable is stated. A validity
 * line SWPC wrote as prose survives parsing as raw text (see `parseValidity`), and an end
 * that cannot be read is not evidence the product has finished — those return null and
 * the record is treated as in force.
 */
function endMs(alert: SpaceWeatherAlert): number | null {
  if (alert.validTo === null) return null;
  const ms = Date.parse(alert.validTo);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Resolve each cancellation to the single record it names, as indices into `all`.
 *
 * Serials are per-message-code counters, so the match is scoped to the cancelling
 * record's own code — the same serial under another code is a different product. SWPC
 * reuses a serial within a code on a corrected reissue, so "Original Issue Time:" picks
 * between them when it names one of the candidates; when it names none (a formatting
 * drift upstream), the nearest preceding record under that code and serial is taken
 * rather than missing the cancellation entirely.
 *
 * Resolving one target per cancellation is what keeps a cancellation from clearing its
 * whole message code: a single code cycles CONTINUED → CANCEL → CONTINUED within minutes,
 * and the records either side of the cancellation are still in force.
 */
function resolveCancelledBySerial(all: readonly SpaceWeatherAlert[]): Set<number> {
  const cancelled = new Set<number>();
  for (const cancellation of all) {
    if (!cancellation.cancelled || !cancellation.cancelsSerialNumber) continue;
    const cancelIssuedMs = Date.parse(cancellation.issueDatetime);
    const candidates = all
      .map((alert, index) => ({ alert, index }))
      .filter(
        ({ alert }) =>
          alert !== cancellation &&
          alert.messageCode === cancellation.messageCode &&
          alert.serialNumber === cancellation.cancelsSerialNumber &&
          Date.parse(alert.issueDatetime) < cancelIssuedMs,
      )
      .sort((a, b) => Date.parse(a.alert.issueDatetime) - Date.parse(b.alert.issueDatetime));
    if (candidates.length === 0) continue;
    const named = cancellation.cancelsOriginalIssueDatetime;
    // The two times come from different feed fields — the body's minute-precision
    // "Issue Time:" versus the record's sub-second `issue_datetime` — so they agree only
    // to the minute.
    const exact = named
      ? candidates.filter(({ alert }) => sameMinute(alert.issueDatetime, named))
      : [];
    const target = (exact.length > 0 ? exact : candidates).at(-1);
    if (target) cancelled.add(target.index);
  }
  return cancelled;
}

/** True when two ISO 8601 instants fall in the same UTC minute. */
function sameMinute(a: string, b: string): boolean {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (Number.isNaN(aMs) || Number.isNaN(bMs)) return false;
  return Math.floor(aMs / 60_000) === Math.floor(bMs / 60_000);
}

/**
 * Indices of every record a later supersede-carrying record has replaced — all of them
 * but the newest by issue time.
 *
 * The rule keys on the line rather than the message code because the line says any and
 * all: the live Watches are sequential revisions of one three-day forecast, issued under
 * whichever `WATA*` code matches the level they predict, so scoping per code returns two
 * conflicting outlooks for the same day. The newest is chosen across the whole feed, not
 * just the records the window admitted — a superseding record outside the caller's
 * lookback still happened.
 *
 * An unreadable issue time sorts oldest rather than unbeatable: every `>` comparison
 * against `NaN` is false, so seeding it at 0 is what stops one undated record from
 * standing as the newest carrier and superseding every genuine Watch behind it.
 */
function resolveSuperseded(all: readonly SpaceWeatherAlert[]): Set<number> {
  const issuedMs = ({ alert }: { alert: SpaceWeatherAlert }) =>
    Date.parse(alert.issueDatetime) || 0;
  const carriers = all
    .map((alert, index) => ({ alert, index }))
    .filter(({ alert }) => alert.supersedes);
  if (carriers.length <= 1) return new Set();
  const newest = carriers.reduce((best, current) =>
    issuedMs(current) > issuedMs(best) ? current : best,
  );
  return new Set(carriers.filter(({ index }) => index !== newest.index).map(({ index }) => index));
}

/**
 * The first reason a record is not in force, or null when it is. A product is in force
 * until something in the feed says otherwise — a stated end that has passed, a
 * cancellation naming it, or a later product that supersedes it.
 */
function exclusionReason(
  alert: SpaceWeatherAlert,
  index: number,
  ctx: {
    nowMs: number;
    cutoffMs: number;
    cancelledBySerial: ReadonlySet<number>;
    superseded: ReadonlySet<number>;
  },
): ExclusionReason | null {
  const end = endMs(alert);
  const issuedMs = Date.parse(alert.issueDatetime);
  // `max_age_hours` bounds how far back to look for candidates; it is not itself a
  // statement about whether a product is in force. A product whose end is still ahead
  // stays in scope however old its issue time — without that, the default window drops a
  // Watch hours before the storm day it forecasts finishes. An issue time that cannot be
  // read counts as outside the window: nothing places it inside one.
  const outsideWindow = Number.isNaN(issuedMs) || issuedMs < ctx.cutoffMs;
  const endAhead = end !== null && end >= ctx.nowMs;
  if (outsideWindow && !endAhead) return 'agedOut';
  if (!IN_FORCE_TYPES.has(alert.productType)) return 'productType';
  // A cancellation carries the cancelled product's own type and no validity window, so
  // neither check above excludes it.
  if (alert.cancelled) return 'cancellationRecord';
  if (ctx.cancelledBySerial.has(index)) return 'cancelledBySerial';
  if (ctx.superseded.has(index)) return 'superseded';
  if (end !== null && end < ctx.nowMs) return 'validityElapsed';
  return null;
}

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
        'True when this record cancels a previously issued product ("CANCEL WARNING:"/"CANCEL WATCH:"/"CANCEL ALERT:" headline) rather than being in force. Always false when active_only=true, which excludes both the cancellation record and the product it names — a cancelled product carries cancelled: false itself, so this flag does not identify one. Set active_only=false to see cancellations and what they cancelled.',
      ),
    serialNumber: z
      .string()
      .nullable()
      .describe(
        'The record\'s SWPC "Serial Number:" value, e.g. "1125"; null when the body carries no such line. A per-message-code counter, not a globally unique ID — it repeats across codes and within one code on a corrected reissue, so quote it together with messageCode. It is the key the "Cancel Serial Number:", "Extension to Serial Number:", and "Continuation of Serial Number:" lines in message point at, which is what makes those chains navigable.',
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
        'Validity-window end as ISO 8601 UTC. Read from the message body\'s "Valid To", "Now Valid Until", or "End Time" label when the product states one. A Watch states none, so its end is derived from the "Highest Storm Level Predicted by Day:" list instead: the instant the last listed UTC day forecasting a storm ends (a trailing "None" day is a forecast of quiet, not coverage), so a Watch listing Sep 17 as its last storm day ends at 2026-09-18T00:00:00Z. Null when nothing in the body states or implies an end — a point-in-time Alert, or a Watch forecasting no storm on any listed day.',
      ),
    message: z.string().describe('Full plain-text message body.'),
  })
  .describe('One SWPC alert, watch, warning, or summary.');

export const getAlerts = tool('noaa_spaceweather_get_alerts', {
  title: 'Get Space Weather Alerts',
  description:
    'Active SWPC alerts, watches, and warnings — parsed into structured records with product type, ' +
    'NOAA scale and level, issue time, serial number, validity window, and plain text. Covers ' +
    'geomagnetic storms, radio blackouts, and radiation storms. With active_only=false, also ' +
    'returns informational summaries, expired notices, and cancellations. max_age_hours controls ' +
    'how far back to look for candidates (default 48 h) — under active_only=true it does not cut ' +
    'off a product whose validity end is still in the future, and under active_only=false it is a ' +
    'literal age cutoff. The SWPC feed keeps all historical records and has no built-in expiry.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    active_only: z
      .boolean()
      .default(true)
      .describe(
        'When true (default), return only in-force Warnings, Watches, and Alerts. Excluded: Summaries and unrecognized products; products whose validity end has passed; cancellation notices; any product a later cancellation names by serial; and all but the newest record carrying the "THIS SUPERSEDES ANY/ALL PRIOR WATCHES IN EFFECT" line. Counts per reason ride in the exclusions enrichment field. Set false to return every product in the window, cancellations included (flagged by the cancelled field).',
      ),
    max_age_hours: z
      .number()
      .min(1)
      .max(720)
      .default(48)
      .describe(
        'How far back to look for products, in hours (default 48). The SWPC feed retains all historical records, so this bounds the candidate set rather than declaring what is current. Under active_only=true a product whose validity end is still in the future is returned even when its issue time falls outside this window — a multi-day Watch would otherwise disappear while a day it forecasts a storm for is still running. Under active_only=false it is literal and cuts at exactly the requested age.',
      ),
  }),
  output: z.object({
    alerts: z.array(AlertSchema).describe('Matching SWPC alert/watch/warning records.'),
    totalCount: z.number().describe('Count of records in the alerts array.'),
    activeOnly: z
      .boolean()
      .describe(
        'Echo of the active_only input: true when the records are the in-force set, false when they are every product in the window. Distinguishes an empty in-force result from an empty feed window.',
      ),
    fetchedAt: z.string().describe('ISO 8601 timestamp of when this data was fetched.'),
  }),

  errors: [
    {
      reason: 'feed_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'SWPC feed returns 5xx or 429, times out, or answers with a body that is not parseable JSON. Retried before failing.',
      retryable: true,
      recovery: 'Retry in 30–60 seconds; SWPC feeds occasionally lag during high-activity events.',
    },
    {
      reason: 'feed_moved',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'SWPC feed path returns a permanent 4xx (404, 410, 401, 403). Fails in one attempt.',
      retryable: false,
      recovery:
        'Retrying will not help — the SWPC feed path no longer resolves or no longer has the expected shape; the feed URL needs updating against SWPC current inventory.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching SWPC alerts', {
      active_only: input.active_only,
      max_age_hours: input.max_age_hours,
    });
    const svc = getSpaceWeatherService();
    const all = await svc.getAlerts(ctx);

    // Compare as epochs — string comparison would silently fail when issueDatetime and
    // the ISO cutoff don't share the exact same format.
    const nowMs = Date.now();
    const cutoffMs = nowMs - input.max_age_hours * 60 * 60 * 1000;

    let filtered: typeof all;
    let excluded: Record<ExclusionReason, number> | undefined;

    if (input.active_only) {
      // Both cross-record rules read the whole feed, not just the records the window
      // admitted: a cancellation or a superseding Watch issued outside the caller's
      // lookback still happened.
      const filterCtx = {
        nowMs,
        cutoffMs,
        cancelledBySerial: resolveCancelledBySerial(all),
        superseded: resolveSuperseded(all),
      };
      const counts = Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, 0])) as Record<
        ExclusionReason,
        number
      >;
      filtered = [];
      all.forEach((alert, index) => {
        const reason = exclusionReason(alert, index, filterCtx);
        if (reason) counts[reason] += 1;
        else filtered.push(alert);
      });
      // Zeros across the board would tell a caller nothing it can act on; the window
      // echo below already says filtering was applied.
      if (filtered.length < all.length) excluded = counts;
      ctx.enrich({
        appliedWindowHours: input.max_age_hours,
        appliedCutoff: new Date(cutoffMs).toISOString(),
      });
      // Written separately rather than spread in conditionally: enrich accumulates, and
      // an absent field must stay absent rather than arrive as an explicit undefined.
      if (excluded) ctx.enrich({ exclusions: excluded });
    } else {
      // A literal history window — nothing is filtered by reason, so no counts.
      filtered = all.filter((a) => Date.parse(a.issueDatetime) >= cutoffMs);
    }

    if (filtered.length === 0) {
      // ctx.enrich.notice is last-wins, so the whole empty-state message is composed
      // once here rather than appended to across branches.
      const excludedCount = excluded
        ? Object.values(excluded).reduce((sum, n) => sum + n, 0)
        : undefined;
      ctx.enrich.notice(
        input.active_only
          ? excludedCount
            ? `No active alerts, watches, or warnings — all ${excludedCount} products in the feed were excluded; see exclusions for the breakdown, or set active_only=false to see them.`
            : 'No active alerts, watches, or warnings. Set active_only=false to include summaries.'
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
        serialNumber: a.serialNumber,
        phenomenon: a.phenomenon,
        issueDatetime: a.issueDatetime,
        validFrom: a.validFrom,
        validTo: a.validTo,
        message: a.message,
      })),
      totalCount: filtered.length,
      activeOnly: input.active_only,
      fetchedAt: new Date().toISOString(),
    };
  },

  enrichment: {
    notice: z.string().optional().describe('Status notice when no products were returned.'),
    appliedWindowHours: z
      .number()
      .optional()
      .describe(
        'The max_age_hours window as applied, echoed so a caller can see what bounded the candidate set. Present only under active_only=true, where a future validity end can keep an older product in scope.',
      ),
    appliedCutoff: z
      .string()
      .optional()
      .describe(
        'ISO 8601 UTC instant the applied window starts at: a product issued before this is outside it. Present only under active_only=true.',
      ),
    exclusions: z
      .object({
        agedOut: z
          .number()
          .describe('Issued outside the applied window with no validity end still ahead.'),
        productType: z
          .number()
          .describe('Summaries and unrecognized products, which are never in force.'),
        cancellationRecord: z.number().describe('Cancellation notices themselves.'),
        cancelledBySerial: z
          .number()
          .describe(
            'Named by a later cancellation\'s "Cancel Serial Number:" under the same code.',
          ),
        superseded: z
          .number()
          .describe('Carries the supersede line but is not the newest record that does.'),
        validityElapsed: z
          .number()
          .describe(
            'Validity end already passed, with nothing newer cancelling or superseding it.',
          ),
      })
      .optional()
      .describe(
        'How many products active_only=true left out, by reason. Reasons overlap, so each excluded record is counted under the first that applies, in this field order — these counts plus totalCount equal the number of records the feed carried. Emitted only when something was excluded, and never under active_only=false. Use it to tell "space weather is quiet" from "everything was filtered" without a second active_only=false call.',
      ),
  },

  enrichmentTrailer: {
    // A structured field would otherwise collapse to a JSON blob in the content[]
    // trailer. Reasons that did not fire are dropped and the keys are left as the schema
    // spells them, so a reader can map a count straight back to structuredContent.
    exclusions: {
      render: (value) => {
        const counts: Record<string, number> = value ?? {};
        const fired = Object.entries(counts)
          .filter(([, count]) => count > 0)
          .map(([reason, count]) => `${count} ${reason}`);
        return `**Excluded:** ${fired.length > 0 ? fired.join(', ') : 'none'}`;
      },
    },
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## SWPC Space Weather Alerts — ${result.fetchedAt}`);
    // The scope belongs beside the count: a total of 0 means something different for an
    // in-force query than for an unfiltered one.
    const scope = result.activeOnly
      ? 'active products only'
      : 'all products in the requested window';
    lines.push(`**Total:** ${result.totalCount} · **Scope:** ${scope}`);
    if (result.alerts.length === 0) {
      lines.push(
        result.activeOnly
          ? '\n_No active alerts._'
          : '\n_No space weather products issued in the requested window._',
      );
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
        // The serial is what makes the "Cancel Serial Number:" and "Continuation of
        // Serial Number:" chains in the body navigable, so it rides here for clients
        // that render only content[].
        const serial = alert.serialNumber ?? 'not stated';
        lines.push(
          `**Issued:** ${alert.issueDatetime} | **Level:** ${alert.level}${scale} | **Serial:** ${serial}`,
        );
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
