import React, { useEffect, useState } from 'react';
import {
  Calendar,
  Camera,
  Check,
  CheckCircle2,
  Clock,
  Cloud,
  Edit3,
  Image as ImageIcon,
  Loader2,
  MapPin,
  Mountain,
  Navigation,
  Pin,
  Plus,
  Share2,
  Trash2,
  X,
} from 'lucide-react';
import type {
  DraftPhotoItem,
  InspectedPoint,
  PhotoAttachment,
  SpotCategory,
  SpotStatus,
  StoredPhotoRecord,
  VisitDate,
  VisitEntry,
  VisitSpot,
} from '../types/visit';
import { getSpotCategoryMeta } from '../lib/spotCategories';
import { formatVisitDate, getTodayDateString } from '../lib/visitDate';
import { fetchOsmPlaceContext, type OsmPlaceCandidate } from '../lib/osmPlaceClient';
import { isHybridSpot } from '../lib/spotDomain';
import { hasActiveMemoryToken, requestDriveAccessToken } from '../lib/googleAuth';
import { hasStoredPhoto } from '../lib/photoStorage';
import { ensurePhotoCached, isRemotePhotoKnownMissing } from '../lib/photoSyncManager';
import { usePhotoObjectUrl } from '../lib/photoUrlCache';
import { SpotForm, type SpotFormMode, type SpotFormSubmitPayload } from './SpotForm';
import { PhotoLightbox } from './PhotoLightbox';
import { useUpdateBlocker } from '../lib/updateGuard';

export interface PendingPhotoDraft {
  key: string;
  targetMode: 'create-spot' | 'add-entry';
  draftPhotos: DraftPhotoItem[];
  suggestedDate?: VisitDate;
  suggestedName?: string;
  suggestedCategory?: SpotCategory;
}

interface SpotDetailSheetProps {
  selectedSpot: VisitSpot | null;
  inspectedPoint: InspectedPoint | null;
  nearbyDuplicateSpot?: VisitSpot | null;
  pendingPhotoDraft?: PendingPhotoDraft | null;
  onClearPendingPhotoDraft?: () => void;
  photoCacheVersion?: number;
  onPhotoCached?: () => void;
  onClose: () => void;
  onSelectExistingSpot: (spot: VisitSpot) => void;
  onCreateSpot: (payload: {
    point: InspectedPoint;
    name: string;
    category: SpotCategory;
    isPinned: boolean;
    kind: SpotStatus;
    date: VisitEntry['date'];
    memo: string;
    photos?: PhotoAttachment[];
    newPhotoRecords?: StoredPhotoRecord[];
  }) => Promise<void>;
  onUpdateSpotMeta: (
    spotId: string,
    patch: { name?: string; category?: SpotCategory; isPinned?: boolean }
  ) => Promise<void>;
  onUpdateSpotCamera: (spotId: string) => Promise<void>;
  onDeleteSpot: (spotId: string) => Promise<void>;
  onAddEntry: (
    spotId: string,
    payload: {
      kind: SpotStatus;
      date: VisitEntry['date'];
      memo: string;
      photos?: PhotoAttachment[];
      newPhotoRecords?: StoredPhotoRecord[];
    }
  ) => Promise<void>;
  onUpdateEntry: (
    spotId: string,
    entryId: string,
    payload: {
      kind: SpotStatus;
      date: VisitEntry['date'];
      memo: string;
      photos?: PhotoAttachment[];
      newPhotoRecords?: StoredPhotoRecord[];
    }
  ) => Promise<void>;
  onDeleteEntry: (spotId: string, entryId: string) => Promise<void>;
  onSharePoint: (lng: number, lat: number, name?: string) => void;
  onFlyToSpot: (spot: VisitSpot) => void;
}

type RemotePhotoStatus = 'loading' | 'needs-auth' | 'offline' | 'missing-remote' | 'error';

