import {
  MAX_BACKUP_FILE_BYTES,
  MAX_ENTRIES_PER_SPOT,
  MAX_MEMO_LENGTH,
  MAX_PHOTOS_PER_ENTRY,
  MAX_SPOT_NAME_LENGTH,
  MAX_SPOTS,
  type PhotoAttachment,
  type SpotCategory,
  type SpotStatus,
  type VisitBackupEnvelope,
  type VisitDate,
  type VisitEntry,
  type VisitSpot,
} from '../types/visit';
import { getSpotCategoryMeta, isSpotCategory } from './spotCategories';
import {
  cloneSpots,
  collectReferencedPhotoIds,
  createUuid,
  deriveSpotStatus,
  hasControlCharacters,
  isSameCoordinate,
  isValidPhotoAttachment,
  sanitizeAddressSummary,
  sanitizeMemo,
  sanitizePhotoCaption,
  sanitizeSpotName,
} from './spotDomain';
import { getVisitDateRange, normalizeVisitDate } from './visitDate';

export const BACKUP_APP_ID = '3d-visit-record';
export const BACKUP_KIND = 'visit-records';
export const BACKUP_SCHEMA_VERSION = 1;
export const PHOTO_SYNC_VERSION = 2 as const;

export type ImportMode = 'merge' | 'replace';
export type DetectedBackupFormat = 'visit-record' | 'rain-viewer';

export class VisitTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisitTransferError';
  }
}

export interface MergePreview {
  next: VisitSpot[];
  added: number;
  updated: number;
  entriesAdded: number;
  unchanged: number;
  removed: number;
  truncatedSpots: number;
  truncatedEntries: number;
  photosAdded: number;
  photosRemoved: number;
}

