import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  AppError,
  badRequest,
  internalError,
  limitExceeded,
} from '@agent-tool-platform/runtime/errors';
import { BoundedWarnings } from '@agent-tool-platform/runtime/limits';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { DocumentOptimizerLimits } from '../config.js';
import { maximumManifestWarnings } from './model.js';
import type { DocumentMetadata } from './model.js';
import type { ParsedBlock, ParsedDocument, ParsedFigure, ParsedTable } from './parser-types.js';
import { abortable, boundedValue, normalizeWhitespace, throwIfAborted } from './util.js';

const maximumTextItems = 250_000;
const maximumOperators = 500_000;
const maximumTables = 1_000;
const maximumFigures = 1_000;
const maximumTableRows = 2_000;
const maximumTableColumns = 64;
const pdfJsPackageDirectory = dirname(
  createRequire(import.meta.url).resolve('pdfjs-dist/package.json'),
);
const pdfJsAssetDirectory = (name: 'cmaps' | 'standard_fonts'): string =>
  `${join(pdfJsPackageDirectory, name).replaceAll('\\', '/')}/`;

interface PdfTextItem {
  readonly str: string;
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
  readonly hasEOL: boolean;
}

interface PdfMarkedContent {
  readonly type: string;
  readonly id?: string;
}

interface PdfLine {
  readonly text: string;
  readonly page: number;
  readonly fontSize: number;
  readonly order: number;
}

interface PdfBookmark {
  readonly title: string;
  readonly level: number;
  readonly page?: number;
}

interface StructNode {
  readonly role: string;
  readonly children: readonly (StructNode | StructContent)[];
}

