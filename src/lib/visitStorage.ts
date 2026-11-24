import { diagnostic } from './diagnostics';
import {
  openVisitDb,
  pruneOrphanPhotosInDb,
  putStoredPhotosInTx,
  STORE_APP_STATE,
  STORE_PHOTOS,
  VISIT_DB_NAME,
} from './photoStorage';
import {
  cloneSpots,
  collectReferencedPhotoIds,
  countTotalPhotos,
  isValidVisitSpot,
} from './spotDomain';
import {
  MAX_SPOTS,
  MAX_TOTAL_PHOTOS,
  type BaseMapId,
  type DriveSyncMeta,
  type LocalAppState,
  type StatusFilterValue,
  type StoredPhotoRecord,
  type UiPreferences,
  type UndoSnapshot,
  type VisitSpot,
} from '../types/visit';
import type { ErrorKind } from '../types/status';

const PRIMARY_KEY = 'primary';

const UI_PREFS_LOCAL_KEY = 'visit3d_ui_prefs_v1';

export const EMPTY_DRIVE_SYNC_META: DriveSyncMeta = {
  folderId: null,
  photosFolderId: null,
  fileId: null,
  lastSyncedRevision: null,
  lastDriveModifiedTime: null,
  lastDriveHeadRevisionId: null,
  lastSyncedAt: null,
  accountEmail: null,
};

export function createEmptyAppState(): LocalAppState {
  return {
    version: 1,
    revision: 0,
    spots: [],
    undo: null,
    driveSync: { ...EMPTY_DRIVE_SYNC_META },
    lastLocalExportAt: null,
  };
}

export interface StorageOperationResult {
  success: boolean;
  error?: ErrorKind;
  message?: string;
  state?: LocalAppState;
}

let currentState: LocalAppState | null = null;
let storageWarning: string | null = null;
let storageBlocked = false;
let operationQueue: Promise<unknown> = Promise.resolve();

export function getVisitStorageWarning(): string | null {
  return storageWarning;
}

export function isVisitStorageBlocked(): boolean {
  return storageBlocked;
}

export function resetVisitStorageForTesting(): void {
  currentState = null;
  storageWarning = null;
  storageBlocked = false;
  operationQueue = Promise.resolve();
}

function safeGetLocalStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadUiPreferences(): UiPreferences {
  const defaults: UiPreferences = {
    baseMap: 'osm',
    exaggeration: 1.5,
    statusFilter: 'all',
    prefectureFillEnabled: false,
  };
  const ls = safeGetLocalStorage();
  if (!ls) return defaults;
  try {
    const raw = JSON.parse(ls.getItem(UI_PREFS_LOCAL_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return defaults;
    const baseMap: BaseMapId =
      raw.baseMap === 'osm' || raw.baseMap === 'hillshade' || raw.baseMap === 'photo'
        ? raw.baseMap
        : defaults.baseMap;
    const exaggeration =
      typeof raw.exaggeration === 'number' &&
      Number.isFinite(raw.exaggeration) &&
      raw.exaggeration >= 1.0 &&
      raw.exaggeration <= 3.0
        ? raw.exaggeration
        : defaults.exaggeration;
    const statusFilter: StatusFilterValue =
      raw.statusFilter === 'all' || raw.statusFilter === 'visited' || raw.statusFilter === 'planned'
        ? raw.statusFilter
        : defaults.statusFilter;
    const prefectureFillEnabled = raw.prefectureFillEnabled === true;
    return { baseMap, exaggeration, statusFilter, prefectureFillEnabled };
  } catch {
    return defaults;
  }
}

export function saveUiPreferences(prefs: UiPreferences): void {
  const ls = safeGetLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(UI_PREFS_LOCAL_KEY, JSON.stringify(prefs));
  } catch {
    // ignore UI prefs failure
  }
}

async function dbRead(db: IDBDatabase, storeName: string, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const timer = setTimeout(() => {
      try {
        tx.abort();
      } catch {
        // already ended
      }
      reject(new Error('storage timeout'));
    }, 5000);
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => {
      clearTimeout(timer);
      resolve(req.result);
    };
    req.onerror = () => {
      clearTimeout(timer);
      reject(new Error('storage read'));
    };
    tx.onabort = () => {
      clearTimeout(timer);
      reject(new Error('storage abort'));
    };
  });
}

