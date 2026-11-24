import type {
  PrefectureStats,
  PrefectureSummaryItem,
  PrefectureVisitStatus,
  VisitSpot,
} from '../types/visit';

export interface PrefectureFeatureProperties {
  code: string;
  name: string;
  status?: PrefectureVisitStatus;
  visitedSpotCount?: number;
  plannedSpotCount?: number;
  totalSpotCount?: number;
}

export type PrefectureGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon;

export type PrefectureFeature = GeoJSON.Feature<
  PrefectureGeometry,
  PrefectureFeatureProperties
>;

export type PrefectureFeatureCollection = GeoJSON.FeatureCollection<
  PrefectureGeometry,
  PrefectureFeatureProperties
>;

/** [minLng, minLat, maxLng, maxLat] */
export type BBox = [number, number, number, number];

export interface IndexedPrefecturePolygon {
  bbox: BBox;
  rings: GeoJSON.Position[][];
}

export interface IndexedPrefectureFeature {
  code: string;
  name: string;
  bbox: BBox;
  polygons: IndexedPrefecturePolygon[];
  feature: PrefectureFeature;
}

export interface PrefectureSpatialIndex {
  geojson: PrefectureFeatureCollection;
  features: IndexedPrefectureFeature[];
}

const rawBaseUrl =
  typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL
    ? String(import.meta.env.BASE_URL)
    : '/';

export const PREFECTURE_GEOJSON_URL = `${
  rawBaseUrl.endsWith('/') ? rawBaseUrl : `${rawBaseUrl}/`
}data/japan-prefectures.geojson`;

const BOUNDARY_EPSILON = 1e-12;
const spatialIndexCache = new WeakMap<PrefectureFeatureCollection, PrefectureSpatialIndex>();

let cachedSpatialIndex: PrefectureSpatialIndex | null = null;
let inFlightSpatialIndexLoad: Promise<PrefectureSpatialIndex> | null = null;

export function computeRingBBox(ring: GeoJSON.Position[]): BBox {
  if (ring.length === 0) {
    return [Infinity, Infinity, -Infinity, -Infinity];
  }
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  for (let i = 0; i < ring.length; i++) {
    const pt = ring[i];
    const lng = pt[0];
    const lat = pt[1];
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }

  return [minLng, minLat, maxLng, maxLat];
}

export function isPointInBBox(lng: number, lat: number, bbox: BBox): boolean {
  return lng >= bbox[0] && lat >= bbox[1] && lng <= bbox[2] && lat <= bbox[3];
}

function isPointOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): boolean {
  if (
    px < Math.min(ax, bx) - BOUNDARY_EPSILON ||
    px > Math.max(ax, bx) + BOUNDARY_EPSILON ||
    py < Math.min(ay, by) - BOUNDARY_EPSILON ||
    py > Math.max(ay, by) + BOUNDARY_EPSILON
  ) {
    return false;
  }

  const dx = bx - ax;
  const dy = by - ay;
  const edgeLen = Math.hypot(dx, dy);
  if (edgeLen <= BOUNDARY_EPSILON) {
    return Math.hypot(px - ax, py - ay) <= BOUNDARY_EPSILON;
  }

  const cross = Math.abs((px - ax) * dy - (py - ay) * dx);
  return cross / edgeLen <= BOUNDARY_EPSILON;
}

