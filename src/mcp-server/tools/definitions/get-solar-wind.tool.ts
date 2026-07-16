/**
 * @fileoverview Tool: noaa_spaceweather_get_solar_wind — real-time L1 solar wind data
 * from the spacecraft SWPC currently flags as active in its RTSW feeds.
 * @module mcp-server/tools/definitions/get-solar-wind
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

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
    'window, oldest first, each record tagged with the reporting spacecraft. ' +
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
          'whole feed, not more history. When a window comes back empty, feedStalenessHours and ' +
          'latestFeedPlasmaTime/latestFeedMagTime report how current the feed actually is.',
      ),
  }),
  output: z.object({
    plasma: z
      .array(PlasmaSchema)
      .describe(
        'Plasma measurements (speed, density, temperature) within the window, oldest first.',
      ),
    mag: z
      .array(MagSchema)
      .describe('Magnetic field measurements (Bx, By, Bz, Bt) within the window, oldest first.'),
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
      .describe('Number of plasma records in the plasma array, spanning the requested window.'),
    magCount: z
      .number()
      .describe(
        'Number of magnetic field records in the mag array, spanning the requested window.',
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
        'Guidance when the requested window returned no plasma or magnetic field records — names the newest record the feed carries, or reports that the feed itself returned nothing from an active spacecraft.',
      ),
  },

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
    ctx.log.info('Fetching solar wind data', { window_hours: input.window_hours });
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

    const notices = [
      emptyWindowNotice('plasma', plasma.length, latestFeedPlasmaTime),
      emptyWindowNotice('magnetic field', mag.length, latestFeedMagTime),
    ].filter((n): n is string => n !== null);
    // One call — the notice field is last-wins, so a second call would clobber the first.
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    // Derive Bz status
    let bzStatus = 'Bz data unavailable.';
    if (latestMag?.bzGsm != null) {
      const bz = latestMag.bzGsm;
      if (bz <= -20) bzStatus = `Strongly southward Bz ${bz} nT — severe storm-driving conditions.`;
      else if (bz <= -10) bzStatus = `Southward Bz ${bz} nT — storm-driving conditions.`;
      else if (bz < 0) bzStatus = `Mildly southward Bz ${bz} nT — weakly geoeffective.`;
      else bzStatus = `Northward Bz +${bz} nT — quiescent, not storm-driving.`;
    }

    return {
      plasma: plasma.map((r) => ({
        timeTag: r.timeTag,
        source: r.source,
        densityPerCm3: r.densityPerCm3,
        speedKmS: r.speedKmS,
        temperatureK: r.temperatureK,
      })),
      mag: mag.map((r) => ({
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
      plasmaCount: plasma.length,
      magCount: mag.length,
      latestFeedPlasmaTime,
      latestFeedMagTime,
      feedStalenessHours,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    const source = result.latestPlasma?.source ?? result.latestMag?.source;
    lines.push(source ? `## Solar Wind (${source})` : '## Solar Wind');
    lines.push(`**Bz Status:** ${result.bzStatus}`);
    lines.push(`**Plasma readings:** ${result.plasmaCount} | **Mag readings:** ${result.magCount}`);

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
