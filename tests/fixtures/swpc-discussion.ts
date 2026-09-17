/**
 * @fileoverview The SWPC Forecast Discussion product (`/text/discussion.txt`) as
 * upstream served it on 2026-09-17, verbatim. Shared by the service-level parser
 * tests and the feed-failure contract's route table so both exercise the real shape:
 * an unprefixed topic heading above each `.24 hr Summary...`, a Solar Activity
 * summary running two paragraphs, and a `:Issued:` time that is not the HTTP
 * `Last-Modified` time.
 * @module tests/fixtures/swpc-discussion
 */

/** The product exactly as served, including its trailing newline. */
export const SWPC_DISCUSSION = `:Product: Forecast Discussion
:Issued: 2026 Sep 17 1230 UTC
# Prepared by the U.S. Dept. of Commerce, NOAA, Space Weather Prediction Center
#
Solar Activity

.24 hr Summary...
Solar activity continued at very low levels with occasional B-class
flaring from an unnumbered plage region in the east, which included a
long-duration B7.9 flare at 16/2345 UTC. Region 4528 (S11W76, Hsx/alpha)
is stable and the only numbered sunspot region on the visible disk.

No Earth-directed CMEs were observed in available coronagraph imagery.

.Forecast...
Solar activity is expected to remain at very low levels, with a chance
for isolated C-class flares through 19 Sep.

Energetic Particle

.24 hr Summary...
The greater than 2 MeV electron flux was at moderate levels, reaching a
peak flux of 534 pfu observed at 16/1440 UTC. The greater than 10 MeV
proton flux remained at background levels.

.Forecast...
The greater than 2 MeV electron flux is expected to reach high levels
through 19 Sep. The greater than 10 MeV proton flux is anticipated to
remain at background levels through 19 Sep.

Solar Wind

.24 hr Summary...
Solar wind parameters were enhanced under negative polarity coronal hole
high-speed stream (-CH HSS). Total field strength (Bt) varied between
3-8 nT throughout the period. The North-South (Bz) component was mostly
northward but briefly reached a maximum southward deflection of -5 nT
around 17/0300 UTC. Solar wind speeds gently decreased from early highs
near 580-600 km/s down to around 480-500 km/s late in the period. The
phi angle remained predominantly negative (towards the Sun).

.Forecast...
Negative polarity CH HSS effects are anticipated to persist through 18
Sep. Additional enhancements are likely on 17 Sep due to flanking
influences from CMEs that departed the Sun on 13 and 14 Sep.

Geospace

.24 hr Summary...
The geomagnetic field was quiet with a single unsettled period in the
middle of the reporting period under CH HSS influences.

.Forecast...
Geomagnetic activity is likely to reach active to G1 (Minor) storm
levels on 17 Sep due to combined CH and CME influences. Unsettled to
active conditions are likely on 18-19 Sep as enhancements wane.
`;