interface StructContent {
  readonly type: string;
  readonly id: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const isTextItem = (value: unknown): value is PdfTextItem => {
  if (!isRecord(value)) return false;
  return (
    typeof value['str'] === 'string' &&
    Array.isArray(value['transform']) &&
    value['transform'].every((entry) => typeof entry === 'number' && Number.isFinite(entry)) &&
    typeof value['width'] === 'number' &&
    typeof value['height'] === 'number' &&
    typeof value['hasEOL'] === 'boolean'
  );
};

const asMarkedContent = (value: unknown): PdfMarkedContent | undefined => {
  if (!isRecord(value) || typeof value['type'] !== 'string') return undefined;
  const id = typeof value['id'] === 'string' ? value['id'] : undefined;
  return { type: value['type'], ...(id === undefined ? {} : { id }) };
};

const textItemFontSize = (item: PdfTextItem): number => {
  const horizontal = finiteNumber(item.transform[0]) ?? 0;
  const vertical = finiteNumber(item.transform[3]) ?? item.height;
  return Math.max(Math.abs(horizontal), Math.abs(vertical), Math.abs(item.height));
};

const textItemX = (item: PdfTextItem): number => finiteNumber(item.transform[4]) ?? 0;
const textItemY = (item: PdfTextItem): number => finiteNumber(item.transform[5]) ?? 0;

const extractLines = (
  items: readonly unknown[],
  page: number,
  startingOrder: number,
): readonly PdfLine[] => {
  const textItems = items.filter(isTextItem);
  const lines: PdfLine[] = [];
  let current:
    | {
        text: string;
        y: number;
        endX: number;
        fontSize: number;
      }
    | undefined;

  const publish = (): void => {
    if (!current) return;
    const text = normalizeWhitespace(current.text);
    if (text.length > 0) {
      lines.push({
        text,
        page,
        fontSize: current.fontSize,
        order: startingOrder + lines.length,
      });
    }
    current = undefined;
  };

  for (const item of textItems) {
    const text = item.str;
    const x = textItemX(item);
    const y = textItemY(item);
    const fontSize = textItemFontSize(item);
    const sameLine = current !== undefined && Math.abs(current.y - y) <= 2;
    if (!sameLine) publish();

    if (!current) {
      current = { text, y, endX: x + item.width, fontSize };
    } else {
      const gap = x - current.endX;
      const separator =
        current.text.length > 0 && text.length > 0 && gap > Math.max(1, fontSize * 0.12) ? ' ' : '';
      current.text += `${separator}${text}`;
      current.endX = Math.max(current.endX, x + item.width);
      current.fontSize = Math.max(current.fontSize, fontSize);
    }
    if (item.hasEOL) publish();
  }
  publish();
  return lines;
};

const markedContentText = (items: readonly unknown[]): ReadonlyMap<string, string> => {
  const values = new Map<string, string[]>();
  const stack: string[] = [];
  for (const item of items) {
    if (isTextItem(item)) {
      const id = stack.at(-1);
      if (id !== undefined && item.str.length > 0) {
        const parts = values.get(id) ?? [];
        parts.push(item.str);
        values.set(id, parts);
      }
      continue;
    }
    const marker = asMarkedContent(item);
    if (!marker) continue;
    if (marker.type === 'beginMarkedContentProps' && marker.id !== undefined) {
      stack.push(marker.id);
    } else if (marker.type === 'beginMarkedContent') {
      stack.push('');
    } else if (marker.type === 'endMarkedContent') {
      stack.pop();
    }
  }
  return new Map(
    [...values].map(([id, parts]) => [id, normalizeWhitespace(parts.join(' '))] as const),
  );
};

const asStructChild = (value: unknown): StructNode | StructContent | undefined => {
  if (!isRecord(value)) return undefined;
  if (typeof value['role'] === 'string' && Array.isArray(value['children'])) {
    return {
      role: value['role'],
      children: value['children'].map(asStructChild).filter((child) => child !== undefined),
    };
  }
  if (typeof value['type'] === 'string' && typeof value['id'] === 'string') {
    return { type: value['type'], id: value['id'] };
  }
  return undefined;
};

const isStructNode = (value: StructNode | StructContent): value is StructNode => 'role' in value;

const collectTables = (node: StructNode, tables: StructNode[]): void => {
  if (node.role === 'Table') tables.push(node);
  for (const child of node.children) {
    if (isStructNode(child)) collectTables(child, tables);
  }
};

const collectRows = (node: StructNode, rows: StructNode[], root: StructNode): void => {
  for (const child of node.children) {
    if (!isStructNode(child) || child.role === 'Table') continue;
    if (child.role === 'TR') rows.push(child);
    else if (child !== root) collectRows(child, rows, root);
  }
};

const collectCells = (node: StructNode, cells: StructNode[]): void => {
  for (const child of node.children) {
    if (!isStructNode(child) || child.role === 'Table' || child.role === 'TR') continue;
    if (child.role === 'TH' || child.role === 'TD') cells.push(child);
    else collectCells(child, cells);
  }
};

const collectContentIds = (node: StructNode, ids: string[]): void => {
  for (const child of node.children) {
    if (isStructNode(child)) {
      if (child.role !== 'Table') collectContentIds(child, ids);
    } else if (child.type === 'content') {
      ids.push(child.id);
    }
  }
};

const tableFromStructure = (
  tableNode: StructNode,
  content: ReadonlyMap<string, string>,
  page: number,
  tableIndex: number,
): ParsedTable | undefined => {
  const rowNodes: StructNode[] = [];
  collectRows(tableNode, rowNodes, tableNode);
  if (rowNodes.length === 0 || rowNodes.length > maximumTableRows + 1) return undefined;

  const rows = rowNodes.map((rowNode) => {
    const cellNodes: StructNode[] = [];
    collectCells(rowNode, cellNodes);
    return {
      header: cellNodes.length > 0 && cellNodes.every((cell) => cell.role === 'TH'),
      values: cellNodes.map((cell) => {
        const ids: string[] = [];
        collectContentIds(cell, ids);
        return normalizeWhitespace(ids.map((id) => content.get(id) ?? '').join(' '));
      }),
    };
  });
  const columnCount = Math.max(...rows.map((row) => row.values.length), 0);
  if (columnCount === 0 || columnCount > maximumTableColumns) return undefined;

  const hasHeader = rows[0]?.header === true;
  const headers = hasHeader
    ? (rows[0]?.values ?? [])
    : Array.from({ length: columnCount }, (_, index) => `Column ${String(index + 1)}`);
  const dataRows = (hasHeader ? rows.slice(1) : rows).map((row) =>
    Array.from({ length: columnCount }, (_, index) => row.values[index] ?? ''),
  );
  return {
    headers,
    rows: dataRows,
    hasHeader,
    extractionMethod: 'pdf-tagged-structure',
    confidence: 'high',
    page,
    locator: `pdf:page=${String(page)};structure-table=${String(tableIndex + 1)}`,
  };
};

const resolveBookmarkPage = async (
  document: Awaited<ReturnType<typeof getDocument>['promise']>,
  destination: unknown,
  signal: AbortSignal,
): Promise<number | undefined> => {
  let resolved = destination;
  if (typeof resolved === 'string') {
    resolved = await abortable(document.getDestination(resolved), signal);
  }
  if (!Array.isArray(resolved) || resolved.length === 0) return undefined;
  const reference: unknown = resolved[0];
  if (typeof reference === 'number' && Number.isInteger(reference) && reference >= 0) {
    return reference + 1;
  }
  if (
    isRecord(reference) &&
    typeof reference['num'] === 'number' &&
    typeof reference['gen'] === 'number'
  ) {
    return (
      (await abortable(
        document.getPageIndex({ num: reference['num'], gen: reference['gen'] }),
        signal,
      )) + 1
    );
  }
  return undefined;
};

const extractBookmarks = async (
  document: Awaited<ReturnType<typeof getDocument>['promise']>,
  signal: AbortSignal,
): Promise<readonly PdfBookmark[]> => {
  const outline: unknown = await abortable(document.getOutline(), signal);
  if (!Array.isArray(outline)) return [];
  const bookmarks: PdfBookmark[] = [];

  const visit = async (items: readonly unknown[], level: number): Promise<void> => {
    for (const item of items) {
      if (!isRecord(item)) continue;
      const title = typeof item['title'] === 'string' ? boundedValue(item['title'], 300) : '';
      if (title.length > 0) {
        const page = await resolveBookmarkPage(document, item['dest'], signal);
        bookmarks.push({
          title,
          level: Math.min(level, 6),
          ...(page === undefined ? {} : { page }),
        });
      }
      if (Array.isArray(item['items'])) await visit(item['items'], level + 1);
    }
  };

  await visit(outline, 1);
  return bookmarks;
};

const headingLevels = (
  lines: readonly PdfLine[],
  bookmarks: readonly PdfBookmark[],
): ReadonlyMap<number, number> => {
  const result = new Map<number, number>();
  const bookmarkByText = new Map<string, PdfBookmark[]>();
  for (const bookmark of bookmarks) {
    const key = normalizeWhitespace(bookmark.title).toLocaleLowerCase('en-US');
    const values = bookmarkByText.get(key) ?? [];
    values.push(bookmark);
    bookmarkByText.set(key, values);
  }
  for (const line of lines) {
    const matches = bookmarkByText.get(line.text.toLocaleLowerCase('en-US')) ?? [];
    const match = matches.find(
      (bookmark) => bookmark.page === undefined || bookmark.page === line.page,
    );
    if (match) result.set(line.order, match.level);
  }

  const sizes = lines
    .filter((line) => line.text.length > 0)
    .map((line) => line.fontSize)
    .filter((size) => size > 0)
    .sort((left, right) => left - right);
  const median = sizes[Math.floor((sizes.length - 1) / 2)] ?? 0;
  const candidates = lines.filter(
    (line) =>
      !result.has(line.order) &&
      median > 0 &&
      line.fontSize >= Math.max(median + 1, median * 1.2) &&
      line.text.length <= 200 &&
      !(line.text.length > 80 && /[.!?]$/u.test(line.text)),
  );
  const rankedSizes = [...new Set(candidates.map((line) => line.fontSize))].sort(
    (left, right) => right - left,
  );
  for (const line of candidates) {
    const rank = rankedSizes.indexOf(line.fontSize);
    result.set(line.order, Math.min(rank + 1, 6));
  }
  return result;
};

const extractMetadata = (raw: unknown, language: string | null): DocumentMetadata => {
  const info = isRecord(raw) && isRecord(raw['info']) ? raw['info'] : {};
  const field = (name: string, maximum: number): string | undefined => {
    const value = info[name];
    return typeof value === 'string' && normalizeWhitespace(value).length > 0
      ? boundedValue(value, maximum)
      : undefined;
  };
  const title = field('Title', 1_000);
  const author = field('Author', 1_000);
  const subject = field('Subject', 2_000);
  const keywords = field('Keywords', 2_000);
  const creator = field('Creator', 1_000);
  const producer = field('Producer', 1_000);
  const created = field('CreationDate', 200);
  const modified = field('ModDate', 200);
  return {
    ...(title === undefined ? {} : { title }),
    ...(author === undefined ? {} : { author }),
    ...(subject === undefined ? {} : { subject }),
    ...(keywords === undefined ? {} : { keywords }),
    ...(creator === undefined ? {} : { creator }),
    ...(producer === undefined ? {} : { producer }),
    ...(created === undefined ? {} : { created }),
    ...(modified === undefined ? {} : { modified }),
    ...(language === null || language.length === 0
      ? {}
      : { language: boundedValue(language, 100) }),
  };
};

const imageDimensions = (operator: number, args: unknown): { width?: number; height?: number } => {
  if (!isUnknownArray(args)) return {};
  if (operator === OPS.paintImageXObject) {
    const width = finiteNumber(args[1]);
    const height = finiteNumber(args[2]);
    return {
      ...(width === undefined || width <= 0 ? {} : { width: Math.round(width) }),
      ...(height === undefined || height <= 0 ? {} : { height: Math.round(height) }),
    };
  }
  const image = args[0];
  if (!isRecord(image)) return {};
  const width = finiteNumber(image['width']);
  const height = finiteNumber(image['height']);
  return {
    ...(width === undefined || width <= 0 ? {} : { width: Math.round(width) }),
    ...(height === undefined || height <= 0 ? {} : { height: Math.round(height) }),
  };
};

const normalizePdfFailure = (error: unknown): Error => {
  if (error instanceof AppError) return error;
  if (isRecord(error) && error['name'] === 'PasswordException') {
    return badRequest('Password-protected PDFs are not supported');
  }
  return badRequest('The PDF is malformed or uses unsupported PDF features');
};

export const parsePdf = async (
  source: Buffer,
  limits: DocumentOptimizerLimits,
  signal: AbortSignal,
): Promise<ParsedDocument> => {
  throwIfAborted(signal);
  let loadingTask: ReturnType<typeof getDocument>;
  try {
    loadingTask = getDocument({
      data: new Uint8Array(source),
      verbosity: 0,
      stopAtErrors: false,
      useWorkerFetch: false,
      useWasm: false,
      disableFontFace: true,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      maxImageSize: 25_000_000,
      cMapUrl: pdfJsAssetDirectory('cmaps'),
      cMapPacked: true,
      standardFontDataUrl: pdfJsAssetDirectory('standard_fonts'),
    });
  } catch (error) {
    throw normalizePdfFailure(error);
  }

  let parsed: ParsedDocument | undefined;
  let primaryFailure: unknown;
  try {
    const document = await abortable(loadingTask.promise, signal);
    if (document.numPages > limits.maxPdfPages) {
      throw limitExceeded(`PDF exceeds the ${String(limits.maxPdfPages)} page limit`, {
        limit: 'maxPdfPages',
        maxPdfPages: limits.maxPdfPages,
      });
    }

    const warnings = new BoundedWarnings(maximumManifestWarnings - 1);
    const lines: PdfLine[] = [];
    const tables: ParsedTable[] = [];
    const figures: ParsedFigure[] = [];
    let textItemCount = 0;
    let extractedCharacters = 0;
    let language: string | null = null;

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      throwIfAborted(signal);
      const page = await abortable(document.getPage(pageNumber), signal);
      let items: readonly unknown[] = [];
      let pageLanguage: string | null = null;
      try {
        const textContent: unknown = await abortable(
          page.getTextContent({ includeMarkedContent: true }),
          signal,
        );
        items =
          isRecord(textContent) && isUnknownArray(textContent['items']) ? textContent['items'] : [];
        pageLanguage =
          isRecord(textContent) && typeof textContent['lang'] === 'string'
            ? textContent['lang']
            : null;
      } catch (error) {
        if (error instanceof AppError) throw error;
        warnings.add(`Text on PDF page ${String(pageNumber)} could not be read and was skipped.`);
      }
      language ??= pageLanguage;
      textItemCount += items.length;
      if (textItemCount > maximumTextItems) {
        throw limitExceeded(`PDF exceeds the ${String(maximumTextItems)} text-item limit`, {
          limit: 'pdfTextItems',
          maxTextItems: maximumTextItems,
        });
      }
      const pageLines = extractLines(items, pageNumber, lines.length);
      lines.push(...pageLines);
      extractedCharacters += pageLines.reduce((total, line) => total + line.text.length, 0);
      if (extractedCharacters > limits.maxExtractedCharacters) {
        throw limitExceeded(
          `Extracted PDF text exceeds the ${String(limits.maxExtractedCharacters)} character limit`,
          {
            limit: 'maxExtractedCharacters',
            maxExtractedCharacters: limits.maxExtractedCharacters,
          },
        );
      }

      try {
        const structure: unknown = await abortable(page.getStructTree(), signal);
        const root = asStructChild(structure);
        if (root && isStructNode(root)) {
          const tableNodes: StructNode[] = [];
          collectTables(root, tableNodes);
          const content = markedContentText(items);
          for (const tableNode of tableNodes) {
            if (tables.length >= maximumTables) {
              throw limitExceeded(`PDF exceeds the ${String(maximumTables)} table limit`, {
                limit: 'pdfTables',
                maxTables: maximumTables,
              });
            }
            const table = tableFromStructure(tableNode, content, pageNumber, tables.length);
            if (table) tables.push(table);
          }
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        warnings.add(
          `Tagged table structure on PDF page ${String(pageNumber)} could not be read and was skipped.`,
        );
      }

      try {
        const operatorList: unknown = await abortable(page.getOperatorList(), signal);
        const functions: readonly unknown[] =
          isRecord(operatorList) && isUnknownArray(operatorList['fnArray'])
            ? operatorList['fnArray']
            : [];
        const argumentsList: readonly unknown[] =
          isRecord(operatorList) && isUnknownArray(operatorList['argsArray'])
            ? operatorList['argsArray']
            : [];
        if (functions.length > maximumOperators) {
          throw limitExceeded(
            `PDF page ${String(pageNumber)} exceeds the ${String(maximumOperators)} operator limit`,
            { limit: 'pdfOperators', maxOperators: maximumOperators },
          );
        }
        for (let index = 0; index < functions.length; index += 1) {
          const operator = functions[index];
          if (operator !== OPS.paintImageXObject && operator !== OPS.paintInlineImageXObject) {
            continue;
          }
          if (figures.length >= maximumFigures) {
            throw limitExceeded(`PDF exceeds the ${String(maximumFigures)} figure limit`, {
              limit: 'pdfFigures',
              maxFigures: maximumFigures,
            });
          }
          figures.push({
            ...imageDimensions(operator, argumentsList[index]),
            semanticDescriptionStatus: 'not-generated',
            asset: {
              available: false,
              reason:
                'PDF image occurrence was inventoried, but this structural parser does not export rendered image bytes.',
            },
            page: pageNumber,
            locator: `pdf:page=${String(pageNumber)};operator=${String(index)}`,
          });
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        warnings.add(
          `Figure operators on PDF page ${String(pageNumber)} could not be read and were skipped.`,
        );
      }
      page.cleanup();
    }

    let bookmarks: readonly PdfBookmark[] = [];
    try {
      bookmarks = await extractBookmarks(document, signal);
    } catch (error) {
      if (error instanceof AppError) throw error;
      warnings.add('The PDF outline could not be read; font-size heading clues were used instead.');
    }
    const levels = headingLevels(lines, bookmarks);
    const blocks: ParsedBlock[] = lines.map((line, index) => {
      const headingLevel = levels.get(line.order);
      return {
        kind: headingLevel === undefined ? 'paragraph' : 'heading',
        text: line.text,
        ...(headingLevel === undefined ? {} : { headingLevel }),
        figureIndexes: [],
        page: line.page,
        blockIndex: index,
        locator: `pdf:page=${String(line.page)};text-line=${String(index + 1)}`,
      };
    });

    let metadata: DocumentMetadata = {};
    try {
      metadata = extractMetadata(await abortable(document.getMetadata(), signal), language);
    } catch (error) {
      if (error instanceof AppError) throw error;
      warnings.add('PDF metadata could not be read.');
      metadata =
        language === null || language.length === 0 ? {} : { language: boundedValue(language, 100) };
    }

    parsed = {
      format: 'pdf',
      pageCount: document.numPages,
      pageCountKind: 'parsed',
      metadata,
      blocks,
      tables,
      figures,
      extractionMethods: [
        'pdfjs-text-and-page-structure',
        ...(tables.length === 0 ? [] : ['pdf-tagged-table-structure']),
        ...(figures.length === 0 ? [] : ['pdf-image-operator-inventory']),
      ],
      warnings: warnings.list(),
    };
  } catch (error) {
    primaryFailure = error;
  }

  try {
    await loadingTask.destroy();
  } catch (cleanupError) {
    throw internalError(
      'PDF parser cleanup failed',
      new AggregateError(
        primaryFailure === undefined ? [cleanupError] : [primaryFailure, cleanupError],
      ),
    );
  }

  if (primaryFailure !== undefined) throw normalizePdfFailure(primaryFailure);
  if (parsed === undefined) throw internalError('PDF parser produced no result');
  return parsed;
};
