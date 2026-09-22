/**
 * @fileoverview Output-schema contract tests across every tool: the advertised
 * JSON Schema shape (descriptions ignored) is pinned by snapshot, every output
 * node carries a description, and the summed description text stays under its
 * byte budget.
 * @module tests/tools/output-schemas.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';

/**
 * Ceiling on the UTF-8 bytes of every `description` in the tools' success
 * output schemas (output fields plus enrichment fields, framework error
 * envelope excluded — the framework builds that from `errors[]`).
 */
const OUTPUT_DESCRIPTION_BUDGET_BYTES = 14_300;

type JsonNode = unknown;

interface OutputBearingDefinition {
  enrichment?: z.ZodRawShape;
  name: string;
  output: z.ZodObject;
}

/**
 * The success schema `tools/list` advertises for a tool, as JSON Schema: the
 * output object extended with its enrichment fields, the same composition the
 * framework advertises before it adds the error envelope.
 */
function successJsonSchema(def: OutputBearingDefinition): JsonNode {
  const schema = def.enrichment ? def.output.extend(def.enrichment) : def.output;
  return z.toJSONSchema(schema);
}

/** Every string `description` value in a JSON Schema tree. */
function collectDescriptions(node: JsonNode, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectDescriptions(child, out);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description' && typeof value === 'string') out.push(value);
      else collectDescriptions(value, out);
    }
  }
  return out;
}

/** A JSON Schema tree with every string `description` removed — the shape alone. */
function stripDescriptions(node: JsonNode): JsonNode {
  if (Array.isArray(node)) return node.map(stripDescriptions);
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key, value]) => !(key === 'description' && typeof value === 'string'))
        .map(([key, value]) => [key, stripDescriptions(value)]),
    );
  }
  return node;
}

/** Paths of every `properties` entry that carries no non-empty description. */
function undescribedProperties(node: JsonNode, path = ''): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((child, i) => undescribedProperties(child, `${path}[${i}]`));
  }
  if (!node || typeof node !== 'object') return [];
  const missing: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && value && typeof value === 'object') {
      for (const [field, fieldSchema] of Object.entries(value)) {
        const description = (fieldSchema as { description?: unknown }).description;
        if (typeof description !== 'string' || description.trim() === '') {
          missing.push(`${path}.${field}`);
        }
        missing.push(...undescribedProperties(fieldSchema, `${path}.${field}`));
      }
    } else {
      missing.push(...undescribedProperties(value, path));
    }
  }
  return missing;
}

const definitions = allToolDefinitions as readonly OutputBearingDefinition[];

describe('tool output schemas', () => {
  it.each(definitions.map((def) => [def.name, def] as const))(
    '%s keeps its advertised shape (keys, types, required, enums)',
    (_name, def) => {
      expect(stripDescriptions(successJsonSchema(def))).toMatchSnapshot();
    },
  );

  it.each(definitions.map((def) => [def.name, def] as const))(
    '%s describes every output and enrichment field',
    (_name, def) => {
      expect(undescribedProperties(successJsonSchema(def))).toEqual([]);
    },
  );

  it(`keeps summed output description text within ${OUTPUT_DESCRIPTION_BUDGET_BYTES} bytes`, () => {
    const perTool = Object.fromEntries(
      definitions.map((def) => [
        def.name,
        collectDescriptions(successJsonSchema(def)).reduce(
          (sum, text) => sum + Buffer.byteLength(text, 'utf8'),
          0,
        ),
      ]),
    );
    const total = Object.values(perTool).reduce((sum, bytes) => sum + bytes, 0);
    expect(total, JSON.stringify(perTool)).toBeLessThanOrEqual(OUTPUT_DESCRIPTION_BUDGET_BYTES);
  });
});
