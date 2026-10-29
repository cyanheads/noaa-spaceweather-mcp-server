/**
 * @fileoverview The `.mcpb` cleaner and the packaging linter select the same
 * dependency agent docs: package-root `framework-skills/`, `skills/`,
 * `.claude/`, `.agents/`, and `SKILL.md`, never a runtime module that merely
 * sits under a `skills/` directory (the MCP SDK's `dist/ext/skills/`).
 * @module tests/scripts/bundle-agent-docs.test
 */

import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

/**
 * `scripts/lint-packaging.ts` holds a repository-only fallback import that a
 * consumer's typecheck cannot resolve, so the module is loaded by URL at run
 * time to keep it out of the `tsc` program.
 */
const lintPackagingUrl = new URL('../../scripts/lint-packaging.ts', import.meta.url).href;
const { AGENT_DOC_ENTRY: LINT_AGENT_DOC_ENTRY } = (await import(lintPackagingUrl)) as {
  AGENT_DOC_ENTRY: RegExp;
};

const lintSelects = (entries: string[]) =>
  entries.filter((entry) => LINT_AGENT_DOC_ENTRY.test(entry));

const agentDocs = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/dotenv/skills/dotenv/SKILL.md',
  'node_modules/thread-stream/.claude/settings.json',
  'node_modules/pkg/.agents/skills/guide/SKILL.md',
  'node_modules/pkg/SKILL.md',
  'node_modules/pkg/docs/SKILL.md',
  'node_modules/outer/node_modules/inner/skills/guide/SKILL.md',
  'node_modules/@scope/outer/node_modules/@inner/pkg/.claude/agents/review.md',
];

const runtimeEntries = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@cyanheads/mcp-ts-core/dist/mcp-server/skills.js',
  'node_modules/pkg/lib/skills/loader.js',
  'node_modules/@acme/skills/index.js',
  'skills/noaa-spaceweather-guide/SKILL.md',
  'dist/index.js',
];

describe('bundle agent-doc selector', () => {
  it('removes package-root agent docs, scoped and nested packages included', () => {
    expect(filterAgentDocEntries(agentDocs)).toEqual(agentDocs);
    expect(lintSelects(agentDocs)).toEqual(agentDocs);
  });

  it.each(runtimeEntries)('retains %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(lintSelects([entry])).toEqual([]);
  });

  it('keeps the cleaner and the linter on one pattern', () => {
    expect(LINT_AGENT_DOC_ENTRY.source).toBe(AGENT_DOC_ENTRY.source);
  });
});
