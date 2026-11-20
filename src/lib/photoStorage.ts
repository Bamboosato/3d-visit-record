import type { ErrorKind } from '../types/status';
import type { PhotoStorageStats, StoredPhotoRecord } from '../types/visit';
import { diagnostic } from './diagnostics';

export const VISIT_DB_NAME = 'visit3d_db';
export const VISIT_DB_VERSION = 1;
export const STORE_APP_STATE = 'app_state';
export const STORE_PHOTOS = 'photos';

const IDB_TIMEOUT_MS = 5000;

export function openVisitDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) {
        db?.close?.();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    const timer = setTimeout(() => finish(null), IDB_TIMEOUT_MS);
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) return finish(null);
      const req = indexedDB.open(VISIT_DB_NAME, VISIT_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_APP_STATE)) {
          db.createObjectStore(STORE_APP_STATE);
        }
        if (!db.objectStoreNames.contains(STORE_PHOTOS)) {
          db.createObjectStore(STORE_PHOTOS);
        }
      };
      req.onsuccess = () => finish(req.result);
      req.onerror = () => finish(null);
      req.onblocked = () => finish(null);
    } catch {
      finish(null);
    }
  });
}

function isValidStoredPhotoRecord(raw: unknown): raw is StoredPhotoRecord {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Partial<StoredPhotoRecord>;
  if (typeof r.id !== 'string' || r.id.length === 0) return false;
  if (r.mimeType !== 'image/webp' && r.mimeType !== 'image/jpeg') return false;
  if (!r.fullBlob || typeof (r.fullBlob as Blob).size !== 'number') return false;
  if (!r.thumbnailBlob || typeof (r.thumbnailBlob as Blob).size !== 'number') return false;
  return true;
}

export async function getStoredPhoto(photoId: string): Promise<StoredPhotoRecord | null> {
  if (!photoId) return null;
  const db = await openVisitDb();
  if (!db) return null;
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE_PHOTOS, 'readonly');
      const timer = setTimeout(() => {
        try {
          tx.abort();
        } catch {
          // ended
        }
        reject(new Error('photo read timeout'));
      }, IDB_TIMEOUT_MS);
      const req = tx.objectStore(STORE_PHOTOS).get(photoId);
      req.onsuccess = () => {
        clearTimeout(timer);
        resolve(req.result);
      };
      req.onerror = () => {
        clearTimeout(timer);
        reject(new Error('photo read error'));
      };
      tx.onabort = () => {
        clearTimeout(timer);
        reject(new Error('photo read abort'));
      };
    });

    if (!isValidStoredPhotoRecord(result)) return null;
    diagnostic({
      operation: 'photo-read',
      backend: 'idb',
      outcome: 'hit',
      bytes: result.fullBlob.size + result.thumbnailBlob.size,
    });
    return result;
  } catch {
    diagnostic({
      operation: 'photo-read',
      backend: 'idb',
      outcome: 'failure',
      error: 'storage-unavailable',
    });
    return null;
  } finally {
    db.close?.();
  }
}

export async function hasStoredPhoto(photoId: string): Promise<boolean> {
  if (!photoId) return false;
  const db = await openVisitDb();
  if (!db) return false;
  try {
    return await new Promise<boolean>((resolve) => {
      const tx = db.transaction(STORE_PHOTOS, 'readonly');
      const timer = setTimeout(() => {
        try {
          tx.abort();
        } catch {
          // ended
        }
        resolve(false);
      }, IDB_TIMEOUT_MS);
      const req = tx.objectStore(STORE_PHOTOS).count(photoId);
      req.onsuccess = () => {
        clearTimeout(timer);
        resolve((req.result ?? 0) > 0);
      };
      req.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
      tx.onabort = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
  } catch {
    return false;
  } finally {
    db.close?.();
  }
}

export async function getStoredPhotoIds(): Promise<Set<string>> {
  const db = await openVisitDb();
  if (!db) return new Set();
  try {
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const tx = db.transaction(STORE_PHOTOS, 'readonly');
      const req = tx.objectStore(STORE_PHOTOS).getAllKeys();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error ?? new Error('getAllKeys failed'));
    });
    return new Set(keys.filter((k): k is string => typeof k === 'string'));
  } catch {
    return new Set();
  } finally {
    db.close?.();
  }
}

export function putStoredPhotosInTx(tx: IDBTransaction, records: StoredPhotoRecord[]): void {
  const store = tx.objectStore(STORE_PHOTOS);
  for (const record of records) {
    store.put(record, record.id);
  }
}

