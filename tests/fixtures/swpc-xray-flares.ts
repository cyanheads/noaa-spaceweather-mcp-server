/**
 * @fileoverview Records from the GOES X-ray flare feed
 * (`/json/goes/primary/xray-flares-7-day.json`) as upstream served them on
 * 2026-09-17, verbatim. The feed publishes each flare's class *with* magnitude,
 * so it is also the only available ground truth for the derived
 * class-with-magnitude on the X-ray flux readings: SWPC truncates the decade
 * quotient to one decimal, and every pair below reproduces exactly under
 * truncation while only 11 of 29 reproduce under rounding.
 * @module tests/fixtures/swpc-xray-flares
 */

/**
 * Every `[max_xrlong, max_class]` pair the 7-day capture carried, in feed order.
 * The window held only B- and C-class flares, so the M/X decades and the
 * decade-edge and zero-flux cases are covered by synthetic values alongside it.
 */
export const PUBLISHED_FLARE_CLASSES: readonly [flux: number, maxClass: string][] = [
  [8.120343295558996e-7, 'B8.1'],
  [6.569279094037483e-7, 'B6.5'],
  [5.391784725361504e-7, 'B5.3'],
  [5.829851943417452e-7, 'B5.8'],
  [5.821242439196794e-7, 'B5.8'],
  [7.802497634656902e-7, 'B7.8'],
  [8.548950631848129e-7, 'B8.5'],
  [5.264486162559479e-7, 'B5.2'],
  [6.133620900072856e-7, 'B6.1'],
  [5.59188890747464e-7, 'B5.5'],
  [7.750425083941082e-7, 'B7.7'],
  [6.374278882503859e-7, 'B6.3'],
  [8.930078934099583e-7, 'B8.9'],
  [8.319618700625142e-7, 'B8.3'],
  [0.000005856938514625654, 'C5.8'],
  [8.319474318341236e-7, 'B8.3'],
  [4.7752649834365e-7, 'B4.7'],
  [6.765262128283211e-7, 'B6.7'],
  [9.67197024692723e-7, 'B9.6'],
  [5.305181502990308e-7, 'B5.3'],
  [5.253311883279821e-7, 'B5.2'],
  [5.592851266555954e-7, 'B5.5'],
  [9.299994871980743e-7, 'B9.2'],
  [9.986259783545393e-7, 'B9.9'],
  [5.476837259266176e-7, 'B5.4'],
  [3.628480556017166e-7, 'B3.6'],
  [3.881270060901443e-7, 'B3.8'],
  [3.453629631167132e-7, 'B3.4'],
  [3.2793295190458593e-7, 'B3.2'],
];

/**
 * Four verbatim feed records — the oldest and newest of the capture plus two
 * from the middle, one of which carries the `max_ratio` / `max_ratio_time` nulls
 * that 8 of the 29 records had. All 12 upstream keys are present on every
 * record, which is what makes an absent key a shape break rather than sparsity.
 */
export const SWPC_XRAY_FLARE_FEED = [
  {
    time_tag: '2026-09-10T20:00:00Z',
    begin_time: '2026-09-10T20:00:00Z',
    begin_class: 'B4.2',
    max_time: '2026-09-10T20:07:00Z',
    max_class: 'B8.1',
    max_xrlong: 8.120343295558996e-7,
    max_ratio: 0.27831748412238544,
    max_ratio_time: '2026-09-10T20:01:50Z',
    current_int_xrlong: 0.0005379929207265377,
    end_time: '2026-09-10T20:12:00Z',
    end_class: 'B6.0',
    satellite: 18,
  },
  {
    time_tag: '2026-09-12T16:18:00Z',
    begin_time: '2026-09-12T16:18:00Z',
    begin_class: 'B6.8',
    max_time: '2026-09-12T16:23:00Z',
    max_class: 'B8.3',
    max_xrlong: 8.319618700625142e-7,
    max_ratio: 0.15331668144354993,
    max_ratio_time: '2026-09-12T16:19:22Z',
    current_int_xrlong: 0.000505169213283807,
    end_time: '2026-09-12T16:27:00Z',
    end_class: 'B7.5',
    satellite: 18,
  },
  {
    time_tag: '2026-09-16T11:46:00Z',
    begin_time: '2026-09-16T11:46:00Z',
    begin_class: 'B2.5',
    max_time: '2026-09-16T11:53:00Z',
    max_class: 'B3.4',
    max_xrlong: 3.453629631167132e-7,
    max_ratio: null,
    max_ratio_time: null,
    current_int_xrlong: 0.00034791059442795813,
    end_time: '2026-09-16T12:03:00Z',
    end_class: 'B2.9',
    satellite: 18,
  },
  {
    time_tag: '2026-09-17T12:08:00Z',
    begin_time: '2026-09-17T12:08:00Z',
    begin_class: 'B2.2',
    max_time: '2026-09-17T12:16:00Z',
    max_class: 'B3.2',
    max_xrlong: 3.2793295190458593e-7,
    max_ratio: null,
    max_ratio_time: null,
    current_int_xrlong: 0.00031226599821820855,
    end_time: '2026-09-17T12:24:00Z',
    end_class: 'B2.7',
    satellite: 18,
  },
];

/**
 * Records from `/json/f107_cm_flux.json` as served on 2026-09-17, newest-first.
 * Three reports per UTC day, and `avg_begin_date` / `ninety_day_mean` /
 * `rec_count` populated only on the Noon record — the one SWPC's own
 * `/products/summary/10cm-flux.json` reports as the day's value. Time tags carry
 * no `Z`.
 */
export const SWPC_F107_FEED = [
  {
    time_tag: '2026-09-16T22:00:00',
    frequency: 2800,
    flux: 100,
    reporting_schedule: 'Afternoon',
    avg_begin_date: null,
    ninety_day_mean: null,
    rec_count: null,
  },
  {
    time_tag: '2026-09-16T20:00:00',
    frequency: 2800,
    flux: 100,
    reporting_schedule: 'Noon',
    avg_begin_date: '2026-06-19T20:00:00',
    ninety_day_mean: 126,
    rec_count: 90,
  },
  {
    time_tag: '2026-09-16T17:00:00',
    frequency: 2800,
    flux: 100,
    reporting_schedule: 'Morning',
    avg_begin_date: null,
    ninety_day_mean: null,
    rec_count: null,
  },
  {
    time_tag: '2026-09-15T22:00:00',
    frequency: 2800,
    flux: 103,
    reporting_schedule: 'Afternoon',
    avg_begin_date: null,
    ninety_day_mean: null,
    rec_count: null,
  },
  {
    time_tag: '2026-09-15T20:00:00',
    frequency: 2800,
    flux: 105,
    reporting_schedule: 'Noon',
    avg_begin_date: '2026-06-18T20:00:00',
    ninety_day_mean: 127,
    rec_count: 90,
  },
];
