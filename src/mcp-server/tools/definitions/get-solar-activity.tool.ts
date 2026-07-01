/**
 * @fileoverview Tool: noaa_spaceweather_get_solar_activity — solar flares, regions, radiation storms.
 * @module mcp-server/tools/definitions/get-solar-activity
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

/** Classify X-ray flux to flare class letter. */
function classifyFlare(fluxWm2: number): string {
  if (fluxWm2 >= 1e-4) return 'X';
  if (fluxWm2 >= 1e-5) return 'M';
  if (fluxWm2 >= 1e-6) return 'C';
  if (fluxWm2 >= 1e-7) return 'B';
  return 'A';
}

/** Format X-ray flux to 2 significant digits in scientific notation, e.g. 1.4e-6. */
function formatFlux(fluxWm2: number): string {
  // toPrecision gives "1.40e-6" style; strip trailing zeros after decimal for readability.
  return fluxWm2.toExponential(1) + ' W/m²';
}

/**
 * Round integral proton flux to 3 significant figures. Raw GOES values carry
 * ~16 digits of IEEE-754 noise (e.g. 0.2243340015411377); pfu are read as plain
 * decimals across the S-scale range, so a rounded number (not a string) is the
 * sensible form — 0.224, 151, 12300.
 */
function roundProtonFlux(fluxPfu: number): number {
  return Number(fluxPfu.toPrecision(3));
}

/** Classify proton flux to NOAA S-scale. */
function classifySScale(fluxPfu: number): number {
  if (fluxPfu >= 100000) return 5;
  if (fluxPfu >= 10000) return 4;
  if (fluxPfu >= 1000) return 3;
  if (fluxPfu >= 100) return 2;
  if (fluxPfu >= 10) return 1;
  return 0;
}

const XraySchema = z
  .object({
    timeTag: z.string().describe('ISO 8601 measurement time tag.'),
    fluxWm2: z
      .string()
      .describe(
        'X-ray flux in W/m² (0.1-0.8nm long channel from GOES), formatted as scientific notation with 2 significant digits, e.g. "1.4e-6 W/m²".',
      ),
    flareClass: z.string().describe('Flare classification letter: A, B, C, M, or X.'),
    satellite: z.number().describe('GOES satellite number.'),
  })
  .describe('One GOES X-ray flux reading with flare class.');

const SolarRegionSchema = z
  .object({
    region: z.number().describe('NOAA active region number.'),
    location: z.string().describe('Heliographic location, e.g. "N17E47".'),
    latitude: z.string().describe('Heliographic latitude, e.g. "N17".'),
    spotClass: z.string().describe('Sunspot morphology class.'),
    numberSpots: z.number().describe('Number of sunspots in this region.'),
    magClass: z.string().describe('Magnetic field class.'),
    cFlareProbability: z.number().describe('Probability of a C-class flare (%).'),
    mFlareProbability: z.number().describe('Probability of an M-class flare (%).'),
    xFlareProbability: z.number().describe('Probability of an X-class flare (%).'),
    protonProbability: z.number().describe('Probability of a proton event (%).'),
    observedDate: z.string().describe('Date this region data was observed.'),
  })
  .describe('One active solar region with flare probabilities.');

const ProbsSchema = z
  .object({
    date: z.string().describe('Forecast date.'),
    cClass1Day: z.number().describe('Total probability of a C-class flare for this date (%).'),
    cClassProbability: z
      .number()
      .describe(
        'Total probability of a C-class flare for this date (%). Date-neutral alias of cClass1Day.',
      ),
    mClass1Day: z.number().describe('Total probability of an M-class flare for this date (%).'),
    mClassProbability: z
      .number()
      .describe(
        'Total probability of an M-class flare for this date (%). Date-neutral alias of mClass1Day.',
      ),
    xClass1Day: z.number().describe('Total probability of an X-class flare for this date (%).'),
    xClassProbability: z
      .number()
      .describe(
        'Total probability of an X-class flare for this date (%). Date-neutral alias of xClass1Day.',
      ),
    protons1Day: z.number().describe('Probability of a ≥10 MeV proton event for this date (%).'),
    protonEventProbability: z
      .number()
      .describe(
        'Probability of a ≥10 MeV proton event for this date (%). Date-neutral alias of protons1Day.',
      ),
  })
  .describe('Solar flare probability forecast for one day.');

