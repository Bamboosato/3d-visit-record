import { abortableDelay, bounded } from './asyncLifecycle';
import { diagnostic } from './diagnostics';
import { clearMemoryToken, requestDriveAccessToken } from './googleAuth';
import { buildBackupEnvelope, parseBackupJson } from './visitMerge';
import type { DriveSyncMeta, PhotoAttachment, VisitSpot } from '../types/visit';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

export const DRIVE_APP_PROPERTY_KEY = '3d-visit-record';
export const DRIVE_ROOT_FOLDER_NAME = '3D Visit Record';
export const DRIVE_RECORDS_FILE_NAME = 'visit-records.json';
export const DRIVE_SNAPSHOTS_FOLDER_NAME = 'snapshots';
export const DRIVE_PHOTOS_FOLDER_NAME = 'photos';
export const MAX_DRIVE_SNAPSHOTS = 5;
const PHOTO_TRANSFER_TIMEOUT_MS = 30000;

export type DriveErrorKind =
  | 'auth'
  | 'quota'
  | 'not-found'
  | 'rate-limit'
  | 'network'
  | 'invalid-data'
  | 'http';

export class DriveApiError extends Error {
  kind: DriveErrorKind;
  status?: number;
  constructor(kind: DriveErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'DriveApiError';
    this.kind = kind;
    this.status = status;
  }
}

export interface DriveUserInfo {
  displayName?: string;
  emailAddress?: string;
  photoLink?: string;
}

export interface DriveFileMeta {
  id: string;
  name: string;
  modifiedTime: string;
  headRevisionId?: string;
  size?: string;
  trashed?: boolean;
  appProperties?: Record<string, string>;
}

export interface RemoteInspectionResult {
  folderId: string | null;
  file: DriveFileMeta | null;
}

export type SaveToDriveResult =
  | {
      outcome: 'saved';
      folderId: string;
      fileId: string;
      modifiedTime: string;
      headRevisionId: string | null;
      revision: number;
      syncedAt: string;
    }
  | {
      outcome: 'conflict';
      folderId: string;
      remoteFile: DriveFileMeta;
      reason: 'remote-newer' | 'remote-exists-unlinked';
    };

async function driveFetchWithRetry(
  url: string,
  init: RequestInit,
  accessToken: string,
  timeoutMs = 15000,
  signal?: AbortSignal
): Promise<Response> {
  let token = accessToken;
  let refreshedAuth = false;

  for (let attempt = 0; attempt <= 2; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);

    let res: Response;
    try {
      res = await bounded(
        fetch(url, { ...init, headers, signal: controller.signal }),
        timeoutMs,
        controller.signal
      );
    } catch (err) {
      controller.abort();
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw err instanceof Error ? err : new DOMException('Aborted', 'AbortError');
      }
      if (attempt < 2) {
        await abortableDelay(300 * (attempt + 1), signal);
        continue;
      }
      throw new DriveApiError(
        'network',
        'Google Drive への接続に失敗しました。通信環境をご確認ください。'
      );
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    if (res.status === 401 && !refreshedAuth) {
      refreshedAuth = true;
      clearMemoryToken();
      try {
        token = await requestDriveAccessToken({ prompt: '', forceRefresh: true });
        continue;
      } catch {
        throw new DriveApiError(
          'auth',
          'Google 認証の有効期限が切れました。再度サインインしてください。',
          401
        );
      }
    }

    if (res.status === 401) {
      clearMemoryToken();
      throw new DriveApiError(
        'auth',
        'Google 認証が必要です。再度サインインしてください。',
        401
      );
    }

    if (res.status === 404) {
      throw new DriveApiError(
        'not-found',
        'Google Drive 上の対象ファイルまたはフォルダが見つかりませんでした。',
        404
      );
    }

    if (res.status === 403) {
      let reason = '';
      try {
        const body = (await res.clone().json()) as {
          error?: { errors?: Array<{ reason?: string }>; message?: string };
        };
        reason = body?.error?.errors?.[0]?.reason ?? '';
      } catch {
        // ignore
      }
      if (reason === 'storageQuotaExceeded') {
        throw new DriveApiError(
          'quota',
          'Google Drive の空き容量が不足しています。ローカルデータは端末内に保持されています。',
          403
        );
      }
      throw new DriveApiError(
        'auth',
        'Google Drive へのアクセス権限がありません。',
        403
      );
    }

    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      const retryAfter = res.headers.get('Retry-After');
      const delayMs = retryAfter && Number.isFinite(Number(retryAfter))
        ? Math.min(Number(retryAfter) * 1000, 5000)
        : 400 * Math.pow(2, attempt);
      await abortableDelay(delayMs, signal);
      continue;
    }

    if (res.status === 429) {
      throw new DriveApiError(
        'rate-limit',
        'Google Drive API が混雑しています。しばらく待ってから再試行してください。',
        429
      );
    }

    if (!res.ok) {
      throw new DriveApiError(
        'http',
        `Google Drive API エラーが発生しました (HTTP ${res.status})。`,
        res.status
      );
    }

    return res;
  }

  throw new DriveApiError('network', 'Google Drive への通信に失敗しました。');
}

