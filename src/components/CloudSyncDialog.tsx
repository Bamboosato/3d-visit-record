import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Cloud,
  CloudDownload,
  CloudUpload,
  Download,
  FileUp,
  Loader2,
  LogIn,
  LogOut,
  RotateCcw,
  X,
} from 'lucide-react';
import type {
  DriveSyncMeta,
  PhotoStorageStats,
  SpotStatus,
  UndoSnapshot,
  VisitSpot,
} from '../types/visit';
import {
  hasActiveMemoryToken,
  isGoogleAuthConfigured,
  requestDriveAccessToken,
  signOutGoogleDrive,
} from '../lib/googleAuth';
import {
  downloadRemoteRecords,
  fetchDriveUserInfo,
  inspectRemoteRecords,
  type DriveFileMeta,
} from '../lib/googleDriveClient';
import { getPhotoStorageStats } from '../lib/photoStorage';
import {
  downloadAllMissingPhotos,
  findMissingRemotePhotos,
  saveWithPhotosToGoogleDrive,
  type MissingRemotePhotosSummary,
  type PhotoSyncProgress,
} from '../lib/photoSyncManager';
import {
  detectBackupFormat,
  exportBackupJsonFile,
  parseBackupJson,
  previewMerge,
  VisitTransferError,
  type DetectedBackupFormat,
  type ImportMode,
} from '../lib/visitMerge';
import {
  isVisitStorageBlocked,
  readRawRecoveryData,
  type StorageOperationResult,
} from '../lib/visitStorage';
import { useUpdateBlocker } from '../lib/updateGuard';

