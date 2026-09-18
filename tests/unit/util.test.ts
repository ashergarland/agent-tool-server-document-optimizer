import { describe, expect, it } from 'vitest';
import {
  abortable,
  boundedValue,
  createProcessingSignal,
  detectSafeRasterMediaType,
  extensionForMediaType,
  throwIfAborted,
} from '../../src/domain/util.js';

describe('document utility bounds', () => {
  it('recognizes only supported raster signatures and extensions', () => {
    expect(
      detectSafeRasterMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe('image/png');
    expect(detectSafeRasterMediaType(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(detectSafeRasterMediaType(Buffer.from('GIF87a', 'ascii'))).toBe('image/gif');
    expect(detectSafeRasterMediaType(Buffer.from('GIF89a', 'ascii'))).toBe('image/gif');
    expect(
      detectSafeRasterMediaType(
        Buffer.concat([
          Buffer.from('RIFF', 'ascii'),
          Buffer.alloc(4),
          Buffer.from('WEBP', 'ascii'),
        ]),
      ),
    ).toBe('image/webp');
    expect(detectSafeRasterMediaType(Buffer.from('not-an-image', 'ascii'))).toBeUndefined();

    expect(extensionForMediaType('image/png')).toBe('.png');
    expect(extensionForMediaType('image/jpeg')).toBe('.jpg');
    expect(extensionForMediaType('image/gif')).toBe('.gif');
    expect(extensionForMediaType('image/webp')).toBe('.webp');
    expect(extensionForMediaType('image/svg+xml')).toBeUndefined();
  });

  it('normalizes and truncates bounded metadata values', () => {
    expect(boundedValue('  compact   value  ', 20)).toBe('compact value');
    expect(boundedValue('1234567890', 8)).toBe('12345...');
  });

  it('normalizes asynchronous parser rejection and cancellation', async () => {
    const active = new AbortController();
    await expect(abortable(Promise.resolve('done'), active.signal)).resolves.toBe('done');
    // Exercise defensive normalization for parser libraries that reject with non-Error values.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const nonErrorFailure = Promise.reject('parser failure');
    await expect(abortable(nonErrorFailure, active.signal)).rejects.toThrow(
      'An asynchronous parser operation failed',
    );

    const during = new AbortController();
    const pending = abortable(new Promise<never>(() => undefined), during.signal);
    during.abort('caller-cancelled');
    await expect(pending).rejects.toMatchObject({
      code: 'timeout',
      message: 'Document processing was cancelled before completion',
    });

    expect(() => throwIfAborted(AbortSignal.abort('processing-timeout'))).toThrow(
      'Document processing exceeded the configured timeout',
    );
  });

  it('propagates caller cancellation into a processing signal', () => {
    const caller = new AbortController();
    const processing = createProcessingSignal(caller.signal, 10_000);
    caller.abort();
    expect(processing.signal.aborted).toBe(true);
    expect(processing.signal.reason).toBe('caller-cancelled');
    processing.dispose();
  });
});