const EntryPhotoThumb: React.FC<{
  photo: PhotoAttachment;
  index: number;
  photoCacheVersion: number;
  remoteStatus?: RemotePhotoStatus;
  onOpen: () => void;
}> = ({ photo, index, photoCacheVersion, remoteStatus, onOpen }) => {
  const { url, loading } = usePhotoObjectUrl(photo.id, 'thumb', photoCacheVersion);
  const isFetching = loading || remoteStatus === 'loading';
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={photo.caption ? `写真を拡大: ${photo.caption}` : `写真 ${index + 1} を拡大`}
      title={photo.caption}
      className="group relative aspect-square rounded-lg overflow-hidden border border-slate-700/80 hover:border-sky-400/80 bg-slate-900 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
    >
      {url ? (
        <img
          src={url}
          alt={photo.caption || `訪問写真 ${index + 1}`}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
        />
      ) : isFetching ? (
        <div className="w-full h-full flex items-center justify-center text-slate-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" aria-hidden="true" />
        </div>
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-0.5 px-1 text-[9px] text-slate-400">
          {remoteStatus === 'missing-remote' ? (
            <>
              <ImageIcon className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
              <span>Drive未検出</span>
            </>
          ) : remoteStatus === 'offline' ? (
            <>
              <Cloud className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
              <span>オフライン</span>
            </>
          ) : photo.driveFileId ? (
            <>
              <Cloud className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
              <span>未取得</span>
            </>
          ) : (
            <ImageIcon className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
          )}
        </div>
      )}
    </button>
  );
};

