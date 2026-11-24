import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as maplibregl from 'maplibre-gl';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronDown,
  Clock,
  Cloud,
  Compass,
  Layers,
  Loader2,
  LocateFixed,
  Search,
} from 'lucide-react';
import { MapViewer } from './components/MapViewer';
import { StatusFilterBar } from './components/StatusFilterBar';
import { SpotDetailSheet, type PendingPhotoDraft } from './components/SpotDetailSheet';
import { SpotNavDrawer } from './components/SpotNavDrawer';
import { CloudSyncDialog } from './components/CloudSyncDialog';
import { LayerMenu } from './components/LayerMenu';
import { PrefectureSummaryLegend } from './components/PrefectureSummaryLegend';
import { StaticPolicyPage } from './components/StaticPolicyPage';
import { PhotoProposalCard, type PhotoProposalState } from './components/PhotoProposalCard';
import { DEFAULT_INITIAL_CAMERA } from './lib/maplibreHelper';
import { fetchPointElevationFromAW3D } from './lib/jaxaClient';
import {
  createEmptyAppState,
  getVisitStorageWarning,
  isVisitStorageBlocked,
  loadAppState,
  loadUiPreferences,
  markLocalExportTimestamp,
  patchPhotoDriveFileIds,
  requestPersistentStorage,
  restoreUndoSnapshot,
  saveSpots,
  saveSpotsWithPhotosAtomic,
  saveSpotsWithUndoAtomic,
  saveUiPreferences,
  updateDriveSyncMeta,
  type StorageOperationResult,
} from './lib/visitStorage';
import {
  collectReferencedPhotoIds,
  createUuid,
  deriveSpotStatus,
  findPhotoLocationMatches,
  hasUnuploadedPhotos,
  isSameCoordinate,
  matchesStatusFilter,
} from './lib/spotDomain';
import { invalidatePhotoUrl } from './lib/photoUrlCache';
import { HYAKUMEIZAN_PRESETS } from './lib/hyakumeizanData';
import { calcDistanceMeters, fetchOsmPlaceContext } from './lib/osmPlaceClient';
import {
  buildSuggestedVisitDateFromPhotos,
  extractExifMetadataFromFile,
} from './lib/photoExif';
import { processPhotoFilesSerial } from './lib/photoProcessor';
import {
  buildPublicShareUrl,
  parseUrlViewState,
  replaceUrlViewState,
  shareOrCopyUrl,
} from './lib/urlSync';
import { runViewTransition } from './lib/viewTransition';
import {
  buildColoredPrefectureGeoJson,
  computePrefectureStats,
  loadPrefectureSpatialIndex,
  type PrefectureSpatialIndex,
} from './lib/prefectureStats';
import { getVisitDateRange } from './lib/visitDate';
import {
  MAX_ENTRIES_PER_SPOT,
  MAX_PHOTOS_PER_ENTRY,
  MAX_SPOTS,
  type BaseMapId,
  type DraftPhotoItem,
  type DriveSyncMeta,
  type InspectedPoint,
  type LocalAppState,
  type PhotoAttachment,
  type PresetMountain,
  type SpotCamera,
  type SpotCategory,
  type SpotStatus,
  type StatusFilterValue,
  type StoredPhotoRecord,
  type VisitEntry,
  type VisitSpot,
  type WebGPUStatus,
} from './types/visit';

type RoutePath = '/' | '/privacy' | '/terms';

function resolveRoutePath(pathname: string): RoutePath {
  if (pathname === '/privacy') return '/privacy';
  if (pathname === '/terms') return '/terms';
  return '/';
}

