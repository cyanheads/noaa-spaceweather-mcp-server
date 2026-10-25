/**
 * @fileoverview CommonMark text parity for upstream strings in tool output.
 * @module tests/tools/markdown-parity.test
 */

import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { getAlerts } from '@/mcp-server/tools/definitions/get-alerts.tool.js';
import { getAuroraForecast } from '@/mcp-server/tools/definitions/get-aurora-forecast.tool.js';
import { getConditions } from '@/mcp-server/tools/definitions/get-conditions.tool.js';
import { getKpIndex } from '@/mcp-server/tools/definitions/get-kp-index.tool.js';
import { getSolarActivity } from '@/mcp-server/tools/definitions/get-solar-activity.tool.js';
import { getSolarWind } from '@/mcp-server/tools/definitions/get-solar-wind.tool.js';

const markdown = new MarkdownIt('commonmark');
type Token = ReturnType<typeof markdown.parse>[number];
const text = 'A*p* [watch](https://example.com) <b>NOAA</b> &copy;';
const multiline = `${text}\n\n\`\`\`\n- retain this line\n  and its indentation\n`;

/** Read the text a CommonMark client sees, retaining hard and soft line breaks. */
function visibleText(tokens: Token[]): string {
  return tokens
    .map((token) => {
      if (token.children) return visibleText(token.children);
      if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n';
      if (token.type === 'text' || token.type === 'code_inline') return token.content;
      if (token.type === 'fence' || token.type === 'code_block') return token.content;
      if (token.block && token.nesting === -1) return '\n';
      return '';
    })
    .join('');
}

/** Assert the raw output remains unchanged while its rendered text stays literal. */
function assertLiteral(
  output: object,
  format: () => readonly { type: string; text?: string }[],
  values: readonly string[],
): void {
  const before = JSON.stringify(output);
  const content = format();
  const tokens = markdown.parse(content.map((block) => block.text ?? '').join('\n'), {});
  const rendered = visibleText(tokens);
  const pending = [...tokens];
  while (pending.length > 0) {
    const token = pending.pop()!;
    expect(['link_open', 'html_inline', 'code_inline', 'fence', 'code_block']).not.toContain(
      token.type,
    );
    if (token.children) pending.push(...token.children);
  }
  for (const value of values) expect(rendered).toContain(value);
  expect(JSON.stringify(output)).toBe(before);
}

