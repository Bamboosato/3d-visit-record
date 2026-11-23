import { describe, expect, it } from 'vitest';
import { findPhotoLocationMatches } from '../src/lib/spotDomain';
import { HYAKUMEIZAN_PRESETS } from '../src/lib/hyakumeizanData';
import type { VisitSpot } from '../src/types/visit';

function createSpot(overrides: Partial<VisitSpot> = {}): VisitSpot {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: 'spot-1',
    name: 'テスト地点',
    status: 'visited',
    category: 'nature',
    center: [138.7274, 35.3606],
    elevation: 3776,
    camera: { zoom: 13, pitch: 55, bearing: 0 },
    isPinned: false,
    entries: [
      {
        id: 'entry-1',
        kind: 'visited',
        date: { precision: 'day', start: '2026-01-01' },
        memo: '',
        photos: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('findPhotoLocationMatches', () => {
  it('matches registered spots within 300m sorted by distance', () => {
    const baseCenter: [number, number] = [139.7671, 35.6812]; // 東京駅付近
    const nearSpot = createSpot({
      id: 'spot-near',
      name: '丸の内駅前',
      center: [139.7675, 35.6814], // 約 40m
    });
    const mediumSpot = createSpot({
      id: 'spot-medium',
      name: '丸ビル付近',
      center: [139.7649, 35.6813], // 約 200m
    });
    const farSpot = createSpot({
      id: 'spot-far',
      name: '皇居外苑',
      center: [139.758, 35.6812], // 約 820m (> 300m)
    });

    const result = findPhotoLocationMatches(
      baseCenter,
      [farSpot, mediumSpot, nearSpot],
      HYAKUMEIZAN_PRESETS
    );

    expect(result.nearbySpots.map((m) => m.spot.id)).toEqual(['spot-near', 'spot-medium']);
    expect(result.nearbySpots[0].distanceMeters).toBeLessThan(result.nearbySpots[1].distanceMeters);
    expect(result.nearbyMountain).toBeNull();
  });

  it('matches unregistered Hyakumeizan mountain within 1000m when no spot is within 300m', () => {
    const fuji = HYAKUMEIZAN_PRESETS.find((m) => m.name.includes('富士'))!;
    // 山頂から約 500m ずらした位置
    const photoCenter: [number, number] = [fuji.center[0] + 0.004, fuji.center[1]];

    const result = findPhotoLocationMatches(photoCenter, [], HYAKUMEIZAN_PRESETS);

    expect(result.nearbySpots).toEqual([]);
    expect(result.nearbyMountain?.mountain.id).toBe(fuji.id);
    expect(result.nearbyMountain?.distanceMeters).toBeLessThanOrEqual(1000);
  });

  it('skips Hyakumeizan mountain if already registered as a spot', () => {
    const fuji = HYAKUMEIZAN_PRESETS.find((m) => m.name.includes('富士'))!;
    const registeredFuji = createSpot({
      id: 'spot-fuji',
      name: fuji.name,
      presetId: fuji.id,
      center: fuji.center,
    });
    // 登録済みスポットからは 500m 離れているが百名山からは 500m 以内
    const photoCenter: [number, number] = [fuji.center[0] + 0.0045, fuji.center[1]];

    const result = findPhotoLocationMatches(photoCenter, [registeredFuji], HYAKUMEIZAN_PRESETS);

    expect(result.nearbySpots).toEqual([]);
    expect(result.nearbyMountain).toBeNull();
  });

  it('returns empty spot list and null mountain when nothing is nearby', () => {
    // 太平洋上など何もない座標
    const result = findPhotoLocationMatches([145.0, 30.0], [], HYAKUMEIZAN_PRESETS);
    expect(result.nearbySpots).toEqual([]);
    expect(result.nearbyMountain).toBeNull();
  });
});
