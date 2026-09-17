/**
 * @fileoverview NOAA Space Weather Prediction Center (SWPC) feed client.
 * Wraps keyless public JSON feeds from services.swpc.noaa.gov, normalizes the
 * diverse feed shapes (array-of-objects, keyed objects) into clean typed domain
 * records, and exposes per-feed methods used by all tools.
 * @module services/space-weather/space-weather-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, type RequestContext, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type {
  AuroraForecastData,
  F107Observation,
  ForecastDiscussion,
  KpForecast,
  KpObservation,
  NoaaScalesData,
  NoaaScalesPeriod,
  ProtonFlux,
  SolarProbabilities,
  SolarRegion,
  SolarWindMag,
  SolarWindPlasma,
  SpaceWeatherAlert,
  XrayFlare,
  XrayFlux,
} from './types.js';

// ── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://services.swpc.noaa.gov';
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Build the SWPC User-Agent from the running server version so it tracks
 * package.json instead of a hardcoded release that silently drifts on each bump.
 * Product token and contact URL are fixed; only the version is dynamic.
 */
function buildUserAgent(version: string): string {
  return `noaa-spaceweather-mcp-server/${version} (github.com/cyanheads/noaa-spaceweather-mcp-server)`;
}

/** Missing/fill value used in many SWPC feeds for sensor failures. */
const FILL_VALUE = -9999;

// ── NOAA scale helpers ──────────────────────────────────────────────────────

/**
 * Maps a Kp value (0–9) to its NOAA G-scale level (0–5). Shared with the
 * get-kp-index tool.
 *
 * SWPC publishes Kp in thirds and starts each G level at that level's "minus"
 * value, so G1 begins at 5− (4.67) rather than 5. Rounding to thirds
 * (`Math.round(kp * 3)`) maps every spelling of a third — 4.67, 4.66 — onto one
 * integer, which makes the bands exact integer comparisons instead of float
 * compares needing a tuned epsilon per band. The top boundary follows the NOAA
 * scales page, which gives G4 as "Kp = 8, including a 9-" and G5 as "Kp = 9": 8.67
 * is G4 and only 9.00 is G5.
 */
export function kpToGScale(kp: number): number {
  const thirds = Math.round(kp * 3);
  if (thirds >= 27) return 5; // 9.00
  if (thirds >= 23) return 4; // 7.67
  if (thirds >= 20) return 3; // 6.67
  if (thirds >= 17) return 2; // 5.67
  if (thirds >= 14) return 1; // 4.67
  return 0;
}

/** One geomagnetic-latitude band of the aurora reachability table. */
export interface AuroraBand {
  /** Equatorward edge of the band, in degrees of geomagnetic latitude. */
  geomagneticLatitude: number;
  /** NOAA G level that reaches this band; 0 means inside the quiet-time oval. */
  gScale: number;
  /** Kp floor at which that G level begins; 0 inside the oval. */
  minKp: number;
}

/**
 * Aurora reachability by geomagnetic latitude, keyed on NOAA G level, ordered
 * poleward-first. The single table for the whole server: aurora-latitude guidance
 * on the Kp tools and the Kp threshold the aurora tool reports for a location both
 * read it, so the two can no longer state different thresholds for one place.
 *
 * Latitudes for G2–G5 are the NOAA scales page figures. The 60° G1 row is this
 * server's interpolation between that page's G2 row and the oval edge — the page
 * states no G1 latitude. The 65° row is not a storm level at all: it is the
 * quiet-time equatorward edge of the auroral oval, where aurora needs no elevated
 * Kp. Below the 40° G5 row no level on the scale reaches.
 *
 * Each Kp floor is its level's "minus" third — the value at which SWPC starts the
 * level, per {@link kpToGScale} — except G5, which begins at a whole Kp 9.
 */
export const AURORA_BANDS: readonly AuroraBand[] = [
  { geomagneticLatitude: 65, gScale: 0, minKp: 0 },
  { geomagneticLatitude: 60, gScale: 1, minKp: 4.67 },
  { geomagneticLatitude: 55, gScale: 2, minKp: 5.67 },
  { geomagneticLatitude: 50, gScale: 3, minKp: 6.67 },
  { geomagneticLatitude: 45, gScale: 4, minKp: 7.67 },
  { geomagneticLatitude: 40, gScale: 5, minKp: 9.0 },
];

/**
 * Resolve the aurora band a geomagnetic latitude sits in, north or south. Returns
 * null equatorward of the 40° G5 edge, where no NOAA storm level reaches.
 */
export function auroraBandForGeomagneticLatitude(geomagneticLatitude: number): AuroraBand | null {
  const abs = Math.abs(geomagneticLatitude);
  return AURORA_BANDS.find((band) => abs >= band.geomagneticLatitude) ?? null;
}

/** Returns aurora visibility latitude guidance for a G-scale level. */
function gScaleToAuroraLatitude(gScale: number): string {
  // G0 is "no storm", not the 65° oval row that also carries gScale 0.
  const band = gScale > 0 ? AURORA_BANDS.find((b) => b.gScale === gScale) : undefined;
  return band
    ? `Aurora possible to ~${band.geomagneticLatitude}° geomagnetic latitude`
    : 'No significant aurora expected at mid-latitudes';
}

// ── Shared fetch helper ─────────────────────────────────────────────────────

/**
 * Matches a JSON string literal, or a bare non-finite numeric token outside one.
 * The string alternative comes first so a quoted value or a key name is consumed
 * whole and never rewritten — including one whose text contains "NaN".
 */
const NON_FINITE_TOKEN_RE = /"(?:[^"\\]|\\.)*"|-?\bInfinity\b|\bNaN\b/g;

/**
 * Replace bare `NaN` / `Infinity` / `-Infinity` tokens in numeric value positions
 * with JSON `null`, leaving every quoted string byte-identical. SWPC emits these
 * non-standard tokens for a failed sensor reading, which is what `null` already
 * means to {@link parseNum}.
 */
function nullOutNonFiniteTokens(text: string): string {
  return text.replace(NON_FINITE_TOKEN_RE, (match) => (match.startsWith('"') ? match : 'null'));
}

/** Parse JSON, returning null instead of throwing so a caller can try a repair. */
function tryParseJson<T>(text: string): { value: T } | null {
  try {
    return { value: JSON.parse(text) as T };
  } catch {
    return null;
  }
}

/**
 * The declared failure reasons every tool's `errors[]` exposes for an upstream feed
 * failure. They split on whether retrying can ever help, because the recovery hint
 * `ctx.recoveryFor` resolves is one-per-reason and the two hints point in opposite
 * directions.
 */
type FeedFailureReason = 'feed_unavailable' | 'feed_moved';

