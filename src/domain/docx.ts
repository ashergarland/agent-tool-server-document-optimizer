import { posix } from 'node:path';
import { AppError, badRequest, limitExceeded } from '@agent-tool-platform/runtime/errors';
import { BoundedWarnings } from '@agent-tool-platform/runtime/limits';
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import type { DocumentOptimizerLimits } from '../config.js';
import { maximumManifestWarnings } from './model.js';
import type { DocumentMetadata } from './model.js';
import type { ParsedBlock, ParsedDocument, ParsedFigure, ParsedTable } from './parser-types.js';
import {
  abortable,
  boundedValue,
  detectSafeRasterMediaType,
  extensionForMediaType,
  normalizeWhitespace,
  sha256,
  throwIfAborted,
} from './util.js';

const maximumCompressionRatio = 200;
const compressionRatioThresholdBytes = 1024 * 1024;
const maximumNestedArchives = 16;
const maximumTables = 1_000;
const maximumFigures = 1_000;
const maximumTableRows = 2_000;
const maximumTableColumns = 64;
const maximumTableCellCharacters = 64_000;
const maximumParagraphs = 100_000;
const documentEntry = 'word/document.xml';
const relationshipsEntry = 'word/_rels/document.xml.rels';
const stylesEntry = 'word/styles.xml';
const corePropertiesEntry = 'docProps/core.xml';
const appPropertiesEntry = 'docProps/app.xml';
const contentTypesEntry = '[Content_Types].xml';

interface ArchiveContents {
  readonly entries: ReadonlyMap<string, Buffer>;
  readonly omittedMedia: ReadonlySet<string>;
  readonly macroPresent: boolean;
  readonly nestedArchiveCount: number;
}

interface Relationship {
  readonly target?: string;
  readonly external: boolean;
}

interface StyleInfo {
  readonly name?: string;
  readonly outlineLevel?: number;
}

interface RawFigure {
  readonly relationshipId: string;
  readonly width?: number;
  readonly height?: number;
  readonly altText?: string;
  readonly caption?: string;
  readonly blockIndex: number;
}

interface PendingDrawing {
  relationshipId: string | undefined;
  width: number | undefined;
  height: number | undefined;
  altText: string | undefined;
}

interface ParagraphBuilder {
  readonly parts: string[];
  readonly figures: PendingDrawing[];
  styleId: string | undefined;
  outlineLevel: number | undefined;
  listLevel: number | undefined;
  listId: string | undefined;
}

interface RowBuilder {
  readonly cells: string[];
  header: boolean;
}

interface TableBuilder {
  readonly rows: RowBuilder[];
  currentRow: RowBuilder | undefined;
  currentCellParts: string[] | undefined;
  readonly sourceIndex: number;
}

interface DocumentBody {
  readonly blocks: readonly ParsedBlock[];
  readonly tables: readonly ParsedTable[];
  readonly figures: readonly RawFigure[];
}

const nestedArchiveExtensions = new Set(['.docx', '.docm', '.xlsx', '.pptx', '.zip', '.jar']);

const isArchivePathSafe = (name: string): boolean => {
  if (
    name.length === 0 ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[a-zA-Z]:/u.test(name)
  ) {
    return false;
  }
  return !name.split('/').some((segment) => segment === '.' || segment === '..');
};

const isSymbolicLinkEntry = (entry: Entry): boolean => {
  const creatorSystem = entry.versionMadeBy >>> 8;
  if (creatorSystem !== 3) return false;
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
};

const extensionOfArchiveEntry = (name: string): string => {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
};

const isXmlEntry = (name: string): boolean =>
  name === documentEntry ||
  name === relationshipsEntry ||
  name === stylesEntry ||
  name === corePropertiesEntry ||
  name === appPropertiesEntry ||
  name === contentTypesEntry;

const readZipEntry = async (
  zip: ZipFile,
  entry: Entry,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Buffer> => {
  const stream = await abortable(zip.openReadStreamPromise(entry), signal);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    throwIfAborted(signal);
    if (!Buffer.isBuffer(chunk)) throw badRequest('The DOCX archive emitted invalid entry data');
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) {
      throw limitExceeded(`DOCX entry exceeds the ${String(maximumBytes)} byte limit`, {
        limit: 'docxEntryBytes',
        maxEntryBytes: maximumBytes,
      });
    }
    chunks.push(chunk);
  }
  if (bytes !== entry.uncompressedSize) {
    throw badRequest('A DOCX archive entry ended before its declared size');
  }
  return Buffer.concat(chunks, bytes);
};