interface CloudSyncDialogProps {
  isOpen: boolean;
  onClose: () => void;
  spots: VisitSpot[];
  revision: number;
  driveSync: DriveSyncMeta;
  undoSnapshot: UndoSnapshot | null;
  hasUnsavedDriveChanges: boolean;
  onUpdateDriveMeta: (patch: Partial<DriveSyncMeta>) => Promise<void>;
  onPhotoDriveIdsUpdated?: (updates: Record<string, string>) => Promise<void>;
  onPhotoCacheUpdated?: () => void;
  onApplyImportedSpots: (options: {
    nextSpots: VisitSpot[];
    reason: 'drive-restore' | 'json-import';
    driveSyncPatch?: Partial<DriveSyncMeta>;
  }) => Promise<StorageOperationResult>;
  onUndoLastRestore: () => Promise<StorageOperationResult>;
  onLocalExportRecorded: (iso: string) => Promise<void>;
  onOpenExport?: () => void;
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSyncProgressLabel(progress: PhotoSyncProgress): string {
  if (progress.phase === 'checking') return 'Google Drive の状態を確認中...';
  if (progress.phase === 'uploading-photos') {
    return `写真をアップロード中 (${progress.completed} / ${progress.total})...`;
  }
  if (progress.phase === 'saving-records') return '訪問記録データを保存中...';
  return `不要な旧写真をゴミ箱へ整理中 (${progress.completed} / ${progress.total})...`;
}

interface PendingImportState {
  sourceLabel: string;
  reason: 'drive-restore' | 'json-import';
  format: DetectedBackupFormat;
  rawText?: string;
  items: VisitSpot[];
  photoSyncVersion?: number;
  driveMeta?: { folderId: string | null; file: DriveFileMeta; revision?: number };
}

function formatDateTime(iso?: string | null): string {
  if (!iso) return '未実施';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '不明';
  return d.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const CloudSyncDialog: React.FC<CloudSyncDialogProps> = ({
  isOpen,
  onClose,
  spots,
  revision,
  driveSync,
  undoSnapshot,
  hasUnsavedDriveChanges,
  onUpdateDriveMeta,
  onPhotoDriveIdsUpdated,
  onPhotoCacheUpdated,
  onApplyImportedSpots,
  onUndoLastRestore,
  onLocalExportRecorded,
  onOpenExport,
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const syncAbortRef = useRef<AbortController | null>(null);

  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;

  const [isConnected, setIsConnected] = useState(() => hasActiveMemoryToken());
  const [statusMessage, setStatusMessage] = useState<{
    kind: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);
  const [syncProgressText, setSyncProgressText] = useState<string | null>(null);
  const [storageStats, setStorageStats] = useState<PhotoStorageStats | null>(null);
  const [missingPhotos, setMissingPhotos] = useState<MissingRemotePhotosSummary | null>(null);

  const [conflictState, setConflictState] = useState<{
    folderId: string | null;
    remoteFile: DriveFileMeta;
    reason: 'remote-newer' | 'remote-exists-unlinked';
  } | null>(null);

  const [pendingImport, setPendingImport] = useState<PendingImportState | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>('merge');
  const [rainImportStatus, setRainImportStatus] = useState<SpotStatus>('planned');

  useUpdateBlocker(isOpen);

  const authConfigured = isGoogleAuthConfigured();
  const storageBlocked = isVisitStorageBlocked();

  const refreshPhotoCacheSummary = async () => {
    try {
      const [stats, missing] = await Promise.all([
        getPhotoStorageStats(),
        findMissingRemotePhotos(spots),
      ]);
      setStorageStats(stats);
      setMissingPhotos(missing);
    } catch {
      // ignore summary refresh error
    }
  };

  useEffect(() => {
    if (!isOpen || busy) return;
    void refreshPhotoCacheSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, spots, busy]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      setIsConnected(hasActiveMemoryToken());
      setStatusMessage(null);
      setSyncProgressText(null);
      setConflictState(null);
      setPendingImport(null);
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      syncAbortRef.current?.abort();
      dialog.close();
    }
  }, [isOpen]);

  // Safari fallback for closedby="any": require both pointerdown & pointerup outside dialog rect
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !isOpen) return;
    if ('closedBy' in HTMLDialogElement.prototype) return;

    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };

    let pressedOutside = false;
    const onPointerDown = (e: PointerEvent) => {
      pressedOutside = !busyRef.current && isOutside(e);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (pressedOutside && !busyRef.current && isOutside(e)) {
        dialog.close('backdrop');
      }
      pressedOutside = false;
    };
    dialog.addEventListener('pointerdown', onPointerDown);
    dialog.addEventListener('pointerup', onPointerUp);
    return () => {
      dialog.removeEventListener('pointerdown', onPointerDown);
      dialog.removeEventListener('pointerup', onPointerUp);
    };
  }, [isOpen]);

  const handleDialogClose = () => {
    const dialog = dialogRef.current;
    if (dialog) {
      dialog.returnValue = '';
    }
    if (!busyRef.current) {
      onClose();
    }
  };

  const mergePreview = useMemo(() => {
    if (!pendingImport) return null;
    return previewMerge(spots, pendingImport.items, importMode, {
      photoSyncVersion: pendingImport.photoSyncVersion,
    });
  }, [spots, pendingImport, importMode]);

  const ensureTokenAndProfile = async (
    prompt: '' | 'consent' | 'select_account' = ''
  ): Promise<string> => {
    const token = await requestDriveAccessToken({ prompt });
    setIsConnected(true);
    try {
      const user = await fetchDriveUserInfo(token);
      if (user.emailAddress && user.emailAddress !== driveSync.accountEmail) {
        await onUpdateDriveMeta({ accountEmail: user.emailAddress });
      }
    } catch {
      // ignore optional display info fetch error
    }
    return token;
  };

  const handleConnect = async (prompt: 'consent' | 'select_account' = 'select_account') => {
    setBusy(true);
    setStatusMessage(null);
    try {
      await ensureTokenAndProfile(prompt);
      setStatusMessage({ kind: 'success', text: 'Google Drive に接続しました。' });
    } catch (err) {
      setStatusMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Google サインインに失敗しました。',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSignOut = async () => {
    setBusy(true);
    try {
      await signOutGoogleDrive();
      setIsConnected(false);
      await onUpdateDriveMeta({ accountEmail: null });
      setStatusMessage({ kind: 'info', text: 'Google アカウントからサインアウトしました。' });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveToDrive = async (forceOverwrite = false) => {
    const controller = new AbortController();
    syncAbortRef.current = controller;
    setBusy(true);
    setStatusMessage(null);
    setConflictState(null);
    setSyncProgressText('Google Drive の状態を確認中...');
    try {
      const token = await ensureTokenAndProfile('');
      const res = await saveWithPhotosToGoogleDrive({
        accessToken: token,
        spots,
        revision,
        syncMeta: driveSync,
        forceOverwrite,
        signal: controller.signal,
        onProgress: (p) => setSyncProgressText(formatSyncProgressLabel(p)),
        onPhotoUploaded: async (photoId, driveFileId) => {
          await onPhotoDriveIdsUpdated?.({ [photoId]: driveFileId });
        },
      });

      if (res.outcome === 'conflict') {
        setConflictState({
          folderId: res.folderId,
          remoteFile: res.remoteFile,
          reason: res.reason,
        });
        return;
      }

      await onUpdateDriveMeta({
        folderId: res.folderId,
        photosFolderId: res.photosFolderId ?? driveSync.photosFolderId ?? null,
        fileId: res.fileId,
        lastDriveModifiedTime: res.modifiedTime,
        lastDriveHeadRevisionId: res.headRevisionId,
        lastSyncedRevision: res.revision,
        lastSyncedAt: res.syncedAt,
      });

      const photoDetails: string[] = [];
      if (res.uploadedPhotoCount > 0) photoDetails.push(`写真アップロード ${res.uploadedPhotoCount}枚`);
      if (res.reusedPhotoCount > 0) photoDetails.push(`重複スキップ ${res.reusedPhotoCount}枚`);
      if (res.trashedPhotoCount > 0) photoDetails.push(`旧写真ゴミ箱整理 ${res.trashedPhotoCount}枚`);
      const detailSuffix = photoDetails.length > 0 ? `（${photoDetails.join(' / ')}）` : '';

      setStatusMessage({
        kind: 'success',
        text: `Google Drive（3D Visit Record/visit-records.json）へ ${spots.length} 件の地点を保存しました${detailSuffix}。`,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setStatusMessage({
          kind: 'info',
          text: 'Google Drive への保存を中断しました。アップロード済みの写真は記録済みのため、次回続きから再開できます。',
        });
      } else {
        setStatusMessage({
          kind: 'error',
          text: err instanceof Error ? err.message : 'Google Drive への保存に失敗しました。',
        });
      }
    } finally {
      syncAbortRef.current = null;
      setSyncProgressText(null);
      setBusy(false);
      await refreshPhotoCacheSummary();
    }
  };

  const handleBulkDownloadMissingPhotos = async () => {
    if (!missingPhotos || missingPhotos.photos.length === 0 || busy) return;
    const controller = new AbortController();
    syncAbortRef.current = controller;
    setBusy(true);
    setStatusMessage(null);
    setSyncProgressText(`未取得の写真をダウンロード中 (0 / ${missingPhotos.photos.length})...`);
    try {
      const token = await ensureTokenAndProfile('');
      const result = await downloadAllMissingPhotos({
        spots,
        accessToken: token,
        signal: controller.signal,
        onProgress: ({ completed, total }) => {
          setSyncProgressText(`未取得の写真をダウンロード中 (${completed} / ${total})...`);
        },
        onPhotoCached: () => onPhotoCacheUpdated?.(),
      });

      if (result.aborted) {
        setStatusMessage({
          kind: 'info',
          text: `一括ダウンロードを中断しました（取得済み ${result.downloaded} 枚は端末にキャッシュ済みです）。`,
        });
      } else if (result.quotaExceeded) {
        setStatusMessage({
          kind: 'error',
          text: `端末の保存容量が不足したため中断しました（${result.downloaded} 枚を保存済み）。`,
        });
      } else if (result.failed > 0) {
        setStatusMessage({
          kind: 'error',
          text: `一括ダウンロード完了（取得 ${result.downloaded} 枚 / スキップ ${result.skipped} 枚 / 失敗 ${result.failed} 枚）${
            result.errorMessage ? `: ${result.errorMessage}` : ''
          }`,
        });
      } else {
        setStatusMessage({
          kind: 'success',
          text: `${result.downloaded} 枚の写真を端末にキャッシュしました（オフラインでも閲覧できます）。`,
        });
      }
    } catch (err) {
      setStatusMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : '写真の一括ダウンロードに失敗しました。',
      });
    } finally {
      syncAbortRef.current = null;
      setSyncProgressText(null);
      setBusy(false);
      await refreshPhotoCacheSummary();
    }
  };

  const handleLoadFromDrive = async () => {
    setBusy(true);
    setStatusMessage(null);
    setConflictState(null);
    try {
      const token = await ensureTokenAndProfile('');
      const inspection = await inspectRemoteRecords(token, driveSync);
      if (!inspection.file) {
        setStatusMessage({
          kind: 'info',
          text: 'Google Drive 上に保存された記録ファイルがまだありません。「Google Drive に保存」で作成できます。',
        });
        return;
      }
      const downloaded = await downloadRemoteRecords(token, inspection.file.id);
      setImportMode('merge');
      setPendingImport({
        sourceLabel: `Google Drive (${formatDateTime(downloaded.meta.modifiedTime)})`,
        reason: 'drive-restore',
        format: 'visit-record',
        items: downloaded.items,
        photoSyncVersion: downloaded.photoSyncVersion,
        driveMeta: {
          folderId: inspection.folderId,
          file: downloaded.meta,
          revision: downloaded.revision,
        },
      });
    } catch (err) {
      setStatusMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Google Drive からの読み込みに失敗しました。',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmPendingImport = async () => {
    if (!pendingImport || !mergePreview) return;
    setBusy(true);
    setStatusMessage(null);
    try {
      const driveSyncPatch: Partial<DriveSyncMeta> | undefined = pendingImport.driveMeta
        ? {
            folderId: pendingImport.driveMeta.folderId ?? driveSync.folderId,
            fileId: pendingImport.driveMeta.file.id,
            lastDriveModifiedTime: pendingImport.driveMeta.file.modifiedTime,
            lastDriveHeadRevisionId: pendingImport.driveMeta.file.headRevisionId ?? null,
            lastSyncedAt: new Date().toISOString(),
          }
        : undefined;

      const result = await onApplyImportedSpots({
        nextSpots: mergePreview.next,
        reason: pendingImport.reason,
        driveSyncPatch,
      });

      if (!result.success) {
        setStatusMessage({
          kind: 'error',
          text: result.message || '復元の適用に失敗しました。',
        });
        return;
      }

      if (driveSyncPatch && result.state && (importMode === 'replace' || spots.length === 0)) {
        await onUpdateDriveMeta({ lastSyncedRevision: result.state.revision });
      }

      setPendingImport(null);
      setStatusMessage({
        kind: 'success',
        text: `${pendingImport.sourceLabel} から復元しました（追加 ${mergePreview.added}件 / 更新 ${mergePreview.updated}件）。直前の状態へ「元に戻す」ことも可能です。`,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleUndo = async () => {
    setBusy(true);
    setStatusMessage(null);
    try {
      const res = await onUndoLastRestore();
      if (res.success) {
        setStatusMessage({ kind: 'success', text: '復元・取り込み直前の状態に戻しました。' });
      } else {
        setStatusMessage({ kind: 'error', text: res.message || '元に戻せませんでした。' });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleLocalExport = async () => {
    if (spots.length === 0) return;
    setBusy(true);
    try {
      const outcome = await exportBackupJsonFile(spots, revision);
      if (outcome !== 'cancelled') {
        await onLocalExportRecorded(new Date().toISOString());
        setStatusMessage({
          kind: 'success',
          text:
            outcome === 'shared'
              ? 'バックアップファイルを共有しました。'
              : 'JSON バックアップのダウンロードを開始しました。',
        });
      }
    } catch {
      setStatusMessage({ kind: 'error', text: 'JSON 書き出しに失敗しました。' });
    } finally {
      setBusy(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setStatusMessage(null);
    try {
      const text = await file.text();
      const format = detectBackupFormat(text);
      const parsed = parseBackupJson(text, { rainViewerImportStatus: rainImportStatus });
      setImportMode('merge');
      setPendingImport({
        sourceLabel: file.name,
        reason: 'json-import',
        format,
        rawText: format === 'rain-viewer' ? text : undefined,
        items: parsed.items,
        photoSyncVersion: parsed.photoSyncVersion,
      });
    } catch (err) {
      setStatusMessage({
        kind: 'error',
        text:
          err instanceof VisitTransferError
            ? err.message
            : 'ファイルの読み込みに失敗しました。',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRainStatusSwitch = (nextStatus: SpotStatus) => {
    setRainImportStatus(nextStatus);
    if (pendingImport?.format === 'rain-viewer' && pendingImport.rawText) {
      try {
        const parsed = parseBackupJson(pendingImport.rawText, {
          rainViewerImportStatus: nextStatus,
        });
        setPendingImport({ ...pendingImport, items: parsed.items });
      } catch {
        // ignore
      }
    }
  };

  const handleRescueDownload = async () => {
    const raw = await readRawRecoveryData();
    const blob = new Blob([JSON.stringify(raw, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `visit3d-rescue-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <dialog
      ref={dialogRef}
      id="cloud-sync-dialog"
      aria-labelledby="cloud-sync-title"
      onClose={handleDialogClose}
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
      {...({ closedby: busy ? 'none' : 'any' } as Record<string, string>)}
      className="visit-modal"
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2">
          <Cloud className="w-5 h-5 text-sky-400" aria-hidden="true" />
          <h2 id="cloud-sync-title" className="text-base font-bold text-white">
            Google Drive 保存・復元
          </h2>
        </div>
        <button
          type="button"
          autoFocus
          disabled={busy}
          onClick={() => dialogRef.current?.close('close-btn')}
          aria-label="閉じる"
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer disabled:opacity-40"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 space-y-4 overflow-y-auto text-xs">
        {syncProgressText && (
          <div
            role="status"
            className="p-3 rounded-xl border border-sky-500/50 bg-sky-500/15 text-sky-100 flex items-center justify-between gap-2"
          >
            <span className="inline-flex items-center gap-2 min-w-0">
              <Loader2 className="w-4 h-4 animate-spin text-sky-300 shrink-0" aria-hidden="true" />
              <span className="truncate">{syncProgressText}</span>
            </span>
            <button
              type="button"
              onClick={() => syncAbortRef.current?.abort()}
              className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-100 font-semibold shrink-0 cursor-pointer"
            >
              中断
            </button>
          </div>
        )}

        {statusMessage && (
          <div
            role="status"
            className={`p-3 rounded-xl border leading-relaxed ${
              statusMessage.kind === 'success'
                ? 'bg-emerald-500/15 border-emerald-400/50 text-emerald-100'
                : statusMessage.kind === 'error'
                  ? 'bg-rose-500/15 border-rose-400/50 text-rose-100'
                  : 'bg-sky-500/15 border-sky-400/50 text-sky-100'
            }`}
          >
            {statusMessage.text}
          </div>
        )}

        {/* Google Drive Connection & Actions */}
        <section className="p-3.5 rounded-2xl bg-slate-950/75 border border-slate-800 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-bold text-slate-100 text-sm">クラウド同期（Google Drive）</div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                {driveSync.accountEmail
                  ? `接続アカウント: ${driveSync.accountEmail}`
                  : isConnected
                    ? 'Google Drive に接続済み'
                    : '未接続（マイドライブ / 3D Visit Record に保存）'}
              </div>
            </div>

            {authConfigured && (
              <div className="flex items-center gap-1.5">
                {isConnected ? (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleConnect('select_account')}
                      className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold cursor-pointer"
                    >
                      切替
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={handleSignOut}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold cursor-pointer"
                    >
                      <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>切断</span>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    id="drive-signin-btn"
                    disabled={busy}
                    onClick={() => handleConnect('select_account')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold cursor-pointer"
                  >
                    <LogIn className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Google に接続</span>
                  </button>
                )}
              </div>
            )}
          </div>

          {!authConfigured && (
            <p className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-[11px]">
              現在この環境には Google OAuth クライアント ID（VITE_GOOGLE_CLIENT_ID）が設定されていません。下の「ローカル JSON バックアップ」はそのままご利用いただけます。
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
            <span>最終 Drive 同期: {formatDateTime(driveSync.lastSyncedAt)}</span>
            {hasUnsavedDriveChanges && (
              <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-200 border border-amber-400/40 font-semibold">
                未保存の変更あり
              </span>
            )}
          </div>

          {authConfigured && (
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                id="drive-save-btn"
                disabled={busy}
                onClick={() => handleSaveToDrive(false)}
                className="inline-flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold cursor-pointer disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <CloudUpload className="w-4 h-4" aria-hidden="true" />
                )}
                <span>Drive に保存</span>
              </button>
              <button
                type="button"
                id="drive-restore-btn"
                disabled={busy}
                onClick={handleLoadFromDrive}
                className="inline-flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold cursor-pointer disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <CloudDownload className="w-4 h-4" aria-hidden="true" />
                )}
                <span>Drive から復元</span>
              </button>
            </div>
          )}

          {/* 端末写真キャッシュ状況 & 未取得写真の一括ダウンロード */}
          {(storageStats || (missingPhotos && missingPhotos.photos.length > 0)) && (
            <div className="pt-2 border-t border-slate-800/80 space-y-2 text-[11px] text-slate-300">
              {storageStats && (
                <div className="flex flex-wrap items-center justify-between gap-1 text-slate-400">
                  <span>
                    写真キャッシュ: 端末に {storageStats.photoCount} 枚保存中（約{' '}
                    {formatByteSize(storageStats.totalBytes)}）
                  </span>
                  {storageStats.originUsageBytes !== null && storageStats.originQuotaBytes !== null && (
                    <span className="tabular-nums">
                      端末全体: {formatByteSize(storageStats.originUsageBytes)} /{' '}
                      {formatByteSize(storageStats.originQuotaBytes)}
                    </span>
                  )}
                </div>
              )}

              {authConfigured && missingPhotos && missingPhotos.photos.length > 0 && (
                <button
                  type="button"
                  id="drive-download-all-photos-btn"
                  disabled={busy}
                  onClick={handleBulkDownloadMissingPhotos}
                  className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/50 text-sky-100 font-semibold cursor-pointer disabled:opacity-50"
                >
                  <CloudDownload className="w-4 h-4 text-sky-300 shrink-0" aria-hidden="true" />
                  <span>
                    未取得の写真をすべてダウンロード（残り {missingPhotos.photos.length} 枚 / 約{' '}
                    {formatByteSize(missingPhotos.totalBytes)}）
                  </span>
                </button>
              )}
            </div>
          )}
        </section>

        {/* Conflict resolution panel */}
        {conflictState && (
          <section className="p-3.5 rounded-2xl bg-amber-950/60 border border-amber-400/60 space-y-2.5">
            <div className="flex items-start gap-2 text-amber-100">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="space-y-1">
                <p className="font-bold">
                  {conflictState.reason === 'remote-exists-unlinked'
                    ? 'Google Drive 上に既存の保存ファイルが見つかりました'
                    : '他の端末・セッションで Google Drive のデータが更新されています'}
                </p>
                <p className="text-[11px] text-amber-200/90">
                  Drive 最終更新: {formatDateTime(conflictState.remoteFile.modifiedTime)}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-2">
              <button
                type="button"
                id="conflict-merge-btn"
                disabled={busy}
                onClick={handleLoadFromDrive}
                className="py-2 px-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold cursor-pointer"
              >
                まず Drive から取り込んでマージする（推奨）
              </button>
              <button
                type="button"
                id="conflict-overwrite-btn"
                disabled={busy}
                onClick={() => handleSaveToDrive(true)}
                className="py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-amber-400/40 text-amber-100 font-semibold cursor-pointer"
              >
                ローカルの内容で Drive を上書きする（退避コピー作成）
              </button>
            </div>
          </section>
        )}

        {/* Pending import / restore preview */}
        {pendingImport && mergePreview && (
          <section className="p-3.5 rounded-2xl bg-slate-950/90 border border-sky-500/50 space-y-3">
            <div className="font-bold text-white">
              取り込み・復元の確認: {pendingImport.sourceLabel}
            </div>

            {pendingImport.format === 'rain-viewer' && (
              <div className="p-2.5 rounded-xl bg-sky-500/10 border border-sky-500/30 space-y-1.5">
                <div className="font-semibold text-sky-200">
                  3d_rain_viewer のお気に入りバックアップとして認識しました
                </div>
                <div className="flex items-center gap-3">
                  <label className="inline-flex items-center gap-1 cursor-pointer">
                    <input
                      type="radio"
                      name="rain-status"
                      checked={rainImportStatus === 'planned'}
                      onChange={() => handleRainStatusSwitch('planned')}
                    />
                    <span>訪問予定として取込</span>
                  </label>
                  <label className="inline-flex items-center gap-1 cursor-pointer">
                    <input
                      type="radio"
                      name="rain-status"
                      checked={rainImportStatus === 'visited'}
                      onChange={() => handleRainStatusSwitch('visited')}
                    />
                    <span>訪問済みとして取込</span>
                  </label>
                </div>
              </div>
            )}

            <div className="flex items-center gap-3">
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="import-mode"
                  checked={importMode === 'merge'}
                  onChange={() => setImportMode('merge')}
                />
                <span className="font-semibold text-emerald-300">マージ（推奨：統合）</span>
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="import-mode"
                  checked={importMode === 'replace'}
                  onChange={() => setImportMode('replace')}
                />
                <span className="font-semibold text-amber-300">置き換え（全置換）</span>
              </label>
            </div>

            <div className="grid grid-cols-4 gap-1.5 text-center p-2 rounded-xl bg-slate-900 border border-slate-800">
              <div>
                <div className="text-[10px] text-slate-400">新規地点</div>
                <div className="font-bold text-emerald-300">+{mergePreview.added}</div>
              </div>
              <div>
                <div className="text-[10px] text-slate-400">更新地点</div>
                <div className="font-bold text-sky-300">{mergePreview.updated}</div>
              </div>
              <div>
                <div className="text-[10px] text-slate-400">ログ追記</div>
                <div className="font-bold text-indigo-300">+{mergePreview.entriesAdded}</div>
              </div>
              <div>
                <div className="text-[10px] text-slate-400">削除</div>
                <div className="font-bold text-rose-300">{mergePreview.removed}</div>
              </div>
            </div>

            {(mergePreview.photosAdded > 0 || mergePreview.photosRemoved > 0) && (
              <div className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-[11px] text-slate-300">
                <span>写真差分</span>
                <span className="font-semibold flex items-center gap-2">
                  {mergePreview.photosAdded > 0 && (
                    <span className="text-emerald-300">追加 +{mergePreview.photosAdded}枚</span>
                  )}
                  {mergePreview.photosRemoved > 0 && (
                    <span className="text-rose-300">削除 -{mergePreview.photosRemoved}枚</span>
                  )}
                </span>
              </div>
            )}

            {(mergePreview.truncatedSpots > 0 || mergePreview.truncatedEntries > 0) && (
              <p className="text-[11px] text-amber-300">
                上限超過により一部データが切り捨てられます（地点 {mergePreview.truncatedSpots}件 / ログ{' '}
                {mergePreview.truncatedEntries}件）。
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setPendingImport(null)}
                className="px-3 py-1.5 rounded-xl bg-slate-800 text-slate-200 cursor-pointer"
              >
                キャンセル
              </button>
              <button
                type="button"
                id="confirm-import-btn"
                disabled={busy}
                onClick={handleConfirmPendingImport}
                className="inline-flex items-center gap-1 px-4 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold cursor-pointer"
              >
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
                <span>適用する</span>
              </button>
            </div>
          </section>
        )}

        {/* 1-generation Undo */}
        {undoSnapshot && (
          <section className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 flex items-center justify-between gap-2">
            <div className="text-[11px] text-slate-300">
              直前の復元（{formatDateTime(undoSnapshot.savedAt)}）を取り消せます。
            </div>
            <button
              type="button"
              id="undo-restore-btn"
              disabled={busy}
              onClick={handleUndo}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-100 font-semibold shrink-0 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>元に戻す</span>
            </button>
          </section>
        )}

        {/* Local JSON Backup & Migration */}
        <details className="rounded-xl bg-slate-950/60 border border-slate-800 p-3">
          <summary className="font-semibold text-slate-200 cursor-pointer select-none">
            ローカル JSON バックアップ・`3d_rain_viewer` 移行取込
          </summary>
          <div className="pt-3 space-y-2.5">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                id="local-json-export-btn"
                disabled={busy || spots.length === 0}
                onClick={handleLocalExport}
                className="inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold border border-slate-700 cursor-pointer disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
                <span>JSON 書き出し</span>
              </button>
              <button
                type="button"
                id="local-json-import-btn"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold border border-slate-700 cursor-pointer disabled:opacity-50"
              >
                <FileUp className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                <span>JSON 読み込み</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={handleFileChange}
                className="hidden"
              />
            </div>
            <p className="text-[11px] text-slate-400 leading-snug">
              3D Visit Record のバックアップのほか、`3d_rain_viewer` のお気に入り JSON ファイルも読み込んで移行できます。
            </p>
            <p className="text-[11px] text-amber-200/90 leading-snug">
              ※ 写真ファイル本体は JSON には含まれません。写真の引き継ぎや外部出力には Google Drive 保存または「写真付き ZIP」書き出しをご利用ください。
            </p>
            {onOpenExport && (
              <button
                type="button"
                id="cloud-sync-open-export-btn"
                disabled={busy}
                onClick={() => {
                  onClose();
                  onOpenExport();
                }}
                className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold border border-slate-700 cursor-pointer disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                <span>GeoJSON / CSV / KML / 写真付きZIP で書き出す</span>
              </button>
            )}
            {storageBlocked && (
              <button
                type="button"
                onClick={handleRescueDownload}
                className="w-full py-2 px-3 rounded-xl bg-rose-700 hover:bg-rose-600 text-white font-bold cursor-pointer"
              >
                破損データ救済ダウンロード（生データ出力）
              </button>
            )}
          </div>
        </details>
      </div>
    </dialog>
  );
};
