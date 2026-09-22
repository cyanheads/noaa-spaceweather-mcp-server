/**
 * @fileoverview Tool: noaa_spaceweather_get_solar_wind — real-time L1 solar wind data
 * from the spacecraft SWPC currently flags as active in its RTSW feeds.
 * @module mcp-server/tools/definitions/get-solar-wind
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';
import type { SolarWindMag, SolarWindPlasma } from '@/services/space-weather/types.js';

/**
 * Records each series is bounded to at the default `reduced` resolution. Pinned at
 * 200 so a default 3-hour call — roughly 170 records per series at the feed's
 * 1-minute cadence — stays inside the bound and is returned untouched.
 */
const REDUCED_SERIES_MAX = 200;

/**
 * Bound a series to {@link REDUCED_SERIES_MAX} records by bucketing it by record
 * count and emitting the one record `pick` selects from each bucket — a real
 * upstream measurement, never a synthesized average, so an excursion shorter than
 * a bucket survives instead of being stepped over by a stride.
 *
 * The newest record rides the tail unbucketed: `series.at(-1)` is what the
 * matching `latest*` field reports, and a caller reading the tail for "current"
 * would otherwise get a stale value. A series already inside the bound is
 * returned as-is with a bucket size of one record.
 */
function reduceSeries<T>(
  records: readonly T[],
  pick: (bucket: readonly T[]) => T,
): { emitted: readonly T[]; bucketRecords: number } {
  if (records.length <= REDUCED_SERIES_MAX) return { emitted: records, bucketRecords: 1 };

  const older = records.slice(0, -1);
  const bucketRecords = Math.ceil(older.length / (REDUCED_SERIES_MAX - 1));
  const emitted: T[] = [];
  for (let i = 0; i < older.length; i += bucketRecords) {
    emitted.push(pick(older.slice(i, i + bucketRecords)));
  }
  emitted.push(...records.slice(-1));
  return { emitted, bucketRecords };
}

/**
 * The bucket's most southward Bz — the storm-relevant extreme. A bucket whose
 * every reading is null keeps its oldest record, so the emitted series stays a
 * sequence of real measurements rather than dropping the interval.
 */
const mostSouthwardBz = (bucket: readonly SolarWindMag[]): SolarWindMag =>
  bucket.reduce((best, record) =>
    record.bzGsm !== null && (best.bzGsm === null || record.bzGsm < best.bzGsm) ? record : best,
  );

/** The bucket's fastest solar wind speed — the plasma counterpart of {@link mostSouthwardBz}. */
const fastestSpeed = (bucket: readonly SolarWindPlasma[]): SolarWindPlasma =>
  bucket.reduce((best, record) =>
    record.speedKmS !== null && (best.speedKmS === null || record.speedKmS > best.speedKmS)
      ? record
      : best,
  );

const PlasmaSchema = z
  .object({
    timeTag: z.string().describe('ISO 8601 measurement time tag.'),
    source: z
      .string()
      .describe('Spacecraft that reported this measurement, as named by the feed, e.g. "SOLAR1".'),
    densityPerCm3: z
      .number()
      .nullable()
      .describe('Proton density in particles/cm³. Null when the feed omits the value.'),
    speedKmS: z
      .number()
      .nullable()
      .describe('Solar wind speed in km/s. Null when the feed omits the value.'),
    temperatureK: z
      .number()
      .nullable()
      .describe('Proton temperature in Kelvin. Null when the feed omits the value.'),
  })
  .describe('One plasma measurement from the active L1 spacecraft.');

const MagSchema = z
  .object({
    timeTag: z.string().describe('ISO 8601 measurement time tag.'),
    source: z
      .string()
      .describe('Spacecraft that reported this measurement, as named by the feed, e.g. "SOLAR1".'),
    bxGsm: z
      .number()
      .nullable()
      .describe('Bx component in GSM coordinates (nT). Null when the feed omits the value.'),
    byGsm: z
      .number()
      .nullable()
      .describe('By component in GSM coordinates (nT). Null when the feed omits the value.'),
    bzGsm: z
      .number()
      .nullable()
      .describe(
        'Bz component in GSM coordinates (nT). Southward (negative) drives geomagnetic storms. Null when the feed omits the value.',
      ),
    bt: z
      .number()
      .nullable()
      .describe('Total field magnitude Bt (nT). Null when the feed omits the value.'),
  })
  .describe('One magnetic field measurement from the active L1 spacecraft.');

