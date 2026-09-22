/**
 * @fileoverview Domain types for NOAA Space Weather Prediction Center feeds.
 * @module services/space-weather/types
 */

// ── NOAA Scale types ───────────────────────────────────────────────────────

/**
 * A single NOAA storm scale entry (R, S, or G) for one period.
 *
 * `scale`/`text` and the two probability fields are alternatives, not companions:
 * SWPC issues a *level* for a period it has observed and a *probability* for one it
 * is forecasting. Today's period carries R/S/G levels with null probabilities; a
 * forecast period carries a G level but only probabilities for R and S, with
 * `scale`/`text` null. A null `scale` therefore means "upstream issues no level for
 * this period", which is a different claim from level 0 — never resolve one to the
 * other (#23).
 */
export interface NoaaScaleEntry {
  /** Storm scale category: R (radio blackout), S (solar radiation), G (geomagnetic). */
  category: 'R' | 'S' | 'G';
  /**
   * Probability of a major event (%), or null when upstream issued none. R only —
   * SWPC's `MajorProb`, the chance of R3 or greater.
   */
  majorProb: number | null;
  /**
   * Probability of a minor event (%), or null when upstream issued none. Carries
   * SWPC's `MinorProb` for R (R1–R2) and its single `Prob` for S (S1 or greater)
   * and G.
   */
  minorProb: number | null;
  /** Storm scale level 0–5, or null when upstream issues no level for this period. */
  scale: number | null;
  /**
   * Human-readable descriptor, e.g. "moderate"; SWPC's literal "none" at level 0.
   * Null when upstream issues no level for this period.
   */
  text: string | null;
}

/** NOAA storm scales for one period. */
export interface NoaaScalesPeriod {
  /** Date string for this period, e.g. "2026-06-04". */
  date: string;
  /** Geomagnetic storm scale (G). */
  G: NoaaScaleEntry;
  /**
   * The period's `date` and `time` as one explicit ISO 8601 UTC instant, e.g.
   * "2026-06-04T15:00:00Z". Empty string when the feed omits either half.
   */
  observedAt: string;
  /** Radio blackout scale (R). */
  R: NoaaScaleEntry;
  /** Solar radiation storm scale (S). */
  S: NoaaScaleEntry;
  /** UTC time stamp, e.g. "15:00:00". */
  time: string;
}

/** All NOAA storm scale periods from the feed. */
export interface NoaaScalesData {
  /**
   * SWPC's 3-day forecast (keys "1", "2", "3"), oldest first. The series opens on
   * today — key "1" repeats key "0"'s `DateStamp` — and runs through the next two
   * UTC days.
   */
  forecast: NoaaScalesPeriod[];
  /** Today's observed/current values (key "0"). */
  today: NoaaScalesPeriod;
  /**
   * The R/S/G levels SWPC assessed for the previous UTC day (key "-1"), or null when the
   * feed carries no such key. Its `date` is that day; its `time` — and so `observedAt` —
   * is the feed's generation clock, which moves in lockstep with every other period's,
   * and says nothing about when that day's levels were observed.
   */
  yesterday: NoaaScalesPeriod | null;
}

// ── Forecast Discussion types ──────────────────────────────────────────────

/** One topic section of the SWPC Forecast Discussion product. */
export interface ForecastDiscussionSection {
  /**
   * Forecast text for the next three days, from the section's ".Forecast..." block.
   * Null when the section carries no such block.
   */
  forecast: string | null;
  /**
   * Past-24-hour summary, from the section's ".24 hr Summary..." block. Null when
   * the block carries no text.
   */
  summary: string | null;
  /** Section heading, e.g. "Solar Activity", "Geospace". */
  topic: string;
}

/**
 * The SWPC Forecast Discussion — the forecaster-written narrative behind the storm
 * scales. Parsed from the `/text/discussion.txt` product.
 */
