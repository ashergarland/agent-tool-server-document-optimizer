import { spawn, spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env['npm_execpath'];

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const runNode = (args, options = {}) => {
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    env: { ...process.env, npm_config_update_notifier: 'false' },
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${process.execPath} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
};

const runNpm = (args, options = {}) => {
  assert(npmCli, 'package:smoke must be invoked through npm');
  return runNode([npmCli, ...args], options);
};

class McpClient {
  constructor(entrypoint, cwd, env = {}) {
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.nonProtocolOutput = [];
    this.stderr = '';
    this.child = spawn(process.execPath, [entrypoint], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.consume(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    this.exit = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  dispatch(line) {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      this.nonProtocolOutput.push(line);
      return;
    }
    if (typeof response.id !== 'number') return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}\n${this.stderr}`));
      }, 30_000);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize() {
    const response = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'capability-package-smoke', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return response;
  }

  async shutdown() {
    this.child.stdin.end();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Packed stdio entrypoint did not exit')), 15_000);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.exit, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  terminate() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL');
    }
  }
}

const main = async () => {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
  const packageName = manifest.name;
  const bins = Object.entries(manifest.bin ?? {});
  assert(typeof packageName === 'string' && packageName.length > 0, 'Package name is missing');
  assert(bins.length === 1, 'Package smoke expects exactly one public executable');
  const [binName, binTarget] = bins[0];

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'capability-package-smoke-'));
  let client;
  try {
    const outside = relative(repositoryRoot, temporaryRoot);
    assert(
      outside.startsWith('..') || isAbsolute(outside),
      'The package consumer must be outside the source checkout',
    );

    runNpm(['run', 'build']);
    const packDirectory = join(temporaryRoot, 'pack');
    await mkdir(packDirectory);
    const packed = JSON.parse(
      runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory]),
    );
    assert(Array.isArray(packed) && packed.length === 1, 'npm pack returned no single candidate');
    const candidate = packed[0];
    assert(candidate.name === packageName, `npm pack selected ${String(candidate.name)}`);

    const packedFiles = candidate.files.map((file) => file.path);
    for (const required of [
      'LICENSE',
      'README.md',
      'dist/public.d.ts',
      'dist/public.js',
      binTarget,
      'package.json',
    ]) {
      assert(packedFiles.includes(required), `Packed package is missing ${required}`);
    }
    for (const forbidden of ['src/', 'tests/', 'scripts/', '.github/', 'coverage/']) {
      assert(
        !packedFiles.some((path) => path.startsWith(forbidden)),
        `Packed package contains ${forbidden}`,
      );
    }

    const tarball = join(packDirectory, candidate.filename);
    const consumer = join(temporaryRoot, 'consumer');
    await mkdir(consumer);
    await writeFile(
      join(consumer, 'package.json'),
      `${JSON.stringify(
        { name: 'capability-package-smoke-consumer', private: true, type: 'module' },
        null,
        2,
      )}\n`,
    );
    const smokePdf = await PDFDocument.create();
    smokePdf.setTitle('Packed capability smoke document');
    smokePdf.setCreationDate(new Date('2026-09-17T00:00:00.000Z'));
    smokePdf.setModificationDate(new Date('2026-09-17T00:00:00.000Z'));
    const font = await smokePdf.embedFont(StandardFonts.Helvetica);
    const page = smokePdf.addPage([400, 400]);
    page.drawText('Package Smoke', { x: 40, y: 340, size: 20, font });
    page.drawText('The packed Document Optimizer parsed this PDF outside its source tree.', {
      x: 40,
      y: 300,
      size: 10,
      font,
    });
    await writeFile(join(consumer, 'smoke.pdf'), await smokePdf.save({ useObjectStreams: false }));
    runNpm(
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball],
      { cwd: consumer },
    );

    const installed = join(consumer, 'node_modules', ...packageName.split('/'));
    const installedManifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    assert(installedManifest.name === packageName, 'External consumer installed the wrong package');
    assert(
      installedManifest.version === candidate.version,
      'Installed version differs from the packed candidate',
    );
    assert(installedManifest.bin?.[binName] === binTarget, 'Installed bin target changed');

    await writeFile(
      join(consumer, 'consumer.mjs'),
      `import { capability, capabilityManifest, documentPackageSchemaVersion } from ${JSON.stringify(
        packageName,
      )};\n` +
        `if (capability.manifest !== capabilityManifest) throw new Error('exports do not compose');\n` +
        `if (documentPackageSchemaVersion !== '1.0') throw new Error('model export failed');\n` +
        `if (capability.tools.length !== 6) throw new Error('tool catalogue export failed');\n`,
    );
    runNode(['consumer.mjs'], { cwd: consumer });

    const installedEntry = join(installed, binTarget);
    await access(installedEntry, fsConstants.R_OK);
    const installedBin = join(
      consumer,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? `${binName}.cmd` : binName,
    );
    await access(installedBin, fsConstants.R_OK);
    if (process.platform !== 'win32') {
      assert(((await stat(installedBin)).mode & 0o111) !== 0, 'Installed bin is not executable');
    }

    client = new McpClient(installedEntry, consumer, {
      DOCUMENT_OPTIMIZER_ROOT: consumer,
    });
    const initialized = await client.initialize();
    assert(initialized.result?.serverInfo, 'Packed entrypoint returned no MCP server identity');
    assert(
      initialized.result.serverInfo.version === candidate.version,
      `Packed entrypoint reported ${String(
        initialized.result.serverInfo.version,
      )}, expected ${candidate.version}`,
    );

    const listed = await client.request('tools/list');
    const names = (listed.result?.tools ?? []).map((tool) => tool.name);
    assert(
      JSON.stringify(names) ===
        JSON.stringify([
          'optimize_document',
          'inspect_document',
          'get_document_outline',
          'get_document_section',
          'get_document_table',
          'get_document_figure',
        ]),
      `Packed entrypoint exposed unexpected tools: ${names.join(', ')}`,
    );

    const invocation = await client.request('tools/call', {
      name: 'optimize_document',
      arguments: { sourcePath: 'smoke.pdf' },
    });
    assert(
      invocation.result?.isError !== true,
      `optimize_document failed from the packed entrypoint: ${JSON.stringify(invocation.result)}`,
    );
    const result = invocation.result?.structuredContent;
    const documentId = result?.manifest?.documentId;
    assert(
      typeof documentId === 'string' &&
        result.manifest.source?.format === 'pdf' &&
        result.manifest.metrics?.pageCount === 1,
      'optimize_document returned the wrong manifest',
    );

    const inspection = await client.request('tools/call', {
      name: 'inspect_document',
      arguments: { documentId },
    });
    assert(
      inspection.result?.structuredContent?.summary?.text?.includes(
        'Packed capability smoke document',
      ),
      'inspect_document returned no packed-source summary',
    );
    const outline = await client.request('tools/call', {
      name: 'get_document_outline',
      arguments: { documentId },
    });
    const sectionId = outline.result?.structuredContent?.entries?.[0]?.sectionId;
    assert(typeof sectionId === 'string', 'get_document_outline returned no section');
    const section = await client.request('tools/call', {
      name: 'get_document_section',
      arguments: { documentId, sectionId },
    });
    assert(
      section.result?.structuredContent?.content?.includes(
        'packed Document Optimizer parsed this PDF',
      ),
      'get_document_section returned no extracted PDF text',
    );

    const exit = await client.shutdown();
    assert(exit.code === 0, `Packed entrypoint exited with code ${String(exit.code)}`);
    assert(client.nonProtocolOutput.length === 0, 'Packed entrypoint wrote non-protocol stdout');
    assert(client.stderr === '', `Packed entrypoint wrote to stderr:\n${client.stderr}`);

    process.stdout.write(
      `Package smoke passed for ${packageName}@${candidate.version}: ` +
        `${packedFiles.length} files, installed and invoked outside the repository.\n`,
    );
  } finally {
    client?.terminate();
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
  }
};

await main();
