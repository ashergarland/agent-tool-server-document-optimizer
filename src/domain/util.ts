import { createHash } from 'node:crypto';
import { timedOut } from '@agent-tool-platform/runtime/errors';

export const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

export const normalizeWhitespace = (value: string): string => value.replace(/\s+/gu, ' ').trim();

export const boundedValue = (value: string, maximum: number): string => {
  const normalized = normalizeWhitespace(value);
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 3)}...`;
};

export const extensionForMediaType = (mediaType: string): string | undefined => {
  switch (mediaType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    default:
      return undefined;
  }
};

export const detectSafeRasterMediaType = (data: Uint8Array): string | undefined => {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  const prefix = Buffer.from(data.subarray(0, 6)).toString('ascii');
  if (prefix === 'GIF87a' || prefix === 'GIF89a') return 'image/gif';
  if (
    data.length >= 12 &&
    Buffer.from(data.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(data.subarray(8, 12)).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
};

const abortError = (signal: AbortSignal): Error =>
  timedOut(
    signal.reason === 'processing-timeout'
      ? 'Document processing exceeded the configured timeout'
      : 'Document processing was cancelled before completion',
  );

export const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortError(signal);
};

export const abortable = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(
          error instanceof Error
            ? error
            : new Error('An asynchronous parser operation failed', { cause: error }),
        );
      },
    );
  });
};

export const createProcessingSignal = (
  callerSignal: AbortSignal,
  timeoutMs: number,
): { readonly signal: AbortSignal; dispose(): void } => {
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort('caller-cancelled');
  if (callerSignal.aborted) {
    controller.abort('caller-cancelled');
  } else {
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort('processing-timeout'), timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    dispose(): void {
      clearTimeout(timer);
      callerSignal.removeEventListener('abort', onCallerAbort);
    },
  };
};

export const slugify = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60);

export const markdownTable = (
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string => {
  const escape = (value: string): string =>
    value.replace(/\\/gu, '\\\\').replace(/\|/gu, '\\|').replace(/\r?\n/gu, '<br>');
  const columns = Math.max(headers.length, ...rows.map((row) => row.length), 1);
  const normalizedHeaders = Array.from({ length: columns }, (_, index) =>
    escape(headers[index] ?? `Column ${String(index + 1)}`),
  );
  const lines = [
    `| ${normalizedHeaders.join(' | ')} |`,
    `| ${normalizedHeaders.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows) {
    lines.push(
      `| ${Array.from({ length: columns }, (_, index) => escape(row[index] ?? '')).join(' | ')} |`,
    );
  }
  return lines.join('\n');
};

export const csvTable = (
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string => {
  const quote = (value: string): string => `"${value.replace(/"/gu, '""')}"`;
  return [headers, ...rows].map((row) => row.map(quote).join(',')).join('\r\n');
};
