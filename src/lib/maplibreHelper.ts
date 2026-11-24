import { bounded, abortableDelay } from './asyncLifecycle';
import * as maplibregl from 'maplibre-gl';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { BaseMapId, RendererBackend, SpotCamera, WebGPUStatus } from '../types/visit';
import {
  expandPrefecturePolygonsForRendering,
  type PrefectureFeatureCollection,
} from './prefectureStats';
import { getAW3DTileGenerator, getJaxaEarth } from './jaxaClient';
import { fetchTileBytesWithRetry, getTileWithOpfsSWR, TileHttpError } from './opfsTileCache';

if (typeof window !== 'undefined') {
  maplibregl.setWorkerUrl(mapWorkerUrl);
}

export const DEFAULT_INITIAL_CAMERA: { center: [number, number] } & SpotCamera = {
  center: [137.5, 36.2],
  zoom: 4.8,
  pitch: 35,
  bearing: 0,
};

const UPSTREAM_RASTER_TEMPLATES: Record<BaseMapId, string> = {
  osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  hillshade: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
  photo:
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
};

// 1x1 transparent PNG used when a regional basemap (GSI pale) returns 404 outside Japan.
const TRANSPARENT_1X1_PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
  0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 96, 0, 0, 0, 2, 0, 1, 226,
  33, 188, 51, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

export const BASE_MAP_SOURCES: Record<
  BaseMapId,
  {
    name: string;
    description: string;
    tiles: string[];
    attribution: string;
    maxzoom: number;
    japanOnlyNote?: string;
  }
> = {
  osm: {
    name: 'OpenStreetMap（標準・全球）',
    description: '国内・海外の道路・都市名・施設を網羅した標準マップ',
    tiles: ['opfs-raster://osm/{z}/{x}/{y}'],
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    maxzoom: 19,
  },
  photo: {
    name: '航空写真（衛星・全球）',
    description: '地形・街並み・自然景観をリアルに映す高解像度衛星写真',
    tiles: ['opfs-raster://photo/{z}/{x}/{y}'],
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics',
    maxzoom: 18,
  },
  hillshade: {
    name: '国土地理院 淡色地図（※日本国内向け）',
    description: '日本国内の地形・等高線が見やすい淡色マップ（海外域は透過表示）',
    tiles: ['opfs-raster://hillshade/{z}/{x}/{y}'],
    attribution:
      '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">国土地理院 淡色地図</a>',
    maxzoom: 18,
    japanOnlyNote: '※日本国内向け',
  },
};

let protocolRegistered = false;
const flatZeroTerrainPngCache = new Map<number, Uint8Array>();

export async function initGraphicsBackend(): Promise<Omit<WebGPUStatus, 'fps'>> {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      const gpu = (navigator as Navigator & { gpu?: any }).gpu;
      if (gpu) {
        const adapter = await gpu.requestAdapter({
          powerPreference: 'high-performance',
        });
        if (adapter) {
          const device = await adapter.requestDevice();
          const info = adapter.info || {};
          const adapterLabel =
            [info.vendor, info.architecture || info.device].filter(Boolean).join(' ') ||
            'WebGPU High-Performance Adapter';

          try {
            const shaderModule = device.createShaderModule({
              code: `
                @compute @workgroup_size(64)
                fn main(@builtin(global_invocation_id) id: vec3<u32>) {
                  let _idx = id.x;
                }
              `,
            });
            await device.createComputePipelineAsync({
              layout: 'auto',
              compute: { module: shaderModule, entryPoint: 'main' },
            });
          } catch {
            // warmup optional
          }

          return {
            backend: 'webgpu',
            webgpuAvailable: true,
            adapterInfo: `${adapterLabel} (WebGPU Active)`,
          };
        }
      }
    } catch {
      // fallback to WebGL2
    }
  }

  return {
    backend: 'webgl2',
    webgpuAvailable: false,
    adapterInfo: 'WebGL2 Fallback Pipeline',
  };
}

