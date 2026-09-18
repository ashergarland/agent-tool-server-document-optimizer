import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestApplication,
  fixturesRoot,
  signal,
  type TestApplication,
} from '../helpers/application.js';

const applications: TestApplication[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (app) => app.shutdown()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { recursive: true, force: true, maxRetries: 3 })),
  );
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'document-optimizer-test-'));
  temporaryDirectories.push(root);
  return root;
};

const appForRoot = async (
  root: string | undefined,
  overrides: NodeJS.ProcessEnv = {},
): Promise<TestApplication> => {
  const app = await createTestApplication({
    DOCUMENT_OPTIMIZER_ROOT: root,
    ...overrides,
  });
  applications.push(app);
  return app;
};

describe('document input safety', () => {
  it('honors a caller cancellation before opening the source', async () => {
    const app = await createTestApplication();
    applications.push(app);
    const controller = new AbortController();
    controller.abort();

    await expect(
      app.services.optimizer.optimize('text.pdf', controller.signal),
    ).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('rejects unsupported formats and extension/content mismatches', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'notes.txt'), 'plain text');
    await writeFile(join(root, 'pretend.pdf'), 'not a PDF');
    const app = await appForRoot(root);

    await expect(app.services.optimizer.optimize('notes.txt', signal())).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(app.services.optimizer.optimize('pretend.pdf', signal())).rejects.toMatchObject({
      code: 'bad_request',
      message: 'The source bytes do not match the PDF file extension',
    });
  });

  it('rejects traversal, absolute paths, and a final symlink', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(join(outside, 'outside.pdf'), await readFile(join(fixturesRoot, 'text.pdf')));
    const app = await appForRoot(root);

    await expect(app.services.optimizer.optimize('../outside.pdf', signal())).rejects.toMatchObject(
      { code: 'forbidden' },
    );
    await expect(
      app.services.optimizer.optimize(join(outside, 'outside.pdf'), signal()),
    ).rejects.toMatchObject({ code: 'bad_request' });

    try {
      await symlink(join(outside, 'outside.pdf'), join(root, 'linked.pdf'));
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'EPERM' ||
        (error as NodeJS.ErrnoException).code === 'EACCES'
      ) {
        return;
      }
      throw error;
    }
    await expect(app.services.optimizer.optimize('linked.pdf', signal())).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('enforces source, XML-part, and process cache limits', async () => {
    const sourceLimited = await createTestApplication({
      DOCUMENT_OPTIMIZER_MAX_SOURCE_BYTES: '1024',
    });
    applications.push(sourceLimited);
    await expect(
      sourceLimited.services.optimizer.optimize('text.pdf', signal()),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });

    const xmlLimited = await createTestApplication({
      DOCUMENT_OPTIMIZER_MAX_XML_BYTES: '1024',
    });
    applications.push(xmlLimited);
    await expect(
      xmlLimited.services.optimizer.optimize('benchmark-release-evidence.docx', signal()),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });

    const cacheLimited = await createTestApplication({
      DOCUMENT_OPTIMIZER_MAX_CACHED_DOCUMENTS: '1',
    });
    applications.push(cacheLimited);
    await cacheLimited.services.optimizer.optimize('text.pdf', signal());
    await expect(
      cacheLimited.services.optimizer.optimize('image-only.pdf', signal()),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
  });

  it('rejects malformed DOCX and unsafe archive entry paths', async () => {
    const app = await createTestApplication();
    applications.push(app);
    await expect(app.services.optimizer.optimize('malformed.docx', signal())).rejects.toMatchObject(
      {
        code: 'bad_request',
        message: 'The DOCX ZIP container is malformed',
      },
    );
    await expect(
      app.services.optimizer.optimize('unsafe-entry.docx', signal()),
    ).rejects.toMatchObject({
      code: 'bad_request',
      message: 'DOCX archive contains an unsafe entry path',
    });
  });

  it('blocks decompression bombs, excessive nested archives, and XML entities', async () => {
    const app = await createTestApplication();
    applications.push(app);
    const compressionError: unknown = await app.services.optimizer
      .optimize('compression-bomb.docx', signal())
      .catch((error: unknown) => error);
    expect(compressionError).toMatchObject({ code: 'limit_exceeded' });
    expect(compressionError).toBeInstanceOf(Error);
    if (compressionError instanceof Error) {
      expect(compressionError.message).toMatch(/compression-ratio limit/iu);
    }

    const nestedError: unknown = await app.services.optimizer
      .optimize('nested-archives.docx', signal())
      .catch((error: unknown) => error);
    expect(nestedError).toMatchObject({ code: 'limit_exceeded' });
    expect(nestedError).toBeInstanceOf(Error);
    if (nestedError instanceof Error) {
      expect(nestedError.message).toMatch(/nested-archive inventory limit/iu);
    }

    const entityError: unknown = await app.services.optimizer
      .optimize('xml-entity.docx', signal())
      .catch((error: unknown) => error);
    expect(entityError).toMatchObject({ code: 'bad_request' });
    expect(entityError).toBeInstanceOf(Error);
    if (entityError instanceof Error) {
      expect(entityError.message).toMatch(/prohibited document type or entity/iu);
    }
  });

  it('omits oversized embedded media while preserving text and inventory', async () => {
    const app = await createTestApplication({
      DOCUMENT_OPTIMIZER_MAX_FIGURE_BYTES: '1024',
    });
    applications.push(app);
    const optimized = await app.services.optimizer.optimize('large-figure.docx', signal());
    expect(optimized.manifest.metrics.figureCount).toBe(1);
    expect(optimized.manifest.processing.warnings.join(' ')).toMatch(
      /exceeded the configured extracted-asset limit/iu,
    );
    expect(
      app.services.optimizer.figure(optimized.manifest.documentId, 'figure-001', true),
    ).toMatchObject({
      retrievalStatus: 'unavailable',
      figure: { asset: { available: false } },
    });
  });

  it('is deterministically not ready when no document root is configured', async () => {
    const app = await appForRoot(undefined);
    const readiness = await app.readiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'document_root', state: 'not_ready' }),
      ]),
    );
    await expect(app.services.optimizer.optimize('text.pdf', signal())).rejects.toMatchObject({
      code: 'not_ready',
    });
  });
});