export function isPointInRing(lng: number, lat: number, ring: GeoJSON.Position[]): boolean {
  if (ring.length < 3) return false;

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    if (isPointOnSegment(lng, lat, xi, yi, xj, yj)) {
      return true;
    }

    const intersects =
      (yi > lat) !== (yj > lat) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

export function isPointInPolygon(
  lng: number,
  lat: number,
  rings: GeoJSON.Position[][]
): boolean {
  if (rings.length === 0) return false;
  if (!isPointInRing(lng, lat, rings[0])) return false;

  for (let i = 1; i < rings.length; i++) {
    if (isPointInRing(lng, lat, rings[i])) {
      return false;
    }
  }

  return true;
}

function mergeBBox(a: BBox, b: BBox): BBox {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

export function buildPrefectureSpatialIndex(
  geojson: PrefectureFeatureCollection
): PrefectureSpatialIndex {
  const cached = spatialIndexCache.get(geojson);
  if (cached) return cached;

  const features: IndexedPrefectureFeature[] = [];

  for (const feature of geojson.features) {
    const code = String(feature.properties?.code ?? '');
    const name = String(feature.properties?.name ?? '');
    const geom = feature.geometry;
    if (!geom || !code || !name) continue;

    const rawPolygons: GeoJSON.Position[][][] =
      geom.type === 'Polygon'
        ? [geom.coordinates]
        : geom.type === 'MultiPolygon'
          ? geom.coordinates
          : [];

    const indexedPolygons: IndexedPrefecturePolygon[] = [];
    let featureBBox: BBox = [Infinity, Infinity, -Infinity, -Infinity];

    for (const rings of rawPolygons) {
      if (!rings || rings.length === 0 || rings[0].length < 3) continue;
      const polyBBox = computeRingBBox(rings[0]);
      featureBBox = mergeBBox(featureBBox, polyBBox);
      indexedPolygons.push({ bbox: polyBBox, rings });
    }

    if (indexedPolygons.length === 0) continue;

    features.push({
      code,
      name,
      bbox: featureBBox,
      polygons: indexedPolygons,
      feature,
    });
  }

  const index: PrefectureSpatialIndex = { geojson, features };
  spatialIndexCache.set(geojson, index);
  return index;
}

function resolveSpatialIndex(
  geojsonOrIndex: PrefectureFeatureCollection | PrefectureSpatialIndex
): PrefectureSpatialIndex {
  if ('geojson' in geojsonOrIndex) {
    return geojsonOrIndex;
  }
  return buildPrefectureSpatialIndex(geojsonOrIndex);
}

export function findPrefectureForPoint(
  point: [number, number],
  geojsonOrIndex: PrefectureFeatureCollection | PrefectureSpatialIndex
): { code: string; name: string } | null {
  if (!Array.isArray(point) || point.length < 2) return null;
  const [lng, lat] = point;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;

  const index = resolveSpatialIndex(geojsonOrIndex);

  for (const pref of index.features) {
    if (!isPointInBBox(lng, lat, pref.bbox)) continue;

    for (const poly of pref.polygons) {
      if (!isPointInBBox(lng, lat, poly.bbox)) continue;
      if (isPointInPolygon(lng, lat, poly.rings)) {
        return { code: pref.code, name: pref.name };
      }
    }
  }

  return null;
}

export function computePrefectureStats(
  spots: VisitSpot[],
  geojsonOrIndex: PrefectureFeatureCollection | PrefectureSpatialIndex
): PrefectureStats {
  const index = resolveSpatialIndex(geojsonOrIndex);

  const countsByCode = new Map<string, { visited: number; planned: number }>();
  for (const pref of index.features) {
    countsByCode.set(pref.code, { visited: 0, planned: 0 });
  }

  for (const spot of spots) {
    const matched = findPrefectureForPoint(spot.center, index);
    if (!matched) continue;
    const counts = countsByCode.get(matched.code);
    if (!counts) continue;

    if (spot.status === 'visited') {
      counts.visited += 1;
    } else if (spot.status === 'planned') {
      counts.planned += 1;
    }
  }

  let visitedCount = 0;
  let plannedOnlyCount = 0;
  let unvisitedCount = 0;
  const byCode: Record<string, PrefectureSummaryItem> = {};
  const items: PrefectureSummaryItem[] = [];

  for (const pref of index.features) {
    const counts = countsByCode.get(pref.code) ?? { visited: 0, planned: 0 };
    const status: PrefectureVisitStatus =
      counts.visited > 0 ? 'visited' : counts.planned > 0 ? 'planned' : 'none';

    if (status === 'visited') visitedCount += 1;
    else if (status === 'planned') plannedOnlyCount += 1;
    else unvisitedCount += 1;

    const item: PrefectureSummaryItem = {
      code: pref.code,
      name: pref.name,
      status,
      visitedSpotCount: counts.visited,
      plannedSpotCount: counts.planned,
      totalSpotCount: counts.visited + counts.planned,
    };

    byCode[pref.code] = item;
    items.push(item);
  }

  return {
    totalPrefectures: items.length,
    visitedCount,
    plannedOnlyCount,
    unvisitedCount,
    byCode,
    items,
  };
}

export function buildColoredPrefectureGeoJson(
  geojsonOrIndex: PrefectureFeatureCollection | PrefectureSpatialIndex,
  stats: PrefectureStats
): PrefectureFeatureCollection {
  const index = resolveSpatialIndex(geojsonOrIndex);

  return {
    type: 'FeatureCollection',
    features: index.features.map((pref) => {
      const summary = stats.byCode[pref.code];
      return {
        type: 'Feature',
        geometry: pref.feature.geometry,
        properties: {
          code: pref.code,
          name: pref.name,
          status: summary?.status ?? 'none',
          visitedSpotCount: summary?.visitedSpotCount ?? 0,
          plannedSpotCount: summary?.plannedSpotCount ?? 0,
          totalSpotCount: summary?.totalSpotCount ?? 0,
        },
      };
    }),
  };
}

function isValidPrefectureGeoJson(raw: unknown): raw is PrefectureFeatureCollection {
  if (!raw || typeof raw !== 'object') return false;
  const candidate = raw as Partial<PrefectureFeatureCollection>;
  if (candidate.type !== 'FeatureCollection' || !Array.isArray(candidate.features)) {
    return false;
  }
  if (candidate.features.length === 0) return false;
  return candidate.features.every((f) => {
    if (!f || f.type !== 'Feature' || !f.properties || !f.geometry) return false;
    const hasMeta =
      typeof f.properties.code === 'string' &&
      f.properties.code.length > 0 &&
      typeof f.properties.name === 'string' &&
      f.properties.name.length > 0;
    const isPoly =
      f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon';
    return hasMeta && isPoly;
  });
}

export async function loadPrefectureSpatialIndex(
  fetcher: typeof fetch = fetch
): Promise<PrefectureSpatialIndex> {
  if (cachedSpatialIndex) {
    return cachedSpatialIndex;
  }
  if (inFlightSpatialIndexLoad) {
    return inFlightSpatialIndexLoad;
  }

  inFlightSpatialIndexLoad = (async () => {
    const response = await fetcher(PREFECTURE_GEOJSON_URL);
    if (!response.ok) {
      throw new Error(`都道府県境界データの読み込みに失敗しました (${response.status})`);
    }
    const parsed: unknown = await response.json();
    if (!isValidPrefectureGeoJson(parsed)) {
      throw new Error('都道府県境界データの形式が不正です。');
    }
    const index = buildPrefectureSpatialIndex(parsed);
    cachedSpatialIndex = index;
    return index;
  })().finally(() => {
    inFlightSpatialIndexLoad = null;
  });

  return inFlightSpatialIndexLoad;
}

export function resetPrefectureLoaderCacheForTesting(): void {
  cachedSpatialIndex = null;
  inFlightSpatialIndexLoad = null;
}