function toTimestamp(iso?: string): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function sanitizeIso(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

function sanitizeEntry(raw: unknown, fallbackIso: string): VisitEntry {
  if (!raw || typeof raw !== 'object') {
    throw new VisitTransferError('記録ログの形式が不正です。');
  }
  const e = raw as Record<string, unknown>;
  const id = typeof e.id === 'string' && /^[\w.-]{1,80}$/.test(e.id) ? e.id : createUuid();
  const kind: SpotStatus = e.kind === 'visited' ? 'visited' : e.kind === 'planned' ? 'planned' : (() => {
    throw new VisitTransferError('記録ログの種別（visited/planned）が不正です。');
  })();

  const dateRes = normalizeVisitDate((e.date ?? { precision: 'none' }) as VisitDate);
  if (!dateRes.ok) {
    throw new VisitTransferError(`記録ログの日付が不正です: ${dateRes.error}`);
  }

  const rawMemo = typeof e.memo === 'string' ? e.memo : '';
  if (rawMemo.length > MAX_MEMO_LENGTH || hasControlCharacters(rawMemo, true)) {
    throw new VisitTransferError(`メモは${MAX_MEMO_LENGTH}文字以内で制御文字を含められません。`);
  }
  const memo = sanitizeMemo(rawMemo);

  const photos: PhotoAttachment[] = [];
  if (e.photos !== undefined) {
    if (!Array.isArray(e.photos)) {
      throw new VisitTransferError('写真メタデータの形式が不正です。');
    }
    const seenPhotoIds = new Set<string>();
    for (const p of e.photos.slice(0, MAX_PHOTOS_PER_ENTRY)) {
      if (!isValidPhotoAttachment(p)) {
        throw new VisitTransferError('写真メタデータに不正な項目が含まれています。');
      }
      if (seenPhotoIds.has(p.id)) continue;
      seenPhotoIds.add(p.id);
      const caption = sanitizePhotoCaption(p.caption);
      const cleanPhoto: PhotoAttachment = { ...p };
      if (caption !== undefined) {
        cleanPhoto.caption = caption;
      } else {
        delete cleanPhoto.caption;
      }
      photos.push(cleanPhoto);
    }
  }

  const createdAt = sanitizeIso(e.createdAt, fallbackIso);
  const updatedAt = sanitizeIso(e.updatedAt, createdAt);

  return {
    id,
    kind,
    date: dateRes.value,
    memo,
    photos,
    createdAt,
    updatedAt,
  };
}

function sanitizeVisitSpot(raw: unknown): VisitSpot {
  if (!raw || typeof raw !== 'object') {
    throw new VisitTransferError('地点データの形式が不正です。');
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.name !== 'string') {
    throw new VisitTransferError('地点名が不足しています。');
  }
  if (s.name.length > MAX_SPOT_NAME_LENGTH || hasControlCharacters(s.name, false)) {
    throw new VisitTransferError(
      `地点名が${MAX_SPOT_NAME_LENGTH}文字を超えているか制御文字を含みます。`
    );
  }
  const name = sanitizeSpotName(s.name);
  if (!name) throw new VisitTransferError('空の地点名は取り込めません。');

  if (!Array.isArray(s.center) || s.center.length !== 2) {
    throw new VisitTransferError('地点の座標が不正です。');
  }
  const [lng, lat] = s.center;
  if (
    typeof lng !== 'number' ||
    typeof lat !== 'number' ||
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    lng < -180 ||
    lng > 180 ||
    lat < -90 ||
    lat > 90
  ) {
    throw new VisitTransferError('地点の経緯度が有効範囲外です。');
  }

  if (!s.camera || typeof s.camera !== 'object') {
    throw new VisitTransferError('地点のカメラ視点情報が不足しています。');
  }
  const cam = s.camera as Record<string, unknown>;
  if (
    typeof cam.zoom !== 'number' ||
    !Number.isFinite(cam.zoom) ||
    typeof cam.pitch !== 'number' ||
    !Number.isFinite(cam.pitch) ||
    typeof cam.bearing !== 'number' ||
    !Number.isFinite(cam.bearing)
  ) {
    throw new VisitTransferError('カメラ視点パラメータが不正です。');
  }

  const id = typeof s.id === 'string' && /^[\w.-]{1,80}$/.test(s.id) ? s.id : createUuid();
  const now = new Date().toISOString();
  const createdAt = sanitizeIso(s.createdAt, now);
  const updatedAt = sanitizeIso(s.updatedAt, createdAt);
  const category: SpotCategory = isSpotCategory(s.category) ? s.category : 'other';
  const elevation =
    s.elevation === null || s.elevation === undefined
      ? null
      : typeof s.elevation === 'number' && Number.isFinite(s.elevation)
        ? Math.round(clamp(s.elevation, -500, 9000))
        : null;

  const addressSummary =
    typeof s.addressSummary === 'string'
      ? (() => {
          if (hasControlCharacters(s.addressSummary, false)) {
            throw new VisitTransferError('住所補助文字列に制御文字が含まれています。');
          }
          return sanitizeAddressSummary(s.addressSummary);
        })()
      : undefined;

  const presetId =
    typeof s.presetId === 'string' && s.presetId.length > 0 && s.presetId.length <= 64
      ? s.presetId
      : undefined;

  if (!Array.isArray(s.entries)) {
    throw new VisitTransferError('訪問・予定ログ配列が不足しています。');
  }
  const entries = s.entries
    .slice(0, MAX_ENTRIES_PER_SPOT)
    .map((entry) => sanitizeEntry(entry, createdAt));

  const rawStatus: SpotStatus = s.status === 'visited' ? 'visited' : 'planned';
  const status = deriveSpotStatus(entries, rawStatus);

  return {
    id,
    name,
    status,
    category,
    center: [lng, lat],
    elevation,
    camera: {
      zoom: Number(clamp(cam.zoom, 1.5, 18).toFixed(2)),
      pitch: Math.round(clamp(cam.pitch, 0, 85)),
      bearing: Math.round(clamp(cam.bearing, -180, 180)),
    },
    addressSummary,
    presetId,
    isPinned: typeof s.isPinned === 'boolean' ? s.isPinned : false,
    entries,
    createdAt,
    updatedAt,
  };
}

function convertRainViewerFavorite(raw: unknown, defaultStatus: SpotStatus): VisitSpot {
  if (!raw || typeof raw !== 'object') {
    throw new VisitTransferError('3d_rain_viewer のお気に入りデータ形式が不正です。');
  }
  const f = raw as Record<string, unknown>;
  if (typeof f.name !== 'string' || !f.name.trim()) {
    throw new VisitTransferError('お気に入り地点名が不正です。');
  }
  if (f.name.length > MAX_SPOT_NAME_LENGTH || hasControlCharacters(f.name, false)) {
    throw new VisitTransferError('地点名が長すぎるか制御文字を含みます。');
  }
  if (!Array.isArray(f.center) || f.center.length !== 2) {
    throw new VisitTransferError('座標データが不正です。');
  }
  const [lng, lat] = f.center;
  if (
    typeof lng !== 'number' ||
    typeof lat !== 'number' ||
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    Math.abs(lng) > 180 ||
    Math.abs(lat) > 90
  ) {
    throw new VisitTransferError('経緯度が有効範囲外です。');
  }
  const zoom = typeof f.zoom === 'number' && Number.isFinite(f.zoom) ? clamp(f.zoom, 1.5, 18) : 10.5;
  const pitch = typeof f.pitch === 'number' && Number.isFinite(f.pitch) ? clamp(f.pitch, 0, 85) : 55;
  const bearing =
    typeof f.bearing === 'number' && Number.isFinite(f.bearing) ? clamp(f.bearing, -180, 180) : 0;

  const now = new Date().toISOString();
  const createdAt = sanitizeIso(f.createdAt, now);
  const updatedAt = sanitizeIso(f.updatedAt, createdAt);
  const category = getSpotCategoryMeta(f.category).id;
  const id = typeof f.id === 'string' && /^[\w.-]{1,80}$/.test(f.id) ? f.id : createUuid();

  return {
    id,
    name: sanitizeSpotName(f.name),
    status: defaultStatus,
    category,
    center: [lng, lat],
    elevation:
      typeof f.elevation === 'number' && Number.isFinite(f.elevation)
        ? Math.round(clamp(f.elevation, -500, 9000))
        : null,
    camera: {
      zoom: Number(zoom.toFixed(2)),
      pitch: Math.round(pitch),
      bearing: Math.round(bearing),
    },
    isPinned: typeof f.isPinned === 'boolean' ? f.isPinned : false,
    entries: [
      {
        id: `${id}-imported`,
        kind: defaultStatus,
        date: { precision: 'none' },
        memo: '',
        photos: [],
        createdAt,
        updatedAt,
      },
    ],
    createdAt,
    updatedAt,
  };
}

export function detectBackupFormat(text: string): DetectedBackupFormat {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VisitTransferError('JSON ファイルとして読み込めませんでした。');
  }

  if (Array.isArray(parsed)) {
    return 'rain-viewer';
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (obj.app === BACKUP_APP_ID) return 'visit-record';
    if (obj.app === '3d-rain-viewer') return 'rain-viewer';
    if (Array.isArray(obj.items) && obj.items.length > 0) {
      const first = obj.items[0] as Record<string, unknown>;
      if (first && typeof first === 'object' && Array.isArray(first.entries)) {
        return 'visit-record';
      }
      return 'rain-viewer';
    }
  }
  throw new VisitTransferError('対応するバックアップデータが見つかりませんでした。');
}

