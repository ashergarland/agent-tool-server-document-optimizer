import { z } from 'zod';

export const documentPackageSchemaVersion = '1.0' as const;
export const optimizerPipelineVersion = '1' as const;
export const maximumManifestWarnings = 32;

export const sourceFormatSchema = z.enum(['pdf', 'docx']);
export type SourceFormat = z.infer<typeof sourceFormatSchema>;

export const processingStatusSchema = z.enum(['optimized', 'needs-ocr', 'no-extractable-text']);
export type ProcessingStatus = z.infer<typeof processingStatusSchema>;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const documentIdSchema = z.string().regex(/^doc_[a-f0-9]{32}$/u);
export const sectionIdSchema = z.string().regex(/^section-\d{3,6}(?:-[a-z0-9-]+)?$/u);
export const tableIdSchema = z.string().regex(/^table-\d{3,6}$/u);
export const figureIdSchema = z.string().regex(/^figure-\d{3,6}$/u);

export const provenanceSchema = z.object({
  sourceSha256: sha256Schema,
  sourcePath: z.string().min(1).max(4_096),
  locator: z.string().min(1).max(4_096),
  page: z.number().int().positive().optional(),
  pageEnd: z.number().int().positive().optional(),
  archiveEntry: z.string().min(1).max(4_096).optional(),
  blockIndex: z.number().int().nonnegative().optional(),
  headingPath: z.array(z.string().min(1).max(300)).max(16),
});
export type DocumentProvenance = z.infer<typeof provenanceSchema>;

export const documentMetadataSchema = z.object({
  title: z.string().min(1).max(1_000).optional(),
  author: z.string().min(1).max(1_000).optional(),
  subject: z.string().min(1).max(2_000).optional(),
  keywords: z.string().min(1).max(2_000).optional(),
  creator: z.string().min(1).max(1_000).optional(),
  producer: z.string().min(1).max(1_000).optional(),
  created: z.string().min(1).max(200).optional(),
  modified: z.string().min(1).max(200).optional(),
  language: z.string().min(1).max(100).optional(),
  reportedWordCount: z.number().int().nonnegative().optional(),
});
export type DocumentMetadata = z.infer<typeof documentMetadataSchema>;

export const documentSummarySchema = z.object({
  kind: z.literal('deterministic-extractive'),
  text: z.string().max(4_000),
  representativeText: z.string().max(2_000),
  majorHeadings: z.array(z.string().min(1).max(300)).max(12),
  limitations: z.array(z.string().min(1).max(500)).max(12),
});
export type DocumentSummary = z.infer<typeof documentSummarySchema>;

export const documentMetricsSchema = z.object({
  sourceBytes: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative().nullable(),
  pageCountKind: z.enum(['parsed', 'source-property', 'unavailable']),
  sectionCount: z.number().int().nonnegative(),
  tableCount: z.number().int().nonnegative(),
  figureCount: z.number().int().nonnegative(),
  extractedTextCharacters: z.number().int().nonnegative(),
  optimizedRepresentationBytes: z.number().int().nonnegative(),
});
export type DocumentMetrics = z.infer<typeof documentMetricsSchema>;

export const outlineEntrySchema = z.object({
  sectionId: sectionIdSchema,
  title: z.string().min(1).max(300),
  level: z.number().int().min(1).max(6),
  order: z.number().int().nonnegative(),
  parentSectionId: sectionIdSchema.optional(),
  pageStart: z.number().int().positive().optional(),
  pageEnd: z.number().int().positive().optional(),
  textCharacters: z.number().int().nonnegative(),
  tableIds: z.array(tableIdSchema),
  figureIds: z.array(figureIdSchema),
  summary: z.string().max(600),
});
export type OutlineEntry = z.infer<typeof outlineEntrySchema>;

export const sectionDescriptorSchema = outlineEntrySchema.omit({
  parentSectionId: true,
  summary: true,
});
export type SectionDescriptor = z.infer<typeof sectionDescriptorSchema>;

