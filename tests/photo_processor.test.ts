import { describe, expect, it, vi } from 'vitest';
import {
  calculateTargetDimensions,
  generateThumbnailFromBlob,
  PhotoProcessingError,
  processPhotoFile,
  processPhotoFilesSerial,
  validatePhotoInputFile,
} from '../src/lib/photoProcessor';
import { MAX_PHOTO_INPUT_BYTES } from '../src/types/visit';

function createFakeDecoder(width: number, height: number, onRelease?: () => void) {
  return async () => ({
    width,
    height,
    drawTo: vi.fn(),
    release: () => {
      onRelease?.();
    },
  });
}

describe('photoProcessor', () => {
  it('calculates proportional target dimensions without upscaling smaller images', () => {
    expect(calculateTargetDimensions(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(calculateTargetDimensions(2000, 4000, 1600)).toEqual({ width: 800, height: 1600 });
    expect(calculateTargetDimensions(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(calculateTargetDimensions(1600, 1200, 320)).toEqual({ width: 320, height: 240 });
  });

  it('rejects SVG files (MIME, extension, and inline <svg> markup), oversized files, and non-images', async () => {
    await expect(validatePhotoInputFile(new Blob([], { type: 'image/jpeg' }), 'empty.jpg')).rejects.toMatchObject({
      name: 'PhotoProcessingError',
      code: 'unsupported-type',
    });

    const hugeBlob = new Blob(['x'], { type: 'image/jpeg' });
    Object.defineProperty(hugeBlob, 'size', { value: MAX_PHOTO_INPUT_BYTES + 1 });
    await expect(validatePhotoInputFile(hugeBlob, 'huge.jpg')).rejects.toMatchObject({
      code: 'file-too-large',
    });

    await expect(
      validatePhotoInputFile(new Blob(['<svg></svg>'], { type: 'image/svg+xml' }), 'icon.svg')
    ).rejects.toMatchObject({ code: 'svg-rejected' });

    await expect(
      validatePhotoInputFile(new Blob(['plain'], { type: '' }), 'vector.SVG')
    ).rejects.toMatchObject({ code: 'svg-rejected' });

    await expect(
      validatePhotoInputFile(
        new Blob(['<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'], {
          type: 'image/png',
        }),
        'disguised.png'
      )
    ).rejects.toMatchObject({ code: 'svg-rejected' });

    await expect(
      validatePhotoInputFile(new Blob(['hello'], { type: 'text/plain' }), 'notes.txt')
    ).rejects.toMatchObject({ code: 'unsupported-type' });
  });

  it('compresses to WebP, computes SHA-256, and releases decoder & canvases', async () => {
    const createdCanvases: HTMLCanvasElement[] = [];
    const origCreateElement = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      const el = origCreateElement(tagName);
      if (tagName.toLowerCase() === 'canvas') {
        createdCanvases.push(el as HTMLCanvasElement);
      }
      return el;
    }) as typeof document.createElement);

    const releaseSpy = vi.fn();
    try {
      const res = await processPhotoFile(new Blob(['raw-image-data'], { type: 'image/jpeg' }), {
        fileName: 'IMG_001.JPG',
        decodeImage: createFakeDecoder(3200, 2400, releaseSpy),
        encodeCanvas: async (_canvas, mime) => new Blob([`encoded-${mime}`], { type: mime }),
      });

      expect(res.attachment.mimeType).toBe('image/webp');
      expect(res.attachment.fileName).toBe(`${res.attachment.id}.webp`);
      expect(res.attachment.width).toBe(1600);
      expect(res.attachment.height).toBe(1200);
      expect(res.attachment.bytes).toBeGreaterThan(0);
      expect(res.fullBlob.type).toBe('image/webp');
      expect(res.thumbnailBlob.type).toBe('image/webp');
      if (res.attachment.checksumSha256 !== undefined) {
        expect(res.attachment.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(createdCanvases.length).toBe(2);
      for (const c of createdCanvases) {
        expect(c.width).toBe(0);
        expect(c.height).toBe(0);
      }
    } finally {
      createSpy.mockRestore();
    }
  });

  it('falls back to JPEG when canvas.toBlob("image/webp") returns PNG (iOS Safari behavior)', async () => {
    const encodeCalls: string[] = [];
    const res = await processPhotoFile(new Blob(['iphone-photo'], { type: 'image/jpeg' }), {
      decodeImage: createFakeDecoder(2400, 1800),
      encodeCanvas: async (_canvas, mime) => {
        encodeCalls.push(mime);
        if (mime === 'image/webp') {
          return new Blob(['png-fallback-by-safari'], { type: 'image/png' });
        }
        return new Blob(['jpeg-encoded'], { type: 'image/jpeg' });
      },
    });

    expect(encodeCalls).toEqual(['image/webp', 'image/jpeg', 'image/jpeg']);
    expect(res.attachment.mimeType).toBe('image/jpeg');
    expect(res.attachment.fileName.endsWith('.jpg')).toBe(true);
    expect(res.fullBlob.type).toBe('image/jpeg');
    expect(res.thumbnailBlob.type).toBe('image/jpeg');
  });

  it('releases decoder and zeroes canvases even when encoding fails', async () => {
    const createdCanvases: HTMLCanvasElement[] = [];
    const origCreateElement = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      const el = origCreateElement(tagName);
      if (tagName.toLowerCase() === 'canvas') {
        createdCanvases.push(el as HTMLCanvasElement);
      }
      return el;
    }) as typeof document.createElement);
    const releaseSpy = vi.fn();

    try {
      await expect(
        processPhotoFile(new Blob(['img'], { type: 'image/jpeg' }), {
          decodeImage: createFakeDecoder(1000, 1000, releaseSpy),
          encodeCanvas: async () => null,
        })
      ).rejects.toBeInstanceOf(PhotoProcessingError);

      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(createdCanvases.length).toBeGreaterThan(0);
      for (const c of createdCanvases) {
        expect(c.width).toBe(0);
        expect(c.height).toBe(0);
      }
    } finally {
      createSpy.mockRestore();
    }
  });

  it('processes multiple files strictly serially and continues past individual invalid files', async () => {
    let active = 0;
    let maxActive = 0;
    const progressCalls: Array<[number, number]> = [];

    const results = await processPhotoFilesSerial(
      [
        new Blob(['p1'], { type: 'image/jpeg' }),
        new Blob(['<svg/>'], { type: 'image/svg+xml' }),
        new Blob(['p3'], { type: 'image/png' }),
      ],
      {
        decodeImage: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
          return { width: 1200, height: 800, drawTo: vi.fn(), release: vi.fn() };
        },
        encodeCanvas: async (_c, mime) => new Blob(['ok'], { type: mime }),
        onProgress: (done, total) => progressCalls.push([done, total]),
      }
    );

    expect(maxActive).toBe(1);
    expect(progressCalls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(results[0].ok).toBe(true);
    expect(results[1]).toMatchObject({ ok: false, code: 'svg-rejected' });
    expect(results[2].ok).toBe(true);
  });

  it('regenerates thumbnails from downloaded blobs', async () => {
    const thumb = await generateThumbnailFromBlob(new Blob(['full'], { type: 'image/jpeg' }), 'image/jpeg', {
      decodeImage: createFakeDecoder(1600, 1200),
      encodeCanvas: async (canvas, mime) => {
        expect(canvas.width).toBe(320);
        expect(canvas.height).toBe(240);
        return new Blob(['thumb-jpeg'], { type: mime });
      },
    });
    expect(thumb.type).toBe('image/jpeg');
  });
});