export const getSolarWind = tool('noaa_spaceweather_get_solar_wind', {
  title: 'Get Solar Wind',
  description:
    'Real-time solar wind measurements from the active spacecraft at L1: proton speed (km/s), ' +
    'density (n/cm³), temperature (K), and the critical Bz component (southward Bz = negative = ' +
    'storm driver). Returns the recent plasma and magnetic field time series within the requested ' +
    'window, oldest first, each record tagged with the reporting spacecraft and bounded to 200 ' +
    'records per series unless resolution is set to "full" — or omitted entirely under "summary", ' +
    'which keeps the latest readings, Bz status, and window extremes (peak speed, density, and Bt; ' +
    'most southward Bz; minutes of southward Bz) for "what is Bz doing now" questions. ' +
    'Bz < −10 nT for sustained periods is a primary geomagnetic storm trigger — use alongside ' +
    'noaa_spaceweather_get_kp_index to see whether elevated solar wind has translated into a ' +
    'geomagnetic storm.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    window_hours: z
      .number()
      .int()
      .min(1)
      .max(168)
      .default(3)
      .describe(
        'Hours of recent solar wind history to return (1–168, default 3). Records update ~every 1 ' +
          'min, but the feed only carries roughly the last 24 hours — a larger window returns the ' +
          'whole feed, not more history, and at the default resolution the returned series stay ' +
          'bounded to 200 records each rather than growing with the window. When a window comes ' +
          'back empty, feedStalenessHours and latestFeedPlasmaTime/latestFeedMagTime report how ' +
          'current the feed actually is.',
      ),
    resolution: z
      .enum(['summary', 'reduced', 'full'])
      .default('reduced')
      .describe(
        'Detail level of the returned plasma and mag series. "summary" returns both series ' +
          'empty and keeps every headline field — about 2 KB whatever the window. "reduced" ' +
          '(default) bounds each series to at most 200 records: the window is bucketed by ' +
          "record count and one real measurement is emitted per bucket — the bucket's fastest " +
          'speed for plasma, its most southward Bz for mag — with the newest record in the ' +
          'window always last. A series already inside the bound is returned untouched, so a ' +
          'default 3-hour call is unaffected. "full" returns every record in the window (~1,400 ' +
          'per series over 24 hours, a ~540 KB response). The headline fields — latestPlasma, ' +
          'latestMag, bzStatus, bzMinInWindow, and the window maxima and southward-Bz minutes — ' +
          'are computed from the full window at every resolution.',
      ),
  }),
  output: z.object({
    plasma: z
      .array(PlasmaSchema)
      .describe(
        'Plasma measurements (speed, density, temperature) within the window, oldest first. Under resolution="reduced" this is at most 200 real records — one per equal-size bucket of the window, each the bucket\'s fastest speed — with the newest windowed record last. Empty under resolution="summary".',
      ),
    mag: z
      .array(MagSchema)
      .describe(
        'Magnetic field measurements (Bx, By, Bz, Bt) within the window, oldest first. Under resolution="reduced" this is at most 200 real records — one per equal-size bucket of the window, each the bucket\'s most southward Bz — with the newest windowed record last, so the final element always equals latestMag. Empty under resolution="summary".',
      ),
    latestPlasma: PlasmaSchema.nullable().describe(
      'Most recent plasma reading, null if no data in window.',
    ),
    latestMag: MagSchema.nullable().describe(
      'Most recent magnetic field reading, null if no data in window.',
    ),
    bzStatus: z
      .string()
      .describe(
        'Plain-language Bz status, e.g. "Southward Bz −14 nT — storm-driving conditions" or "Northward Bz +5 nT — quiescent".',
      ),
    plasmaCount: z
      .number()
      .describe(
        'Number of plasma records in the plasma array. Equal to the records in the window at full resolution; under a reduction it is the emitted count, and plasmaWindowRecords carries the pre-reduction total. Under resolution="summary" the array is empty and this is the records the window held.',
      ),
    magCount: z
      .number()
      .describe(
        'Number of magnetic field records in the mag array. Equal to the records in the window at full resolution; under a reduction it is the emitted count, and magWindowRecords carries the pre-reduction total. Under resolution="summary" the array is empty and this is the records the window held.',
      ),
    bzMinInWindow: z
      .number()
      .nullable()
      .describe(
        'Lowest (most southward) Bz reading in nT across the whole window, computed before any reduction — the number storm work reads next to the latest value. Null when the window is empty or every bzGsm in it is null.',
      ),
    bzMinTimeTag: z
      .string()
      .nullable()
      .describe(
        'ISO 8601 time tag of the record that carried bzMinInWindow. Null whenever bzMinInWindow is null.',
      ),
    bzSouthMinutesInWindow: z
      .number()
      .describe(
        'Minutes of southward Bz in the window: the count of 1-minute mag records with bzGsm below 0, across the whole window before any reduction. Gaps in the feed are not counted, so it can fall short of the wall-clock time Bz spent southward. 0 on an empty window, an all-null window, or one with no southward Bz.',
      ),
    speedMaxInWindow: z
      .number()
      .nullable()
      .describe(
        'Highest solar wind speed in km/s across the whole window, computed before any reduction. Null when the window is empty or every speedKmS in it is null.',
      ),
    speedMaxTimeTag: z
      .string()
      .nullable()
      .describe(
        'ISO 8601 time tag of the record that carried speedMaxInWindow. Null whenever speedMaxInWindow is null.',
      ),
    densityMaxInWindow: z
      .number()
      .nullable()
      .describe(
        'Highest proton density in particles/cm³ across the whole window, computed before any reduction. Null when the window is empty or every densityPerCm3 in it is null.',
      ),
    btMaxInWindow: z
      .number()
      .nullable()
      .describe(
        'Highest total field magnitude Bt in nT across the whole window, computed before any reduction. Null when the window is empty or every bt in it is null.',
      ),
    latestFeedPlasmaTime: z
      .string()
      .nullable()
      .describe(
        'ISO 8601 time of the newest plasma record the feed carries, ignoring the window. Null when the feed returned no active-spacecraft plasma records. Compare against the window to tell a quiet feed from a stale one.',
      ),
    latestFeedMagTime: z
      .string()
      .nullable()
      .describe(
        'ISO 8601 time of the newest magnetic field record the feed carries, ignoring the window. Null when the feed returned no active-spacecraft mag records.',
      ),
    feedStalenessHours: z
      .number()
      .nullable()
      .describe(
        'Hours between now and the newest record across both feeds — how far behind real time the upstream data is. Null when both feeds returned no active-spacecraft records.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on what shaped this response: that the requested window returned no plasma or magnetic field records — naming the newest record the feed carries, or reporting that the feed itself returned nothing from an active spacecraft — that a series was bounded to 200 records, with the per-series factors, or that resolution="summary" omitted both series.',
      ),
    plasmaBucketRecords: z
      .number()
      .optional()
      .describe(
        'Plasma records per emitted record — the bucket size the window was reduced by, or 1 when this series was returned untouched. Records rather than a minute cadence: the feed skips minutes, so a bucket spans a variable stretch of wall-clock time. Present only when a reduction was applied to either series.',
      ),
    plasmaWindowRecords: z
      .number()
      .optional()
      .describe(
        'Plasma records the window held before reduction. Present only when a reduction was applied to either series, or under resolution="summary".',
      ),
    magBucketRecords: z
      .number()
      .optional()
      .describe(
        'Magnetic field records per emitted record — the bucket size the window was reduced by, or 1 when this series was returned untouched. The two series differ in length, so each carries its own factor. Present only when a reduction was applied to either series.',
      ),
    magWindowRecords: z
      .number()
      .optional()
      .describe(
        'Magnetic field records the window held before reduction. Present only when a reduction was applied to either series, or under resolution="summary".',
      ),
  },

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
    ctx.log.info('Fetching solar wind data', {
      window_hours: input.window_hours,
      resolution: input.resolution,
    });
    const svc = getSpaceWeatherService();
    const [allPlasma, allMag] = await Promise.all([
      svc.getSolarWindPlasma(ctx),
      svc.getSolarWindMag(ctx),
    ]);

    const nowMs = Date.now();
    const cutoffMs = nowMs - input.window_hours * 3_600_000;

    // Compare epoch millis, not ISO strings: RTSW time tags carry no milliseconds,
    // so they don't collate reliably against a toISOString() cutoff that does.
    const plasma = allPlasma.filter((r) => new Date(r.timeTag).getTime() >= cutoffMs);
    const mag = allMag.filter((r) => new Date(r.timeTag).getTime() >= cutoffMs);

    // Service returns each series oldest-first, so the last element is the newest.
    const latestPlasma = plasma.length > 0 ? plasma[plasma.length - 1] : null;
    const latestMag = mag.length > 0 ? mag[mag.length - 1] : null;

    // Feed freshness is a fact about the feed, not the window — read it from the
    // unwindowed series so an empty window can still report what upstream carries.
    const latestFeedPlasmaTime = allPlasma.at(-1)?.timeTag ?? null;
    const latestFeedMagTime = allMag.at(-1)?.timeTag ?? null;
    const newestFeedMs = Math.max(
      latestFeedPlasmaTime ? new Date(latestFeedPlasmaTime).getTime() : Number.NEGATIVE_INFINITY,
      latestFeedMagTime ? new Date(latestFeedMagTime).getTime() : Number.NEGATIVE_INFINITY,
    );
    const feedStalenessHours = Number.isFinite(newestFeedMs)
      ? Math.round(((nowMs - newestFeedMs) / 3_600_000) * 100) / 100
      : null;

    /** Explain an empty windowed series: stale feed, or nothing from an active spacecraft. */
    const emptyWindowNotice = (
      label: string,
      windowedCount: number,
      latestFeedTime: string | null,
    ): string | null => {
      if (windowedCount > 0) return null;
      return latestFeedTime
        ? `No ${label} readings in the requested ${input.window_hours}-hour window; the newest record the feed carries is from ${latestFeedTime}.`
        : `The feed returned no ${label} readings from an active spacecraft.`;
    };

    // Derive Bz status
    let bzStatus = 'Bz data unavailable.';
    if (latestMag?.bzGsm != null) {
      const bz = latestMag.bzGsm;
      if (bz <= -20) bzStatus = `Strongly southward Bz ${bz} nT — severe storm-driving conditions.`;
      else if (bz <= -10) bzStatus = `Southward Bz ${bz} nT — storm-driving conditions.`;
      else if (bz < 0) bzStatus = `Mildly southward Bz ${bz} nT — weakly geoeffective.`;
      else bzStatus = `Northward Bz +${bz} nT — quiescent, not storm-driving.`;
    }

    // Window statistics read the full windowed series, before any reduction: the whole
    // point of these fields is that they survive a reduction that emits neither
    // neighbour, and a summary that emits nothing at all.
    let bzMinInWindow: number | null = null;
    let bzMinTimeTag: string | null = null;
    let btMaxInWindow: number | null = null;
    // Each mag record is a 1-minute average, so the count is measured southward
    // minutes; a gap in the feed contributes no record and so adds nothing.
    let bzSouthMinutesInWindow = 0;
    for (const record of mag) {
      if (record.bzGsm !== null && (bzMinInWindow === null || record.bzGsm < bzMinInWindow)) {
        bzMinInWindow = record.bzGsm;
        bzMinTimeTag = record.timeTag;
      }
      if (record.bzGsm !== null && record.bzGsm < 0) bzSouthMinutesInWindow++;
      if (record.bt !== null && (btMaxInWindow === null || record.bt > btMaxInWindow)) {
        btMaxInWindow = record.bt;
      }
    }
    let speedMaxInWindow: number | null = null;
    let speedMaxTimeTag: string | null = null;
    let densityMaxInWindow: number | null = null;
    for (const record of plasma) {
      if (
        record.speedKmS !== null &&
        (speedMaxInWindow === null || record.speedKmS > speedMaxInWindow)
      ) {
        speedMaxInWindow = record.speedKmS;
        speedMaxTimeTag = record.timeTag;
      }
      if (
        record.densityPerCm3 !== null &&
        (densityMaxInWindow === null || record.densityPerCm3 > densityMaxInWindow)
      ) {
        densityMaxInWindow = record.densityPerCm3;
      }
    }

    const summary = input.resolution === 'summary';
    /** Emit a series at the requested resolution: nothing, bucket extremes, or every record. */
    const emit = <T>(records: readonly T[], pick: (bucket: readonly T[]) => T) =>
      input.resolution === 'reduced'
        ? reduceSeries(records, pick)
        : { emitted: summary ? [] : records, bucketRecords: 1 };
    const plasmaReduction = emit(plasma, fastestSpeed);
    const magReduction = emit(mag, mostSouthwardBz);
    const reducedSeries = [
      plasmaReduction.bucketRecords > 1
        ? `plasma ${plasma.length} → ${plasmaReduction.emitted.length} records (one per ${plasmaReduction.bucketRecords})`
        : null,
      magReduction.bucketRecords > 1
        ? `magnetic field ${mag.length} → ${magReduction.emitted.length} records (one per ${magReduction.bucketRecords})`
        : null,
    ].filter((n): n is string => n !== null);

    const notices = [
      emptyWindowNotice('plasma', plasma.length, latestFeedPlasmaTime),
      emptyWindowNotice('magnetic field', mag.length, latestFeedMagTime),
      reducedSeries.length > 0
        ? `Series bounded to ${REDUCED_SERIES_MAX} records each at resolution="reduced" — ${reducedSeries.join(', ')}. Every emitted record is a real measurement (its bucket's fastest speed or most southward Bz) and the newest record in the window is last; bzStatus, latestPlasma, latestMag, and every window statistic come from the full window. Pass resolution="full" for every record.`
        : null,
      summary
        ? `Series omitted at resolution="summary" — the latest readings, Bz status, and window statistics come from all ${plasma.length} plasma and ${mag.length} magnetic field records in the window. Pass resolution="reduced" or "full" for the series.`
        : null,
    ].filter((n): n is string => n !== null);
    // One call — the notice field is last-wins, so a second call would clobber the first.
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
    // Written separately rather than spread in conditionally: enrich accumulates, and
    // an absent field must stay absent rather than arrive as an explicit undefined.
    if (reducedSeries.length > 0) {
      ctx.enrich({
        plasmaBucketRecords: plasmaReduction.bucketRecords,
        plasmaWindowRecords: plasma.length,
        magBucketRecords: magReduction.bucketRecords,
        magWindowRecords: mag.length,
      });
    } else if (summary) {
      // No bucketing ran, but the caller still needs to know how many records existed.
      ctx.enrich({ plasmaWindowRecords: plasma.length, magWindowRecords: mag.length });
    }

    return {
      plasma: plasmaReduction.emitted.map((r) => ({
        timeTag: r.timeTag,
        source: r.source,
        densityPerCm3: r.densityPerCm3,
        speedKmS: r.speedKmS,
        temperatureK: r.temperatureK,
      })),
      mag: magReduction.emitted.map((r) => ({
        timeTag: r.timeTag,
        source: r.source,
        bxGsm: r.bxGsm,
        byGsm: r.byGsm,
        bzGsm: r.bzGsm,
        bt: r.bt,
      })),
      latestPlasma: latestPlasma
        ? {
            timeTag: latestPlasma.timeTag,
            source: latestPlasma.source,
            densityPerCm3: latestPlasma.densityPerCm3,
            speedKmS: latestPlasma.speedKmS,
            temperatureK: latestPlasma.temperatureK,
          }
        : null,
      latestMag: latestMag
        ? {
            timeTag: latestMag.timeTag,
            source: latestMag.source,
            bxGsm: latestMag.bxGsm,
            byGsm: latestMag.byGsm,
            bzGsm: latestMag.bzGsm,
            bt: latestMag.bt,
          }
        : null,
      bzStatus,
      // A summary empties the arrays but must not blind the caller to what existed.
      plasmaCount: summary ? plasma.length : plasmaReduction.emitted.length,
      magCount: summary ? mag.length : magReduction.emitted.length,
      latestFeedPlasmaTime,
      latestFeedMagTime,
      feedStalenessHours,
      bzMinInWindow,
      bzMinTimeTag,
      bzSouthMinutesInWindow,
      speedMaxInWindow,
      speedMaxTimeTag,
      densityMaxInWindow,
      btMaxInWindow,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    const source = result.latestPlasma?.source ?? result.latestMag?.source;
    lines.push(source ? `## Solar Wind (${source})` : '## Solar Wind');
    lines.push(`**Bz Status:** ${result.bzStatus}`);
    lines.push(
      `**Minimum Bz in window:** ${
        result.bzMinInWindow != null && result.bzMinTimeTag != null
          ? `${result.bzMinInWindow} nT at ${result.bzMinTimeTag}`
          : 'N/A'
      }`,
    );
    lines.push(
      `**Southward Bz in window:** ${result.bzSouthMinutesInWindow} min (1-minute records with Bz < 0; feed gaps not counted)`,
    );
    lines.push(
      `**Maximum speed in window:** ${
        result.speedMaxInWindow != null && result.speedMaxTimeTag != null
          ? `${result.speedMaxInWindow} km/s at ${result.speedMaxTimeTag}`
          : 'N/A'
      }`,
    );
    lines.push(
      `**Maximum density in window:** ${result.densityMaxInWindow != null ? `${result.densityMaxInWindow} n/cm³` : 'N/A'} | **Maximum Bt in window:** ${result.btMaxInWindow != null ? `${result.btMaxInWindow} nT` : 'N/A'}`,
    );
    // Only a summary empties both arrays while the window still held records.
    const seriesOmitted =
      result.plasma.length === 0 &&
      result.mag.length === 0 &&
      result.plasmaCount + result.magCount > 0;
    lines.push(
      `**Plasma readings:** ${result.plasmaCount} | **Mag readings:** ${result.magCount}${seriesOmitted ? ' — in the window; series not included' : ''}`,
    );

    if (result.latestFeedPlasmaTime != null) {
      lines.push(`**Newest plasma record in feed:** ${result.latestFeedPlasmaTime}`);
    }
    if (result.latestFeedMagTime != null) {
      lines.push(`**Newest mag record in feed:** ${result.latestFeedMagTime}`);
    }
    if (result.feedStalenessHours != null) {
      lines.push(`**Feed staleness:** ${result.feedStalenessHours} h behind real time`);
    }

    if (result.latestPlasma) {
      const p = result.latestPlasma;
      lines.push('');
      lines.push('### Latest Plasma');
      lines.push(`**Time:** ${p.timeTag} | **Source:** ${p.source}`);
      lines.push(`- Speed: ${p.speedKmS != null ? `${p.speedKmS} km/s` : 'N/A'}`);
      lines.push(`- Density: ${p.densityPerCm3 != null ? `${p.densityPerCm3} n/cm³` : 'N/A'}`);
      lines.push(`- Temperature: ${p.temperatureK != null ? `${p.temperatureK} K` : 'N/A'}`);
    }
    if (result.latestMag) {
      const m = result.latestMag;
      lines.push('');
      lines.push('### Latest Magnetic Field');
      lines.push(`**Time:** ${m.timeTag} | **Source:** ${m.source}`);
      lines.push(`- Bz (GSM): ${m.bzGsm != null ? `${m.bzGsm} nT` : 'N/A'} ← storm driver`);
      lines.push(`- Bt (total): ${m.bt != null ? `${m.bt} nT` : 'N/A'}`);
      lines.push(
        `- Bx: ${m.bxGsm != null ? `${m.bxGsm} nT` : 'N/A'} | By: ${m.byGsm != null ? `${m.byGsm} nT` : 'N/A'}`,
      );
    }
    if (result.plasma.length > 0) {
      lines.push('');
      lines.push('### Plasma Time Series');
      for (const r of result.plasma) {
        lines.push(
          `- ${r.timeTag} (${r.source}): speed=${r.speedKmS != null ? `${r.speedKmS} km/s` : 'N/A'}, density=${r.densityPerCm3 != null ? `${r.densityPerCm3} n/cm³` : 'N/A'}, temp=${r.temperatureK != null ? `${r.temperatureK} K` : 'N/A'}`,
        );
      }
    }
    if (result.mag.length > 0) {
      lines.push('');
      lines.push('### Mag Time Series');
      for (const r of result.mag) {
        lines.push(
          `- ${r.timeTag} (${r.source}): Bz=${r.bzGsm != null ? `${r.bzGsm} nT` : 'N/A'}, Bt=${r.bt != null ? `${r.bt} nT` : 'N/A'}, Bx=${r.bxGsm != null ? `${r.bxGsm} nT` : 'N/A'}, By=${r.byGsm != null ? `${r.byGsm} nT` : 'N/A'}`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
