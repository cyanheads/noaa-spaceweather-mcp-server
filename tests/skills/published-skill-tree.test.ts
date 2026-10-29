/**
 * @fileoverview The root `skills/` tree the server publishes over MCP passes the
 * SDK's strict loader and holds only the one guide skill.
 * @module tests/skills/published-skill-tree.test
 */

import { readdir } from 'node:fs/promises';
import { validateSkillTree } from '@cyanheads/mcp-ts-core/linter';
import { describe, expect, it } from 'vitest';

const skillsRoot = new URL('../../skills/', import.meta.url).pathname;

describe('published skill tree', () => {
  it('passes the strict skill loader', async () => {
    expect(await validateSkillTree(skillsRoot)).toEqual([]);
  });

  it('holds only the noaa-spaceweather-guide skill', async () => {
    expect(await readdir(skillsRoot)).toEqual(['noaa-spaceweather-guide']);
  });
});