function parseDriveSyncMeta(raw: unknown): DriveSyncMeta {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_DRIVE_SYNC_META };
  const m = raw as Partial<DriveSyncMeta>;
  return {
    folderId: typeof m.folderId === 'string' ? m.folderId : null,
    photosFolderId: typeof m.photosFolderId === 'string' ? m.photosFolderId : null,
    fileId: typeof m.fileId === 'string' ? m.fileId : null,
    lastSyncedRevision:
      typeof m.lastSyncedRevision === 'number' && Number.isSafeInteger(m.lastSyncedRevision)
        ? m.lastSyncedRevision
        : null,
    lastDriveModifiedTime:
      typeof m.lastDriveModifiedTime === 'string' ? m.lastDriveModifiedTime : null,
    lastDriveHeadRevisionId:
      typeof m.lastDriveHeadRevisionId === 'string' ? m.lastDriveHeadRevisionId : null,
    lastSyncedAt: typeof m.lastSyncedAt === 'string' ? m.lastSyncedAt : null,
    accountEmail: typeof m.accountEmail === 'string' ? m.accountEmail : null,
  };
}

function parseAppState(value: unknown): LocalAppState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<LocalAppState>;
  if (raw.version !== 1 || !Array.isArray(raw.spots)) return null;
  if (!raw.spots.every(isValidVisitSpot)) return null;

  let undo: UndoSnapshot | null = null;
  if (raw.undo != null) {
    if (
      typeof raw.undo !== 'object' ||
      !Array.isArray(raw.undo.spots) ||
      !raw.undo.spots.every(isValidVisitSpot) ||
      typeof raw.undo.savedAt !== 'string' ||
      !Number.isFinite(Date.parse(raw.undo.savedAt)) ||
      (raw.undo.reason !== 'drive-restore' && raw.undo.reason !== 'json-import')
    ) {
      return null;
    }
    undo = {
      savedAt: raw.undo.savedAt,
      reason: raw.undo.reason,
      spots: cloneSpots(raw.undo.spots),
    };
  }

  return {
    version: 1,
    revision:
      typeof raw.revision === 'number' && Number.isSafeInteger(raw.revision) && raw.revision >= 0
        ? raw.revision
        : 0,
    spots: cloneSpots(raw.spots),
    undo,
    driveSync: parseDriveSyncMeta(raw.driveSync),
    lastLocalExportAt: typeof raw.lastLocalExportAt === 'string' ? raw.lastLocalExportAt : null,
  };
}

async function readStateFromDb(): Promise<LocalAppState> {
  storageBlocked = false;
  storageWarning = null;

  const db = await openVisitDb();
  if (!db) {
    if (currentState) return currentState;
    storageBlocked = true;
    storageWarning = 'ローカルデータベース（IndexedDB）を開けませんでした。';
    diagnostic({
      operation: 'visit-read',
      backend: 'idb',
      outcome: 'failure',
      error: 'storage-unavailable',
    });
    return createEmptyAppState();
  }

  try {
    const raw = await dbRead(db, STORE_APP_STATE, PRIMARY_KEY);
    if (raw === undefined || raw === null) {
      const next = currentState ?? createEmptyAppState();
      currentState = next;
      diagnostic({
        operation: 'visit-read',
        backend: 'idb',
        outcome: 'success',
        count: next.spots.length,
      });
      return next;
    }
    const parsed = parseAppState(raw);
    if (!parsed) {
      storageBlocked = true;
      storageWarning =
        '保存データの形式を検証できません。元データを保護するため自動更新を停止しました。救済データ書き出しをご検討ください。';
      diagnostic({
        operation: 'visit-read',
        backend: 'idb',
        outcome: 'failure',
        error: 'invalid-data',
      });
      return createEmptyAppState();
    }
    currentState = parsed;
    diagnostic({
      operation: 'visit-read',
      backend: 'idb',
      outcome: 'success',
      count: parsed.spots.length,
    });
    return parsed;
  } catch {
    storageBlocked = true;
    storageWarning = '保存先の読み出しに失敗しました。再読み込みして確認してください。';
    diagnostic({
      operation: 'visit-read',
      backend: 'idb',
      outcome: 'failure',
      error: 'storage-unavailable',
    });
    return currentState ?? createEmptyAppState();
  } finally {
    db.close?.();
  }
}

