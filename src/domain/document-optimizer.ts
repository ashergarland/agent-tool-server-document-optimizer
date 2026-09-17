import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CapabilityContext } from '@agent-tool-platform/runtime/capability';
import type { BoundedQueue } from '@agent-tool-platform/runtime/concurrency';
import {
  badRequest,
  internalError,
  limitExceeded,
  notFound,
} from '@agent-tool-platform/runtime/errors';
import { extensionOf } from '@agent-tool-platform/runtime/fs';
import type { RootBoundary } from '@agent-tool-platform/runtime/fs';
import type { DocumentOptimizerConfig } from '../config.js';
import type {
  DocumentManifest,
  FigureDescriptor,
  OutlineEntry,
  SectionBlock,
  SectionRecord,
  StoredDocument,
  TableRecord,
} from './model.js';
import { optimizerPipelineVersion } from './model.js';
import { parseDocx } from './docx.js';
import { parsePdf } from './pdf.js';
import {
  buildRepresentation,
  finalizeRepresentationSize,
  serializeOptimizedDocument,
} from './representation.js';
import { createProcessingSignal, csvTable, markdownTable, sha256 } from './util.js';

type CapabilityLogger = CapabilityContext<DocumentOptimizerConfig>['logger'];

export interface OptimizationResult {
  readonly manifest: DocumentManifest;
  readonly cacheHit: boolean;
}

export interface OutlineResult {
  readonly documentId: string;
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly entries: OutlineEntry[];
  readonly truncated: boolean;
  readonly nextOffset: number | null;
}

export interface SectionResult {
  readonly documentId: string;
  readonly section: Omit<SectionRecord, 'markdown' | 'blocks'>;
  readonly offset: number;
  readonly appliedMaxCharacters: number;
  readonly limitClamped: boolean;
  readonly totalCharacters: number;
  readonly content: string;
  readonly truncated: boolean;
  readonly nextOffset: number | null;
  readonly provenance: SectionBlock[];
  readonly provenanceTruncated: boolean;
}

interface TablePage {
  readonly documentId: string;
  readonly table: TableRecord;
  readonly offset: number;
  readonly rows: string[][];
  readonly totalRows: number;
  readonly truncated: boolean;
  readonly nextOffset: number | null;
  readonly resultLimitReached: boolean;
}

export type TableResult =
  | (Omit<TablePage, 'table' | 'rows'> & {
      readonly format: 'structured';
      readonly table: Omit<TableRecord, 'headers' | 'rows'>;
      readonly headers: string[];
      readonly rows: string[][];
    })
  | (Omit<TablePage, 'table' | 'rows'> & {
      readonly format: 'markdown' | 'csv';
      readonly table: Omit<TableRecord, 'headers' | 'rows'>;
      readonly content: string;
    });

export interface FigureResult {
  readonly documentId: string;
  readonly figure: FigureDescriptor;
  readonly retrievalStatus: 'metadata-only' | 'included' | 'unavailable';
  readonly dataEncoding?: 'base64';
  readonly dataBase64?: string;
}

const isPdf = (preview: Buffer): boolean => {
  const index = preview.indexOf('%PDF-', 0, 'ascii');
  return index >= 0 && index <= 1_024;
};

const isZip = (preview: Buffer): boolean =>
  preview.length >= 4 &&
  preview[0] === 0x50 &&
  preview[1] === 0x4b &&
  ((preview[2] === 0x03 && preview[3] === 0x04) ||
    (preview[2] === 0x05 && preview[3] === 0x06) ||
    (preview[2] === 0x07 && preview[3] === 0x08));

const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

const descriptorWithoutContent = (
  section: SectionRecord,
): Omit<SectionRecord, 'markdown' | 'blocks'> => ({
  sectionId: section.sectionId,
  title: section.title,
  level: section.level,
  order: section.order,
  ...(section.pageStart === undefined ? {} : { pageStart: section.pageStart }),
  ...(section.pageEnd === undefined ? {} : { pageEnd: section.pageEnd }),
  textCharacters: section.textCharacters,
  tableIds: [...section.tableIds],
  figureIds: [...section.figureIds],
});