/**
 * Wire-shaped feed failure: the caller's tool contract supplies the recovery hint,
 * `path` names the feed on every class (an HTTP-origin error carries a status but no
 * path of its own), and `data` from the underlying rejection is preserved so `status`,
 * `statusText`, `retryAfter`, `retryAttempts`, and `available` survive.
 *
 * Both reasons map to `ServiceUnavailable`: the failure is upstream, and no 4xx from
 * these keyless feeds can be caused by caller input. `feed_moved` also carries
 * `retryable: false`, so a caller — or any outer retry — can see that re-attempting a
 * path SWPC no longer serves cannot succeed.
 */
function feedFailure(
  reason: FeedFailureReason,
  message: string,
  path: string,
  ctx: Context,
  data?: Record<string, unknown>,
  cause?: unknown,
): McpError {
  return new McpError(
    JsonRpcErrorCode.ServiceUnavailable,
    message,
    {
      ...data,
      ...(reason === 'feed_moved' ? { retryable: false } : {}),
      path,
      reason,
      ...ctx.recoveryFor(reason),
    },
    cause !== undefined ? { cause } : undefined,
  );
}

/**
 * The codes the framework's retry predicate treats as transient, so a rejection
 * carrying one has already been through all four attempts.
 */
const RETRIED_CODES: ReadonlySet<JsonRpcErrorCode> = new Set([
  JsonRpcErrorCode.ServiceUnavailable,
  JsonRpcErrorCode.Timeout,
  JsonRpcErrorCode.RateLimited,
]);

/**
 * Which reason an upstream rejection belongs to, or null when it is not a feed failure
 * at all and must pass through untouched.
 *
 * A 4xx the framework treats as permanent means the feed path itself no longer resolves
 * — these tools take no upstream identifier, so nothing a caller sent can produce one
 * (#21 was SWPC deleting a feed outright). Keying on the retry verdict rather than the
 * status range alone is what keeps `feed_moved` synonymous with "failed on the first
 * attempt": a 408 or 425 is a 4xx the framework classifies as `Timeout` and retries, so
 * it belongs with the transient set. Everything else — 5xx, 429, network error, client
 * deadline, unparseable or HTML body — clears on its own and stays retryable.
 */
function feedFailureReason(error: unknown): FeedFailureReason | null {
  if (error instanceof McpError) {
    if (error.code === JsonRpcErrorCode.RequestCancelled) return null;
    const status = error.data?.status;
    const permanentStatus = typeof status === 'number' && status >= 400 && status < 500;
    if (permanentStatus && !RETRIED_CODES.has(error.code)) return 'feed_moved';
  }
  return 'feed_unavailable';
}

/** Matches a body whose first markup is an HTML document rather than feed content. */
const HTML_BODY_RE = /^\s*<(!DOCTYPE\s+html|html[\s>])/i;

/**
 * The single funnel every feed call passes through — JSON or plain text — so it is also
 * the one place a rejection is classified against the tools' declared error contract.
 * A second fetch path with its own retry and error handling would lose `data.reason`,
 * `data.path`, and the contract recovery hint.
 *
 * Classification sits **outside** the `withRetry` boundary on purpose. Both reasons
 * surface as `ServiceUnavailable`, which is in the framework's transient set — rewriting
 * the code inside the retry closure would turn a permanent 404 into four attempts and
 * seven seconds spent on a feed SWPC no longer serves. Out here the retry decision has
 * already been made from the upstream code, so attempt counts are untouched.
 */
function withFeedClassification<T>(
  path: string,
  ctx: Context,
  run: (reqCtx: RequestContext) => Promise<T>,
): Promise<T> {
  // Cast ctx to RequestContext for framework utils — Context is structurally
  // compatible but lacks the index signature the type expects.
  const reqCtx = ctx as unknown as RequestContext;
  return withRetry(() => run(reqCtx), {
    operation: `fetchFeed:${path}`,
    context: reqCtx,
    baseDelayMs: 1000,
    signal: ctx.signal,
  }).catch((error: unknown) => {
    // The caller withdrew the request; nothing about the feed failed.
    if (ctx.signal.aborted) throw error;
    const reason = feedFailureReason(error);
    if (reason === null) throw error;
    throw feedFailure(
      reason,
      error instanceof Error ? error.message : `SWPC feed request failed for ${path}.`,
      path,
      ctx,
      error instanceof McpError ? error.data : undefined,
      error,
    );
  });
}

/** One request for `path`, returning the body as text. */
async function requestBody(
  path: string,
  reqCtx: RequestContext,
  signal: AbortSignal,
  userAgent: string,
): Promise<string> {
  const response = await fetchWithTimeout(`${BASE_URL}${path}`, FETCH_TIMEOUT_MS, reqCtx, {
    signal,
    headers: { 'User-Agent': userAgent },
  });
  return response.text();
}

