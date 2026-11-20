import {
  MAX_PHOTO_INPUT_BYTES,
  PHOTO_DISPLAY_MAX_EDGE,
  PHOTO_JPEG_FALLBACK_QUALITY,
  PHOTO_THUMB_QUALITY,
  PHOTO_THUMBNAIL_MAX_EDGE,
  PHOTO_WEBP_QUALITY,
  type PhotoAttachment,
  type PhotoMimeType,
} from '../types/visit';
import { diagnostic } from './diagnostics';
import { extractExifDateFromFile } from './photoExif';
import { createUuid } from './spotDomain';

const MAX_DECODABLE_DIMENSION = 25000;
const ALLOWED_RASTER_EXT_RE = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i;
const SVG_EXT_RE = /\.svgz?$/i;

export type PhotoProcessingErrorCode =
  | 'unsupported-type'
  | 'svg-rejected'
  | 'file-too-large'
  | 'decode-failed'
  | 'encode-failed';

export class PhotoProcessingError extends Error {
  code: PhotoProcessingErrorCode;
  constructor(code: PhotoProcessingErrorCode, message: string) {
    super(message);
    this.name = 'PhotoProcessingError';
    this.code = code;
  }
}

export interface DecodedImageSource {
  width: number;
  height: number;
  drawTo: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
  release: () => void;
}

export interface PhotoProcessOptions {
  fileName?: string;
  decodeImage?: (blob: Blob) => Promise<DecodedImageSource>;
  encodeCanvas?: (
    canvas: HTMLCanvasElement,
    mimeType: string,
    quality: number
  ) => Promise<Blob | null>;
}

export interface ProcessedPhotoResult {
  attachment: PhotoAttachment;
  fullBlob: Blob;
  thumbnailBlob: Blob;
  exifLocalDate?: string;
}

export type SerialPhotoResult =
  | { ok: true; result: ProcessedPhotoResult }
  | { ok: false; fileName: string; error: string; code: PhotoProcessingErrorCode };

export function calculateTargetDimensions(
  srcWidth: number,
  srcHeight: number,
  maxEdge: number
): { width: number; height: number } {
  if (
    !Number.isFinite(srcWidth) ||
    !Number.isFinite(srcHeight) ||
    srcWidth <= 0 ||
    srcHeight <= 0 ||
    !Number.isFinite(maxEdge) ||
    maxEdge <= 0
  ) {
    throw new PhotoProcessingError('decode-failed', '画像の縦横サイズを判定できませんでした。');
  }
  const longest = Math.max(srcWidth, srcHeight);
  const scale = Math.min(1, maxEdge / longest);
  return {
    width: Math.max(1, Math.round(srcWidth * scale)),
    height: Math.max(1, Math.round(srcHeight * scale)),
  };
}

function getFileName(file: Blob, overrideName?: string): string {
  if (overrideName) return overrideName;
  if (typeof File !== 'undefined' && file instanceof File && file.name) {
    return file.name;
  }
  return 'photo';
}

export async function validatePhotoInputFile(file: Blob, fileName?: string): Promise<void> {
  const name = getFileName(file, fileName);
  const mime = (file.type || '').toLowerCase().trim();

  if (file.size <= 0) {
    throw new PhotoProcessingError('unsupported-type', '空の画像ファイルは追加できません。');
  }
  if (file.size > MAX_PHOTO_INPUT_BYTES) {
    const limitMb = Math.round(MAX_PHOTO_INPUT_BYTES / (1024 * 1024));
    throw new PhotoProcessingError(
      'file-too-large',
      `ファイルサイズが上限（${limitMb}MB）を超えています。`
    );
  }

  if (mime.includes('svg') || SVG_EXT_RE.test(name)) {
    throw new PhotoProcessingError(
      'svg-rejected',
      'セキュリティ保護のため SVG 形式の画像は添付できません。JPEG / PNG / WebP 等をご利用ください。'
    );
  }

  // 先頭 512 バイトに SVG マークアップが含まれる場合も拒否する
  try {
    const headBuf = await file.slice(0, 512).arrayBuffer();
    const headText = new TextDecoder('utf-8', { fatal: false }).decode(headBuf).toLowerCase();
    if (headText.includes('<svg') || headText.includes('<!doctype svg')) {
      throw new PhotoProcessingError(
        'svg-rejected',
        'セキュリティ保護のため SVG 形式の画像は添付できません。JPEG / PNG / WebP 等をご利用ください。'
      );
    }
  } catch (err) {
    if (err instanceof PhotoProcessingError) throw err;
  }

  if (mime) {
    if (!mime.startsWith('image/')) {
      throw new PhotoProcessingError(
        'unsupported-type',
        '画像ファイル（JPEG / PNG / WebP 等）を選択してください。'
      );
    }
  } else if (name !== 'photo' && !ALLOWED_RASTER_EXT_RE.test(name)) {
    throw new PhotoProcessingError(
      'unsupported-type',
      '対応していないファイル形式です。JPEG / PNG / WebP 等を選択してください。'
    );
  }
}

