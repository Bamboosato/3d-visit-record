import type { VisitDate } from '../types/visit';
import { isValidDatePart } from './visitDate';

const MAX_EXIF_SCAN_BYTES = 128 * 1024;

export type ExifDateSourceTag = 'DateTimeOriginal' | 'DateTimeDigitized' | 'DateTime';

export interface ExtractedExifDate {
  /** 撮影地の壁時計日付 ('YYYY-MM-DD') */
  localDate: string;
  /** ISO 8601 形式の日時文字列（オフセットタグがあれば付与） */
  takenAt: string;
  sourceTag: ExifDateSourceTag;
}

const TAG_DATE_TIME = 0x0132;
const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_DATE_TIME_DIGITIZED = 0x9004;
const TAG_OFFSET_TIME = 0x9010;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const TAG_OFFSET_TIME_DIGITIZED = 0x9012;
const TYPE_ASCII = 2;
const TYPE_LONG = 4;

interface RawExifDates {
  dateTimeOriginal?: string;
  dateTimeDigitized?: string;
  dateTime?: string;
  offsetOriginal?: string;
  offsetDigitized?: string;
  offsetTime?: string;
}

function createReader(bytes: Uint8Array, littleEndian: boolean) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    u16(offset: number): number {
      return view.getUint16(offset, littleEndian);
    },
    u32(offset: number): number {
      return view.getUint32(offset, littleEndian);
    },
  };
}

function readAsciiString(bytes: Uint8Array, start: number, maxLength: number): string {
  const end = Math.min(bytes.length, start + maxLength);
  let out = '';
  for (let i = start; i < end; i++) {
    const code = bytes[i];
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out.trim();
}

function readIfdAsciiValue(
  bytes: Uint8Array,
  entryOffset: number,
  tiffStart: number,
  tiffEnd: number,
  count: number,
  u32: (offset: number) => number
): string | undefined {
  if (count === 0 || count > 64) return undefined;
  if (count <= 4) {
    return readAsciiString(bytes, entryOffset + 8, count);
  }
  const relOffset = u32(entryOffset + 8);
  const absStart = tiffStart + relOffset;
  if (absStart < tiffStart || absStart + count > tiffEnd) return undefined;
  return readAsciiString(bytes, absStart, count);
}

function parseExifTimestamp(
  rawDate: string | undefined,
  rawOffset: string | undefined
): { localDate: string; takenAt: string } | null {
  if (!rawDate) return null;
  const m = /^(\d{4})[:/-](\d{2})[:/-](\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/.exec(rawDate.trim());
  if (!m) return null;
  const localDate = `${m[1]}-${m[2]}-${m[3]}`;
  if (!isValidDatePart('day', localDate)) return null;

  const hour = m[4] ?? '00';
  const minute = m[5] ?? '00';
  const second = m[6] ?? '00';
  const hNum = Number(hour);
  const mNum = Number(minute);
  const sNum = Number(second);
  if (hNum > 23 || mNum > 59 || sNum > 59) return null;

  const offsetClean = rawOffset?.trim();
  const validOffset =
    offsetClean && (/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(offsetClean) || offsetClean === 'Z')
      ? offsetClean
      : '';
  const takenAt = `${localDate}T${hour}:${minute}:${second}${validOffset}`;
  if (!Number.isFinite(Date.parse(takenAt))) return null;
  return { localDate, takenAt };
}

function parseIfdEntries(
  bytes: Uint8Array,
  tiffStart: number,
  tiffEnd: number,
  ifdRelOffset: number,
  littleEndian: boolean,
  onEntry: (tag: number, type: number, count: number, entryOffset: number) => void
): void {
  const { u16, u32 } = createReader(bytes, littleEndian);
  const ifdAbs = tiffStart + ifdRelOffset;
  if (ifdAbs < tiffStart || ifdAbs + 2 > tiffEnd) return;
  const count = u16(ifdAbs);
  const maxPossible = Math.floor((tiffEnd - (ifdAbs + 2)) / 12);
  const safeCount = Math.min(count, maxPossible, 256);
  for (let i = 0; i < safeCount; i++) {
    const entryOffset = ifdAbs + 2 + i * 12;
    const tag = u16(entryOffset);
    const type = u16(entryOffset + 2);
    const valCount = u32(entryOffset + 4);
    onEntry(tag, type, valCount, entryOffset);
  }
}

function parseTiffExifDates(
  bytes: Uint8Array,
  tiffStart: number,
  tiffEnd: number
): ExtractedExifDate | null {
  if (tiffStart < 0 || tiffEnd > bytes.length || tiffStart + 8 > tiffEnd) return null;

  let littleEndian: boolean;
  if (bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49) {
    littleEndian = true;
  } else if (bytes[tiffStart] === 0x4d && bytes[tiffStart + 1] === 0x4d) {
    littleEndian = false;
  } else {
    return null;
  }

  const { u16, u32 } = createReader(bytes, littleEndian);
  if (u16(tiffStart + 2) !== 0x002a) return null;

  const ifd0Offset = u32(tiffStart + 4);
  const collected: RawExifDates = {};
  let exifIfdOffset: number | null = null;

  // IFD0: 撮影日時（DateTime）と Exif IFD ポインタのみ走査（GPS IFD は意図的に読まない）
  parseIfdEntries(bytes, tiffStart, tiffEnd, ifd0Offset, littleEndian, (tag, type, count, entryOffset) => {
    if (tag === TAG_DATE_TIME && type === TYPE_ASCII) {
      collected.dateTime = readIfdAsciiValue(bytes, entryOffset, tiffStart, tiffEnd, count, u32);
    } else if (tag === TAG_EXIF_IFD_POINTER && (type === TYPE_LONG || count === 1)) {
      exifIfdOffset = u32(entryOffset + 8);
    }
  });

  if (exifIfdOffset !== null) {
    parseIfdEntries(bytes, tiffStart, tiffEnd, exifIfdOffset, littleEndian, (tag, type, count, entryOffset) => {
      if (type !== TYPE_ASCII) return;
      const val = readIfdAsciiValue(bytes, entryOffset, tiffStart, tiffEnd, count, u32);
      if (tag === TAG_DATE_TIME_ORIGINAL) collected.dateTimeOriginal = val;
      else if (tag === TAG_DATE_TIME_DIGITIZED) collected.dateTimeDigitized = val;
      else if (tag === TAG_OFFSET_TIME_ORIGINAL) collected.offsetOriginal = val;
      else if (tag === TAG_OFFSET_TIME_DIGITIZED) collected.offsetDigitized = val;
      else if (tag === TAG_OFFSET_TIME) collected.offsetTime = val;
    });
  }

  const candidates: Array<{
    tag: ExifDateSourceTag;
    rawDate?: string;
    rawOffset?: string;
  }> = [
    {
      tag: 'DateTimeOriginal',
      rawDate: collected.dateTimeOriginal,
      rawOffset: collected.offsetOriginal ?? collected.offsetTime,
    },
    {
      tag: 'DateTimeDigitized',
      rawDate: collected.dateTimeDigitized,
      rawOffset: collected.offsetDigitized ?? collected.offsetOriginal ?? collected.offsetTime,
    },
    {
      tag: 'DateTime',
      rawDate: collected.dateTime,
      rawOffset: collected.offsetTime ?? collected.offsetOriginal,
    },
  ];

  for (const c of candidates) {
    const parsed = parseExifTimestamp(c.rawDate, c.rawOffset);
    if (parsed) {
      return {
        localDate: parsed.localDate,
        takenAt: parsed.takenAt,
        sourceTag: c.tag,
      };
    }
  }
  return null;
}

function hasExifHeaderAt(bytes: Uint8Array, offset: number): boolean {
  return (
    offset + 6 <= bytes.length &&
    bytes[offset] === 0x45 && // E
    bytes[offset + 1] === 0x78 && // x
    bytes[offset + 2] === 0x69 && // i
    bytes[offset + 3] === 0x66 && // f
    bytes[offset + 4] === 0x00 &&
    bytes[offset + 5] === 0x00
  );
}

function parseJpegExifDates(bytes: Uint8Array): ExtractedExifDate | null {
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) break;

    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda || marker === 0x00) break;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (offset + 2 > bytes.length) break;

    const segLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segLength < 2) break;
    const payloadStart = offset + 2;
    const nextOffset = offset + segLength;

    if (marker === 0xe1 && hasExifHeaderAt(bytes, payloadStart)) {
      const tiffEnd = Math.min(bytes.length, nextOffset);
      const result = parseTiffExifDates(bytes, payloadStart + 6, tiffEnd);
      if (result) return result;
    }

    if (nextOffset > bytes.length) break;
    offset = nextOffset;
  }
  return null;
}

