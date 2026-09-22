/**
 * @fileoverview Tool: noaa_spaceweather_get_solar_activity — solar flares, regions, radiation storms.
 * @module mcp-server/tools/definitions/get-solar-activity
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getSpaceWeatherService } from '@/services/space-weather/space-weather-service.js';

/**
 * The A-class decade — the lowest SWPC names, and the fallback for a reading that
 * reaches no floor at all. {@link classifyFlare} keeps calling such a reading "A",
 * the weakest letter it has and the value that field has always carried;
 * {@link classifyFlareWithMagnitude} reports no class for it, because the scheme
 * has none below A1.0.
 */
const A_DECADE = ['A', 1e-8] as const;

/** GOES flare-class decade floors in W/m², highest first. X is unbounded above. */
const FLARE_DECADES: readonly (readonly [letter: string, floor: number])[] = [
  ['X', 1e-4],
  ['M', 1e-5],
  ['C', 1e-6],
  ['B', 1e-7],
  A_DECADE,
];

/** The decade a flux reading sits in — its class letter and that class's floor. */
function flareDecade(fluxWm2: number): readonly [letter: string, floor: number] {
  return FLARE_DECADES.find(([, floor]) => fluxWm2 >= floor) ?? A_DECADE;
}

/** Classify X-ray flux to flare class letter. */
function classifyFlare(fluxWm2: number): string {
  return flareDecade(fluxWm2)[0];
}

/**
 * Flare class with magnitude, e.g. "M5.2", matching how SWPC writes the classes it
 * publishes on the flare feed — the same flare would otherwise be reported two ways
 * in one response.
 *
 * SWPC **truncates** the decade quotient to one decimal; it does not round. Across a
 * full 7-day flare capture all 29 published `max_class` values reproduce under
 * truncation and only 11 under rounding, and rounding also invents classes that do
 * not exist at a decade edge (9.986e-7 would become "B10.0"). The quotient is snapped
 * to 12 significant digits first because binary division is inexact in an
 * input-dependent way: 4.9e-5 / 1e-5 evaluates to 4.8999999999999995, which a bare
 * truncation reports as M4.8 for a flux that is exactly M4.9.
 *
 * Null below the A1 floor of 1e-8 W/m², which includes zero and the negative
 * excursions the long channel occasionally reports. SWPC's scheme starts at A1.0, so
 * every string below that floor — "A0.0" for a zero, "A0.9" for 9.9e-9 — would be a
 * class no SWPC product writes, stating a classification that does not exist. In a
 * 7-day capture 431 of 9,982 long-channel readings were exactly 0.0 and none fell
 * between 0 and 1e-8, so the floor is where the published vocabulary ends rather
 * than a place real measurements sit.
 */
function classifyFlareWithMagnitude(fluxWm2: number): string | null {
  const [letter, floor] = flareDecade(fluxWm2);
  // flareDecade falls back to the A decade, so a reading that reaches no floor —
  // sub-A1, zero, negative, NaN — fails this comparison and has no class.
  if (!(fluxWm2 >= floor)) return null;
  const quotient = Number((fluxWm2 / floor).toPrecision(12));
  return `${letter}${(Math.floor(quotient * 10) / 10).toFixed(1)}`;
}

/**
 * NOAA R-scale (radio blackout) levels as flux floors in W/m², highest first. The
 * NOAA scales page states the levels by physical measure — R1 at M1, R2 at M5, R3 at
 * X1, R4 at X10, R5 at X20 — so the level comes from the flux already in hand rather
 * than from parsing a class string. Below M1 there is no blackout level.
 */
const R_SCALE_FLOORS: readonly (readonly [level: number, floor: number])[] = [
  [5, 2e-3],
  [4, 1e-3],
  [3, 1e-4],
  [2, 5e-5],
  [1, 1e-5],
];

/** NOAA R-scale level (0–5) implied by a peak X-ray flux. */
function fluxToRScale(fluxWm2: number): number {
  return R_SCALE_FLOORS.find(([, floor]) => fluxWm2 >= floor)?.[0] ?? 0;
}

/**
 * Format X-ray flux for display: 2 significant digits in scientific notation, e.g.
 * "1.4e-6 W/m²". Raw GOES values carry ~16 digits of IEEE-754 noise, which is what
 * `fluxWm2Value` is for — a caller comparing numbers reads that field rather than
 * parsing this string (#4).
 */