const readArchive = async (
  source: Buffer,
  limits: DocumentOptimizerLimits,
  signal: AbortSignal,
): Promise<ArchiveContents> => {
  let zip: ZipFile;
  try {
    zip = await abortable(
      yauzl.fromBufferPromise(source, {
        autoClose: false,
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      }),
      signal,
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw badRequest('The DOCX ZIP container is malformed');
  }

  if (zip.entryCount > limits.maxArchiveEntries) {
    zip.close();
    throw limitExceeded(
      `DOCX archive exceeds the ${String(limits.maxArchiveEntries)} entry limit`,
      { limit: 'maxArchiveEntries', maxArchiveEntries: limits.maxArchiveEntries },
    );
  }

  const entries = new Map<string, Buffer>();
  const seen = new Set<string>();
  const omittedMedia = new Set<string>();
  let macroPresent = false;
  let nestedArchiveCount = 0;
  let totalUncompressedBytes = 0;

  try {
    for await (const entry of zip.eachEntry()) {
      throwIfAborted(signal);
      const name = entry.fileName;
      if (!isArchivePathSafe(name)) {
        throw badRequest('DOCX archive contains an unsafe entry path');
      }
      if (seen.has(name)) throw badRequest('DOCX archive contains duplicate entry names');
      seen.add(name);
      if (isSymbolicLinkEntry(entry)) {
        throw badRequest('DOCX archive contains a symbolic-link entry');
      }
      if (entry.isEncrypted()) throw badRequest('Encrypted DOCX archive entries are not supported');
      if (!entry.canDecodeFileData()) {
        throw badRequest('DOCX archive uses an unsupported compression method');
      }
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
        throw badRequest('DOCX archive declares an invalid entry size');
      }
      totalUncompressedBytes += entry.uncompressedSize;
      if (totalUncompressedBytes > limits.maxArchiveBytes) {
        throw limitExceeded(
          `DOCX archive exceeds the ${String(limits.maxArchiveBytes)} uncompressed-byte limit`,
          { limit: 'maxArchiveBytes', maxArchiveBytes: limits.maxArchiveBytes },
        );
      }
      if (
        entry.uncompressedSize >= compressionRatioThresholdBytes &&
        (entry.compressedSize === 0 ||
          entry.uncompressedSize / entry.compressedSize > maximumCompressionRatio)
      ) {
        throw limitExceeded(
          `DOCX entry exceeds the ${String(maximumCompressionRatio)}:1 compression-ratio limit`,
          { limit: 'docxCompressionRatio', maxCompressionRatio: maximumCompressionRatio },
        );
      }

      const lowerName = name.toLowerCase();
      macroPresent ||= lowerName.endsWith('/vbaproject.bin') || lowerName === 'vbaproject.bin';
      if (nestedArchiveExtensions.has(extensionOfArchiveEntry(name))) {
        nestedArchiveCount += 1;
        if (nestedArchiveCount > maximumNestedArchives) {
          throw limitExceeded(
            `DOCX archive exceeds the ${String(maximumNestedArchives)} nested-archive inventory limit`,
            { limit: 'nestedArchives', maxNestedArchives: maximumNestedArchives },
          );
        }
      }
      if (name.endsWith('/')) continue;

      if (isXmlEntry(name)) {
        if (entry.uncompressedSize > limits.maxXmlBytes) {
          throw limitExceeded(
            `DOCX XML part exceeds the ${String(limits.maxXmlBytes)} byte limit`,
            {
              limit: 'maxXmlBytes',
              maxXmlBytes: limits.maxXmlBytes,
            },
          );
        }
        entries.set(name, await readZipEntry(zip, entry, limits.maxXmlBytes, signal));
      } else if (name.startsWith('word/media/')) {
        if (entry.uncompressedSize > limits.maxFigureBytes) {
          omittedMedia.add(name);
        } else {
          entries.set(name, await readZipEntry(zip, entry, limits.maxFigureBytes, signal));
        }
      }
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (
      error instanceof Error &&
      /^(?:invalid characters in fileName|absolute path|invalid relative path):/u.test(
        error.message,
      )
    ) {
      throw badRequest('DOCX archive contains an unsafe entry path');
    }
    throw badRequest('The DOCX ZIP container is malformed');
  } finally {
    zip.close();
  }

  if (!entries.has(contentTypesEntry) || !entries.has(documentEntry)) {
    throw badRequest('The archive is not a valid DOCX document');
  }
  return { entries, omittedMedia, macroPresent, nestedArchiveCount };
};

const safeXml = (buffer: Buffer, entry: string): string => {
  const text = buffer.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) {
    throw badRequest(`DOCX XML part ${entry} contains a prohibited document type or entity`);
  }
  return text;
};