/** Fetch and parse a JSON feed, through the shared retry-plus-classify funnel. */
function fetchFeed<T>(path: string, ctx: Context, userAgent: string): Promise<T> {
  return withFeedClassification(path, ctx, async (reqCtx) => {
    const text = await requestBody(path, reqCtx, ctx.signal, userAgent);
    if (HTML_BODY_RE.test(text)) {
      throw serviceUnavailable(
        `SWPC feed returned HTML instead of JSON — likely rate-limited or unavailable.`,
        { path },
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      // A bare NaN/Infinity token is a lexical error: the parse aborts before any
      // value exists, so a reviver can never reach it. Repair only a body that has
      // already failed — the happy path never pays for the scan, and these bodies
      // reach 4.5 MB.
      const repaired = nullOutNonFiniteTokens(text);
      if (repaired !== text) {
        const parsed = tryParseJson<T>(repaired);
        if (parsed) return parsed.value;
      }
      throw serviceUnavailable(
        `Failed to parse SWPC feed JSON from ${path}.`,
        { path },
        { cause: err },
      );
    }
  });
}

/**
 * Fetch a plain-text SWPC product, through the same funnel as {@link fetchFeed}. The
 * HTML guard applies unchanged: an HTML body from these paths is the rate-limited or
 * unavailable page, not a product, and it clears on its own.
 *
 * Whether the body is the *shape* the product is documented to have is checked by the
 * caller, after this resolves — the same placement as the scales feed's missing-`"0"`
 * check, and for the same reason: a `feed_moved` raised in here would be a
 * `ServiceUnavailable` inside the retry closure and cost four attempts on a break no
 * retry can fix.
 */
function fetchText(path: string, ctx: Context, userAgent: string): Promise<string> {
  return withFeedClassification(path, ctx, async (reqCtx) => {
    const text = await requestBody(path, reqCtx, ctx.signal, userAgent);
    if (HTML_BODY_RE.test(text)) {
      throw serviceUnavailable(
        `SWPC product returned HTML instead of text — likely rate-limited or unavailable.`,
        { path },
      );
    }
    return text;
  });
}

// ── Normalization helpers ───────────────────────────────────────────────────

/**
 * Parse numeric string, returning null if the value is the fill value or NaN.
 *
 * The single numeric parse for the scales feed, levels and probabilities alike. SWPC
 * sends `null` for a period it issues no level for — every forecast period's R and S,
 * where the forecast is a probability instead — and that null is upstream saying "no
 * level here", a different claim from level 0. Returning null rather than 0 is what
 * keeps the two apart (#23); an unparseable value is not a level or a percentage
 * either and reads the same way.
 */
function parseNum(s: string | number | null | undefined): number | null {
  if (s == null) return null;
  const n = typeof s === 'string' ? parseFloat(s) : s;
  if (!Number.isFinite(n) || n === FILL_VALUE) return null;
  return n;
}

/**
 * Normalize a SWPC time tag string to explicit ISO 8601 UTC (always ends in 'Z').
 * SWPC emits two Z-less shapes: solar-wind and alert bodies use space-separated
 * "YYYY-MM-DD HH:MM:SS.mmm", while the Kp feeds use T-separated
 * "YYYY-MM-DDTHH:MM:SS". Neither carries a UTC designator, so `new Date(tag)`
 * interprets them as local time and corrupts all time-based filtering.
 * Short-circuits only when the value already ends in 'Z' (or isn't a string);
 * otherwise swaps the date/time space for 'T' (a no-op when already 'T'-separated)
 * and appends 'Z'.
 */
function normalizeSwpcTime(tag: string): string {
  if (typeof tag !== 'string' || tag.endsWith('Z')) return tag;
  return `${tag.replace(' ', 'T')}Z`;
}

/**
 * Comparator ordering records oldest-first on one explicit-UTC ISO 8601 field —
 * lexicographic compare is chronological once every tag ends in 'Z'.
 *
 * Every series this service emits is oldest-first regardless of the order upstream
 * serves it — the RTSW and F10.7 feeds both serve newest-first — so ordering is an
 * invariant of the domain types rather than an accident of the feed. Each series names
 * its own key: solar-wind records carry `timeTag`, a flare event carries no tag of its
 * own and keys on `beginTime` (the feed's `time_tag` equals `begin_time` on every
 * record), and an F10.7 report keys on `observedTime`.
 */
function byIsoAscending<K extends string>(
  key: K,
): (a: Record<K, string>, b: Record<K, string>) => number {
  return (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
}

/** Three-letter month abbreviations used in SWPC product datetime lines. */
const SWPC_MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

/**
 * Parse a SWPC product datetime ("2026 Jun 14 0600 UTC") to ISO 8601 UTC
 * ("2026-06-14T06:00:00Z"). SWPC alert/warning bodies use this "YYYY Mon DD
 * HHMM UTC" shape, which `new Date()` cannot parse. Returns null when the input
 * doesn't match, so callers can fall back to the raw text.
 */
function parseSwpcDatetime(raw: string): string | null {
  const m = raw.trim().match(/^(\d{4})\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\s+UTC$/);
  if (!m) return null;
  const [, year, monthAbbr, dayRaw, hhmm] = m;
  if (!(year && monthAbbr && dayRaw && hhmm)) return null;
  const month = SWPC_MONTHS[monthAbbr.toLowerCase()];
  if (!month) return null;
  const day = dayRaw.padStart(2, '0');
  return `${year}-${month}-${day}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00Z`;
}

// ── Forecast Discussion parsing ─────────────────────────────────────────────

/** Matches the ":Issued:" directive of a SWPC text product and captures its value. */
const ISSUED_LINE_RE = /^:Issued:\s*(.+)$/im;

/**
 * Opens a topic section. Every section of the discussion leads with this block, so it
 * is the anchor the section scan keys on — the heading itself is an unprefixed line
 * with nothing to distinguish it from body prose except its position above this.
 */
const SUMMARY_HEADER_RE = /^\.\s*24\s*hr\s+summary/i;

/** Opens the forecast block inside a topic section. */
const FORECAST_HEADER_RE = /^\.forecast/i;

/** Any block header — what ends the preceding block's text. */
const BLOCK_HEADER_RE = /^\./;

/**
 * True for a line that could be a topic heading: SWPC writes headings unprefixed,
 * while every other structural line carries a ":directive", "#comment", or ".header"
 * marker.
 */
function isTopicHeading(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith(':') &&
    !trimmed.startsWith('#') &&
    !trimmed.startsWith('.')
  );
}

/**
 * The text of one block, from its header to the next header or the section's end.
 * Interior blank lines survive — a summary can run several paragraphs, so splitting on
 * one would truncate it — and the padding at either end does not. Null when the block
 * is absent or carries no text.
 */
function blockText(lines: readonly string[], headerRe: RegExp): string | null {
  const start = lines.findIndex((line) => headerRe.test(line));
  if (start === -1) return null;
  const collected: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (BLOCK_HEADER_RE.test(line)) break;
    collected.push(line);
  }
  while (collected[0]?.trim() === '') collected.shift();
  while (collected.at(-1)?.trim() === '') collected.pop();
  return collected.length > 0 ? collected.join('\n') : null;
}

/**
 * Parse the SWPC Forecast Discussion product into its topic sections. Returns null
 * when the body carries no topic section at all, which the caller reports as a shape
 * break rather than passing off as a discussion with nothing in it: the sections are
 * the product, and an ":Issued:" line is no evidence of one — every SWPC text product
 * opens with that directive, so a body carrying it and no section is as likely to be a
 * different product served on this path as an empty discussion. An absent issue line
 * alongside real sections is the opposite case and parses, with `issued` null.
 *
 * Sections are located from their ".24 hr Summary..." headers: the last non-blank line
 * above one is the topic heading, and the section runs from there to the next topic
 * heading. Scanning for unprefixed lines directly would also match every line of body
 * prose.
 */
function parseForecastDiscussion(raw: string): ForecastDiscussion | null {
  const body = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = body.split('\n');
  const issuedRaw = body.match(ISSUED_LINE_RE)?.[1]?.trim();

  const starts: { topic: string; topicIndex: number }[] = [];
  lines.forEach((line, index) => {
    if (!SUMMARY_HEADER_RE.test(line)) return;
    for (let above = index - 1; above >= 0; above--) {
      const candidate = lines[above] ?? '';
      if (candidate.trim().length === 0) continue;
      // The first non-blank line above decides: anything marked as a directive,
      // comment, or another block header means this block opens no new section.
      if (isTopicHeading(candidate)) starts.push({ topic: candidate.trim(), topicIndex: above });
      break;
    }
  });

  if (starts.length === 0) return null;

  return {
    // The ":Issued:" value is the same "YYYY Mon DD HHMM UTC" shape the alert bodies
    // use; fall back to its raw text when it does not match, as the alert parsing does.
    issued: issuedRaw === undefined ? null : (parseSwpcDatetime(issuedRaw) ?? issuedRaw),
    sections: starts.map(({ topic, topicIndex }, position) => {
      const end = starts[position + 1]?.topicIndex ?? lines.length;
      const sectionLines = lines.slice(topicIndex + 1, end);
      return {
        topic,
        summary: blockText(sectionLines, SUMMARY_HEADER_RE),
        forecast: blockText(sectionLines, FORECAST_HEADER_RE),
      };
    }),
  };
}