function formatFlux(fluxWm2: number): string {
  return `${fluxWm2.toExponential(1)} W/m²`;
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
    fluxWm2Value: z
      .number()
      .describe(
        'Same quantity as fluxWm2, unformatted, so it can be compared without parsing the display string.',
      ),
    flareClass: z.string().describe('Flare classification letter: A, B, C, M, or X.'),
    flareClassFull: z
      .string()
      .nullable()
      .describe(
        'Flare class with magnitude, e.g. "B2.5" — null below the A1 floor of 1e-8 W/m² (zero and negative readings included), where SWPC\'s class scheme defines none.',
      ),
    satellite: z.number().describe('GOES satellite number.'),
  })
  .describe('One GOES X-ray flux reading with flare class.');

const FlareSchema = z
  .object({
    beginTime: z.string().describe('ISO 8601 UTC onset time (SWPC begin_time).'),
    maxTime: z.string().describe('ISO 8601 UTC time of peak flux (SWPC max_time).'),
    endTime: z
      .string()
      .nullable()
      .describe('ISO 8601 UTC decay time; null while the flare is still in progress.'),
    beginClass: z.string().describe('GOES class with magnitude at onset, e.g. "B4.2".'),
    maxClass: z
      .string()
      .describe('Peak GOES class with magnitude, e.g. "M5.2" — SWPC max_class, read as published.'),
    endClass: z
      .string()
      .nullable()
      .describe('GOES class with magnitude at decay; null while the flare is still in progress.'),
    peakFluxWm2: z
      .number()
      .describe('Peak long-channel (0.1–0.8 nm) flux in W/m² — SWPC max_xrlong.'),
    rScale: z
      .number()
      .describe(
        'NOAA R-scale level implied by the peak flux (0–5); 0 means below the R1 threshold.',
      ),
    satellite: z.number().describe('GOES satellite number the record came from.'),
  })
  .describe('One discrete GOES X-ray flare event.');

const F107Schema = z
  .object({
    observedTime: z
      .string()
      .describe(
        "ISO 8601 UTC time of the observation (normalized from the feed's Z-less tag). Up to ~24 h old — read it rather than treating the value as now.",
      ),
    fluxSfu: z
      .number()
      .describe('10.7 cm solar radio flux in solar flux units (sfu), measured at 2800 MHz.'),
    ninetyDayMeanSfu: z
      .number()
      .nullable()
      .describe('90-day mean flux in sfu; null when the selected record does not carry one.'),
    reportingSchedule: z
      .string()
      .describe(
        'Which of the three daily Penticton reports this is: "Morning", "Noon", or "Afternoon".',
      ),
  })
  .describe('Latest daily F10.7 index.');