async function encodeTerrainRGBPng(
  data: Float32Array | Uint32Array | null,
  tileSize: number
): Promise<Uint8Array> {
  if (!data) {
    const cachedFlat = flatZeroTerrainPngCache.get(tileSize);
    if (cachedFlat) return cachedFlat;
  }

  const je = await getJaxaEarth();
  const rgba = new Uint8ClampedArray(tileSize * tileSize * 4);

  if (data) {
    const len = Math.min(data.length, tileSize * tileSize);
    for (let i = 0; i < len; i++) {
      let height = data[i];
      if (Number.isNaN(height) || !Number.isFinite(height) || height < -500) {
        height = 0;
      }
      const h = Math.round((height + 10000) * 10) | 0;
      const offset = i * 4;
      rgba[offset] = (h >>> 16) & 255;
      rgba[offset + 1] = (h >>> 8) & 255;
      rgba[offset + 2] = h & 255;
      rgba[offset + 3] = 255;
    }
  } else {
    for (let i = 0; i < tileSize * tileSize; i++) {
      const offset = i * 4;
      rgba[offset] = 1;
      rgba[offset + 1] = 134;
      rgba[offset + 2] = 160;
      rgba[offset + 3] = 255;
    }
  }

  const pngBytes: Uint8Array = await je.image.createPngUint8ArrayByImageDataObject({
    width: tileSize,
    height: tileSize,
    data: rgba,
  });

  if (!data) {
    flatZeroTerrainPngCache.set(tileSize, pngBytes);
  }

  return pngBytes;
}

export async function fetchRasterTileForBasemap(
  sourceId: BaseMapId,
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const template = UPSTREAM_RASTER_TEMPLATES[sourceId] ?? UPSTREAM_RASTER_TEMPLATES.osm;
  const upstreamUrl = template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));

  return getTileWithOpfsSWR({
    category: 'raster',
    key: `${sourceId}_${z}_${x}_${y}`,
    signal,
    fetcher: async (sig) => {
      try {
        return await fetchTileBytesWithRetry(upstreamUrl, sig || signal);
      } catch (err) {
        if (sourceId === 'hillshade' && err instanceof TileHttpError && err.status === 404) {
          return TRANSPARENT_1X1_PNG;
        }
        throw err;
      }
    },
  });
}

export function registerVisitMapProtocols(tileSize = 256): void {
  if (protocolRegistered) return;
  protocolRegistered = true;

  maplibregl.addProtocol('opfs-raster', async (params, abortController) => {
    const signal = abortController?.signal;
    if (signal?.aborted) throw new Error('Aborted');
    const parts = params.url.replace('opfs-raster://', '').split('/');
    const sourceId = (parts[0] as BaseMapId) || 'osm';
    const z = parseInt(parts[1], 10);
    const x = parseInt(parts[2], 10);
    const y = parseInt(parts[3], 10);

    const buffer = await fetchRasterTileForBasemap(sourceId, z, x, y, signal);
    return { data: buffer };
  });

  maplibregl.addProtocol('jaxa-aw3d', async (params, abortController) => {
    const signal = abortController?.signal;
    if (signal?.aborted) throw new Error('Aborted');
    const parts = params.url.replace('jaxa-aw3d://', '').split('/');
    const z = parseInt(parts[0], 10);
    const x = parseInt(parts[1], 10);
    const y = parseInt(parts[2], 10);

    const buffer = await getTileWithOpfsSWR({
      category: 'terrain',
      key: `aw3d_v3.2_rgb-v3_${tileSize}_${z}_${x}_${y}`,
      signal,
      fetcher: async (requestSignal) => {
        let lastError: unknown = null;
        for (let attempt = 0; attempt <= 2; attempt++) {
          try {
            const tg = await getAW3DTileGenerator(tileSize);
            const dataObject = await bounded(
              tg.getDataObject(x, y, z, requestSignal),
              15000,
              requestSignal
            );
            if (!dataObject || !dataObject.data) {
              throw new Error('No land elevation data for tile');
            }
            return await encodeTerrainRGBPng(dataObject.data, tileSize);
          } catch (err) {
            if (requestSignal?.aborted) throw err;
            lastError = err;
            if (attempt < 2) {
              await abortableDelay(180 * (attempt + 1), requestSignal);
            }
          }
        }
        throw lastError ?? new Error(`Failed to load terrain tile ${z}/${x}/${y}`);
      },
    });

    return { data: buffer };
  });
}