/** Parse a product code prefix to a product type. */
function parseProductType(id: string): SpaceWeatherAlert['productType'] {
  const upper = id.toUpperCase();
  if (upper.startsWith('WAR')) return 'Warning';
  if (upper.startsWith('WAT')) return 'Watch';
  if (upper.startsWith('ALT')) return 'Alert';
  if (upper.startsWith('SUM')) return 'Summary';
  return 'Other';
}

/**
 * Matches the NOAA scale stated in a product body, e.g. "NOAA Scale: G1 - Minor".
 * Deliberately neither case-sensitive nor line-anchored: SWPC emits both
 * "NOAA Scale:" and "Noaa Scale:", and sometimes glues correction prose straight
 * onto the label with no line break ("...valid until 12/2100 UTC.NOAA Scale: G1 -
 * Minor"), which a `^`-anchored pattern would silently miss.
 */
const NOAA_SCALE_RE = /noaa\s+scale:\s*([GRS]\d)/i;

/**
 * Matches the storm category in a Watch headline, e.g. "WATCH: Geomagnetic Storm
 * Category G2 Predicted". The A-index watch products carry this instead of a
 * "NOAA Scale:" line. The literal "Category" is required so this cannot match the
 * per-day "Jul 03:  G2 (Moderate)" outlook lines further down the same body.
 */
const CATEGORY_RE = /category\s+([GRS]\d)/i;

/**
 * Matches a cancellation headline. SWPC cancels a product by issuing a fresh record
 * under the same message code with a "CANCEL <type>:" headline, so this must be
 * evaluated per record — a single code cycles between in-force and cancelled within
 * minutes. "EXTENDED"/"CONTINUED" headlines mean the opposite (still in force) and
 * deliberately do not match; the line anchor keeps the "Cancel Serial Number:" field
 * carried by every cancellation from triggering it.
 */
const CANCEL_RE = /^CANCEL\s+(?:WARNING|WATCH|ALERT):/im;

/**
 * Matches the record's own serial number. Line-anchored on purpose: every cancellation,
 * extension, and continuation also carries a "<prefix> Serial Number:" field naming a
 * *different* record, and an unanchored pattern would read one of those as this
 * record's own serial.
 */
const SERIAL_RE = /^Serial\s+Number:\s*(\S+)/im;

/** Matches the serial a cancellation names as its target. */
const CANCEL_SERIAL_RE = /^Cancel\s+Serial\s+Number:\s*(\S+)/im;

/**
 * Matches the issue time a cancellation restates for its target. Only a cancellation
 * carries this line, so it never collides with the record's own "Issue Time:".
 */
const ORIGINAL_ISSUE_TIME_RE = /^Original\s+Issue\s+Time:\s*([^\r\n]+)/im;

/**
 * Matches the supersede claim every in-force Watch carries ("THIS SUPERSEDES ANY/ALL
 * PRIOR WATCHES IN EFFECT"). Line-anchored and keyed on the opening words so a body
 * mentioning the word in prose cannot trigger it.
 */
const SUPERSEDES_RE = /^THIS\s+SUPERSEDES\b/im;

/**
 * Matches the header above a Watch's per-day storm outlook, consuming the rest of its
 * line so the entry scan starts on the first day line. A cancellation states its days
 * under "Cancelled Level Predicted:", which deliberately does not match — that list
 * describes what was called off, not a period the product covers.
 */
const PREDICTED_DAY_HEADER_RE = /^Highest\s+Storm\s+Level\s+Predicted\s+by\s+Day:[^\n]*\n/im;

/**
 * Matches one "<Mon> <DD>:  <Level> (<Descriptor>)" entry of a predicted-day line.
 * The colon must follow the day with no space: the cancellation list writes
 * "Sep 08  : None (Bellow G1)", a second guard against parsing one.
 */
const PREDICTED_DAY_ENTRY_RE = /\b([A-Za-z]{3})\s+(\d{1,2}):\s+(\S+)/g;

/** The level SWPC writes for a day it forecasts no storm on. */
const NO_STORM_LEVEL = 'none';

/**
 * Extract the NOAA scale a product body states, e.g. "G1", "R2", "S1". Prefers the
 * explicit "NOAA Scale:" label and falls back to a Watch headline's "Category G<n>".
 * Returns null for products carrying neither — K4 warnings sit below the G-scale, and
 * radio-burst/electron-flux alerts sit outside the NOAA scales entirely.
 */
function parseNoaaScale(message: string): string | null {
  const m = message.match(NOAA_SCALE_RE) ?? message.match(CATEGORY_RE);
  return m?.[1]?.toUpperCase() ?? null;
}

/**
 * Fallback phenomenon for products whose body states no NOAA scale, keyed on the
 * message code's core (the characters after the WAR/WAT/ALT/SUM prefix). Order
 * matters: "SUD" (Geomagnetic Sudden Impulse) must be matched before the bare "S"
 * solar-radiation branch it would otherwise fall into.
 */
function phenomenonFromCode(code: string): string {
  const core = code.toUpperCase().slice(3);
  if (core.startsWith('SUD')) return 'Geomagnetic';
  // A-index storm watches (A20/A30/A50) are geomagnetic-storm products keyed on a
  // predicted A-index, not aurora bulletins.
  if (/^[AGK]\d/.test(core)) return 'Geomagnetic';
  if (core.startsWith('X') || core.startsWith('R')) return 'Radio Blackout';
  if (core.startsWith('PX') || core.startsWith('S')) return 'Solar Radiation';
  return 'Space Weather';
}

/**
 * Resolve the phenomenon from the NOAA scale letter the body states — it names the
 * product's domain directly — falling back to the message code when there is none.
 */
function parsePhenomenon(code: string, scale: string | null): string {
  switch (scale?.[0]) {
    case 'G':
      return 'Geomagnetic';
    case 'R':
      return 'Radio Blackout';
    case 'S':
      return 'Solar Radiation';
    default:
      return phenomenonFromCode(code);
  }
}

/**
 * Resolve the NOAA scale level (0–5) from the scale the body states. K-index-suffixed
 * codes carrying no scale line convert through {@link kpToGScale} (K4 sits below the
 * G-scale, so it resolves to 0). Everything else falls back to 0, meaning "no NOAA
 * scale" — a code's numeric suffix is not a severity: it encodes flux thresholds
 * ("EF3"), radio-burst types ("TP2"), and wavelengths ("10R").
 */
function parseLevel(code: string, scale: string | null): number {
  if (scale) return Number(scale.slice(1));
  const kIndex = code.toUpperCase().match(/^(?:WAR|ALT)K(\d{2})$/)?.[1];
  return kIndex ? kpToGScale(Number(kIndex)) : 0;
}

