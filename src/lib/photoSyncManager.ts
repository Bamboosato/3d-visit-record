import type { DriveSyncMeta, PhotoAttachment, PhotoMimeType, StoredPhotoRecord, VisitSpot } from '../types/visit';
import { diagnostic } from './diagnostics';
import { hasActiveMemoryToken, requestDriveAccessToken } from './googleAuth';
import {
  detectRemoteConflict,
  DriveApiError,
  downloadDrivePhotoBlob,
  ensurePhotosFolderId,
  ensureRootFolderId,
  findPhotosFolderId,
  inspectRemoteRecords,
  listRemotePhotos,
  saveToGoogleDrive,
  trashDriveFile,
  uploadPhotoToDrive,
  type DriveFileMeta,
} from './googleDriveClient';
import { generateThumbnailFromBlob } from './photoProcessor';
import {
  getStoredPhoto,
  getStoredPhotoIds,
  hasStoredPhoto,
  putStoredPhoto,
} from './photoStorage';
import { invalidatePhotoUrl } from './photoUrlCache';
import { cloneSpots } from './spotDomain';

const PHOTO_SYNC_CONCURRENCY = 3;

const inFlightDownloads = new Map<string, Promise<EnsurePhotoCachedResult>>();
const missingRemotePhotoIds = new Set<string>();

export function isRemotePhotoKnownMissing(photoId: string): boolean {
  return missingRemotePhotoIds.has(photoId);
}

export function resetPhotoSyncStateForTesting(): void {
  inFlightDownloads.clear();
  missingRemotePhotoIds.clear();
}

export type PhotoSyncProgress =
  | { phase: 'checking' }
  | { phase: 'uploading-photos'; completed: number; total: number }
  | { phase: 'saving-records' }
  | { phase: 'cleaning-photos'; completed: number; total: number };

export interface SaveWithPhotosOptions {
  accessToken: string;
  spots: VisitSpot[];
  revision: number;
  syncMeta: DriveSyncMeta;
  forceOverwrite?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: PhotoSyncProgress) => void;
  onPhotoUploaded?: (photoId: string, driveFileId: string) => Promise<void> | void;
}

export type SaveWithPhotosResult =
  | {
      outcome: 'saved';
      folderId: string;
      photosFolderId: string | null;
      fileId: string;
      modifiedTime: string;
      headRevisionId: string | null;
      revision: number;
      syncedAt: string;
      uploadedPhotoCount: number;
      reusedPhotoCount: number;
      trashedPhotoCount: number;
    }
  | {
      outcome: 'conflict';
      folderId: string | null;
      remoteFile: DriveFileMeta;
      reason: 'remote-exists-unlinked' | 'remote-newer';
    };

export interface EnsurePhotoCachedOptions {
  interactiveAuth?: boolean;
  signal?: AbortSignal;
  accessToken?: string;
  generateThumbnail?: (fullBlob: Blob, mimeType: PhotoMimeType) => Promise<Blob>;
}

export type EnsurePhotoCachedResult =
  | { status: 'cached' }
  | { status: 'downloaded'; record: StoredPhotoRecord }
  | { status: 'needs-auth' }
  | { status: 'offline' }
  | { status: 'missing-remote' }
  | { status: 'error'; error: string; quotaExceeded?: boolean };

export interface MissingRemotePhotosSummary {
  photos: PhotoAttachment[];
  totalBytes: number;
}

export interface BulkDownloadResult {
  total: number;
  downloaded: number;
  skipped: number;
  failed: number;
  aborted: boolean;
  quotaExceeded: boolean;
  errorMessage?: string;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  if (items.length === 0) return;
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);

  const runners = Array.from({ length: workerCount }, async () => {
    while (true) {
      if (signal?.aborted) return;
      const idx = nextIndex++;
      if (idx >= items.length) return;
      await worker(items[idx], idx);
    }
  });

  await Promise.all(runners);
}

function collectUniquePhotos(spots: VisitSpot[]): PhotoAttachment[] {
  const seen = new Set<string>();
  const list: PhotoAttachment[] = [];
  for (const spot of spots) {
    for (const entry of spot.entries) {
      for (const photo of entry.photos) {
        if (!seen.has(photo.id)) {
          seen.add(photo.id);
          list.push(photo);
        }
      }
    }
  }
  return list;
}

function applyResolvedDriveIds(
  spots: VisitSpot[],
  resolved: Map<string, string>
): VisitSpot[] {
  if (resolved.size === 0) return spots;
  return spots.map((spot) => ({
    ...spot,
    entries: spot.entries.map((entry) => ({
      ...entry,
      photos: entry.photos.map((photo) => {
        const driveId = resolved.get(photo.id);
        return driveId ? { ...photo, driveFileId: driveId } : photo;
      }),
    })),
  }));
}

