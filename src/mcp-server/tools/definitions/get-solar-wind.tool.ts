/**
 * @fileoverview Tool: noaa_spaceweather_get_solar_wind — real-time DSCOVR solar wind data.
 * @module mcp-server/tools/definitions/get-solar-wind
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

const PlasmaSchema = z
  .object({
    timeTag: z.string().describe('ISO 8601 measurement time tag.'),
    densityPerCm3: z
      .number()
      .nullable()
      .describe('Proton density in particles/cm³. Null when sensor fill value.'),
    speedKmS: z
      .number()
      .nullable()
      .describe('Solar wind speed in km/s. Null when sensor fill value.'),
    temperatureK: z
      .number()
      .nullable()
      .describe('Proton temperature in Kelvin. Null when sensor fill value.'),
  })
  .describe('One DSCOVR plasma measurement.');

const MagSchema = z
  .object({
    timeTag: z.string().describe('ISO 8601 measurement time tag.'),
    bxGsm: z
      .number()
      .nullable()
      .describe('Bx component in GSM coordinates (nT). Null when sensor fill value.'),
    byGsm: z
      .number()
      .nullable()
      .describe('By component in GSM coordinates (nT). Null when sensor fill value.'),
    bzGsm: z
      .number()
      .nullable()
      .describe(
        'Bz component in GSM coordinates (nT). Southward (negative) drives geomagnetic storms. Null when sensor fill value.',
      ),
    bt: z
      .number()
      .nullable()
      .describe('Total field magnitude Bt (nT). Null when sensor fill value.'),
  })
  .describe('One DSCOVR magnetic field measurement.');

export const getSolarWind = tool('noaa_spaceweather_get_solar_wind', {
  title: 'Get Solar Wind',
  description:
    'Real-time solar wind data from DSCOVR at L1: proton speed (km/s), density (n/cm³), temperature ' +
    '(K), and the critical Bz component (southward Bz = negative = storm driver). Returns the ' +
    'recent plasma and magnetic field time series within the requested window. ' +
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
        'Hours of recent solar wind history to return (1–168, default 3). Feeds update ~every 1 min.',
      ),
  }),
  output: z.object({
    plasma: z
      .array(PlasmaSchema)
      .describe('Plasma measurements (speed, density, temperature) within the window.'),
    mag: z
      .array(MagSchema)
      .describe('Magnetic field measurements (Bx, By, Bz, Bt) within the window.'),
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
  }),

  errors: [
    {
      reason: 'feed_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'SWPC endpoint returns non-OK status or times out after retries.',
      retryable: true,
      recovery: 'Retry in 30–60 seconds; SWPC feeds occasionally lag during high-activity events.',
    },
    {
      reason: 'invalid_window',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'window_hours is outside the allowed range 1–168.',
      recovery: 'Use a window_hours value between 1 and 168.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching solar wind data', { window_hours: input.window_hours });
    if (input.window_hours < 1 || input.window_hours > 168) {
      throw ctx.fail('invalid_window', `window_hours must be 1–168, got ${input.window_hours}`, {
        ...ctx.recoveryFor('invalid_window'),
      });
    }

    const svc = getSpaceWeatherService();
    const [allPlasma, allMag] = await Promise.all([
      svc.getSolarWindPlasma(ctx),
      svc.getSolarWindMag(ctx),
    ]);

    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - input.window_hours);
    const cutoffIso = cutoff.toISOString();

    const plasma = allPlasma.filter((r) => r.timeTag >= cutoffIso);
    const mag = allMag.filter((r) => r.timeTag >= cutoffIso);

    const latestPlasma = plasma.length > 0 ? plasma[plasma.length - 1] : null;
    const latestMag = mag.length > 0 ? mag[mag.length - 1] : null;

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
        densityPerCm3: r.densityPerCm3,
        speedKmS: r.speedKmS,
        temperatureK: r.temperatureK,
      })),
      mag: mag.map((r) => ({
        timeTag: r.timeTag,
        bxGsm: r.bxGsm,
        byGsm: r.byGsm,
        bzGsm: r.bzGsm,
        bt: r.bt,
      })),
      latestPlasma: latestPlasma
        ? {
            timeTag: latestPlasma.timeTag,
            densityPerCm3: latestPlasma.densityPerCm3,
            speedKmS: latestPlasma.speedKmS,
            temperatureK: latestPlasma.temperatureK,
          }
        : null,
      latestMag: latestMag
        ? {
            timeTag: latestMag.timeTag,
            bxGsm: latestMag.bxGsm,
            byGsm: latestMag.byGsm,
            bzGsm: latestMag.bzGsm,
            bt: latestMag.bt,
          }
        : null,
      bzStatus,
      plasmaCount: plasma.length,
      magCount: mag.length,
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push('## Solar Wind (DSCOVR)');
    lines.push(`**Bz Status:** ${result.bzStatus}`);
    lines.push(`**Plasma readings:** ${result.plasmaCount} | **Mag readings:** ${result.magCount}`);

    if (result.latestPlasma) {
      const p = result.latestPlasma;
      lines.push('');
      lines.push('### Latest Plasma');
      lines.push(`**Time:** ${p.timeTag}`);
      lines.push(`- Speed: ${p.speedKmS != null ? `${p.speedKmS} km/s` : 'N/A'}`);
      lines.push(`- Density: ${p.densityPerCm3 != null ? `${p.densityPerCm3} n/cm³` : 'N/A'}`);
      lines.push(`- Temperature: ${p.temperatureK != null ? `${p.temperatureK} K` : 'N/A'}`);
    }
    if (result.latestMag) {
      const m = result.latestMag;
      lines.push('');
      lines.push('### Latest Magnetic Field');
      lines.push(`**Time:** ${m.timeTag}`);
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
          `- ${r.timeTag}: speed=${r.speedKmS != null ? `${r.speedKmS} km/s` : 'N/A'}, density=${r.densityPerCm3 != null ? `${r.densityPerCm3} n/cm³` : 'N/A'}, temp=${r.temperatureK != null ? `${r.temperatureK} K` : 'N/A'}`,
        );
      }
    }
    if (result.mag.length > 0) {
      lines.push('');
      lines.push('### Mag Time Series');
      for (const r of result.mag) {
        lines.push(
          `- ${r.timeTag}: Bz=${r.bzGsm != null ? `${r.bzGsm} nT` : 'N/A'}, Bt=${r.bt != null ? `${r.bt} nT` : 'N/A'}, Bx=${r.bxGsm != null ? `${r.bxGsm} nT` : 'N/A'}, By=${r.byGsm != null ? `${r.byGsm} nT` : 'N/A'}`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