/**
 * Extract a validity datetime from the first message line matching `labelRe`
 * (capture group 1 = the datetime text), normalized to ISO 8601 UTC. Falls back
 * to the raw trimmed text when it doesn't match the SWPC datetime shape, and
 * returns null when no line matches.
 */
function parseValidity(message: string, labelRe: RegExp): string | null {
  const value = message.match(labelRe)?.[1]?.trim();
  if (!value) return null;
  return parseSwpcDatetime(value) ?? value;
}

/**
 * Derive a validity end from a Watch's "Highest Storm Level Predicted by Day:" list,
 * as ISO 8601 UTC. No `WAT*` product carries a validity label, so this list is the
 * only thing in the body that states how far the Watch reaches — without it, every
 * Watch's end reads as unknown and an elapsed-end filter can never drop one.
 *
 * The end is the *end* of the last listed UTC day whose level is not "None", expressed
 * as the start of the following day. A trailing "None" day forecasts quiet rather than
 * extending coverage, so taking the last listed day instead over-extends by a full day
 * on most live Watches; a list that is "None" throughout covers nothing and yields null.
 *
 * The list states no year. It is taken from `issueDatetime`, rolled forward for a
 * January day listed by a December Watch — the only boundary a forward-looking
 * three-day outlook can cross.
 *
 * Returns null when the body carries no such list, when its days are all quiet, or when
 * the issue time cannot be read (there is then no year to resolve the days against).
 */
function parsePredictedDayEnd(message: string, issueDatetime: string): string | null {
  const header = message.match(PREDICTED_DAY_HEADER_RE);
  if (header?.index === undefined) return null;

  const issueMs = Date.parse(issueDatetime);
  if (Number.isNaN(issueMs)) return null;
  const issued = new Date(issueMs);

  let lastStormDay: { month: number; day: number } | null = null;
  // Day entries sit on the line(s) directly after the header, with no blank line before
  // whatever follows them (a live Watch runs straight into its supersede line), so the
  // scan stops at the first line carrying no entry rather than at a paragraph break.
  for (const line of message.slice(header.index + header[0].length).split('\n')) {
    const entries = [...line.matchAll(PREDICTED_DAY_ENTRY_RE)];
    if (entries.length === 0) break;
    for (const [, monthAbbr, dayRaw, level] of entries) {
      if (!(monthAbbr && dayRaw && level)) continue;
      const month = SWPC_MONTHS[monthAbbr.toLowerCase()];
      if (!month || level.toLowerCase() === NO_STORM_LEVEL) continue;
      lastStormDay = { month: Number(month), day: Number(dayRaw) };
    }
  }
  if (!lastStormDay) return null;

  const year =
    issued.getUTCMonth() + 1 === 12 && lastStormDay.month === 1
      ? issued.getUTCFullYear() + 1
      : issued.getUTCFullYear();
  // Date.UTC rolls a day past the month's length into the next month — and a December
  // 32nd into the next year — so the day-after arithmetic needs no calendar guard.
  const end = new Date(Date.UTC(year, lastStormDay.month - 1, lastStormDay.day + 1));
  // Match the label-parsed values, which carry no milliseconds.
  return end.toISOString().replace(/\.000Z$/, 'Z');
}

// ── Raw feed types ─────────────────────────────────────────────────────────

/**
 * One category entry of a `noaa-scales.json` period. Which fields are present varies
 * by category and period: the observed period carries `Scale`/`Text` with null
 * probabilities, a forecast period carries `Scale: null`/`Text: null` on R and S with
 * the probabilities populated, and a G entry carries no probability field at all.
 */
interface RawScaleEntry {
  MajorProb?: string | number | null;
  MinorProb?: string | number | null;
  Prob?: string | number | null;
  Scale: string | number | null;
  Text: string | null;
}

interface RawScalesPeriod {
  DateStamp: string;
  G: RawScaleEntry;
  R: RawScaleEntry;
  S: RawScaleEntry;
  TimeStamp: string;
}

interface RawKpObserved {
  a_running: number | string | null;
  Kp: number | string;
  station_count: number | string | null;
  time_tag: string;
}

interface RawKpForecast {
  kp: number | string;
  noaa_scale: string | null;
  observed: string;
  time_tag: string;
}

interface RawAuroraFeed {
  coordinates: [number, number, number][];
  'Data Format': string;
  'Forecast Time': string;
  'Observation Time': string;
}

/**
 * One record of the RTSW (Real-Time Solar Wind) plasma feed. The feed interleaves
 * every reporting spacecraft — only records with `active: true` come from the one
 * SWPC currently treats as authoritative. Numeric fields arrive as numbers.
 * Fields the tools don't map (alpha particles, GSE/GSM velocity vectors, per-sensor
 * quality flags) are omitted from this type.
 */
interface RawRtswWind {
  active: boolean;
  proton_density: number | null;
  proton_speed: number | null;
  proton_temperature: number | null;
  source: string;
  time_tag: string;
}

/**
 * One record of the RTSW magnetic field feed. Same interleaved-spacecraft shape as
 * {@link RawRtswWind}; `bt`/`b*_gsm` names already match the domain type.
 */
interface RawRtswMag {
  active: boolean;
  bt: number | null;
  bx_gsm: number | null;
  by_gsm: number | null;
  bz_gsm: number | null;
  source: string;
  time_tag: string;
}

interface RawXrayFlux {
  energy: string;
  flux: number;
  observed_flux: number;
  satellite: number;
  time_tag: string;
}

/**
 * One record of the GOES X-ray flare feed — one discrete flare event, published at
 * onset. All twelve keys are present on every record, so sparsity arrives as `null`
 * rather than an absent key. `max_ratio`, `max_ratio_time`, and `current_int_xrlong`
 * are carried by the feed but deliberately unmapped (see {@link XrayFlare}).
 */
interface RawXrayFlare {
  begin_class: string;
  begin_time: string;
  end_class: string | null;
  end_time: string | null;
  max_class: string;
  max_time: string;
  max_xrlong: number;
  satellite: number;
  time_tag: string;
}

/**
 * One record of the F10.7 cm radio flux feed. Three per UTC day; `avg_begin_date`,
 * `ninety_day_mean`, and `rec_count` are populated only on the Noon record.
 * `frequency` is 2800 on every record and is not mapped.
 */
interface RawF107 {
  flux: number;
  ninety_day_mean: number | null;
  reporting_schedule: string;
  time_tag: string;
}

interface RawSolarRegion {
  area: number | null;
  c_flare_probability: number | string;
  // latitude and longitude are returned as bare integers in the live feed
  // (e.g. 17, -5), not as heliographic strings like "N17", "S05".
  // Both can be null in tombstone entries for recently-exited regions.
  latitude: number | string | null;
  location: string | null;
  longitude: number | string | null;
  m_flare_probability: number | string;
  mag_class: string | null;
  number_spots: number | null;
  observed_date: string;
  proton_probability: number | string;
  region: number;
  spot_class: string | null;
  x_flare_probability: number | string;
}