const tableWithoutContent = (table: TableRecord): Omit<TableRecord, 'headers' | 'rows'> => ({
  tableId: table.tableId,
  order: table.order,
  ...(table.title === undefined ? {} : { title: table.title }),
  sectionId: table.sectionId,
  rowCount: table.rowCount,
  columnCount: table.columnCount,
  hasHeader: table.hasHeader,
  extractionMethod: table.extractionMethod,
  confidence: table.confidence,
  provenance: table.provenance,
});

const safeSlice = (
  text: string,
  requestedOffset: number,
  maximumCharacters: number,
): { readonly offset: number; readonly end: number; readonly content: string } => {
  let offset = requestedOffset;
  if (
    offset > 0 &&
    offset < text.length &&
    /[\uDC00-\uDFFF]/u.test(text[offset] ?? '') &&
    /[\uD800-\uDBFF]/u.test(text[offset - 1] ?? '')
  ) {
    offset += 1;
  }
  let end = Math.min(text.length, offset + maximumCharacters);
  if (
    end > offset &&
    end < text.length &&
    /[\uD800-\uDBFF]/u.test(text[end - 1] ?? '') &&
    /[\uDC00-\uDFFF]/u.test(text[end] ?? '')
  ) {
    end -= 1;
  }
  if (end === offset && offset < text.length) {
    end = Math.min(text.length, offset + 2);
  }
  return { offset, end, content: text.slice(offset, end) };
};

export class DocumentOptimizer {
  private readonly documents = new Map<string, StoredDocument>();
  private readonly packagesDirectory: string;

  public constructor(
    private readonly config: DocumentOptimizerConfig,
    private readonly boundary: RootBoundary,
    private readonly queue: BoundedQueue,
    scratchPath: string,
    private readonly logger: CapabilityLogger,
  ) {
    this.packagesDirectory = join(scratchPath, 'documents');
  }

