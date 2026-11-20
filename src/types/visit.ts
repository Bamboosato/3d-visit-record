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

/** v2以降の写真添付メタデータ（初版は常に photos: [] を保持し、前方互換を維持） */
export interface PhotoAttachment {
  id: string;
  fileName: string;
  mimeType: 'image/webp' | 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
  caption?: string;
  takenAt?: string;
  driveFileId?: string;
  checksumSha256?: string;
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
  exportedAt: string;
  revision: number;
  count: number;
  items: VisitSpot[];
}

export interface DriveSyncMeta {
  folderId: string | null;
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

export interface UiPreferences {
  baseMap: BaseMapId;
  exaggeration: number;
  statusFilter: StatusFilterValue;
}
