import {
  MAX_ADDRESS_SUMMARY_LENGTH,
  MAX_ENTRIES_PER_SPOT,
  MAX_MEMO_LENGTH,
  MAX_PHOTO_CAPTION_LENGTH,
  MAX_PHOTOS_PER_ENTRY,
  MAX_SPOT_NAME_LENGTH,
  SAME_COORDINATE_TOLERANCE_DEG,
  type PhotoAttachment,
  type PresetMountain,
  type SpotStatus,
  type StatusFilterValue,
  type VisitEntry,
  type VisitSpot,
} from '../types/visit';
import { getVisitDateRange, isValidVisitDate } from './visitDate';
import { isSpotCategory } from './spotCategories';
import { calcDistanceMeters } from './osmPlaceClient';

export function createUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isSameCoordinate(
  lng1: number,
  lat1: number,
  lng2: number,
  lat2: number,
  tolerance = SAME_COORDINATE_TOLERANCE_DEG
): boolean {
  return Math.abs(lng1 - lng2) <= tolerance && Math.abs(lat1 - lat2) <= tolerance;
}

export function hasControlCharacters(value: string, allowNewlines = false): boolean {
  if (allowNewlines) {
    // Allow \n and \r, reject NUL and other C0/DEL controls
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
  }
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}

export function sanitizeSpotName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export function sanitizeMemo(raw: string): string {
  return raw.replace(/\r\n/g, '\n').trim();
}

export function sanitizeAddressSummary(raw?: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, MAX_ADDRESS_SUMMARY_LENGTH) : undefined;
}

export function sanitizePhotoCaption(raw?: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  return cleaned || undefined;
}

export function isValidPhotoFileName(fileName: string): boolean {
  if (typeof fileName !== 'string') return false;
  if (fileName.length === 0 || fileName.length > 255) return false;
  if (hasControlCharacters(fileName, false)) return false;
  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) return false;
  return fileName.trim().length > 0;
}

/**
 * 地点の主ステータスを決定します（2.4節整合ルール）。
 * 1件以上の visited ログが存在すれば 'visited'、visited が0件で planned がある場合は 'planned'。
 */
export function deriveSpotStatus(
  entries: VisitEntry[],
  fallbackStatus: SpotStatus = 'planned'
): SpotStatus {
  if (entries.length === 0) return fallbackStatus;
  if (entries.some((e) => e.kind === 'visited')) return 'visited';
  return 'planned';
}

export function hasPlannedEntry(spot: VisitSpot): boolean {
  return spot.entries.some((e) => e.kind === 'planned');
}

export function isHybridSpot(spot: VisitSpot): boolean {
  return spot.status === 'visited' && hasPlannedEntry(spot);
}

export function matchesStatusFilter(spot: VisitSpot, filter: StatusFilterValue): boolean {
  if (filter === 'all') return true;
  if (filter === 'visited') return spot.status === 'visited';
  return spot.status === 'planned' || hasPlannedEntry(spot);
}

export function getSpotSortDateKey(spot: VisitSpot, filter: StatusFilterValue): string {
  const candidates =
    filter === 'planned'
      ? spot.entries.filter((e) => e.kind === 'planned')
      : spot.entries;
  let best = '';
  for (const entry of candidates) {
    const range = getVisitDateRange(entry.date);
    if (range && range.start > best) {
      best = range.start;
    }
  }
  return best;
}

export function matchHyakumeizanSpot(
  mountain: PresetMountain,
  spots: VisitSpot[]
): VisitSpot | null {
  const byPreset = spots.find((s) => s.presetId === mountain.id);
  if (byPreset) return byPreset;

  let closest: VisitSpot | null = null;
  let closestDist = Infinity;
  for (const spot of spots) {
    const dist = calcDistanceMeters(mountain.center[1], mountain.center[0], spot.center[1], spot.center[0]);
    if (dist <= 2000 && dist < closestDist) {
      closest = spot;
      closestDist = dist;
    }
  }
  return closest;
}