export async function saveWithPhotosToGoogleDrive(
  options: SaveWithPhotosOptions
): Promise<SaveWithPhotosResult> {
  const {
    accessToken,
    spots,
    revision,
    syncMeta,
    forceOverwrite = false,
    signal,
    onProgress,
    onPhotoUploaded,
  } = options;

  onProgress?.({ phase: 'checking' });

  // Phase 1: 競合検知先行（競合時は写真をアップロードもゴミ箱移動もしない）
  const inspection = await inspectRemoteRecords(accessToken, syncMeta, signal);
  if (inspection.file && !forceOverwrite) {
    const conflictReason = detectRemoteConflict(inspection.file, syncMeta);
    if (conflictReason) {
      return {
        outcome: 'conflict',
        folderId: inspection.folderId,
        remoteFile: inspection.file,
        reason: conflictReason,
      };
    }
  }

  const allPhotos = collectUniquePhotos(spots);
  const pendingPhotos = allPhotos.filter((p) => !p.driveFileId);

  // Phase 2: photos/ フォルダ確認 & 既存ファイルインデックス取得
  let rootFolderId = inspection.folderId;
  if (!rootFolderId && pendingPhotos.length > 0) {
    rootFolderId = await ensureRootFolderId(accessToken, syncMeta.folderId, signal);
  }

  let photosFolderId: string | null = null;
  let remotePhotos: DriveFileMeta[] = [];
  const byChecksum = new Map<string, DriveFileMeta>();
  const byPhotoId = new Map<string, DriveFileMeta>();

  if (rootFolderId) {
    photosFolderId =
      pendingPhotos.length > 0
        ? await ensurePhotosFolderId(accessToken, rootFolderId, syncMeta.photosFolderId, signal)
        : await findPhotosFolderId(accessToken, rootFolderId, syncMeta.photosFolderId, signal);

    if (photosFolderId) {
      remotePhotos = await listRemotePhotos(accessToken, photosFolderId, signal);
      for (const file of remotePhotos) {
        const pId = file.appProperties?.photoId;
        const sha = file.appProperties?.checksumSha256;
        if (pId && !byPhotoId.has(pId)) byPhotoId.set(pId, file);
        if (sha && !byChecksum.has(sha)) byChecksum.set(sha, file);
      }
    }
  }

  // Phase 3: 未アップロード写真の並列アップロード（上限3・重複再利用・1枚毎レジューム）
  const resolvedDriveIds = new Map<string, string>();
  let uploadedPhotoCount = 0;
  let reusedPhotoCount = 0;

  if (pendingPhotos.length > 0) {
    if (!rootFolderId) {
      rootFolderId = await ensureRootFolderId(accessToken, syncMeta.folderId, signal);
    }
    if (!photosFolderId) {
      photosFolderId = await ensurePhotosFolderId(
        accessToken,
        rootFolderId,
        syncMeta.photosFolderId,
        signal
      );
    }

    onProgress?.({ phase: 'uploading-photos', completed: 0, total: pendingPhotos.length });

    let completed = 0;
    let firstError: unknown = null;

    await runWithConcurrency(
      pendingPhotos,
      PHOTO_SYNC_CONCURRENCY,
      async (photo) => {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        try {
          const matched =
            byPhotoId.get(photo.id) ??
            (photo.checksumSha256 ? byChecksum.get(photo.checksumSha256) : undefined);

          let driveId: string;
          if (matched) {
            driveId = matched.id;
            reusedPhotoCount++;
          } else {
            const stored = await getStoredPhoto(photo.id);
            if (!stored) {
              throw new DriveApiError(
                'invalid-data',
                `写真「${photo.fileName}」のデータが端末に存在しないためアップロードできませんでした。`
              );
            }
            let uploadedMeta: DriveFileMeta;
            try {
              uploadedMeta = await uploadPhotoToDrive({
                accessToken,
                photosFolderId: photosFolderId!,
                photo,
                blob: stored.fullBlob,
                signal,
              });
            } catch (err) {
              if (err instanceof DriveApiError && err.kind === 'not-found') {
                // キャッシュされた photosFolderId が削除されていた場合は再作成して 1 回リトライ
                photosFolderId = await ensurePhotosFolderId(
                  accessToken,
                  rootFolderId!,
                  null,
                  signal
                );
                uploadedMeta = await uploadPhotoToDrive({
                  accessToken,
                  photosFolderId,
                  photo,
                  blob: stored.fullBlob,
                  signal,
                });
              } else {
                throw err;
              }
            }
            driveId = uploadedMeta.id;
            uploadedPhotoCount++;
          }

          resolvedDriveIds.set(photo.id, driveId);
          await onPhotoUploaded?.(photo.id, driveId);
          completed++;
          onProgress?.({ phase: 'uploading-photos', completed, total: pendingPhotos.length });
        } catch (err) {
          if (!firstError) firstError = err;
        }
      },
      signal
    );

    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    if (firstError) {
      throw firstError;
    }
  }

  const workingSpots = applyResolvedDriveIds(cloneSpots(spots), resolvedDriveIds);

  // Phase 4: visit-records.json 保存（スナップショット退避付き）
  onProgress?.({ phase: 'saving-records' });

  const finalRootId =
    rootFolderId ?? (await ensureRootFolderId(accessToken, syncMeta.folderId, signal));

  const recordSaveResult = await saveToGoogleDrive({
    accessToken,
    spots: workingSpots,
    revision,
    syncMeta: {
      ...syncMeta,
      folderId: finalRootId,
      fileId: inspection.file?.id ?? syncMeta.fileId,
    },
    forceOverwrite: true,
    signal,
  });

  if (recordSaveResult.outcome !== 'saved') {
    return recordSaveResult;
  }

  // Phase 5: visit-records.json 保存成功後にのみ未参照 Drive 写真を自動ゴミ箱移動（非致命）
  let trashedPhotoCount = 0;
  if (photosFolderId && remotePhotos.length > 0 && !signal?.aborted) {
    const finalPhotos = collectUniquePhotos(workingSpots);
    const activeDriveIds = new Set<string>();
    const activePhotoIds = new Set<string>();
    for (const p of finalPhotos) {
      activePhotoIds.add(p.id);
      if (p.driveFileId) activeDriveIds.add(p.driveFileId);
    }

    const unreferenced = remotePhotos.filter((file) => {
      if (activeDriveIds.has(file.id)) return false;
      const filePhotoId = file.appProperties?.photoId;
      if (filePhotoId && activePhotoIds.has(filePhotoId)) return false;
      return true;
    });

    if (unreferenced.length > 0) {
      let cleaned = 0;
      onProgress?.({ phase: 'cleaning-photos', completed: 0, total: unreferenced.length });
      try {
        await runWithConcurrency(
          unreferenced,
          PHOTO_SYNC_CONCURRENCY,
          async (file) => {
            try {
              await trashDriveFile(accessToken, file.id, signal);
              trashedPhotoCount++;
            } catch {
              // ゴミ箱移動の一部失敗で保存全体の成功を妨げない
            } finally {
              cleaned++;
              onProgress?.({ phase: 'cleaning-photos', completed: cleaned, total: unreferenced.length });
            }
          },
          signal
        );
      } catch {
        // 非致命
      }
    }
  }

  diagnostic({
    operation: 'photo-sync',
    backend: 'drive',
    outcome: 'success',
    count: uploadedPhotoCount,
  });

  return {
    outcome: 'saved',
    folderId: recordSaveResult.folderId,
    photosFolderId,
    fileId: recordSaveResult.fileId,
    modifiedTime: recordSaveResult.modifiedTime,
    headRevisionId: recordSaveResult.headRevisionId,
    revision: recordSaveResult.revision,
    syncedAt: recordSaveResult.syncedAt,
    uploadedPhotoCount,
    reusedPhotoCount,
    trashedPhotoCount,
  };
}