function sortEntries(entries: VisitEntry[]): VisitEntry[] {
  return [...entries].sort((a, b) => {
    const ra = getVisitDateRange(a.date)?.start ?? '';
    const rb = getVisitDateRange(b.date)?.start ?? '';
    if (ra !== rb) return rb.localeCompare(ra);
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}

export const App: React.FC = () => {
  const [routePath, setRoutePath] = useState<RoutePath>(() =>
    typeof window !== 'undefined' ? resolveRoutePath(window.location.pathname) : '/'
  );

  useEffect(() => {
    const onPopState = () => setRoutePath(resolveRoutePath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigateRoute = useCallback((nextPath: RoutePath) => {
    if (typeof window !== 'undefined' && window.location.pathname !== nextPath) {
      window.history.pushState(null, '', nextPath);
    }
    setRoutePath(nextPath);
    if (typeof window !== 'undefined') window.scrollTo(0, 0);
  }, []);

  const initialUrlStateRef = useRef(parseUrlViewState());
  const initialUiPrefsRef = useRef(loadUiPreferences());

  const [appState, setAppState] = useState<LocalAppState>(() => createEmptyAppState());
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [storageBlocked, setStorageBlocked] = useState(false);

  const [baseMap, setBaseMap] = useState<BaseMapId>(
    () => initialUrlStateRef.current?.baseMap ?? initialUiPrefsRef.current.baseMap
  );
  const [exaggeration, setExaggeration] = useState<number>(
    () => initialUrlStateRef.current?.exaggeration ?? initialUiPrefsRef.current.exaggeration
  );
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>(
    () => initialUiPrefsRef.current.statusFilter
  );
  const [prefectureFillEnabled, setPrefectureFillEnabled] = useState<boolean>(
    () => initialUiPrefsRef.current.prefectureFillEnabled
  );
  const [prefectureIndex, setPrefectureIndex] = useState<PrefectureSpatialIndex | null>(null);
  const [isPrefectureLoading, setIsPrefectureLoading] = useState(false);
  const [prefectureLoadError, setPrefectureLoadError] = useState<string | null>(null);
  const [prefectureLoadNonce, setPrefectureLoadNonce] = useState(0);

  const [gpuStatus, setGpuStatus] = useState<WebGPUStatus>({
    backend: 'webgpu',
    webgpuAvailable: true,
    adapterInfo: 'Initializing...',
    fps: 0,
  });

  const [selectedSpotId, setSelectedSpotId] = useState<string | null>(null);
  const [inspectedPoint, setInspectedPoint] = useState<InspectedPoint | null>(() => {
    const url = initialUrlStateRef.current;
    if (!url || !url.spotName) return null;
    return {
      lng: url.lng,
      lat: url.lat,
      elevation: null,
      label: url.spotName,
    };
  });

  const [isNavOpen, setIsNavOpen] = useState(false);
  const [isFilterMenuOpen, setIsFilterMenuOpen] = useState(false);
  const [isLayerOpen, setIsLayerOpen] = useState(false);
  const [isSyncOpen, setIsSyncOpen] = useState(false);
  const [isLocating, setIsLocating] = useState(false);
  const [isMapLoading, setIsMapLoading] = useState(true);
  const [toastText, setToastText] = useState<string | null>(null);
  const [photoCacheVersion, setPhotoCacheVersion] = useState(0);
  const [photoProposal, setPhotoProposal] = useState<PhotoProposalState | null>(null);
  const [pendingPhotoDraft, setPendingPhotoDraft] = useState<PendingPhotoDraft | null>(null);
  const [isReadingPhotoExif, setIsReadingPhotoExif] = useState(false);

  const mapRef = useRef<maplibregl.Map | null>(null);
  const cameraSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const photoProposalInputRef = useRef<HTMLInputElement | null>(null);
  const photoProposalFilesRef = useRef<File[]>([]);
  const photoProposalAbortRef = useRef<AbortController | null>(null);

  const initialCamera = useMemo<{ center: [number, number] } & SpotCamera>(() => {
    const url = initialUrlStateRef.current;
    if (url) {
      return {
        center: [url.lng, url.lat],
        zoom: url.zoom,
        pitch: url.pitch,
        bearing: url.bearing,
      };
    }
    return DEFAULT_INITIAL_CAMERA;
  }, []);

  const showToast = useCallback((text: string) => {
    setToastText(text);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastText(null), 3500);
  }, []);

  // Load persisted state from IndexedDB
  useEffect(() => {
    let mounted = true;
    void loadAppState().then((loaded) => {
      if (!mounted) return;
      setAppState(loaded);
      setStorageWarning(getVisitStorageWarning());
      setStorageBlocked(isVisitStorageBlocked());

      const url = initialUrlStateRef.current;
      if (url && url.spotName) {
        const matched = loaded.spots.find((s) =>
          isSameCoordinate(s.center[0], s.center[1], url.lng, url.lat)
        );
        if (matched) {
          setSelectedSpotId(matched.id);
          setInspectedPoint(null);
        } else {
          void fetchPointElevationFromAW3D(url.lng, url.lat).then((elev) => {
            if (mounted && elev !== null) {
              setInspectedPoint((prev) => (prev ? { ...prev, elevation: elev } : prev));
            }
          });
        }
        replaceUrlViewState({
          lat: url.lat,
          lng: url.lng,
          zoom: url.zoom,
          pitch: url.pitch,
          bearing: url.bearing,
          baseMap: url.baseMap,
          exaggeration: url.exaggeration,
        });
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Persist UI preferences
  useEffect(() => {
    saveUiPreferences({ baseMap, exaggeration, statusFilter, prefectureFillEnabled });
  }, [baseMap, exaggeration, statusFilter, prefectureFillEnabled]);

  // Lazy-load 47-prefecture GeoJSON only when fill overlay is turned ON
  useEffect(() => {
    if (!prefectureFillEnabled || prefectureIndex) return;
    let cancelled = false;
    setIsPrefectureLoading(true);
    setPrefectureLoadError(null);
    void loadPrefectureSpatialIndex()
      .then((index) => {
        if (cancelled) return;
        setPrefectureIndex(index);
        setIsPrefectureLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setIsPrefectureLoading(false);
        setPrefectureLoadError(
          err instanceof Error ? err.message : '都道府県データの読み込みに失敗しました。'
        );
      });
    return () => {
      cancelled = true;
    };
  }, [prefectureFillEnabled, prefectureIndex, prefectureLoadNonce]);

  const prefectureStats = useMemo(() => {
    if (!prefectureFillEnabled || !prefectureIndex) return null;
    return computePrefectureStats(appState.spots, prefectureIndex);
  }, [prefectureFillEnabled, prefectureIndex, appState.spots]);

  const coloredPrefectureGeoJson = useMemo(() => {
    if (!prefectureFillEnabled || !prefectureIndex || !prefectureStats) return null;
    return buildColoredPrefectureGeoJson(prefectureIndex, prefectureStats);
  }, [prefectureFillEnabled, prefectureIndex, prefectureStats]);

  const selectedSpot = useMemo(
    () => appState.spots.find((s) => s.id === selectedSpotId) ?? null,
    [appState.spots, selectedSpotId]
  );

  const nearbyDuplicateSpot = useMemo(() => {
    if (!inspectedPoint || selectedSpot) return null;
    return (
      appState.spots.find((s) =>
        isSameCoordinate(s.center[0], s.center[1], inspectedPoint.lng, inspectedPoint.lat)
      ) ?? null
    );
  }, [appState.spots, inspectedPoint, selectedSpot]);

  const statusCounts = useMemo(() => {
    let visited = 0;
    let planned = 0;
    for (const spot of appState.spots) {
      if (matchesStatusFilter(spot, 'visited')) visited++;
      if (matchesStatusFilter(spot, 'planned')) planned++;
    }
    return { all: appState.spots.length, visited, planned };
  }, [appState.spots]);

  const hasUnsavedDriveChanges = useMemo(() => {
    if (appState.spots.length === 0 && appState.driveSync.lastSyncedRevision === null) return false;
    if (hasUnuploadedPhotos(appState.spots)) return true;
    return (
      appState.driveSync.lastSyncedRevision === null ||
      appState.revision > appState.driveSync.lastSyncedRevision
    );
  }, [appState.spots, appState.revision, appState.driveSync.lastSyncedRevision]);

  const referenceLocation = useMemo(() => {
    const center = mapRef.current?.getCenter();
    if (center) return { lat: center.lat, lng: center.lng };
    return { lat: initialCamera.center[1], lng: initialCamera.center[0] };
  }, [initialCamera, selectedSpotId, isNavOpen]);

  const flyTo = useCallback(
    (center: [number, number], camera?: Partial<SpotCamera>) => {
      const map = mapRef.current;
      if (!map) return;
      map.flyTo({
        center,
        zoom: camera?.zoom ?? map.getZoom(),
        pitch: camera?.pitch ?? map.getPitch(),
        bearing: camera?.bearing ?? map.getBearing(),
        duration: 950,
        essential: true,
      });
    },
    []
  );

  const getCurrentCameraSnapshot = useCallback((): SpotCamera => {
    const map = mapRef.current;
    if (!map) return { zoom: 10.5, pitch: 55, bearing: 0 };
    return {
      zoom: Number(map.getZoom().toFixed(2)),
      pitch: Math.round(map.getPitch()),
      bearing: Math.round(map.getBearing()),
    };
  }, []);

  const handleCameraChange = useCallback(
    (view: { lat: number; lng: number; zoom: number; pitch: number; bearing: number }) => {
      if (cameraSyncTimerRef.current) clearTimeout(cameraSyncTimerRef.current);
      cameraSyncTimerRef.current = setTimeout(() => {
        replaceUrlViewState({
          ...view,
          baseMap,
          exaggeration,
        });
      }, 300);
    },
    [baseMap, exaggeration]
  );

  // Mutual exclusion helpers
  const openNav = () => {
    setIsFilterMenuOpen(false);
    setIsLayerOpen(false);
    setIsSyncOpen(false);
    setIsNavOpen((prev) => !prev);
  };
  const openFilterMenu = () => {
    setIsNavOpen(false);
    setIsLayerOpen(false);
    setIsSyncOpen(false);
    setIsFilterMenuOpen((prev) => !prev);
  };
  const openLayer = () => {
    setIsFilterMenuOpen(false);
    setIsNavOpen(false);
    setIsSyncOpen(false);
    setIsLayerOpen((prev) => !prev);
  };
  const openSync = () => {
    setIsFilterMenuOpen(false);
    setIsNavOpen(false);
    setIsLayerOpen(false);
    setIsSyncOpen(true);
  };

  const handleSelectSpot = useCallback(
    (spot: VisitSpot, options?: { preserveCamera?: boolean }) => {
      runViewTransition(() => {
        setInspectedPoint(null);
        setSelectedSpotId(spot.id);
      });
      flyTo(spot.center, options?.preserveCamera ? undefined : spot.camera);
    },
    [flyTo]
  );

  const handleInspectEmptyPoint = useCallback((point: InspectedPoint) => {
    runViewTransition(() => {
      setSelectedSpotId(null);
      setInspectedPoint(point);
    });
    if (point.elevation === null) {
      void fetchPointElevationFromAW3D(point.lng, point.lat).then((elev) => {
        if (elev !== null) {
          setInspectedPoint((prev) =>
            prev && isSameCoordinate(prev.lng, prev.lat, point.lng, point.lat, 0.0001)
              ? { ...prev, elevation: elev }
              : prev
          );
        }
      });
    }
  }, []);

  const handleSelectSearchLocation = useCallback(
    (point: InspectedPoint, zoom: number) => {
      const existing = appState.spots.find((s) =>
        isSameCoordinate(s.center[0], s.center[1], point.lng, point.lat)
      );
      if (existing) {
        handleSelectSpot(existing);
        return;
      }
      runViewTransition(() => {
        setSelectedSpotId(null);
        setInspectedPoint(point);
      });
      flyTo([point.lng, point.lat], { zoom, pitch: 55, bearing: 0 });
      void fetchPointElevationFromAW3D(point.lng, point.lat).then((elev) => {
        if (elev !== null) {
          setInspectedPoint((prev) =>
            prev && isSameCoordinate(prev.lng, prev.lat, point.lng, point.lat, 0.0001)
              ? { ...prev, elevation: elev }
              : prev
          );
        }
      });
    },
    [appState.spots, flyTo, handleSelectSpot]
  );

  const handleSelectMountain = useCallback(
    (mountain: PresetMountain, matchedSpot: VisitSpot | null) => {
      if (matchedSpot) {
        handleSelectSpot(matchedSpot);
        return;
      }
      runViewTransition(() => {
        setSelectedSpotId(null);
        setInspectedPoint({
          lng: mountain.center[0],
          lat: mountain.center[1],
          elevation: mountain.elevation,
          label: mountain.name,
          addressSummary: mountain.region,
          presetId: mountain.id,
          suggestedCategory: 'nature',
          recommendedZoom: mountain.zoom,
        });
      });
      flyTo(mountain.center, {
        zoom: mountain.zoom,
        pitch: mountain.pitch,
        bearing: mountain.bearing,
      });
    },
    [flyTo, handleSelectSpot]
  );

  const handleLocateCurrentPosition = useCallback(() => {
    if (isLocating) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      showToast('このブラウザは現在地取得に対応していません。');
      return;
    }
    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setIsLocating(false);
        const lng = pos.coords.longitude;
        const lat = pos.coords.latitude;
        const matched = appState.spots.find((s) =>
          isSameCoordinate(s.center[0], s.center[1], lng, lat)
        );
        if (matched) {
          handleSelectSpot(matched);
          return;
        }
        const currentZoom = mapRef.current?.getZoom() ?? 12;
        flyTo([lng, lat], { zoom: Math.max(currentZoom, 12) });
        runViewTransition(() => {
          setSelectedSpotId(null);
          setInspectedPoint({ lng, lat, elevation: null, label: '現在地' });
        });
        void fetchPointElevationFromAW3D(lng, lat).then((elev) => {
          if (elev !== null) {
            setInspectedPoint((prev) =>
              prev && isSameCoordinate(prev.lng, prev.lat, lng, lat, 0.0001)
                ? { ...prev, elevation: elev }
                : prev
            );
          }
        });
      },
      () => {
        setIsLocating(false);
        showToast('現在地を取得できませんでした。位置情報の許可をご確認ください。');
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  }, [isLocating, appState.spots, flyTo, handleSelectSpot, showToast]);

  const handleDismissPhotoProposal = useCallback(() => {
    photoProposalAbortRef.current?.abort();
    photoProposalAbortRef.current = null;
    photoProposalFilesRef.current = [];
    setPhotoProposal(null);
  }, []);

  const handlePhotoProposalFilesSelected = useCallback(
    async (fileList: FileList | File[]) => {
      const rawFiles = Array.from(fileList);
      if (rawFiles.length === 0) return;

      const accepted = rawFiles.slice(0, MAX_PHOTOS_PER_ENTRY);
      if (rawFiles.length > MAX_PHOTOS_PER_ENTRY) {
        showToast(
          `1回の記録につき最大 ${MAX_PHOTOS_PER_ENTRY} 枚までのため、先頭 ${accepted.length} 枚を対象にしました。`
        );
      }

      photoProposalAbortRef.current?.abort();
      const abortController = new AbortController();
      photoProposalAbortRef.current = abortController;
      photoProposalFilesRef.current = accepted;
      setIsReadingPhotoExif(true);

      try {
        let gpsCenter: [number, number] | null = null;
        let gpsAltitude: number | undefined;
        let hasSpreadLocations = false;
        const localDates: Array<string | undefined> = [];

        for (const file of accepted) {
          const meta = await extractExifMetadataFromFile(file);
          if (abortController.signal.aborted) return;
          if (meta?.date?.localDate) {
            localDates.push(meta.date.localDate);
          }
          if (meta?.gps) {
            if (!gpsCenter) {
              gpsCenter = meta.gps.center;
              gpsAltitude = meta.gps.altitude;
            } else {
              const dist = calcDistanceMeters(
                gpsCenter[1],
                gpsCenter[0],
                meta.gps.center[1],
                meta.gps.center[0]
              );
              if (dist > 500) {
                hasSpreadLocations = true;
              }
            }
          }
        }

        const suggestedDate = buildSuggestedVisitDateFromPhotos(localDates);

        if (!gpsCenter) {
          setPhotoProposal({
            fileCount: rawFiles.length,
            acceptedCount: accepted.length,
            gpsCenter: null,
            hasSpreadLocations: false,
            suggestedDate,
            nearbySpots: [],
            nearbyMountain: null,
            osmContext: null,
            isLoadingOsm: false,
            isPreparingDraft: false,
          });
          return;
        }

        // GPSが見つかった場合は該当座標へ地図を移動し、既存の選択状態はクリアして提案UIを表示
        runViewTransition(() => {
          setSelectedSpotId(null);
          setInspectedPoint(null);
          setPendingPhotoDraft(null);
        });
        const currentZoom = mapRef.current?.getZoom() ?? 10.5;
        flyTo(gpsCenter, { zoom: Math.max(currentZoom, 14), pitch: 55 });

        const matches = findPhotoLocationMatches(
          gpsCenter,
          appState.spots,
          HYAKUMEIZAN_PRESETS
        );
        const needsReverseGeocode =
          matches.nearbySpots.length === 0 && matches.nearbyMountain === null;

        setPhotoProposal({
          fileCount: rawFiles.length,
          acceptedCount: accepted.length,
          gpsCenter,
          gpsAltitude,
          hasSpreadLocations,
          suggestedDate,
          nearbySpots: matches.nearbySpots,
          nearbyMountain: matches.nearbyMountain,
          osmContext: null,
          isLoadingOsm: needsReverseGeocode,
          isPreparingDraft: false,
        });

        if (needsReverseGeocode) {
          void fetchOsmPlaceContext(gpsCenter[1], gpsCenter[0], {
            signal: abortController.signal,
            onPartialUpdate: (ctx) => {
              if (!abortController.signal.aborted) {
                setPhotoProposal((prev) =>
                  prev ? { ...prev, osmContext: ctx } : prev
                );
              }
            },
          })
            .then((ctx) => {
              if (!abortController.signal.aborted) {
                setPhotoProposal((prev) =>
                  prev ? { ...prev, osmContext: ctx, isLoadingOsm: false } : prev
                );
              }
            })
            .catch(() => {
              if (!abortController.signal.aborted) {
                setPhotoProposal((prev) =>
                  prev ? { ...prev, isLoadingOsm: false } : prev
                );
              }
            });
        }
      } finally {
        if (!abortController.signal.aborted) {
          setIsReadingPhotoExif(false);
        }
      }
    },
    [appState.spots, flyTo, showToast]
  );

  const prepareDraftPhotosFromProposal = useCallback(async (): Promise<{
    draftPhotos: DraftPhotoItem[];
    errors: string[];
  }> => {
    const files = photoProposalFilesRef.current;
    const results = await processPhotoFilesSerial(files);
    const draftPhotos: DraftPhotoItem[] = [];
    const errors: string[] = [];

    for (const item of results) {
      if (item.ok) {
        const previewUrl =
          typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
            ? URL.createObjectURL(item.result.thumbnailBlob)
            : '';
        draftPhotos.push({
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

    return { draftPhotos, errors };
  }, []);

  const handleAcceptAddEntryFromPhoto = useCallback(
    async (spotId: string) => {
      if (!photoProposal) return;
      const targetSpot = appState.spots.find((s) => s.id === spotId);
      if (!targetSpot) return;

      setPhotoProposal((prev) =>
        prev ? { ...prev, isPreparingDraft: true, errorMessage: null } : prev
      );

      const { draftPhotos, errors } = await prepareDraftPhotosFromProposal();
      if (draftPhotos.length === 0) {
        setPhotoProposal((prev) =>
          prev
            ? {
                ...prev,
                isPreparingDraft: false,
                errorMessage: errors[0] || '画像を読み込めませんでした。',
              }
            : prev
        );
        return;
      }
      if (errors.length > 0) {
        showToast(`一部の画像をスキップしました: ${errors[0]}`);
      }

      photoProposalAbortRef.current?.abort();
      photoProposalFilesRef.current = [];
      setPendingPhotoDraft({
        key: createUuid(),
        targetMode: 'add-entry',
        draftPhotos,
        suggestedDate: photoProposal.suggestedDate ?? undefined,
      });
      setPhotoProposal(null);
      handleSelectSpot(targetSpot);
    },
    [appState.spots, handleSelectSpot, photoProposal, prepareDraftPhotosFromProposal, showToast]
  );

  const handleAcceptCreateSpotFromPhoto = useCallback(async () => {
    if (!photoProposal || !photoProposal.gpsCenter) return;

    setPhotoProposal((prev) =>
      prev ? { ...prev, isPreparingDraft: true, errorMessage: null } : prev
    );

    const { draftPhotos, errors } = await prepareDraftPhotosFromProposal();
    if (draftPhotos.length === 0) {
      setPhotoProposal((prev) =>
        prev
          ? {
              ...prev,
              isPreparingDraft: false,
              errorMessage: errors[0] || '画像を読み込めませんでした。',
            }
          : prev
      );
      return;
    }
    if (errors.length > 0) {
      showToast(`一部の画像をスキップしました: ${errors[0]}`);
    }

    const [lng, lat] = photoProposal.gpsCenter;
    const mountain = photoProposal.nearbyMountain?.mountain;
    const osmTop = photoProposal.osmContext?.candidates[0];
    const suggestedName =
      mountain?.name ?? osmTop?.name ?? photoProposal.osmContext?.addressSummary ?? '';
    const suggestedCategory: SpotCategory = mountain
      ? 'nature'
      : (osmTop?.suggestedSpotCategory ?? 'nature');

    const point: InspectedPoint = {
      lng,
      lat,
      elevation:
        mountain?.elevation ??
        (photoProposal.gpsAltitude !== undefined ? Math.round(photoProposal.gpsAltitude) : null),
      label: suggestedName || undefined,
      addressSummary: mountain?.region ?? photoProposal.osmContext?.addressSummary,
      presetId: mountain?.id,
      suggestedCategory,
    };

    photoProposalAbortRef.current?.abort();
    photoProposalFilesRef.current = [];
    setPendingPhotoDraft({
      key: createUuid(),
      targetMode: 'create-spot',
      draftPhotos,
      suggestedDate: photoProposal.suggestedDate ?? undefined,
      suggestedName,
      suggestedCategory,
    });
    setPhotoProposal(null);
    runViewTransition(() => {
      setSelectedSpotId(null);
      setInspectedPoint(point);
    });

    if (point.elevation === null) {
      void fetchPointElevationFromAW3D(lng, lat).then((elev) => {
        if (elev !== null) {
          setInspectedPoint((prev) =>
            prev && isSameCoordinate(prev.lng, prev.lat, lng, lat, 0.0001)
              ? { ...prev, elevation: elev }
              : prev
          );
        }
      });
    }
  }, [photoProposal, prepareDraftPhotosFromProposal, showToast]);

  const syncPhotoCacheAfterSpotsChange = useCallback(
    (prevSpots: VisitSpot[], nextSpots: VisitSpot[]) => {
      const prevIds = collectReferencedPhotoIds(prevSpots);
      const nextIds = collectReferencedPhotoIds(nextSpots);
      let changed = false;
      for (const id of prevIds) {
        if (!nextIds.has(id)) {
          invalidatePhotoUrl(id);
          changed = true;
        }
      }
      for (const id of nextIds) {
        if (!prevIds.has(id)) {
          changed = true;
        }
      }
      if (changed) {
        setPhotoCacheVersion((v) => v + 1);
      }
    },
    []
  );

  const commitSpots = useCallback(
    async (
      nextSpots: VisitSpot[],
      newPhotoRecords?: StoredPhotoRecord[]
    ): Promise<StorageOperationResult> => {
      const prevSpots = appState.spots;
      const res =
        newPhotoRecords && newPhotoRecords.length > 0
          ? await saveSpotsWithPhotosAtomic(nextSpots, newPhotoRecords)
          : await saveSpots(nextSpots);
      setStorageWarning(getVisitStorageWarning());
      setStorageBlocked(isVisitStorageBlocked());
      if (res.success && res.state) {
        setAppState(res.state);
        syncPhotoCacheAfterSpotsChange(prevSpots, res.state.spots);
        requestPersistentStorage();
      } else if (res.message) {
        showToast(res.message);
      }
      return res;
    },
    [appState.spots, showToast, syncPhotoCacheAfterSpotsChange]
  );

  const handleCreateSpot = useCallback(
    async (payload: {
      point: InspectedPoint;
      name: string;
      category: SpotCategory;
      isPinned: boolean;
      kind: SpotStatus;
      date: VisitEntry['date'];
      memo: string;
      photos?: PhotoAttachment[];
      newPhotoRecords?: StoredPhotoRecord[];
    }) => {
      if (appState.spots.length >= MAX_SPOTS) {
        showToast(`登録上限（${MAX_SPOTS}件）に達しています。`);
        return;
      }
      const now = new Date().toISOString();
      const matchedMountainId =
        payload.point.presetId ??
        HYAKUMEIZAN_PRESETS.find(
          (m) =>
            calcDistanceMeters(m.center[1], m.center[0], payload.point.lat, payload.point.lng) <=
            2000
        )?.id;
      const newSpot: VisitSpot = {
        id: createUuid(),
        name: payload.name,
        status: payload.kind,
        category: payload.category,
        center: [payload.point.lng, payload.point.lat],
        elevation: payload.point.elevation,
        camera: getCurrentCameraSnapshot(),
        addressSummary: payload.point.addressSummary,
        presetId: matchedMountainId,
        isPinned: payload.isPinned,
        entries: [
          {
            id: createUuid(),
            kind: payload.kind,
            date: payload.date,
            memo: payload.memo,
            photos: payload.photos ?? [],
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      };

      const res = await commitSpots([newSpot, ...appState.spots], payload.newPhotoRecords);
      if (res.success) {
        runViewTransition(() => {
          setInspectedPoint(null);
          setSelectedSpotId(newSpot.id);
        });
        showToast(`「${newSpot.name}」を登録しました。`);
      }
    },
    [appState.spots, commitSpots, getCurrentCameraSnapshot, showToast]
  );

  const handleUpdateSpotMeta = useCallback(
    async (spotId: string, patch: { name?: string; category?: SpotCategory; isPinned?: boolean }) => {
      const now = new Date().toISOString();
      const next = appState.spots.map((s) =>
        s.id === spotId
          ? {
              ...s,
              name: patch.name ?? s.name,
              category: patch.category ?? s.category,
              isPinned: patch.isPinned ?? s.isPinned,
              updatedAt: now,
            }
          : s
      );
      const res = await commitSpots(next);
      if (res.success) showToast('地点情報を更新しました。');
    },
    [appState.spots, commitSpots, showToast]
  );

  const handleUpdateSpotCamera = useCallback(
    async (spotId: string) => {
      const camera = getCurrentCameraSnapshot();
      const now = new Date().toISOString();
      const next = appState.spots.map((s) =>
        s.id === spotId ? { ...s, camera, updatedAt: now } : s
      );
      await commitSpots(next);
    },
    [appState.spots, commitSpots, getCurrentCameraSnapshot]
  );

  const handleDeleteSpot = useCallback(
    async (spotId: string) => {
      const next = appState.spots.filter((s) => s.id !== spotId);
      const res = await commitSpots(next);
      if (res.success) {
        runViewTransition(() => setSelectedSpotId(null));
        showToast('地点を削除しました。');
      }
    },
    [appState.spots, commitSpots, showToast]
  );

  const handleAddEntry = useCallback(
    async (
      spotId: string,
      payload: {
        kind: SpotStatus;
        date: VisitEntry['date'];
        memo: string;
        photos?: PhotoAttachment[];
        newPhotoRecords?: StoredPhotoRecord[];
      }
    ) => {
      const target = appState.spots.find((s) => s.id === spotId);
      if (!target) return;
      if (target.entries.length >= MAX_ENTRIES_PER_SPOT) {
        showToast(`1地点の記録上限（${MAX_ENTRIES_PER_SPOT}件）に達しています。`);
        return;
      }
      const now = new Date().toISOString();
      const entry: VisitEntry = {
        id: createUuid(),
        kind: payload.kind,
        date: payload.date,
        memo: payload.memo,
        photos: payload.photos ?? [],
        createdAt: now,
        updatedAt: now,
      };
      const nextEntries = sortEntries([entry, ...target.entries]);
      const next = appState.spots.map((s) =>
        s.id === spotId
          ? {
              ...s,
              entries: nextEntries,
              status: deriveSpotStatus(nextEntries, s.status),
              updatedAt: now,
            }
          : s
      );
      const res = await commitSpots(next, payload.newPhotoRecords);
      if (res.success) showToast('記録を追加しました。');
    },
    [appState.spots, commitSpots, showToast]
  );

  const handleUpdateEntry = useCallback(
    async (
      spotId: string,
      entryId: string,
      payload: {
        kind: SpotStatus;
        date: VisitEntry['date'];
        memo: string;
        photos?: PhotoAttachment[];
        newPhotoRecords?: StoredPhotoRecord[];
      }
    ) => {
      const now = new Date().toISOString();
      const next = appState.spots.map((s) => {
        if (s.id !== spotId) return s;
        const nextEntries = sortEntries(
          s.entries.map((e) =>
            e.id === entryId
              ? {
                  ...e,
                  kind: payload.kind,
                  date: payload.date,
                  memo: payload.memo,
                  photos: payload.photos ?? e.photos,
                  updatedAt: now,
                }
              : e
          )
        );
        return {
          ...s,
          entries: nextEntries,
          status: deriveSpotStatus(nextEntries, s.status),
          updatedAt: now,
        };
      });
      const res = await commitSpots(next, payload.newPhotoRecords);
      if (res.success) showToast('記録を更新しました。');
    },
    [appState.spots, commitSpots, showToast]
  );

  const handleDeleteEntry = useCallback(
    async (spotId: string, entryId: string) => {
      const now = new Date().toISOString();
      const next = appState.spots.map((s) => {
        if (s.id !== spotId) return s;
        const nextEntries = s.entries.filter((e) => e.id !== entryId);
        return {
          ...s,
          entries: nextEntries,
          status: deriveSpotStatus(nextEntries, s.status),
          updatedAt: now,
        };
      });
      const res = await commitSpots(next);
      if (res.success) showToast('記録を削除しました。');
    },
    [appState.spots, commitSpots, showToast]
  );

  const handleSharePoint = useCallback(
    async (lng: number, lat: number, name?: string) => {
      const cam = getCurrentCameraSnapshot();
      const url = buildPublicShareUrl({
        lng,
        lat,
        ...cam,
        spotName: name,
        baseMap,
        exaggeration,
      });
      const outcome = await shareOrCopyUrl({ url, title: name ? `${name} — 3D Visit Record` : undefined });
      if (outcome === 'copied') showToast('3D視点リンクをコピーしました（個人記録は含まれません）。');
      else if (outcome === 'failed') showToast('リンクのコピーに失敗しました。');
    },
    [getCurrentCameraSnapshot, baseMap, exaggeration, showToast]
  );

  const handleShareCurrentView = useCallback(async () => {
    const center = mapRef.current?.getCenter();
    await handleSharePoint(
      center?.lng ?? initialCamera.center[0],
      center?.lat ?? initialCamera.center[1],
      selectedSpot?.name ?? inspectedPoint?.label
    );
  }, [handleSharePoint, initialCamera.center, selectedSpot?.name, inspectedPoint?.label]);

  const handleUpdateDriveMeta = useCallback(async (patch: Partial<DriveSyncMeta>) => {
    const res = await updateDriveSyncMeta(patch, false);
    if (res.success && res.state) setAppState(res.state);
  }, []);

  const handlePhotoDriveIdsUpdated = useCallback(async (updates: Record<string, string>) => {
    const res = await patchPhotoDriveFileIds(updates);
    if (res.success && res.state) setAppState(res.state);
  }, []);

  const handlePhotoCacheUpdated = useCallback(() => {
    setPhotoCacheVersion((v) => v + 1);
  }, []);

  const handleApplyImportedSpots = useCallback(
    async (options: {
      nextSpots: VisitSpot[];
      reason: 'drive-restore' | 'json-import';
      driveSyncPatch?: Partial<DriveSyncMeta>;
    }) => {
      const prevSpots = appState.spots;
      const res = await saveSpotsWithUndoAtomic(
        options.nextSpots,
        appState.spots,
        options.reason,
        options.driveSyncPatch
      );
      setStorageWarning(getVisitStorageWarning());
      setStorageBlocked(isVisitStorageBlocked());
      if (res.success && res.state) {
        setAppState(res.state);
        syncPhotoCacheAfterSpotsChange(prevSpots, res.state.spots);
        if (selectedSpotId && !res.state.spots.some((s) => s.id === selectedSpotId)) {
          setSelectedSpotId(null);
        }
      }
      return res;
    },
    [appState.spots, selectedSpotId, syncPhotoCacheAfterSpotsChange]
  );

  const handleUndoLastRestore = useCallback(async () => {
    const prevSpots = appState.spots;
    const res = await restoreUndoSnapshot();
    if (res.success && res.state) {
      setAppState(res.state);
      syncPhotoCacheAfterSpotsChange(prevSpots, res.state.spots);
      showToast('復元前の状態に戻しました。');
    }
    return res;
  }, [appState.spots, showToast, syncPhotoCacheAfterSpotsChange]);

  const handleLocalExportRecorded = useCallback(async (iso: string) => {
    const res = await markLocalExportTimestamp(iso);
    if (res.success && res.state) setAppState(res.state);
  }, []);

  if (routePath === '/privacy' || routePath === '/terms') {
    return (
      <StaticPolicyPage
        page={routePath === '/privacy' ? 'privacy' : 'terms'}
        onNavigateHome={() => navigateRoute('/')}
        onNavigatePage={(p) => navigateRoute(p === 'privacy' ? '/privacy' : '/terms')}
      />
    );
  }

  const mobileFilterOptions: Array<{
    id: StatusFilterValue;
    label: string;
    shortLabel: string;
    count: number;
    icon: React.ReactNode;
    activeClass: string;
  }> = [
    {
      id: 'all',
      label: 'すべて',
      shortLabel: 'すべて',
      count: statusCounts.all,
      icon: <Layers className="w-3.5 h-3.5 shrink-0 text-sky-400" aria-hidden="true" />,
      activeClass: 'bg-sky-500/20 border-sky-400/60 text-white',
    },
    {
      id: 'visited',
      label: '訪問済み',
      shortLabel: '訪問',
      count: statusCounts.visited,
      icon: <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-400" aria-hidden="true" />,
      activeClass: 'bg-emerald-500/20 border-emerald-400/60 text-white',
    },
    {
      id: 'planned',
      label: '訪問予定',
      shortLabel: '予定',
      count: statusCounts.planned,
      icon: <Clock className="w-3.5 h-3.5 shrink-0 text-amber-400" aria-hidden="true" />,
      activeClass: 'bg-amber-500/20 border-amber-400/60 text-white',
    },
  ];
  const activeMobileFilter =
    mobileFilterOptions.find((opt) => opt.id === statusFilter) ?? mobileFilterOptions[0];

  return (
    <div className="app-viewport select-none">
      <MapViewer
        initialCamera={initialCamera}
        spots={appState.spots}
        statusFilter={statusFilter}
        selectedSpotId={selectedSpotId}
        exaggeration={exaggeration}
        baseMap={baseMap}
        prefectureFillEnabled={prefectureFillEnabled}
        prefectureGeoJson={coloredPrefectureGeoJson}
        inspectedPoint={inspectedPoint}
        onStatusChange={setGpuStatus}
        onTileLoadingChange={setIsMapLoading}
        onInspectEmptyPoint={handleInspectEmptyPoint}
        onSelectSpot={(spot) => handleSelectSpot(spot, { preserveCamera: true })}
        onCameraChange={handleCameraChange}
        mapInstanceRef={mapRef}
      />

      {/* Top Header Bar: 左（スマホ時はプルダウン統合タイトル / md以上はタイトル＋フィルター連結ピル）＆ 右（連結ツールバー） */}
      <header className="pointer-events-none fixed top-0 inset-x-0 z-30 safe-header-padding flex items-center justify-between gap-2 md:gap-0">
        {/* スマホ画面用：タイトル＋ステータスフィルター プルダウン */}
        <div className="pointer-events-auto relative md:hidden shrink-0">
          <button
            type="button"
            id="mobile-title-filter-btn"
            onClick={openFilterMenu}
            aria-expanded={isFilterMenuOpen}
            aria-controls="mobile-filter-dropdown"
            aria-label={`3D Visit 表示絞り込み（現在: ${activeMobileFilter.label} ${activeMobileFilter.count}件）`}
            className="min-h-[38px] whitespace-nowrap inline-flex items-center gap-1.5 pl-2.5 pr-2.5 py-1 rounded-full bg-slate-900/90 hover:bg-slate-800/95 backdrop-blur-md border border-slate-700/80 shadow-lg text-white transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            <Compass
              className={`w-4 h-4 text-sky-400 shrink-0 ${
                isMapLoading ? 'animate-spin [animation-duration:2s]' : ''
              }`}
              aria-hidden="true"
            />
            <span className="font-bold text-xs tracking-tight text-white">3D Visit</span>
            <span className="inline-flex items-center gap-1 pl-1.5 border-l border-slate-700/80 text-[11px] font-semibold text-slate-200">
              {activeMobileFilter.icon}
              <span className="hidden min-[380px]:inline">{activeMobileFilter.shortLabel}</span>
              <span className="tabular-nums opacity-85">{activeMobileFilter.count}</span>
              <ChevronDown
                className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 ${
                  isFilterMenuOpen ? 'rotate-180' : ''
                }`}
                aria-hidden="true"
              />
            </span>
          </button>

          {isFilterMenuOpen && (
            <div
              id="mobile-filter-dropdown"
              role="menu"
              aria-label="地図上のステータス絞り込み"
              className="safe-top-left-dropdown fixed z-30 w-52 rounded-2xl bg-slate-900/95 backdrop-blur-md border border-slate-700/85 shadow-2xl p-1.5 space-y-1"
            >
              {mobileFilterOptions.map((opt) => {
                const active = statusFilter === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    id={`mobile-status-filter-${opt.id}`}
                    onClick={() => {
                      setStatusFilter(opt.id);
                      setIsFilterMenuOpen(false);
                    }}
                    className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border text-xs font-semibold transition-colors cursor-pointer ${
                      active
                        ? opt.activeClass
                        : 'border-transparent text-slate-300 hover:bg-slate-800/80 hover:text-white'
                    }`}
                  >
                    <span className="inline-flex items-center gap-2">
                      {opt.icon}
                      <span>{opt.label}</span>
                    </span>
                    <span className="tabular-nums text-[11px] opacity-85">{opt.count}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* PC・タブレット画面用：タイトルピル＋連結フィルターバー */}
        <div
          title="3D Visit Record"
          className="pointer-events-auto hidden md:inline-flex shrink-0 min-h-[42px] whitespace-nowrap items-center gap-1.5 pl-3 pr-2.5 py-1 rounded-full rounded-r-none bg-slate-900/90 backdrop-blur-md border border-slate-700/80 border-r border-r-slate-700/80 shadow-lg"
        >
          <Compass
            className={`w-4 h-4 text-sky-400 shrink-0 ${
              isMapLoading ? 'animate-spin [animation-duration:2s]' : ''
            }`}
            aria-hidden="true"
          />
          <span className="font-bold text-sm tracking-tight text-white">3D Visit</span>
        </div>

        <div className="hidden md:flex pointer-events-none">
          <StatusFilterBar
            value={statusFilter}
            onChange={setStatusFilter}
            counts={statusCounts}
            connectedLeft
          />
        </div>

        {/* Right Connected Action Toolbar */}
        <div className="pointer-events-auto md:ml-auto shrink-0 inline-flex items-center rounded-full bg-slate-900/95 border border-slate-700/80 shadow-lg divide-x divide-slate-700/70">
          <button
            type="button"
            id="nav-toggle-btn"
            onClick={openNav}
            aria-expanded={isNavOpen}
            aria-label="一覧・検索"
            className="whitespace-nowrap inline-flex items-center gap-1.5 min-h-[38px] sm:min-h-[42px] pl-3 pr-2.5 sm:px-3.5 py-1 rounded-l-full hover:bg-slate-800/90 text-xs sm:text-sm font-bold text-slate-100 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            <Search className="w-4 h-4 text-sky-400 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">一覧・検索</span>
          </button>

          <button
            type="button"
            id="cloud-sync-open-btn"
            onClick={openSync}
            aria-label="Drive同期"
            className="relative whitespace-nowrap inline-flex items-center gap-1.5 min-h-[38px] sm:min-h-[42px] px-2.5 sm:px-3.5 py-1 hover:bg-slate-800/90 text-xs sm:text-sm font-bold text-slate-100 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            <Cloud className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">Drive同期</span>
            {hasUnsavedDriveChanges && (
              <span
                title="Driveに未保存の変更があります"
                aria-label="未保存の変更あり"
                className="w-2 h-2 rounded-full bg-amber-400 ring-2 ring-slate-900"
              />
            )}
          </button>

          <LayerMenu
            exaggeration={exaggeration}
            onChangeExaggeration={setExaggeration}
            baseMap={baseMap}
            onChangeBaseMap={setBaseMap}
            prefectureFillEnabled={prefectureFillEnabled}
            onTogglePrefectureFill={setPrefectureFillEnabled}
            prefectureStats={prefectureStats}
            isPrefectureLoading={isPrefectureLoading}
            prefectureLoadError={prefectureLoadError}
            onRetryPrefectureLoad={() => setPrefectureLoadNonce((n) => n + 1)}
            gpuStatus={gpuStatus}
            isOpen={isLayerOpen}
            onToggleOpen={openLayer}
            onShareView={handleShareCurrentView}
            onNavigatePolicy={(page) => {
              setIsLayerOpen(false);
              navigateRoute(page === 'privacy' ? '/privacy' : '/terms');
            }}
            connected
          />

          <button
            type="button"
            id="locate-me-btn"
            onClick={handleLocateCurrentPosition}
            aria-label="現在地へ移動"
            title="現在地へ移動"
            className="inline-flex items-center justify-center min-w-[38px] sm:min-w-[42px] min-h-[38px] sm:min-h-[42px] pl-2.5 pr-3 rounded-r-full hover:bg-slate-800/90 text-sky-400 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            {isLocating ? (
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            ) : (
              <LocateFixed className="w-4 h-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </header>

      {/* Compact Prefecture Fill Legend & Achievement Badge (only when overlay ON) */}
      {prefectureFillEnabled && prefectureStats && !isNavOpen && !isFilterMenuOpen && (
        <aside
          data-testid="prefecture-legend-badge"
          aria-label="都道府県塗りつぶし凡例"
          className="pointer-events-auto fixed z-10 safe-top-left-dropdown rounded-xl bg-slate-900/90 backdrop-blur-md border border-slate-700/80 shadow-lg px-3 py-2 text-[11px] text-slate-100"
        >
          <PrefectureSummaryLegend stats={prefectureStats} compact />
        </aside>
      )}

      {/* Storage warning banner */}
      {storageWarning && (
        <div
          role="alert"
          className="pointer-events-auto fixed top-28 left-1/2 -translate-x-1/2 z-40 max-w-md w-[92vw] p-3 rounded-xl bg-rose-950/95 border border-rose-500/70 text-xs text-rose-100 shadow-2xl flex items-center gap-2"
        >
          <AlertTriangle className="w-4 h-4 text-rose-300 shrink-0" aria-hidden="true" />
          <span className="flex-1">{storageWarning}</span>
          {storageBlocked && (
            <button
              type="button"
              onClick={openSync}
              className="px-2.5 py-1 rounded-lg bg-rose-600 text-white font-bold shrink-0 cursor-pointer"
            >
              救済画面へ
            </button>
          )}
        </div>
      )}

      {/* Toast message */}
      {toastText && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-slate-900/95 border border-sky-400/60 text-xs font-semibold text-white shadow-xl"
        >
          {toastText}
        </div>
      )}

      {/* Backdrop for dropdown menus */}
      {(isLayerOpen || isFilterMenuOpen) && (
        <div
          className="fixed inset-0 z-20 pointer-events-auto"
          onClick={() => {
            setIsLayerOpen(false);
            setIsFilterMenuOpen(false);
          }}
          aria-hidden="true"
        />
      )}

      {/* Navigation Drawer */}
      <SpotNavDrawer
        isOpen={isNavOpen}
        onClose={() => setIsNavOpen(false)}
        spots={appState.spots}
        photoCacheVersion={photoCacheVersion}
        referenceLocation={referenceLocation}
        onSelectSpot={(spot) => handleSelectSpot(spot)}
        onSelectSearchLocation={handleSelectSearchLocation}
        onSelectMountain={handleSelectMountain}
      />

      {/* Hidden file input for photo EXIF spot proposal */}
      <input
        ref={photoProposalInputRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const files = e.target.files;
          if (files && files.length > 0) {
            void handlePhotoProposalFilesSelected(files);
          }
          e.target.value = '';
        }}
      />

      {/* Bottom-right Floating Action Button: 写真から記録を作成（案B） */}
      {!selectedSpot && !inspectedPoint && !photoProposal && !isNavOpen && !isSyncOpen && (
        <button
          type="button"
          id="fab-create-from-photo"
          disabled={isReadingPhotoExif}
          onClick={() => photoProposalInputRef.current?.click()}
          aria-label="写真から記録を作成"
          title="写真の位置情報から記録を作成"
          className="pointer-events-auto absolute bottom-[calc(max(var(--safe-bottom),var(--safe-top))+3rem)] sm:bottom-[calc(max(var(--safe-bottom),var(--safe-top))+2.5rem)] right-3 sm:right-4 z-20 inline-flex items-center justify-center gap-2 min-w-[48px] min-h-[48px] px-3 sm:px-4 rounded-full bg-sky-600 hover:bg-sky-500 active:bg-sky-700 disabled:opacity-60 text-white text-xs sm:text-sm font-bold shadow-xl border border-sky-400/50 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
        >
          {isReadingPhotoExif ? (
            <Loader2 className="w-5 h-5 animate-spin shrink-0" aria-hidden="true" />
          ) : (
            <Camera className="w-5 h-5 shrink-0" aria-hidden="true" />
          )}
          <span className="hidden sm:inline">写真から記録</span>
        </button>
      )}

      {/* Photo EXIF Spot Proposal Card */}
      {photoProposal && (
        <PhotoProposalCard
          proposal={photoProposal}
          onAcceptAddEntry={handleAcceptAddEntryFromPhoto}
          onAcceptCreateSpot={handleAcceptCreateSpotFromPhoto}
          onDismiss={handleDismissPhotoProposal}
        />
      )}

      {/* Detail / Registration Sheet */}
      <SpotDetailSheet
        selectedSpot={selectedSpot}
        inspectedPoint={inspectedPoint}
        nearbyDuplicateSpot={nearbyDuplicateSpot}
        pendingPhotoDraft={pendingPhotoDraft}
        onClearPendingPhotoDraft={() => setPendingPhotoDraft(null)}
        photoCacheVersion={photoCacheVersion}
        onPhotoCached={handlePhotoCacheUpdated}
        onClose={() =>
          runViewTransition(() => {
            setPendingPhotoDraft(null);
            setSelectedSpotId(null);
            setInspectedPoint(null);
          })
        }
        onSelectExistingSpot={(spot) => handleSelectSpot(spot)}
        onCreateSpot={handleCreateSpot}
        onUpdateSpotMeta={handleUpdateSpotMeta}
        onUpdateSpotCamera={handleUpdateSpotCamera}
        onDeleteSpot={handleDeleteSpot}
        onAddEntry={handleAddEntry}
        onUpdateEntry={handleUpdateEntry}
        onDeleteEntry={handleDeleteEntry}
        onSharePoint={handleSharePoint}
        onFlyToSpot={(spot) => flyTo(spot.center, spot.camera)}
      />

      {/* Native <dialog> Cloud Sync Modal */}
      <CloudSyncDialog
        isOpen={isSyncOpen}
        onClose={() => setIsSyncOpen(false)}
        spots={appState.spots}
        revision={appState.revision}
        driveSync={appState.driveSync}
        undoSnapshot={appState.undo}
        hasUnsavedDriveChanges={hasUnsavedDriveChanges}
        onUpdateDriveMeta={handleUpdateDriveMeta}
        onPhotoDriveIdsUpdated={handlePhotoDriveIdsUpdated}
        onPhotoCacheUpdated={handlePhotoCacheUpdated}
        onApplyImportedSpots={handleApplyImportedSpots}
        onUndoLastRestore={handleUndoLastRestore}
        onLocalExportRecorded={handleLocalExportRecorded}
      />
    </div>
  );
};

export default App;
