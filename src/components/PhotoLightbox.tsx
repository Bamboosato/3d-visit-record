import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  Download,
  Image as ImageIcon,
  Loader2,
  X,
} from 'lucide-react';
import type { PhotoAttachment } from '../types/visit';
import { getStoredPhoto } from '../lib/photoStorage';
import { usePhotoObjectUrl } from '../lib/photoUrlCache';
import { useUpdateBlocker } from '../lib/updateGuard';

interface PhotoLightboxProps {
  isOpen: boolean;
  photos: PhotoAttachment[];
  initialIndex: number;
  spotName?: string;
  photoCacheVersion?: number;
  onRequestRemotePhoto?: (photo: PhotoAttachment) => void;
  onClose: () => void;
}

function formatTakenAtLabel(takenAt?: string): string | null {
  if (!takenAt) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(takenAt.trim());
  if (!m) return null;
  return m[4] && m[5] ? `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}` : `${m[1]}/${m[2]}/${m[3]}`;
}

export const PhotoLightbox: React.FC<PhotoLightboxProps> = ({
  isOpen,
  photos,
  initialIndex,
  spotName,
  photoCacheVersion = 0,
  onRequestRemotePhoto,
  onClose,
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [saving, setSaving] = useState(false);

  useUpdateBlocker(isOpen);

  useEffect(() => {
    if (!isOpen || photos.length === 0) return;
    const clamped = Math.min(Math.max(0, initialIndex), photos.length - 1);
    setCurrentIndex(clamped);
  }, [isOpen, initialIndex, photos.length]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && photos.length > 0) {
      if (!dialog.open && typeof dialog.showModal === 'function') {
        dialog.showModal();
      }
    } else if (dialog.open && typeof dialog.close === 'function') {
      dialog.close();
    }
  }, [isOpen, photos.length]);

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
      pressedOutside = isOutside(e);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e)) {
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

  const activePhoto =
    isOpen && photos.length > 0 ? photos[Math.min(currentIndex, photos.length - 1)] : null;

  const { url: fullUrl, loading: fullLoading } = usePhotoObjectUrl(
    activePhoto?.id,
    'full',
    photoCacheVersion
  );
  const { url: thumbUrl } = usePhotoObjectUrl(activePhoto?.id, 'thumb', photoCacheVersion);

  const canNavigate = photos.length > 1;
  const goPrev = () => {
    if (!canNavigate) return;
    setCurrentIndex((prev) => (prev - 1 + photos.length) % photos.length);
  };
  const goNext = () => {
    if (!canNavigate) return;
    setCurrentIndex((prev) => (prev + 1) % photos.length);
  };

  const handleSaveOrShare = async () => {
    if (!activePhoto || saving) return;
    setSaving(true);
    try {
      const record = await getStoredPhoto(activePhoto.id);
      if (!record) return;
      const isTouchDevice =
        typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
      if (isTouchDevice && typeof navigator.share === 'function' && typeof File === 'function') {
        const file = new File([record.fullBlob], activePhoto.fileName, { type: record.mimeType });
        if (navigator.canShare?.({ files: [file] })) {
          try {
            await navigator.share({
              files: [file],
              title: activePhoto.caption || spotName || '3D Visit Record 写真',
            });
            return;
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') return;
          }
        }
      }

      const blobUrl = URL.createObjectURL(record.fullBlob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = activePhoto.fileName;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
    } finally {
      setSaving(false);
    }
  };

  const handleDialogClose = () => {
    const dialog = dialogRef.current;
    if (dialog) {
      dialog.returnValue = '';
    }
    onClose();
  };

  const takenAtLabel = formatTakenAtLabel(activePhoto?.takenAt);
  const displayUrl = fullUrl ?? (fullLoading ? thumbUrl : null);

  return (
    <dialog
      ref={dialogRef}
      aria-label={spotName ? `${spotName} の写真プレビュー` : '写真拡大表示'}
      onClose={handleDialogClose}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          goPrev();
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          goNext();
        }
      }}
      {...({ closedby: 'any' } as Record<string, string>)}
      className="visit-lightbox"
    >
      {activePhoto && (
        <>
          <header className="flex items-center justify-between gap-2 px-3 sm:px-4 py-2.5 border-b border-slate-800 bg-slate-950/80 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0 text-xs">
              <span className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-100 font-bold tabular-nums shrink-0">
                {currentIndex + 1} / {photos.length}
              </span>
              {takenAtLabel && (
                <span className="text-slate-300 tabular-nums truncate">{takenAtLabel}</span>
              )}
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {fullUrl && (
                <button
                  type="button"
                  onClick={handleSaveOrShare}
                  disabled={saving}
                  aria-label="この写真を保存または共有"
                  className="inline-flex items-center gap-1.5 min-h-[44px] px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-semibold cursor-pointer disabled:opacity-50"
                >
                  {saving ? (
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Download className="w-4 h-4 text-sky-400" aria-hidden="true" />
                  )}
                  <span className="hidden sm:inline">保存 / 共有</span>
                </button>
              )}
              <button
                type="button"
                autoFocus
                onClick={() => dialogRef.current?.close('close-btn')}
                aria-label="写真を閉じる"
                className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-xl text-slate-300 hover:text-white hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
          </header>

          <div
            className="relative flex-1 min-h-[16rem] flex items-center justify-center bg-slate-950/90 overflow-hidden px-2 py-3 select-none"
            onTouchStart={(e) => {
              const t = e.touches[0];
              if (t) touchStartRef.current = { x: t.clientX, y: t.clientY };
            }}
            onTouchEnd={(e) => {
              const start = touchStartRef.current;
              touchStartRef.current = null;
              const t = e.changedTouches[0];
              if (!start || !t || !canNavigate) return;
              const dx = t.clientX - start.x;
              const dy = t.clientY - start.y;
              if (Math.abs(dx) >= 45 && Math.abs(dx) > Math.abs(dy)) {
                if (dx > 0) goPrev();
                else goNext();
              }
            }}
          >
            {canNavigate && (
              <button
                type="button"
                onClick={goPrev}
                aria-label="前の写真"
                className="absolute left-2 z-10 inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-full bg-slate-900/80 hover:bg-slate-800 border border-slate-700/80 text-white shadow-lg cursor-pointer"
              >
                <ChevronLeft className="w-5 h-5" aria-hidden="true" />
              </button>
            )}

            {displayUrl ? (
              <img
                src={displayUrl}
                alt={activePhoto.caption || `${spotName ?? '訪問記録'} の写真 ${currentIndex + 1}`}
                className="max-w-full max-h-[68dvh] object-contain rounded-lg"
              />
            ) : fullLoading ? (
              <div className="flex flex-col items-center gap-2 text-xs text-slate-300">
                <Loader2 className="w-6 h-6 text-sky-400 animate-spin" aria-hidden="true" />
                <span>写真を読み込み中...</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 text-center px-6 py-8 text-xs text-slate-300">
                <ImageIcon className="w-8 h-8 text-slate-500" aria-hidden="true" />
                <p>この写真は端末にまだ保存されていません。</p>
                {activePhoto.driveFileId && onRequestRemotePhoto && (
                  <button
                    type="button"
                    onClick={() => onRequestRemotePhoto(activePhoto)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold cursor-pointer"
                  >
                    <CloudDownload className="w-4 h-4" aria-hidden="true" />
                    <span>Drive から取得する</span>
                  </button>
                )}
              </div>
            )}

            {canNavigate && (
              <button
                type="button"
                onClick={goNext}
                aria-label="次の写真"
                className="absolute right-2 z-10 inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-full bg-slate-900/80 hover:bg-slate-800 border border-slate-700/80 text-white shadow-lg cursor-pointer"
              >
                <ChevronRight className="w-5 h-5" aria-hidden="true" />
              </button>
            )}
          </div>

          {activePhoto.caption && (
            <footer className="px-4 py-2.5 border-t border-slate-800 bg-slate-950/85 text-xs sm:text-sm text-slate-100 leading-relaxed break-words shrink-0">
              {activePhoto.caption}
            </footer>
          )}
        </>
      )}
    </dialog>
  );
};