export async function computeSha256Hex(blob: Blob): Promise<string | undefined> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle?.digest) return undefined;
    const buffer = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const bytes = new Uint8Array(hashBuffer);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  } catch {
    return undefined;
  }
}

async function decodeWithImageElement(blob: Blob): Promise<DecodedImageSource> {
  if (typeof Image === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    throw new PhotoProcessingError('decode-failed', 'この環境では画像をデコードできません。');
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () =>
        reject(new PhotoProcessingError('decode-failed', '画像を読み込めませんでした。'));
      el.src = objectUrl;
    });
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    return {
      width,
      height,
      drawTo: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
      release: () => {
        img.src = '';
      },
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function defaultDecodeImage(blob: Blob): Promise<DecodedImageSource> {
  if (typeof createImageBitmap === 'function') {
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      try {
        bitmap = await createImageBitmap(blob);
      } catch {
        bitmap = null;
      }
    }
    if (bitmap) {
      const bmp = bitmap;
      return {
        width: bmp.width,
        height: bmp.height,
        drawTo: (ctx, w, h) => ctx.drawImage(bmp, 0, 0, w, h),
        release: () => {
          try {
            bmp.close();
          } catch {
            // ignore
          }
        },
      };
    }
  }
  return decodeWithImageElement(blob);
}

function defaultEncodeCanvas(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number
): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      if (typeof canvas.toBlob !== 'function') {
        resolve(null);
        return;
      }
      canvas.toBlob((blob) => resolve(blob), mimeType, quality);
    } catch {
      resolve(null);
    }
  });
}

function createCanvasElement(width: number, height: number): HTMLCanvasElement {
  if (typeof document === 'undefined') {
    throw new PhotoProcessingError('encode-failed', 'ブラウザ環境でのみ画像を処理できます。');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function releaseCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // ignore
  }
}

async function encodeWithWebpOrJpegFallback(
  canvas: HTMLCanvasElement,
  encodeFn: (c: HTMLCanvasElement, mime: string, q: number) => Promise<Blob | null>,
  preferredMime?: PhotoMimeType,
  qualityOverride?: number
): Promise<{ blob: Blob; mimeType: PhotoMimeType }> {
  if (preferredMime === 'image/jpeg') {
    const jpegBlob = await encodeFn(
      canvas,
      'image/jpeg',
      qualityOverride ?? PHOTO_JPEG_FALLBACK_QUALITY
    );
    if (!jpegBlob || jpegBlob.size <= 0) {
      throw new PhotoProcessingError('encode-failed', 'JPEG 画像の生成に失敗しました。');
    }
    return { blob: jpegBlob, mimeType: 'image/jpeg' };
  }

  const webpBlob = await encodeFn(canvas, 'image/webp', qualityOverride ?? PHOTO_WEBP_QUALITY);
  if (webpBlob && webpBlob.size > 0 && webpBlob.type.toLowerCase() === 'image/webp') {
    return { blob: webpBlob, mimeType: 'image/webp' };
  }

  // Safari 等で canvas.toBlob('image/webp') が image/png へフォールバックした場合の JPEG 変換
  const jpegBlob = await encodeFn(
    canvas,
    'image/jpeg',
    qualityOverride ?? PHOTO_JPEG_FALLBACK_QUALITY
  );
  if (!jpegBlob || jpegBlob.size <= 0) {
    throw new PhotoProcessingError('encode-failed', '画像の圧縮保存に失敗しました。');
  }
  return { blob: jpegBlob, mimeType: 'image/jpeg' };
}