export async function ensurePhotoCached(
  photo: PhotoAttachment,
  options: EnsurePhotoCachedOptions = {}
): Promise<EnsurePhotoCachedResult> {
  if (options.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  if (await hasStoredPhoto(photo.id)) {
    return { status: 'cached' };
  }

  if (!photo.driveFileId || missingRemotePhotoIds.has(photo.id)) {
    return { status: 'missing-remote' };
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { status: 'offline' };
  }

  let token = options.accessToken;
  if (!token) {
    if (!options.interactiveAuth && !hasActiveMemoryToken()) {
      return { status: 'needs-auth' };
    }
    try {
      token = await requestDriveAccessToken({ prompt: '' });
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : 'Google Drive への接続に失敗しました。',
      };
    }
  }

  const existingPromise = inFlightDownloads.get(photo.id);
  if (existingPromise) {
    return existingPromise;
  }

  const task = (async (): Promise<EnsurePhotoCachedResult> => {
    try {
      const fullBlob = await downloadDrivePhotoBlob(token, photo.driveFileId!, options.signal);
      const genThumb =
        options.generateThumbnail ?? ((b: Blob, m: PhotoMimeType) => generateThumbnailFromBlob(b, m));
      const thumbnailBlob = await genThumb(fullBlob, photo.mimeType);

      const now = new Date().toISOString();
      const record: StoredPhotoRecord = {
        id: photo.id,
        mimeType: photo.mimeType,
        width: photo.width,
        height: photo.height,
        bytes: fullBlob.size,
        fullBlob,
        thumbnailBlob,
        createdAt: now,
        updatedAt: now,
      };

      const putRes = await putStoredPhoto(record);
      if (!putRes.success) {
        return {
          status: 'error',
          error: putRes.message ?? '写真のローカルキャッシュに失敗しました。',
          quotaExceeded: putRes.error === 'quota',
        };
      }

      invalidatePhotoUrl(photo.id);
      diagnostic({
        operation: 'photo-read',
        backend: 'drive',
        outcome: 'success',
        bytes: fullBlob.size,
      });
      return { status: 'downloaded', record };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      if (err instanceof DriveApiError && err.kind === 'not-found') {
        missingRemotePhotoIds.add(photo.id);
        return { status: 'missing-remote' };
      }
      diagnostic({
        operation: 'photo-read',
        backend: 'drive',
        outcome: 'failure',
        error: err instanceof DriveApiError && err.kind === 'auth' ? 'auth' : 'network',
      });
      return {
        status: 'error',
        error: err instanceof Error ? err.message : '写真のダウンロードに失敗しました。',
      };
    }
  })().finally(() => {
    if (inFlightDownloads.get(photo.id) === task) {
      inFlightDownloads.delete(photo.id);
    }
  });

  inFlightDownloads.set(photo.id, task);
  return task;
}

