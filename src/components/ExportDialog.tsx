import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Download,
  FileJson,
  FileSpreadsheet,
  Filter,
  Globe,
  Loader2,
  X,
} from 'lucide-react';
import type { SpotCategory, StatusFilterValue, VisitSpot } from '../types/visit';
import {
  buildExportFileName,
  buildExportZipArchive,
  filterSpotsForExport,
  generateCsv,
  generateGeoJson,
  generateKml,
  summarizeExportTargets,
  triggerBlobDownload,
  type ExportFormat,
  type ExportZipProgress,
} from '../lib/exportData';
import { SPOT_CATEGORY_LIST } from '../lib/spotCategories';
import { useUpdateBlocker } from '../lib/updateGuard';

interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  spots: VisitSpot[];
  mapStatusFilter: StatusFilterValue;
  onLocalExportRecorded: (iso: string) => Promise<void>;
}

type ExportScopeMode = 'all' | 'filtered';

function formatZipProgressText(progress: ExportZipProgress): string {
  if (progress.phase === 'preparing') {
    return 'エクスポートを準備中...';
  }
  if (progress.phase === 'reading-photos') {
    return `写真を読み込み中 (${progress.processed}/${progress.total})...`;
  }
  return 'ZIP アーカイブを作成中...';
}

export const ExportDialog: React.FC<ExportDialogProps> = ({
  isOpen,
  onClose,
  spots,
  mapStatusFilter,
  onLocalExportRecorded,
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [scopeMode, setScopeMode] = useState<ExportScopeMode>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>('all');
  const [categoryFilter, setCategoryFilter] = useState<SpotCategory | 'all'>('all');

  const [busyFormat, setBusyFormat] = useState<ExportFormat | null>(null);
  const busyRef = useRef(false);
  busyRef.current = busyFormat !== null;

  const [zipProgress, setZipProgress] = useState<ExportZipProgress | null>(null);
  const [statusMessage, setStatusMessage] = useState<{
    kind: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  useUpdateBlocker(isOpen);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      setScopeMode('all');
      setStatusFilter(mapStatusFilter);
      setCategoryFilter('all');
      setZipProgress(null);
      setStatusMessage(null);
      if (!dialog.open) {
        if (typeof dialog.showModal === 'function') {
          dialog.showModal();
        } else {
          dialog.setAttribute('open', '');
        }
      }
    } else if (dialog.open) {
      abortRef.current?.abort();
      if (typeof dialog.close === 'function') {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
      }
    }
  }, [isOpen, mapStatusFilter]);

  // Safari fallback for closedby="any"
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
        dialog.close?.('backdrop');
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

  const targetSpots = useMemo(() => {
    if (scopeMode === 'all') return spots;
    return filterSpotsForExport(spots, {
      status: statusFilter,
      category: categoryFilter,
    });
  }, [spots, scopeMode, statusFilter, categoryFilter]);

  const targetSummary = useMemo(() => summarizeExportTargets(targetSpots), [targetSpots]);

  const isBusy = busyFormat !== null;
  const isActionDisabled = isBusy || targetSummary.spotCount === 0;

  const handleExport = async (format: ExportFormat) => {
    if (busyRef.current || targetSpots.length === 0) return;

    busyRef.current = true;
    setBusyFormat(format);
    setStatusMessage(null);
    setZipProgress(null);

    const controller = format === 'zip' ? new AbortController() : null;
    abortRef.current = controller;

    try {
      if (format === 'zip') {
        const result = await buildExportZipArchive(targetSpots, {
          signal: controller?.signal,
          onProgress: (p) => setZipProgress(p),
        });
        triggerBlobDownload(result.blob, result.fileName);
        await onLocalExportRecorded(new Date().toISOString());

        if (result.manifest.missingPhotoCount > 0) {
          setStatusMessage({
            kind: 'info',
            text: `${result.fileName} のダウンロードを開始しました（${result.manifest.spotCount} 地点 / 写真 ${result.manifest.includedPhotoCount} 枚同梱 / 端末未保存・欠損 ${result.manifest.missingPhotoCount} 枚をスキップ）。`,
          });
        } else {
          setStatusMessage({
            kind: 'success',
            text: `${result.fileName} のダウンロードを開始しました（${result.manifest.spotCount} 地点 / 写真 ${result.manifest.includedPhotoCount} 枚同梱）。`,
          });
        }
        return;
      }

      const fileName = buildExportFileName(format);
      let blob: Blob;
      if (format === 'geojson') {
        blob = new Blob([generateGeoJson(targetSpots)], {
          type: 'application/geo+json;charset=utf-8',
        });
      } else if (format === 'csv') {
        blob = new Blob([generateCsv(targetSpots)], {
          type: 'text/csv;charset=utf-8',
        });
      } else {
        blob = new Blob([generateKml(targetSpots)], {
          type: 'application/vnd.google-earth.kml+xml;charset=utf-8',
        });
      }

      triggerBlobDownload(blob, fileName);
      await onLocalExportRecorded(new Date().toISOString());
      setStatusMessage({
        kind: 'success',
        text: `${fileName} のダウンロードを開始しました（${targetSummary.spotCount} 地点 / ${targetSummary.entryCount} 件の記録）。`,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setStatusMessage({
          kind: 'info',
          text: '写真付き ZIP の書き出しを中断しました。',
        });
      } else {
        setStatusMessage({
          kind: 'error',
          text: err instanceof Error ? err.message : 'データの書き出しに失敗しました。',
        });
      }
    } finally {
      abortRef.current = null;
      setZipProgress(null);
      busyRef.current = false;
      setBusyFormat(null);
    }
  };

  const formatCards: Array<{
    format: ExportFormat;
    id: string;
    title: string;
    extLabel: string;
    description: string;
    icon: React.ReactNode;
    accentClass: string;
  }> = [
    {
      format: 'geojson',
      id: 'export-geojson-btn',
      title: 'GeoJSON',
      extLabel: '.geojson',
      description: 'QGIS / Google Earth / GIS ツール向け（地点・標高・全ログ構造を保持）',
      icon: <FileJson className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />,
      accentClass: 'hover:border-emerald-400/60 hover:bg-emerald-500/10',
    },
    {
      format: 'csv',
      id: 'export-csv-btn',
      title: 'CSV（UTF-8 BOM付）',
      extLabel: '.csv',
      description: 'Excel / スプレッドシート / Googleマイマップ向け（1訪問ログ＝1行）',
      icon: <FileSpreadsheet className="w-4 h-4 text-sky-400 shrink-0" aria-hidden="true" />,
      accentClass: 'hover:border-sky-400/60 hover:bg-sky-500/10',
    },
    {
      format: 'kml',
      id: 'export-kml-btn',
      title: 'KML',
      extLabel: '.kml',
      description: 'Googleマイマップ / Google Earth ワンステップ取り込み向け（状態別フォルダ）',
      icon: <Globe className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />,
      accentClass: 'hover:border-amber-400/60 hover:bg-amber-500/10',
    },
    {
      format: 'zip',
      id: 'export-zip-btn',
      title: '写真付き ZIP アーカイブ',
      extLabel: '.zip',
      description: 'GeoJSON・CSV・KML・写真本体・manifest.json をまとめて書き出し',
      icon: <Archive className="w-4 h-4 text-indigo-400 shrink-0" aria-hidden="true" />,
      accentClass: 'hover:border-indigo-400/60 hover:bg-indigo-500/10',
    },
  ];

  return (
    <dialog
      ref={dialogRef}
      id="data-export-dialog"
      aria-labelledby="data-export-title"
      onClose={handleDialogClose}
      onCancel={(e) => {
        if (isBusy) e.preventDefault();
      }}
      {...({ closedby: isBusy ? 'none' : 'any' } as Record<string, string>)}
      className="visit-modal"
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2">
          <Download className="w-5 h-5 text-sky-400" aria-hidden="true" />
          <h2 id="data-export-title" className="text-base font-bold text-white">
            データ書き出し
          </h2>
        </div>
        <button
          type="button"
          autoFocus
          disabled={isBusy}
          onClick={() => {
            if (typeof dialogRef.current?.close === 'function') {
              dialogRef.current.close('close-btn');
            } else {
              handleDialogClose();
            }
          }}
          aria-label="閉じる"
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer disabled:opacity-40"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 space-y-4 overflow-y-auto text-xs">
        {zipProgress && (
          <div
            role="status"
            aria-live="polite"
            className="p-3 rounded-xl border border-indigo-500/50 bg-indigo-500/15 text-indigo-100 space-y-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2 min-w-0 font-semibold">
                <Loader2 className="w-4 h-4 animate-spin text-indigo-300 shrink-0" aria-hidden="true" />
                <span className="truncate">{formatZipProgressText(zipProgress)}</span>
              </span>
              <button
                type="button"
                onClick={() => abortRef.current?.abort()}
                className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-100 font-semibold shrink-0 cursor-pointer"
              >
                中断
              </button>
            </div>
            {zipProgress.total > 0 && (
              <div className="w-full h-1.5 rounded-full bg-slate-900 overflow-hidden">
                <div
                  className="h-full bg-indigo-400 transition-all duration-150"
                  style={{
                    width: `${Math.min(100, Math.round((zipProgress.processed / zipProgress.total) * 100))}%`,
                  }}
                />
              </div>
            )}
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

        {/* 書き出し対象選択 */}
        <section className="p-3.5 rounded-2xl bg-slate-950/75 border border-slate-800 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 font-bold text-slate-100 text-sm">
              <Filter className="w-4 h-4 text-sky-400" aria-hidden="true" />
              <span>書き出し対象</span>
            </div>
            {mapStatusFilter !== 'all' && scopeMode === 'all' && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => {
                  setStatusFilter(mapStatusFilter);
                  setScopeMode('filtered');
                }}
                className="text-[11px] px-2 py-0.5 rounded-full bg-sky-500/15 hover:bg-sky-500/25 border border-sky-400/40 text-sky-200 font-semibold cursor-pointer disabled:opacity-50"
              >
                マップ絞り込み（{mapStatusFilter === 'visited' ? '訪問済み' : '訪問予定'}）を適用
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              id="export-scope-all-btn"
              disabled={isBusy}
              aria-pressed={scopeMode === 'all'}
              onClick={() => setScopeMode('all')}
              className={`py-2 px-3 rounded-xl border font-semibold transition-colors cursor-pointer disabled:opacity-50 ${
                scopeMode === 'all'
                  ? 'bg-sky-500/20 border-sky-400/60 text-white'
                  : 'bg-slate-900/70 border-slate-800 text-slate-300 hover:border-slate-700'
              }`}
            >
              すべての地点（{spots.length}件）
            </button>
            <button
              type="button"
              id="export-scope-filtered-btn"
              disabled={isBusy}
              aria-pressed={scopeMode === 'filtered'}
              onClick={() => setScopeMode('filtered')}
              className={`py-2 px-3 rounded-xl border font-semibold transition-colors cursor-pointer disabled:opacity-50 ${
                scopeMode === 'filtered'
                  ? 'bg-sky-500/20 border-sky-400/60 text-white'
                  : 'bg-slate-900/70 border-slate-800 text-slate-300 hover:border-slate-700'
              }`}
            >
              条件で絞り込む
            </button>
          </div>

          {scopeMode === 'filtered' && (
            <div className="space-y-2.5 pt-1 border-t border-slate-800/80">
              <div>
                <div className="text-[11px] text-slate-400 mb-1">ステータス</div>
                <div className="flex flex-wrap gap-1.5">
                  {(
                    [
                      { id: 'all', label: 'すべて' },
                      { id: 'visited', label: '訪問済み' },
                      { id: 'planned', label: '訪問予定' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      disabled={isBusy}
                      aria-pressed={statusFilter === opt.id}
                      onClick={() => setStatusFilter(opt.id)}
                      className={`px-2.5 py-1 rounded-lg border text-[11px] font-semibold cursor-pointer disabled:opacity-50 ${
                        statusFilter === opt.id
                          ? 'bg-emerald-500/20 border-emerald-400/60 text-emerald-100'
                          : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-[11px] text-slate-400 mb-1">カテゴリ</div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    disabled={isBusy}
                    aria-pressed={categoryFilter === 'all'}
                    onClick={() => setCategoryFilter('all')}
                    className={`px-2.5 py-1 rounded-lg border text-[11px] font-semibold cursor-pointer disabled:opacity-50 ${
                      categoryFilter === 'all'
                        ? 'bg-sky-500/20 border-sky-400/60 text-sky-100'
                        : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    すべて
                  </button>
                  {SPOT_CATEGORY_LIST.map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      disabled={isBusy}
                      aria-pressed={categoryFilter === cat.id}
                      onClick={() => setCategoryFilter(cat.id)}
                      className={`px-2.5 py-1 rounded-lg border text-[11px] font-semibold cursor-pointer disabled:opacity-50 ${
                        categoryFilter === cat.id
                          ? 'bg-sky-500/20 border-sky-400/60 text-sky-100'
                          : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div
            data-testid="export-target-summary"
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-xl bg-slate-900/90 border border-slate-800 text-[11px]"
          >
            <span className="text-slate-400">書き出し対象</span>
            <span className="font-semibold text-slate-100 tabular-nums">
              {targetSummary.spotCount} 地点 / {targetSummary.entryCount} 件の記録 / 写真{' '}
              {targetSummary.photoCount} 枚
            </span>
          </div>

          {targetSummary.spotCount === 0 && (
            <p className="text-[11px] text-amber-300">
              書き出し対象の地点がありません。条件を変更するか、地点を登録してからお試しください。
            </p>
          )}
        </section>

        {/* 出力形式選択 */}
        <section className="space-y-2">
          <div className="font-bold text-slate-200 text-sm">形式を選んでダウンロード</div>
          <div className="space-y-2">
            {formatCards.map((card) => {
              const runningThis = busyFormat === card.format;
              return (
                <button
                  key={card.format}
                  type="button"
                  id={card.id}
                  disabled={isActionDisabled}
                  onClick={() => void handleExport(card.format)}
                  className={`w-full text-left p-3 rounded-2xl bg-slate-950/75 border border-slate-800 transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${card.accentClass}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 font-bold text-slate-100 text-sm">
                      {runningThis ? (
                        <Loader2 className="w-4 h-4 animate-spin text-sky-400 shrink-0" aria-hidden="true" />
                      ) : (
                        card.icon
                      )}
                      <span>{card.title}</span>
                    </span>
                    <span className="px-2 py-0.5 rounded-md bg-slate-900 border border-slate-700 font-mono text-[10px] text-slate-300">
                      {card.extLabel}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1 leading-snug">{card.description}</p>
                  {card.format === 'zip' && (
                    <p className="text-[10px] text-slate-500 mt-1 leading-snug">
                      ※ 端末にキャッシュ済みの写真を同梱します（未取得・欠損写真は自動スキップ）。
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </dialog>
  );
};
