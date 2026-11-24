export type SpotStatus = 'visited' | 'planned';
export type StatusFilterValue = 'all' | SpotStatus;
export type SpotCategory = 'nature' | 'tourism' | 'lifestyle' | 'other';
export type VisitDatePrecision = 'day' | 'month' | 'year' | 'none';

export type RendererBackend = 'webgpu' | 'webgl2' | 'webgl';
export type BaseMapId = 'osm' | 'hillshade' | 'photo';

export const MAX_SPOTS = 1000;
export const MAX_ENTRIES_PER_SPOT = 50;
export const MAX_SPOT_NAME_LENGTH = 80;
export const MAX_ADDRESS_SUMMARY_LENGTH = 120;
export const MAX_MEMO_LENGTH = 2000;
export const MAX_BACKUP_FILE_BYTES = 16 * 1024 * 1024;
export const SAME_COORDINATE_TOLERANCE_DEG = 0.0005;

export const MAX_PHOTOS_PER_ENTRY = 5;
export const MAX_TOTAL_PHOTOS = 2000;
export const MAX_PHOTO_INPUT_BYTES = 25 * 1024 * 1024;
export const MAX_PHOTO_CAPTION_LENGTH = 200;
export const PHOTO_DISPLAY_MAX_EDGE = 1600;
export const PHOTO_THUMBNAIL_MAX_EDGE = 320;
export const PHOTO_WEBP_QUALITY = 0.82;
export const PHOTO_JPEG_FALLBACK_QUALITY = 0.85;
export const PHOTO_THUMB_QUALITY = 0.75;

export type PhotoMimeType = 'image/webp' | 'image/jpeg';

export interface VisitDate {
  precision: VisitDatePrecision;
  /**
   * precision に応じた開始値:
   * - 'day'  : 'YYYY-MM-DD'
   * - 'month': 'YYYY-MM'
   * - 'year' : 'YYYY'
   * - 'none' : undefined
   */
  start?: string;
  /**
   * From-To 期間指定時の終了値（precision !== 'none' のとき任意）。
   * start と同じ精度であり、end >= start を満たす。
   * end === start の場合は正規化時に省略（undefined）とする。
   */
  end?: string;
}

/** v2.0以降の写真添付メタデータ */
export interface PhotoAttachment {
  id: string;
  fileName: string;
  mimeType: PhotoMimeType;
  width: number;
  height: number;
  bytes: number;
  caption?: string;
  takenAt?: string;
  driveFileId?: string;
  checksumSha256?: string;
}

/** IndexedDB 'photos' ストアのレコード構造 */
export interface StoredPhotoRecord {
  id: string;
  mimeType: PhotoMimeType;
  width: number;
  height: number;
  bytes: number;
  fullBlob: Blob;
  thumbnailBlob: Blob;
  createdAt: string;
  updatedAt: string;
}

/** フォーム編集中に保持する未確定写真ドラフト（メモリ上のみ） */
export interface DraftPhotoItem {
  attachment: PhotoAttachment;
  fullBlob?: Blob;
  thumbnailBlob?: Blob;
  previewUrl: string;
  isNew: boolean;
  exifLocalDate?: string;
}

/** 端末内写真ストレージ使用量サマリー */
export interface PhotoStorageStats {
  photoCount: number;
  totalBytes: number;
  originUsageBytes: number | null;
  originQuotaBytes: number | null;
}

export interface VisitEntry {
  id: string;
  kind: SpotStatus;
  date: VisitDate;
  memo: string;
  photos: PhotoAttachment[];
  createdAt: string;
  updatedAt: string;
}

export interface SpotCamera {
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface VisitSpot {
  id: string;
  name: string;
  status: SpotStatus;
  category: SpotCategory;
  center: [number, number]; // [lng, lat]
  elevation: number | null;
  camera: SpotCamera;
  addressSummary?: string;
  presetId?: string;
  isPinned: boolean;
  entries: VisitEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface VisitBackupEnvelope {
  app: '3d-visit-record';
  kind: 'visit-records';
  schemaVersion: 1;
  photoSyncVersion?: 2;
  exportedAt: string;
  revision: number;
  count: number;
  items: VisitSpot[];
}

export interface DriveSyncMeta {
  folderId: string | null;
  photosFolderId?: string | null;
  fileId: string | null;
  lastSyncedRevision: number | null;
  lastDriveModifiedTime: string | null;
  lastDriveHeadRevisionId: string | null;
  lastSyncedAt: string | null;
  accountEmail: string | null;
}

export interface UndoSnapshot {
  savedAt: string;
  reason: 'drive-restore' | 'json-import';
  spots: VisitSpot[];
}

export interface LocalAppState {
  version: 1;
  revision: number;
  spots: VisitSpot[];
  undo: UndoSnapshot | null;
  driveSync: DriveSyncMeta;
  lastLocalExportAt: string | null;
}

export interface PresetMountain {
  id: string;
  name: string;
  kana: string;
  areaGroup: string;
  prefectures: string[];
  region: string;
  emoji: string;
  elevation: number;
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  description: string;
}

export interface InspectedPoint {
  lng: number;
  lat: number;
  elevation: number | null;
  label?: string;
  addressSummary?: string;
  presetId?: string;
  suggestedCategory?: SpotCategory;
  recommendedZoom?: number;
}

export interface WebGPUStatus {
  backend: RendererBackend;
  webgpuAvailable: boolean;
  adapterInfo: string;
  fps: number;
}

export type PrefectureVisitStatus = 'visited' | 'planned' | 'none';

export interface PrefectureSummaryItem {
  code: string;
  name: string;
  status: PrefectureVisitStatus;
  visitedSpotCount: number;
  plannedSpotCount: number;
  totalSpotCount: number;
}

export interface PrefectureStats {
  totalPrefectures: number;
  visitedCount: number;
  plannedOnlyCount: number;
  unvisitedCount: number;
  byCode: Record<string, PrefectureSummaryItem>;
  items: PrefectureSummaryItem[];
}

export interface UiPreferences {
  baseMap: BaseMapId;
  exaggeration: number;
  statusFilter: StatusFilterValue;
  prefectureFillEnabled: boolean;
}