interface RawSolarProbs {
  '10mev_protons_1_day': number | string;
  '10mev_protons_2_day'?: number | string;
  '10mev_protons_3_day'?: number | string;
  c_class_1_day: number | string;
  c_class_2_day?: number | string;
  c_class_3_day?: number | string;
  date: string;
  m_class_1_day: number | string;
  m_class_2_day?: number | string;
  m_class_3_day?: number | string;
  x_class_1_day: number | string;
  x_class_2_day?: number | string;
  x_class_3_day?: number | string;
}

interface RawProtonFlux {
  energy: string;
  flux: number;
  satellite: number;
  time_tag: string;
}

interface RawAlert {
  issue_datetime: string;
  message: string;
  product_id: string;
}

// ── SpaceWeatherService ─────────────────────────────────────────────────────

/** NOAA SWPC public feeds client. Initialized once; accessed via accessor. */
export class SpaceWeatherService {
  /**
   * SWPC User-Agent, built once from the injected server version so it tracks
   * package.json instead of a hardcoded release.
   */
  private readonly userAgent: string;

  // storage is accepted per the service contract but unused by this keyless,
  // stateless feed client; config supplies only the server version for the UA.
  constructor(config: AppConfig, _storage: StorageService) {
    this.userAgent = buildUserAgent(config.mcpServerVersion);
  }

  // ── NOAA Scales ────────────────────────────────────────────────────────

  /** Fetch current NOAA storm scales (today + 3-day forecast). */
  async getNoaaScales(ctx: Context): Promise<NoaaScalesData> {
    const path = '/products/noaa-scales.json';
    const raw = await fetchFeed<Record<string, RawScalesPeriod>>(path, ctx, this.userAgent);

    // Levels and probabilities both go through parseNum, so an absent or unparseable
    // value stays null instead of reading as level 0 or a 0% chance. SWPC names the
    // probability fields per category: R carries MinorProb (R1–R2) and MajorProb
    // (R3 or greater), S and G carry a single Prob.
    const normalizePeriod = (r: RawScalesPeriod): NoaaScalesPeriod => ({
      date: r.DateStamp ?? '',
      time: r.TimeStamp ?? '',
      // The feed splits the period stamp across two Z-less fields; joined they are the
      // space-separated shape normalizeSwpcTime() exists for, and every other
      // timestamp this service emits is explicit ISO 8601 UTC.
      observedAt:
        r.DateStamp && r.TimeStamp ? normalizeSwpcTime(`${r.DateStamp} ${r.TimeStamp}`) : '',
      G: {
        category: 'G',
        scale: parseNum(r.G?.Scale),
        text: r.G?.Text ?? null,
        minorProb: parseNum(r.G?.Prob),
        majorProb: null,
      },
      R: {
        category: 'R',
        scale: parseNum(r.R?.Scale),
        text: r.R?.Text ?? null,
        minorProb: parseNum(r.R?.MinorProb),
        majorProb: parseNum(r.R?.MajorProb),
      },
      S: {
        category: 'S',
        scale: parseNum(r.S?.Scale),
        text: r.S?.Text ?? null,
        minorProb: parseNum(r.S?.Prob),
        majorProb: null,
      },
    });

    const today = raw['0'];
    // The feed answered, but not with the shape it is documented to have — the same
    // class of break as a path that no longer resolves, and equally unfixable by a retry.
    if (!today)
      throw feedFailure('feed_moved', 'SWPC scales feed missing key "0" (today).', path, ctx, {
        available: Object.keys(raw),
      });

    return {
      today: normalizePeriod(today),
      forecast: (['1', '2', '3'] as const)
        .map((k) => raw[k])
        .filter((p): p is RawScalesPeriod => p != null)
        .map((p) => normalizePeriod(p)),
    };
  }

  // ── Forecast Discussion ─────────────────────────────────────────────────

  /**
   * Fetch the SWPC Forecast Discussion — the forecaster-written narrative explaining
   * what is driving the storm scales, split into its topic sections.
   */
  async getForecastDiscussion(ctx: Context): Promise<ForecastDiscussion> {
    const path = '/text/discussion.txt';
    const text = await fetchText(path, ctx, this.userAgent);

    const discussion = parseForecastDiscussion(text);
    // The product answered, but not with the shape it is documented to have — the same
    // class of break as the scales feed losing its "0" key, and equally unfixable by a
    // retry. Raised out here rather than inside fetchText so it costs one attempt.
    if (!discussion)
      throw feedFailure(
        'feed_moved',
        'SWPC forecast discussion carried no topic section.',
        path,
        ctx,
        { bytes: text.length },
      );

    return discussion;
  }

  // ── Kp Index ────────────────────────────────────────────────────────────

  /** Fetch observed Kp index history. */
  async getKpObserved(ctx: Context): Promise<KpObservation[]> {
    const raw = await fetchFeed<RawKpObserved[]>(
      '/products/noaa-planetary-k-index.json',
      ctx,
      this.userAgent,
    );
    return raw.map((r) => {
      const kp = parseNum(r.Kp) ?? 0;
      const gScale = kpToGScale(kp);
      return {
        timeTag: normalizeSwpcTime(r.time_tag),
        kp,
        gScale,
        auroraLatitude: gScaleToAuroraLatitude(gScale),
        aRunning: parseNum(r.a_running),
        stationCount: parseNum(r.station_count),
      };
    });
  }

  /** Fetch Kp 3-day forecast. */
  async getKpForecast(ctx: Context): Promise<KpForecast[]> {
    const raw = await fetchFeed<RawKpForecast[]>(
      '/products/noaa-planetary-k-index-forecast.json',
      ctx,
      this.userAgent,
    );
    return raw.map((r) => ({
      timeTag: normalizeSwpcTime(r.time_tag),
      kp: parseNum(r.kp) ?? 0,
      observed: r.observed,
      noaaScale: r.noaa_scale ?? null,
    }));
  }

  // ── OVATION Aurora ──────────────────────────────────────────────────────

  /** Fetch the latest OVATION aurora forecast grid. */
  async getAuroraForecast(ctx: Context): Promise<AuroraForecastData> {
    const raw = await fetchFeed<RawAuroraFeed>(
      '/json/ovation_aurora_latest.json',
      ctx,
      this.userAgent,
    );
    return {
      meta: {
        observationTime: raw['Observation Time'] ?? '',
        forecastTime: raw['Forecast Time'] ?? '',
      },
      grid: (raw.coordinates ?? []).map(([lon, lat, aurora]) => ({
        // OVATION grid uses 0–360 longitude. Normalize so user coordinates (WGS84
        // standard −180..180) map to the same range for nearest-grid-point search.
        // The result runs −179..180: the 180 column stays put and there is no −180
        // column, so the search has to compare longitudes with an antimeridian wrap
        // rather than a raw difference.
        longitude: lon > 180 ? lon - 360 : lon,
        latitude: lat,
        auroraPercent: aurora,
      })),
    };
  }

