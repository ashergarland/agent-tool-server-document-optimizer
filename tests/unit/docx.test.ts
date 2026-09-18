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

describe('DOCX optimization', () => {
  it('preserves headings, paragraphs, lists, hierarchy, and archive provenance', async () => {
    const app = await application();
    const optimized = await app.services.optimizer.optimize('headings.docx', signal());

    expect(optimized.manifest.source.format).toBe('docx');
    expect(optimized.manifest.metadata).toMatchObject({
      title: 'Structured DOCX Fixture',
      author: 'Synthetic Fixture Generator',
      reportedWordCount: 31,
    });
    expect(optimized.manifest.metrics).toMatchObject({
      pageCount: 1,
      pageCountKind: 'source-property',
      sectionCount: 3,
    });

    const outline = app.services.optimizer.outline(optimized.manifest.documentId, 0, 100);
    expect(outline.entries.map(({ title, level }) => ({ title, level }))).toEqual([
      { title: 'Structured DOCX Fixture', level: 1 },
      { title: 'Overview', level: 2 },
      { title: 'Details', level: 2 },
    ]);
    expect(outline.entries[1]?.parentSectionId).toBe(outline.entries[0]?.sectionId);

    const overview = app.services.optimizer.section(
      optimized.manifest.documentId,
      outline.entries[1]!.sectionId,
      0,
      16_000,
    );
    expect(overview.content).toContain(
      'This paragraph retains heading and archive-entry provenance.',
    );
    expect(overview.content).toContain('- First bounded list item');
    expect(
      overview.provenance.some(
        ({ provenance }) =>
          provenance.archiveEntry === 'word/document.xml' &&
          provenance.headingPath.join('/') === 'Structured DOCX Fixture/Overview',
      ),
    ).toBe(true);
  });

  it('truthfully reports a DOCX with no extractable text', async () => {
    const app = await application();
    const optimized = await app.services.optimizer.optimize('empty.docx', signal());

    expect(optimized.manifest.processing).toMatchObject({
      status: 'no-extractable-text',
      warnings: ['No parser-visible text was extracted from the document.'],
    });
    expect(optimized.manifest.metrics).toMatchObject({
      extractedTextCharacters: 0,
      sectionCount: 1,
      tableCount: 0,
      figureCount: 0,
    });
    expect(optimized.manifest.summary.limitations).toContain('No parser-visible text was found.');
  });

  it('skips text boxes without rejecting ordinary document paragraphs', async () => {
    const app = await application();
    const optimized = await app.services.optimizer.optimize('text-box.docx', signal());
    const outline = app.services.optimizer.outline(optimized.manifest.documentId, 0, 10);
    const section = app.services.optimizer.section(
      optimized.manifest.documentId,
      outline.entries[0]!.sectionId,
      0,
      16_000,
    );

    expect(section.content).toContain('Ordinary text before the shape.');
    expect(section.content).toContain('Ordinary text after the shape.');
    expect(section.content).toContain('Following ordinary paragraph remains available.');
    expect(section.content).not.toContain('Text-box content is outside');
    expect(optimized.manifest.processing.warnings.join(' ')).toMatch(
      /Text-box content was skipped/u,
    );
  });

  it('extracts table headers and cells with bounded structured, Markdown, and CSV access', async () => {
    const app = await application();
    const optimized = await app.services.optimizer.optimize('table.docx', signal());
    expect(optimized.manifest.metrics.tableCount).toBe(1);

    const structured = app.services.optimizer.table(
      optimized.manifest.documentId,
      'table-001',
      0,
      1,
      'structured',
    );
    expect(structured).toMatchObject({
      format: 'structured',
      headers: ['Setting', 'Value'],
      rows: [['Listener environment variable', 'PORT']],
      totalRows: 2,
      truncated: true,
      nextOffset: 1,
      table: {
        extractionMethod: 'docx-ooxml',
        confidence: 'high',
        provenance: { archiveEntry: 'word/document.xml' },
      },
    });
    const markdown = app.services.optimizer.table(
      optimized.manifest.documentId,
      'table-001',
      0,
      25,
      'markdown',
    );
    expect(markdown).toMatchObject({ format: 'markdown', truncated: false });
    if (markdown.format === 'markdown') {
      expect(markdown.content).toContain('| Readiness port | 8080 |');
    }
    const csv = app.services.optimizer.table(
      optimized.manifest.documentId,
      'table-001',
      0,
      25,
      'csv',
    );
    if (csv.format === 'csv') {
      expect(csv.content).toContain('"Listener environment variable","PORT"');
    }
  });

  it('bounds rendered table output after Markdown escaping', async () => {
    const app = await createTestApplication({
      DOCUMENT_OPTIMIZER_MAX_RESULT_CHARACTERS: '1000',
    });
    applications.push(app);
    const optimized = await app.services.optimizer.optimize('escaped-table.docx', signal());
    const first = app.services.optimizer.table(
      optimized.manifest.documentId,
      'table-001',
      0,
      100,
      'markdown',
    );

    expect(first).toMatchObject({
      format: 'markdown',
      truncated: true,
      nextOffset: 1,
      resultLimitReached: true,
    });
    if (first.format === 'markdown') {
      expect(first.content.length).toBeLessThanOrEqual(1_000);
    }
  });

  it('inventories and returns a verified embedded raster image for a Vision handoff', async () => {
    const app = await application();
    const optimized = await app.services.optimizer.optimize('figure.docx', signal());
    expect(optimized.manifest.metrics.figureCount).toBe(1);

    const metadata = app.services.optimizer.figure(
      optimized.manifest.documentId,
      'figure-001',
      false,
    );
    expect(metadata).toMatchObject({
      retrievalStatus: 'metadata-only',
      figure: {
        mediaType: 'image/png',
        width: 100,
        height: 50,
        semanticDescription: 'Synthetic architecture marker for later Vision handoff',
        semanticDescriptionStatus: 'source-alt-text',
        asset: { available: true },
        provenance: { archiveEntry: 'word/media/figure.png' },
      },
    });

    const withData = app.services.optimizer.figure(
      optimized.manifest.documentId,
      'figure-001',
      true,
    );
    expect(withData.retrievalStatus).toBe('included');
    expect(withData.dataEncoding).toBe('base64');
    expect(Buffer.from(withData.dataBase64!, 'base64').subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const packageDirectory = join(
      app.services.scratch.path,
      'documents',
      optimized.manifest.documentId,
    );
    const packageJson = await readFile(join(packageDirectory, 'document.json'));
    const asset = await readFile(
      join(packageDirectory, ...metadata.figure.asset.reference!.split('/')),
    );
    expect(packageJson.byteLength + asset.byteLength).toBe(
      optimized.manifest.metrics.optimizedRepresentationBytes,
    );

    const alternate = await app.services.optimizer.optimize('alternate-figure.docx', signal());
    expect(alternate.manifest.metrics.figureCount).toBe(1);
    expect(alternate.manifest.processing.warnings.join(' ')).toMatch(
      /compatibility fallback content was skipped/u,
    );
  });

  it('paginates large sections and reports deployment-limit clamping', async () => {
    const app = await createTestApplication({
      DOCUMENT_OPTIMIZER_MAX_RESULT_CHARACTERS: '1000',
    });
    applications.push(app);
    const optimized = await app.services.optimizer.optimize('long-section.docx', signal());
    const sectionId = app.services.optimizer.outline(optimized.manifest.documentId, 0, 10)
      .entries[0]!.sectionId;

    const first = app.services.optimizer.section(
      optimized.manifest.documentId,
      sectionId,
      0,
      2_000,
    );
    expect(first).toMatchObject({
      appliedMaxCharacters: 1_000,
      limitClamped: true,
      truncated: true,
      nextOffset: 1_000,
    });
    const second = app.services.optimizer.section(
      optimized.manifest.documentId,
      sectionId,
      first.nextOffset!,
      1_000,
    );
    expect(second.offset).toBe(first.nextOffset);
    expect(`${first.content}${second.content}`).toContain('bounded progressive sentence 1');

    const unicode = await app.services.optimizer.optimize('unicode.docx', signal());
    const unicodeSectionId = app.services.optimizer.outline(unicode.manifest.documentId, 0, 10)
      .entries[0]!.sectionId;
    const unicodePage = app.services.optimizer.section(
      unicode.manifest.documentId,
      unicodeSectionId,
      0,
      2,
    );
    expect(unicodePage.content).toBe('\u{1F600}');
    expect(unicodePage.nextOffset).toBe(2);
  });

  it('ignores macro content and external images without executing or fetching them', async () => {
    const app = await application();
    const macro = await app.services.optimizer.optimize('macro-content.docx', signal());
    expect(macro.manifest.processing.warnings.join(' ')).toMatch(
      /macro content was ignored and was not executed/iu,
    );
    const macroSection = app.services.optimizer.section(
      macro.manifest.documentId,
      app.services.optimizer.outline(macro.manifest.documentId, 0, 10).entries[0]!.sectionId,
      0,
      16_000,
    );
    expect(macroSection.content).toContain('Ordinary document text remains available');

    const external = await app.services.optimizer.optimize('external-figure.docx', signal());
    const figure = app.services.optimizer.figure(external.manifest.documentId, 'figure-001', true);
    expect(figure).toMatchObject({
      retrievalStatus: 'unavailable',
      figure: {
        semanticDescription: 'External image must not be fetched',
        asset: {
          available: false,
          reason: 'External image relationships are not fetched.',
        },
      },
    });
  });
});