export function isValidPhotoAttachment(raw: unknown): raw is PhotoAttachment {
  if (!raw || typeof raw !== 'object') return false;
  const p = raw as Partial<PhotoAttachment>;
  if (typeof p.id !== 'string' || !/^[\w.-]{1,80}$/.test(p.id)) return false;
  if (typeof p.fileName !== 'string' || !isValidPhotoFileName(p.fileName)) return false;
  if (p.mimeType !== 'image/webp' && p.mimeType !== 'image/jpeg') return false;
  if (typeof p.width !== 'number' || !Number.isFinite(p.width) || p.width <= 0) return false;
  if (typeof p.height !== 'number' || !Number.isFinite(p.height) || p.height <= 0) return false;
  if (typeof p.bytes !== 'number' || !Number.isFinite(p.bytes) || p.bytes <= 0) return false;
  if (
    p.caption !== undefined &&
    (typeof p.caption !== 'string' ||
      p.caption.length > MAX_PHOTO_CAPTION_LENGTH ||
      hasControlCharacters(p.caption, false))
  ) {
    return false;
  }
  if (
    p.takenAt !== undefined &&
    (typeof p.takenAt !== 'string' || p.takenAt.length > 64 || !Number.isFinite(Date.parse(p.takenAt)))
  ) {
    return false;
  }
  if (
    p.driveFileId !== undefined &&
    (typeof p.driveFileId !== 'string' ||
      p.driveFileId.length === 0 ||
      p.driveFileId.length > 200 ||
      hasControlCharacters(p.driveFileId, false))
  ) {
    return false;
  }
  if (
    p.checksumSha256 !== undefined &&
    (typeof p.checksumSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(p.checksumSha256))
  ) {
    return false;
  }
  return true;
}

export function collectReferencedPhotoIds(spots: VisitSpot[]): Set<string> {
  const ids = new Set<string>();
  for (const spot of spots) {
    for (const entry of spot.entries) {
      for (const photo of entry.photos) {
        ids.add(photo.id);
      }
    }
  }
  return ids;
}

export function countTotalPhotos(spots: VisitSpot[]): number {
  let total = 0;
  for (const spot of spots) {
    for (const entry of spot.entries) {
      total += entry.photos.length;
    }
  }
  return total;
}

export function hasUnuploadedPhotos(spots: VisitSpot[]): boolean {
  for (const spot of spots) {
    for (const entry of spot.entries) {
      for (const photo of entry.photos) {
        if (!photo.driveFileId) return true;
      }
    }
  }
  return false;
}

export function isValidVisitEntry(raw: unknown): raw is VisitEntry {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Partial<VisitEntry>;
  if (typeof e.id !== 'string' || !/^[\w.-]{1,80}$/.test(e.id)) return false;
  if (e.kind !== 'visited' && e.kind !== 'planned') return false;
  if (!isValidVisitDate(e.date)) return false;
  if (typeof e.memo !== 'string' || e.memo.length > MAX_MEMO_LENGTH) return false;
  if (hasControlCharacters(e.memo, true)) return false;
  if (
    !Array.isArray(e.photos) ||
    e.photos.length > MAX_PHOTOS_PER_ENTRY ||
    !e.photos.every(isValidPhotoAttachment)
  ) {
    return false;
  }
  if (new Set(e.photos.map((p) => p.id)).size !== e.photos.length) return false;
  if (typeof e.createdAt !== 'string' || !Number.isFinite(Date.parse(e.createdAt))) return false;
  if (typeof e.updatedAt !== 'string' || !Number.isFinite(Date.parse(e.updatedAt))) return false;
  return true;
}