function parseWebpExifDates(bytes: Uint8Array): ExtractedExifDate | null {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourCc = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4);
    const chunkSize = view.getUint32(0, true);
    const payloadStart = offset + 8;
    const payloadEnd = Math.min(bytes.length, payloadStart + chunkSize);

    if (fourCc === 'EXIF') {
      const tiffStart = hasExifHeaderAt(bytes, payloadStart) ? payloadStart + 6 : payloadStart;
      const result = parseTiffExifDates(bytes, tiffStart, payloadEnd);
      if (result) return result;
    }

    const padded = chunkSize + (chunkSize & 1);
    const next = payloadStart + padded;
    if (next <= offset) break;
    offset = next;
  }
  return null;
}

export function extractExifDateFromBuffer(input: ArrayBuffer | Uint8Array): ExtractedExifDate | null {
  try {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < 12) return null;

    // JPEG: FF D8
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      return parseJpegExifDates(bytes);
    }

    // WebP: RIFF....WEBP
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return parseWebpExifDates(bytes);
    }

    return null;
  } catch {
    return null;
  }
}

export async function extractExifDateFromFile(file: Blob): Promise<ExtractedExifDate | null> {
  try {
    const slice = file.slice(0, MAX_EXIF_SCAN_BYTES);
    const buf = await slice.arrayBuffer();
    return extractExifDateFromBuffer(buf);
  } catch {
    return null;
  }
}

export function extractLocalDateFromTakenAt(takenAt?: string): string | undefined {
  if (!takenAt) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(takenAt.trim());
  if (!m) return undefined;
  return isValidDatePart('day', m[1]) ? m[1] : undefined;
}

export function buildSuggestedVisitDateFromPhotos(
  localDates: Array<string | undefined>
): VisitDate | null {
  const valid = [...new Set(localDates.filter((d): d is string => Boolean(d && isValidDatePart('day', d))))].sort();
  if (valid.length === 0) return null;
  const start = valid[0];
  const end = valid[valid.length - 1];
  return start === end ? { precision: 'day', start } : { precision: 'day', start, end };
}