  // ── Solar Wind ──────────────────────────────────────────────────────────

  /**
   * Fetch solar wind plasma from the RTSW feed (roughly the last 24 hours at
   * 1-minute cadence). Keeps only the spacecraft SWPC flags active — the feed
   * interleaves every reporting spacecraft, and `overall_quality` is uniformly 0,
   * so `active` is the only discriminating signal.
   */
  async getSolarWindPlasma(ctx: Context): Promise<SolarWindPlasma[]> {
    const raw = await fetchFeed<RawRtswWind[]>('/json/rtsw/rtsw_wind_1m.json', ctx, this.userAgent);
    return raw
      .filter((r) => r.active)
      .map((r) => ({
        timeTag: normalizeSwpcTime(r.time_tag),
        source: r.source,
        densityPerCm3: parseNum(r.proton_density),
        speedKmS: parseNum(r.proton_speed),
        temperatureK: parseNum(r.proton_temperature),
      }))
      .sort(byIsoAscending('timeTag'));
  }

  /**
   * Fetch solar wind magnetic field from the RTSW feed (roughly the last 24 hours
   * at 1-minute cadence). Filtered to the active spacecraft like
   * {@link SpaceWeatherService.getSolarWindPlasma}.
   */
  async getSolarWindMag(ctx: Context): Promise<SolarWindMag[]> {
    const raw = await fetchFeed<RawRtswMag[]>('/json/rtsw/rtsw_mag_1m.json', ctx, this.userAgent);
    return raw
      .filter((r) => r.active)
      .map((r) => ({
        timeTag: normalizeSwpcTime(r.time_tag),
        source: r.source,
        bxGsm: parseNum(r.bx_gsm),
        byGsm: parseNum(r.by_gsm),
        bzGsm: parseNum(r.bz_gsm),
        bt: parseNum(r.bt),
      }))
      .sort(byIsoAscending('timeTag'));
  }

  // ── Solar Activity ──────────────────────────────────────────────────────

  /**
   * Fetch GOES X-ray flux (6-hour, long-channel 0.1-0.8nm only).
   *
   * The 6-hour feed's records are byte-identical to the newest 710 of the 7-day
   * feed — same seven keys, same two energy channels, same 1-minute cadence, same
   * newest time tag — so the past-hour slice its only caller takes is the same 61
   * records either way, for ~4.36 MB less per call.
   */
  async getXrayFlux(ctx: Context): Promise<XrayFlux[]> {
    const raw = await fetchFeed<RawXrayFlux[]>(
      '/json/goes/primary/xrays-6-hour.json',
      ctx,
      this.userAgent,
    );
    return raw
      .filter((r) => r.energy === '0.1-0.8nm')
      .map((r) => ({
        timeTag: r.time_tag,
        satellite: r.satellite,
        fluxWm2: r.flux,
        energy: r.energy,
      }));
  }

  /**
   * Fetch discrete GOES X-ray flare events (rolling 7 days), oldest-first.
   *
   * Classes are read as published, not derived from the flux. Ordering is
   * normalized here rather than depending on upstream's, the same as the solar-wind
   * series: it makes oldest-first an invariant of the domain type instead of an
   * accident of the feed.
   */
  async getXrayFlares(ctx: Context): Promise<XrayFlare[]> {
    const raw = await fetchFeed<RawXrayFlare[]>(
      '/json/goes/primary/xray-flares-7-day.json',
      ctx,
      this.userAgent,
    );
    return raw
      .map((r) => ({
        beginTime: normalizeSwpcTime(r.begin_time),
        maxTime: normalizeSwpcTime(r.max_time),
        endTime: r.end_time == null ? null : normalizeSwpcTime(r.end_time),
        beginClass: r.begin_class,
        maxClass: r.max_class,
        endClass: r.end_class ?? null,
        peakFluxWm2: r.max_xrlong,
        satellite: r.satellite,
      }))
      .sort(byIsoAscending('beginTime'));
  }

  /**
   * Fetch the latest daily F10.7 solar radio flux report, or null when the feed
   * carries no Noon record.
   *
   * The newest record is not the answer: the feed serves three reports per UTC day
   * and its index 0 is often that day's Afternoon report, while SWPC's own one-value
   * summary product reports the Noon one — which is also the only schedule carrying
   * `ninety_day_mean`. Selection is by time among the Noon records, so it does not
   * depend on the order upstream serves.
   */
  async getF107(ctx: Context): Promise<F107Observation | null> {
    const raw = await fetchFeed<RawF107[]>('/json/f107_cm_flux.json', ctx, this.userAgent);
    const noonReports = raw
      .filter((r) => r.reporting_schedule === 'Noon')
      .map((r) => ({
        observedTime: normalizeSwpcTime(r.time_tag),
        fluxSfu: r.flux,
        ninetyDayMeanSfu: parseNum(r.ninety_day_mean),
        reportingSchedule: r.reporting_schedule,
      }))
      .sort(byIsoAscending('observedTime'));
    // Sorted oldest-first, so the last element is the latest Noon report. Ordered by
    // time rather than read off a position: the feed serves newest-first today, and
    // its index 0 is usually that day's Morning or Afternoon report.
    return noonReports.at(-1) ?? null;
  }

  /** Fetch active solar regions (most recent observed date only). */
  async getSolarRegions(ctx: Context): Promise<SolarRegion[]> {
    const raw = await fetchFeed<RawSolarRegion[]>('/json/solar_regions.json', ctx, this.userAgent);
    // The feed contains ~30 days of region history in reverse-chrono order.
    // Filter to the most recent observed_date to return only currently active regions.
    const mostRecentDate = raw.length > 0 ? raw[0]?.observed_date : null;
    return raw
      .filter(
        // most recent date only, skip tombstones
        (r): r is RawSolarRegion & { location: string } =>
          r.location != null && r.observed_date === mostRecentDate,
      )
      .map((r) => {
        // latitude is a bare integer in the live feed (e.g. 17, -5).
        // Normalize to heliographic string ("N17", "S05") to match the declared output type.
        const latNum = typeof r.latitude === 'number' ? r.latitude : parseFloat(String(r.latitude));
        const latStr = Number.isFinite(latNum)
          ? `${latNum >= 0 ? 'N' : 'S'}${String(Math.abs(latNum)).padStart(2, '0')}`
          : String(r.latitude ?? '');
        return {
          observedDate: r.observed_date,
          region: r.region,
          latitude: latStr,
          location: r.location,
          spotClass: r.spot_class ?? '',
          numberSpots: r.number_spots ?? 0,
          magClass: r.mag_class ?? '',
          cFlareProbability: parseNum(r.c_flare_probability) ?? 0,
          mFlareProbability: parseNum(r.m_flare_probability) ?? 0,
          xFlareProbability: parseNum(r.x_flare_probability) ?? 0,
          protonProbability: parseNum(r.proton_probability) ?? 0,
        };
      });
  }