const localName = (name: string): string => name.slice(name.indexOf(':') + 1);

const attribute = (tag: SaxesTagPlain, ...names: readonly string[]): string | undefined => {
  for (const name of names) {
    const value = tag.attributes[name];
    if (typeof value === 'string') return value;
  }
  return undefined;
};

const createParser = (): SaxesParser<{ xmlns: false }> => {
  const parser = new SaxesParser({ xmlns: false });
  parser.on('error', (error) => {
    throw error;
  });
  parser.on('doctype', () => {
    throw badRequest('DOCX XML document types are not permitted');
  });
  return parser;
};

const parseRelationships = (
  xml: string,
  warnings: BoundedWarnings,
): ReadonlyMap<string, Relationship> => {
  const relationships = new Map<string, Relationship>();
  const parser = createParser();
  parser.on('opentag', (tag) => {
    if (localName(tag.name) !== 'Relationship') return;
    const id = attribute(tag, 'Id', 'id');
    const type = attribute(tag, 'Type', 'type');
    const target = attribute(tag, 'Target', 'target');
    const external = attribute(tag, 'TargetMode', 'targetMode') === 'External';
    if (!id || !type?.endsWith('/image')) return;
    if (external) {
      relationships.set(id, { external: true });
      warnings.add('An external DOCX image relationship was inventoried but not fetched.');
      return;
    }
    if (!target || target.includes('\\') || target.startsWith('/')) {
      relationships.set(id, { external: false });
      warnings.add('A DOCX image relationship had an unsafe target and was not extracted.');
      return;
    }
    const resolved = posix.normalize(posix.join('word', target));
    if (!resolved.startsWith('word/') || resolved.split('/').includes('..')) {
      relationships.set(id, { external: false });
      warnings.add(
        'A DOCX image relationship escaped the document namespace and was not extracted.',
      );
      return;
    }
    relationships.set(id, { target: resolved, external: false });
  });
  parser.write(xml).close();
  return relationships;
};

const parseStyles = (xml: string): ReadonlyMap<string, StyleInfo> => {
  const styles = new Map<string, StyleInfo>();
  const parser = createParser();
  let current:
    | {
        id: string;
        paragraph: boolean;
        name: string | undefined;
        outlineLevel: number | undefined;
      }
    | undefined;
  parser.on('opentag', (tag) => {
    const name = localName(tag.name);
    if (name === 'style') {
      const id = attribute(tag, 'w:styleId', 'styleId');
      if (id) {
        current = {
          id,
          paragraph: attribute(tag, 'w:type', 'type') === 'paragraph',
          name: undefined,
          outlineLevel: undefined,
        };
      }
    } else if (current && name === 'name') {
      const value = attribute(tag, 'w:val', 'val');
      if (value !== undefined) current.name = value;
    } else if (current && name === 'outlineLvl') {
      const value = Number(attribute(tag, 'w:val', 'val'));
      if (Number.isInteger(value) && value >= 0 && value < 9) current.outlineLevel = value;
    }
  });
  parser.on('closetag', (tag) => {
    if (localName(tag.name) !== 'style' || !current) return;
    if (current.paragraph) {
      styles.set(current.id, {
        ...(current.name === undefined ? {} : { name: current.name }),
        ...(current.outlineLevel === undefined ? {} : { outlineLevel: current.outlineLevel }),
      });
    }
    current = undefined;
  });
  parser.write(xml).close();
  return styles;
};

