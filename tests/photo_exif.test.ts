import { describe, expect, it } from 'vitest';
import {
  buildSuggestedVisitDateFromPhotos,
  extractExifDateFromBuffer,
  extractExifDateFromFile,
  extractLocalDateFromTakenAt,
} from '../src/lib/photoExif';

function writeAscii(buf: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    buf[offset + i] = text.charCodeAt(i);
  }
}

interface TiffBuildOptions {
  littleEndian: boolean;
  dateTime?: string;
  dateTimeOriginal?: string;
  dateTimeDigitized?: string;
  offsetOriginal?: string;
  includeGpsIfd?: boolean;
}

function buildTiffExifBytes(opts: TiffBuildOptions): Uint8Array {
  const le = opts.littleEndian;
  const buf = new Uint8Array(512);
  const view = new DataView(buf.buffer);

  // TIFF header
  if (le) {
    buf[0] = 0x49;
    buf[1] = 0x49;
  } else {
    buf[0] = 0x4d;
    buf[1] = 0x4d;
  }
  view.setUint16(2, 0x002a, le);
  view.setUint32(4, 8, le); // IFD0 starts at 8

  const ifd0Entries: Array<{ tag: number; type: number; count: number; valueOrPtr: number; str?: string }> = [];
  if (opts.dateTime) {
    ifd0Entries.push({ tag: 0x0132, type: 2, count: opts.dateTime.length + 1, valueOrPtr: 0, str: opts.dateTime });
  }
  if (opts.includeGpsIfd) {
    ifd0Entries.push({ tag: 0x8825, type: 4, count: 1, valueOrPtr: 400 });
  }

  const exifEntries: Array<{ tag: number; type: number; count: number; valueOrPtr: number; str?: string }> = [];
  if (opts.dateTimeOriginal) {
    exifEntries.push({
      tag: 0x9003,
      type: 2,
      count: opts.dateTimeOriginal.length + 1,
      valueOrPtr: 0,
      str: opts.dateTimeOriginal,
    });
  }
  if (opts.dateTimeDigitized) {
    exifEntries.push({
      tag: 0x9004,
      type: 2,
      count: opts.dateTimeDigitized.length + 1,
      valueOrPtr: 0,
      str: opts.dateTimeDigitized,
    });
  }
  if (opts.offsetOriginal) {
    exifEntries.push({
      tag: 0x9011,
      type: 2,
      count: opts.offsetOriginal.length + 1,
      valueOrPtr: 0,
      str: opts.offsetOriginal,
    });
  }

  const hasExifIfd = exifEntries.length > 0;
  const ifd0Count = ifd0Entries.length + (hasExifIfd ? 1 : 0);
  const ifd0Start = 8;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  let dataCursor = ifd0Start + ifd0Size;

  let exifIfdStart = 0;
  if (hasExifIfd) {
    exifIfdStart = dataCursor;
    dataCursor += 2 + exifEntries.length * 12 + 4;
    ifd0Entries.push({ tag: 0x8769, type: 4, count: 1, valueOrPtr: exifIfdStart });
  }

  // Write IFD0
  view.setUint16(ifd0Start, ifd0Entries.length, le);
  ifd0Entries.forEach((entry, idx) => {
    const pos = ifd0Start + 2 + idx * 12;
    view.setUint16(pos, entry.tag, le);
    view.setUint16(pos + 2, entry.type, le);
    view.setUint32(pos + 4, entry.count, le);
    if (entry.str !== undefined) {
      if (entry.count <= 4) {
        writeAscii(buf, pos + 8, entry.str);
      } else {
        view.setUint32(pos + 8, dataCursor, le);
        writeAscii(buf, dataCursor, entry.str);
        dataCursor += entry.count;
      }
    } else {
      view.setUint32(pos + 8, entry.valueOrPtr, le);
    }
  });

  if (hasExifIfd) {
    view.setUint16(exifIfdStart, exifEntries.length, le);
    exifEntries.forEach((entry, idx) => {
      const pos = exifIfdStart + 2 + idx * 12;
      view.setUint16(pos, entry.tag, le);
      view.setUint16(pos + 2, entry.type, le);
      view.setUint32(pos + 4, entry.count, le);
      if (entry.str !== undefined) {
        if (entry.count <= 4) {
          writeAscii(buf, pos + 8, entry.str);
        } else {
          view.setUint32(pos + 8, dataCursor, le);
          writeAscii(buf, dataCursor, entry.str);
          dataCursor += entry.count;
        }
      }
    });
  }

  return buf.slice(0, Math.max(dataCursor + 8, 256));
}

function wrapJpegApp1(tiffBytes: Uint8Array): Uint8Array {
  const segLen = 2 + 6 + tiffBytes.length;
  const out = new Uint8Array(2 + 2 + segLen + 2);
  out[0] = 0xff;
  out[1] = 0xd8; // SOI
  out[2] = 0xff;
  out[3] = 0xe1; // APP1
  out[4] = (segLen >> 8) & 0xff;
  out[5] = segLen & 0xff;
  writeAscii(out, 6, 'Exif');
  out[10] = 0;
  out[11] = 0;
  out.set(tiffBytes, 12);
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9; // EOI
  return out;
}

