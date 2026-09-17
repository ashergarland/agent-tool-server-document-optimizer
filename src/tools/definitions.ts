import { defineTool, type AnyToolDefinition } from '@agent-tool-platform/runtime/tools';
import { z } from 'zod';
import { figureBytesCeiling, resultCharactersCeiling } from '../config.js';
import {
  documentIdSchema,
  documentManifestSchema,
  figureDescriptorSchema,
  outlineEntrySchema,
  sectionBlockSchema,
  sectionDescriptorSchema,
  sectionIdSchema,
  tableDescriptorSchema,
  tableIdSchema,
  figureIdSchema,
} from '../domain/model.js';
import type { CapabilityServices } from '../services.js';

const sourcePathSchema = z.string().min(1).max(4_096).meta({ maxLength: 4_096 });

const optimizeDocumentInputSchema = z.object({
  sourcePath: sourcePathSchema,
});

const optimizeDocumentOutputSchema = z.object({
  manifest: documentManifestSchema,
  cacheHit: z.boolean(),
});

export type OptimizeDocumentInput = z.infer<typeof optimizeDocumentInputSchema>;
export type OptimizeDocumentOutput = z.infer<typeof optimizeDocumentOutputSchema>;

export const optimizeDocumentTool = defineTool({
  name: 'optimize_document',
  title: 'Optimize document',
  summary: 'Parse one bounded local PDF or DOCX into a reusable agent-native package.',
  description:
    'Read a root-relative source document, validate and parse it once, and retain a deterministic process-lifetime representation in Platform-owned scratch storage.',
  kind: 'read',
  routing: {
    useWhen: [
      'a PDF or DOCX is too large or expensive to repeatedly inspect raw',
      'sections, tables, figures, or source provenance are useful',
      'progressive document access is preferable to loading the entire source',
    ],
    doNotUseWhen: [
      'the source is already tiny or exact binary/page-render fidelity is required; use a raw source tool',
      'the task is corpus-level retrieval; use Doc RAG',
      'the task requires interpreting visual meaning; use Vision after figure extraction',
    ],
    nextSteps: ['inspect_document', 'get_document_outline'],
    scope: 'one .pdf or .docx path relative to DOCUMENT_OPTIMIZER_ROOT',
    changesState: false,
  },
  inputSchema: optimizeDocumentInputSchema,
  outputSchema: optimizeDocumentOutputSchema,
  async handler(input, services: CapabilityServices, context) {
    return await services.optimizer.optimize(input.sourcePath, context.signal);
  },
});

const inspectDocumentInputSchema = z.object({
  documentId: documentIdSchema,
});

const inspectDocumentOutputSchema = documentManifestSchema;

export type InspectDocumentInput = z.infer<typeof inspectDocumentInputSchema>;
export type InspectDocumentOutput = z.infer<typeof inspectDocumentOutputSchema>;

export const inspectDocumentTool = defineTool({
  name: 'inspect_document',
  title: 'Inspect optimized document',
  summary: 'Return a compact manifest, extractive summary, counts, limits, and source identity.',
  description:
    'Orient an agent without returning the complete document. The summary is deterministic and extractive rather than model-generated.',
  kind: 'read',
  routing: {
    useWhen: [
      'you need the cheapest overview of an already optimized document',
      'you need format, page/section/table/figure counts, warnings, or fallback state',
      'you need the source hash and processing provenance',
    ],
    doNotUseWhen: [
      'the source has not been optimized in this process; call optimize_document first',
      'you need section content; use get_document_section after inspecting the outline',
    ],
    prerequisites: ['optimize_document'],
    nextSteps: ['get_document_outline', 'get_document_section'],
    scope: 'one process-lifetime optimized document ID',
    changesState: false,
  },
  inputSchema: inspectDocumentInputSchema,
  outputSchema: inspectDocumentOutputSchema,
  handler(input, services: CapabilityServices) {
    return Promise.resolve(services.optimizer.inspect(input.documentId));
  },
});

const getDocumentOutlineInputSchema = z.object({
  documentId: documentIdSchema,
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(25),
});

