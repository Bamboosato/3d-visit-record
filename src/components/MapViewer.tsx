import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Loader2 } from 'lucide-react';
import type {
  BaseMapId,
  InspectedPoint,
  SpotCamera,
  StatusFilterValue,
  VisitSpot,
  WebGPUStatus,
} from '../types/visit';
import {
  createMapInstance,
  DEFAULT_INITIAL_CAMERA,
  initGraphicsBackend,
  registerVisitMapProtocols,
} from '../lib/maplibreHelper';
import { getSpotSpriteId, registerSpotSprites } from '../lib/spotCategories';
import { isHybridSpot, matchesStatusFilter } from '../lib/spotDomain';

interface ViewportLabel {
  id: string;
  name: string;
  x: number;
  y: number;
  isSelected: boolean;
  status: VisitSpot['status'];
}

interface MapViewerProps {
  initialCamera?: { center: [number, number] } & SpotCamera;
  spots: VisitSpot[];
  statusFilter: StatusFilterValue;
  selectedSpotId: string | null;
  exaggeration: number;
  baseMap: BaseMapId;
  inspectedPoint: InspectedPoint | null;
  onStatusChange: (status: WebGPUStatus) => void;
  onInspectEmptyPoint: (point: InspectedPoint) => void;
  onSelectSpot: (spot: VisitSpot) => void;
  onCameraChange?: (view: {
    lat: number;
    lng: number;
    zoom: number;
    pitch: number;
    bearing: number;
  }) => void;
  mapInstanceRef?: React.MutableRefObject<maplibregl.Map | null>;
}

const SPOTS_SOURCE_ID = 'visit-spots-source';
const SPOTS_LAYER_ID = 'visit-spots-pins';
const MAX_VIEWPORT_LABELS = 50;
const LABEL_ZOOM_THRESHOLD = 9.0;

