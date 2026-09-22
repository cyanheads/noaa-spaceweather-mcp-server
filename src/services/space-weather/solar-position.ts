/**
 * @fileoverview Solar position: geometric solar elevation for a UTC instant and a
 * geographic coordinate, and the sky-darkness state that elevation implies. Pure and
 * dependency-free; used to gate aurora visibility on whether the sun is up.
 * @module services/space-weather/solar-position
 */

const DEG_TO_RAD = Math.PI / 180;

const MS_PER_DAY = 86_400_000;
const MINUTES_PER_DAY = 1440;

/** Julian Date of the Unix epoch, 1970-01-01T00:00Z. */
const UNIX_EPOCH_JD = 2_440_587.5;

/** Julian Date of the J2000.0 epoch, 2000-01-01T12:00 TT. */
const J2000_JD = 2_451_545;

/**
 * Geometric solar elevation in degrees (−90 to 90) at `at`, for a geographic
 * (WGS84) latitude and longitude. No atmospheric refraction is applied, so the value
 * is the sun's true angle above the horizon, not its apparent one.
 *
 * The NOAA Global Monitoring Laboratory solar-position algorithm (after Meeus,
 * *Astronomical Algorithms*): mean orbital elements in Julian centuries from J2000,
 * the equation of center, nutation- and aberration-corrected apparent longitude, and
 * the equation of time for the hour angle. Accurate to well under 0.1° across
 * 1901–2099, which is ample for a threshold at 0°, −6°, and −12°. UTC is used for TT;
 * the ~70 s difference moves the sun by about 0.3′.
 */
export function solarElevationDeg(at: Date, latitude: number, longitude: number): number {
  const ms = at.getTime();
  const julianCenturies = (ms / MS_PER_DAY + UNIX_EPOCH_JD - J2000_JD) / 36_525;
  const t = julianCenturies;

  const meanLongitude = (280.46646 + t * (36_000.76983 + t * 0.0003032)) % 360;
  const meanAnomaly = (357.52911 + t * (35_999.05029 - 0.0001537 * t)) * DEG_TO_RAD;
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  const equationOfCenter =
    Math.sin(meanAnomaly) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnomaly) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnomaly) * 0.000289;

  const ascendingNode = (125.04 - 1934.136 * t) * DEG_TO_RAD;
  const apparentLongitude =
    (meanLongitude + equationOfCenter - 0.00569 - 0.00478 * Math.sin(ascendingNode)) * DEG_TO_RAD;

  const meanObliquity =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = (meanObliquity + 0.00256 * Math.cos(ascendingNode)) * DEG_TO_RAD;

  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparentLongitude));

  const y = Math.tan(obliquity / 2) ** 2;
  const l0 = meanLongitude * DEG_TO_RAD;
  const equationOfTimeMinutes =
    (4 / DEG_TO_RAD) *
    (y * Math.sin(2 * l0) -
      2 * eccentricity * Math.sin(meanAnomaly) +
      4 * eccentricity * y * Math.sin(meanAnomaly) * Math.cos(2 * l0) -
      0.5 * y * y * Math.sin(4 * l0) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnomaly));

  const utcMinutes = (((ms % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY) / 60_000;
  const trueSolarMinutes =
    (((utcMinutes + equationOfTimeMinutes + 4 * longitude) % MINUTES_PER_DAY) + MINUTES_PER_DAY) %
    MINUTES_PER_DAY;
  const hourAngle = (trueSolarMinutes / 4 - 180) * DEG_TO_RAD;

  const lat = latitude * DEG_TO_RAD;
  const cosZenith =
    Math.sin(lat) * Math.sin(declination) +
    Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
  // Clamp against float drift past ±1, where acos is undefined.
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith)));
  return 90 - zenith / DEG_TO_RAD;
}

/** Sky-darkness states, brightest first. */
export const DARKNESS_STATES = ['day', 'civil_twilight', 'nautical_twilight', 'dark'] as const;

export type Darkness = (typeof DARKNESS_STATES)[number];

/**
 * The darkness state for a solar elevation in degrees: `day` at 0° and above,
 * `civil_twilight` from −6° up to 0°, `nautical_twilight` from −12° up to −6°, and
 * `dark` below −12°. Each boundary value belongs to the brighter state.
 */
export function darknessFor(elevationDeg: number): Darkness {
  if (elevationDeg >= 0) return 'day';
  if (elevationDeg >= -6) return 'civil_twilight';
  if (elevationDeg >= -12) return 'nautical_twilight';
  return 'dark';
}