  public async optimize(
    sourcePath: string,
    callerSignal: AbortSignal,
  ): Promise<OptimizationResult> {
    return await this.queue.run(async () => {
      const opened = await this.boundary.openFile(sourcePath, { previewBytes: 4_096 });
      let source: Buffer | undefined;
      let readFailure: unknown;
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of opened.createReadStream({ signal: callerSignal })) {
          if (!Buffer.isBuffer(chunk))
            throw internalError('Confined source stream emitted non-bytes');
          chunks.push(chunk);
          bytes += chunk.byteLength;
        }
        if (bytes !== opened.sizeBytes) {
          throw badRequest('The source document changed size while it was being read');
        }
        source = Buffer.concat(chunks, bytes);
      } catch (error) {
        readFailure = error;
      }
      try {
        await opened.close();
      } catch (closeError) {
        throw internalError(
          'Source document descriptor cleanup failed',
          new AggregateError(readFailure === undefined ? [closeError] : [readFailure, closeError]),
        );
      }
      if (readFailure !== undefined) {
        if (readFailure instanceof Error) throw readFailure;
        throw internalError('Source document read failed', readFailure);
      }
      if (source === undefined) throw internalError('Source document read produced no bytes');

      const extension = extensionOf(opened.relativePath);
      const format = extension === '.pdf' ? 'pdf' : extension === '.docx' ? 'docx' : undefined;
      if (format === undefined) {
        throw badRequest('Only .pdf and .docx source files are supported');
      }
      if (
        (format === 'pdf' && !isPdf(opened.preview)) ||
        (format === 'docx' && !isZip(opened.preview))
      ) {
        throw badRequest(
          `The source bytes do not match the ${format.toUpperCase()} file extension`,
        );
      }

      const sourceDigest = sha256(source);
      const idDigest = sha256(
        [
          'document-optimizer',
          optimizerPipelineVersion,
          this.config.service.version,
          opened.relativePath,
          sourceDigest,
        ].join('\0'),
      );
      const documentId = `doc_${idDigest.slice(0, 32)}`;
      const cached = this.documents.get(documentId);
      if (cached) return { manifest: cached.package.manifest, cacheHit: true };
      if (this.documents.size >= this.config.documents.limits.maxCachedDocuments) {
        throw limitExceeded(
          `The process-lifetime cache already contains ${String(
            this.config.documents.limits.maxCachedDocuments,
          )} optimized documents`,
          {
            limit: 'maxCachedDocuments',
            maxCachedDocuments: this.config.documents.limits.maxCachedDocuments,
          },
        );
      }

      const processing = createProcessingSignal(
        callerSignal,
        this.config.documents.limits.processingTimeoutMs,
      );
      try {
        const parsed =
          format === 'pdf'
            ? await parsePdf(source, this.config.documents.limits, processing.signal)
            : await parseDocx(source, this.config.documents.limits, processing.signal);
        const built = finalizeRepresentationSize(
          buildRepresentation({
            documentId,
            optimizerVersion: this.config.service.version,
            source: {
              relativePath: opened.relativePath,
              sha256: sourceDigest,
              bytes: source.byteLength,
            },
            parsed,
          }),
        );
        const packagePath = await this.persist(documentId, built.package, built.assets);
        this.documents.set(documentId, {
          package: built.package,
          assets: built.assets,
          packagePath,
        });
        return { manifest: built.package.manifest, cacheHit: false };
      } catch (error) {
        this.logger.warn(
          { errorName: errorName(error), sourcePath: opened.relativePath },
          'Document optimization failed',
        );
        throw error;
      } finally {
        processing.dispose();
      }
    }, callerSignal);
  }

  public inspect(documentId: string): DocumentManifest {
    return this.get(documentId).package.manifest;
  }

  public outline(documentId: string, offset: number, limit: number): OutlineResult {
    const entries = this.get(documentId).package.outline;
    if (offset > entries.length) throw badRequest('Outline offset exceeds the number of entries');
    const page = entries.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      documentId,
      offset,
      limit,
      total: entries.length,
      entries: page,
      truncated: nextOffset < entries.length,
      nextOffset: nextOffset < entries.length ? nextOffset : null,
    };
  }

  public section(
    documentId: string,
    requestedSectionId: string,
    offset: number,
    requestedMaximum: number,
  ): SectionResult {
    const document = this.get(documentId);
    const section = document.package.sections.find(
      ({ sectionId: candidate }) => candidate === requestedSectionId,
    );
    if (!section) throw notFound(`Unknown section: ${requestedSectionId}`);
    if (offset > section.markdown.length) {
      throw badRequest('Section offset exceeds the section length');
    }
    const appliedMaximum = Math.min(
      requestedMaximum,
      this.config.documents.limits.maxResultCharacters,
    );
    const sliced = safeSlice(section.markdown, offset, appliedMaximum);
    const matching = section.blocks.filter(
      (block) => block.endCharacter > sliced.offset && block.startCharacter < sliced.end,
    );
    const provenance = matching.slice(0, 100);
    return {
      documentId,
      section: descriptorWithoutContent(section),
      offset: sliced.offset,
      appliedMaxCharacters: appliedMaximum,
      limitClamped: requestedMaximum > appliedMaximum,
      totalCharacters: section.markdown.length,
      content: sliced.content,
      truncated: sliced.end < section.markdown.length,
      nextOffset: sliced.end < section.markdown.length ? sliced.end : null,
      provenance,
      provenanceTruncated: provenance.length < matching.length,
    };
  }

  public table(
    documentId: string,
    requestedTableId: string,
    offset: number,
    maximumRows: number,
    format: 'structured' | 'markdown' | 'csv',
  ): TableResult {
    const document = this.get(documentId);
    const table = document.package.tables.find(({ tableId }) => tableId === requestedTableId);
    if (!table) throw notFound(`Unknown table: ${requestedTableId}`);
    if (offset > table.rows.length) throw badRequest('Table row offset exceeds the row count');

    const maximumCharacters = this.config.documents.limits.maxResultCharacters;
    const rows: string[][] = [];
    let characters = table.headers.reduce((total, value) => total + value.length, 0);
    let rendered =
      format === 'structured'
        ? undefined
        : format === 'markdown'
          ? markdownTable(table.headers, rows)
          : csvTable(table.headers, rows);
    if ((rendered?.length ?? characters) > maximumCharacters) {
      throw limitExceeded('The table headers exceed the configured result character limit', {
        limit: 'maxResultCharacters',
        maxResultCharacters: maximumCharacters,
      });
    }
    let resultLimitReached = false;
    for (const row of table.rows.slice(offset, offset + maximumRows)) {
      const rowCharacters = row.reduce((total, value) => total + value.length, 0);
      const candidateRows = [...rows, [...row]];
      const candidateRendered =
        format === 'structured'
          ? undefined
          : format === 'markdown'
            ? markdownTable(table.headers, candidateRows)
            : csvTable(table.headers, candidateRows);
      if ((candidateRendered?.length ?? characters + rowCharacters) > maximumCharacters) {
        if (rows.length === 0) {
          throw limitExceeded('The next table row exceeds the configured result character limit', {
            limit: 'maxResultCharacters',
            maxResultCharacters: maximumCharacters,
            rowOffset: offset,
          });
        }
        resultLimitReached = true;
        break;
      }
      rows.push([...row]);
      characters += rowCharacters;
      rendered = candidateRendered;
    }
    const nextOffset = offset + rows.length;
    const common = {
      documentId,
      table: tableWithoutContent(table),
      offset,
      totalRows: table.rows.length,
      truncated: nextOffset < table.rows.length,
      nextOffset: nextOffset < table.rows.length ? nextOffset : null,
      resultLimitReached,
    };
    if (format === 'structured') {
      return { ...common, format, headers: [...table.headers], rows };
    }
    return {
      ...common,
      format,
      content: rendered!,
    };
  }

  public figure(documentId: string, requestedFigureId: string, includeData: boolean): FigureResult {
    const document = this.get(documentId);
    const figure = document.package.figures.find(({ figureId }) => figureId === requestedFigureId);
    if (!figure) throw notFound(`Unknown figure: ${requestedFigureId}`);
    if (!includeData) return { documentId, figure, retrievalStatus: 'metadata-only' };
    const reference = figure.asset.reference;
    const data = reference === undefined ? undefined : document.assets.get(reference);
    if (data === undefined) return { documentId, figure, retrievalStatus: 'unavailable' };
    return {
      documentId,
      figure,
      retrievalStatus: 'included',
      dataEncoding: 'base64',
      dataBase64: data.toString('base64'),
    };
  }

  private get(documentId: string): StoredDocument {
    const document = this.documents.get(documentId);
    if (!document) {
      throw notFound(
        `Unknown document: ${documentId}. Optimize the source in this process before retrieving it.`,
      );
    }
    return document;
  }

  private async persist(
    documentId: string,
    document: StoredDocument['package'],
    assets: ReadonlyMap<string, Buffer>,
  ): Promise<string> {
    await mkdir(this.packagesDirectory, { recursive: true });
    const partial = await mkdtemp(join(this.packagesDirectory, '.partial-'));
    const destination = join(this.packagesDirectory, documentId);
    try {
      await writeFile(join(partial, 'document.json'), serializeOptimizedDocument(document), {
        encoding: 'utf8',
        flag: 'wx',
      });
      for (const [reference, data] of assets) {
        if (!/^figures\/[a-f0-9]{24}\.(?:png|jpg|gif|webp)$/u.test(reference)) {
          throw internalError('Generated figure reference failed confinement validation');
        }
        const target = join(partial, ...reference.split('/'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, data, { flag: 'wx' });
      }
      await rename(partial, destination);
      return destination;
    } catch (error) {
      try {
        await rm(partial, { recursive: true, force: true, maxRetries: 3 });
      } catch (cleanupError) {
        throw internalError(
          'Partial optimized package cleanup failed',
          new AggregateError([error, cleanupError]),
        );
      }
      if (error instanceof Error) throw error;
      throw internalError('Optimized package persistence failed', error);
    }
  }
}