function wrapWebpExif(tiffBytes: Uint8Array, withExifPrefix = false): Uint8Array {
  const payloadLen = (withExifPrefix ? 6 : 0) + tiffBytes.length;
  const paddedLen = payloadLen + (payloadLen & 1);
  const riffSize = 4 + 8 + paddedLen;
  const out = new Uint8Array(8 + riffSize);
  const view = new DataView(out.buffer);
  writeAscii(out, 0, 'RIFF');
  view.setUint32(4, riffSize, true);
  writeAscii(out, 8, 'WEBP');
  writeAscii(out, 12, 'EXIF');
  view.setUint32(16, payloadLen, true);
  let pos = 20;
  if (withExifPrefix) {
    writeAscii(out, pos, 'Exif');
    out[pos + 4] = 0;
    out[pos + 5] = 0;
    pos += 6;
  }
  out.set(tiffBytes, pos);
  return out;
}

describe('photoExif', () => {
  it('extracts DateTimeOriginal with offset from little-endian JPEG and preserves wall-clock date', async () => {
    const tiff = buildTiffExifBytes({
      littleEndian: true,
      dateTime: '2025:10:01 12:00:00',
      dateTimeOriginal: '2025:10:12 01:15:00',
      offsetOriginal: '+09:00',
      includeGpsIfd: true,
    });
    const jpeg = wrapJpegApp1(tiff);

    const extracted = extractExifDateFromBuffer(jpeg);
    expect(extracted).toEqual({
      localDate: '2025-10-12',
      takenAt: '2025-10-12T01:15:00+09:00',
      sourceTag: 'DateTimeOriginal',
    });

    const fromBlob = await extractExifDateFromFile(new Blob([jpeg as unknown as BlobPart], { type: 'image/jpeg' }));
    expect(fromBlob?.localDate).toBe('2025-10-12');
    expect(extractLocalDateFromTakenAt(fromBlob?.takenAt)).toBe('2025-10-12');
  });

  it('supports big-endian TIFF and falls back to DateTimeDigitized or DateTime', () => {
    const tiffDigitized = buildTiffExifBytes({
      littleEndian: false,
      dateTime: '2024:05:01 09:00:00',
      dateTimeDigitized: '2024:05:03 14:20:30',
    });
    expect(extractExifDateFromBuffer(wrapJpegApp1(tiffDigitized))).toEqual({
      localDate: '2024-05-03',
      takenAt: '2024-05-03T14:20:30',
      sourceTag: 'DateTimeDigitized',
    });

    const tiffDateTimeOnly = buildTiffExifBytes({
      littleEndian: false,
      dateTime: '2023:08:15 07:05:00',
    });
    expect(extractExifDateFromBuffer(wrapJpegApp1(tiffDateTimeOnly))).toEqual({
      localDate: '2023-08-15',
      takenAt: '2023-08-15T07:05:00',
      sourceTag: 'DateTime',
    });
  });

  it('extracts EXIF dates from WebP EXIF chunks (with and without Exif prefix)', () => {
    const tiff = buildTiffExifBytes({
      littleEndian: true,
      dateTimeOriginal: '2026:03:21 16:40:10',
    });
    expect(extractExifDateFromBuffer(wrapWebpExif(tiff, false))?.localDate).toBe('2026-03-21');
    expect(extractExifDateFromBuffer(wrapWebpExif(tiff, true))?.localDate).toBe('2026-03-21');
  });

  it('safely returns null for invalid dates, PNGs without EXIF, and truncated/corrupt bytes', () => {
    const zeroDate = buildTiffExifBytes({
      littleEndian: true,
      dateTimeOriginal: '0000:00:00 00:00:00',
      dateTime: '2025:02:30 10:00:00',
    });
    expect(extractExifDateFromBuffer(wrapJpegApp1(zeroDate))).toBeNull();
    expect(extractExifDateFromBuffer(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBeNull();
    expect(extractExifDateFromBuffer(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]))).toBeNull();
    expect(extractLocalDateFromTakenAt('2025-02-30T00:00:00')).toBeUndefined();
  });

  it('builds single-day or From-To VisitDate suggestions from multiple photo local dates', () => {
    expect(buildSuggestedVisitDateFromPhotos([undefined, ''])).toBeNull();
    expect(buildSuggestedVisitDateFromPhotos(['2025-10-12', '2025-10-12', undefined])).toEqual({
      precision: 'day',
      start: '2025-10-12',
    });
    expect(buildSuggestedVisitDateFromPhotos(['2025-10-12', '2025-10-10', '2025-10-11'])).toEqual({
      precision: 'day',
      start: '2025-10-10',
      end: '2025-10-12',
    });
  });
});