export const sectionBlockSchema = z.object({
  blockId: z.string().regex(/^block-\d{3,8}$/u),
  kind: z.enum(['heading', 'paragraph', 'list', 'table', 'figure']),
  startCharacter: z.number().int().nonnegative(),
  endCharacter: z.number().int().nonnegative(),
  tableId: tableIdSchema.optional(),
  figureIds: z.array(figureIdSchema),
  provenance: provenanceSchema,
});
export type SectionBlock = z.infer<typeof sectionBlockSchema>;

export const sectionRecordSchema = z.object({
  ...sectionDescriptorSchema.shape,
  markdown: z.string(),
  blocks: z.array(sectionBlockSchema),
});
export type SectionRecord = z.infer<typeof sectionRecordSchema>;

export const tableDescriptorSchema = z.object({
  tableId: tableIdSchema,
  order: z.number().int().nonnegative(),
  title: z.string().min(1).max(500).optional(),
  sectionId: sectionIdSchema,
  rowCount: z.number().int().nonnegative(),
  columnCount: z.number().int().nonnegative(),
  hasHeader: z.boolean(),
  extractionMethod: z.enum(['docx-ooxml', 'pdf-tagged-structure']),
  confidence: z.enum(['high', 'medium']),
  provenance: provenanceSchema,
});
export type TableDescriptor = z.infer<typeof tableDescriptorSchema>;

export const tableRecordSchema = z.object({
  ...tableDescriptorSchema.shape,
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
});
export type TableRecord = z.infer<typeof tableRecordSchema>;

export const figureAssetSchema = z.object({
  available: z.boolean(),
  reference: z.string().min(1).max(500).optional(),
  sha256: sha256Schema.optional(),
  bytes: z.number().int().nonnegative().optional(),
  reason: z.string().min(1).max(500).optional(),
});
export type FigureAsset = z.infer<typeof figureAssetSchema>;

export const figureDescriptorSchema = z.object({
  figureId: figureIdSchema,
  order: z.number().int().nonnegative(),
  sectionId: sectionIdSchema,
  mediaType: z.string().min(1).max(200).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  caption: z.string().min(1).max(1_000).optional(),
  semanticDescription: z.string().min(1).max(2_000).optional(),
  semanticDescriptionStatus: z.enum(['source-alt-text', 'source-caption', 'not-generated']),
  asset: figureAssetSchema,
  provenance: provenanceSchema,
});
export type FigureDescriptor = z.infer<typeof figureDescriptorSchema>;

export const documentManifestSchema = z.object({
  schemaVersion: z.literal(documentPackageSchemaVersion),
  documentId: documentIdSchema,
  source: z.object({
    name: z.string().min(1).max(1_000),
    relativePath: z.string().min(1).max(4_096),
    sha256: sha256Schema,
    bytes: z.number().int().nonnegative(),
    format: sourceFormatSchema,
  }),
  metadata: documentMetadataSchema,
  processing: z.object({
    pipelineVersion: z.literal(optimizerPipelineVersion),
    optimizerVersion: z.string().min(1).max(200),
    status: processingStatusSchema,
    extractionMethods: z.array(z.string().min(1).max(200)).max(20),
    warnings: z.array(z.string().min(1).max(500)).max(maximumManifestWarnings),
    sourceChangeDetection: z.literal('sha256'),
    cacheScope: z.literal('process-lifetime-scratch'),
  }),
  metrics: documentMetricsSchema,
  summary: documentSummarySchema,
  inventory: z.object({
    rootSectionIds: z.array(sectionIdSchema),
    sectionCount: z.number().int().nonnegative(),
    tableCount: z.number().int().nonnegative(),
    figureCount: z.number().int().nonnegative(),
  }),
  provenance: provenanceSchema,
});
export type DocumentManifest = z.infer<typeof documentManifestSchema>;

export const optimizedDocumentPackageSchema = z.object({
  manifest: documentManifestSchema,
  outline: z.array(outlineEntrySchema),
  sections: z.array(sectionRecordSchema),
  tables: z.array(tableRecordSchema),
  figures: z.array(figureDescriptorSchema),
  documentMarkdown: z.string(),
});
export type OptimizedDocumentPackage = z.infer<typeof optimizedDocumentPackageSchema>;

export interface StoredDocument {
  readonly package: OptimizedDocumentPackage;
  readonly assets: ReadonlyMap<string, Buffer>;
  readonly packagePath: string;
}
