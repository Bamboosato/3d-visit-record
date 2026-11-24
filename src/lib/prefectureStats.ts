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

export const MAX_COASTAL_FALLBACK_METERS = 5000;

const METERS_PER_DEG_LAT = 111320;

const JAPAN_PREFECTURES: ReadonlyArray<{ code: string; name: string }> = [
  { code: '01', name: '北海道' },
  { code: '02', name: '青森県' },
  { code: '03', name: '岩手県' },
  { code: '04', name: '宮城県' },
  { code: '05', name: '秋田県' },
  { code: '06', name: '山形県' },
  { code: '07', name: '福島県' },
  { code: '08', name: '茨城県' },
  { code: '09', name: '栃木県' },
  { code: '10', name: '群馬県' },
  { code: '11', name: '埼玉県' },
  { code: '12', name: '千葉県' },
  { code: '13', name: '東京都' },
  { code: '14', name: '神奈川県' },
  { code: '15', name: '新潟県' },
  { code: '16', name: '富山県' },
  { code: '17', name: '石川県' },
  { code: '18', name: '福井県' },
  { code: '19', name: '山梨県' },
  { code: '20', name: '長野県' },
  { code: '21', name: '岐阜県' },
  { code: '22', name: '静岡県' },
  { code: '23', name: '愛知県' },
  { code: '24', name: '三重県' },
  { code: '25', name: '滋賀県' },
  { code: '26', name: '京都府' },
  { code: '27', name: '大阪府' },
  { code: '28', name: '兵庫県' },
  { code: '29', name: '奈良県' },
  { code: '30', name: '和歌山県' },
  { code: '31', name: '鳥取県' },
  { code: '32', name: '島根県' },
  { code: '33', name: '岡山県' },
  { code: '34', name: '広島県' },
  { code: '35', name: '山口県' },
  { code: '36', name: '徳島県' },
  { code: '37', name: '香川県' },
  { code: '38', name: '愛媛県' },
  { code: '39', name: '高知県' },
  { code: '40', name: '福岡県' },
  { code: '41', name: '佐賀県' },
  { code: '42', name: '長崎県' },
  { code: '43', name: '熊本県' },
  { code: '44', name: '大分県' },
  { code: '45', name: '宮崎県' },
  { code: '46', name: '鹿児島県' },
  { code: '47', name: '沖縄県' },
];

const PREF_BY_NAME = new Map(JAPAN_PREFECTURES.map((p) => [p.name, p]));
const PREF_NAME_REGEX = new RegExp(
  [...JAPAN_PREFECTURES]
    .sort((a, b) => b.name.length - a.name.length)
    .map((p) => p.name)
    .join('|'),
  'g'
);

export function extractPrefecturesFromAddress(
  addressSummary?: string
): Array<{ code: string; name: string }> {
  if (!addressSummary || typeof addressSummary !== 'string') return [];
  const trimmed = addressSummary.trim();
  if (!trimmed) return [];

  const matches: Array<{ code: string; name: string }> = [];
  const seen = new Set<string>();
  PREF_NAME_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PREF_NAME_REGEX.exec(trimmed)) !== null) {
    const pref = PREF_BY_NAME.get(match[0]);
    if (pref && !seen.has(pref.code)) {
      seen.add(pref.code);
      matches.push(pref);
    }
  }
  return matches;
}

function isWithinJapanTerritory(lng: number, lat: number): boolean {
  return lat >= 20 && lat <= 46.5 && lng >= 122 && lng <= 155;
}

function isPointInExpandedBBox(
  lng: number,
  lat: number,
  bbox: BBox,
  padLng: number,
  padLat: number
): boolean {
  return (
    lng >= bbox[0] - padLng &&
    lat >= bbox[1] - padLat &&
    lng <= bbox[2] + padLng &&
    lat <= bbox[3] + padLat
  );
}

function distancePointToSegmentMeters(
  lng: number,
  lat: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const metersPerDegLng = METERS_PER_DEG_LAT * cosLat;
  const axm = (ax - lng) * metersPerDegLng;
  const aym = (ay - lat) * METERS_PER_DEG_LAT;
  const bxm = (bx - lng) * metersPerDegLng;
  const bym = (by - lat) * METERS_PER_DEG_LAT;
  const dx = bxm - axm;
  const dy = bym - aym;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return Math.hypot(axm, aym);
  }
  const t = Math.max(0, Math.min(1, -(axm * dx + aym * dy) / lenSq));
  return Math.hypot(axm + t * dx, aym + t * dy);
}

export function findNearestPrefectureWithinDistance(
  point: [number, number],
  geojsonOrIndex: PrefectureFeatureCollection | PrefectureSpatialIndex,
  maxDistanceMeters: number = MAX_COASTAL_FALLBACK_METERS
): { code: string; name: string } | null {
  if (!Array.isArray(point) || point.length < 2) return null;
  const [lng, lat] = point;
  if (
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    !Number.isFinite(maxDistanceMeters) ||
    maxDistanceMeters <= 0
  ) {
    return null;
  }

  const index = resolveSpatialIndex(geojsonOrIndex);
  const padLat = maxDistanceMeters / METERS_PER_DEG_LAT;
  const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const padLng = maxDistanceMeters / (METERS_PER_DEG_LAT * cosLat);

  let bestDist = maxDistanceMeters;
  let bestMatch: { code: string; name: string } | null = null;

  for (const pref of index.features) {
    if (!isPointInExpandedBBox(lng, lat, pref.bbox, padLng, padLat)) continue;

    for (const poly of pref.polygons) {
      if (!isPointInExpandedBBox(lng, lat, poly.bbox, padLng, padLat)) continue;

      for (const ring of poly.rings) {
        if (ring.length < 2) continue;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const dist = distancePointToSegmentMeters(
            lng,
            lat,
            ring[j][0],
            ring[j][1],
            ring[i][0],
            ring[i][1]
          );
          if (dist <= bestDist) {
            bestDist = dist;
            bestMatch = { code: pref.code, name: pref.name };
          }
        }
      }
    }
  }

  return bestMatch;
}

export function findPrefectureForPoint(
  point: [number, number],
  geojsonOrIndex: PrefectureFeatureCollection | PrefectureSpatialIndex,
  options?: { maxFallbackDistanceMeters?: number }
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

  const fallbackMeters = options?.maxFallbackDistanceMeters ?? MAX_COASTAL_FALLBACK_METERS;
  if (fallbackMeters > 0) {
    return findNearestPrefectureWithinDistance(point, index, fallbackMeters);
  }

  return null;
}

export function resolvePrefectureForSpot(
  spot: Pick<VisitSpot, 'center' | 'addressSummary'>,
  geojsonOrIndex: PrefectureFeatureCollection | PrefectureSpatialIndex,
  options?: { maxFallbackDistanceMeters?: number }
): { code: string; name: string } | null {
  if (!Array.isArray(spot.center) || spot.center.length < 2) return null;
  const [lng, lat] = spot.center;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;

  const index = resolveSpatialIndex(geojsonOrIndex);
  const addressCandidates = isWithinJapanTerritory(lng, lat)
    ? extractPrefecturesFromAddress(spot.addressSummary)
    : [];

  if (addressCandidates.length === 1) {
    return addressCandidates[0];
  }

  if (addressCandidates.length > 1) {
    const pointMatch = findPrefectureForPoint(spot.center, index, options);
    if (pointMatch && addressCandidates.some((c) => c.code === pointMatch.code)) {
      return pointMatch;
    }
    return addressCandidates[0];
  }

  return findPrefectureForPoint(spot.center, index, options);
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
    const matched = resolvePrefectureForSpot(spot, index);
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
