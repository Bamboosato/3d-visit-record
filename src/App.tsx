import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as maplibregl from 'maplibre-gl';
import {
  AlertTriangle,
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
import { SpotDetailSheet } from './components/SpotDetailSheet';
import { SpotNavDrawer } from './components/SpotNavDrawer';
import { CloudSyncDialog } from './components/CloudSyncDialog';
import { LayerMenu } from './components/LayerMenu';
import { StaticPolicyPage } from './components/StaticPolicyPage';
import { DEFAULT_INITIAL_CAMERA } from './lib/maplibreHelper';
import { fetchPointElevationFromAW3D } from './lib/jaxaClient';
import {
  createEmptyAppState,
  getVisitStorageWarning,
  isVisitStorageBlocked,
  loadAppState,
  loadUiPreferences,
  markLocalExportTimestamp,
  requestPersistentStorage,
  restoreUndoSnapshot,
  saveSpots,
  saveSpotsWithUndoAtomic,
  saveUiPreferences,
  updateDriveSyncMeta,
  type StorageOperationResult,
} from './lib/visitStorage';
import {
  createUuid,
  deriveSpotStatus,
  isSameCoordinate,
  matchesStatusFilter,
} from './lib/spotDomain';
import { HYAKUMEIZAN_PRESETS } from './lib/hyakumeizanData';
import { calcDistanceMeters } from './lib/osmPlaceClient';
import {
  buildPublicShareUrl,
  parseUrlViewState,
  replaceUrlViewState,
  shareOrCopyUrl,
} from './lib/urlSync';
import { runViewTransition } from './lib/viewTransition';
import { getVisitDateRange } from './lib/visitDate';
import {
  MAX_ENTRIES_PER_SPOT,
  MAX_SPOTS,
  type BaseMapId,
  type DriveSyncMeta,
  type InspectedPoint,
  type LocalAppState,
  type PresetMountain,
  type SpotCamera,
  type SpotCategory,
  type SpotStatus,
  type StatusFilterValue,
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
  const [toastText, setToastText] = useState<string | null>(null);

  const mapRef = useRef<maplibregl.Map | null>(null);
  const cameraSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    saveUiPreferences({ baseMap, exaggeration, statusFilter });
  }, [baseMap, exaggeration, statusFilter]);

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
    return (
      appState.driveSync.lastSyncedRevision === null ||
      appState.revision > appState.driveSync.lastSyncedRevision
    );
  }, [appState.spots.length, appState.revision, appState.driveSync.lastSyncedRevision]);

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

  const commitSpots = useCallback(
    async (nextSpots: VisitSpot[]): Promise<StorageOperationResult> => {
      const res = await saveSpots(nextSpots);
      setStorageWarning(getVisitStorageWarning());
      setStorageBlocked(isVisitStorageBlocked());
      if (res.success && res.state) {
        setAppState(res.state);
        requestPersistentStorage();
      } else if (res.message) {
        showToast(res.message);
      }
      return res;
    },
    [showToast]
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
            photos: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      };

      const res = await commitSpots([newSpot, ...appState.spots]);
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
    async (spotId: string, payload: { kind: SpotStatus; date: VisitEntry['date']; memo: string }) => {
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
        photos: [],
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
      const res = await commitSpots(next);
      if (res.success) showToast('記録を追加しました。');
    },
    [appState.spots, commitSpots, showToast]
  );

  const handleUpdateEntry = useCallback(
    async (
      spotId: string,
      entryId: string,
      payload: { kind: SpotStatus; date: VisitEntry['date']; memo: string }
    ) => {
      const now = new Date().toISOString();
      const next = appState.spots.map((s) => {
        if (s.id !== spotId) return s;
        const nextEntries = sortEntries(
          s.entries.map((e) =>
            e.id === entryId
              ? { ...e, kind: payload.kind, date: payload.date, memo: payload.memo, updatedAt: now }
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
      const res = await commitSpots(next);
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

  const handleApplyImportedSpots = useCallback(
    async (options: {
      nextSpots: VisitSpot[];
      reason: 'drive-restore' | 'json-import';
      driveSyncPatch?: Partial<DriveSyncMeta>;
    }) => {
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
        if (selectedSpotId && !res.state.spots.some((s) => s.id === selectedSpotId)) {
          setSelectedSpotId(null);
        }
      }
      return res;
    },
    [appState.spots, selectedSpotId]
  );

  const handleUndoLastRestore = useCallback(async () => {
    const res = await restoreUndoSnapshot();
    if (res.success && res.state) {
      setAppState(res.state);
      showToast('復元前の状態に戻しました。');
    }
    return res;
  }, [showToast]);

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
        inspectedPoint={inspectedPoint}
        onStatusChange={setGpuStatus}
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
            <Compass className="w-4 h-4 text-sky-400 shrink-0" aria-hidden="true" />
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
          <Compass className="w-4 h-4 text-sky-400 shrink-0" aria-hidden="true" />
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
        referenceLocation={referenceLocation}
        onSelectSpot={(spot) => handleSelectSpot(spot)}
        onSelectSearchLocation={handleSelectSearchLocation}
        onSelectMountain={handleSelectMountain}
      />

      {/* Detail / Registration Sheet */}
      <SpotDetailSheet
        selectedSpot={selectedSpot}
        inspectedPoint={inspectedPoint}
        nearbyDuplicateSpot={nearbyDuplicateSpot}
        onClose={() =>
          runViewTransition(() => {
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
        onApplyImportedSpots={handleApplyImportedSpots}
        onUndoLastRestore={handleUndoLastRestore}
        onLocalExportRecorded={handleLocalExportRecorded}
      />
    </div>
  );
};

export default App;