const EntryPhotoStrip: React.FC<{
  photos: PhotoAttachment[];
  photoCacheVersion: number;
  remoteStatusById: Record<string, RemotePhotoStatus>;
  onLoadRemote: (photos: PhotoAttachment[]) => void;
  onOpen: (index: number) => void;
}> = ({ photos, photoCacheVersion, remoteStatusById, onLoadRemote, onOpen }) => {
  if (photos.length === 0) return null;
  const needsAuthPhotos = photos.filter(
    (p) => p.driveFileId && (remoteStatusById[p.id] === 'needs-auth' || remoteStatusById[p.id] === 'error')
  );
  return (
    <div className="pt-1 space-y-1.5">
      <div className="grid grid-cols-5 gap-1.5">
        {photos.map((photo, index) => (
          <EntryPhotoThumb
            key={photo.id}
            photo={photo}
            index={index}
            photoCacheVersion={photoCacheVersion}
            remoteStatus={remoteStatusById[photo.id]}
            onOpen={() => onOpen(index)}
          />
        ))}
      </div>
      {needsAuthPhotos.length > 0 && (
        <button
          type="button"
          onClick={() => onLoadRemote(needsAuthPhotos)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-sky-600/25 hover:bg-sky-600/40 border border-sky-400/40 text-sky-200 text-[11px] font-semibold cursor-pointer"
        >
          <Cloud className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Drive から写真を読み込む（{needsAuthPhotos.length}枚）</span>
        </button>
      )}
    </div>
  );
};

type ActiveFormState =
  | { mode: 'create-spot'; defaultKind: SpotStatus }
  | { mode: 'edit-spot' }
  | { mode: 'add-entry'; defaultKind: SpotStatus }
  | { mode: 'edit-entry'; entry: VisitEntry }
  | { mode: 'convert-to-visited'; entry: VisitEntry }
  | null;

export const SpotDetailSheet: React.FC<SpotDetailSheetProps> = ({
  selectedSpot,
  inspectedPoint,
  nearbyDuplicateSpot,
  pendingPhotoDraft = null,
  onClearPendingPhotoDraft,
  photoCacheVersion = 0,
  onPhotoCached,
  onClose,
  onSelectExistingSpot,
  onCreateSpot,
  onUpdateSpotMeta,
  onUpdateSpotCamera,
  onDeleteSpot,
  onAddEntry,
  onUpdateEntry,
  onDeleteEntry,
  onSharePoint,
  onFlyToSpot,
}) => {
  const [formState, setFormState] = useState<ActiveFormState>(null);
  const [submitting, setSubmitting] = useState(false);
  const [isPhotoProcessing, setIsPhotoProcessing] = useState(false);
  const [lightboxState, setLightboxState] = useState<{
    photos: PhotoAttachment[];
    index: number;
  } | null>(null);
  const [remoteStatusById, setRemoteStatusById] = useState<Record<string, RemotePhotoStatus>>({});
  const [confirmDeleteSpot, setConfirmDeleteSpot] = useState(false);
  const [confirmDeleteEntryId, setConfirmDeleteEntryId] = useState<string | null>(null);
  const [osmCandidates, setOsmCandidates] = useState<OsmPlaceCandidate[]>([]);
  const [addressSummary, setAddressSummary] = useState<string | undefined>(undefined);
  const [isLoadingOsm, setIsLoadingOsm] = useState(false);
  const [cameraSavedFeedback, setCameraSavedFeedback] = useState(false);

  useUpdateBlocker(formState !== null || submitting || isPhotoProcessing);

  useEffect(() => {
    const shouldAutoOpenCreate =
      pendingPhotoDraft?.targetMode === 'create-spot' && Boolean(inspectedPoint) && !selectedSpot;
    const shouldAutoOpenAddEntry =
      pendingPhotoDraft?.targetMode === 'add-entry' && Boolean(selectedSpot);

    if (shouldAutoOpenCreate) {
      setFormState({ mode: 'create-spot', defaultKind: 'visited' });
    } else if (shouldAutoOpenAddEntry) {
      setFormState({ mode: 'add-entry', defaultKind: 'visited' });
    } else {
      setFormState(null);
    }

    setIsPhotoProcessing(false);
    setLightboxState(null);
    setRemoteStatusById({});
    setConfirmDeleteSpot(false);
    setConfirmDeleteEntryId(null);
    setCameraSavedFeedback(false);
    setOsmCandidates([]);
    setAddressSummary(inspectedPoint?.addressSummary);
  }, [selectedSpot?.id, inspectedPoint?.lng, inspectedPoint?.lat, pendingPhotoDraft?.key]);

  const spotPhotoSignature =
    selectedSpot?.entries
      .flatMap((e) => e.photos.map((p) => `${p.id}:${p.driveFileId ?? ''}`))
      .join(',') ?? '';

  const runRemotePhotoFetch = async (
    targetPhotos: PhotoAttachment[],
    interactiveAuth: boolean,
    signal?: AbortSignal
  ) => {
    const unique: PhotoAttachment[] = [];
    const seen = new Set<string>();
    for (const p of targetPhotos) {
      if (p.driveFileId && !seen.has(p.id)) {
        seen.add(p.id);
        unique.push(p);
      }
    }
    if (unique.length === 0) return;

    let accessToken: string | undefined;
    if (interactiveAuth && !hasActiveMemoryToken()) {
      try {
        accessToken = await requestDriveAccessToken({ prompt: '' });
      } catch {
        setRemoteStatusById((prev) => {
          const next = { ...prev };
          for (const p of unique) next[p.id] = 'needs-auth';
          return next;
        });
        return;
      }
    }

    setRemoteStatusById((prev) => {
      const next = { ...prev };
      for (const p of unique) next[p.id] = 'loading';
      return next;
    });

    let cursor = 0;
    const workerCount = Math.min(3, unique.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          if (signal?.aborted) return;
          const idx = cursor++;
          if (idx >= unique.length) return;
          const photo = unique[idx];
          try {
            const res = await ensurePhotoCached(photo, {
              interactiveAuth,
              accessToken,
              signal,
            });
            if (signal?.aborted) return;
            if (res.status === 'cached' || res.status === 'downloaded') {
              setRemoteStatusById((prev) => {
                const next = { ...prev };
                delete next[photo.id];
                return next;
              });
              if (res.status === 'downloaded') {
                onPhotoCached?.();
              }
            } else {
              setRemoteStatusById((prev) => ({ ...prev, [photo.id]: res.status }));
            }
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') return;
            setRemoteStatusById((prev) => ({ ...prev, [photo.id]: 'error' }));
          }
        }
      })
    );
  };

  useEffect(() => {
    if (!selectedSpot || formState !== null) return;
    const remotePhotos = selectedSpot.entries
      .flatMap((e) => e.photos)
      .filter((p) => Boolean(p.driveFileId));
    if (remotePhotos.length === 0) return;

    const controller = new AbortController();
    void (async () => {
      const uncached: PhotoAttachment[] = [];
      const knownMissing: string[] = [];

      for (const p of remotePhotos) {
        if (controller.signal.aborted) return;
        if (isRemotePhotoKnownMissing(p.id)) {
          knownMissing.push(p.id);
          continue;
        }
        const stored = await hasStoredPhoto(p.id);
        if (!stored) uncached.push(p);
      }
      if (controller.signal.aborted) return;

      if (knownMissing.length > 0) {
        setRemoteStatusById((prev) => {
          const next = { ...prev };
          for (const id of knownMissing) next[id] = 'missing-remote';
          return next;
        });
      }

      if (uncached.length === 0) return;

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setRemoteStatusById((prev) => {
          const next = { ...prev };
          for (const p of uncached) next[p.id] = 'offline';
          return next;
        });
        return;
      }

      if (!hasActiveMemoryToken()) {
        setRemoteStatusById((prev) => {
          const next = { ...prev };
          for (const p of uncached) next[p.id] = 'needs-auth';
          return next;
        });
        return;
      }

      await runRemotePhotoFetch(uncached, false, controller.signal);
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSpot?.id, formState === null, spotPhotoSignature]);

  useEffect(() => {
    if (!inspectedPoint || selectedSpot) return;
    const controller = new AbortController();
    setIsLoadingOsm(true);

    void fetchOsmPlaceContext(inspectedPoint.lat, inspectedPoint.lng, {
      signal: controller.signal,
      onPartialUpdate: (ctx) => {
        if (!controller.signal.aborted) {
          setOsmCandidates(ctx.candidates);
          if (ctx.addressSummary) setAddressSummary(ctx.addressSummary);
        }
      },
    })
      .then((ctx) => {
        if (!controller.signal.aborted) {
          setOsmCandidates(ctx.candidates);
          if (ctx.addressSummary) setAddressSummary(ctx.addressSummary);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoadingOsm(false);
      });

    return () => controller.abort();
  }, [inspectedPoint?.lng, inspectedPoint?.lat, selectedSpot]);

  if (!selectedSpot && !inspectedPoint) return null;

  const handleFormSubmit = async (payload: SpotFormSubmitPayload) => {
    setSubmitting(true);
    try {
      if (formState?.mode === 'create-spot' && inspectedPoint) {
        await onCreateSpot({
          point: { ...inspectedPoint, addressSummary },
          name: payload.name!,
          category: payload.category!,
          isPinned: Boolean(payload.isPinned),
          kind: payload.kind!,
          date: payload.date!,
          memo: payload.memo ?? '',
          photos: payload.photos,
          newPhotoRecords: payload.newPhotoRecords,
        });
        onClearPendingPhotoDraft?.();
        setFormState(null);
      } else if (formState?.mode === 'edit-spot' && selectedSpot) {
        await onUpdateSpotMeta(selectedSpot.id, {
          name: payload.name,
          category: payload.category,
          isPinned: payload.isPinned,
        });
        setFormState(null);
      } else if (formState?.mode === 'add-entry' && selectedSpot) {
        await onAddEntry(selectedSpot.id, {
          kind: payload.kind!,
          date: payload.date!,
          memo: payload.memo ?? '',
          photos: payload.photos,
          newPhotoRecords: payload.newPhotoRecords,
        });
        onClearPendingPhotoDraft?.();
        setFormState(null);
      } else if (
        (formState?.mode === 'edit-entry' || formState?.mode === 'convert-to-visited') &&
        selectedSpot
      ) {
        await onUpdateEntry(selectedSpot.id, formState.entry.id, {
          kind: formState.mode === 'convert-to-visited' ? 'visited' : payload.kind!,
          date: payload.date!,
          memo: payload.memo ?? '',
          photos: payload.photos,
          newPhotoRecords: payload.newPhotoRecords,
        });
        setFormState(null);
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Unregistered inspected point card
  if (!selectedSpot && inspectedPoint) {
    return (
      <section
        aria-label="地点登録シート"
        className="vt-detail-sheet pointer-events-auto fixed bottom-3 left-3 right-3 sm:left-4 sm:right-auto sm:w-[26rem] z-20 rounded-2xl bg-slate-900/95 backdrop-blur-md border border-slate-700/85 shadow-2xl p-4 max-h-[75dvh] overflow-y-auto"
        style={{ marginBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <div className="flex items-start justify-between gap-2 mb-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sky-400 text-xs font-bold mb-0.5">
              <MapPin className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>選択した地点</span>
            </div>
            <h2 className="vt-detail-title text-base font-bold text-white truncate">
              {inspectedPoint.label ||
                osmCandidates[0]?.name ||
                `地点 (${inspectedPoint.lat.toFixed(4)}, ${inspectedPoint.lng.toFixed(4)})`}
            </h2>
            <p className="text-[11px] text-slate-400 mt-0.5 flex flex-wrap items-center gap-x-2">
              {addressSummary && <span>{addressSummary}</span>}
              <span className="font-mono">
                {inspectedPoint.lat.toFixed(4)}, {inspectedPoint.lng.toFixed(4)}
              </span>
              <span className="inline-flex items-center gap-0.5 text-emerald-300">
                <Mountain className="w-3 h-3" aria-hidden="true" />
                {inspectedPoint.elevation !== null
                  ? `標高 ${inspectedPoint.elevation.toLocaleString()}m`
                  : '標高データなし'}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {nearbyDuplicateSpot && formState === null && (
          <div className="mb-3 p-2.5 rounded-xl bg-amber-500/15 border border-amber-400/40 text-xs text-amber-100 space-y-1.5">
            <p className="font-semibold">
              すぐ近く（約50m以内）に登録済みの地点「{nearbyDuplicateSpot.name}」があります。
            </p>
            <button
              type="button"
              onClick={() => onSelectExistingSpot(nearbyDuplicateSpot)}
              className="px-2.5 py-1 rounded-lg bg-amber-500/30 hover:bg-amber-500/45 text-amber-50 font-semibold cursor-pointer"
            >
              既存地点を開いて記録を追加する
            </button>
          </div>
        )}

        {formState?.mode === 'create-spot' ? (
          <SpotForm
            mode="create-spot"
            initialName={
              pendingPhotoDraft?.targetMode === 'create-spot'
                ? pendingPhotoDraft.suggestedName || inspectedPoint.label || ''
                : (inspectedPoint.label ?? '')
            }
            initialCategory={
              pendingPhotoDraft?.targetMode === 'create-spot'
                ? (pendingPhotoDraft.suggestedCategory ?? inspectedPoint.suggestedCategory ?? 'nature')
                : (inspectedPoint.suggestedCategory ?? 'nature')
            }
            initialKind={formState.defaultKind}
            initialDate={
              pendingPhotoDraft?.targetMode === 'create-spot'
                ? pendingPhotoDraft.suggestedDate
                : undefined
            }
            initialDraftPhotos={
              pendingPhotoDraft?.targetMode === 'create-spot'
                ? pendingPhotoDraft.draftPhotos
                : undefined
            }
            osmCandidates={osmCandidates}
            isLoadingOsm={isLoadingOsm}
            submitting={submitting}
            onPhotoProcessingChange={setIsPhotoProcessing}
            onSubmit={handleFormSubmit}
            onCancel={() => {
              onClearPendingPhotoDraft?.();
              setFormState(null);
            }}
          />
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                id="btn-register-visited"
                onClick={() => setFormState({ mode: 'create-spot', defaultKind: 'visited' })}
                className="inline-flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow cursor-pointer"
              >
                <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                <span>訪問済みに登録</span>
              </button>
              <button
                type="button"
                id="btn-register-planned"
                onClick={() => setFormState({ mode: 'create-spot', defaultKind: 'planned' })}
                className="inline-flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold shadow cursor-pointer"
              >
                <Clock className="w-4 h-4" aria-hidden="true" />
                <span>訪問予定に登録</span>
              </button>
            </div>
            <button
              type="button"
              onClick={() =>
                onSharePoint(
                  inspectedPoint.lng,
                  inspectedPoint.lat,
                  inspectedPoint.label || osmCandidates[0]?.name
                )
              }
              className="w-full inline-flex items-center justify-center gap-1.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 cursor-pointer"
            >
              <Share2 className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
              <span>この地点の3D視点を共有</span>
            </button>
          </div>
        )}
      </section>
    );
  }

  // Registered Spot Detail Sheet
  const spot = selectedSpot!;
  const catMeta = getSpotCategoryMeta(spot.category);
  const CatIcon = catMeta.icon;
  const hybrid = isHybridSpot(spot);
  const firstPlannedEntry = spot.entries.find((e) => e.kind === 'planned') ?? null;

  return (
    <section
      aria-label="地点詳細シート"
      className="vt-detail-sheet pointer-events-auto fixed bottom-3 left-3 right-3 sm:left-4 sm:right-auto sm:w-[27rem] z-20 rounded-2xl bg-slate-900/95 backdrop-blur-md border border-slate-700/85 shadow-2xl p-4 max-h-[78dvh] overflow-y-auto"
      style={{ marginBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                spot.status === 'visited'
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-400/50'
                  : 'bg-amber-500/20 text-amber-300 border-amber-400/50 border-dashed'
              }`}
            >
              {spot.status === 'visited' ? (
                <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
              ) : (
                <Clock className="w-3 h-3" aria-hidden="true" />
              )}
              <span>{spot.status === 'visited' ? '訪問済み' : '訪問予定'}</span>
            </span>

            {hybrid && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-200 border border-amber-400/50">
                再訪予定あり
              </span>
            )}

            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${catMeta.badgeBgClass}`}
            >
              <CatIcon className="w-3 h-3" aria-hidden="true" />
              <span>{catMeta.label}</span>
            </span>

            {spot.isPinned && (
              <span className="inline-flex items-center gap-0.5 text-[11px] text-sky-300 font-semibold">
                <Pin className="w-3 h-3" aria-hidden="true" />
                <span>ピン留め</span>
              </span>
            )}
          </div>

          <h2 className="vt-detail-title text-base font-bold text-white break-words">{spot.name}</h2>

          <p className="text-[11px] text-slate-400 flex flex-wrap items-center gap-x-2">
            {spot.addressSummary && <span>{spot.addressSummary}</span>}
            {spot.elevation !== null && (
              <span className="inline-flex items-center gap-0.5 text-emerald-300">
                <Mountain className="w-3 h-3" aria-hidden="true" />
                標高 {spot.elevation.toLocaleString()}m
              </span>
            )}
          </p>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="閉じる"
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Quick actions row */}
      {formState === null && (
        <div className="flex flex-wrap items-center gap-1.5 mt-3 pb-3 border-b border-slate-800">
          <button
            type="button"
            onClick={() => onFlyToSpot(spot)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold cursor-pointer"
          >
            <Navigation className="w-3 h-3 text-sky-400" aria-hidden="true" />
            <span>登録視点へ</span>
          </button>

          <button
            type="button"
            onClick={async () => {
              await onUpdateSpotCamera(spot.id);
              setCameraSavedFeedback(true);
              setTimeout(() => setCameraSavedFeedback(false), 2000);
            }}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold cursor-pointer"
          >
            {cameraSavedFeedback ? (
              <Check className="w-3 h-3 text-emerald-400" aria-hidden="true" />
            ) : (
              <Camera className="w-3 h-3 text-sky-400" aria-hidden="true" />
            )}
            <span>{cameraSavedFeedback ? '視点を更新しました' : '現在の視点で更新'}</span>
          </button>

          <button
            type="button"
            onClick={() => setFormState({ mode: 'edit-spot' })}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold cursor-pointer"
          >
            <Edit3 className="w-3 h-3" aria-hidden="true" />
            <span>地点編集</span>
          </button>

          <button
            type="button"
            onClick={() => onSharePoint(spot.center[0], spot.center[1], spot.name)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold cursor-pointer"
          >
            <Share2 className="w-3 h-3 text-sky-400" aria-hidden="true" />
            <span>共有</span>
          </button>
        </div>
      )}

      {/* Primary CTA to convert planned spot to visited */}
      {formState === null && spot.status === 'planned' && (
        <div className="mt-3">
          <button
            type="button"
            id="btn-convert-to-visited"
            onClick={() => {
              if (firstPlannedEntry) {
                setFormState({ mode: 'convert-to-visited', entry: firstPlannedEntry });
              } else {
                setFormState({ mode: 'add-entry', defaultKind: 'visited' });
              }
            }}
            className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow cursor-pointer"
          >
            <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
            <span>訪問済みにする（日付・感想を記録）</span>
          </button>
        </div>
      )}

      {/* Active inline form */}
      {formState !== null && (
        <div className="mt-3 pt-2 border-t border-slate-800">
          <SpotForm
            mode={formState.mode as SpotFormMode}
            initialName={spot.name}
            initialCategory={spot.category}
            initialIsPinned={spot.isPinned}
            initialKind={
              formState.mode === 'add-entry'
                ? formState.defaultKind
                : formState.mode === 'edit-entry'
                  ? formState.entry.kind
                  : 'visited'
            }
            initialDate={
              formState.mode === 'edit-entry'
                ? formState.entry.date
                : formState.mode === 'convert-to-visited'
                  ? { precision: 'day', start: getTodayDateString() }
                  : formState.mode === 'add-entry' && pendingPhotoDraft?.targetMode === 'add-entry'
                    ? pendingPhotoDraft.suggestedDate
                    : undefined
            }
            initialMemo={
              formState.mode === 'edit-entry' || formState.mode === 'convert-to-visited'
                ? formState.entry.memo
                : ''
            }
            initialPhotos={
              formState.mode === 'edit-entry' || formState.mode === 'convert-to-visited'
                ? formState.entry.photos
                : undefined
            }
            initialDraftPhotos={
              formState.mode === 'add-entry' && pendingPhotoDraft?.targetMode === 'add-entry'
                ? pendingPhotoDraft.draftPhotos
                : undefined
            }
            submitting={submitting}
            onPhotoProcessingChange={setIsPhotoProcessing}
            onSubmit={handleFormSubmit}
            onCancel={() => {
              onClearPendingPhotoDraft?.();
              setFormState(null);
            }}
          />
        </div>
      )}

      {/* Entries history list */}
      {formState === null && (
        <div className="mt-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-slate-300">
              訪問・予定ログ ({spot.entries.length}件)
            </h3>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                id="btn-add-visited-entry"
                onClick={() => setFormState({ mode: 'add-entry', defaultKind: 'visited' })}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-600/25 hover:bg-emerald-600/40 border border-emerald-500/40 text-emerald-200 text-[11px] font-semibold cursor-pointer"
              >
                <Plus className="w-3 h-3" aria-hidden="true" />
                <span>訪問記録</span>
              </button>
              <button
                type="button"
                id="btn-add-planned-entry"
                onClick={() => setFormState({ mode: 'add-entry', defaultKind: 'planned' })}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-600/25 hover:bg-amber-600/40 border border-amber-500/40 text-amber-200 text-[11px] font-semibold cursor-pointer"
              >
                <Plus className="w-3 h-3" aria-hidden="true" />
                <span>再訪予定</span>
              </button>
            </div>
          </div>

          {spot.entries.length === 0 ? (
            <p className="text-xs text-slate-400 py-2">まだ記録ログがありません。</p>
          ) : (
            <ul className="space-y-2">
              {spot.entries.map((entry) => (
                <li
                  key={entry.id}
                  className="p-2.5 rounded-xl bg-slate-950/75 border border-slate-800/90 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          entry.kind === 'visited'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : 'bg-amber-500/20 text-amber-300'
                        }`}
                      >
                        {entry.kind === 'visited' ? '訪問' : '予定'}
                      </span>
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-100">
                        <Calendar className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                        <span>{formatVisitDate(entry.date)}</span>
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {entry.kind === 'planned' && (
                        <button
                          type="button"
                          onClick={() => setFormState({ mode: 'convert-to-visited', entry })}
                          className="px-1.5 py-0.5 rounded bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-200 text-[10px] font-semibold cursor-pointer"
                        >
                          完了にする
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label="記録を編集"
                        onClick={() => setFormState({ mode: 'edit-entry', entry })}
                        className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      {confirmDeleteEntryId === entry.id ? (
                        <button
                          type="button"
                          onClick={async () => {
                            await onDeleteEntry(spot.id, entry.id);
                            setConfirmDeleteEntryId(null);
                          }}
                          className="px-1.5 py-0.5 rounded bg-rose-600 text-white text-[10px] font-bold cursor-pointer"
                        >
                          削除確定
                        </button>
                      ) : (
                        <button
                          type="button"
                          aria-label="記録を削除"
                          onClick={() => setConfirmDeleteEntryId(entry.id)}
                          className="p-1 rounded text-slate-400 hover:text-rose-300 hover:bg-slate-800 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {entry.memo && (
                    <p className="text-xs text-slate-300 whitespace-pre-wrap break-words leading-relaxed">
                      {entry.memo}
                    </p>
                  )}

                  {entry.photos.length > 0 && (
                    <EntryPhotoStrip
                      photos={entry.photos}
                      photoCacheVersion={photoCacheVersion}
                      remoteStatusById={remoteStatusById}
                      onLoadRemote={(targetPhotos) => void runRemotePhotoFetch(targetPhotos, true)}
                      onOpen={(index) => setLightboxState({ photos: entry.photos, index })}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* Spot deletion */}
          <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between">
            {confirmDeleteSpot ? (
              <div className="flex items-center gap-2 w-full justify-between">
                <span className="text-[11px] text-rose-300 font-semibold">
                  この地点と全記録を削除しますか？
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteSpot(false)}
                    className="px-2.5 py-1 rounded-lg bg-slate-800 text-slate-200 text-[11px] cursor-pointer"
                  >
                    中止
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await onDeleteSpot(spot.id);
                    }}
                    className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold cursor-pointer"
                  >
                    削除する
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDeleteSpot(true)}
                className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-rose-300 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>この地点を削除</span>
              </button>
            )}
          </div>
        </div>
      )}

      <PhotoLightbox
        isOpen={lightboxState !== null}
        photos={lightboxState?.photos ?? []}
        initialIndex={lightboxState?.index ?? 0}
        spotName={spot.name}
        photoCacheVersion={photoCacheVersion}
        onRequestRemotePhoto={(photo) => void runRemotePhotoFetch([photo], true)}
        onClose={() => setLightboxState(null)}
      />
    </section>
  );
};