const parsePropertyValues = (
  xml: string,
  names: ReadonlySet<string>,
): ReadonlyMap<string, string> => {
  const values = new Map<string, string>();
  const parser = createParser();
  let capture: string | undefined;
  let parts: string[] = [];
  parser.on('opentag', (tag) => {
    const name = localName(tag.name);
    if (names.has(name)) {
      capture = name;
      parts = [];
    }
  });
  parser.on('text', (text) => {
    if (capture !== undefined) parts.push(text);
  });
  parser.on('closetag', (tag) => {
    if (capture === undefined || localName(tag.name) !== capture) return;
    const value = normalizeWhitespace(parts.join(''));
    if (value.length > 0) values.set(capture, value);
    capture = undefined;
    parts = [];
  });
  parser.write(xml).close();
  return values;
};

const parseMetadata = (
  coreXml: string | undefined,
  appXml: string | undefined,
): { metadata: DocumentMetadata; pageCount: number | null } => {
  const core =
    coreXml === undefined
      ? new Map<string, string>()
      : parsePropertyValues(
          coreXml,
          new Set(['title', 'creator', 'subject', 'keywords', 'created', 'modified', 'language']),
        );
  const app =
    appXml === undefined
      ? new Map<string, string>()
      : parsePropertyValues(appXml, new Set(['Application', 'Pages', 'Words']));
  const value = (
    source: ReadonlyMap<string, string>,
    key: string,
    maximum: number,
  ): string | undefined => {
    const candidate = source.get(key);
    return candidate === undefined ? undefined : boundedValue(candidate, maximum);
  };
  const title = value(core, 'title', 1_000);
  const author = value(core, 'creator', 1_000);
  const subject = value(core, 'subject', 2_000);
  const keywords = value(core, 'keywords', 2_000);
  const created = value(core, 'created', 200);
  const modified = value(core, 'modified', 200);
  const language = value(core, 'language', 100);
  const producer = value(app, 'Application', 1_000);
  const words = Number(app.get('Words'));
  const pages = Number(app.get('Pages'));
  return {
    metadata: {
      ...(title === undefined ? {} : { title }),
      ...(author === undefined ? {} : { author }),
      ...(subject === undefined ? {} : { subject }),
      ...(keywords === undefined ? {} : { keywords }),
      ...(created === undefined ? {} : { created }),
      ...(modified === undefined ? {} : { modified }),
      ...(language === undefined ? {} : { language }),
      ...(producer === undefined ? {} : { producer }),
      ...(Number.isInteger(words) && words >= 0 ? { reportedWordCount: words } : {}),
    },
    pageCount: Number.isInteger(pages) && pages >= 0 ? pages : null,
  };
};

const headingLevel = (
  paragraph: ParagraphBuilder,
  styles: ReadonlyMap<string, StyleInfo>,
): number | undefined => {
  if (paragraph.outlineLevel !== undefined) return Math.min(paragraph.outlineLevel + 1, 6);
  const style = paragraph.styleId === undefined ? undefined : styles.get(paragraph.styleId);
  if (style?.outlineLevel !== undefined) return Math.min(style.outlineLevel + 1, 6);
  const name = style?.name ?? paragraph.styleId;
  const match = name?.match(/heading[\s_-]*([1-6])/iu);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

const extentPixels = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const emu = Number(value);
  return Number.isFinite(emu) && emu > 0 ? Math.max(1, Math.round(emu / 9_525)) : undefined;
};

