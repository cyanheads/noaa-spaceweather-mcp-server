/**
 * @fileoverview Tests for the solar-position leaf module: geometric solar elevation
 * against independently published reference values, and the darkness classification
 * boundaries.
 * @module tests/services/solar-position.test
 */

import { describe, expect, it } from 'vitest';
import { darknessFor, solarElevationDeg } from '@/services/space-weather/solar-position.js';

/** Standard sunrise/sunset altitude: geometric elevation of the sun's center at 34′ refraction + 16′ semi-diameter. */
const SUNRISE_SUNSET_ELEVATION = -0.833;

/** Seattle as NOAA GML's solar calculator table lists it. */
const SEATTLE = { latitude: 47.6062, longitude: -122.3321 };

function elevationAt(iso: string, latitude: number, longitude: number): number {
  return solarElevationDeg(new Date(iso), latitude, longitude);
}

describe('solarElevationDeg', () => {
  /**
   * NOAA GML Solar Calculator, sunrise/sunset tables for 2026 at 47.6062, −122.3321
   * (America/Los_Angeles, UTC−7 in September): Sep 22 sunrise 06:56, sunset 19:07,
   * solar noon 13:02:08. The published times are rounded to the minute, so each is
   * checked as a crossing of the −0.833° altitude within ±1 minute of it.
   */
  it('crosses the sunset altitude within a minute of NOAA’s published Seattle sunset', () => {
    // 19:07 PDT on Sep 22 is 02:07Z on Sep 23.
    const before = elevationAt('2026-09-23T02:06:00Z', SEATTLE.latitude, SEATTLE.longitude);
    const after = elevationAt('2026-09-23T02:08:00Z', SEATTLE.latitude, SEATTLE.longitude);

    expect(before).toBeGreaterThan(SUNRISE_SUNSET_ELEVATION);
    expect(after).toBeLessThan(SUNRISE_SUNSET_ELEVATION);
  });

  it('crosses the sunrise altitude within a minute of NOAA’s published Seattle sunrise', () => {
    // 06:56 PDT is 13:56Z.
    const before = elevationAt('2026-09-22T13:55:00Z', SEATTLE.latitude, SEATTLE.longitude);
    const after = elevationAt('2026-09-22T13:57:00Z', SEATTLE.latitude, SEATTLE.longitude);

    expect(before).toBeLessThan(SUNRISE_SUNSET_ELEVATION);
    expect(after).toBeGreaterThan(SUNRISE_SUNSET_ELEVATION);
  });

  it('peaks at NOAA’s published Seattle solar noon, at 90° − latitude near the equinox', () => {
    // 13:02:08 PDT is 20:02:08Z; the declination is ~+0.1° a day before the equinox.
    const noon = elevationAt('2026-09-22T20:02:08Z', SEATTLE.latitude, SEATTLE.longitude);
    const earlier = elevationAt('2026-09-22T19:52:08Z', SEATTLE.latitude, SEATTLE.longitude);
    const later = elevationAt('2026-09-22T20:12:08Z', SEATTLE.latitude, SEATTLE.longitude);

    expect(noon).toBeGreaterThan(earlier);
    expect(noon).toBeGreaterThan(later);
    expect(noon).toBeCloseTo(90 - SEATTLE.latitude, 0);
  });

  it('puts the sun 19.6° up at (−64, 157) at 2026-09-22T22:45Z', () => {
    expect(elevationAt('2026-09-22T22:45:00Z', -64, 157)).toBeCloseTo(19.63, 1);
  });

  it('keeps the sun above the horizon at local midnight in the June polar day', () => {
    // 15°E: local midnight ≈ 23:00Z. Midnight elevation at 78°N is 78 + 23.4 − 90.
    expect(elevationAt('2026-06-20T23:00:00Z', 78, 15)).toBeCloseTo(11.4, 0);
  });

  it('keeps the sun below the horizon at local noon in the December polar night', () => {
    // Noon elevation is 90 − latitude − 23.4: nautical at 78°N, below −12° only past ~78.6°N.
    expect(elevationAt('2026-12-21T11:00:00Z', 78, 15)).toBeCloseTo(-11.4, 0);
    expect(elevationAt('2026-12-21T11:00:00Z', 80, 15)).toBeCloseTo(-13.4, 0);
  });

  it('reads the same at longitude 180 and −180', () => {
    const at = '2026-09-22T12:00:00Z';
    expect(elevationAt(at, 51, 180)).toBeCloseTo(elevationAt(at, 51, -180), 9);
  });

  it('matches the declination at the poles, where the hour angle drops out', () => {
    // At a pole elevation equals the declination: −23.44° at the December solstice.
    expect(elevationAt('2026-12-21T12:00:00Z', 90, 0)).toBeCloseTo(-23.44, 1);
    expect(elevationAt('2026-12-21T12:00:00Z', -90, 0)).toBeCloseTo(23.44, 1);
  });
});

describe('darknessFor', () => {
  it.each([
    [90, 'day'],
    [0.1, 'day'],
    [0, 'day'],
    [-0.1, 'civil_twilight'],
    [-6, 'civil_twilight'],
    [-6.1, 'nautical_twilight'],
    [-12, 'nautical_twilight'],
    [-12.1, 'dark'],
    [-90, 'dark'],
  ] as const)('classifies %s° as %s', (elevation, darkness) => {
    expect(darknessFor(elevation)).toBe(darkness);
  });
});