export function createMapInstance(
  container: HTMLElement | string,
  initialCamera: { center: [number, number] } & SpotCamera = DEFAULT_INITIAL_CAMERA,
  preferredBackend: RendererBackend = 'webgpu'
): maplibregl.Map {
  const baseStyle: maplibregl.StyleSpecification = {
    version: 8,
    sky: {
      'sky-color': '#091428',
      'sky-horizon-blend': 0.45,
      'horizon-color': '#1e3a5f',
      'horizon-fog-blend': 0.6,
      'fog-color': '#0f172a',
      'fog-ground-blend': 0.35,
    },
    sources: {
      osm: {
        type: 'raster',
        tiles: BASE_MAP_SOURCES.osm.tiles,
        tileSize: 256,
        attribution: BASE_MAP_SOURCES.osm.attribution,
        maxzoom: BASE_MAP_SOURCES.osm.maxzoom,
      },
      hillshade: {
        type: 'raster',
        tiles: BASE_MAP_SOURCES.hillshade.tiles,
        tileSize: 256,
        attribution: BASE_MAP_SOURCES.hillshade.attribution,
        maxzoom: BASE_MAP_SOURCES.hillshade.maxzoom,
      },
      photo: {
        type: 'raster',
        tiles: BASE_MAP_SOURCES.photo.tiles,
        tileSize: 256,
        attribution: BASE_MAP_SOURCES.photo.attribution,
        maxzoom: BASE_MAP_SOURCES.photo.maxzoom,
      },
    },
    layers: [
      {
        id: 'base-osm',
        type: 'raster',
        source: 'osm',
        layout: { visibility: 'visible' },
        paint: {
          'raster-brightness-max': 0.9,
          'raster-contrast': 0.1,
          'raster-saturation': -0.1,
        },
      },
      {
        id: 'base-hillshade',
        type: 'raster',
        source: 'hillshade',
        layout: { visibility: 'none' },
        paint: {
          'raster-brightness-max': 0.92,
          'raster-contrast': 0.25,
          'raster-saturation': -0.4,
        },
      },
      {
        id: 'base-photo',
        type: 'raster',
        source: 'photo',
        layout: { visibility: 'none' },
        paint: {
          'raster-brightness-max': 0.95,
          'raster-contrast': 0.08,
        },
      },
    ],
  };

  const baseMapOptions: maplibregl.MapOptions = {
    container,
    style: baseStyle,
    center: initialCamera.center,
    zoom: initialCamera.zoom,
    pitch: initialCamera.pitch,
    bearing: initialCamera.bearing,
    maxPitch: 85,
    minZoom: 1.5,
    maxZoom: 18,
    fadeDuration: 0,
    attributionControl: false,
  };

  try {
    return new maplibregl.Map({
      ...baseMapOptions,
      canvasContextAttributes: {
        powerPreference: 'high-performance',
        antialias: preferredBackend === 'webgpu',
        desynchronized: true,
        contextType: 'webgl2',
      },
    });
  } catch {
    return new maplibregl.Map(baseMapOptions);
  }
}

export const PREFECTURE_SOURCE_ID = 'japan-prefectures-source';
export const PREFECTURE_FILL_LAYER_ID = 'japan-prefectures-fill';
export const PREFECTURE_LINE_CASING_LAYER_ID = 'japan-prefectures-line-casing';
export const PREFECTURE_LINE_LAYER_ID = 'japan-prefectures-line';

const PREFECTURE_CASING_COLOR = '#0f172a';

function buildPrefectureFillColorExpression(): maplibregl.ExpressionSpecification {
  return ['match', ['get', 'status'], 'visited', '#10b981', 'planned', '#f59e0b', '#475569'];
}

function buildPrefectureFillOpacityExpression(): maplibregl.ExpressionSpecification {
  return ['match', ['get', 'status'], 'visited', 0.42, 'planned', 0.4, 0.08];
}

function buildPrefectureCasingWidthExpression(): maplibregl.ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], 2, 0.8, 4, 1.4, 6, 2.2, 9, 3.0, 12, 3.6];
}

function buildTieredLineOpacityExpression(
  visitedOpacity: number,
  plannedOpacity: number,
  noneOpacity: number
): maplibregl.ExpressionSpecification {
  const activeByTier = (maxTier: number): maplibregl.ExpressionSpecification => [
    'case',
    ['<=', ['coalesce', ['get', 'borderTier'], 0], maxTier],
    ['match', ['get', 'status'], 'visited', visitedOpacity, 'planned', plannedOpacity, noneOpacity],
    0,
  ];
  return [
    'step',
    ['zoom'],
    activeByTier(0),
    6.0,
    activeByTier(1),
    7.5,
    activeByTier(2),
    9.0,
    activeByTier(3),
    10.5,
    activeByTier(4),
  ];
}

