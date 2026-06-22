/**
 * @fileoverview NOAA Space Weather Prediction Center (SWPC) feed client.
 * Wraps keyless public JSON feeds from services.swpc.noaa.gov, normalizes the
 * diverse feed shapes (array-of-arrays, array-of-objects, keyed objects) into
 * clean typed domain records, and exposes per-feed methods used by all tools.
 * @module services/space-weather/space-weather-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, type RequestContext, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type {
  AuroraForecastData,
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
  XrayFlux,
} from './types.js';

// ── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://services.swpc.noaa.gov';
const USER_AGENT =
  'noaa-spaceweather-mcp-server/0.1.1 (github.com/cyanheads/noaa-spaceweather-mcp-server)';
const FETCH_TIMEOUT_MS = 15_000;

/** Missing/fill value used in many SWPC feeds for sensor failures. */
const FILL_VALUE = -9999;

// ── NOAA scale helpers ──────────────────────────────────────────────────────

/** Maps Kp value (0–9) to NOAA G-scale level (0–5). Shared with get-kp-index tool. */
export function kpToGScale(kp: number): number {
  if (kp >= 9) return 5;
  if (kp >= 8) return 4;
  if (kp >= 7) return 3;
  if (kp >= 6) return 2;
  if (kp >= 5) return 1;
  return 0;
}

/** Returns aurora visibility latitude guidance for a G-scale level. */
function gScaleToAuroraLatitude(gScale: number): string {
  switch (gScale) {
    case 5:
      return 'Aurora possible to ~40° geomagnetic latitude';
    case 4:
      return 'Aurora possible to ~45° geomagnetic latitude';
    case 3:
      return 'Aurora possible to ~50° geomagnetic latitude';
    case 2:
      return 'Aurora possible to ~55° geomagnetic latitude';
    case 1:
      return 'Aurora possible to ~60° geomagnetic latitude';
    default:
      return 'No significant aurora expected at mid-latitudes';
  }
}

// ── Shared fetch helper ─────────────────────────────────────────────────────

async function fetchFeed<T>(path: string, ctx: Context): Promise<T> {
  // Cast ctx to RequestContext for framework utils — Context is structurally
  // compatible but lacks the index signature the type expects.
  const reqCtx = ctx as unknown as RequestContext;
  return withRetry(
    async () => {
      const url = `${BASE_URL}${path}`;
      const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS, reqCtx, {
        signal: ctx.signal,
        headers: { 'User-Agent': USER_AGENT },
      });
      const text = await response.text();
      if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
        throw serviceUnavailable(
          `SWPC feed returned HTML instead of JSON — likely rate-limited or unavailable.`,
          { path },
        );
      }
      try {
        return JSON.parse(text) as T;
      } catch (err) {
        throw serviceUnavailable(
          `Failed to parse SWPC feed JSON from ${path}.`,
          { path },
          { cause: err },
        );
      }
    },
    {
      operation: `fetchFeed:${path}`,
      context: reqCtx,
      baseDelayMs: 1000,
      signal: ctx.signal,
    },
  );
}

// ── Normalization helpers ───────────────────────────────────────────────────

/**
 * Normalize a null/string/number scale value to a number.
 * SWPC returns null for unavailable forecasts — treat as 0 (no storm).
 */
