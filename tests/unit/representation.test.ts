import { describe, expect, it } from 'vitest';
import { maximumManifestWarnings } from '../../src/domain/model.js';
import type { ParsedDocument } from '../../src/domain/parser-types.js';
import { buildRepresentation } from '../../src/domain/representation.js';

describe('agent-native representation', () => {
  it('bounds warning overflow within the manifest schema', () => {
    const parsed: ParsedDocument = {
      format: 'docx',
      pageCount: null,
      pageCountKind: 'unavailable',
      metadata: {},
      blocks: [],
      tables: [],
      figures: [],
      extractionMethods: ['docx-ooxml-text-and-heading-structure'],
      warnings: Array.from({ length: 40 }, (_, index) => `Parser warning ${String(index + 1)}`),
    };

    const built = buildRepresentation({
      documentId: `doc_${'0'.repeat(32)}`,
      optimizerVersion: '0.0.0-development',
      source: {
        relativePath: 'warning-overflow.docx',
        sha256: '0'.repeat(64),
        bytes: 1,
      },
      parsed,
    });

    expect(built.package.manifest.processing.warnings).toHaveLength(maximumManifestWarnings);
    expect(built.package.manifest.processing.warnings.at(-1)).toBe(
      'Additional warnings were suppressed',
    );
  });
});