function buildPrefectureCoreLineColorExpression(): maplibregl.ExpressionSpecification {
  return ['match', ['get', 'status'], 'visited', '#ffffff', 'planned', '#ffffff', '#e2e8f0'];
}

function buildPrefectureCoreLineWidthExpression(): maplibregl.ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], 2, 0.35, 4, 0.65, 6, 1.0, 9, 1.4, 12, 1.7];
}

type PrefectureLinePaint = {
  'line-color': string | maplibregl.ExpressionSpecification;
  'line-width': maplibregl.ExpressionSpecification;
  'line-opacity': maplibregl.ExpressionSpecification;
};

function ensurePrefectureLineLayer(
  map: maplibregl.Map,
  layerId: string,
  paint: PrefectureLinePaint,
  beforeId?: string
): void {
  if (!map.getLayer(layerId)) {
    map.addLayer(
      {
        id: layerId,
        type: 'line',
        source: PREFECTURE_SOURCE_ID,
        layout: {
          visibility: 'visible',
          'line-join': 'bevel',
          'line-cap': 'butt',
        },
        paint,
      },
      beforeId
    );
    return;
  }

  map.setLayoutProperty(layerId, 'visibility', 'visible');
  for (const prop of Object.keys(paint) as Array<keyof PrefectureLinePaint>) {
    map.setPaintProperty(layerId, prop, paint[prop]);
  }
  if (beforeId) {
    map.moveLayer(layerId, beforeId);
  }
}

export function syncPrefectureOverlayLayers(
  map: maplibregl.Map,
  options: {
    enabled: boolean;
    data: PrefectureFeatureCollection | null;
    baseMap: BaseMapId;
    beforeLayerId?: string;
  }
): void {
  const { enabled, data, beforeLayerId } = options;

  if (!enabled || !data) {
    for (const layerId of [
      PREFECTURE_FILL_LAYER_ID,
      PREFECTURE_LINE_CASING_LAYER_ID,
      PREFECTURE_LINE_LAYER_ID,
    ]) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', 'none');
      }
    }
    return;
  }

  const renderData = expandPrefecturePolygonsForRendering(data);

  const existingSource = map.getSource(PREFECTURE_SOURCE_ID) as
    | maplibregl.GeoJSONSource
    | undefined;
  if (!existingSource) {
    map.addSource(PREFECTURE_SOURCE_ID, {
      type: 'geojson',
      data: renderData,
    });
  } else {
    existingSource.setData(renderData);
  }

  const resolvedBeforeId =
    beforeLayerId && map.getLayer(beforeLayerId) ? beforeLayerId : undefined;

  if (!map.getLayer(PREFECTURE_FILL_LAYER_ID)) {
    map.addLayer(
      {
        id: PREFECTURE_FILL_LAYER_ID,
        type: 'fill',
        source: PREFECTURE_SOURCE_ID,
        layout: { visibility: 'visible' },
        paint: {
          'fill-color': buildPrefectureFillColorExpression(),
          'fill-opacity': buildPrefectureFillOpacityExpression(),
        },
      },
      resolvedBeforeId
    );
  } else {
    map.setLayoutProperty(PREFECTURE_FILL_LAYER_ID, 'visibility', 'visible');
    if (resolvedBeforeId) {
      map.moveLayer(PREFECTURE_FILL_LAYER_ID, resolvedBeforeId);
    }
  }

  ensurePrefectureLineLayer(
    map,
    PREFECTURE_LINE_CASING_LAYER_ID,
    {
      'line-color': PREFECTURE_CASING_COLOR,
      'line-width': buildPrefectureCasingWidthExpression(),
      'line-opacity': buildTieredLineOpacityExpression(0.8, 0.8, 0.62),
    },
    resolvedBeforeId
  );

  ensurePrefectureLineLayer(
    map,
    PREFECTURE_LINE_LAYER_ID,
    {
      'line-color': buildPrefectureCoreLineColorExpression(),
      'line-width': buildPrefectureCoreLineWidthExpression(),
      'line-opacity': buildTieredLineOpacityExpression(0.95, 0.95, 0.72),
    },
    resolvedBeforeId
  );
}