export interface ForecastDiscussion {
  /**
   * Issue time as ISO 8601 UTC, from the product's ":Issued:" line. Falls back to
   * that line's raw text when it does not match the SWPC datetime shape, and is null
   * when the product carries no such line at all — a body with topic sections but no
   * issue line still parses, and there is nothing to derive a time from. HTTP
   * `Last-Modified` is not issuance time and is never read for this.
   */
  issued: string | null;
  /** One entry per topic section, in product order. */
  sections: ForecastDiscussionSection[];
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
  /** Longitude −179–180: the feed's 0–359 normalized, so there is a 180 column and no −180 one. */
  longitude: number;
}

/** Full OVATION aurora forecast. */
export interface AuroraForecastData {
  /** Grid of aurora probability points (1° resolution). */
  grid: AuroraGridPoint[];
  meta: AuroraForecastMeta;
}

// ── Solar wind types ───────────────────────────────────────────────────────

/**
 * One real-time plasma measurement from the spacecraft SWPC currently flags as
 * active in the RTSW feed. Records are ordered oldest-first.
 */
export interface SolarWindPlasma {
  /** Proton density in particles/cm³. Null when missing. */
  densityPerCm3: number | null;
  /**
   * Reporting spacecraft as named by the feed, e.g. "SOLAR1", "ACE", "IMAP".
   * Upstream controls this set, so it is an open string rather than a union.
   */
  source: string;
  /** Solar wind speed in km/s. Null when missing. */
  speedKmS: number | null;
  /** Proton temperature in Kelvin. Null when missing. */
  temperatureK: number | null;
  /** ISO 8601 time tag. */
  timeTag: string;
}

/**
 * One real-time magnetic field measurement from the spacecraft SWPC currently
 * flags as active in the RTSW feed. Records are ordered oldest-first.
 */