export const MapViewer: React.FC<MapViewerProps> = ({
  initialCamera = DEFAULT_INITIAL_CAMERA,
  spots,
  statusFilter,
  selectedSpotId,
  exaggeration,
  baseMap,
  inspectedPoint,
  onStatusChange,
  onInspectEmptyPoint,
  onSelectSpot,
  onCameraChange,
  mapInstanceRef,
}) => {
  const [isTilesLoading, setIsTilesLoading] = useState<boolean>(true);
  const [mapReady, setMapReady] = useState(false);
  const [viewportLabels, setViewportLabels] = useState<ViewportLabel[]>([]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const internalMapRef = useRef<maplibregl.Map | null>(null);
  const inspectMarkerRef = useRef<maplibregl.Marker | null>(null);

  const latestSpotsRef = useRef<VisitSpot[]>(spots);
  const latestFilterRef = useRef<StatusFilterValue>(statusFilter);
  const latestSelectedIdRef = useRef<string | null>(selectedSpotId);
  const latestExaggerationRef = useRef<number>(exaggeration);
  const latestBaseMapRef = useRef<BaseMapId>(baseMap);

  const onInspectEmptyPointRef = useRef(onInspectEmptyPoint);
  const onSelectSpotRef = useRef(onSelectSpot);
  const onCameraChangeRef = useRef(onCameraChange);
  const onStatusChangeRef = useRef(onStatusChange);

  latestSpotsRef.current = spots;
  latestFilterRef.current = statusFilter;
  latestSelectedIdRef.current = selectedSpotId;
  latestExaggerationRef.current = exaggeration;
  latestBaseMapRef.current = baseMap;
  onInspectEmptyPointRef.current = onInspectEmptyPoint;
  onSelectSpotRef.current = onSelectSpot;
  onCameraChangeRef.current = onCameraChange;
  onStatusChangeRef.current = onStatusChange;

  const filteredSpots = useMemo(
    () => spots.filter((s) => matchesStatusFilter(s, statusFilter)),
    [spots, statusFilter]
  );

  const syncViewportLabels = () => {
    const map = internalMapRef.current;
    if (!map) return;
    if (map.getZoom() < LABEL_ZOOM_THRESHOLD) {
      setViewportLabels((prev) => (prev.length === 0 ? prev : []));
      return;
    }

    const bounds = map.getBounds();
    const activeList = latestSpotsRef.current.filter((s) =>
      matchesStatusFilter(s, latestFilterRef.current)
    );
    const inView = activeList.filter((s) => bounds.contains(s.center));

    inView.sort((a, b) => {
      const aSel = a.id === latestSelectedIdRef.current ? 1 : 0;
      const bSel = b.id === latestSelectedIdRef.current ? 1 : 0;
      if (aSel !== bSel) return bSel - aSel;
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });

    const nextLabels: ViewportLabel[] = [];
    for (const s of inView.slice(0, MAX_VIEWPORT_LABELS)) {
      const pt = map.project(s.center);
      nextLabels.push({
        id: s.id,
        name: s.name,
        x: Math.round(pt.x),
        y: Math.round(pt.y),
        isSelected: s.id === latestSelectedIdRef.current,
        status: s.status,
      });
    }
    setViewportLabels(nextLabels);
  };

  useEffect(() => {
    if (!containerRef.current || internalMapRef.current) return;

    let disposed = false;
    let rafId = 0;
    let frameCount = 0;
    let lastFpsTime = performance.now();
    let resizeObserver: ResizeObserver | null = null;
    let clearTileLoadingTimeout = () => {};
    let clearMoveEndSettleTimer = () => {};
    let backendStatus: Omit<WebGPUStatus, 'fps'> = {
      backend: 'webgpu',
      webgpuAvailable: true,
      adapterInfo: 'Initializing WebGPU...',
    };

    registerVisitMapProtocols(256);

    const setup = async () => {
      backendStatus = await initGraphicsBackend();
      if (disposed || !containerRef.current) return;

      const map = createMapInstance(containerRef.current, initialCamera, backendStatus.backend);
      internalMapRef.current = map;
      if (mapInstanceRef) mapInstanceRef.current = map;

      let tileLoadingTimeout: ReturnType<typeof setTimeout> | null = null;
      let moveEndSettleTimer: ReturnType<typeof setTimeout> | null = null;

      clearTileLoadingTimeout = () => {
        if (tileLoadingTimeout !== null) {
          clearTimeout(tileLoadingTimeout);
          tileLoadingTimeout = null;
        }
      };
      clearMoveEndSettleTimer = () => {
        if (moveEndSettleTimer !== null) {
          clearTimeout(moveEndSettleTimer);
          moveEndSettleTimer = null;
        }
      };

      const emitCameraView = () => {
        if (disposed) return;
        const center = map.getCenter();
        onCameraChangeRef.current?.({
          lat: center.lat,
          lng: center.lng,
          zoom: map.getZoom(),
          pitch: map.getPitch(),
          bearing: map.getBearing(),
        });
      };

      map.on('move', syncViewportLabels);
      map.on('zoom', syncViewportLabels);
      map.on('moveend', () => {
        if (disposed) return;
        emitCameraView();
        syncViewportLabels();
        clearMoveEndSettleTimer();
        let retries = 4;
        const checkSettle = () => {
          if (disposed) return;
          if (map.areTilesLoaded() || retries <= 0) {
            clearTileLoadingTimeout();
            setIsTilesLoading(false);
          } else {
            retries -= 1;
            moveEndSettleTimer = setTimeout(checkSettle, 200);
          }
        };
        moveEndSettleTimer = setTimeout(checkSettle, 250);
      });

      map.on('dataloading', (e) => {
        if (disposed) return;
        if (e.dataType === 'source') {
          setIsTilesLoading(true);
          clearTileLoadingTimeout();
          tileLoadingTimeout = setTimeout(() => {
            if (!disposed) setIsTilesLoading(false);
          }, 2500);
        }
      });

      map.on('idle', () => {
        if (disposed) return;
        clearTileLoadingTimeout();
        clearMoveEndSettleTimer();
        setIsTilesLoading(false);
      });

      map.on('error', () => {
        if (disposed) return;
        if (map.areTilesLoaded()) {
          clearTileLoadingTimeout();
          clearMoveEndSettleTimer();
          setIsTilesLoading(false);
        }
      });

      if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
        resizeObserver = new ResizeObserver(() => {
          if (!disposed) {
            map.resize();
            syncViewportLabels();
          }
        });
        resizeObserver.observe(containerRef.current);
      }

      map.addControl(
        new maplibregl.NavigationControl({
          visualizePitch: true,
          showZoom: true,
          showCompass: true,
        }),
        'bottom-left'
      );
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left');

      map.on('load', () => {
        if (disposed) return;

        if (!map.getSource('terrain')) {
          map.addSource('terrain', {
            type: 'raster-dem',
            tiles: ['jaxa-aw3d://{z}/{x}/{y}'],
            tileSize: 256,
            maxzoom: 11,
            encoding: 'mapbox',
            attribution:
              '<a href="https://data.earth.jaxa.jp/" target="_blank" rel="noreferrer">JAXA Earth API (AW3D30)</a>',
          });
        }

        map.setTerrain({
          source: 'terrain',
          exaggeration: latestExaggerationRef.current,
        });

        if (!map.getLayer('terrain-hillshade')) {
          map.addLayer({
            id: 'terrain-hillshade',
            type: 'hillshade',
            source: 'terrain',
            paint: {
              'hillshade-exaggeration': 0.45,
              'hillshade-shadow-color': '#020617',
              'hillshade-highlight-color': '#f8fafc',
              'hillshade-accent-color': '#334155',
            },
          });
        }

        // Apply initial basemap selection
        (['osm', 'hillshade', 'photo'] as BaseMapId[]).forEach((id) => {
          const layerId = `base-${id}`;
          if (map.getLayer(layerId)) {
            map.setLayoutProperty(
              layerId,
              'visibility',
              id === latestBaseMapRef.current ? 'visible' : 'none'
            );
          }
        });

        // Register 12 Canvas sprites & GeoJSON symbol layer (glyphs-free)
        registerSpotSprites(map);
        if (!map.getSource(SPOTS_SOURCE_ID)) {
          map.addSource(SPOTS_SOURCE_ID, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
          });
        }
        if (!map.getLayer(SPOTS_LAYER_ID)) {
          map.addLayer({
            id: SPOTS_LAYER_ID,
            type: 'symbol',
            source: SPOTS_SOURCE_ID,
            layout: {
              'icon-image': ['get', 'spriteId'],
              'icon-size': ['case', ['==', ['get', 'isSelected'], true], 1.24, 1.0],
              'icon-allow-overlap': ['step', ['zoom'], false, 11, true],
              'icon-ignore-placement': false,
              'symbol-sort-key': ['get', 'sortKey'],
            },
          });
        }

        map.on('mouseenter', SPOTS_LAYER_ID, () => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', SPOTS_LAYER_ID, () => {
          map.getCanvas().style.cursor = '';
        });

        setMapReady(true);
      });

      map.on('click', async (e) => {
        if (disposed) return;

        if (map.getLayer(SPOTS_LAYER_ID)) {
          const hitFeatures = map.queryRenderedFeatures(e.point, {
            layers: [SPOTS_LAYER_ID],
          });
          const spotId = hitFeatures[0]?.properties?.spotId as string | undefined;
          if (spotId) {
            const matched = latestSpotsRef.current.find((s) => s.id === spotId);
            if (matched) {
              onSelectSpotRef.current(matched);
              return;
            }
          }
        }

        const { lng, lat } = e.lngLat;
        onInspectEmptyPointRef.current({ lng, lat, elevation: null });
      });

      const tickFps = () => {
        if (disposed) return;
        frameCount++;
        const now = performance.now();
        if (now - lastFpsTime >= 1000) {
          const fps = Math.round((frameCount * 1000) / (now - lastFpsTime));
          onStatusChangeRef.current({ ...backendStatus, fps });
          frameCount = 0;
          lastFpsTime = now;
        }
        rafId = requestAnimationFrame(tickFps);
      };
      rafId = requestAnimationFrame(tickFps);
    };

    void setup();

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      clearTileLoadingTimeout();
      clearMoveEndSettleTimer();
      resizeObserver?.disconnect();
      inspectMarkerRef.current?.remove();
      inspectMarkerRef.current = null;
      if (internalMapRef.current) {
        internalMapRef.current.remove();
        internalMapRef.current = null;
      }
      if (mapInstanceRef) mapInstanceRef.current = null;
    };
  }, []);

  // Sync filtered spots to GeoJSON source
  useEffect(() => {
    const map = internalMapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource(SPOTS_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
    if (!source) return;

    const features: GeoJSON.Feature<GeoJSON.Point>[] = filteredSpots.map((spot) => {
      const isSelected = spot.id === selectedSpotId;
      const sortKey =
        (isSelected ? 0 : spot.isPinned ? 10 : spot.status === 'visited' ? 20 : 30) -
        Math.min(9, Date.parse(spot.updatedAt) / 1e13);
      return {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: spot.center,
        },
        properties: {
          spotId: spot.id,
          spriteId: getSpotSpriteId(spot.category, spot.status, isHybridSpot(spot)),
          isSelected,
          sortKey,
        },
      };
    });

    source.setData({ type: 'FeatureCollection', features });
    syncViewportLabels();
  }, [filteredSpots, selectedSpotId, mapReady]);

  // Sync exaggeration
  useEffect(() => {
    const map = internalMapRef.current;
    if (!map || !mapReady) return;
    try {
      map.setTerrain({ source: 'terrain', exaggeration });
    } catch {
      // ignore if terrain not yet mounted
    }
  }, [exaggeration, mapReady]);

  // Sync baseMap visibility
  useEffect(() => {
    const map = internalMapRef.current;
    if (!map || !mapReady) return;
    (['osm', 'hillshade', 'photo'] as BaseMapId[]).forEach((id) => {
      const layerId = `base-${id}`;
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', id === baseMap ? 'visible' : 'none');
      }
    });
  }, [baseMap, mapReady]);

  // Single DOM marker for unregistered inspected point
  useEffect(() => {
    const map = internalMapRef.current;
    if (!map || !mapReady) return;

    if (!inspectedPoint) {
      inspectMarkerRef.current?.remove();
      inspectMarkerRef.current = null;
      return;
    }

    if (!inspectMarkerRef.current) {
      const el = document.createElement('div');
      el.className =
        'w-5 h-5 rounded-full bg-sky-400 border-2 border-white shadow-[0_0_16px_rgba(56,189,248,0.9)] animate-pulse pointer-events-none';
      inspectMarkerRef.current = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([inspectedPoint.lng, inspectedPoint.lat])
        .addTo(map);
    } else {
      inspectMarkerRef.current.setLngLat([inspectedPoint.lng, inspectedPoint.lat]);
    }
  }, [inspectedPoint, mapReady]);

  return (
    <div className="relative w-full h-full">
      <div
        ref={containerRef}
        id="visit-map-container"
        data-testid="visit-map-container"
        className="w-full h-full bg-slate-950"
      />

      {/* Zoom >= 9 viewport-culled non-interactive spot labels */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden z-[5]" aria-hidden="true">
        {viewportLabels.map((lbl) => (
          <div
            key={lbl.id}
            style={{
              transform: `translate3d(${lbl.x}px, ${lbl.y}px, 0) translate(-50%, 16px)`,
            }}
            className={`absolute top-0 left-0 px-2 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap max-w-[140px] truncate shadow-md border ${
              lbl.isSelected
                ? 'bg-sky-600/95 text-white border-sky-200'
                : lbl.status === 'visited'
                  ? 'bg-slate-900/90 text-slate-100 border-emerald-400/50'
                  : 'bg-slate-900/90 text-amber-100 border-amber-400/50 border-dashed'
            }`}
          >
            {lbl.name}
          </div>
        ))}
      </div>

      {isTilesLoading && (
        <div
          aria-live="polite"
          className="pointer-events-none absolute top-20 right-4 z-10 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-900/80 backdrop-blur border border-slate-700/70 text-[11px] text-slate-300 shadow"
        >
          <Loader2 className="w-3 h-3 animate-spin text-sky-400" aria-hidden="true" />
          <span>3D地形読込中</span>
        </div>
      )}
    </div>
  );
};
