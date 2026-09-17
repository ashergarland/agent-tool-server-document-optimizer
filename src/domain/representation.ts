import { posix } from 'node:path';
import { BoundedWarnings } from '@agent-tool-platform/runtime/limits';
import type {
  DocumentManifest,
  DocumentProvenance,
  FigureDescriptor,
  OptimizedDocumentPackage,
  OutlineEntry,
  SectionBlock,
  SectionRecord,
  TableRecord,
} from './model.js';
import {
  documentPackageSchemaVersion,
  maximumManifestWarnings,
  optimizedDocumentPackageSchema,
  optimizerPipelineVersion,
} from './model.js';
import type { ParsedBlock, ParsedDocument, ParsedFigure, ParsedTable } from './parser-types.js';
import { boundedValue, markdownTable, slugify } from './util.js';

export interface SourceIdentity {
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface RepresentationBuildInput {
  readonly documentId: string;
  readonly optimizerVersion: string;
  readonly source: SourceIdentity;
  readonly parsed: ParsedDocument;
}

export interface BuiltRepresentation {
  readonly package: OptimizedDocumentPackage;
  readonly assets: ReadonlyMap<string, Buffer>;
}

interface RenderedBlock {
  readonly kind: SectionBlock['kind'];
  readonly markdown: string;
  readonly parsed: ParsedBlock | ParsedTable | ParsedFigure;
  readonly tableId?: string;
  readonly figureIds: readonly string[];
}

interface SectionDraft {
  readonly sectionId: string;
  readonly title: string;
  readonly level: number;
  readonly order: number;
  readonly parentSectionId?: string;
  readonly headingPath: readonly string[];
  readonly blocks: RenderedBlock[];
}

const numberedId = (prefix: 'section' | 'table' | 'figure', index: number): string =>
  `${prefix}-${String(index + 1).padStart(3, '0')}`;

const sectionId = (title: string, index: number): string => {
  const base = numberedId('section', index);
  const slug = slugify(title);
  return slug.length === 0 ? base : `${base}-${slug}`;
};

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const pageOf = (value: ParsedBlock | ParsedTable | ParsedFigure): number | undefined => value.page;

const provenanceFor = (
  source: SourceIdentity,
  parsed: ParsedBlock | ParsedTable | ParsedFigure,
  headingPath: readonly string[],
): DocumentProvenance => ({
  sourceSha256: source.sha256,
  sourcePath: source.relativePath,
  locator: parsed.locator,
  ...(parsed.page === undefined ? {} : { page: parsed.page }),
  ...(parsed.archiveEntry === undefined ? {} : { archiveEntry: parsed.archiveEntry }),
  ...(parsed.blockIndex === undefined ? {} : { blockIndex: parsed.blockIndex }),
  headingPath: [...headingPath],
});

const tableMarkdown = (tableIdValue: string, table: ParsedTable): string => {
  const title = table.title === undefined ? tableIdValue : `${tableIdValue}: ${table.title}`;
  return `**Table ${title}**\n\n${markdownTable(table.headers, table.rows)}`;
};

const figureMarkdown = (figureIdValue: string, figure: ParsedFigure): string => {
  const label = figure.semanticDescription ?? figure.caption ?? `Extracted figure ${figureIdValue}`;
  return `![${label.replace(/\]/gu, '\\]')}](figure:${figureIdValue})`;
};

const representativeText = (sections: readonly SectionRecord[]): string =>
  boundedValue(
    sections
      .map((section) => section.markdown)
      .join(' ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/[#*_`|>-]+/gu, ' '),
    900,
  );

const findSectionForPage = (
  drafts: readonly SectionDraft[],
  page: number | undefined,
): SectionDraft => {
  if (page === undefined) return drafts[0]!;
  let selected = drafts[0]!;
  for (const draft of drafts) {
    const pages = draft.blocks
      .map(({ parsed }) => pageOf(parsed))
      .filter((value) => value !== undefined);
    const minimum = pages.length === 0 ? undefined : Math.min(...pages);
    if (minimum !== undefined && minimum <= page) selected = draft;
  }
  return selected;
};

const createSections = (
  input: RepresentationBuildInput,
  tableIds: readonly string[],
  figureIds: readonly string[],
): readonly SectionDraft[] => {
  const { parsed } = input;
  const drafts: SectionDraft[] = [];
  const stack: SectionDraft[] = [];
  const tableAssignments = new Set<number>();
  const figureAssignments = new Set<number>();

  const addSection = (title: string, level: number): SectionDraft => {
    while ((stack.at(-1)?.level ?? 0) >= level) stack.pop();
    const parent = stack.at(-1);
    const draft: SectionDraft = {
      sectionId: sectionId(title, drafts.length),
      title: boundedValue(title, 300) || `Section ${String(drafts.length + 1)}`,
      level,
      order: drafts.length,
      ...(parent === undefined ? {} : { parentSectionId: parent.sectionId }),
      headingPath: [...(parent?.headingPath ?? []), boundedValue(title, 300)],
      blocks: [],
    };
    drafts.push(draft);
    stack.push(draft);
    return draft;
  };

  let current: SectionDraft | undefined;
  const ensureCurrent = (): SectionDraft =>
    (current ??= addSection(input.parsed.metadata.title ?? 'Document', 1));

  for (const block of parsed.blocks) {
    if (block.kind === 'heading' && block.text.length > 0) {
      current = addSection(block.text, block.headingLevel ?? 1);
    }
    const section = ensureCurrent();
    const attachedFigures = block.figureIndexes
      .map((index) => {
        const figure = parsed.figures[index];
        const id = figureIds[index];
        if (!figure || !id) return undefined;
        figureAssignments.add(index);
        return { figure, id };
      })
      .filter((value) => value !== undefined);

    if (block.kind === 'table' && block.tableIndex !== undefined) {
      const table = parsed.tables[block.tableIndex];
      const id = tableIds[block.tableIndex];
      if (table && id) {
        tableAssignments.add(block.tableIndex);
        section.blocks.push({
          kind: 'table',
          markdown: tableMarkdown(id, table),
          parsed: table,
          tableId: id,
          figureIds: [],
        });
      }
      continue;
    }

    const text =
      block.kind === 'heading'
        ? `${'#'.repeat(Math.min(block.headingLevel ?? 1, 6))} ${block.text}`
        : block.kind === 'list'
          ? `- ${block.text}`
          : block.text;
    const figureText = attachedFigures
      .map(({ figure, id }) => figureMarkdown(id, figure))
      .join('\n\n');
    const markdown = [text, figureText].filter((part) => part.length > 0).join('\n\n');
    if (markdown.length > 0) {
      section.blocks.push({
        kind:
          block.kind === 'heading'
            ? 'heading'
            : block.kind === 'list'
              ? 'list'
              : attachedFigures.length > 0 && text.length === 0
                ? 'figure'
                : 'paragraph',
        markdown,
        parsed: block,
        figureIds: attachedFigures.map(({ id }) => id),
      });
    }
  }

  if (drafts.length === 0) current = addSection(input.parsed.metadata.title ?? 'Document', 1);

  for (let index = 0; index < parsed.tables.length; index += 1) {
    if (tableAssignments.has(index)) continue;
    const table = parsed.tables[index];
    const id = tableIds[index];
    if (!table || !id) continue;
    const section = findSectionForPage(drafts, table.page);
    section.blocks.push({
      kind: 'table',
      markdown: tableMarkdown(id, table),
      parsed: table,
      tableId: id,
      figureIds: [],
    });
  }

  for (let index = 0; index < parsed.figures.length; index += 1) {
    if (figureAssignments.has(index)) continue;
    const figure = parsed.figures[index];
    const id = figureIds[index];
    if (!figure || !id) continue;
    const section = findSectionForPage(drafts, figure.page);
    section.blocks.push({
      kind: 'figure',
      markdown: figureMarkdown(id, figure),
      parsed: figure,
      figureIds: [id],
    });
  }

  return drafts;
};

const finalizeSections = (
  drafts: readonly SectionDraft[],
  source: SourceIdentity,
): readonly SectionRecord[] =>
  drafts.map((draft) => {
    let markdown = '';
    const blocks: SectionBlock[] = [];
    for (const rendered of draft.blocks) {
      if (markdown.length > 0) markdown += '\n\n';
      const startCharacter = markdown.length;
      markdown += rendered.markdown;
      blocks.push({
        blockId: `block-${String(blocks.length + 1).padStart(3, '0')}`,
        kind: rendered.kind,
        startCharacter,
        endCharacter: markdown.length,
        ...(rendered.tableId === undefined ? {} : { tableId: rendered.tableId }),
        figureIds: [...rendered.figureIds],
        provenance: provenanceFor(source, rendered.parsed, draft.headingPath),
      });
    }
    const pages = draft.blocks
      .map(({ parsed }) => pageOf(parsed))
      .filter((value) => value !== undefined);
    const tableIds = unique(
      draft.blocks.map(({ tableId }) => tableId).filter((value) => value !== undefined),
    );
    const figureIds = unique(draft.blocks.flatMap((block) => block.figureIds));
    return {
      sectionId: draft.sectionId,
      title: draft.title,
      level: draft.level,
      order: draft.order,
      ...(pages.length === 0 ? {} : { pageStart: Math.min(...pages), pageEnd: Math.max(...pages) }),
      textCharacters: markdown.length,
      tableIds,
      figureIds,
      markdown,
      blocks,
    };
  });

const sectionForParsed = (
  sections: readonly SectionRecord[],
  parsed: ParsedTable | ParsedFigure,
  id: string,
  kind: 'table' | 'figure',
): SectionRecord => {
  const linked = sections.find((section) =>
    kind === 'table' ? section.tableIds.includes(id) : section.figureIds.includes(id),
  );
  if (linked) return linked;
  if (parsed.page !== undefined) {
    const byPage = [...sections]
      .reverse()
      .find((section) => section.pageStart !== undefined && section.pageStart <= parsed.page!);
    if (byPage) return byPage;
  }
  return sections[0]!;
};

const statusFor = (
  parsed: ParsedDocument,
  extractedCharacters: number,
): DocumentManifest['processing']['status'] => {
  if (parsed.format === 'pdf') {
    const threshold = Math.max(20, (parsed.pageCount ?? 1) * 5);
    if (extractedCharacters < threshold) return 'needs-ocr';
  }
  return extractedCharacters === 0 ? 'no-extractable-text' : 'optimized';
};

const buildSummary = (
  title: string,
  parsed: ParsedDocument,
  sections: readonly SectionRecord[],
  tableCount: number,
  figureCount: number,
  status: DocumentManifest['processing']['status'],
): DocumentManifest['summary'] => {
  const headings = sections
    .map((section) => section.title)
    .filter((heading, index) => index > 0 || heading !== 'Document')
    .slice(0, 12);
  const representative = representativeText(sections);
  const pageDescription =
    parsed.pageCount === null
      ? 'an unavailable page count'
      : `${String(parsed.pageCount)} ${parsed.pageCount === 1 ? 'page' : 'pages'}`;
  const limitations: string[] = [
    'This overview is deterministic and extractive; it is not an LLM-generated semantic summary.',
  ];
  if (parsed.format === 'pdf') {
    limitations.push('PDF tables are extracted only when tagged table structure is available.');
  }
  if (figureCount > 0) {
    limitations.push(
      'Figure meaning is not interpreted; source captions or alt text are returned when available.',
    );
  }
  if (parsed.pageCountKind === 'source-property') {
    limitations.push('The DOCX page count is a source property and may be stale.');
  }
  if (status === 'needs-ocr') {
    limitations.push('Parser-visible PDF text is insufficient; OCR or Vision may be required.');
  } else if (status === 'no-extractable-text') {
    limitations.push('No parser-visible text was found.');
  }
  const headingText =
    headings.length === 0
      ? 'No headings were detected.'
      : `Major headings: ${headings.join('; ')}.`;
  const representativeTextValue =
    representative.length === 0
      ? 'No representative text was extracted.'
      : `Representative text: ${representative}`;
  return {
    kind: 'deterministic-extractive',
    text: boundedValue(
      `${title} is a ${parsed.format.toUpperCase()} document with ${pageDescription}, ${String(
        sections.length,
      )} sections, ${String(tableCount)} tables, and ${String(figureCount)} figures. ${headingText} ${representativeTextValue}`,
      4_000,
    ),
    representativeText: representative,
    majorHeadings: headings,
    limitations,
  };
};

export const buildRepresentation = (input: RepresentationBuildInput): BuiltRepresentation => {
  const tableIds = input.parsed.tables.map((_, index) => numberedId('table', index));
  const figureIds = input.parsed.figures.map((_, index) => numberedId('figure', index));
  const drafts = createSections(input, tableIds, figureIds);
  const sections = finalizeSections(drafts, input.source);
  const sectionById = new Map(drafts.map((draft) => [draft.sectionId, draft] as const));

  const tables: TableRecord[] = input.parsed.tables.map((table, index) => {
    const id = tableIds[index]!;
    const section = sectionForParsed(sections, table, id, 'table');
    const draft = sectionById.get(section.sectionId)!;
    return {
      tableId: id,
      order: index,
      ...(table.title === undefined ? {} : { title: table.title }),
      sectionId: section.sectionId,
      rowCount: table.rows.length,
      columnCount: Math.max(table.headers.length, ...table.rows.map((row) => row.length), 0),
      hasHeader: table.hasHeader,
      extractionMethod: table.extractionMethod,
      confidence: table.confidence,
      provenance: provenanceFor(input.source, table, draft.headingPath),
      headers: [...table.headers],
      rows: table.rows.map((row) => [...row]),
    };
  });

  const assets = new Map<string, Buffer>();
  const figures: FigureDescriptor[] = input.parsed.figures.map((figure, index) => {
    const id = figureIds[index]!;
    const section = sectionForParsed(sections, figure, id, 'figure');
    const draft = sectionById.get(section.sectionId)!;
    if (figure.data !== undefined && figure.asset.reference !== undefined) {
      assets.set(figure.asset.reference, figure.data);
    }
    return {
      figureId: id,
      order: index,
      sectionId: section.sectionId,
      ...(figure.mediaType === undefined ? {} : { mediaType: figure.mediaType }),
      ...(figure.width === undefined ? {} : { width: figure.width }),
      ...(figure.height === undefined ? {} : { height: figure.height }),
      ...(figure.caption === undefined ? {} : { caption: figure.caption }),
      ...(figure.semanticDescription === undefined
        ? {}
        : { semanticDescription: figure.semanticDescription }),
      semanticDescriptionStatus: figure.semanticDescriptionStatus,
      asset: figure.asset,
      provenance: provenanceFor(input.source, figure, draft.headingPath),
    };
  });

  const outline: OutlineEntry[] = drafts.map((draft, index) => {
    const section = sections[index]!;
    return {
      sectionId: section.sectionId,
      title: section.title,
      level: section.level,
      order: section.order,
      ...(draft.parentSectionId === undefined ? {} : { parentSectionId: draft.parentSectionId }),
      ...(section.pageStart === undefined ? {} : { pageStart: section.pageStart }),
      ...(section.pageEnd === undefined ? {} : { pageEnd: section.pageEnd }),
      textCharacters: section.textCharacters,
      tableIds: section.tableIds,
      figureIds: section.figureIds,
      summary: boundedValue(
        section.markdown.replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1').replace(/[#*_`|>-]+/gu, ' '),
        500,
      ),
    };
  });

  const extractedCharacters =
    input.parsed.blocks.reduce((total, block) => total + block.text.length, 0) +
    input.parsed.tables.reduce(
      (total, table) =>
        total +
        table.headers.reduce((subtotal, cell) => subtotal + cell.length, 0) +
        table.rows.reduce(
          (subtotal, row) => subtotal + row.reduce((rowTotal, cell) => rowTotal + cell.length, 0),
          0,
        ),
      0,
    );
  const status = statusFor(input.parsed, extractedCharacters);
  const warnings = new BoundedWarnings(maximumManifestWarnings - 1);
  for (const warning of input.parsed.warnings) warnings.add(warning);
  if (status === 'needs-ocr') {
    warnings.add('PDF text extraction was insufficient; OCR or Vision may be required.');
  } else if (status === 'no-extractable-text') {
    warnings.add('No parser-visible text was extracted from the document.');
  }

  const name = posix.basename(input.source.relativePath);
  const title = input.parsed.metadata.title ?? name;
  const summary = buildSummary(
    title,
    input.parsed,
    sections,
    tables.length,
    figures.length,
    status,
  );
  const documentMarkdown = sections
    .map((section) => section.markdown)
    .filter((section) => section.length > 0)
    .join('\n\n');
  const rootSectionIds = drafts
    .filter((draft) => draft.parentSectionId === undefined)
    .map((draft) => draft.sectionId);
  const manifest: DocumentManifest = {
    schemaVersion: documentPackageSchemaVersion,
    documentId: input.documentId,
    source: {
      name,
      relativePath: input.source.relativePath,
      sha256: input.source.sha256,
      bytes: input.source.bytes,
      format: input.parsed.format,
    },
    metadata: input.parsed.metadata,
    processing: {
      pipelineVersion: optimizerPipelineVersion,
      optimizerVersion: input.optimizerVersion,
      status,
      extractionMethods: unique(input.parsed.extractionMethods),
      warnings: [...warnings.list()],
      sourceChangeDetection: 'sha256',
      cacheScope: 'process-lifetime-scratch',
    },
    metrics: {
      sourceBytes: input.source.bytes,
      pageCount: input.parsed.pageCount,
      pageCountKind: input.parsed.pageCountKind,
      sectionCount: sections.length,
      tableCount: tables.length,
      figureCount: figures.length,
      extractedTextCharacters: extractedCharacters,
      optimizedRepresentationBytes: 0,
    },
    summary,
    inventory: {
      rootSectionIds,
      sectionCount: sections.length,
      tableCount: tables.length,
      figureCount: figures.length,
    },
    provenance: {
      sourceSha256: input.source.sha256,
      sourcePath: input.source.relativePath,
      locator: `source:sha256=${input.source.sha256}`,
      headingPath: [],
    },
  };
  return {
    package: optimizedDocumentPackageSchema.parse({
      manifest,
      outline,
      sections,
      tables,
      figures,
      documentMarkdown,
    }),
    assets,
  };
};

export const serializeOptimizedDocument = (document: OptimizedDocumentPackage): string =>
  `${JSON.stringify(document, null, 2)}\n`;

export const finalizeRepresentationSize = (built: BuiltRepresentation): BuiltRepresentation => {
  const assetBytes = [...built.assets.values()].reduce(
    (total, asset) => total + asset.byteLength,
    0,
  );
  let document = built.package;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = Buffer.byteLength(serializeOptimizedDocument(document), 'utf8') + assetBytes;
    if (document.manifest.metrics.optimizedRepresentationBytes === bytes) {
      return { package: optimizedDocumentPackageSchema.parse(document), assets: built.assets };
    }
    document = {
      ...document,
      manifest: {
        ...document.manifest,
        metrics: {
          ...document.manifest.metrics,
          optimizedRepresentationBytes: bytes,
        },
      },
    };
  }
  return { package: optimizedDocumentPackageSchema.parse(document), assets: built.assets };
};