const getDocumentOutlineOutputSchema = z.object({
  documentId: documentIdSchema,
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
  total: z.number().int().nonnegative(),
  entries: z.array(outlineEntrySchema).max(100),
  truncated: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export type GetDocumentOutlineInput = z.infer<typeof getDocumentOutlineInputSchema>;
export type GetDocumentOutlineOutput = z.infer<typeof getDocumentOutlineOutputSchema>;

export const getDocumentOutlineTool = defineTool({
  name: 'get_document_outline',
  title: 'Get document outline',
  summary: 'Page through section hierarchy, compact section summaries, and asset references.',
  description:
    'Return bounded outline entries so an agent can select a section before requesting detailed text.',
  kind: 'read',
  routing: {
    useWhen: [
      'you need the document shape or heading hierarchy',
      'you need section IDs, page ranges, or table/figure IDs before retrieving detail',
    ],
    doNotUseWhen: [
      'you only need the document-level overview; use inspect_document',
      'you already know the exact section ID; use get_document_section',
    ],
    prerequisites: ['optimize_document'],
    nextSteps: ['get_document_section', 'get_document_table', 'get_document_figure'],
    scope: 'at most 100 outline entries per call',
    changesState: false,
  },
  inputSchema: getDocumentOutlineInputSchema,
  outputSchema: getDocumentOutlineOutputSchema,
  handler(input, services: CapabilityServices) {
    return Promise.resolve(services.optimizer.outline(input.documentId, input.offset, input.limit));
  },
});

const getDocumentSectionInputSchema = z.object({
  documentId: documentIdSchema,
  sectionId: sectionIdSchema,
  offset: z.number().int().nonnegative().default(0),
  maxCharacters: z.number().int().min(2).max(resultCharactersCeiling).default(16_000),
});

const getDocumentSectionOutputSchema = z.object({
  documentId: documentIdSchema,
  section: sectionDescriptorSchema,
  offset: z.number().int().nonnegative(),
  appliedMaxCharacters: z.number().int().positive().max(resultCharactersCeiling),
  limitClamped: z.boolean(),
  totalCharacters: z.number().int().nonnegative(),
  content: z.string().max(resultCharactersCeiling),
  truncated: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
  provenance: z.array(sectionBlockSchema).max(100),
  provenanceTruncated: z.boolean(),
});

export type GetDocumentSectionInput = z.infer<typeof getDocumentSectionInputSchema>;
export type GetDocumentSectionOutput = z.infer<typeof getDocumentSectionOutputSchema>;

export const getDocumentSectionTool = defineTool({
  name: 'get_document_section',
  title: 'Get document section',
  summary: 'Return a bounded slice of one section with block-level source provenance.',
  description:
    'Retrieve only the optimized Markdown needed for the current task. Large sections are paginated by character offset.',
  kind: 'read',
  routing: {
    useWhen: [
      'the outline identifies one relevant section or subsection',
      'you need semantic text with page, heading, paragraph, or archive-entry provenance',
    ],
    doNotUseWhen: [
      'you need only structure; use get_document_outline',
      'you need structured table cells; use get_document_table',
      'you need exact original binary or rendered-page fidelity; use a raw source tool',
    ],
    prerequisites: ['optimize_document', 'get_document_outline'],
    nextSteps: ['get_document_table', 'get_document_figure'],
    scope: `one section slice, capped by deployment configuration and ${String(
      resultCharactersCeiling,
    )} characters absolutely`,
    changesState: false,
  },
  inputSchema: getDocumentSectionInputSchema,
  outputSchema: getDocumentSectionOutputSchema,
  handler(input, services: CapabilityServices) {
    return Promise.resolve(
      services.optimizer.section(
        input.documentId,
        input.sectionId,
        input.offset,
        input.maxCharacters,
      ),
    );
  },
});

const tableFormatSchema = z.enum(['structured', 'markdown', 'csv']);
const getDocumentTableInputSchema = z.object({
  documentId: documentIdSchema,
  tableId: tableIdSchema,
  rowOffset: z.number().int().nonnegative().default(0),
  maxRows: z.number().int().min(1).max(100).default(25),
  format: tableFormatSchema.default('structured'),
});

const tableResultCommon = {
  documentId: documentIdSchema,
  table: tableDescriptorSchema,
  offset: z.number().int().nonnegative(),
  totalRows: z.number().int().nonnegative(),
  truncated: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
  resultLimitReached: z.boolean(),
};

const getDocumentTableOutputSchema = z.object({
  ...tableResultCommon,
  format: tableFormatSchema,
  headers: z.array(z.string()).optional(),
  rows: z.array(z.array(z.string())).max(100).optional(),
  content: z.string().max(resultCharactersCeiling).optional(),
});

export type GetDocumentTableInput = z.infer<typeof getDocumentTableInputSchema>;
export type GetDocumentTableOutput = z.infer<typeof getDocumentTableOutputSchema>;

export const getDocumentTableTool = defineTool({
  name: 'get_document_table',
  title: 'Get document table',
  summary: 'Return bounded rows from one structurally extracted table.',
  description:
    'Retrieve table cells as structured JSON-compatible arrays, Markdown, or CSV text with section and source provenance.',
  kind: 'read',
  routing: {
    useWhen: [
      'an outline or section references a table needed for analysis',
      'structured rows are cheaper or more reliable than flattened document text',
    ],
    doNotUseWhen: [
      'the source chart has no structural cell data; use get_document_figure and Vision if visual interpretation is needed',
      'you need tables across a corpus; use Doc RAG or a data capability after ingestion',
    ],
    prerequisites: ['optimize_document'],
    nextSteps: ['get_document_section'],
    scope: 'one table, at most 100 rows per call and bounded by the configured result limit',
    changesState: false,
  },
  inputSchema: getDocumentTableInputSchema,
  outputSchema: getDocumentTableOutputSchema,
  handler(input, services: CapabilityServices) {
    return Promise.resolve(
      services.optimizer.table(
        input.documentId,
        input.tableId,
        input.rowOffset,
        input.maxRows,
        input.format,
      ),
    );
  },
});

const maximumFigureBase64Characters = Math.ceil(figureBytesCeiling / 3) * 4 + 4;
const getDocumentFigureInputSchema = z.object({
  documentId: documentIdSchema,
  figureId: figureIdSchema,
  includeData: z.boolean().default(false),
});

const getDocumentFigureOutputSchema = z.object({
  documentId: documentIdSchema,
  figure: figureDescriptorSchema,
  retrievalStatus: z.enum(['metadata-only', 'included', 'unavailable']),
  dataEncoding: z.literal('base64').optional(),
  dataBase64: z.string().max(maximumFigureBase64Characters).optional(),
});

export type GetDocumentFigureInput = z.infer<typeof getDocumentFigureInputSchema>;
export type GetDocumentFigureOutput = z.infer<typeof getDocumentFigureOutputSchema>;

export const getDocumentFigureTool = defineTool({
  name: 'get_document_figure',
  title: 'Get document figure',
  summary: 'Return figure inventory metadata first and bounded embedded bytes only on request.',
  description:
    'Expose provenance, dimensions, media type, captions or source alt text, extraction status, and an optional base64 raster asset for a later Vision handoff.',
  kind: 'read',
  routing: {
    useWhen: [
      'an outline or section references a figure',
      'you need a caption, source alt text, dimensions, extraction state, or page provenance',
      'Vision needs extracted raster bytes for semantic interpretation',
    ],
    doNotUseWhen: [
      'section text or a source caption already answers the question; avoid requesting image bytes',
      'you expect semantic diagram interpretation from this capability; use Vision',
      'you need a rendered original PDF page; use a raw/source rendering tool',
    ],
    prerequisites: ['optimize_document'],
    scope: `one figure; data is opt-in and capped at ${String(figureBytesCeiling)} source bytes`,
    changesState: false,
  },
  inputSchema: getDocumentFigureInputSchema,
  outputSchema: getDocumentFigureOutputSchema,
  handler(input, services: CapabilityServices) {
    return Promise.resolve(
      services.optimizer.figure(input.documentId, input.figureId, input.includeData),
    );
  },
});

export const capabilityTools: readonly AnyToolDefinition<CapabilityServices>[] = [
  optimizeDocumentTool,
  inspectDocumentTool,
  getDocumentOutlineTool,
  getDocumentSectionTool,
  getDocumentTableTool,
  getDocumentFigureTool,
];