function collectReferencedIdsForState(state: LocalAppState): Set<string> {
  const ids = collectReferencedPhotoIds(state.spots);
  if (state.undo) {
    for (const id of collectReferencedPhotoIds(state.undo.spots)) {
      ids.add(id);
    }
  }
  return ids;
}

async function commitStateToDb(
  state: LocalAppState,
  options?: { newPhotos?: StoredPhotoRecord[]; pruneOrphans?: boolean }
): Promise<StorageOperationResult> {
  const newPhotos = options?.newPhotos ?? [];
  const db = await openVisitDb();
  if (!db) {
    diagnostic({
      operation: 'visit-commit',
      backend: 'idb',
      outcome: 'failure',
      error: 'storage-unavailable',
    });
    return {
      success: false,
      error: 'storage-unavailable',
      message: '保存先データベースを開けませんでした。変更前のデータは保持されています。',
    };
  }

  try {
    let quotaExceeded = false;
    const storeNames =
      newPhotos.length > 0 ? [STORE_APP_STATE, STORE_PHOTOS] : [STORE_APP_STATE];
    const timeoutMs = newPhotos.length > 0 ? 10000 : 5000;

    const ok = await new Promise<boolean>((resolve) => {
      const tx = db.transaction(storeNames, 'readwrite');
      const timer = setTimeout(() => {
        try {
          tx.abort();
        } catch {
          // ended
        }
      }, timeoutMs);
      tx.oncomplete = () => {
        clearTimeout(timer);
        resolve(true);
      };
      tx.onerror = () => {
        clearTimeout(timer);
        quotaExceeded = tx.error?.name === 'QuotaExceededError';
        resolve(false);
      };
      tx.onabort = () => {
        clearTimeout(timer);
        quotaExceeded = tx.error?.name === 'QuotaExceededError';
        resolve(false);
      };
      if (newPhotos.length > 0) {
        putStoredPhotosInTx(tx, newPhotos);
      }
      tx.objectStore(STORE_APP_STATE).put(state, PRIMARY_KEY);
    });

    if (!ok) {
      diagnostic({
        operation: 'visit-commit',
        backend: 'idb',
        outcome: 'failure',
        error: quotaExceeded ? 'quota' : 'storage-unavailable',
      });
      return {
        success: false,
        error: quotaExceeded ? 'quota' : 'storage-unavailable',
        message: quotaExceeded
          ? '端末の保存容量が不足しています。'
          : '保存に失敗しました。変更前のデータは保持されています。',
      };
    }

    currentState = state;
    storageWarning = null;
    diagnostic({
      operation: 'visit-commit',
      backend: 'idb',
      outcome: 'success',
      count: state.spots.length,
    });

    if (options?.pruneOrphans) {
      try {
        await pruneOrphanPhotosInDb(db, collectReferencedIdsForState(state));
      } catch {
        // ベストエフォートのGC失敗では本体保存成功を妨げない
      }
    }

    return { success: true, state };
  } finally {
    db.close?.();
  }
}

function validateSpotsForWrite(spots: VisitSpot[]): StorageOperationResult | null {
  if (!Array.isArray(spots) || spots.length > MAX_SPOTS) {
    return {
      success: false,
      error: 'invalid-data',
      message: `登録できる地点は最大 ${MAX_SPOTS} 件までです。`,
    };
  }
  const ids = new Set(spots.map((s) => s?.id));
  if (ids.size !== spots.length) {
    return {
      success: false,
      error: 'invalid-data',
      message: '地点IDが重複しているため保存を停止しました。',
    };
  }
  if (countTotalPhotos(spots) > MAX_TOTAL_PHOTOS) {
    return {
      success: false,
      error: 'invalid-data',
      message: `登録できる写真の総数は最大 ${MAX_TOTAL_PHOTOS} 枚までです。`,
    };
  }
  if (!spots.every(isValidVisitSpot)) {
    return {
      success: false,
      error: 'invalid-data',
      message: '地点または記録の形式・文字数制限に不正があります。',
    };
  }
  return null;
}