export function parseBackupJson(
  text: string,
  options?: { rainViewerImportStatus?: SpotStatus }
): {
  format: DetectedBackupFormat;
  items: VisitSpot[];
  revision?: number;
  photoSyncVersion?: number;
} {
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > MAX_BACKUP_FILE_BYTES) {
    throw new VisitTransferError('ファイルサイズが大きすぎます（上限 16MB）。');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VisitTransferError('JSON ファイルとして読み込めませんでした。');
  }

  const rainStatus = options?.rainViewerImportStatus ?? 'planned';

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) throw new VisitTransferError('取り込める地点データが見つかりませんでした。');
    if (parsed.length > MAX_SPOTS * 2) {
      throw new VisitTransferError(`件数が多すぎます（上限 ${MAX_SPOTS} 件）。`);
    }
    return {
      format: 'rain-viewer',
      items: parsed.map((item) => convertRainViewerFavorite(item, rainStatus)),
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new VisitTransferError('バックアップファイルの形式が正しくありません。');
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.app === '3d-rain-viewer') {
    if (!Array.isArray(obj.items) || obj.items.length === 0) {
      throw new VisitTransferError('3d_rain_viewer のお気に入り地点が見つかりませんでした。');
    }
    return {
      format: 'rain-viewer',
      items: obj.items.map((item) => convertRainViewerFavorite(item, rainStatus)),
    };
  }

  if (obj.app !== undefined && obj.app !== BACKUP_APP_ID) {
    throw new VisitTransferError('3D Visit Record のバックアップファイルではありません。');
  }
  if (obj.kind !== undefined && obj.kind !== BACKUP_KIND) {
    throw new VisitTransferError('訪問記録データのバックアップファイルではありません。');
  }
  if (typeof obj.schemaVersion === 'number' && obj.schemaVersion > BACKUP_SCHEMA_VERSION) {
    throw new VisitTransferError(
      '新しいバージョンのアプリで作成されたデータです。アプリを更新してから読み込んでください。'
    );
  }
  if (!Array.isArray(obj.items)) {
    throw new VisitTransferError('バックアップデータに地点一覧（items）が含まれていません。');
  }
  if (obj.items.length > MAX_SPOTS * 2) {
    throw new VisitTransferError(`データ件数が多すぎます（上限 ${MAX_SPOTS} 件）。`);
  }

  const items = obj.items.map(sanitizeVisitSpot);
  const revision =
    typeof obj.revision === 'number' && Number.isSafeInteger(obj.revision) ? obj.revision : undefined;
  const photoSyncVersion =
    typeof obj.photoSyncVersion === 'number' &&
    Number.isSafeInteger(obj.photoSyncVersion) &&
    obj.photoSyncVersion > 0
      ? obj.photoSyncVersion
      : undefined;

  return { format: 'visit-record', items, revision, photoSyncVersion };
}