const parseDocumentBody = (
  xml: string,
  styles: ReadonlyMap<string, StyleInfo>,
  limits: DocumentOptimizerLimits,
  warnings: BoundedWarnings,
): DocumentBody => {
  const parser = createParser();
  const blocks: ParsedBlock[] = [];
  const tables: ParsedTable[] = [];
  const figures: RawFigure[] = [];
  const tableStack: TableBuilder[] = [];
  let paragraph: ParagraphBuilder | undefined;
  let paragraphIndex = 0;
  let tableIndex = 0;
  let textDepth = 0;
  let numberingDepth = 0;
  let drawingDepth = 0;
  let drawing: PendingDrawing | undefined;
  let extractedCharacters = 0;
  let ignoredSubtreeDepth = 0;

  const addText = (text: string): void => {
    if (!paragraph || text.length === 0) return;
    paragraph.parts.push(text);
    extractedCharacters += text.length;
    if (extractedCharacters > limits.maxExtractedCharacters) {
      throw limitExceeded(
        `Extracted DOCX text exceeds the ${String(limits.maxExtractedCharacters)} character limit`,
        {
          limit: 'maxExtractedCharacters',
          maxExtractedCharacters: limits.maxExtractedCharacters,
        },
      );
    }
  };

  const finishParagraph = (): void => {
    if (!paragraph) return;
    const text = normalizeWhitespace(paragraph.parts.join(''));
    const figureIndexes: number[] = [];
    for (const pending of paragraph.figures) {
      if (!pending.relationshipId) continue;
      if (figures.length >= maximumFigures) {
        throw limitExceeded(`DOCX exceeds the ${String(maximumFigures)} figure limit`, {
          limit: 'docxFigures',
          maxFigures: maximumFigures,
        });
      }
      figureIndexes.push(figures.length);
      figures.push({
        relationshipId: pending.relationshipId,
        ...(pending.width === undefined ? {} : { width: pending.width }),
        ...(pending.height === undefined ? {} : { height: pending.height }),
        ...(pending.altText === undefined ? {} : { altText: pending.altText }),
        ...(text.length === 0 ? {} : { caption: boundedValue(text, 1_000) }),
        blockIndex: paragraphIndex,
      });
    }

    const table = tableStack.at(-1);
    if (table?.currentCellParts) {
      if (text.length > 0) table.currentCellParts.push(text);
      if (figureIndexes.length > 0) {
        table.currentCellParts.push(
          figureIndexes.map((index) => `[Figure ${String(index + 1)}]`).join(' '),
        );
      }
    } else if (text.length > 0 || figureIndexes.length > 0) {
      const level = headingLevel(paragraph, styles);
      const kind =
        level !== undefined
          ? 'heading'
          : paragraph.listId !== undefined || paragraph.listLevel !== undefined
            ? 'list'
            : 'paragraph';
      blocks.push({
        kind,
        text,
        ...(level === undefined ? {} : { headingLevel: level }),
        figureIndexes,
        blockIndex: paragraphIndex,
        archiveEntry: documentEntry,
        locator: `docx:word/document.xml;paragraph=${String(paragraphIndex + 1)}`,
      });
    }
    paragraphIndex += 1;
    if (paragraphIndex > maximumParagraphs) {
      throw limitExceeded(`DOCX exceeds the ${String(maximumParagraphs)} paragraph limit`, {
        limit: 'docxParagraphs',
        maxParagraphs: maximumParagraphs,
      });
    }
    paragraph = undefined;
  };

  const finishTable = (): void => {
    const table = tableStack.pop();
    if (!table) return;
    const rows = table.rows.filter((row) => row.cells.some((cell) => cell.length > 0));
    if (rows.length > maximumTableRows + 1) {
      throw limitExceeded(`DOCX table exceeds the ${String(maximumTableRows)} row limit`, {
        limit: 'docxTableRows',
        maxRows: maximumTableRows,
      });
    }
    const columns = Math.max(...rows.map((row) => row.cells.length), 0);
    if (columns > maximumTableColumns) {
      throw limitExceeded(`DOCX table exceeds the ${String(maximumTableColumns)} column limit`, {
        limit: 'docxTableColumns',
        maxColumns: maximumTableColumns,
      });
    }
    if (columns === 0) return;
    const normalizedRows = rows.map((row) =>
      Array.from({ length: columns }, (_, index) => {
        const cell = normalizeWhitespace(row.cells[index] ?? '');
        if (cell.length > maximumTableCellCharacters) {
          throw limitExceeded(
            `DOCX table cell exceeds the ${String(maximumTableCellCharacters)} character limit`,
            { limit: 'docxTableCellCharacters', maxCharacters: maximumTableCellCharacters },
          );
        }
        return cell;
      }),
    );
    const hasHeader = rows[0]?.header === true;
    const headers = hasHeader
      ? (normalizedRows[0] ?? [])
      : Array.from({ length: columns }, (_, index) => `Column ${String(index + 1)}`);
    const dataRows = hasHeader ? normalizedRows.slice(1) : normalizedRows;
    if (tables.length >= maximumTables) {
      throw limitExceeded(`DOCX exceeds the ${String(maximumTables)} table limit`, {
        limit: 'docxTables',
        maxTables: maximumTables,
      });
    }
    const parsedTableIndex = tables.length;
    tables.push({
      headers,
      rows: dataRows,
      hasHeader,
      extractionMethod: 'docx-ooxml',
      confidence: hasHeader ? 'high' : 'medium',
      blockIndex: table.sourceIndex,
      archiveEntry: documentEntry,
      locator: `docx:word/document.xml;table=${String(table.sourceIndex + 1)}`,
    });

    const parent = tableStack.at(-1);
    if (parent?.currentCellParts) {
      parent.currentCellParts.push(`[Nested table ${String(parsedTableIndex + 1)}]`);
      warnings.add(
        'A nested DOCX table was extracted separately and referenced from its parent cell.',
      );
    } else {
      blocks.push({
        kind: 'table',
        text: '',
        tableIndex: parsedTableIndex,
        figureIndexes: [],
        blockIndex: table.sourceIndex,
        archiveEntry: documentEntry,
        locator: `docx:word/document.xml;table=${String(table.sourceIndex + 1)}`,
      });
    }
  };

  parser.on('opentag', (tag) => {
    const name = localName(tag.name);
    if (ignoredSubtreeDepth > 0) {
      ignoredSubtreeDepth += 1;
      return;
    }
    if (name === 'txbxContent') {
      ignoredSubtreeDepth = 1;
      warnings.add('Text-box content was skipped; ordinary document text remains available.');
      return;
    }
    if (name === 'Fallback') {
      ignoredSubtreeDepth = 1;
      warnings.add(
        'OOXML compatibility fallback content was skipped to avoid duplicate extraction.',
      );
      return;
    }
    switch (name) {
      case 'p':
        if (paragraph) throw badRequest('DOCX contains unsupported nested paragraphs');
        paragraph = {
          parts: [],
          figures: [],
          styleId: undefined,
          outlineLevel: undefined,
          listLevel: undefined,
          listId: undefined,
        };
        break;
      case 't':
        textDepth += 1;
        break;
      case 'tab':
        addText('\t');
        break;
      case 'br':
      case 'cr':
        addText('\n');
        break;
      case 'pStyle':
        if (paragraph) {
          const value = attribute(tag, 'w:val', 'val');
          if (value !== undefined) paragraph.styleId = value;
        }
        break;
      case 'numPr':
        numberingDepth += 1;
        break;
      case 'ilvl':
        if (paragraph && numberingDepth > 0) {
          const value = Number(attribute(tag, 'w:val', 'val'));
          if (Number.isInteger(value) && value >= 0) paragraph.listLevel = value;
        }
        break;
      case 'numId':
        if (paragraph && numberingDepth > 0) {
          const value = attribute(tag, 'w:val', 'val');
          if (value !== undefined) paragraph.listId = value;
        }
        break;
      case 'outlineLvl':
        if (paragraph) {
          const value = Number(attribute(tag, 'w:val', 'val'));
          if (Number.isInteger(value) && value >= 0) paragraph.outlineLevel = value;
        }
        break;
      case 'drawing':
      case 'pict':
        drawingDepth += 1;
        drawing ??= {
          relationshipId: undefined,
          width: undefined,
          height: undefined,
          altText: undefined,
        };
        break;
      case 'extent':
        if (drawing) {
          const width = extentPixels(attribute(tag, 'cx'));
          const height = extentPixels(attribute(tag, 'cy'));
          if (width !== undefined) drawing.width = width;
          if (height !== undefined) drawing.height = height;
        }
        break;
      case 'docPr':
        if (drawing) {
          const alt = attribute(tag, 'descr', 'title', 'name');
          if (alt) drawing.altText = boundedValue(alt, 2_000);
        }
        break;
      case 'blip':
      case 'imagedata':
        if (drawing) {
          const value = attribute(tag, 'r:embed', 'embed', 'r:id', 'id', 'r:link', 'link');
          if (value !== undefined) drawing.relationshipId = value;
        }
        break;
      case 'tbl':
        tableStack.push({
          rows: [],
          currentRow: undefined,
          currentCellParts: undefined,
          sourceIndex: tableIndex,
        });
        tableIndex += 1;
        break;
      case 'tr': {
        const table = tableStack.at(-1);
        if (table) table.currentRow = { cells: [], header: false };
        break;
      }
      case 'tblHeader': {
        const row = tableStack.at(-1)?.currentRow;
        if (row) row.header = true;
        break;
      }
      case 'tc': {
        const table = tableStack.at(-1);
        if (table) table.currentCellParts = [];
        break;
      }
      default:
        break;
    }
  });
  parser.on('text', (text) => {
    if (ignoredSubtreeDepth === 0 && textDepth > 0) addText(text);
  });
  parser.on('closetag', (tag) => {
    if (ignoredSubtreeDepth > 0) {
      ignoredSubtreeDepth -= 1;
      return;
    }
    const name = localName(tag.name);
    switch (name) {
      case 't':
        textDepth = Math.max(0, textDepth - 1);
        break;
      case 'numPr':
        numberingDepth = Math.max(0, numberingDepth - 1);
        break;
      case 'drawing':
      case 'pict':
        drawingDepth = Math.max(0, drawingDepth - 1);
        if (drawingDepth === 0 && drawing) {
          if (drawing.relationshipId && paragraph) paragraph.figures.push(drawing);
          drawing = undefined;
        }
        break;
      case 'p':
        finishParagraph();
        break;
      case 'tc': {
        const table = tableStack.at(-1);
        const row = table?.currentRow;
        if (table?.currentCellParts && row) {
          row.cells.push(normalizeWhitespace(table.currentCellParts.join(' ')));
          table.currentCellParts = undefined;
        }
        break;
      }
      case 'tr': {
        const table = tableStack.at(-1);
        if (table?.currentRow) {
          table.rows.push(table.currentRow);
          table.currentRow = undefined;
        }
        break;
      }
      case 'tbl':
        finishTable();
        break;
      default:
        break;
    }
  });
  parser.write(xml).close();
  if (paragraph || tableStack.length > 0) {
    throw badRequest('DOCX document structure ended unexpectedly');
  }
  return { blocks, tables, figures };
};

