import React from 'react';
import {
  Settings,
  Mountain,
  Layers,
  ChevronUp,
  ShieldCheck,
  FileText,
  Share2,
  Map as MapIcon,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type { BaseMapId, PrefectureStats, WebGPUStatus } from '../types/visit';
import { BASE_MAP_SOURCES } from '../lib/maplibreHelper';
import { PrefectureSummaryLegend } from './PrefectureSummaryLegend';

const SUPPORTS_NATIVE_SWITCH =
  typeof HTMLInputElement !== 'undefined' && 'switch' in HTMLInputElement.prototype;

interface LayerMenuProps {
  exaggeration: number;
  onChangeExaggeration: (val: number) => void;
  baseMap: BaseMapId;
  onChangeBaseMap: (id: BaseMapId) => void;
  prefectureFillEnabled: boolean;
  onTogglePrefectureFill: (enabled: boolean) => void;
  prefectureStats: PrefectureStats | null;
  isPrefectureLoading?: boolean;
  prefectureLoadError?: string | null;
  onRetryPrefectureLoad?: () => void;
  gpuStatus: WebGPUStatus;
  isOpen: boolean;
  onToggleOpen: () => void;
  onShareView: () => void;
  onNavigatePolicy: (page: 'privacy' | 'terms') => void;
  connected?: boolean;
}

export const LayerMenu: React.FC<LayerMenuProps> = ({
  exaggeration,
  onChangeExaggeration,
  baseMap,
  onChangeBaseMap,
  prefectureFillEnabled,
  onTogglePrefectureFill,
  prefectureStats,
  isPrefectureLoading = false,
  prefectureLoadError = null,
  onRetryPrefectureLoad,
  gpuStatus,
  isOpen,
  onToggleOpen,
  onShareView,
  onNavigatePolicy,
  connected = false,
}) => {
  return (
    <aside
      aria-label="表示設定メニュー"
      className="vt-layer-menu pointer-events-auto relative flex items-center shrink-0"
    >
      <button
        type="button"
        id="layer-menu-toggle-btn"
        onClick={onToggleOpen}
        aria-expanded={isOpen}
        aria-controls="layer-menu-panel"
        aria-label="設定"
        className={
          connected
            ? 'whitespace-nowrap inline-flex items-center gap-1 sm:gap-1.5 min-h-[38px] sm:min-h-[42px] px-2.5 sm:px-3.5 py-1 hover:bg-slate-800/90 text-xs sm:text-sm font-bold text-slate-100 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400'
            : 'inline-flex items-center gap-1 sm:gap-1.5 min-h-[38px] sm:min-h-[42px] px-2.5 sm:px-3.5 py-1.5 rounded-xl bg-slate-900/90 hover:bg-slate-800/95 backdrop-blur-md border border-slate-700/80 shadow-lg text-xs sm:text-sm font-bold text-slate-100 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400'
        }
      >
        <Settings
          className={`w-4 h-4 text-sky-400 transition-transform duration-300 shrink-0 ${
            isOpen ? 'rotate-90' : 'rotate-0'
          }`}
          aria-hidden="true"
        />
        <span className="hidden sm:inline">設定</span>
        <ChevronUp
          className={`hidden sm:block w-4 h-4 text-slate-400 transition-transform duration-200 shrink-0 ${
            isOpen ? 'rotate-0' : 'rotate-180'
          }`}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <div
          id="layer-menu-panel"
          className="safe-top-dropdown fixed z-30 rounded-2xl bg-slate-900/95 backdrop-blur-md border border-slate-700/80 shadow-2xl p-3.5 text-xs text-slate-100 w-80 max-w-[calc(100vw-1.5rem)] space-y-3.5 overflow-y-auto"
        >
          {/* 地形高さ強調 */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="exaggeration-slider"
                className="flex items-center gap-1.5 font-semibold text-slate-200"
              >
                <Mountain className="w-4 h-4 text-emerald-400" aria-hidden="true" />
                <span>3D 地形の高さ強調</span>
              </label>
              <span className="font-mono text-sky-300 font-bold">{exaggeration.toFixed(1)}x</span>
            </div>
            <input
              id="exaggeration-slider"
              type="range"
              min="1.0"
              max="3.0"
              step="0.1"
              value={exaggeration}
              onChange={(e) => onChangeExaggeration(Number(e.target.value))}
              className="w-full h-2 rounded-lg bg-slate-800 cursor-pointer accent-sky-400"
            />
          </div>

          {/* 背景地図切替 */}
          <div>
            <div className="flex items-center gap-1.5 font-semibold text-slate-200 mb-1.5">
              <Layers className="w-4 h-4 text-sky-400" aria-hidden="true" />
              <span>背景地図</span>
            </div>
            <div className="space-y-1.5">
              {(Object.keys(BASE_MAP_SOURCES) as BaseMapId[]).map((id) => {
                const src = BASE_MAP_SOURCES[id];
                const active = baseMap === id;
                return (
                  <button
                    key={id}
                    type="button"
                    id={`basemap-btn-${id}`}
                    onClick={() => onChangeBaseMap(id)}
                    aria-pressed={active}
                    className={`w-full text-left px-2.5 py-2 rounded-xl border transition-colors cursor-pointer ${
                      active
                        ? 'bg-sky-500/20 border-sky-400/60 text-white'
                        : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:border-slate-600'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1.5 font-semibold">
                      <span>{src.name}</span>
                      {active && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/30 text-sky-200">
                          選択中
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">
                      {src.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* オーバーレイ表示（日本地図塗りつぶしモード） */}
          <div className="pt-2 border-t border-slate-800 space-y-2">
            <div className="flex items-center gap-1.5 font-semibold text-slate-200">
              <MapIcon className="w-4 h-4 text-emerald-400" aria-hidden="true" />
              <span>オーバーレイ表示</span>
            </div>

            <label
              htmlFor="prefecture-fill-toggle"
              className="flex items-center justify-between gap-2.5 px-2.5 py-2 rounded-xl border border-slate-800 bg-slate-950/60 hover:border-slate-700 cursor-pointer transition-colors"
            >
              <span className="min-w-0">
                <span className="block font-semibold text-slate-100">都道府県塗りつぶし</span>
                <span className="block text-[11px] text-slate-400 mt-0.5 leading-snug">
                  47都道府県の訪問・予定状況を色分け
                </span>
              </span>
              <input
                id="prefecture-fill-toggle"
                type="checkbox"
                role="switch"
                checked={prefectureFillEnabled}
                onChange={(e) => onTogglePrefectureFill(e.target.checked)}
                {...({ switch: '' } as Record<string, string>)}
                className={
                  SUPPORTS_NATIVE_SWITCH ? 'visit-switch-native' : 'visit-switch-fallback'
                }
              />
            </label>

            {prefectureFillEnabled && (
              <div
                data-testid="layer-menu-prefecture-summary"
                className="rounded-xl bg-slate-950/75 border border-slate-800/90 p-2.5 space-y-2"
              >
                {isPrefectureLoading && !prefectureStats && (
                  <div className="flex items-center gap-1.5 text-[11px] text-sky-300">
                    <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden="true" />
                    <span>都道府県データを読み込み中...</span>
                  </div>
                )}

                {prefectureLoadError && !isPrefectureLoading && (
                  <div className="space-y-1.5 text-[11px] text-rose-300">
                    <p className="leading-snug">{prefectureLoadError}</p>
                    {onRetryPrefectureLoad && (
                      <button
                        type="button"
                        onClick={onRetryPrefectureLoad}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-400/40 text-rose-100 font-semibold cursor-pointer"
                      >
                        <RefreshCw className="w-3 h-3" aria-hidden="true" />
                        <span>再試行</span>
                      </button>
                    )}
                  </div>
                )}

                {prefectureStats && (
                  <PrefectureSummaryLegend stats={prefectureStats} showProgressBar />
                )}
              </div>
            )}
          </div>

          {/* 3D視点リンク共有 */}
          <div className="pt-2 border-t border-slate-800">
            <button
              type="button"
              onClick={onShareView}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold border border-slate-700 transition-colors cursor-pointer"
            >
              <Share2 className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
              <span>現在の3D視点リンクを共有</span>
            </button>
            <p className="text-[10px] text-slate-400 mt-1 leading-tight">
              ※ 共有リンクには座標・視点のみ含まれ、訪問日やメモは含まれません。
            </p>
          </div>

          {/* 描画エンジン情報 & 法務リンク */}
          <div className="pt-2 border-t border-slate-800 space-y-2 text-[11px] text-slate-400">
            <div className="flex items-center justify-between">
              <span>描画エンジン</span>
              <span className="font-mono text-slate-200">
                {gpuStatus.backend.toUpperCase()} {gpuStatus.fps > 0 ? `· ${gpuStatus.fps}fps` : ''}
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 pt-1">
              <button
                type="button"
                onClick={() => onNavigatePolicy('privacy')}
                className="inline-flex items-center gap-1 whitespace-nowrap text-sky-400 hover:text-sky-300 underline cursor-pointer"
              >
                <ShieldCheck className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>プライバシーポリシー</span>
              </button>
              <button
                type="button"
                onClick={() => onNavigatePolicy('terms')}
                className="inline-flex items-center gap-1 whitespace-nowrap text-sky-400 hover:text-sky-300 underline cursor-pointer"
              >
                <FileText className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>利用規約・クレジット</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};
