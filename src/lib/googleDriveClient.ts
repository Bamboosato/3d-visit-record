import { abortableDelay, bounded } from './asyncLifecycle';
import { diagnostic } from './diagnostics';
import { clearMemoryToken, requestDriveAccessToken } from './googleAuth';
import { buildBackupEnvelope, parseBackupJson } from './visitMerge';
import type { DriveSyncMeta, VisitSpot } from '../types/visit';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

export const DRIVE_APP_PROPERTY_KEY = '3d-visit-record';
export const DRIVE_ROOT_FOLDER_NAME = '3D Visit Record';
export const DRIVE_RECORDS_FILE_NAME = 'visit-records.json';
export const DRIVE_SNAPSHOTS_FOLDER_NAME = 'snapshots';
export const MAX_DRIVE_SNAPSHOTS = 5;

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
  timeoutMs = 15000
): Promise<Response> {
  let token = accessToken;
  let refreshedAuth = false;

  for (let attempt = 0; attempt <= 2; attempt++) {
    const controller = new AbortController();
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
      if (attempt < 2) {
        await abortableDelay(300 * (attempt + 1));
        continue;
      }
      throw new DriveApiError(
        'network',
        'Google Drive への接続に失敗しました。通信環境をご確認ください。'
      );
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
      await abortableDelay(delayMs);
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
  orderBy?: string
): Promise<DriveFileMeta[]> {
  const url = new URL(`${DRIVE_API_BASE}/files`);
  url.searchParams.set('q', q);
  url.searchParams.set('fields', fields);
  url.searchParams.set('spaces', 'drive');
  url.searchParams.set('pageSize', '20');
  if (orderBy) url.searchParams.set('orderBy', orderBy);

  const res = await driveFetchWithRetry(url.toString(), { method: 'GET' }, accessToken);
  const data = (await res.json()) as { files?: DriveFileMeta[] };
  return data.files ?? [];
}

async function getDriveFileMeta(
  accessToken: string,
  fileId: string
): Promise<DriveFileMeta | null> {
  try {
    const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(
      fileId
    )}?fields=${encodeURIComponent('id,name,modifiedTime,headRevisionId,size,trashed,appProperties')}`;
    const res = await driveFetchWithRetry(url, { method: 'GET' }, accessToken);
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
  parentId?: string
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
    accessToken
  );
  const created = (await res.json()) as { id: string };
  return created.id;
}

async function findRootFolderId(
  accessToken: string,
  knownFolderId?: string | null
): Promise<string | null> {
  if (knownFolderId) {
    const meta = await getDriveFileMeta(accessToken, knownFolderId);
    if (meta) return meta.id;
  }
  const files = await queryDriveFiles(
    accessToken,
    `trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='app' and value='${DRIVE_APP_PROPERTY_KEY}' } and appProperties has { key='role' and value='root' }`,
    'files(id,name,modifiedTime)'
  );
  return files[0]?.id ?? null;
}

async function ensureRootFolderId(
  accessToken: string,
  knownFolderId?: string | null
): Promise<string> {
  const existing = await findRootFolderId(accessToken, knownFolderId);
  if (existing) return existing;
  return createDriveFolder(accessToken, DRIVE_ROOT_FOLDER_NAME, 'root');
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
  syncMeta?: Partial<DriveSyncMeta>
): Promise<RemoteInspectionResult> {
  const folderId = await findRootFolderId(accessToken, syncMeta?.folderId);

  if (syncMeta?.fileId) {
    const meta = await getDriveFileMeta(accessToken, syncMeta.fileId);
    if (meta) {
      return { folderId, file: meta };
    }
  }

  const parentFilter = folderId ? `'${folderId}' in parents and ` : '';
  const files = await queryDriveFiles(
    accessToken,
    `trashed = false and ${parentFilter}appProperties has { key='app' and value='${DRIVE_APP_PROPERTY_KEY}' } and appProperties has { key='role' and value='records' }`,
    'files(id,name,modifiedTime,headRevisionId,size,trashed,appProperties)',
    'modifiedTime desc'
  );

  return { folderId, file: files[0] ?? null };
}

export async function downloadRemoteRecords(
  accessToken: string,
  fileId: string
): Promise<{ items: VisitSpot[]; revision?: number; meta: DriveFileMeta }> {
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
    return { items: parsed.items, revision: parsed.revision, meta };
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
}): Promise<SaveToDriveResult> {
  const { accessToken, spots, revision, syncMeta, forceOverwrite = false } = options;
  const inspection = await inspectRemoteRecords(accessToken, syncMeta);
  const folderId = inspection.folderId ?? (await ensureRootFolderId(accessToken, syncMeta.folderId));
  const remoteFile = inspection.file;

  if (remoteFile && !forceOverwrite) {
    if (!syncMeta.lastDriveModifiedTime) {
      return {
        outcome: 'conflict',
        folderId,
        remoteFile,
        reason: 'remote-exists-unlinked',
      };
    }
    const modifiedChanged = remoteFile.modifiedTime !== syncMeta.lastDriveModifiedTime;
    const revChanged =
      Boolean(remoteFile.headRevisionId) &&
      Boolean(syncMeta.lastDriveHeadRevisionId) &&
      remoteFile.headRevisionId !== syncMeta.lastDriveHeadRevisionId;
    if (modifiedChanged || revChanged) {
      return {
        outcome: 'conflict',
        folderId,
        remoteFile,
        reason: 'remote-newer',
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
      accessToken
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
      accessToken
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
