import { afterEach, describe, expect, it } from 'vitest';
import { createTestApplication, signal, type TestApplication } from '../helpers/application.js';

const applications: TestApplication[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (app) => app.shutdown()));
});

describe('Hackathon Level 2 release-evidence proof', () => {
  it('preserves runtime, deployment, rollout, readiness, and provenance facts', async () => {
    const app = await createTestApplication();
    applications.push(app);
    const optimized = await app.services.optimizer.optimize(
      'benchmark-release-evidence.docx',
      signal(),
    );
    const outline = app.services.optimizer.outline(optimized.manifest.documentId, 0, 100);
    const sections = outline.entries.map((entry) =>
      app.services.optimizer.section(optimized.manifest.documentId, entry.sectionId, 0, 128_000),
    );
    const evidence = sections.map(({ content }) => content).join('\n');

    expect(evidence).toContain('checkout-api');
    expect(evidence).toContain('Pull request | 1842');
    expect(evidence).toContain('deployment template was not changed');
    expect(evidence).toContain(
      'Services that adopt RFC-27 consume PORT and do not consume the legacy APP_PORT name',
    );
    expect(evidence).toContain('Local default | 3000');
    expect(evidence).toContain('Deployed value | 8080');
    expect(evidence).toContain('Bind address | 0.0.0.0');
    expect(evidence).toContain('Standard health route | /healthz');
    expect(evidence).toContain('Container build | Passed');
    expect(evidence).toContain('Container push | Passed');
    expect(evidence).toContain('Source-map upload | Warning');
    expect(evidence).toContain('Ingress target | 8080 | Passed');
    expect(evidence).toContain('Readiness transport | TCP | Passed');
    expect(evidence).toContain('Readiness port | 8080 | Passed');
    expect(evidence).toContain('Revision resource was created');
    expect(evidence).toContain('Pipeline marked readiness failed');
    expect(evidence).toContain('No live provider or secret material is required');

    expect(optimized.manifest.metrics).toMatchObject({
      pageCount: 4,
      sectionCount: 8,
      tableCount: 5,
      figureCount: 0,
    });
    expect(optimized.manifest.processing.status).toBe('optimized');
    expect(optimized.manifest.summary.majorHeadings).toEqual(
      expect.arrayContaining(['Runtime contract RFC-27', 'Deployment policy', 'Rollout timeline']),
    );
    expect(
      sections.flatMap(({ provenance }) => provenance.map(({ provenance }) => provenance)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourcePath: 'benchmark-release-evidence.docx',
          archiveEntry: 'word/document.xml',
          headingPath: ['Checkout API 2.4.0 release evidence', 'Runtime contract RFC-27'],
        }),
      ]),
    );
  });
});
