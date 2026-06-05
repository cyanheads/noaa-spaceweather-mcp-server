/**
 * @fileoverview Domain types for NOAA Space Weather Prediction Center feeds.
 * @module services/space-weather/types
 */

// ── NOAA Scale types ───────────────────────────────────────────────────────

/** A single NOAA storm scale entry (R, S, or G) for one forecast period. */
export interface NoaaScaleEntry {
  /** Storm scale category: R (radio blackout), S (solar radiation), G (geomagnetic). */
  category: 'R' | 'S' | 'G';
  /** Probability of a major event (%), or null when not applicable. */
  majorProb: number | null;
  /** Probability of a minor event (%), or null when not applicable. */
  minorProb: number | null;
  /** Storm scale level 0–5. */
  scale: number;
  /** Human-readable descriptor, e.g. "Moderate". Empty string when scale is 0. */
  text: string;
}

/** NOAA storm scales for one forecast period. */
export interface NoaaScalesPeriod {
  /** Date string for this period, e.g. "2026-06-04". */
  date: string;
  /** Geomagnetic storm scale (G). */
  G: NoaaScaleEntry;
  /** Radio blackout scale (R). */
  R: NoaaScaleEntry;
  /** Solar radiation storm scale (S). */
  S: NoaaScaleEntry;
  /** UTC time stamp, e.g. "15:00:00". */
  time: string;
}

/** All NOAA storm scale periods from the feed. */
export interface NoaaScalesData {
  /** 3-day forecast array (keys "1", "2", "3"). */
  forecast: NoaaScalesPeriod[];
  /** Today's observed/current values (key "0"). */
  today: NoaaScalesPeriod;
}

// ── Kp index types ─────────────────────────────────────────────────────────

/** One observed Kp index reading. */
export interface KpObservation {
  /** Running mean of geomagnetic activity. */
  aRunning: number | null;
  /** Aurora latitude guidance for this Kp level, e.g. "Aurora possible to ~55°". */
  auroraLatitude: string;
  /** Corresponding NOAA G-scale level (0–5). */
  gScale: number;
  /** Kp value 0–9. */
  kp: number;
  /** Number of stations contributing. */
  stationCount: number | null;
  /** ISO 8601 time tag for the 3-hour interval. */
  timeTag: string;
}

/** One Kp forecast point. */
export interface KpForecast {
  /** Forecasted Kp value. */
  kp: number;
  /** NOAA scale string, e.g. "G1", or null when not available. */
  noaaScale: string | null;
  /** "observed" or "predicted". */
  observed: string;
  /** ISO 8601 time tag. */
  timeTag: string;
}

// ── Aurora / OVATION types ─────────────────────────────────────────────────

/** OVATION aurora forecast metadata. */
export interface AuroraForecastMeta {
  /** Forecast valid time, e.g. "2026-06-04T15:02:00Z". */
  forecastTime: string;
  /** Observation time, e.g. "2026-06-04T14:32:00Z". */
  observationTime: string;
}

/** Aurora probability for a single grid cell. */
export interface AuroraGridPoint {
  /** Aurora probability 0–100. */
  auroraPercent: number;
  /** Latitude −90–90. */
  latitude: number;
  /** Longitude −180–180. */
  longitude: number;
}

/** Full OVATION aurora forecast. */
export interface AuroraForecastData {
  /** Grid of aurora probability points (1° resolution). */
  grid: AuroraGridPoint[];
  meta: AuroraForecastMeta;
}

// ── Solar wind types ───────────────────────────────────────────────────────

/** One real-time plasma measurement from DSCOVR. */
export interface SolarWindPlasma {
  /** Proton density in particles/cm³. Null when the sensor returns -9999. */
  densityPerCm3: number | null;
  /** Solar wind speed in km/s. Null when missing. */
  speedKmS: number | null;
  /** Proton temperature in Kelvin. Null when missing. */
  temperatureK: number | null;
  /** ISO 8601 time tag. */
  timeTag: string;
}

/** One real-time magnetic field measurement from DSCOVR. */
export interface SolarWindMag {
  /** Total field magnitude Bt (nT). Null when missing. */
  bt: number | null;
  /** Bx component in GSM coordinates (nT). Null when missing. */
  bxGsm: number | null;
  /** By component in GSM coordinates (nT). Null when missing. */
  byGsm: number | null;
  /** Bz component in GSM coordinates (nT). Null when missing. */
  bzGsm: number | null;
  /** ISO 8601 time tag. */
  timeTag: string;
}

// ── Solar activity types ───────────────────────────────────────────────────

/** One GOES X-ray flux reading. */
export interface XrayFlux {
  /** Energy band descriptor. */
  energy: string;
  /** Flux in W/m² (the "0.1-0.8nm" long channel). */
  fluxWm2: number;
  /** Satellite number. */
  satellite: number;
  /** ISO 8601 time tag. */
  timeTag: string;
}

/** Active solar region (NOAA active region). */
export interface SolarRegion {
  /** C-class flare probability (%). */
  cFlareProbability: number;
  /** Heliographic latitude, e.g. "N17". */
  latitude: string;
  /** Heliographic location, e.g. "N17E47". */
  location: string;
  /** Magnetic class. */
  magClass: string;
  /** M-class flare probability (%). */
  mFlareProbability: number;
  /** Number of sunspots. */
  numberSpots: number;
  /** Observation date. */
  observedDate: string;
  /** Proton event probability (%). */
  protonProbability: number;
  /** NOAA active region number. */
  region: number;
  /** Spot classification. */
  spotClass: string;
  /** X-class flare probability (%). */
  xFlareProbability: number;
}

/** Flare probability forecast for one day. */
export interface SolarProbabilities {
  /** Probability of a C-class flare (%). */
  cClass1Day: number;
  /** Forecast date. */
  date: string;
  /** Probability of an M-class flare (%). */
  mClass1Day: number;
  /** Probability of ≥10 MeV proton event (%). */
  protons1Day: number;
  /** Probability of an X-class flare (%). */
  xClass1Day: number;
}

/** One integral proton flux reading from GOES. */
export interface ProtonFlux {
  /** Energy channel, e.g. ">=10 MeV". */
  energy: string;
  /** Flux in particle flux units (pfu). */
  fluxPfu: number;
  /** Satellite number. */
  satellite: number;
  /** ISO 8601 time tag. */
  timeTag: string;
}

// ── Alert types ────────────────────────────────────────────────────────────

/** Parsed SWPC alert/watch/warning. */
export interface SpaceWeatherAlert {
  /** ISO 8601 issue datetime. */
  issueDatetime: string;
  /** Severity level (numeric suffix from product code, 0 when not applicable). */
  level: number;
  /** Full plain-text message body. */
  message: string;
  /** Short parsed phenomenon, e.g. "Geomagnetic", "Radio Blackout", "Solar Radiation". */
  phenomenon: string;
  /** Product code, e.g. "WARK04", "ALTK07", "SUMS". */
  productId: string;
  /** Product type derived from the code prefix. */
  productType: 'Warning' | 'Watch' | 'Alert' | 'Summary' | 'Other';
  /** Valid from (parsed from message), null if not found. */
  validFrom: string | null;
  /** Valid to (parsed from message), null if not found. */
  validTo: string | null;
}
