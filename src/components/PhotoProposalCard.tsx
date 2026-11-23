import React from 'react';
import {
  AlertCircle,
  Calendar,
  Camera,
  CheckCircle2,
  Loader2,
  MapPin,
  Mountain,
  Plus,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { VisitDate } from '../types/visit';
import type { MatchedPresetMountain, MatchedRegisteredSpot } from '../lib/spotDomain';
import type { OsmPlaceContext } from '../lib/osmPlaceClient';
import { formatDistanceLabel } from '../lib/osmPlaceClient';
import { formatVisitDate } from '../lib/visitDate';

export interface PhotoProposalState {
  fileCount: number;
  acceptedCount: number;
  gpsCenter: [number, number] | null;
  gpsAltitude?: number;
  hasSpreadLocations: boolean;
  suggestedDate: VisitDate | null;
  nearbySpots: MatchedRegisteredSpot[];
  nearbyMountain: MatchedPresetMountain | null;
  osmContext: OsmPlaceContext | null;
  isLoadingOsm: boolean;
  isPreparingDraft: boolean;
  errorMessage?: string | null;
}

interface PhotoProposalCardProps {
  proposal: PhotoProposalState;
  onAcceptAddEntry: (spotId: string) => void;
  onAcceptCreateSpot: () => void;
  onDismiss: () => void;
}

export const PhotoProposalCard: React.FC<PhotoProposalCardProps> = ({
  proposal,
  onAcceptAddEntry,
  onAcceptCreateSpot,
  onDismiss,
}) => {
  const hasGps = proposal.gpsCenter !== null;
  const primarySpot = proposal.nearbySpots[0] ?? null;
  const mountainMatch = proposal.nearbyMountain;
  const osmTopCandidate = proposal.osmContext?.candidates[0] ?? null;

  return (
    <section
      aria-label="写真からのスポット提案"
      className="pointer-events-auto fixed bottom-3 left-3 right-3 sm:left-4 sm:right-auto sm:w-[26rem] z-30 rounded-2xl bg-slate-900/95 backdrop-blur-md border border-sky-500/50 shadow-2xl p-4 max-h-[75dvh] overflow-y-auto space-y-3"
      style={{ marginBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sky-400 text-xs font-bold">
            <Camera className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>写真からのスポット提案（{proposal.acceptedCount}枚）</span>
          </div>
          {proposal.suggestedDate && (
            <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-emerald-300 font-medium">
              <Calendar className="w-3 h-3 shrink-0" aria-hidden="true" />
              <span>検出された撮影日: {formatVisitDate(proposal.suggestedDate)}</span>
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          disabled={proposal.isPreparingDraft}
          aria-label="提案を閉じる"
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {proposal.errorMessage && (
        <div className="p-2.5 rounded-xl bg-rose-950/60 border border-rose-500/50 text-xs text-rose-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" aria-hidden="true" />
          <span>{proposal.errorMessage}</span>
        </div>
      )}

      {!hasGps ? (
        <div className="space-y-2.5">
          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-400/40 text-xs text-amber-100 space-y-1">
            <p className="font-semibold">
              位置情報が見つからないため地図から場所を選択してください
            </p>
            <p className="text-[11px] text-amber-200/80 leading-relaxed">
              選択した写真に GPS 情報が含まれていないか、読み取れない形式でした。地図をタップして地点を選ぶと、通常の登録フォームから写真を添付できます。
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="w-full py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-semibold border border-slate-700 cursor-pointer"
          >
            閉じる
          </button>
        </div>
      ) : (
        <div className="space-y-2.5">
          <p className="text-[11px] text-slate-400 font-mono flex items-center gap-1.5">
            <MapPin className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
            <span>
              {proposal.gpsCenter![1].toFixed(4)}, {proposal.gpsCenter![0].toFixed(4)}
            </span>
            {proposal.gpsAltitude !== undefined && (
              <span className="text-emerald-300">· 標高約 {Math.round(proposal.gpsAltitude)}m</span>
            )}
          </p>

          {proposal.hasSpreadLocations && (
            <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-400/30 rounded-lg px-2.5 py-1.5">
              ※ 複数地点の写真が含まれるため、最初の位置情報をもとに提案しています。
            </p>
          )}

          {primarySpot ? (
            <div className="space-y-2">
              <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-400/40 space-y-2">
                <p className="text-xs font-bold text-emerald-200 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>近くの登録済みスポットが見つかりました</span>
                </p>
                <div className="space-y-1.5">
                  {proposal.nearbySpots.slice(0, 3).map((item) => (
                    <div
                      key={item.spot.id}
                      className="flex items-center justify-between gap-2 p-2 rounded-lg bg-slate-950/70 border border-slate-800"
                    >
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-white truncate">{item.spot.name}</p>
                        <p className="text-[10px] text-slate-400">
                          写真の位置から {formatDistanceLabel(item.distanceMeters)}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={proposal.isPreparingDraft}
                        onClick={() => onAcceptAddEntry(item.spot.id)}
                        className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-[11px] font-bold cursor-pointer"
                      >
                        {proposal.isPreparingDraft ? (
                          <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                        ) : (
                          <Plus className="w-3 h-3" aria-hidden="true" />
                        )}
                        <span>記録を追加</span>
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <button
                type="button"
                disabled={proposal.isPreparingDraft}
                onClick={onAcceptCreateSpot}
                className="w-full py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-xs font-semibold border border-slate-700 cursor-pointer"
              >
                別の新規スポットとして作成
              </button>
            </div>
          ) : mountainMatch ? (
            <div className="p-3 rounded-xl bg-sky-500/10 border border-sky-400/40 space-y-2.5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[11px] font-bold text-sky-300 flex items-center gap-1">
                    <Mountain className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>日本百名山プリセットに一致</span>
                  </p>
                  <p className="text-sm font-bold text-white mt-0.5">
                    {mountainMatch.mountain.name}
                  </p>
                  <p className="text-[11px] text-slate-300">
                    {mountainMatch.mountain.region} · 標高 {mountainMatch.mountain.elevation}m ·{' '}
                    {formatDistanceLabel(mountainMatch.distanceMeters)}
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={proposal.isPreparingDraft}
                onClick={onAcceptCreateSpot}
                className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-xs font-bold shadow cursor-pointer"
              >
                {proposal.isPreparingDraft ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Plus className="w-4 h-4" aria-hidden="true" />
                )}
                <span>「{mountainMatch.mountain.name}」として新規登録</span>
              </button>
            </div>
          ) : (
            <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 space-y-2.5">
              {proposal.isLoadingOsm ? (
                <div className="flex items-center gap-2 text-xs text-slate-300">
                  <Loader2 className="w-4 h-4 animate-spin text-sky-400 shrink-0" aria-hidden="true" />
                  <span>周辺の地名・施設候補を取得しています...</span>
                </div>
              ) : (
                <div>
                  <p className="text-[11px] text-slate-400">推定された場所</p>
                  <p className="text-sm font-bold text-white mt-0.5">
                    {osmTopCandidate?.name ||
                      proposal.osmContext?.addressSummary ||
                      '写真の撮影地点'}
                  </p>
                  {proposal.osmContext?.addressSummary &&
                    osmTopCandidate?.name !== proposal.osmContext.addressSummary && (
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        {proposal.osmContext.addressSummary}
                      </p>
                    )}
                </div>
              )}

              <button
                type="button"
                disabled={proposal.isPreparingDraft}
                onClick={onAcceptCreateSpot}
                className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold shadow cursor-pointer"
              >
                {proposal.isPreparingDraft ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Plus className="w-4 h-4" aria-hidden="true" />
                )}
                <span>この場所に新規スポットを作成</span>
              </button>
            </div>
          )}
        </div>
      )}

      <p className="text-[10px] text-slate-400 flex items-start gap-1.5 pt-1 border-t border-slate-800/80 leading-relaxed">
        <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
        <span>位置情報は場所の提案にのみ使用され、保存画像からは EXIF が削除されます。</span>
      </p>
    </section>
  );
};