function validateNewPhotosForWrite(records: StoredPhotoRecord[]): StorageOperationResult | null {
  for (const r of records) {
    if (
      !r ||
      typeof r.id !== 'string' ||
      r.id.length === 0 ||
      (r.mimeType !== 'image/webp' && r.mimeType !== 'image/jpeg') ||
      !r.fullBlob ||
      r.fullBlob.size <= 0 ||
      !r.thumbnailBlob ||
      r.thumbnailBlob.size <= 0
    ) {
      return {
        success: false,
        error: 'invalid-data',
        message: '写真データの形式が不正なため保存を停止しました。',
      };
    }
  }
  return null;
}

interface PendingStateMutation {
  state: LocalAppState;
  newPhotos?: StoredPhotoRecord[];
  pruneOrphans?: boolean;
  bumpRevision?: boolean;
}

function enqueueStateUpdate(
  mutator: (prev: LocalAppState) => PendingStateMutation | LocalAppState | StorageOperationResult
): Promise<StorageOperationResult> {
  const task = operationQueue
    .then(async (): Promise<StorageOperationResult> => {
      const state = currentState ?? (await readStateFromDb());
      if (storageBlocked) {
        return {
          success: false,
          error: 'storage-unavailable',
          message: storageWarning ?? '保存データを確認できないため更新を停止しました。',
        };
      }
      const next = mutator(state);
      if ('success' in next) return next;
      const mutation: PendingStateMutation =
        'state' in next ? next : { state: next, pruneOrphans: true, bumpRevision: true };
      const shouldBump = mutation.bumpRevision !== false;
      const committedState: LocalAppState = {
        ...mutation.state,
        revision: shouldBump ? Math.max(state.revision + 1, Date.now()) : mutation.state.revision,
      };
      return commitStateToDb(committedState, {
        newPhotos: mutation.newPhotos,
        pruneOrphans: mutation.pruneOrphans,
      });
    })
    .catch((): StorageOperationResult => ({
      success: false,
      error: 'storage-unavailable',
      message: '保存処理で予期しないエラーが発生しました。',
    }));
  operationQueue = task;
  return task;
}

export function loadAppState(): Promise<LocalAppState> {
  const task = operationQueue.then(() => readStateFromDb());
  operationQueue = task.catch(() => {});
  return task;
}

export function saveSpots(spots: VisitSpot[]): Promise<StorageOperationResult> {
  return enqueueStateUpdate((state) => {
    const invalid = validateSpotsForWrite(spots);
    if (invalid) return invalid;
    return {
      state: {
        ...state,
        spots: cloneSpots(spots),
      },
      pruneOrphans: true,
      bumpRevision: true,
    };
  });
}

export function saveSpotsWithPhotosAtomic(
  spots: VisitSpot[],
  newPhotos: StoredPhotoRecord[]
): Promise<StorageOperationResult> {
  return enqueueStateUpdate((state) => {
    const invalidSpots = validateSpotsForWrite(spots);
    if (invalidSpots) return invalidSpots;
    const invalidPhotos = validateNewPhotosForWrite(newPhotos);
    if (invalidPhotos) return invalidPhotos;
    return {
      state: {
        ...state,
        spots: cloneSpots(spots),
      },
      newPhotos,
      pruneOrphans: true,
      bumpRevision: true,
    };
  });
}