function sortEntriesDescending(entries: VisitEntry[]): VisitEntry[] {
  return [...entries].sort((a, b) => {
    const ra = getVisitDateRange(a.date)?.start ?? '';
    const rb = getVisitDateRange(b.date)?.start ?? '';
    if (ra !== rb) return rb.localeCompare(ra);
    return toTimestamp(b.updatedAt) - toTimestamp(a.updatedAt);
  });
}

function mergeEntries(
  existingEntries: VisitEntry[],
  incomingEntries: VisitEntry[],
  respectEmptyIncomingPhotos = false
): { entries: VisitEntry[]; addedCount: number; updatedCount: number; truncatedCount: number } {
  const byId = new Map<string, VisitEntry>();
  for (const e of existingEntries) {
    byId.set(e.id, { ...e, date: { ...e.date }, photos: e.photos.map((p) => ({ ...p })) });
  }

  let addedCount = 0;
  let updatedCount = 0;

  for (const inc of incomingEntries) {
    const prev = byId.get(inc.id);
    if (!prev) {
      byId.set(inc.id, { ...inc, date: { ...inc.date }, photos: inc.photos.map((p) => ({ ...p })) });
      addedCount++;
    } else if (toTimestamp(inc.updatedAt) > toTimestamp(prev.updatedAt)) {
      byId.set(inc.id, {
        ...inc,
        date: { ...inc.date },
        photos: respectEmptyIncomingPhotos
          ? inc.photos.map((p) => ({ ...p }))
          : inc.photos.length > 0
            ? inc.photos.map((p) => ({ ...p }))
            : prev.photos,
        createdAt: prev.createdAt,
      });
      updatedCount++;
    }
  }

  const sorted = sortEntriesDescending([...byId.values()]);
  const truncatedCount = Math.max(0, sorted.length - MAX_ENTRIES_PER_SPOT);
  return {
    entries: sorted.slice(0, MAX_ENTRIES_PER_SPOT),
    addedCount,
    updatedCount,
    truncatedCount,
  };
}

function findDuplicateSpotIndex(list: VisitSpot[], target: VisitSpot): number {
  const byId = list.findIndex((s) => s.id === target.id);
  if (byId >= 0) return byId;
  return list.findIndex((s) =>
    isSameCoordinate(s.center[0], s.center[1], target.center[0], target.center[1])
  );
}

function diffPhotoCounts(
  current: VisitSpot[],
  next: VisitSpot[]
): { photosAdded: number; photosRemoved: number } {
  const prevIds = collectReferencedPhotoIds(current);
  const nextIds = collectReferencedPhotoIds(next);
  let photosAdded = 0;
  let photosRemoved = 0;
  for (const id of nextIds) {
    if (!prevIds.has(id)) photosAdded++;
  }
  for (const id of prevIds) {
    if (!nextIds.has(id)) photosRemoved++;
  }
  return { photosAdded, photosRemoved };
}

function dedupeIncomingSpots(
  items: VisitSpot[],
  respectEmptyIncomingPhotos = false
): VisitSpot[] {
  const result: VisitSpot[] = [];
  for (const item of items) {
    const idx = findDuplicateSpotIndex(result, item);
    if (idx < 0) {
      result.push(cloneSpots([item])[0]);
    } else {
      const existing = result[idx];
      const merged = mergeEntries(existing.entries, item.entries, respectEmptyIncomingPhotos);
      const newer =
        toTimestamp(item.updatedAt) > toTimestamp(existing.updatedAt) ? item : existing;
      result[idx] = {
        ...newer,
        id: existing.id,
        entries: merged.entries,
        status: deriveSpotStatus(merged.entries, newer.status),
      };
    }
  }
  return result;
}