const SolarRegionSchema = z
  .object({
    region: z.number().describe('NOAA active region number.'),
    location: z.string().describe('Heliographic location, e.g. "N17E47".'),
    latitude: z.string().describe('Heliographic latitude, e.g. "N17".'),
    spotClass: z
      .string()
      .describe(
        'Sunspot morphology class, e.g. "Dsi". Empty for a spotless region (plage), where magClass is empty and numberSpots is 0 too.',
      ),
    numberSpots: z.number().describe('Number of sunspots in this region; 0 for a spotless region.'),
    magClass: z.string().describe('Magnetic field class, e.g. "B"; empty for a spotless region.'),
    areaMillionths: z
      .number()
      .nullable()
      .describe(
        'Sunspot area in millionths of the solar hemisphere. Null for a spotless region (plage).',
      ),
    firstObserved: z
      .string()
      .describe('ISO 8601 UTC time SWPC first recorded this region, e.g. "2026-09-21T07:29:27Z".'),
    cFlareCount: z
      .number()
      .describe(
        'C-class flares SWPC attributed to this region on observedDate itself — a same-day tally updated during that day, unlike the probability fields, which cover the following day.',
      ),
    mFlareCount: z
      .number()
      .describe(
        'M-class flares SWPC attributed to this region on observedDate itself — a same-day tally updated during that day, unlike the probability fields, which cover the following day.',
      ),
    xFlareCount: z
      .number()
      .describe(
        'X-class flares SWPC attributed to this region on observedDate itself — a same-day tally updated during that day, unlike the probability fields, which cover the following day.',
      ),
    cFlareProbability: z
      .number()
      .describe(
        'Probability of a C-class flare from this region (%), for the UTC day AFTER observedDate — SWPC issues each day’s region probabilities against the previous day’s observation.',
      ),
    mFlareProbability: z
      .number()
      .describe(
        'Probability of an M-class flare from this region (%), for the UTC day AFTER observedDate — SWPC issues each day’s region probabilities against the previous day’s observation.',
      ),
    xFlareProbability: z
      .number()
      .describe(
        'Probability of an X-class flare from this region (%), for the UTC day AFTER observedDate — SWPC issues each day’s region probabilities against the previous day’s observation.',
      ),
    protonProbability: z
      .number()
      .describe(
        'Probability of a proton event from this region (%), for the UTC day AFTER observedDate — SWPC issues each day’s region probabilities against the previous day’s observation.',
      ),
    observedDate: z
      .string()
      .describe(
        'UTC date this region was observed. The three flare counts cover this day; the four probability fields cover the following day, not this one.',
      ),
  })
  .describe(
    "One active solar region: morphology, the flares SWPC attributed to it that day, and the next day's flare probabilities.",
  );

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
    'Solar flare and radiation storm picture: discrete flare events from the past week with peak class ' +
    'and R-scale level, recent GOES X-ray flux with flare-class labels (A/B/C/M/X) and class magnitude, ' +
    'the daily F10.7 cm solar radio flux, 3-day flare-class probabilities (C/M/X), active solar regions ' +
    'with per-region flare probabilities, and GOES integral proton flux at ≥10 MeV with NOAA S-scale. ' +
    'For operators tracking HF radio blackout (R-scale, driven by X-ray) and radiation storm risk ' +
    '(S-scale, driven by protons). Each active region carries the C/M/X flare counts SWPC attributed ' +
    'to it that UTC day, which identify the region driving current activity — the flare events ' +
    'themselves carry no region.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  input: z.object({
    include_regions: z
      .boolean()
      .default(true)
      .describe(
        'Include active solar region details (default true). Set false to skip region data and reduce response size.',
      ),
    flare_hours: z
      .number()
      .int()
      .min(1)
      .max(168)
      .default(24)
      .describe(
        'How far back to report discrete flare events, in hours before now, filtered on each ' +
          'flare’s onset time (1–168, default 24). The feed keeps a rolling 7 days, so 168 returns ' +
          'everything it carries. When the window comes back empty, the response names the newest ' +
          'flare the feed holds.',
      ),
  }),
  output: z.object({
    latestXray: XraySchema.nullable().describe(
      'Most recent GOES X-ray flux reading, null if unavailable.',
    ),
    recentXray: z
      .array(XraySchema)
      .describe('GOES X-ray flux readings from the past hour, oldest first.'),
    recentFlares: z
      .array(FlareSchema)
      .describe(
        'Discrete flare events whose onset falls within the flare_hours window, oldest first. Empty when no flare began in the window.',
      ),
    f107: F107Schema.nullable().describe(
      'Latest daily F10.7 solar radio flux — the Noon Penticton report, which is the value SWPC reports for the day. Null when the feed carries no such record.',
    ),
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
        'Currently active solar regions with same-day flare counts and next-day flare probabilities. Empty when include_regions=false or no regions are active.',
      ),
    fetchedAt: z.string().describe('ISO 8601 timestamp of when this data was fetched.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the requested flare_hours window returned no flare events — names the newest flare the feed carries, or reports that the feed itself returned none.',
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
    ctx.log.info('Fetching solar activity', {
      include_regions: input.include_regions,
      flare_hours: input.flare_hours,
    });
    const svc = getSpaceWeatherService();

    // Every composed feed is required: a Promise.allSettled with per-feed nulls would
    // make a null f107 ambiguous between "feed down" and "no data", so any feed
    // failure fails the call with its declared reason instead.
    const [xray, flares, f107, probs, protons, regions] = await Promise.all([
      svc.getXrayFlux(ctx),
      svc.getXrayFlares(ctx),
      svc.getF107(ctx),
      svc.getSolarProbabilities(ctx),
      svc.getProtonFlux(ctx),
      input.include_regions ? svc.getSolarRegions(ctx) : Promise.resolve(null),
    ]);

    /** One X-ray reading, with the class letter and the class-with-magnitude. */
    const toXrayReading = (r: { timeTag: string; fluxWm2: number; satellite: number }) => ({
      timeTag: r.timeTag,
      fluxWm2: formatFlux(r.fluxWm2),
      fluxWm2Value: r.fluxWm2,
      flareClass: classifyFlare(r.fluxWm2),
      flareClassFull: classifyFlareWithMagnitude(r.fluxWm2),
      satellite: r.satellite,
    });

    // Latest X-ray
    const latestXrayRaw = xray.length > 0 ? xray[xray.length - 1] : null;
    const latestXray = latestXrayRaw ? toXrayReading(latestXrayRaw) : null;

    // Recent X-ray — last hour. Compare epochs, not raw ISO strings: X-ray
    // timeTags carry no fractional seconds while toISOString() always emits
    // .mmm, so lexicographic >= disagrees with true chronology at the window
    // boundary (same class of bug already fixed in get-alerts, #6).
    const hourCutoff = new Date();
    hourCutoff.setHours(hourCutoff.getHours() - 1);
    const hourCutoffMs = hourCutoff.getTime();
    const recentXray = xray
      .filter((r) => new Date(r.timeTag).getTime() >= hourCutoffMs)
      .map(toXrayReading);

    // Flare events whose onset falls in the requested window. Epoch compare for the
    // same reason as the X-ray slice above: the cutoff carries milliseconds and the
    // feed's onset times do not, so a lexicographic compare disagrees with
    // chronology at the boundary.
    const flareCutoffMs = Date.now() - input.flare_hours * 3_600_000;
    const recentFlares = flares
      .filter((f) => new Date(f.beginTime).getTime() >= flareCutoffMs)
      .map((f) => ({
        beginTime: f.beginTime,
        maxTime: f.maxTime,
        endTime: f.endTime,
        beginClass: f.beginClass,
        maxClass: f.maxClass,
        endClass: f.endClass,
        peakFluxWm2: f.peakFluxWm2,
        rScale: fluxToRScale(f.peakFluxWm2),
        satellite: f.satellite,
      }));

    // One call — the notice field is last-wins, so a second would clobber the first.
    if (recentFlares.length === 0) {
      // The service orders the series oldest-first, so the last element is the newest.
      const newest = flares.at(-1);
      ctx.enrich.notice(
        newest
          ? `No flare events began in the requested ${input.flare_hours}-hour window; the newest flare the feed carries is ${newest.maxClass}, which began at ${newest.beginTime}.`
          : 'The feed returned no flare events.',
      );
    }

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
      recentFlares,
      f107: f107
        ? {
            observedTime: f107.observedTime,
            fluxSfu: f107.fluxSfu,
            ninetyDayMeanSfu: f107.ninetyDayMeanSfu,
            reportingSchedule: f107.reportingSchedule,
          }
        : null,
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
        areaMillionths: r.areaMillionths,
        firstObserved: r.firstObserved,
        cFlareCount: r.cFlareCount,
        mFlareCount: r.mFlareCount,
        xFlareCount: r.xFlareCount,
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
        `**Time:** ${x.timeTag} | **Class:** ${x.flareClass} (${x.flareClassFull ?? 'no magnitude — flux below the A1 floor'}) | **Flux:** ${x.fluxWm2} (raw ${x.fluxWm2Value}) | **Satellite:** GOES-${x.satellite}`,
      );
    }
    if (result.recentXray.length > 0) {
      lines.push('');
      lines.push('### X-ray (Past Hour)');
      for (const r of result.recentXray) {
        lines.push(
          `- ${r.timeTag}: ${r.flareClass} class ${r.flareClassFull ?? '(no magnitude)'} — ${r.fluxWm2} (raw ${r.fluxWm2Value}) | GOES-${r.satellite}`,
        );
      }
    }
    if (result.recentFlares.length > 0) {
      lines.push('');
      lines.push('### Flare Events');
      for (const f of result.recentFlares) {
        lines.push(
          `- **${f.maxClass}** peaked ${f.maxTime} at ${f.peakFluxWm2} W/m² — **R${f.rScale}** | began ${f.beginTime} as ${f.beginClass} | decayed ${f.endTime ?? 'in progress'} to ${f.endClass ?? 'in progress'} | GOES-${f.satellite}`,
        );
      }
    }
    if (result.f107) {
      const f = result.f107;
      lines.push('');
      lines.push('### F10.7 cm Solar Radio Flux');
      lines.push(
        `**Observed:** ${f.observedTime} (${f.reportingSchedule} report) | **Flux:** ${f.fluxSfu} sfu` +
          (f.ninetyDayMeanSfu != null ? ` | **90-day mean:** ${f.ninetyDayMeanSfu} sfu` : ''),
      );
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
        // SWPC nulls every morphology field together on a spotless region.
        const spotless = r.spotClass === '' && r.magClass === '' && r.numberSpots === 0;
        lines.push(
          `**AR${r.region}** — Location: ${r.location} | Latitude: ${r.latitude} | Observed: ${r.observedDate} | First observed: ${r.firstObserved}`,
        );
        const morphology = spotless
          ? 'Class: no spots (plage)'
          : `Class: ${r.spotClass}/${r.magClass} | Spots: ${r.numberSpots}`;
        const area =
          r.areaMillionths === null ? 'none' : `${r.areaMillionths} millionths of the hemisphere`;
        lines.push(`  ${morphology} | Area: ${area}`);
        lines.push(
          `  Flares on ${r.observedDate}: C=${r.cFlareCount} M=${r.mFlareCount} X=${r.xFlareCount}`,
        );
        lines.push(
          `  Flare probability, following day: C=${r.cFlareProbability}% M=${r.mFlareProbability}% X=${r.xFlareProbability}% Proton=${r.protonProbability}%`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