export async function processPhotoFile(
  file: Blob,
  options: PhotoProcessOptions = {}
): Promise<ProcessedPhotoResult> {
  const fileName = getFileName(file, options.fileName);
  await validatePhotoInputFile(file, fileName);

  // Canvas 変換前の元画像から撮影日時 EXIF のみを読み取る（GPS は読まない）
  const exif = await extractExifDateFromFile(file);

  const decodeFn = options.decodeImage ?? defaultDecodeImage;
  const encodeFn = options.encodeCanvas ?? defaultEncodeCanvas;

  let decoded: DecodedImageSource | null = null;
  let fullCanvas: HTMLCanvasElement | null = null;
  let thumbCanvas: HTMLCanvasElement | null = null;

  try {
    decoded = await decodeFn(file);
    if (
      !Number.isFinite(decoded.width) ||
      !Number.isFinite(decoded.height) ||
      decoded.width <= 0 ||
      decoded.height <= 0 ||
      decoded.width > MAX_DECODABLE_DIMENSION ||
      decoded.height > MAX_DECODABLE_DIMENSION
    ) {
      throw new PhotoProcessingError(
        'decode-failed',
        '画像の解像度が不正または大きすぎるため処理できません。'
      );
    }

    const fullSize = calculateTargetDimensions(decoded.width, decoded.height, PHOTO_DISPLAY_MAX_EDGE);
    fullCanvas = createCanvasElement(fullSize.width, fullSize.height);
    const fullCtx = fullCanvas.getContext('2d');
    if (!fullCtx) {
      throw new PhotoProcessingError('encode-failed', '画像の描画コンテキストを取得できませんでした。');
    }
    decoded.drawTo(fullCtx, fullSize.width, fullSize.height);

    // 本体を描画し終えたら元デコードリソースを早期解放してメモリ負荷を抑える
    decoded.release();
    decoded = null;

    const encodedFull = await encodeWithWebpOrJpegFallback(fullCanvas, encodeFn);

    const thumbSize = calculateTargetDimensions(
      fullSize.width,
      fullSize.height,
      PHOTO_THUMBNAIL_MAX_EDGE
    );
    thumbCanvas = createCanvasElement(thumbSize.width, thumbSize.height);
    const thumbCtx = thumbCanvas.getContext('2d');
    if (!thumbCtx) {
      throw new PhotoProcessingError('encode-failed', 'サムネイルの生成に失敗しました。');
    }
    thumbCtx.drawImage(fullCanvas, 0, 0, thumbSize.width, thumbSize.height);

    const encodedThumb = await encodeWithWebpOrJpegFallback(
      thumbCanvas,
      encodeFn,
      encodedFull.mimeType,
      PHOTO_THUMB_QUALITY
    );

    const checksumSha256 = await computeSha256Hex(encodedFull.blob);
    const id = createUuid();
    const ext = encodedFull.mimeType === 'image/webp' ? 'webp' : 'jpg';

    const attachment: PhotoAttachment = {
      id,
      fileName: `${id}.${ext}`,
      mimeType: encodedFull.mimeType,
      width: fullSize.width,
      height: fullSize.height,
      bytes: encodedFull.blob.size,
      takenAt: exif?.takenAt,
      checksumSha256,
    };

    return {
      attachment,
      fullBlob: encodedFull.blob,
      thumbnailBlob: encodedThumb.blob,
      exifLocalDate: exif?.localDate,
    };
  } catch (err) {
    if (err instanceof PhotoProcessingError) {
      diagnostic({
        operation: 'photo-write',
        backend: 'memory',
        outcome: 'failure',
        error: err.code === 'decode-failed' || err.code === 'encode-failed' ? 'decode' : 'invalid-data',
      });
      throw err;
    }
    diagnostic({
      operation: 'photo-write',
      backend: 'memory',
      outcome: 'failure',
      error: 'decode',
    });
    throw new PhotoProcessingError(
      'decode-failed',
      'この画像形式を読み込めませんでした。JPEG / PNG / WebP 形式でお試しください。'
    );
  } finally {
    decoded?.release();
    releaseCanvas(fullCanvas);
    releaseCanvas(thumbCanvas);
  }
}

export async function processPhotoFilesSerial(
  files: Blob[],
  options: PhotoProcessOptions & {
    onProgress?: (completed: number, total: number) => void;
  } = {}
): Promise<SerialPhotoResult[]> {
  const results: SerialPhotoResult[] = [];
  const total = files.length;

  for (let i = 0; i < total; i++) {
    const file = files[i];
    const name = getFileName(file, options.fileName);
    try {
      const processed = await processPhotoFile(file, { ...options, fileName: name });
      results.push({ ok: true, result: processed });
    } catch (err) {
      const pErr =
        err instanceof PhotoProcessingError
          ? err
          : new PhotoProcessingError('decode-failed', '画像の処理に失敗しました。');
      results.push({ ok: false, fileName: name, error: pErr.message, code: pErr.code });
    }
    options.onProgress?.(i + 1, total);
  }

  return results;
}

export async function generateThumbnailFromBlob(
  fullBlob: Blob,
  mimeType: PhotoMimeType,
  options: PhotoProcessOptions = {}
): Promise<Blob> {
  const decodeFn = options.decodeImage ?? defaultDecodeImage;
  const encodeFn = options.encodeCanvas ?? defaultEncodeCanvas;

  let decoded: DecodedImageSource | null = null;
  let thumbCanvas: HTMLCanvasElement | null = null;

  try {
    decoded = await decodeFn(fullBlob);
    const thumbSize = calculateTargetDimensions(
      decoded.width,
      decoded.height,
      PHOTO_THUMBNAIL_MAX_EDGE
    );
    thumbCanvas = createCanvasElement(thumbSize.width, thumbSize.height);
    const ctx = thumbCanvas.getContext('2d');
    if (!ctx) {
      throw new PhotoProcessingError('encode-failed', 'サムネイルの描画コンテキストを取得できませんでした。');
    }
    decoded.drawTo(ctx, thumbSize.width, thumbSize.height);
    const encoded = await encodeWithWebpOrJpegFallback(
      thumbCanvas,
      encodeFn,
      mimeType,
      PHOTO_THUMB_QUALITY
    );
    return encoded.blob;
  } finally {
    decoded?.release();
    releaseCanvas(thumbCanvas);
  }
}