export async function fetchDriveUserInfo(accessToken: string): Promise<DriveUserInfo> {
  const url = `${DRIVE_API_BASE}/about?fields=${encodeURIComponent(
    'user(displayName,emailAddress,photoLink)'
  )}`;
  const res = await driveFetchWithRetry(url, { method: 'GET' }, accessToken);
  const data = (await res.json()) as { user?: DriveUserInfo };
  return data.user ?? {};
}

async function queryDriveFiles(
  accessToken: string,
  q: string,
  fields = 'files(id,name,modifiedTime,headRevisionId,size,trashed,appProperties)',
  orderBy?: string,
  signal?: AbortSignal
): Promise<DriveFileMeta[]> {
  const url = new URL(`${DRIVE_API_BASE}/files`);
  url.searchParams.set('q', q);
  url.searchParams.set('fields', fields);
  url.searchParams.set('spaces', 'drive');
  url.searchParams.set('pageSize', '20');
  if (orderBy) url.searchParams.set('orderBy', orderBy);

  const res = await driveFetchWithRetry(url.toString(), { method: 'GET' }, accessToken, 15000, signal);
  const data = (await res.json()) as { files?: DriveFileMeta[] };
  return data.files ?? [];
}

export async function listAllDriveFilesByQuery(
  accessToken: string,
  q: string,
  fields = 'files(id,name,modifiedTime,size,trashed,appProperties)',
  orderBy?: string,
  signal?: AbortSignal
): Promise<DriveFileMeta[]> {
  const normalizedFields = fields.includes('nextPageToken') ? fields : `nextPageToken,${fields}`;
  const all: DriveFileMeta[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 50; page++) {
    const url = new URL(`${DRIVE_API_BASE}/files`);
    url.searchParams.set('q', q);
    url.searchParams.set('fields', normalizedFields);
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('pageSize', '100');
    if (orderBy) url.searchParams.set('orderBy', orderBy);
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await driveFetchWithRetry(
      url.toString(),
      { method: 'GET' },
      accessToken,
      15000,
      signal
    );
    const data = (await res.json()) as { files?: DriveFileMeta[]; nextPageToken?: string };
    if (Array.isArray(data.files)) {
      all.push(...data.files);
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return all;
}

async function getDriveFileMeta(
  accessToken: string,
  fileId: string,
  signal?: AbortSignal
): Promise<DriveFileMeta | null> {
  try {
    const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(
      fileId
    )}?fields=${encodeURIComponent('id,name,modifiedTime,headRevisionId,size,trashed,appProperties')}`;
    const res = await driveFetchWithRetry(url, { method: 'GET' }, accessToken, 15000, signal);
    const meta = (await res.json()) as DriveFileMeta;
    if (meta.trashed) return null;
    return meta;
  } catch (err) {
    if (err instanceof DriveApiError && err.kind === 'not-found') return null;
    throw err;
  }
}

async function createDriveFolder(
  accessToken: string,
  name: string,
  role: string,
  parentId?: string,
  signal?: AbortSignal
): Promise<string> {
  const metadata: Record<string, unknown> = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    appProperties: {
      app: DRIVE_APP_PROPERTY_KEY,
      role,
    },
  };
  if (parentId) metadata.parents = [parentId];

  const res = await driveFetchWithRetry(
    `${DRIVE_API_BASE}/files?fields=id`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(metadata),
    },
    accessToken,
    15000,
    signal
  );
  const created = (await res.json()) as { id: string };
  return created.id;
}

async function findRootFolderId(
  accessToken: string,
  knownFolderId?: string | null,
  signal?: AbortSignal
): Promise<string | null> {
  if (knownFolderId) {
    const meta = await getDriveFileMeta(accessToken, knownFolderId, signal);
    if (meta) return meta.id;
  }
  const files = await queryDriveFiles(
    accessToken,
    `trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='app' and value='${DRIVE_APP_PROPERTY_KEY}' } and appProperties has { key='role' and value='root' }`,
    'files(id,name,modifiedTime)',
    undefined,
    signal
  );
  return files[0]?.id ?? null;
}

export async function ensureRootFolderId(
  accessToken: string,
  knownFolderId?: string | null,
  signal?: AbortSignal
): Promise<string> {
  const existing = await findRootFolderId(accessToken, knownFolderId, signal);
  if (existing) return existing;
  return createDriveFolder(accessToken, DRIVE_ROOT_FOLDER_NAME, 'root', undefined, signal);
}

export async function findPhotosFolderId(
  accessToken: string,
  rootFolderId: string,
  knownPhotosFolderId?: string | null,
  signal?: AbortSignal
): Promise<string | null> {
  if (knownPhotosFolderId) {
    const meta = await getDriveFileMeta(accessToken, knownPhotosFolderId, signal);
    if (meta) return meta.id;
  }
  const files = await queryDriveFiles(
    accessToken,
    `trashed = false and '${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='app' and value='${DRIVE_APP_PROPERTY_KEY}' } and appProperties has { key='role' and value='photos' }`,
    'files(id,name)',
    undefined,
    signal
  );
  return files[0]?.id ?? null;
}