export async function findMissingRemotePhotos(
  spots: VisitSpot[]
): Promise<MissingRemotePhotosSummary> {
  const all = collectUniquePhotos(spots);
  const storedIds = await getStoredPhotoIds();
  const photos = all.filter(
    (p) => Boolean(p.driveFileId) && !storedIds.has(p.id) && !missingRemotePhotoIds.has(p.id)
  );
  const totalBytes = photos.reduce((sum, p) => sum + p.bytes, 0);
  return { photos, totalBytes };
}

export async function downloadAllMissingPhotos(options: {
  spots: VisitSpot[];
  accessToken?: string;
  signal?: AbortSignal;
  onProgress?: (progress: { completed: number; total: number }) => void;
  onPhotoCached?: (photoId: string) => void;
  generateThumbnail?: (fullBlob: Blob, mimeType: PhotoMimeType) => Promise<Blob>;
}): Promise<BulkDownloadResult> {
  const { spots, signal, onProgress, onPhotoCached, generateThumbnail } = options;
  const { photos } = await findMissingRemotePhotos(spots);
  if (photos.length === 0) {
    return {
      total: 0,
      downloaded: 0,
      skipped: 0,
      failed: 0,
      aborted: false,
      quotaExceeded: false,
    };
  }

  const token = options.accessToken ?? (await requestDriveAccessToken({ prompt: '' }));
  const internalAbort = new AbortController();
  const onParentAbort = () => internalAbort.abort();
  signal?.addEventListener('abort', onParentAbort, { once: true });
  if (signal?.aborted) internalAbort.abort();

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let completed = 0;
  let quotaExceeded = false;
  let errorMessage: string | undefined;

  onProgress?.({ completed: 0, total: photos.length });

  try {
    await runWithConcurrency(
      photos,
      PHOTO_SYNC_CONCURRENCY,
      async (photo) => {
        if (internalAbort.signal.aborted) return;
        try {
          const res = await ensurePhotoCached(photo, {
            accessToken: token,
            interactiveAuth: true,
            signal: internalAbort.signal,
            generateThumbnail,
          });
          if (res.status === 'downloaded') {
            downloaded++;
            onPhotoCached?.(photo.id);
          } else if (res.status === 'cached' || res.status === 'missing-remote') {
            skipped++;
          } else if (res.status === 'error') {
            failed++;
            errorMessage = errorMessage ?? res.error;
            if (res.quotaExceeded) {
              quotaExceeded = true;
              internalAbort.abort();
            }
          } else {
            failed++;
          }
        } catch (err) {
          if (!(err instanceof Error && err.name === 'AbortError')) {
            failed++;
            errorMessage =
              errorMessage ?? (err instanceof Error ? err.message : '写真の取得に失敗しました。');
          }
        } finally {
          completed++;
          onProgress?.({ completed, total: photos.length });
        }
      },
      internalAbort.signal
    );
  } finally {
    signal?.removeEventListener('abort', onParentAbort);
  }

  return {
    total: photos.length,
    downloaded,
    skipped,
    failed,
    aborted: Boolean(signal?.aborted),
    quotaExceeded,
    errorMessage,
  };
}
