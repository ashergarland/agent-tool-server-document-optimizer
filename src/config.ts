import {
  ConfigurationError,
  defineCapabilityConfig,
  loadCapabilityConfig,
  type PlatformConfig,
} from '@agent-tool-platform/runtime/config';
import { z } from 'zod';
import { capabilityManifest } from './manifest.js';

const mebibyte = 1024 * 1024;

export const sourceBytesCeiling = 100 * mebibyte;
export const pdfPagesCeiling = 2_000;
export const archiveEntriesCeiling = 10_000;
export const archiveBytesCeiling = 512 * mebibyte;
export const xmlBytesCeiling = 32 * mebibyte;
export const figureBytesCeiling = 16 * mebibyte;
export const extractedCharactersCeiling = 10_000_000;
export const resultCharactersCeiling = 1_000_000;
export const cachedDocumentsCeiling = 128;
export const queueLimitCeiling = 128;

const boundedInteger = (minimum: number, maximum: number, fallback: number) =>
  z.coerce.number().int().min(minimum).max(maximum).default(fallback);

export const documentOptimizerEnvSchema = z.object({
  DOCUMENT_OPTIMIZER_ROOT: z.string().min(1).optional(),
  DOCUMENT_OPTIMIZER_MAX_SOURCE_BYTES: boundedInteger(1024, sourceBytesCeiling, 25 * mebibyte),
  DOCUMENT_OPTIMIZER_MAX_PDF_PAGES: boundedInteger(1, pdfPagesCeiling, 500),
  DOCUMENT_OPTIMIZER_MAX_ARCHIVE_ENTRIES: boundedInteger(8, archiveEntriesCeiling, 2_048),
  DOCUMENT_OPTIMIZER_MAX_ARCHIVE_BYTES: boundedInteger(
    mebibyte,
    archiveBytesCeiling,
    100 * mebibyte,
  ),
  DOCUMENT_OPTIMIZER_MAX_XML_BYTES: boundedInteger(1024, xmlBytesCeiling, 8 * mebibyte),
  DOCUMENT_OPTIMIZER_MAX_FIGURE_BYTES: boundedInteger(1024, figureBytesCeiling, 4 * mebibyte),
  DOCUMENT_OPTIMIZER_MAX_EXTRACTED_CHARACTERS: boundedInteger(
    1_000,
    extractedCharactersCeiling,
    2_000_000,
  ),
  DOCUMENT_OPTIMIZER_MAX_RESULT_CHARACTERS: boundedInteger(1_000, resultCharactersCeiling, 128_000),
  DOCUMENT_OPTIMIZER_PROCESSING_TIMEOUT_MS: boundedInteger(1_000, 300_000, 30_000),
  DOCUMENT_OPTIMIZER_MAX_CACHED_DOCUMENTS: boundedInteger(1, cachedDocumentsCeiling, 16),
  DOCUMENT_OPTIMIZER_QUEUE_LIMIT: boundedInteger(0, queueLimitCeiling, 8),
});

export type DocumentOptimizerEnv = z.infer<typeof documentOptimizerEnvSchema>;

export interface DocumentOptimizerLimits {
  readonly maxSourceBytes: number;
  readonly maxPdfPages: number;
  readonly maxArchiveEntries: number;
  readonly maxArchiveBytes: number;
  readonly maxXmlBytes: number;
  readonly maxFigureBytes: number;
  readonly maxExtractedCharacters: number;
  readonly maxResultCharacters: number;
  readonly processingTimeoutMs: number;
  readonly maxCachedDocuments: number;
  readonly queueLimit: number;
}

export interface DocumentOptimizerConfig extends PlatformConfig {
  readonly documents: {
    readonly root: string | undefined;
    readonly limits: DocumentOptimizerLimits;
  };
}

export const buildDocumentOptimizerConfig = (
  base: PlatformConfig,
  env: DocumentOptimizerEnv,
): DocumentOptimizerConfig => ({
  ...base,
  documents: {
    root: env.DOCUMENT_OPTIMIZER_ROOT,
    limits: {
      maxSourceBytes: env.DOCUMENT_OPTIMIZER_MAX_SOURCE_BYTES,
      maxPdfPages: env.DOCUMENT_OPTIMIZER_MAX_PDF_PAGES,
      maxArchiveEntries: env.DOCUMENT_OPTIMIZER_MAX_ARCHIVE_ENTRIES,
      maxArchiveBytes: env.DOCUMENT_OPTIMIZER_MAX_ARCHIVE_BYTES,
      maxXmlBytes: env.DOCUMENT_OPTIMIZER_MAX_XML_BYTES,
      maxFigureBytes: env.DOCUMENT_OPTIMIZER_MAX_FIGURE_BYTES,
      maxExtractedCharacters: env.DOCUMENT_OPTIMIZER_MAX_EXTRACTED_CHARACTERS,
      maxResultCharacters: env.DOCUMENT_OPTIMIZER_MAX_RESULT_CHARACTERS,
      processingTimeoutMs: env.DOCUMENT_OPTIMIZER_PROCESSING_TIMEOUT_MS,
      maxCachedDocuments: env.DOCUMENT_OPTIMIZER_MAX_CACHED_DOCUMENTS,
      queueLimit: env.DOCUMENT_OPTIMIZER_QUEUE_LIMIT,
    },
  },
});

export const documentOptimizerConfigSpec = defineCapabilityConfig<
  typeof documentOptimizerEnvSchema,
  DocumentOptimizerConfig
>({
  schema: documentOptimizerEnvSchema,
  build: ({ base, env }) => buildDocumentOptimizerConfig(base, env),
  validate: (config) => {
    if (config.documents.limits.maxFigureBytes > config.documents.limits.maxArchiveBytes) {
      throw new ConfigurationError(
        'DOCUMENT_OPTIMIZER_MAX_FIGURE_BYTES must not exceed DOCUMENT_OPTIMIZER_MAX_ARCHIVE_BYTES',
      );
    }
    if (config.documents.limits.maxXmlBytes > config.documents.limits.maxArchiveBytes) {
      throw new ConfigurationError(
        'DOCUMENT_OPTIMIZER_MAX_XML_BYTES must not exceed DOCUMENT_OPTIMIZER_MAX_ARCHIVE_BYTES',
      );
    }
  },
});

export const documentOptimizerConfigDefaults = {
  serviceName: capabilityManifest.name,
  serviceVersion: capabilityManifest.version,
};

export const loadDocumentOptimizerConfig = (
  source: NodeJS.ProcessEnv = process.env,
): DocumentOptimizerConfig =>
  loadCapabilityConfig({
    defaults: documentOptimizerConfigDefaults,
    spec: documentOptimizerConfigSpec,
    source,
  });