function coerceScale(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Parse numeric string, returning null if the value is the fill value or NaN. */
function parseNum(s: string | number | null | undefined): number | null {
  if (s == null) return null;
  const n = typeof s === 'string' ? parseFloat(s) : s;
  if (!Number.isFinite(n) || n === FILL_VALUE) return null;
  return n;
}

/**
 * Normalize a SWPC time tag string to ISO 8601 UTC.
 * SWPC solar-wind feeds use "YYYY-MM-DD HH:MM:SS.mmm" (space-separated, no 'Z').
 * Without normalization, `new Date(tag)` interprets the string as local time
 * rather than UTC, corrupting all time-based filtering.
 */
function normalizeSwpcTime(tag: string): string {
  // Replace the space between date and time with 'T' and append 'Z' if absent.
  if (typeof tag !== 'string' || tag.includes('T')) return tag;
  const normalized = tag.replace(' ', 'T');
  return normalized.endsWith('Z') ? normalized : `${normalized}Z`;
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
  const month = SWPC_MONTHS[m[2]!.toLowerCase()];
  if (!month) return null;
  const day = m[3]!.padStart(2, '0');
  const hhmm = m[4]!;
  return `${m[1]}-${month}-${day}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00Z`;
}

/**
 * Normalize array-of-arrays feed (plasma, mag) with a header row.
 * data[0] is string[] field names; data[1..n] are string[] value rows.
 */
function normalizeArrayOfArrays(raw: string[][]): Record<string, string>[] {
  if (raw.length < 2 || !Array.isArray(raw[0])) return [];
  const headers = raw[0];
  return raw.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] ?? '';
    });
    return obj;
  });
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

/** Extract phenomenon name from product code. */
function parsePhenomenon(id: string): string {
  const upper = id.toUpperCase();
  // After the 3-char type prefix, look at the next character(s)
  const core = upper.slice(3);
  if (core.startsWith('G') || core.startsWith('K')) return 'Geomagnetic';
  if (core.startsWith('R') || core.startsWith('X')) return 'Radio Blackout';
  if (core.startsWith('S')) return 'Solar Radiation';
  if (core.startsWith('A')) return 'Aurora';
  return 'Space Weather';
}