export function saveSpotsWithUndoAtomic(
  nextSpots: VisitSpot[],
  undoSpots: VisitSpot[],
  reason: 'drive-restore' | 'json-import',
  driveSyncPatch?: Partial<DriveSyncMeta>
): Promise<StorageOperationResult> {
  return enqueueStateUpdate((state) => {
    const invalidNext = validateSpotsForWrite(nextSpots);
    if (invalidNext) return invalidNext;
    const invalidUndo = validateSpotsForWrite(undoSpots);
    if (invalidUndo) return invalidUndo;
    return {
      state: {
        ...state,
        spots: cloneSpots(nextSpots),
        undo: {
          savedAt: new Date().toISOString(),
          reason,
          spots: cloneSpots(undoSpots),
        },
        driveSync: driveSyncPatch ? { ...state.driveSync, ...driveSyncPatch } : state.driveSync,
      },
      pruneOrphans: true,
      bumpRevision: true,
    };
  });
}

export function restoreUndoSnapshot(): Promise<StorageOperationResult> {
  return enqueueStateUpdate((state) => {
    if (!state.undo) {
      return {
        success: false,
        error: 'invalid-data',
        message: '復元できる直前の状態（Undoデータ）がありません。',
      };
    }
    const invalid = validateSpotsForWrite(state.undo.spots);
    if (invalid) return invalid;
    return {
      state: {
        ...state,
        spots: cloneSpots(state.undo.spots),
        undo: null,
      },
      pruneOrphans: true,
      bumpRevision: true,
    };
  });
}

export function patchPhotoDriveFileIds(
  updates: Record<string, string>
): Promise<StorageOperationResult> {
  return enqueueStateUpdate((state) => {
    const keys = Object.keys(updates);
    if (keys.length === 0) {
      return { success: true, state };
    }
    let changed = false;
    const nextSpots = state.spots.map((spot) => {
      let spotChanged = false;
      const nextEntries = spot.entries.map((entry) => {
        let entryChanged = false;
        const nextPhotos = entry.photos.map((photo) => {
          const nextDriveId = updates[photo.id];
          if (nextDriveId && photo.driveFileId !== nextDriveId) {
            entryChanged = true;
            return { ...photo, driveFileId: nextDriveId };
          }
          return photo;
        });
        if (!entryChanged) return entry;
        spotChanged = true;
        return { ...entry, photos: nextPhotos };
      });
      if (!spotChanged) return spot;
      changed = true;
      return { ...spot, entries: nextEntries };
    });

    if (!changed) {
      return { success: true, state };
    }
    return {
      state: {
        ...state,
        spots: nextSpots,
      },
      pruneOrphans: false,
      bumpRevision: false,
    };
  });
}

export function updateDriveSyncMeta(
  patch: Partial<DriveSyncMeta>,
  bumpRevision = false
): Promise<StorageOperationResult> {
  const task = operationQueue.then(async () => {
    const state = currentState ?? (await readStateFromDb());
    if (storageBlocked) {
      return {
        success: false,
        error: 'storage-unavailable' as const,
        message: storageWarning ?? '保存停止中です。',
      };
    }
    const next: LocalAppState = {
      ...state,
      revision: bumpRevision ? Math.max(state.revision + 1, Date.now()) : state.revision,
      driveSync: { ...state.driveSync, ...patch },
    };
    return commitStateToDb(next);
  });
  operationQueue = task.catch(() => {});
  return task;
}

export function markLocalExportTimestamp(iso: string): Promise<StorageOperationResult> {
  const task = operationQueue.then(async () => {
    const state = currentState ?? (await readStateFromDb());
    if (storageBlocked) {
      return { success: false, error: 'storage-unavailable' as const };
    }
    return commitStateToDb({ ...state, lastLocalExportAt: iso });
  });
  operationQueue = task.catch(() => {});
  return task;
}

export async function readRawRecoveryData(): Promise<unknown> {
  const db = await openVisitDb();
  if (!db) return { error: 'IndexedDB unavailable' };
  try {
    const primary = await dbRead(db, STORE_APP_STATE, PRIMARY_KEY);
    return { dbName: VISIT_DB_NAME, store: STORE_APP_STATE, primary: primary ?? null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to read raw data' };
  } finally {
    db.close?.();
  }
}

export function requestPersistentStorage(): void {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
    void navigator.storage
      .persisted()
      .then((already) => (already ? true : navigator.storage.persist()))
      .catch(() => undefined);
  } catch {
    // ignore
  }
}