export async function ensurePhotosFolderId(
  accessToken: string,
  rootFolderId: string,
  knownPhotosFolderId?: string | null,
  signal?: AbortSignal
): Promise<string> {
  const existing = await findPhotosFolderId(accessToken, rootFolderId, knownPhotosFolderId, signal);
  if (existing) return existing;
  return createDriveFolder(accessToken, DRIVE_PHOTOS_FOLDER_NAME, 'photos', rootFolderId, signal);
}

export async function listRemotePhotos(
  accessToken: string,
  photosFolderId: string,
  signal?: AbortSignal
): Promise<DriveFileMeta[]> {
  return listAllDriveFilesByQuery(
    accessToken,
    `trashed = false and '${photosFolderId}' in parents and appProperties has { key='app' and value='${DRIVE_APP_PROPERTY_KEY}' } and appProperties has { key='role' and value='photo' }`,
    'files(id,name,modifiedTime,size,trashed,appProperties)',
    undefined,
    signal
  );
}

export async function uploadPhotoToDrive(options: {
  accessToken: string;
  photosFolderId: string;
  photo: PhotoAttachment;
  blob: Blob;
  signal?: AbortSignal;
}): Promise<DriveFileMeta> {
  const { accessToken, photosFolderId, photo, blob, signal } = options;
  const boundary = `visit3d_photo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const appProperties: Record<string, string> = {
    app: DRIVE_APP_PROPERTY_KEY,
    role: 'photo',
    photoId: photo.id,
  };
  if (photo.checksumSha256) {
    appProperties.checksumSha256 = photo.checksumSha256;
  }

  const metadata = {
    name: photo.fileName,
    mimeType: photo.mimeType,
    parents: [photosFolderId],
    appProperties,
  };

  const metaPart = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${photo.mimeType}`,
    '',
    '',
  ].join('\r\n');
  const closingPart = `\r\n--${boundary}--`;
  const body = new Blob([metaPart, blob, closingPart]);

  const res = await driveFetchWithRetry(
    `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,modifiedTime,size,appProperties`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    },
    accessToken,
    PHOTO_TRANSFER_TIMEOUT_MS,
    signal
  );
  return (await res.json()) as DriveFileMeta;
}

