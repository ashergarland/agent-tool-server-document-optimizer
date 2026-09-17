import { createToolRegistry } from '@agent-tool-platform/runtime/tools';
import { createTestInvocationContext } from '@agent-tool-platform/testkit';
import { describe, expect, it } from 'vitest';
import { TextInspector } from '../../src/domain/text-inspector.js';
import { capabilityTools } from '../../src/tools/definitions.js';

describe('text inspection domain', () => {
  it('counts bytes, Unicode code points, lines, and words', () => {
    expect(new TextInspector().inspect('one 😀\nthree')).toEqual({
      bytes: 14,
      characters: 11,
      lines: 2,
      words: 3,
    });
  });

  it('reports zero lines and words for empty text', () => {
    expect(new TextInspector().inspect('')).toEqual({
      bytes: 0,
      characters: 0,
      lines: 0,
      words: 0,
    });
  });

  it('exposes the domain behavior through the capability tool', async () => {
    const registry = createToolRegistry(capabilityTools);
    await expect(
      registry.invoke(
        'inspect_text',
        { text: 'one two\nthree' },
        { text: new TextInspector() },
        createTestInvocationContext(),
      ),
    ).resolves.toEqual({
      bytes: 13,
      characters: 13,
      lines: 2,
      words: 3,
    });
  });

  it('accepts exactly 10,000 non-BMP Unicode code points', async () => {
    const registry = createToolRegistry(capabilityTools);
    await expect(
      registry.invoke(
        'inspect_text',
        { text: '😀'.repeat(10_000) },
        { text: new TextInspector() },
        createTestInvocationContext(),
      ),
    ).resolves.toMatchObject({
      bytes: 40_000,
      characters: 10_000,
    });
  });

  it('rejects exactly 10,001 non-BMP Unicode code points', async () => {
    const registry = createToolRegistry(capabilityTools);
    await expect(
      registry.invoke(
        'inspect_text',
        { text: '😀'.repeat(10_001) },
        { text: new TextInspector() },
        createTestInvocationContext(),
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('preserves the ASCII boundary', async () => {
    const registry = createToolRegistry(capabilityTools);
    const services = { text: new TextInspector() };

    await expect(
      registry.invoke(
        'inspect_text',
        { text: 'x'.repeat(10_000) },
        services,
        createTestInvocationContext(),
      ),
    ).resolves.toMatchObject({ characters: 10_000 });
    await expect(
      registry.invoke(
        'inspect_text',
        { text: 'x'.repeat(10_001) },
        services,
        createTestInvocationContext(),
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('retains the declared maximum in the registry JSON Schema', () => {
    const registry = createToolRegistry(capabilityTools);
    expect(registry.get('inspect_text').inputJsonSchema).toMatchObject({
      properties: {
        text: {
          maxLength: 10_000,
        },
      },
    });
  });
});