export interface SolarWindMag {
  /** Total field magnitude Bt (nT). Null when missing. */
  bt: number | null;
  /** Bx component in GSM coordinates (nT). Null when missing. */
  bxGsm: number | null;
  /** By component in GSM coordinates (nT). Null when missing. */
  byGsm: number | null;
  /** Bz component in GSM coordinates (nT). Null when missing. */
  bzGsm: number | null;
  /**
   * Reporting spacecraft as named by the feed, e.g. "SOLAR1", "ACE", "IMAP".
   * Upstream controls this set, so it is an open string rather than a union.
   */
  source: string;
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

/**
 * One discrete GOES X-ray flare event.
 *
 * Every class is read from the feed, never derived: SWPC publishes `begin_class`,
 * `max_class`, and `end_class` with their magnitudes already stated. The record is
 * published at onset — `time_tag` equals `begin_time` on every record — so a flare
 * still in progress has no decay time or class yet and both read null.
 *
 * The feed's `max_ratio` / `max_ratio_time` are not mapped, and neither is
 * `current_int_xrlong`: it is an *integrated* flux running about four decades above
 * the peak, so reading it as a peak or a class would misreport the flare by orders
 * of magnitude.
 */
export interface XrayFlare {
  /** GOES class with magnitude at onset, e.g. "B4.2". */
  beginClass: string;
  /** ISO 8601 UTC onset time. */
  beginTime: string;
  /** GOES class with magnitude at decay; null while the flare is still in progress. */
  endClass: string | null;
  /** ISO 8601 UTC decay time; null while the flare is still in progress. */
  endTime: string | null;
  /** Peak GOES class with magnitude, e.g. "M5.2" — SWPC's `max_class`, as published. */
  maxClass: string;
  /** ISO 8601 UTC time of peak flux. */
  maxTime: string;
  /** Peak long-channel (0.1–0.8 nm) flux in W/m² — SWPC's `max_xrlong`. */
  peakFluxWm2: number;
  /** GOES satellite number the record came from. */
  satellite: number;
}

/**
 * One daily F10.7 solar radio flux report, measured at 2800 MHz by the Penticton
 * Radio Observatory (NRC Canada).
 *
 * The feed carries three reports per UTC day (Morning, Noon, Afternoon) and only
 * the Noon record carries a 90-day mean — it is also the value SWPC's own one-value
 * summary product reports for the day. The observation can be up to ~24 h old, so
 * `observedTime` rides with the value rather than being read as "now".
 */
export interface F107Observation {
  /** 10.7 cm solar radio flux in solar flux units (sfu). */
  fluxSfu: number;
  /** 90-day mean flux in sfu; null when the selected record carries none. */
  ninetyDayMeanSfu: number | null;
  /** ISO 8601 UTC observation time, normalized from the feed's Z-less tag. */
  observedTime: string;
  /** Which of the three daily reports this is: "Morning", "Noon", or "Afternoon". */
  reportingSchedule: string;
}

/**
 * Active solar region (NOAA active region).
 *
 * The four probability fields cover the UTC day *after* {@link SolarRegion.observedDate},
 * not that date: SWPC heads the block "Region Flare Probabilities for <day+1>" over a
 * `:Reg_Prob: <day>` table, and the JSON feed's `observed_date` is the `:Reg_Prob:`
 * date. Read alongside `observedDate` in the same record, they otherwise look like
 * same-day figures.
 *
 * The three flare counts are the opposite: same-day tallies of the flares SWPC
 * attributed to this region on `observedDate` itself, updated during the day.
 *
 * A spotless region (plage) arrives with `area`, `spot_class`, `number_spots`, and
 * `mag_class` all null together: `areaMillionths` is null, and the morphology fields
 * read `''` / 0 / `''`.
 */
export interface SolarRegion {
  /**
   * Sunspot area in millionths of the solar hemisphere; null for a spotless region.
   */
  areaMillionths: number | null;
  /** C-class flares SWPC attributed to this region on `observedDate`. */
  cFlareCount: number;
  /** C-class flare probability (%), for the UTC day after `observedDate`. */
  cFlareProbability: number;
  /** ISO 8601 UTC time SWPC first recorded this region. */
  firstObserved: string;
  /** Heliographic latitude, e.g. "N17". */
  latitude: string;
  /** Heliographic location, e.g. "N17E47". */
  location: string;
  /** Magnetic class; empty for a spotless region. */
  magClass: string;
  /** M-class flares SWPC attributed to this region on `observedDate`. */
  mFlareCount: number;
  /** M-class flare probability (%), for the UTC day after `observedDate`. */
  mFlareProbability: number;
  /** Number of sunspots; 0 for a spotless region. */
  numberSpots: number;
  /** UTC observation date; the probability fields cover the following day. */
  observedDate: string;
  /** Proton event probability (%), for the UTC day after `observedDate`. */
  protonProbability: number;
  /** NOAA active region number. */
  region: number;
  /** Spot classification; empty for a spotless region. */
  spotClass: string;
  /** X-class flares SWPC attributed to this region on `observedDate`. */
  xFlareCount: number;
  /** X-class flare probability (%), for the UTC day after `observedDate`. */
  xFlareProbability: number;
}

/**
 * Flare probability forecast for one day. Each probability is exposed under both
 * a legacy date-specific name (`*1Day`) and a date-neutral alias — the latter
 * reads correctly for every forecast date, not just day one (#16). The two
 * always carry the same value.
 */
export interface SolarProbabilities {
  /** Probability of a C-class flare (%). */
  cClass1Day: number;
  /** Probability of a C-class flare (%). Date-neutral alias of cClass1Day. */
  cClassProbability: number;
  /** Forecast date. */
  date: string;
  /** Probability of an M-class flare (%). */
  mClass1Day: number;
  /** Probability of an M-class flare (%). Date-neutral alias of mClass1Day. */
  mClassProbability: number;
  /** Probability of a ≥10 MeV proton event (%). Date-neutral alias of protons1Day. */
  protonEventProbability: number;
  /** Probability of ≥10 MeV proton event (%). */
  protons1Day: number;
  /** Probability of an X-class flare (%). */
  xClass1Day: number;
  /** Probability of an X-class flare (%). Date-neutral alias of xClass1Day. */
  xClassProbability: number;
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
  /**
   * True when this record is a cancellation notice ("CANCEL WARNING:" / "CANCEL WATCH:" /
   * "CANCEL ALERT:" headline) rather than a product in force. SWPC cancels by issuing a
   * new record under the same message code, so this is per-record: the same code cycles
   * between in-force and cancelled. "EXTENDED"/"CONTINUED" records are still in force and
   * are not cancellations.
   */
  cancelled: boolean;
  /**
   * The issue time a cancellation restates for its target ("Original Issue Time:"), as
   * ISO 8601 UTC; null on every other record. SWPC reuses a serial within a message
   * code on a corrected reissue, so this is what disambiguates which record
   * {@link SpaceWeatherAlert.cancelsSerialNumber} names.
   */
  cancelsOriginalIssueDatetime: string | null;
  /**
   * The serial this record cancels ("Cancel Serial Number:"); null when it cancels
   * nothing. Resolves against {@link SpaceWeatherAlert.serialNumber} under this
   * record's own {@link SpaceWeatherAlert.messageCode} — serials are per-code counters,
   * not global identifiers. The "Extension to Serial Number:" and "Continuation of
   * Serial Number:" links mean the referenced product is still in force and never
   * populate this.
   */
  cancelsSerialNumber: string | null;
  /** ISO 8601 issue datetime. */
  issueDatetime: string;
  /**
   * NOAA scale level 0–5, read from the scale stated in the message body. 0 means the
   * product states no NOAA scale (K4 warnings sit below the G-scale; radio-burst and
   * electron-flux alerts sit outside the scales) — it is not a severity of zero.
   */
  level: number;
  /** Full plain-text message body. */
  message: string;
  /**
   * Full SWPC "Space Weather Message Code" parsed from the message body, e.g.
   * "WARK04", "ALTEF3". Falls back to the short feed ID when the body carries no
   * message-code line.
   */
  messageCode: string;
  /**
   * NOAA scale the body states, e.g. "G1", "R2", "S1"; null when the product states
   * none. Carries the scale letter that the numeric level alone cannot.
   */
  noaaScale: string | null;
  /**
   * Short phenomenon derived from the body's NOAA scale letter, falling back to the
   * message code, e.g. "Geomagnetic", "Radio Blackout", "Solar Radiation".
   */
  phenomenon: string;
  /** Short SWPC feed product ID, e.g. "K04W", "EF3A". See messageCode for the full code. */
  productId: string;
  /** Product type derived from the code prefix. */
  productType: 'Warning' | 'Watch' | 'Alert' | 'Summary' | 'Other';
  /**
   * The record's own "Serial Number:" value; null when the body carries no such line.
   * A per-message-code counter, not a globally unique ID — it repeats across codes and
   * within one code on a corrected reissue. It is the key the "Cancel Serial Number:",
   * "Extension to Serial Number:", and "Continuation of Serial Number:" links point at.
   */
  serialNumber: string | null;
  /**
   * True when the body carries the "THIS SUPERSEDES ANY/ALL PRIOR WATCHES IN EFFECT"
   * line — a claim over every earlier record carrying it, not just others under the same
   * message code. A cancellation does not carry the line; it removes its named target
   * through {@link SpaceWeatherAlert.cancelsSerialNumber} instead.
   */
  supersedes: boolean;
  /** Validity-window start as ISO 8601 UTC ("Valid From"/"Begin Time" line), null if absent. */
  validFrom: string | null;
  /**
   * Validity-window end as ISO 8601 UTC, null when nothing in the body states one.
   * Read from a "Valid To" / "Now Valid Until" / "End Time" label when the product
   * carries one. A Watch carries none, so its end is derived from the "Highest Storm
   * Level Predicted by Day:" list instead: the end of the last listed UTC day whose
   * level is not "None" (a trailing None day forecasts quiet rather than extending
   * coverage), with the year taken from `issueDatetime`. A cancellation's "Cancelled
   * Level Predicted:" list is a different header and yields nothing.
   */
  validTo: string | null;
}