export async function putStoredPhoto(
  record: StoredPhotoRecord
): Promise<{ success: boolean; error?: ErrorKind; message?: string }> {
  const db = await openVisitDb();
  if (!db) {
    diagnostic({
      operation: 'photo-write',
      backend: 'idb',
      outcome: 'failure',
      error: 'storage-unavailable',
    });
    return {
      success: false,
      error: 'storage-unavailable',
      message: '写真の保存先データベースを開けませんでした。',
    };
  }
  try {
    let quotaExceeded = false;
    const ok = await new Promise<boolean>((resolve) => {
      const tx = db.transaction(STORE_PHOTOS, 'readwrite');
      const timer = setTimeout(() => {
        try {
          tx.abort();
        } catch {
          // ended
        }
      }, IDB_TIMEOUT_MS);
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
      tx.objectStore(STORE_PHOTOS).put(record, record.id);
    });

    if (!ok) {
      diagnostic({
        operation: 'photo-write',
        backend: 'idb',
        outcome: 'failure',
        error: quotaExceeded ? 'quota' : 'storage-unavailable',
      });
      return {
        success: false,
        error: quotaExceeded ? 'quota' : 'storage-unavailable',
        message: quotaExceeded
          ? '端末の保存容量が不足しているため写真を保存できませんでした。'
          : '写真のローカル保存に失敗しました。',
      };
    }

    diagnostic({
      operation: 'photo-write',
      backend: 'idb',
      outcome: 'success',
      bytes: record.fullBlob.size + record.thumbnailBlob.size,
      count: 1,
    });
    return { success: true };
  } finally {
    db.close?.();
  }
}

export async function pruneOrphanPhotosInDb(
  db: IDBDatabase,
  referencedIds: Set<string>
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction(STORE_PHOTOS, 'readwrite');
    const store = tx.objectStore(STORE_PHOTOS);
    let deletedCount = 0;

    tx.oncomplete = () => resolve(deletedCount);
    tx.onerror = () => reject(tx.error ?? new Error('prune failed'));
    tx.onabort = () => reject(tx.error ?? new Error('prune aborted'));

    const keysReq = store.getAllKeys();
    keysReq.onsuccess = () => {
      const keys = keysReq.result ?? [];
      for (const key of keys) {
        if (typeof key === 'string' && !referencedIds.has(key)) {
          store.delete(key);
          deletedCount++;
        }
      }
    };
  });
}

export async function pruneOrphanPhotos(referencedIds: Set<string>): Promise<number> {
  const db = await openVisitDb();
  if (!db) return 0;
  try {
    return await pruneOrphanPhotosInDb(db, referencedIds);
  } catch {
    return 0;
  } finally {
    db.close?.();
  }
}

export async function getPhotoStorageStats(): Promise<PhotoStorageStats> {
  let originUsageBytes: number | null = null;
  let originQuotaBytes: number | null = null;

  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      if (typeof est.usage === 'number' && Number.isFinite(est.usage)) {
        originUsageBytes = est.usage;
      }
      if (typeof est.quota === 'number' && Number.isFinite(est.quota)) {
        originQuotaBytes = est.quota;
      }
    }
  } catch {
    // ignore storage estimate error
  }

  const db = await openVisitDb();
  if (!db) {
    return { photoCount: 0, totalBytes: 0, originUsageBytes, originQuotaBytes };
  }

  try {
    const { photoCount, totalBytes } = await new Promise<{ photoCount: number; totalBytes: number }>(
      (resolve, reject) => {
        const tx = db.transaction(STORE_PHOTOS, 'readonly');
        const store = tx.objectStore(STORE_PHOTOS);
        let count = 0;
        let bytes = 0;

        tx.oncomplete = () => resolve({ photoCount: count, totalBytes: bytes });
        tx.onerror = () => reject(tx.error ?? new Error('stats failed'));
        tx.onabort = () => reject(tx.error ?? new Error('stats aborted'));

        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          const val = cursor.value as Partial<StoredPhotoRecord> | undefined;
          if (val) {
            count++;
            const fullSize =
              val.fullBlob && typeof val.fullBlob.size === 'number'
                ? val.fullBlob.size
                : typeof val.bytes === 'number'
                  ? val.bytes
                  : 0;
            const thumbSize =
              val.thumbnailBlob && typeof val.thumbnailBlob.size === 'number'
                ? val.thumbnailBlob.size
                : 0;
            bytes += fullSize + thumbSize;
          }
          cursor.continue();
        };
      }
    );

    return { photoCount, totalBytes, originUsageBytes, originQuotaBytes };
  } catch {
    return { photoCount: 0, totalBytes: 0, originUsageBytes, originQuotaBytes };
  } finally {
    db.close?.();
  }
}
