import type { DocumentMetadata, FigureAsset, SourceFormat, TableDescriptor } from './model.js';

export interface ParsedBlock {
  readonly kind: 'heading' | 'paragraph' | 'list' | 'table';
  readonly text: string;
  readonly headingLevel?: number;
  readonly tableIndex?: number;
  readonly figureIndexes: readonly number[];
  readonly page?: number;
  readonly blockIndex: number;
  readonly archiveEntry?: string;
  readonly locator: string;
}

export interface ParsedTable {
  readonly title?: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly hasHeader: boolean;
  readonly extractionMethod: TableDescriptor['extractionMethod'];
  readonly confidence: TableDescriptor['confidence'];
  readonly page?: number;
  readonly blockIndex?: number;
  readonly archiveEntry?: string;
  readonly locator: string;
}

export interface ParsedFigure {
  readonly mediaType?: string;
  readonly width?: number;
  readonly height?: number;
  readonly caption?: string;
  readonly semanticDescription?: string;
  readonly semanticDescriptionStatus: 'source-alt-text' | 'source-caption' | 'not-generated';
  readonly asset: FigureAsset;
  readonly data?: Buffer;
  readonly page?: number;
  readonly blockIndex?: number;
  readonly archiveEntry?: string;
  readonly locator: string;
}

export interface ParsedDocument {
  readonly format: SourceFormat;
  readonly pageCount: number | null;
  readonly pageCountKind: 'parsed' | 'source-property' | 'unavailable';
  readonly metadata: DocumentMetadata;
  readonly blocks: readonly ParsedBlock[];
  readonly tables: readonly ParsedTable[];
  readonly figures: readonly ParsedFigure[];
  readonly extractionMethods: readonly string[];
  readonly warnings: readonly string[];
}