export function isValidVisitSpot(raw: unknown): raw is VisitSpot {
  if (!raw || typeof raw !== 'object') return false;
  const s = raw as Partial<VisitSpot>;
  if (typeof s.id !== 'string' || !/^[\w.-]{1,80}$/.test(s.id)) return false;
  if (typeof s.name !== 'string') return false;
  const trimmedName = s.name.trim();
  if (
    trimmedName.length === 0 ||
    s.name.length > MAX_SPOT_NAME_LENGTH ||
    hasControlCharacters(s.name, false)
  ) {
    return false;
  }
  if (s.status !== 'visited' && s.status !== 'planned') return false;
  if (!isSpotCategory(s.category)) return false;
  if (!Array.isArray(s.center) || s.center.length !== 2) return false;
  const [lng, lat] = s.center;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return false;
  if (s.elevation !== null && (typeof s.elevation !== 'number' || !Number.isFinite(s.elevation))) {
    return false;
  }
  if (!s.camera || typeof s.camera !== 'object') return false;
  if (!Number.isFinite(s.camera.zoom) || s.camera.zoom < 0 || s.camera.zoom > 24) return false;
  if (!Number.isFinite(s.camera.pitch) || s.camera.pitch < 0 || s.camera.pitch > 85) return false;
  if (!Number.isFinite(s.camera.bearing) || s.camera.bearing < -180 || s.camera.bearing > 360) {
    return false;
  }
  if (
    s.addressSummary !== undefined &&
    (typeof s.addressSummary !== 'string' ||
      s.addressSummary.length > MAX_ADDRESS_SUMMARY_LENGTH ||
      hasControlCharacters(s.addressSummary, false))
  ) {
    return false;
  }
  if (s.presetId !== undefined && (typeof s.presetId !== 'string' || s.presetId.length > 64)) {
    return false;
  }
  if (typeof s.isPinned !== 'boolean') return false;
  if (
    !Array.isArray(s.entries) ||
    s.entries.length > MAX_ENTRIES_PER_SPOT ||
    !s.entries.every(isValidVisitEntry)
  ) {
    return false;
  }
  if (typeof s.createdAt !== 'string' || !Number.isFinite(Date.parse(s.createdAt))) return false;
  if (typeof s.updatedAt !== 'string' || !Number.isFinite(Date.parse(s.updatedAt))) return false;
  return true;
}

export function cloneSpots(spots: VisitSpot[]): VisitSpot[] {
  return spots.map((s) => ({
    ...s,
    center: [s.center[0], s.center[1]] as [number, number],
    camera: { ...s.camera },
    entries: s.entries.map((e) => ({
      ...e,
      date: { ...e.date },
      photos: e.photos.map((p) => ({ ...p })),
    })),
  }));
}

export const PHOTO_MATCH_SPOT_RADIUS_METERS = 300;
export const PHOTO_MATCH_MOUNTAIN_RADIUS_METERS = 1000;

export interface MatchedRegisteredSpot {
  spot: VisitSpot;
  distanceMeters: number;
}

export interface MatchedPresetMountain {
  mountain: PresetMountain;
  distanceMeters: number;
}

export interface PhotoLocationMatchResult {
  nearbySpots: MatchedRegisteredSpot[];
  nearbyMountain: MatchedPresetMountain | null;
}

/**
 * 写真EXIFの [lng, lat] 座標から、優先度順にスポット候補をマッチングします。
 * 1. 登録済みスポット（半径 300m 以内、近い順）
 * 2. 未登録の日本百名山プリセット（半径 1,000m 以内、最も近い1件）
 */
export function findPhotoLocationMatches(
  center: [number, number],
  spots: VisitSpot[],
  mountains: PresetMountain[]
): PhotoLocationMatchResult {
  const [lng, lat] = center;

  const nearbySpots: MatchedRegisteredSpot[] = [];
  for (const spot of spots) {
    const distanceMeters = calcDistanceMeters(lat, lng, spot.center[1], spot.center[0]);
    if (distanceMeters <= PHOTO_MATCH_SPOT_RADIUS_METERS) {
      nearbySpots.push({ spot, distanceMeters });
    }
  }
  nearbySpots.sort((a, b) => a.distanceMeters - b.distanceMeters);

  if (nearbySpots.length > 0) {
    return { nearbySpots, nearbyMountain: null };
  }

  let nearbyMountain: MatchedPresetMountain | null = null;
  for (const mountain of mountains) {
    if (matchHyakumeizanSpot(mountain, spots) !== null) continue;
    const distanceMeters = calcDistanceMeters(lat, lng, mountain.center[1], mountain.center[0]);
    if (
      distanceMeters <= PHOTO_MATCH_MOUNTAIN_RADIUS_METERS &&
      (!nearbyMountain || distanceMeters < nearbyMountain.distanceMeters)
    ) {
      nearbyMountain = { mountain, distanceMeters };
    }
  }

  return { nearbySpots: [], nearbyMountain };
}
