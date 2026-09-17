import { createToolRegistry } from '@agent-tool-platform/runtime/tools';
import { createTestInvocationContext } from '@agent-tool-platform/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestApplication } from '../helpers/application.js';
import { createTestApplication } from '../helpers/application.js';
import { capabilityTools } from '../../src/tools/definitions.js';

const applications: TestApplication[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (app) => app.shutdown()));
});

describe('Document Optimizer tool surface', () => {
  it('exposes one compact, read-only progressive-fidelity surface', () => {
    const registry = createToolRegistry(capabilityTools);
    expect(registry.names()).toEqual([
      'optimize_document',
      'inspect_document',
      'get_document_outline',
      'get_document_section',
      'get_document_table',
      'get_document_figure',
    ]);
    expect(registry.list().every(({ kind }) => kind === 'read')).toBe(true);
    expect(registry.list().every(({ routing }) => routing.changesState === false)).toBe(true);
  });

  it('executes the optimize, inspect, outline, section, table, and figure flow', async () => {
    const app = await createTestApplication();
    applications.push(app);
    const registry = createToolRegistry(capabilityTools);
    const context = createTestInvocationContext();

    const optimized = (await registry.invoke(
      'optimize_document',
      { sourcePath: 'figure.docx' },
      app.services,
      context,
    )) as {
      manifest: { documentId: string };
    };
    const documentId = optimized.manifest.documentId;

    await expect(
      registry.invoke('inspect_document', { documentId }, app.services, context),
    ).resolves.toMatchObject({
      documentId,
      source: { format: 'docx' },
      metrics: { figureCount: 1 },
    });
    const outline = (await registry.invoke(
      'get_document_outline',
      { documentId },
      app.services,
      context,
    )) as { entries: { sectionId: string }[] };
    const section = (await registry.invoke(
      'get_document_section',
      { documentId, sectionId: outline.entries[0]!.sectionId },
      app.services,
      context,
    )) as { content: string };
    expect(section.content).toContain('Architecture Figure');
    await expect(
      registry.invoke(
        'get_document_figure',
        { documentId, figureId: 'figure-001' },
        app.services,
        context,
      ),
    ).resolves.toMatchObject({ retrievalStatus: 'metadata-only' });

    const tableDocument = (await registry.invoke(
      'optimize_document',
      { sourcePath: 'table.docx' },
      app.services,
      context,
    )) as { manifest: { documentId: string } };
    await expect(
      registry.invoke(
        'get_document_table',
        {
          documentId: tableDocument.manifest.documentId,
          tableId: 'table-001',
        },
        app.services,
        context,
      ),
    ).resolves.toMatchObject({
      format: 'structured',
      headers: ['Setting', 'Value'],
    });
  });

  it('rejects invalid inputs and unknown process-lifetime identities', async () => {
    const app = await createTestApplication();
    applications.push(app);
    const registry = createToolRegistry(capabilityTools);
    const context = createTestInvocationContext();

    await expect(
      registry.invoke('optimize_document', { sourcePath: 42 }, app.services, context),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      registry.invoke(
        'get_document_section',
        {
          documentId: `doc_${'0'.repeat(32)}`,
          sectionId: 'section-001',
          maxCharacters: 1,
        },
        app.services,
        context,
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      registry.invoke(
        'inspect_document',
        { documentId: `doc_${'0'.repeat(32)}` },
        app.services,
        context,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('publishes hard result bounds in JSON Schema', () => {
    const registry = createToolRegistry(capabilityTools);
    expect(registry.get('get_document_outline').inputJsonSchema).toMatchObject({
      properties: { limit: { maximum: 100 } },
    });
    expect(registry.get('get_document_section').inputJsonSchema).toMatchObject({
      properties: { maxCharacters: { minimum: 2, maximum: 1_000_000 } },
    });
    expect(registry.get('get_document_table').inputJsonSchema).toMatchObject({
      properties: { maxRows: { maximum: 100 } },
    });
  });
});