const inferredMediaType = (entry: string | undefined): string | undefined => {
  if (entry === undefined) return undefined;
  switch (extensionOfArchiveEntry(entry)) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.emf':
      return 'image/emf';
    case '.wmf':
      return 'image/wmf';
    default:
      return undefined;
  }
};

const materializeFigures = (
  rawFigures: readonly RawFigure[],
  relationships: ReadonlyMap<string, Relationship>,
  archive: ArchiveContents,
  warnings: BoundedWarnings,
): readonly ParsedFigure[] =>
  rawFigures.map((raw, index) => {
    const relationship = relationships.get(raw.relationshipId);
    const target = relationship?.target;
    const base = {
      ...(raw.width === undefined ? {} : { width: raw.width }),
      ...(raw.height === undefined ? {} : { height: raw.height }),
      ...(raw.caption === undefined ? {} : { caption: raw.caption }),
      blockIndex: raw.blockIndex,
      ...(target === undefined ? {} : { archiveEntry: target }),
      locator: `docx:word/document.xml;drawing=${String(index + 1)}`,
    };
    const description = raw.altText ?? raw.caption;
    const descriptionFields =
      description === undefined
        ? { semanticDescriptionStatus: 'not-generated' as const }
        : {
            semanticDescription: description,
            semanticDescriptionStatus:
              raw.altText === undefined
                ? ('source-caption' as const)
                : ('source-alt-text' as const),
          };

    if (relationship?.external === true) {
      return {
        ...base,
        ...descriptionFields,
        asset: {
          available: false,
          reason: 'External image relationships are not fetched.',
        },
      };
    }
    if (target === undefined) {
      warnings.add('A DOCX figure relationship could not be resolved.');
      return {
        ...base,
        ...descriptionFields,
        asset: {
          available: false,
          reason: 'The image relationship target is missing or unsafe.',
        },
      };
    }
    const inferred = inferredMediaType(target);
    if (archive.omittedMedia.has(target)) {
      warnings.add('A DOCX figure exceeded the configured extracted-asset limit.');
      return {
        ...base,
        ...descriptionFields,
        ...(inferred === undefined ? {} : { mediaType: inferred }),
        asset: {
          available: false,
          reason: 'The embedded image exceeded the configured figure byte limit.',
        },
      };
    }
    const data = archive.entries.get(target);
    if (data === undefined) {
      warnings.add('A DOCX figure referenced a missing media entry.');
      return {
        ...base,
        ...descriptionFields,
        ...(inferred === undefined ? {} : { mediaType: inferred }),
        asset: {
          available: false,
          reason: 'The embedded image entry is missing.',
        },
      };
    }
    const mediaType = detectSafeRasterMediaType(data);
    if (mediaType === undefined) {
      warnings.add('A DOCX figure used a media type that is inventoried but not exported.');
      return {
        ...base,
        ...descriptionFields,
        ...(inferred === undefined ? {} : { mediaType: inferred }),
        asset: {
          available: false,
          reason: 'Only verified PNG, JPEG, GIF, and WebP figure bytes are exported.',
        },
      };
    }
    const digest = sha256(data);
    const extension = extensionForMediaType(mediaType);
    if (extension === undefined) {
      throw badRequest('A verified DOCX image has no supported output extension');
    }
    return {
      ...base,
      ...descriptionFields,
      mediaType,
      asset: {
        available: true,
        reference: `figures/${digest.slice(0, 24)}${extension}`,
        sha256: digest,
        bytes: data.byteLength,
      },
      data,
    };
  });