export async function downloadDrivePhotoBlob(
  accessToken: string,
  fileId: string,
  signal?: AbortSignal
): Promise<Blob> {
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`;
  const res = await driveFetchWithRetry(
    url,
    { method: 'GET' },
    accessToken,
    PHOTO_TRANSFER_TIMEOUT_MS,
    signal
  );
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('application/json')) {
    throw new DriveApiError('invalid-data', 'Drive から取得した写真データの形式が不正です。');
  }
  const blob = await res.blob();
  if (!blob || blob.size <= 0) {
    throw new DriveApiError('invalid-data', 'Drive から空の写真データが返されました。');
  }
  return blob;
}

export async function trashDriveFile(
  accessToken: string,
  fileId: string,
  signal?: AbortSignal
): Promise<void> {
  try {
    await driveFetchWithRetry(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=id,trashed`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ trashed: true }),
      },
      accessToken,
      15000,
      signal
    );
  } catch (err) {
    if (err instanceof DriveApiError && err.kind === 'not-found') {
      return;
    }
    throw err;
  }
}

async function ensureSnapshotsFolderId(
  accessToken: string,
  rootFolderId: string
): Promise<string> {
  const files = await queryDriveFiles(
    accessToken,
    `trashed = false and '${rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='app' and value='${DRIVE_APP_PROPERTY_KEY}' } and appProperties has { key='role' and value='snapshots' }`,
    'files(id,name)'
  );
  if (files[0]?.id) return files[0].id;
  return createDriveFolder(accessToken, DRIVE_SNAPSHOTS_FOLDER_NAME, 'snapshots', rootFolderId);
}

export async function inspectRemoteRecords(
  accessToken: string,
  syncMeta?: Partial<DriveSyncMeta>,
  signal?: AbortSignal
): Promise<RemoteInspectionResult> {
  const folderId = await findRootFolderId(accessToken, syncMeta?.folderId, signal);

  if (syncMeta?.fileId) {
    const meta = await getDriveFileMeta(accessToken, syncMeta.fileId, signal);
    if (meta) {
      return { folderId, file: meta };
    }
  }

  const parentFilter = folderId ? `'${folderId}' in parents and ` : '';
  const files = await queryDriveFiles(
    accessToken,
    `trashed = false and ${parentFilter}appProperties has { key='app' and value='${DRIVE_APP_PROPERTY_KEY}' } and appProperties has { key='role' and value='records' }`,
    'files(id,name,modifiedTime,headRevisionId,size,trashed,appProperties)',
    'modifiedTime desc',
    signal
  );

  return { folderId, file: files[0] ?? null };
}

export function detectRemoteConflict(
  remoteFile: DriveFileMeta | null,
  syncMeta: DriveSyncMeta
): 'remote-exists-unlinked' | 'remote-newer' | null {
  if (!remoteFile) return null;
  if (!syncMeta.lastDriveModifiedTime) {
    return 'remote-exists-unlinked';
  }
  const modifiedChanged = remoteFile.modifiedTime !== syncMeta.lastDriveModifiedTime;
  const revChanged =
    Boolean(remoteFile.headRevisionId) &&
    Boolean(syncMeta.lastDriveHeadRevisionId) &&
    remoteFile.headRevisionId !== syncMeta.lastDriveHeadRevisionId;
  return modifiedChanged || revChanged ? 'remote-newer' : null;
}

export async function downloadRemoteRecords(
  accessToken: string,
  fileId: string
): Promise<{ items: VisitSpot[]; revision?: number; photoSyncVersion?: number; meta: DriveFileMeta }> {
  const meta = await getDriveFileMeta(accessToken, fileId);
  if (!meta) {
    throw new DriveApiError(
      'not-found',
      'Google Drive 上に保存ファイルが見つかりませんでした。',
      404
    );
  }
  const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`;
  const res = await driveFetchWithRetry(url, { method: 'GET' }, accessToken);
  const text = await res.text();
  try {
    const parsed = parseBackupJson(text);
    diagnostic({
      operation: 'drive-sync',
      backend: 'drive',
      outcome: 'success',
      count: parsed.items.length,
    });
    return {
      items: parsed.items,
      revision: parsed.revision,
      photoSyncVersion: parsed.photoSyncVersion,
      meta,
    };
  } catch (err) {
    diagnostic({
      operation: 'drive-sync',
      backend: 'drive',
      outcome: 'failure',
      error: 'invalid-data',
    });
    throw new DriveApiError(
      'invalid-data',
      err instanceof Error ? err.message : 'Drive 上のデータ形式が不正です。'
    );
  }
}

function buildMultipartBody(
  metadata: Record<string, unknown>,
  jsonContent: string
): { contentType: string; body: string } {
  const boundary = `visit3d_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    jsonContent,
    `--${boundary}--`,
  ].join('\r\n');

  return {
    contentType: `multipart/related; boundary=${boundary}`,
    body,
  };
}

function buildSnapshotFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `visit-records-${stamp}.json`;
}

async function createSnapshotAndPrune(
  accessToken: string,
  rootFolderId: string,
  sourceFileId: string
): Promise<void> {
  try {
    const snapshotsFolderId = await ensureSnapshotsFolderId(accessToken, rootFolderId);
    await driveFetchWithRetry(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(sourceFileId)}/copy?fields=id`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({
          name: buildSnapshotFileName(),
          parents: [snapshotsFolderId],
          appProperties: {
            app: DRIVE_APP_PROPERTY_KEY,
            role: 'snapshot',
          },
        }),
      },
      accessToken
    );

    const snapshots = await queryDriveFiles(
      accessToken,
      `trashed = false and '${snapshotsFolderId}' in parents and appProperties has { key='app' and value='${DRIVE_APP_PROPERTY_KEY}' } and appProperties has { key='role' and value='snapshot' }`,
      'files(id,name,createdTime,modifiedTime)',
      'createdTime desc'
    );

    const toDelete = snapshots.slice(MAX_DRIVE_SNAPSHOTS);
    for (const old of toDelete) {
      await driveFetchWithRetry(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(old.id)}`,
        { method: 'DELETE' },
        accessToken
      ).catch(() => {});
    }
  } catch {
    // スナップショット退避の失敗で本体保存を妨げない
  }
}

export async function saveToGoogleDrive(options: {
  accessToken: string;
  spots: VisitSpot[];
  revision: number;
  syncMeta: DriveSyncMeta;
  forceOverwrite?: boolean;
  signal?: AbortSignal;
}): Promise<SaveToDriveResult> {
  const { accessToken, spots, revision, syncMeta, forceOverwrite = false, signal } = options;
  const inspection = await inspectRemoteRecords(accessToken, syncMeta, signal);
  const folderId =
    inspection.folderId ?? (await ensureRootFolderId(accessToken, syncMeta.folderId, signal));
  const remoteFile = inspection.file;

  if (remoteFile && !forceOverwrite) {
    const conflictReason = detectRemoteConflict(remoteFile, syncMeta);
    if (conflictReason) {
      return {
        outcome: 'conflict',
        folderId,
        remoteFile,
        reason: conflictReason,
      };
    }
  }

  const envelope = buildBackupEnvelope(spots, revision);
  const jsonContent = JSON.stringify(envelope, null, 2);

  let savedMeta: DriveFileMeta;
  if (remoteFile) {
    await createSnapshotAndPrune(accessToken, folderId, remoteFile.id);
    const { contentType, body } = buildMultipartBody(
      {
        name: DRIVE_RECORDS_FILE_NAME,
        appProperties: {
          app: DRIVE_APP_PROPERTY_KEY,
          role: 'records',
          schemaVersion: '1',
        },
      },
      jsonContent
    );
    const res = await driveFetchWithRetry(
      `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(
        remoteFile.id
      )}?uploadType=multipart&fields=id,name,modifiedTime,headRevisionId,size`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': contentType },
        body,
      },
      accessToken,
      15000,
      signal
    );
    savedMeta = (await res.json()) as DriveFileMeta;
  } else {
    const { contentType, body } = buildMultipartBody(
      {
        name: DRIVE_RECORDS_FILE_NAME,
        mimeType: 'application/json',
        parents: [folderId],
        appProperties: {
          app: DRIVE_APP_PROPERTY_KEY,
          role: 'records',
          schemaVersion: '1',
        },
      },
      jsonContent
    );
    const res = await driveFetchWithRetry(
      `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,modifiedTime,headRevisionId,size`,
      {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body,
      },
      accessToken,
      15000,
      signal
    );
    savedMeta = (await res.json()) as DriveFileMeta;
  }

  diagnostic({
    operation: 'drive-sync',
    backend: 'drive',
    outcome: 'success',
    count: spots.length,
  });

  return {
    outcome: 'saved',
    folderId,
    fileId: savedMeta.id,
    modifiedTime: savedMeta.modifiedTime,
    headRevisionId: savedMeta.headRevisionId ?? null,
    revision,
    syncedAt: new Date().toISOString(),
  };
}
