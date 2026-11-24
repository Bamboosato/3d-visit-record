import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildColoredPrefectureGeoJson,
  buildPrefectureSpatialIndex,
  computePrefectureStats,
  findPrefectureForPoint,
  isPointInPolygon,
  loadPrefectureSpatialIndex,
  PREFECTURE_GEOJSON_URL,
  resetPrefectureLoaderCacheForTesting,
  type PrefectureFeatureCollection,
} from '../src/lib/prefectureStats';
import type { VisitSpot } from '../src/types/visit';

const GEOJSON_PATH = path.resolve(process.cwd(), 'public', 'data', 'japan-prefectures.geojson');
const rawGeoJsonText = fs.readFileSync(GEOJSON_PATH, 'utf8');
const prefectureGeoJson = JSON.parse(rawGeoJsonText) as PrefectureFeatureCollection;

function makeSpot(
  id: string,
  name: string,
  status: VisitSpot['status'],
  center: [number, number]
): VisitSpot {
  return {
    id,
    name,
    status,
    category: 'tourism',
    center,
    elevation: null,
    camera: { zoom: 12, pitch: 45, bearing: 0 },
    isPinned: false,
    entries: [
      {
        id: `${id}-entry-1`,
        kind: status,
        date: { precision: 'day', start: '2026-10-01' },
        memo: '',
        photos: [],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    ],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

describe('prefectureStats', () => {
  beforeEach(() => {
    resetPrefectureLoaderCacheForTesting();
  });

  it('ships lightweight valid 47-prefecture GeoJSON under 500KB', () => {
    const stat = fs.statSync(GEOJSON_PATH);
    expect(stat.size).toBeGreaterThan(1024);
    expect(stat.size).toBeLessThan(500 * 1024);

    expect(prefectureGeoJson.type).toBe('FeatureCollection');
    expect(prefectureGeoJson.features).toHaveLength(47);

    const codes = prefectureGeoJson.features.map((f) => f.properties.code);
    const expectedCodes = Array.from({ length: 47 }, (_, i) => String(i + 1).padStart(2, '0'));
    expect(codes).toEqual(expectedCodes);
    expect(prefectureGeoJson.features[0].properties.name).toBe('北海道');
    expect(prefectureGeoJson.features[12].properties.name).toBe('東京都');
    expect(prefectureGeoJson.features[46].properties.name).toBe('沖縄県');
  });

  it('maps representative domestic points to the right prefecture and returns null offshore/overseas', () => {
    const index = buildPrefectureSpatialIndex(prefectureGeoJson);

    const domesticCases: Array<{ label: string; point: [number, number]; code: string; name: string }> = [
      { label: '東京駅', point: [139.7671, 35.6812], code: '13', name: '東京都' },
      { label: '札幌駅', point: [141.3508, 43.0687], code: '01', name: '北海道' },
      { label: '大阪駅', point: [135.4959, 34.7025], code: '27', name: '大阪府' },
      { label: '那覇', point: [127.6792, 26.2124], code: '47', name: '沖縄県' },
      { label: '屋久島', point: [130.5042, 30.3361], code: '46', name: '鹿児島県' },
      { label: '利尻山', point: [141.2419, 45.1786], code: '01', name: '北海道' },
      { label: '石垣島', point: [124.18, 24.38], code: '47', name: '沖縄県' },
      { label: '富士山', point: [138.7274, 35.3606], code: '22', name: '静岡県' },
    ];

    for (const tc of domesticCases) {
      expect(findPrefectureForPoint(tc.point, index), tc.label).toEqual({
        code: tc.code,
        name: tc.name,
      });
    }

    expect(findPrefectureForPoint([145.0, 30.0], index)).toBeNull(); // Pacific Ocean
    expect(findPrefectureForPoint([134.0, 38.0], index)).toBeNull(); // Sea of Japan
    expect(findPrefectureForPoint([2.2945, 48.8584], index)).toBeNull(); // Paris
    expect(findPrefectureForPoint([Number.NaN, 35.68], index)).toBeNull();
  });

  it('handles polygon holes and outer edges deterministically in isPointInPolygon', () => {
    const polygonWithHole = [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      [
        [3, 3],
        [7, 3],
        [7, 7],
        [3, 7],
        [3, 3],
      ],
    ];

    expect(isPointInPolygon(1, 1, polygonWithHole)).toBe(true);
    expect(isPointInPolygon(0, 5, polygonWithHole)).toBe(true);
    expect(isPointInPolygon(5, 5, polygonWithHole)).toBe(false);
    expect(isPointInPolygon(11, 5, polygonWithHole)).toBe(false);
  });

  it('computes stats with 0 spots, prefers visited over planned, and ignores non-prefecture coordinates', () => {
    const index = buildPrefectureSpatialIndex(prefectureGeoJson);

    const emptyStats = computePrefectureStats([], index);
    expect(emptyStats.totalPrefectures).toBe(47);
    expect(emptyStats.visitedCount).toBe(0);
    expect(emptyStats.plannedOnlyCount).toBe(0);
    expect(emptyStats.unvisitedCount).toBe(47);
    expect(emptyStats.items.every((item) => item.status === 'none')).toBe(true);

    const spots: VisitSpot[] = [
      makeSpot('tokyo-visited', '東京駅', 'visited', [139.7671, 35.6812]),
      makeSpot('tokyo-planned', '高尾山', 'planned', [139.2436, 35.6253]),
      makeSpot('osaka-planned', '大阪城', 'planned', [135.5259, 34.6873]),
      makeSpot('hokkaido-visited', '札幌', 'visited', [141.3508, 43.0687]),
      makeSpot('paris-visited', 'エッフェル塔', 'visited', [2.2945, 48.8584]),
      makeSpot('ocean-planned', '太平洋', 'planned', [145.0, 30.0]),
    ];

    const stats = computePrefectureStats(spots, index);
    expect(stats.totalPrefectures).toBe(47);
    expect(stats.visitedCount).toBe(2); // 北海道, 東京都
    expect(stats.plannedOnlyCount).toBe(1); // 大阪府
    expect(stats.unvisitedCount).toBe(44);

    // Visited wins when both visited and planned exist in Tokyo
    expect(stats.byCode['13']).toEqual({
      code: '13',
      name: '東京都',
      status: 'visited',
      visitedSpotCount: 1,
      plannedSpotCount: 1,
      totalSpotCount: 2,
    });
    expect(stats.byCode['27']).toEqual({
      code: '27',
      name: '大阪府',
      status: 'planned',
      visitedSpotCount: 0,
      plannedSpotCount: 1,
      totalSpotCount: 1,
    });
    expect(stats.byCode['47'].status).toBe('none');

    // Colored GeoJSON preserves original input immutably
    const colored = buildColoredPrefectureGeoJson(index, stats);
    expect(colored.features).toHaveLength(47);
    expect(colored.features[12].properties.status).toBe('visited');
    expect(colored.features[26].properties.status).toBe('planned');
    expect(colored.features[46].properties.status).toBe('none');
    expect(prefectureGeoJson.features[12].properties.status).toBeUndefined();
  });

  it('lazy-loads and caches prefecture index and allows retry after error', async () => {
    const failingFetch = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    await expect(loadPrefectureSpatialIndex(failingFetch as unknown as typeof fetch)).rejects.toThrow();

    const successFetch = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(PREFECTURE_GEOJSON_URL);
      return {
        ok: true,
        status: 200,
        json: async () => prefectureGeoJson,
      } as Response;
    });

    const [first, second] = await Promise.all([
      loadPrefectureSpatialIndex(successFetch as unknown as typeof fetch),
      loadPrefectureSpatialIndex(successFetch as unknown as typeof fetch),
    ]);
    expect(first).toBe(second);
    expect(first.features).toHaveLength(47);
    expect(successFetch).toHaveBeenCalledTimes(1);

    const third = await loadPrefectureSpatialIndex(successFetch as unknown as typeof fetch);
    expect(third).toBe(first);
    expect(successFetch).toHaveBeenCalledTimes(1);
  });
});