  /** Fetch solar flare probabilities (3-day forward outlook from the latest issued entry). */
  async getSolarProbabilities(ctx: Context): Promise<SolarProbabilities[]> {
    const raw = await fetchFeed<RawSolarProbs[]>(
      '/json/solar_probabilities.json',
      ctx,
      this.userAgent,
    );
    // The feed is a 30-entry reverse-chrono archive of daily forecasts.
    // Each entry embeds a 3-day outlook via _1_day / _2_day / _3_day columns.
    // Take only the most recent entry (index 0) and expand its 3-day outlook
    // into three records, advancing the date by 0, 1, and 2 days respectively.
    const latest = raw[0];
    if (!latest) return [];
    // Normalize to UTC: the date field is "2026-06-04T00:00:00" without a 'Z',
    // so new Date() would interpret it as local time. Append 'Z' to force UTC.
    const rawDate = latest.date.endsWith('Z') ? latest.date : `${latest.date}Z`;
    // Advance the epoch by whole UTC days. `setDate`/`getDate` read the process
    // timezone's calendar, so a window crossing a DST transition there shifts the
    // emitted instant by the offset change — duplicating one forecast day at a
    // spring-forward and dropping every date off midnight UTC at a fall-back.
    const baseMs = new Date(rawDate).getTime();
    return [0, 1, 2].map((dayOffset) => {
      const date = new Date(baseMs + dayOffset * 86_400_000);
      const suffix = dayOffset === 0 ? '1_day' : dayOffset === 1 ? '2_day' : '3_day';
      // Parse each probability once, then expose it under both the legacy
      // date-specific name and the date-neutral alias (#16) so the two never drift.
      const cClass = parseNum(latest[`c_class_${suffix}` as keyof RawSolarProbs] as string) ?? 0;
      const mClass = parseNum(latest[`m_class_${suffix}` as keyof RawSolarProbs] as string) ?? 0;
      const xClass = parseNum(latest[`x_class_${suffix}` as keyof RawSolarProbs] as string) ?? 0;
      const protons =
        parseNum(latest[`10mev_protons_${suffix}` as keyof RawSolarProbs] as string) ?? 0;
      return {
        date: date.toISOString(),
        cClass1Day: cClass,
        cClassProbability: cClass,
        mClass1Day: mClass,
        mClassProbability: mClass,
        xClass1Day: xClass,
        xClassProbability: xClass,
        protons1Day: protons,
        protonEventProbability: protons,
      };
    });
  }

  /** Fetch GOES integral proton flux (3-day, ≥10 MeV channel). */
  async getProtonFlux(ctx: Context): Promise<ProtonFlux[]> {
    const raw = await fetchFeed<RawProtonFlux[]>(
      '/json/goes/primary/integral-protons-plot-3-day.json',
      ctx,
      this.userAgent,
    );
    return raw
      .filter((r) => r.energy === '>=10 MeV')
      .map((r) => ({
        timeTag: r.time_tag,
        satellite: r.satellite,
        fluxPfu: r.flux,
        energy: r.energy,
      }));
  }

  // ── Alerts ──────────────────────────────────────────────────────────────

  /** Fetch SWPC alerts, watches, and warnings. */
  async getAlerts(ctx: Context): Promise<SpaceWeatherAlert[]> {
    const raw = await fetchFeed<RawAlert[]>('/products/alerts.json', ctx, this.userAgent);
    return raw.map((r) => {
      const id = r.product_id ?? '';
      // Normalize line endings once: every parse below reads this text, and it is the
      // body callers receive.
      const message = (r.message ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
      // The product_id field in the feed is a 4-char abbreviated code (e.g. "K04W").
      // The full message code (e.g. "WARK04") lives in the message body as:
      //   "Space Weather Message Code: WARK04"
      // Use the full message code for type/phenomenon/level parsing; it carries
      // the WAR/WAT/ALT/SUM prefix the parser needs.
      const msgCodeMatch = message.match(/Space\s+Weather\s+Message\s+Code:\s*(\S+)/i);
      const msgCode = msgCodeMatch?.[1] ?? id;
      // The body's NOAA scale drives both level and phenomenon — the message code's
      // suffix and prefix shape misreport both for most live products.
      const noaaScale = parseNoaaScale(message);
      // Normalize SWPC's space-separated datetime ("2026-06-06 22:11:17") to ISO 8601 so
      // downstream Date comparisons work correctly (the SpaceWeatherAlert.issueDatetime
      // contract says ISO 8601; raw feed values break string comparisons with ISO cutoffs).
      // The predicted-day derivation below also reads it, for the year its days omit.
      const issueDatetime = normalizeSwpcTime(r.issue_datetime ?? '');
      return {
        productId: id,
        messageCode: msgCode,
        productType: parseProductType(msgCode),
        level: parseLevel(msgCode, noaaScale),
        noaaScale,
        cancelled: CANCEL_RE.test(message),
        serialNumber: message.match(SERIAL_RE)?.[1] ?? null,
        cancelsSerialNumber: message.match(CANCEL_SERIAL_RE)?.[1] ?? null,
        cancelsOriginalIssueDatetime: parseValidity(message, ORIGINAL_ISSUE_TIME_RE),
        supersedes: SUPERSEDES_RE.test(message),
        issueDatetime,
        message,
        phenomenon: parsePhenomenon(msgCode, noaaScale),
        // Validity window parsed from the message body, normalized to ISO 8601.
        // SWPC labels it differently per product: Warnings/Watches use "Valid
        // From/To", extended Warnings restate the expiry as "Now Valid Until",
        // and Alerts/Summaries use "Begin/End Time". Products with no such line
        // keep null.
        validFrom: parseValidity(message, /(?:Valid\s+From|Begin\s+Time):\s*([^\r\n]+)/i),
        // A Watch carries no end label at all, so fall back to the end its per-day
        // storm outlook implies. A stated label always wins over the derivation.
        validTo:
          parseValidity(message, /(?:Valid\s+To|Now\s+Valid\s+Until|End\s+Time):\s*([^\r\n]+)/i) ??
          parsePredictedDayEnd(message, issueDatetime),
      };
    });
  }
}

// ── Init / accessor ─────────────────────────────────────────────────────────

let _service: SpaceWeatherService | undefined;

/** Initialize the SpaceWeatherService singleton. Call once in setup(). */
export function initSpaceWeatherService(config: AppConfig, storage: StorageService): void {
  _service = new SpaceWeatherService(config, storage);
}

/** Access the initialized SpaceWeatherService singleton. */
export function getSpaceWeatherService(): SpaceWeatherService {
  if (!_service)
    throw new Error(
      'SpaceWeatherService not initialized — call initSpaceWeatherService() in setup()',
    );
  return _service;
}