describe('upstream text renders literally under CommonMark', () => {
  it.each([getSolarActivity, getSolarWind])('preserves raw notice text for $name', (definition) => {
    const render = definition.enrichmentTrailer!.notice!.render!;
    const output = { notice: multiline };
    assertLiteral(output, () => [{ type: 'text', text: render(multiline) }], [multiline]);
  });

  it('preserves alert metadata and a multiline message containing a fence', () => {
    const output = getAlerts.output.parse({
      alerts: [
        {
          productId: `Product ${text}`,
          messageCode: text,
          productType: 'Warning',
          level: 1,
          noaaScale: text,
          cancelled: false,
          serialNumber: text,
          phenomenon: text,
          issueDatetime: text,
          validFrom: text,
          validTo: text,
          message: multiline,
        },
      ],
      totalCount: 1,
      activeOnly: true,
      fetchedAt: '2026-10-25T00:00:00Z',
    });
    assertLiteral(output, () => getAlerts.format!(output), [`Product ${text}`, multiline]);
  });

  it('preserves scale descriptions and multiline forecast discussion', () => {
    const level = { scale: 1, label: 'G1', text: `Scale ${text}` };
    const output = getConditions.output.parse({
      observedAt: '2026-10-25T00:00:00Z',
      currentKp: 5,
      currentGScale: 1,
      auroraLatitude: 'Aurora possible',
      yesterday: null,
      today: { G: level, R: level, S: level },
      forecast: [],
      summary: text,
      discussion: {
        issued: null,
        sections: [
          { topic: text, summary: `Summary ${multiline}`, forecast: `Forecast ${multiline}` },
        ],
      },
    });
    assertLiteral(output, () => getConditions.format!(output), [
      `Scale ${text}`,
      `Summary ${multiline}`,
      `Forecast ${multiline}`,
    ]);
  });

  it('preserves Kp forecast labels supplied by the feed', () => {
    const output = getKpIndex.output.parse({
      observed: [],
      forecast: [
        {
          timeTag: '2026-10-25T00:00:00Z',
          kp: 5,
          observed: `Observed ${text}`,
          noaaScale: `Scale ${text}`,
          gScale: 1,
          gLabel: 'G1',
        },
      ],
      currentKp: 5,
      currentGScale: 1,
      auroraLatitude: 'Aurora possible',
      observedCount: 0,
    });
    assertLiteral(output, () => getKpIndex.format!(output), [`Observed ${text}`, `Scale ${text}`]);
  });

  it('preserves OVATION time strings', () => {
    const output = getAuroraForecast.output.parse({
      observationTime: `Observation ${text}`,
      forecastTime: `Forecast ${text}`,
      localLookup: null,
      gridPointCount: 1,
      topAuroraPercent: 10,
      topAuroraRegion: '67°N, 20°W',
    });
    assertLiteral(output, () => getAuroraForecast.format!(output), [
      `Observation ${text}`,
      `Forecast ${text}`,
    ]);
  });

  it('preserves solar flare, proton, radio-flux and region text', () => {
    const output = getSolarActivity.output.parse({
      latestXray: null,
      recentXray: [],
      recentFlares: [
        {
          beginTime: text,
          maxTime: text,
          endTime: text,
          beginClass: text,
          maxClass: `Peak ${text}`,
          endClass: text,
          peakFluxWm2: 0.00001,
          rScale: 1,
          satellite: 18,
        },
      ],
      f107: {
        observedTime: text,
        fluxSfu: 100,
        ninetyDayMeanSfu: null,
        reportingSchedule: `Report ${text}`,
      },
      probabilities: [],
      latestProton: { timeTag: text, fluxPfu: 10, sScale: 1, energy: `Energy ${text}` },
      sScale: 1,
      sScaleText: 'S1 minor radiation storm',
      activeRegions: [
        {
          region: 1,
          location: `Location ${text}`,
          latitude: text,
          spotClass: text,
          magClass: text,
          numberSpots: 1,
          areaMillionths: 1,
          firstObserved: text,
          observedDate: text,
          cFlareCount: 0,
          mFlareCount: 0,
          xFlareCount: 0,
          cFlareProbability: 0,
          mFlareProbability: 0,
          xFlareProbability: 0,
          protonProbability: 0,
        },
      ],
      fetchedAt: '2026-10-25T00:00:00Z',
    });
    assertLiteral(output, () => getSolarActivity.format!(output), [
      `Peak ${text}`,
      `Report ${text}`,
      `Energy ${text}`,
      `Location ${text}`,
    ]);
  });

  it('preserves spacecraft identifiers in solar wind records', () => {
    const plasma = {
      timeTag: '2026-10-25T00:00:00Z',
      source: `Plasma ${text}`,
      densityPerCm3: 1,
      speedKmS: 400,
      temperatureK: 10000,
    };
    const mag = {
      timeTag: '2026-10-25T00:00:00Z',
      source: `Mag ${text}`,
      bxGsm: 1,
      byGsm: 2,
      bzGsm: -3,
      bt: 4,
    };
    const output = getSolarWind.output.parse({
      plasma: [plasma],
      mag: [mag],
      latestPlasma: plasma,
      latestMag: mag,
      bzStatus: 'Southward',
      plasmaCount: 1,
      magCount: 1,
      bzMinInWindow: -3,
      bzMinTimeTag: null,
      bzSouthMinutesInWindow: 1,
      speedMaxInWindow: 400,
      speedMaxTimeTag: null,
      densityMaxInWindow: 1,
      btMaxInWindow: 4,
      latestFeedPlasmaTime: null,
      latestFeedMagTime: null,
      feedStalenessHours: null,
    });
    assertLiteral(output, () => getSolarWind.format!(output), [`Plasma ${text}`, `Mag ${text}`]);
  });
});
