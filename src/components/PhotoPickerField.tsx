import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  ImagePlus,
  Loader2,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import {
  MAX_PHOTO_CAPTION_LENGTH,
  MAX_PHOTOS_PER_ENTRY,
  type DraftPhotoItem,
  type VisitDate,
} from '../types/visit';
import {
  buildSuggestedVisitDateFromPhotos,
  extractLocalDateFromTakenAt,
} from '../lib/photoExif';
import { processPhotoFilesSerial } from '../lib/photoProcessor';
import { hasControlCharacters } from '../lib/spotDomain';
import { formatVisitDate } from '../lib/visitDate';

interface PhotoPickerFieldProps {
  photos: DraftPhotoItem[];
  onChangePhotos: React.Dispatch<React.SetStateAction<DraftPhotoItem[]>>;
  onProcessingChange: (processing: boolean) => void;
  currentDate: VisitDate;
  onApplySuggestedDate: (suggested: VisitDate) => void;
  disabled?: boolean;
}

function isSameVisitDate(a: VisitDate, b: VisitDate): boolean {
  if (a.precision !== b.precision) return false;
  if (a.precision === 'none') return true;
  return a.start === b.start && (a.end ?? undefined) === (b.end ?? undefined);
}

export const PhotoPickerField: React.FC<PhotoPickerFieldProps> = ({
  photos,
  onChangePhotos,
  onProcessingChange,
  currentDate,
  onApplySuggestedDate,
  disabled = false,
}) => {
  const uid = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);

  const [isDragging, setIsDragging] = useState(false);
  const [processingState, setProcessingState] = useState<{ done: number; total: number } | null>(
    null
  );
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [errorMessages, setErrorMessages] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(photos[0]?.attachment.id ?? null);
  const [dismissedSuggestionKey, setDismissedSuggestionKey] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (photos.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !photos.some((p) => p.attachment.id === selectedId)) {
      setSelectedId(photos[0].attachment.id);
    }
  }, [photos, selectedId]);

  const activePhotoIndex = useMemo(
    () => photos.findIndex((p) => p.attachment.id === selectedId),
    [photos, selectedId]
  );
  const activePhoto = activePhotoIndex >= 0 ? photos[activePhotoIndex] : null;

  const activeCaption = activePhoto?.attachment.caption ?? '';
  const activeCaptionError = useMemo(() => {
    if (!activePhoto) return null;
    if (activeCaption.length > MAX_PHOTO_CAPTION_LENGTH) {
      return `キャプションは${MAX_PHOTO_CAPTION_LENGTH}文字以内で入力してください。`;
    }
    if (hasControlCharacters(activeCaption, false)) {
      return 'キャプションに使用できない制御文字が含まれています。';
    }
    return null;
  }, [activePhoto, activeCaption]);

  const suggestedDate = useMemo(() => {
    const dates = photos.map(
      (p) => p.exifLocalDate ?? extractLocalDateFromTakenAt(p.attachment.takenAt)
    );
    return buildSuggestedVisitDateFromPhotos(dates);
  }, [photos]);

  const suggestionKey = suggestedDate
    ? `${suggestedDate.start ?? ''}|${suggestedDate.end ?? ''}`
    : null;
  const showDateSuggestion = Boolean(
    suggestedDate &&
      suggestionKey &&
      dismissedSuggestionKey !== suggestionKey &&
      !isSameVisitDate(suggestedDate, currentDate)
  );

  const isBusy = processingState !== null;
  const remainingSlots = Math.max(0, MAX_PHOTOS_PER_ENTRY - photos.length);
  const canAddMore = !disabled && !isBusy && remainingSlots > 0;

  const handleFiles = async (fileList: FileList | File[]) => {
    const rawFiles = Array.from(fileList);
    if (rawFiles.length === 0 || disabled || isBusy) return;

    setNoticeMessage(null);
    setErrorMessages([]);

    if (remainingSlots <= 0) {
      setNoticeMessage(`写真は1ログあたり最大 ${MAX_PHOTOS_PER_ENTRY} 枚まで添付できます。`);
      return;
    }

    const accepted = rawFiles.slice(0, remainingSlots);
    if (rawFiles.length > remainingSlots) {
      setNoticeMessage(
        `1ログ最大 ${MAX_PHOTOS_PER_ENTRY} 枚までのため、先頭 ${accepted.length} 枚のみ処理しました。`
      );
    }

    setProcessingState({ done: 0, total: accepted.length });
    onProcessingChange(true);

    try {
      const results = await processPhotoFilesSerial(accepted, {
        onProgress: (done, total) => {
          if (mountedRef.current) {
            setProcessingState({ done, total });
          }
        },
      });

      const createdItems: DraftPhotoItem[] = [];
      const errors: string[] = [];

      for (const item of results) {
        if (item.ok) {
          const previewUrl =
            typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
              ? URL.createObjectURL(item.result.thumbnailBlob)
              : '';
          createdItems.push({
            attachment: item.result.attachment,
            fullBlob: item.result.fullBlob,
            thumbnailBlob: item.result.thumbnailBlob,
            previewUrl,
            isNew: true,
            exifLocalDate: item.result.exifLocalDate,
          });
        } else {
          errors.push(`${item.fileName}: ${item.error}`);
        }
      }

      if (!mountedRef.current) {
        for (const created of createdItems) {
          if (created.previewUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) {
            URL.revokeObjectURL(created.previewUrl);
          }
        }
        return;
      }

      if (createdItems.length > 0) {
        onChangePhotos((prev) => [...prev, ...createdItems].slice(0, MAX_PHOTOS_PER_ENTRY));
        setSelectedId((prevSel) => prevSel ?? createdItems[0].attachment.id);
      }
      if (errors.length > 0) {
        setErrorMessages(errors);
      }
    } finally {
      if (mountedRef.current) {
        setProcessingState(null);
      }
      onProcessingChange(false);
    }
  };

  const handleMove = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= photos.length) return;
    const movedId = photos[index]?.attachment.id;
    onChangePhotos((prev) => {
      const copy = [...prev];
      const [moved] = copy.splice(index, 1);
      copy.splice(target, 0, moved);
      return copy;
    });
    if (movedId) setSelectedId(movedId);
  };

  const handleRemove = (index: number) => {
    const target = photos[index];
    if (!target) return;
    if (target.isNew && target.previewUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) {
      URL.revokeObjectURL(target.previewUrl);
    }
    onChangePhotos((prev) => prev.filter((_, i) => i !== index));
  };

  const handleCaptionChange = (photoId: string, value: string) => {
    onChangePhotos((prev) =>
      prev.map((item) =>
        item.attachment.id === photoId
          ? { ...item, attachment: { ...item.attachment, caption: value } }
          : item
      )
    );
  };

  return (
    <div className="space-y-2 pt-1">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-slate-200">写真（任意・最大 {MAX_PHOTOS_PER_ENTRY} 枚）</span>
        <span className="text-[11px] text-slate-400 tabular-nums">
          {photos.length} / {MAX_PHOTOS_PER_ENTRY}
        </span>
      </div>

      {/* ファイル選択・ドロップ領域（モバイルでもライブラリ/カメラ/ファイルを選べるよう capture は付けない） */}
      <div
        onDragOver={(e) => {
          if (!canAddMore) return;
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          if (canAddMore && e.dataTransfer?.files?.length) {
            void handleFiles(e.dataTransfer.files);
          }
        }}
        className={`rounded-xl border border-dashed transition-colors ${
          isDragging
            ? 'border-sky-400 bg-sky-500/15'
            : canAddMore
              ? 'border-slate-700 bg-slate-950/75 hover:border-slate-500'
              : 'border-slate-800 bg-slate-950/40 opacity-60'
        }`}
      >
        <input
          ref={fileInputRef}
          id={`${uid}-photo-input`}
          type="file"
          accept="image/*"
          multiple
          disabled={!canAddMore}
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) {
              void handleFiles(files);
            }
            e.target.value = '';
          }}
          className="hidden"
        />
        <button
          type="button"
          disabled={!canAddMore}
          onClick={() => fileInputRef.current?.click()}
          className="w-full py-2.5 px-3 flex items-center justify-center gap-2 text-xs font-semibold text-slate-200 cursor-pointer disabled:cursor-not-allowed"
        >
          {isBusy ? (
            <>
              <Loader2 className="w-4 h-4 text-sky-400 animate-spin shrink-0" aria-hidden="true" />
              <span>
                写真を最適化中... ({processingState.done}/{processingState.total})
              </span>
            </>
          ) : (
            <>
              <ImagePlus className="w-4 h-4 text-sky-400 shrink-0" aria-hidden="true" />
              <span>
                {remainingSlots > 0
                  ? '写真を追加（複数選択・ドラッグ＆ドロップ）'
                  : `上限（${MAX_PHOTOS_PER_ENTRY}枚）に達しました`}
              </span>
            </>
          )}
        </button>
      </div>

      {noticeMessage && (
        <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2.5 py-1.5">
          {noticeMessage}
        </p>
      )}

      {errorMessages.length > 0 && (
        <div
          role="alert"
          className="p-2.5 rounded-xl bg-rose-500/15 border border-rose-400/40 text-[11px] text-rose-200 space-y-1"
        >
          {errorMessages.map((msg, idx) => (
            <p key={idx} className="flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{msg}</span>
            </p>
          ))}
        </div>
      )}

      {/* EXIF 撮影日時の訪問日反映提案 */}
      {showDateSuggestion && suggestedDate && (
        <div className="flex flex-wrap items-center justify-between gap-2 p-2 rounded-xl bg-sky-500/15 border border-sky-400/40 text-[11px] text-sky-100">
          <span className="inline-flex items-center gap-1.5">
            <CalendarPlus className="w-3.5 h-3.5 text-sky-300 shrink-0" aria-hidden="true" />
            <span>
              写真の撮影日（<strong>{formatVisitDate(suggestedDate)}</strong>）を訪問日に反映しますか？
            </span>
          </span>
          <div className="flex items-center gap-1 ml-auto">
            <button
              type="button"
              onClick={() => onApplySuggestedDate(suggestedDate)}
              className="px-2 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-bold cursor-pointer"
            >
              反映する
            </button>
            <button
              type="button"
              aria-label="撮影日の提案を閉じる"
              onClick={() => setDismissedSuggestionKey(suggestionKey)}
              className="p-1 rounded-lg text-sky-200 hover:bg-sky-500/20 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/* サムネイル並び替え＆選択リスト */}
      {photos.length > 0 && (
        <div className="space-y-2">
          <div className="grid grid-cols-5 gap-1.5">
            {photos.map((item, idx) => {
              const isSelected = item.attachment.id === activePhoto?.attachment.id;
              return (
                <div
                  key={item.attachment.id}
                  className={`relative rounded-xl overflow-hidden border bg-slate-950 ${
                    isSelected ? 'border-sky-400 ring-2 ring-sky-400/40' : 'border-slate-700/80'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedId(item.attachment.id)}
                    aria-label={`写真 ${idx + 1} を選択`}
                    className="block w-full aspect-square overflow-hidden cursor-pointer focus-visible:outline-none"
                  >
                    {item.previewUrl ? (
                      <img
                        src={item.previewUrl}
                        alt={item.attachment.caption || `添付写真 ${idx + 1}`}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-slate-900 text-[10px] text-slate-400">
                        読込中
                      </div>
                    )}
                  </button>

                  {idx === 0 && (
                    <span className="pointer-events-none absolute top-1 left-1 inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-sky-600/90 text-white text-[9px] font-bold shadow">
                      <Star className="w-2.5 h-2.5 fill-current" aria-hidden="true" />
                      代表
                    </span>
                  )}

                  <div className="flex items-center justify-between gap-0.5 px-1 py-0.5 bg-slate-950/90 border-t border-slate-800">
                    <button
                      type="button"
                      disabled={disabled || idx === 0}
                      onClick={() => handleMove(idx, -1)}
                      aria-label={`写真 ${idx + 1} を前へ移動`}
                      className="p-0.5 rounded text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-30 cursor-pointer disabled:cursor-default"
                    >
                      <ChevronLeft className="w-3 h-3" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      disabled={disabled || idx === photos.length - 1}
                      onClick={() => handleMove(idx, 1)}
                      aria-label={`写真 ${idx + 1} を後ろへ移動`}
                      className="p-0.5 rounded text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-30 cursor-pointer disabled:cursor-default"
                    >
                      <ChevronRight className="w-3 h-3" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => handleRemove(idx)}
                      aria-label={`写真 ${idx + 1} を削除`}
                      className="p-0.5 rounded text-slate-400 hover:text-rose-300 hover:bg-slate-800 disabled:opacity-30 cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {activePhoto && (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={`${uid}-caption`} className="text-[11px] font-semibold text-slate-300">
                  写真 {activePhotoIndex + 1} のキャプション（任意）
                </label>
                <span className="text-[10px] text-slate-400 tabular-nums">
                  {activeCaption.length} / {MAX_PHOTO_CAPTION_LENGTH}
                </span>
              </div>
              <input
                id={`${uid}-caption`}
                type="text"
                maxLength={MAX_PHOTO_CAPTION_LENGTH}
                disabled={disabled}
                value={activeCaption}
                onChange={(e) => handleCaptionChange(activePhoto.attachment.id, e.target.value)}
                aria-invalid={activeCaptionError ? 'true' : 'false'}
                placeholder="例: 河童橋からの穂高連峰"
                className={`visit-input w-full px-2.5 py-1.5 rounded-xl bg-slate-950/90 border text-base sm:text-xs text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-400 ${
                  activeCaptionError ? 'user-invalid-fallback border-rose-400' : 'border-slate-700'
                }`}
              />
              {activeCaptionError && (
                <p className="flex items-center gap-1 text-[11px] text-rose-300">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>{activeCaptionError}</span>
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