export function previewMerge(
  current: VisitSpot[],
  incomingRaw: VisitSpot[],
  mode: ImportMode,
  options?: { photoSyncVersion?: number }
): MergePreview {
  const respectEmptyIncomingPhotos = (options?.photoSyncVersion ?? 0) >= 2;
  const incoming = dedupeIncomingSpots(incomingRaw, respectEmptyIncomingPhotos);

  if (mode === 'replace') {
    const next = incoming.slice(0, MAX_SPOTS);
    let added = 0;
    let updated = 0;
    let entriesAdded = 0;
    let unchanged = 0;
    for (const item of next) {
      const idx = findDuplicateSpotIndex(current, item);
      if (idx < 0) {
        added++;
        entriesAdded += item.entries.length;
      } else if (toTimestamp(item.updatedAt) > toTimestamp(current[idx].updatedAt)) {
        updated++;
      } else {
        unchanged++;
      }
    }
    const keptCount = next.filter((item) => findDuplicateSpotIndex(current, item) >= 0).length;
    const { photosAdded, photosRemoved } = diffPhotoCounts(current, next);
    return {
      next,
      added,
      updated,
      entriesAdded,
      unchanged,
      removed: Math.max(0, current.length - keptCount),
      truncatedSpots: Math.max(0, incoming.length - next.length),
      truncatedEntries: 0,
      photosAdded,
      photosRemoved,
    };
  }

  const merged = cloneSpots(current);
  const newSpots: VisitSpot[] = [];
  let updated = 0;
  let entriesAdded = 0;
  let unchanged = 0;
  let truncatedEntries = 0;

  for (const item of incoming) {
    const idx = findDuplicateSpotIndex(merged, item);
    if (idx < 0) {
      newSpots.push(item);
      continue;
    }

    const existing = merged[idx];
    const entryMerge = mergeEntries(existing.entries, item.entries, respectEmptyIncomingPhotos);
    truncatedEntries += entryMerge.truncatedCount;
    entriesAdded += entryMerge.addedCount;

    const metaIsNewer = toTimestamp(item.updatedAt) > toTimestamp(existing.updatedAt);
    if (metaIsNewer || entryMerge.addedCount > 0 || entryMerge.updatedCount > 0) {
      const metaBase = metaIsNewer ? item : existing;
      merged[idx] = {
        ...metaBase,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt:
          toTimestamp(item.updatedAt) > toTimestamp(existing.updatedAt)
            ? item.updatedAt
            : existing.updatedAt,
        elevation: metaBase.elevation ?? existing.elevation ?? item.elevation,
        addressSummary: metaBase.addressSummary ?? existing.addressSummary ?? item.addressSummary,
        presetId: metaBase.presetId ?? existing.presetId ?? item.presetId,
        entries: entryMerge.entries,
        status: deriveSpotStatus(entryMerge.entries, metaBase.status),
      };
      updated++;
    } else {
      unchanged++;
    }
  }

  const room = Math.max(0, MAX_SPOTS - merged.length);
  const acceptedNew = newSpots.slice(0, room);
  for (const s of acceptedNew) entriesAdded += s.entries.length;

  const next = [...acceptedNew, ...merged];
  const { photosAdded, photosRemoved } = diffPhotoCounts(current, next);

  return {
    next,
    added: acceptedNew.length,
    updated,
    entriesAdded,
    unchanged,
    removed: 0,
    truncatedSpots: Math.max(0, newSpots.length - acceptedNew.length),
    truncatedEntries,
    photosAdded,
    photosRemoved,
  };
}

export function buildBackupEnvelope(spots: VisitSpot[], revision = 1): VisitBackupEnvelope {
  return {
    app: BACKUP_APP_ID,
    kind: BACKUP_KIND,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    photoSyncVersion: PHOTO_SYNC_VERSION,
    exportedAt: new Date().toISOString(),
    revision,
    count: spots.length,
    items: cloneSpots(spots),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function buildBackupFileName(date = new Date()): string {
  const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(
    date.getHours()
  )}${pad2(date.getMinutes())}`;
  return `3d-visit-record-${stamp}.json`;
}

export async function exportBackupJsonFile(
  spots: VisitSpot[],
  revision = 1
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const json = JSON.stringify(buildBackupEnvelope(spots, revision), null, 2);
  const fileName = buildBackupFileName();
  const blob = new Blob([json], { type: 'application/json' });

  const isTouchDevice =
    typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  if (isTouchDevice && typeof navigator.share === 'function' && typeof File === 'function') {
    const file = new File([blob], fileName, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: '3D Visit Record バックアップ' });
        return 'shared';
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return 'cancelled';
      }
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}
