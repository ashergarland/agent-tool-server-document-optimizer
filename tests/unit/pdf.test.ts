import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApplication, signal, type TestApplication } from '../helpers/application.js';

const applications: TestApplication[] = [];

const application = async (): Promise<TestApplication> => {
  const created = await createTestApplication();
  applications.push(created);
  return created;
};

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (app) => app.shutdown()));
});

describe('PDF optimization', () => {
  it('extracts real text, metadata, page provenance, sections, and figure inventory', async () => {
    const app = await application();
    const optimized = await app.services.optimizer.optimize('text.pdf', signal());

    expect(optimized.cacheHit).toBe(false);
    expect(optimized.manifest.source).toMatchObject({
      name: 'text.pdf',
      relativePath: 'text.pdf',
      format: 'pdf',
    });
    expect(optimized.manifest.metadata).toMatchObject({
      title: 'Document Optimizer PDF Fixture',
      author: 'Synthetic Fixture Generator',
    });
    expect(optimized.manifest.metrics).toMatchObject({
      pageCount: 2,
      pageCountKind: 'parsed',
      figureCount: 1,
    });
    expect(optimized.manifest.processing.status).toBe('optimized');
    expect(optimized.manifest.processing.extractionMethods).toContain(
      'pdfjs-text-and-page-structure',
    );

    const outline = app.services.optimizer.outline(optimized.manifest.documentId, 0, 100);
    expect(outline.entries.map(({ title }) => title)).toEqual(
      expect.arrayContaining(['Executive Summary', 'Deployment Evidence']),
    );
    const deployment = outline.entries.find(({ title }) => title === 'Deployment Evidence');
    expect(deployment).toMatchObject({ pageStart: 2, pageEnd: 2 });
    expect(deployment?.figureIds).toEqual(['figure-001']);

    const section = app.services.optimizer.section(
      optimized.manifest.documentId,
      deployment!.sectionId,
      0,
      16_000,
    );
    expect(section.content).toContain('readiness uses TCP port 8080');
    expect(
      section.provenance.some(
        ({ provenance }) => provenance.page === 2 && provenance.sourcePath === 'text.pdf',
      ),
    ).toBe(true);

    const figure = app.services.optimizer.figure(
      optimized.manifest.documentId,
      'figure-001',
      false,
    );
    expect(figure).toMatchObject({
      retrievalStatus: 'metadata-only',
      figure: {
        semanticDescriptionStatus: 'not-generated',
        asset: { available: false },
        provenance: { page: 2 },
      },
    });
  });

  it('retains available text when an optional PDF page resource is broken', async () => {
    const app = await application();
    const optimized = await app.services.optimizer.optimize(
      'recoverable-resource-error.pdf',
      signal(),
    );

    expect(optimized.manifest.processing.status).toBe('optimized');
    expect(optimized.manifest.metadata.title).toBe('Recoverable PDF Resource Fixture');
    const outline = app.services.optimizer.outline(optimized.manifest.documentId, 0, 10);
    const section = app.services.optimizer.section(
      optimized.manifest.documentId,
      outline.entries[0]!.sectionId,
      0,
      16_000,
    );
    expect(section.content).toContain('Real text survives a broken optional image resource.');
  });

  it('returns deterministic identity, outline, section text, and provenance', async () => {
    const firstApp = await application();
    const secondApp = await application();
    const first = await firstApp.services.optimizer.optimize('text.pdf', signal());
    const firstAgain = await firstApp.services.optimizer.optimize('text.pdf', signal());
    const second = await secondApp.services.optimizer.optimize('text.pdf', signal());

    expect(firstAgain.cacheHit).toBe(true);
    expect(firstAgain.manifest).toEqual(first.manifest);
    expect(second.manifest).toEqual(first.manifest);

    const firstPackage = await readFile(
      join(firstApp.services.scratch.path, 'documents', first.manifest.documentId, 'document.json'),
      'utf8',
    );
    const secondPackage = await readFile(
      join(
        secondApp.services.scratch.path,
        'documents',
        second.manifest.documentId,
        'document.json',
      ),
      'utf8',
    );
    expect(secondPackage).toBe(firstPackage);
    expect(Buffer.byteLength(firstPackage, 'utf8')).toBe(
      first.manifest.metrics.optimizedRepresentationBytes,
    );

    const firstOutline = firstApp.services.optimizer.outline(first.manifest.documentId, 0, 100);
    const secondOutline = secondApp.services.optimizer.outline(second.manifest.documentId, 0, 100);
    expect(secondOutline).toEqual(firstOutline);
    for (const entry of firstOutline.entries) {
      expect(
        secondApp.services.optimizer.section(
          second.manifest.documentId,
          entry.sectionId,
          0,
          128_000,
        ),
      ).toEqual(
        firstApp.services.optimizer.section(first.manifest.documentId, entry.sectionId, 0, 128_000),
      );
    }
  });

  it('truthfully marks an image-only PDF as requiring OCR or Vision', async () => {
    const app = await application();
    const optimized = await app.services.optimizer.optimize('image-only.pdf', signal());

    expect(optimized.manifest.processing.status).toBe('needs-ocr');
    expect(optimized.manifest.metrics.extractedTextCharacters).toBe(0);
    expect(optimized.manifest.metrics.figureCount).toBe(1);
    expect(optimized.manifest.processing.warnings.join(' ')).toMatch(/OCR or Vision/iu);
    expect(optimized.manifest.summary.limitations.join(' ')).toMatch(/OCR or Vision/iu);
  });

  it('extracts structured cells when a PDF exposes tagged table structure', async () => {
    const app = await application();
    const optimized = await app.services.optimizer.optimize('tagged-table.pdf', signal());
    expect(optimized.manifest.metrics.tableCount).toBe(1);
    expect(optimized.manifest.processing.extractionMethods).toContain('pdf-tagged-table-structure');
    expect(
      app.services.optimizer.table(optimized.manifest.documentId, 'table-001', 0, 25, 'structured'),
    ).toMatchObject({
      format: 'structured',
      headers: ['Setting', 'Value'],
      rows: [['Readiness port', '8080']],
      table: {
        extractionMethod: 'pdf-tagged-structure',
        confidence: 'high',
        provenance: { page: 1 },
      },
    });
  });

  it('rejects a malformed PDF with a deterministic client error', async () => {
    const app = await application();
    await expect(app.services.optimizer.optimize('malformed.pdf', signal())).rejects.toMatchObject({
      code: 'bad_request',
      message: 'The PDF is malformed or uses unsupported PDF features',
    });
  });

  it('enforces the configured PDF page ceiling', async () => {
    const app = await createTestApplication({
      DOCUMENT_OPTIMIZER_MAX_PDF_PAGES: '1',
    });
    applications.push(app);
    await expect(app.services.optimizer.optimize('text.pdf', signal())).rejects.toMatchObject({
      code: 'limit_exceeded',
    });
  });
});
