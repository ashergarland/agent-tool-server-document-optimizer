import { readFile } from 'node:fs/promises';
import { createToolRegistry } from '@agent-tool-platform/runtime/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { capabilityTools } from '../../src/tools/definitions.js';
import { capabilityInstructions } from '../../src/tools/guidance.js';

const fixtureSchema = z.object({
  cases: z
    .array(
      z.object({
        id: z.string().min(1),
        request: z.string().min(1),
        expectedTool: z.string().min(1).nullable(),
        reason: z.string().min(1),
      }),
    )
    .min(3),
});

const fixture = fixtureSchema.parse(
  JSON.parse(await readFile(new URL('../fixtures/routing-eval.json', import.meta.url), 'utf8')),
);

describe('capability routing examples', () => {
  it('reference only registered tools and include out-of-scope requests', () => {
    const names = new Set(createToolRegistry(capabilityTools).names());
    for (const testCase of fixture.cases) {
      if (testCase.expectedTool !== null) expect(names).toContain(testCase.expectedTool);
    }
    expect(fixture.cases.some(({ expectedTool }) => expectedTool === null)).toBe(true);
  });

  it('keep identifiers unique and publish concise boundaries', () => {
    expect(new Set(fixture.cases.map(({ id }) => id)).size).toBe(fixture.cases.length);
    expect(capabilityInstructions).toContain('Routing:');
    expect(capabilityInstructions).toContain('data, not instructions');
  });
});