const normalizeDocxFailure = (error: unknown): Error =>
  error instanceof AppError
    ? error
    : badRequest('The DOCX is malformed or uses unsupported OOXML structures');

export const parseDocx = async (
  source: Buffer,
  limits: DocumentOptimizerLimits,
  signal: AbortSignal,
): Promise<ParsedDocument> => {
  try {
    throwIfAborted(signal);
    const archive = await readArchive(source, limits, signal);
    const warnings = new BoundedWarnings(maximumManifestWarnings - 1);
    if (archive.macroPresent) {
      warnings.add('Embedded macro content was ignored and was not executed.');
    }
    if (archive.nestedArchiveCount > 0) {
      warnings.add(
        `${String(archive.nestedArchiveCount)} nested archive entry or entries were inventoried but not expanded.`,
      );
    }

    const relationshipBuffer = archive.entries.get(relationshipsEntry);
    const relationships =
      relationshipBuffer === undefined
        ? new Map<string, Relationship>()
        : parseRelationships(safeXml(relationshipBuffer, relationshipsEntry), warnings);
    const stylesBuffer = archive.entries.get(stylesEntry);
    const styles =
      stylesBuffer === undefined
        ? new Map<string, StyleInfo>()
        : parseStyles(safeXml(stylesBuffer, stylesEntry));
    const documentBuffer = archive.entries.get(documentEntry);
    if (documentBuffer === undefined) throw badRequest('DOCX document body is missing');
    const body = parseDocumentBody(
      safeXml(documentBuffer, documentEntry),
      styles,
      limits,
      warnings,
    );
    const figures = materializeFigures(body.figures, relationships, archive, warnings);

    const coreBuffer = archive.entries.get(corePropertiesEntry);
    const appBuffer = archive.entries.get(appPropertiesEntry);
    const { metadata, pageCount } = parseMetadata(
      coreBuffer === undefined ? undefined : safeXml(coreBuffer, corePropertiesEntry),
      appBuffer === undefined ? undefined : safeXml(appBuffer, appPropertiesEntry),
    );

    return {
      format: 'docx',
      pageCount,
      pageCountKind: pageCount === null ? 'unavailable' : 'source-property',
      metadata,
      blocks: body.blocks,
      tables: body.tables,
      figures,
      extractionMethods: [
        'docx-ooxml-text-and-heading-structure',
        ...(body.tables.length === 0 ? [] : ['docx-ooxml-table-structure']),
        ...(figures.length === 0 ? [] : ['docx-relationship-media-inventory']),
      ],
      warnings: warnings.list(),
    };
  } catch (error) {
    throw normalizeDocxFailure(error);
  }
};