const ProtonSchema = z
  .object({
    timeTag: z.string().describe('ISO 8601 measurement time tag.'),
    fluxPfu: z
      .number()
      .describe(
        'Integral proton flux in particle flux units (pfu) at ≥10 MeV, rounded to 3 significant figures.',
      ),
    sScale: z.number().describe('NOAA S-scale level (0–5) for this flux reading.'),
    energy: z.string().describe('Energy channel, e.g. ">=10 MeV".'),
  })
  .describe('One GOES integral proton flux reading with S-scale.');

export const getSolarActivity = tool('noaa_spaceweather_get_solar_activity', {
  title: 'Get Solar Activity',
  description:
    'Solar flare and radiation storm picture: recent GOES X-ray flux with flare-class labels (A/B/C/M/X), ' +
    '3-day flare-class probabilities (C/M/X), active solar regions with per-region flare probabilities, ' +
    'and GOES integral proton flux at ≥10 MeV with NOAA S-scale. For operators tracking HF radio ' +
    'blackout (R-scale, driven by X-ray) and radiation storm risk (S-scale, driven by protons). ' +
    'Active region data helps identify which region is driving current activity.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    include_regions: z
      .boolean()
      .default(true)
      .describe(
        'Include active solar region details (default true). Set false to skip region data and reduce response size.',
      ),
  }),
  output: z.object({
    latestXray: XraySchema.nullable().describe(
      'Most recent GOES X-ray flux reading, null if unavailable.',
    ),
    recentXray: z
      .array(XraySchema)
      .describe('GOES X-ray flux readings from the past hour, oldest first.'),
    probabilities: z.array(ProbsSchema).describe('3-day flare probability forecasts.'),
    latestProton: ProtonSchema.nullable().describe(
      'Most recent ≥10 MeV proton flux reading, null if unavailable.',
    ),
    sScale: z
      .number()
      .describe(
        'Current NOAA S-scale for solar radiation storms (0–5), derived from latest proton flux.',
      ),
    sScaleText: z
      .string()
      .describe('Plain-language S-scale description, e.g. "S2 moderate radiation storm".'),
    activeRegions: z
      .array(SolarRegionSchema)
      .describe(
        'Currently active solar regions with per-region flare probabilities. Empty when include_regions=false or no regions are active.',
      ),
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
    ctx.log.info('Fetching solar activity', { include_regions: input.include_regions });
    const svc = getSpaceWeatherService();

    const [xray, probs, protons, regions] = await Promise.all([
      svc.getXrayFlux(ctx),
      svc.getSolarProbabilities(ctx),
      svc.getProtonFlux(ctx),
      input.include_regions ? svc.getSolarRegions(ctx) : Promise.resolve(null),
    ]);

    // Latest X-ray
    const latestXrayRaw = xray.length > 0 ? xray[xray.length - 1] : null;
    const latestXray = latestXrayRaw
      ? {
          timeTag: latestXrayRaw.timeTag,
          fluxWm2: formatFlux(latestXrayRaw.fluxWm2),
          flareClass: classifyFlare(latestXrayRaw.fluxWm2),
          satellite: latestXrayRaw.satellite,
        }
      : null;

    // Recent X-ray — last hour. Compare epochs, not raw ISO strings: X-ray
    // timeTags carry no fractional seconds while toISOString() always emits
    // .mmm, so lexicographic >= disagrees with true chronology at the window
    // boundary (same class of bug already fixed in get-alerts, #6).
    const hourCutoff = new Date();
    hourCutoff.setHours(hourCutoff.getHours() - 1);
    const hourCutoffMs = hourCutoff.getTime();
    const recentXray = xray
      .filter((r) => new Date(r.timeTag).getTime() >= hourCutoffMs)
      .map((r) => ({
        timeTag: r.timeTag,
        fluxWm2: formatFlux(r.fluxWm2),
        flareClass: classifyFlare(r.fluxWm2),
        satellite: r.satellite,
      }));

    // Latest proton / S-scale
    const latestProtonRaw = protons.length > 0 ? protons[protons.length - 1] : null;
    const sScale = latestProtonRaw ? classifySScale(latestProtonRaw.fluxPfu) : 0;
    const sScaleDescriptors = [
      'No radiation storm',
      'S1 minor radiation storm',
      'S2 moderate radiation storm',
      'S3 strong radiation storm',
      'S4 severe radiation storm',
      'S5 extreme radiation storm',
    ];
    const sScaleText = sScaleDescriptors[sScale] ?? 'Unknown';

    const latestProton = latestProtonRaw
      ? {
          timeTag: latestProtonRaw.timeTag,
          // S-scale is classified from the raw value above; round only for display.
          fluxPfu: roundProtonFlux(latestProtonRaw.fluxPfu),
          sScale,
          energy: latestProtonRaw.energy,
        }
      : null;

    return {
      latestXray,
      recentXray,
      probabilities: probs.map((p) => ({
        date: p.date,
        cClass1Day: p.cClass1Day,
        cClassProbability: p.cClassProbability,
        mClass1Day: p.mClass1Day,
        mClassProbability: p.mClassProbability,
        xClass1Day: p.xClass1Day,
        xClassProbability: p.xClassProbability,
        protons1Day: p.protons1Day,
        protonEventProbability: p.protonEventProbability,
      })),
      latestProton,
      sScale,
      sScaleText,
      activeRegions: (regions ?? []).map((r) => ({
        region: r.region,
        location: r.location,
        latitude: r.latitude,
        spotClass: r.spotClass,
        numberSpots: r.numberSpots,
        magClass: r.magClass,
        cFlareProbability: r.cFlareProbability,
        mFlareProbability: r.mFlareProbability,
        xFlareProbability: r.xFlareProbability,
        protonProbability: r.protonProbability,
        observedDate: r.observedDate,
      })),
      fetchedAt: new Date().toISOString(),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## Solar Activity — ${result.fetchedAt}`);
    lines.push(`**Radiation Storm:** ${result.sScaleText} (S-scale ${result.sScale})`);

    if (result.latestXray) {
      const x = result.latestXray;
      lines.push('');
      lines.push('### Latest X-ray Flux');
      lines.push(
        `**Time:** ${x.timeTag} | **Class:** ${x.flareClass} | **Flux:** ${x.fluxWm2} | **Satellite:** GOES-${x.satellite}`,
      );
    }
    if (result.recentXray.length > 0) {
      lines.push('');
      lines.push('### X-ray (Past Hour)');
      for (const r of result.recentXray) {
        lines.push(`- ${r.timeTag}: ${r.flareClass} class — ${r.fluxWm2} | GOES-${r.satellite}`);
      }
    }
    if (result.latestProton) {
      const p = result.latestProton;
      lines.push('');
      lines.push('### Proton Flux (≥10 MeV)');
      lines.push(
        `**Time:** ${p.timeTag} | **Flux:** ${p.fluxPfu} pfu | **S${p.sScale}** | **Channel:** ${p.energy}`,
      );
    }
    if (result.probabilities.length > 0) {
      lines.push('');
      lines.push('### Flare Probabilities (3-day forecast)');
      for (const p of result.probabilities) {
        lines.push(
          `**${p.date}:** C=${p.cClassProbability}% | M=${p.mClassProbability}% | X=${p.xClassProbability}% | Proton=${p.protonEventProbability}%`,
        );
        // The legacy *1Day fields carry the same values; rendered so content[]
        // stays in parity with structuredContent across both field namings (#16).
        lines.push(
          `  (legacy: cClass1Day=${p.cClass1Day}% mClass1Day=${p.mClass1Day}% xClass1Day=${p.xClass1Day}% protons1Day=${p.protons1Day}%)`,
        );
      }
    }
    if (result.activeRegions.length > 0) {
      lines.push('');
      lines.push('### Active Solar Regions');
      for (const r of result.activeRegions) {
        lines.push(
          `**AR${r.region}** — Location: ${r.location} | Latitude: ${r.latitude} | Observed: ${r.observedDate}`,
        );
        lines.push(`  Class: ${r.spotClass}/${r.magClass} | Spots: ${r.numberSpots}`);
        lines.push(
          `  Flare: C=${r.cFlareProbability}% M=${r.mFlareProbability}% X=${r.xFlareProbability}% Proton=${r.protonProbability}%`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
