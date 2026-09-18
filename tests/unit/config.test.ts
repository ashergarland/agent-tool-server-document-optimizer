import { describe, expect, it } from 'vitest';
import { generateTestApiKey } from '@agent-tool-platform/testkit';
import { loadDocumentOptimizerConfig } from '../../src/config.js';

const base = {
  NODE_ENV: 'test',
  AUTH_MODE: 'api-key',
  API_KEYS: generateTestApiKey(),
};

describe('Document Optimizer configuration', () => {
  it('loads bounded defaults without requiring a provider or secret', () => {
    const config = loadDocumentOptimizerConfig({
      ...base,
      DOCUMENT_OPTIMIZER_ROOT: 'documents',
    });
    expect(config.documents).toMatchObject({
      root: 'documents',
      limits: {
        maxSourceBytes: 25 * 1024 * 1024,
        maxPdfPages: 500,
        maxArchiveEntries: 2_048,
        maxArchiveBytes: 100 * 1024 * 1024,
        maxFigureBytes: 4 * 1024 * 1024,
        processingTimeoutMs: 30_000,
      },
    });
  });

  it('rejects values above absolute ceilings', () => {
    expect(() =>
      loadDocumentOptimizerConfig({
        ...base,
        DOCUMENT_OPTIMIZER_MAX_PDF_PAGES: '2001',
      }),
    ).toThrow(/DOCUMENT_OPTIMIZER_MAX_PDF_PAGES/iu);
  });

  it('rejects cross-field archive limit contradictions', () => {
    expect(() =>
      loadDocumentOptimizerConfig({
        ...base,
        DOCUMENT_OPTIMIZER_MAX_ARCHIVE_BYTES: String(1024 * 1024),
        DOCUMENT_OPTIMIZER_MAX_FIGURE_BYTES: String(2 * 1024 * 1024),
      }),
    ).toThrow(
      'DOCUMENT_OPTIMIZER_MAX_FIGURE_BYTES must not exceed DOCUMENT_OPTIMIZER_MAX_ARCHIVE_BYTES',
    );
  });
});