/** Parse numeric level from product code suffix. */
function parseLevel(id: string): number {
  const match = id.match(/(\d+)\w*$/);
  if (!match) return 0;
  return parseInt(match[1]!, 10);
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

// ── Raw feed types ─────────────────────────────────────────────────────────

interface RawScaleEntry {
  MajorProb?: string | number | null;
  MinorProb: string | number | null;
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

interface RawXrayFlux {
  energy: string;
  flux: number;
  observed_flux: number;
  satellite: number;
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
  // config and storage are accepted per the service contract but not used by this
  // keyless, stateless feed client.
  constructor(_config: AppConfig, _storage: StorageService) {}

  // ── NOAA Scales ────────────────────────────────────────────────────────

  /** Fetch current NOAA storm scales (today + 3-day forecast). */
  async getNoaaScales(ctx: Context): Promise<NoaaScalesData> {
    const raw = await fetchFeed<Record<string, RawScalesPeriod>>('/products/noaa-scales.json', ctx);

    const normalizePeriod = (r: RawScalesPeriod): NoaaScalesPeriod => ({
      date: r.DateStamp ?? '',
      time: r.TimeStamp ?? '',
      G: {
        category: 'G',
        scale: coerceScale(r.G?.Scale),
        text: r.G?.Text ?? '',
        minorProb: r.G?.Prob != null ? coerceScale(r.G.Prob) : null,
        majorProb: null,
      },
      R: {
        category: 'R',
        scale: coerceScale(r.R?.Scale),
        text: r.R?.Text ?? '',
        minorProb: r.R?.MinorProb != null ? coerceScale(r.R.MinorProb) : null,
        majorProb: r.R?.MajorProb != null ? coerceScale(r.R.MajorProb) : null,
      },
      S: {
        category: 'S',
        scale: coerceScale(r.S?.Scale),
        text: r.S?.Text ?? '',
        minorProb: r.S?.Prob != null ? coerceScale(r.S.Prob) : null,
        majorProb: null,
      },
    });

    const today = raw['0'];
    if (!today)
      throw serviceUnavailable('SWPC scales feed missing key "0" (today).', {
        available: Object.keys(raw),
      });

    return {
      today: normalizePeriod(today),
      forecast: (['1', '2', '3'] as const)
        .filter((k) => raw[k] != null)
        .map((k) => normalizePeriod(raw[k]!)),
    };
  }

  // ── Kp Index ────────────────────────────────────────────────────────────

  /** Fetch observed Kp index history. */
  async getKpObserved(ctx: Context): Promise<KpObservation[]> {
    const raw = await fetchFeed<RawKpObserved[]>('/products/noaa-planetary-k-index.json', ctx);
    return raw.map((r) => {
      const kp = parseNum(r.Kp) ?? 0;
      const gScale = kpToGScale(kp);
      return {
        timeTag: r.time_tag,
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
    );
    return raw.map((r) => ({
      timeTag: r.time_tag,
      kp: parseNum(r.kp) ?? 0,
      observed: r.observed,
      noaaScale: r.noaa_scale ?? null,
    }));
  }

  // ── OVATION Aurora ──────────────────────────────────────────────────────

  /** Fetch the latest OVATION aurora forecast grid. */
  async getAuroraForecast(ctx: Context): Promise<AuroraForecastData> {
    const raw = await fetchFeed<RawAuroraFeed>('/json/ovation_aurora_latest.json', ctx);
    return {
      meta: {
        observationTime: raw['Observation Time'] ?? '',
        forecastTime: raw['Forecast Time'] ?? '',
      },
      grid: (raw.coordinates ?? []).map(([lon, lat, aurora]) => ({
        // OVATION grid uses 0–360 longitude. Normalize to −180..179 so user
        // coordinates (WGS84 standard −180..180) map to the same range for
        // nearest-grid-point search.
        longitude: lon > 180 ? lon - 360 : lon,
        latitude: lat,
        auroraPercent: aurora,
      })),
    };
  }

  // ── Solar Wind ──────────────────────────────────────────────────────────

  /** Fetch solar wind plasma (7-day, array-of-arrays format). */
  async getSolarWindPlasma(ctx: Context): Promise<SolarWindPlasma[]> {
    const raw = await fetchFeed<string[][]>('/products/solar-wind/plasma-7-day.json', ctx);
    const rows = normalizeArrayOfArrays(raw);
    return rows.map((r) => ({
      timeTag: normalizeSwpcTime(r['time_tag'] ?? ''),
      densityPerCm3: parseNum(r['density']),
      speedKmS: parseNum(r['speed']),
      temperatureK: parseNum(r['temperature']),
    }));
  }

  /** Fetch solar wind magnetic field (7-day, array-of-arrays format). */
  async getSolarWindMag(ctx: Context): Promise<SolarWindMag[]> {
    const raw = await fetchFeed<string[][]>('/products/solar-wind/mag-7-day.json', ctx);
    const rows = normalizeArrayOfArrays(raw);
    return rows.map((r) => ({
      timeTag: normalizeSwpcTime(r['time_tag'] ?? ''),
      bxGsm: parseNum(r['bx_gsm']),
      byGsm: parseNum(r['by_gsm']),
      bzGsm: parseNum(r['bz_gsm']),
      bt: parseNum(r['bt']),
    }));
  }

  // ── Solar Activity ──────────────────────────────────────────────────────

  /** Fetch GOES X-ray flux (7-day, long-channel 0.1-0.8nm only). */
  async getXrayFlux(ctx: Context): Promise<XrayFlux[]> {
    const raw = await fetchFeed<RawXrayFlux[]>('/json/goes/primary/xrays-7-day.json', ctx);
    return raw
      .filter((r) => r.energy === '0.1-0.8nm')
      .map((r) => ({
        timeTag: r.time_tag,
        satellite: r.satellite,
        fluxWm2: r.flux,
        energy: r.energy,
      }));
  }

  /** Fetch active solar regions (most recent observed date only). */
  async getSolarRegions(ctx: Context): Promise<SolarRegion[]> {
    const raw = await fetchFeed<RawSolarRegion[]>('/json/solar_regions.json', ctx);
    // The feed contains ~30 days of region history in reverse-chrono order.
    // Filter to the most recent observed_date to return only currently active regions.
    const mostRecentDate = raw.length > 0 ? raw[0]?.observed_date : null;
    return raw
      .filter((r) => r.location != null && r.observed_date === mostRecentDate) // most recent date only, skip tombstones
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
          location: r.location!,
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
    const raw = await fetchFeed<RawSolarProbs[]>('/json/solar_probabilities.json', ctx);
    // The feed is a 30-entry reverse-chrono archive of daily forecasts.
    // Each entry embeds a 3-day outlook via _1_day / _2_day / _3_day columns.
    // Take only the most recent entry (index 0) and expand its 3-day outlook
    // into three records, advancing the date by 0, 1, and 2 days respectively.
    if (raw.length === 0) return [];
    const latest = raw[0]!;
    // Normalize to UTC: the date field is "2026-06-04T00:00:00" without a 'Z',
    // so new Date() would interpret it as local time. Append 'Z' to force UTC.
    const rawDate = latest.date.endsWith('Z') ? latest.date : `${latest.date}Z`;
    const baseDate = new Date(rawDate);
    return [0, 1, 2].map((dayOffset) => {
      const d = new Date(baseDate);
      d.setDate(d.getDate() + dayOffset);
      const suffix = dayOffset === 0 ? '1_day' : dayOffset === 1 ? '2_day' : '3_day';
      return {
        date: d.toISOString(),
        cClass1Day: parseNum(latest[`c_class_${suffix}` as keyof RawSolarProbs] as string) ?? 0,
        mClass1Day: parseNum(latest[`m_class_${suffix}` as keyof RawSolarProbs] as string) ?? 0,
        xClass1Day: parseNum(latest[`x_class_${suffix}` as keyof RawSolarProbs] as string) ?? 0,
        protons1Day:
          parseNum(latest[`10mev_protons_${suffix}` as keyof RawSolarProbs] as string) ?? 0,
      };
    });
  }

  /** Fetch GOES integral proton flux (3-day, ≥10 MeV channel). */
  async getProtonFlux(ctx: Context): Promise<ProtonFlux[]> {
    const raw = await fetchFeed<RawProtonFlux[]>(
      '/json/goes/primary/integral-protons-plot-3-day.json',
      ctx,
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
    const raw = await fetchFeed<RawAlert[]>('/products/alerts.json', ctx);
    return raw.map((r) => {
      const id = r.product_id ?? '';
      const message = r.message ?? '';
      // The product_id field in the feed is a 4-char abbreviated code (e.g. "K04W").
      // The full message code (e.g. "WARK04") lives in the message body as:
      //   "Space Weather Message Code: WARK04"
      // Use the full message code for type/phenomenon/level parsing; it carries
      // the WAR/WAT/ALT/SUM prefix the parser needs.
      const msgCodeMatch = message.match(/Space\s+Weather\s+Message\s+Code:\s*(\S+)/i);
      const msgCode = msgCodeMatch?.[1] ?? id;
      return {
        productId: id,
        productType: parseProductType(msgCode),
        level: parseLevel(msgCode),
        // Normalize SWPC's space-separated datetime ("2026-06-06 22:11:17") to ISO 8601 so
        // downstream Date comparisons work correctly (the SpaceWeatherAlert.issueDatetime
        // contract says ISO 8601; raw feed values break string comparisons with ISO cutoffs).
        issueDatetime: normalizeSwpcTime(r.issue_datetime ?? ''),
        message: message.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim(),
        phenomenon: parsePhenomenon(msgCode),
        // Validity window parsed from the message body, normalized to ISO 8601.
        // SWPC labels it differently per product: Warnings/Watches use "Valid
        // From/To", extended Warnings restate the expiry as "Now Valid Until",
        // and Alerts/Summaries use "Begin/End Time". Products with no such line
        // keep null.
        validFrom: parseValidity(message, /(?:Valid\s+From|Begin\s+Time):\s*([^\r\n]+)/i),
        validTo: parseValidity(
          message,
          /(?:Valid\s+To|Now\s+Valid\s+Until|End\s+Time):\s*([^\r\n]+)/i,
        ),
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
