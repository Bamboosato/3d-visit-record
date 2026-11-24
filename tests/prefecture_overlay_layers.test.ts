import { describe, expect, it, vi } from 'vitest';
import type * as maplibregl from 'maplibre-gl';
import {
  PREFECTURE_FILL_LAYER_ID,
  PREFECTURE_LINE_CASING_LAYER_ID,
  PREFECTURE_LINE_LAYER_ID,
  PREFECTURE_SOURCE_ID,
  syncPrefectureOverlayLayers,
} from '../src/lib/maplibreHelper';
import type { PrefectureFeatureCollection } from '../src/lib/prefectureStats';

interface MockLayer {
  id: string;
  type: string;
  source: string;
  layout: Record<string, unknown>;
  paint: Record<string, unknown>;
}

function createSamplePrefectureGeoJson(status: 'visited' | 'planned' | 'none'): PrefectureFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { code: '13', name: '東京都', status },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [139.5, 35.5],
              [139.9, 35.5],
              [139.9, 35.8],
              [139.5, 35.8],
              [139.5, 35.5],
            ],
          ],
        },
      },
    ],
  };
}

function createMockMap(initialLayerIds: string[] = []) {
  const sources = new Map<string, { type: string; data: unknown; setData: ReturnType<typeof vi.fn> }>();
  const layers: MockLayer[] = initialLayerIds.map((id) => ({
    id,
    type: 'symbol',
    source: 'base',
    layout: { visibility: 'visible' },
    paint: {},
  }));

  const insertLayer = (layer: MockLayer, beforeId?: string) => {
    if (beforeId) {
      const idx = layers.findIndex((l) => l.id === beforeId);
      if (idx !== -1) {
        layers.splice(idx, 0, layer);
        return;
      }
    }
    layers.push(layer);
  };

  const mockMap = {
    getSource: vi.fn((id: string) => sources.get(id)),
    addSource: vi.fn((id: string, spec: { type: string; data: unknown }) => {
      const setData = vi.fn((nextData: unknown) => {
        const entry = sources.get(id);
        if (entry) entry.data = nextData;
      });
      sources.set(id, { type: spec.type, data: spec.data, setData });
    }),
    getLayer: vi.fn((id: string) => layers.find((l) => l.id === id)),
    addLayer: vi.fn((layer: MockLayer, beforeId?: string) => {
      insertLayer(
        {
          id: layer.id,
          type: layer.type,
          source: layer.source,
          layout: { ...(layer.layout ?? {}) },
          paint: { ...(layer.paint ?? {}) },
        },
        beforeId
      );
    }),
    moveLayer: vi.fn((id: string, beforeId?: string) => {
      const idx = layers.findIndex((l) => l.id === id);
      if (idx === -1) return;
      const [layer] = layers.splice(idx, 1);
      insertLayer(layer, beforeId);
    }),
    setLayoutProperty: vi.fn((id: string, name: string, value: unknown) => {
      const layer = layers.find((l) => l.id === id);
      if (layer) layer.layout[name] = value;
    }),
    setPaintProperty: vi.fn((id: string, name: string, value: unknown) => {
      const layer = layers.find((l) => l.id === id);
      if (layer) layer.paint[name] = value;
    }),
  };

  return {
    map: mockMap as unknown as maplibregl.Map,
    mockMap,
    layers,
    sources,
  };
}

describe('syncPrefectureOverlayLayers', () => {
  it('does not create source or layers when disabled initially', () => {
    const { map, mockMap, layers, sources } = createMockMap([
      'base-osm',
      'terrain-hillshade',
      'visit-spots-clusters',
      'visit-spots-pins',
    ]);

    syncPrefectureOverlayLayers(map, {
      enabled: false,
      data: null,
      baseMap: 'osm',
      beforeLayerId: 'visit-spots-clusters',
    });

    expect(sources.size).toBe(0);
    expect(mockMap.addSource).not.toHaveBeenCalled();
    expect(mockMap.addLayer).not.toHaveBeenCalled();
    expect(layers.map((l) => l.id)).toEqual([
      'base-osm',
      'terrain-hillshade',
      'visit-spots-clusters',
      'visit-spots-pins',
    ]);
  });

  it('adds fill, dark casing, and white core line layers in exact order below spot clusters/pins', () => {
    const { map, layers, sources } = createMockMap([
      'base-osm',
      'terrain-hillshade',
      'visit-spots-clusters',
      'visit-spots-pins',
    ]);
    const data = createSamplePrefectureGeoJson('visited');

    syncPrefectureOverlayLayers(map, {
      enabled: true,
      data,
      baseMap: 'osm',
      beforeLayerId: 'visit-spots-clusters',
    });

    expect(sources.get(PREFECTURE_SOURCE_ID)?.data).toBe(data);
    expect(layers.map((l) => l.id)).toEqual([
      'base-osm',
      'terrain-hillshade',
      PREFECTURE_FILL_LAYER_ID,
      PREFECTURE_LINE_CASING_LAYER_ID,
      PREFECTURE_LINE_LAYER_ID,
      'visit-spots-clusters',
      'visit-spots-pins',
    ]);

    const casing = layers.find((l) => l.id === PREFECTURE_LINE_CASING_LAYER_ID)!;
    expect(casing.paint['line-color']).toBe('#0f172a');
    expect(casing.paint['line-width']).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      4,
      2.4,
      8,
      3.4,
      11,
      4.2,
    ]);
    expect(casing.paint['line-opacity']).toEqual([
      'match',
      ['get', 'status'],
      'visited',
      0.8,
      'planned',
      0.8,
      0.65,
    ]);

    const coreLine = layers.find((l) => l.id === PREFECTURE_LINE_LAYER_ID)!;
    expect(coreLine.paint['line-color']).toEqual([
      'match',
      ['get', 'status'],
      'visited',
      '#ffffff',
      'planned',
      '#ffffff',
      '#e2e8f0',
    ]);
    expect(coreLine.paint['line-width']).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      4,
      1.0,
      8,
      1.5,
      11,
      2.0,
    ]);
    expect(coreLine.paint['line-opacity']).toEqual([
      'match',
      ['get', 'status'],
      'visited',
      0.95,
      'planned',
      0.95,
      0.75,
    ]);
  });

  it('hides all 3 overlay layers when turned off and restores data + stacking order when turned back on', () => {
    const { map, layers, sources } = createMockMap([
      'base-osm',
      'terrain-hillshade',
      'visit-spots-clusters',
      'visit-spots-pins',
    ]);

    const firstData = createSamplePrefectureGeoJson('planned');
    syncPrefectureOverlayLayers(map, {
      enabled: true,
      data: firstData,
      baseMap: 'hillshade',
      beforeLayerId: 'visit-spots-clusters',
    });

    // Turn OFF
    syncPrefectureOverlayLayers(map, {
      enabled: false,
      data: firstData,
      baseMap: 'hillshade',
      beforeLayerId: 'visit-spots-clusters',
    });

    for (const id of [
      PREFECTURE_FILL_LAYER_ID,
      PREFECTURE_LINE_CASING_LAYER_ID,
      PREFECTURE_LINE_LAYER_ID,
    ]) {
      expect(layers.find((l) => l.id === id)?.layout.visibility).toBe('none');
    }

    // Turn back ON with updated data & basemap
    const secondData = createSamplePrefectureGeoJson('visited');
    syncPrefectureOverlayLayers(map, {
      enabled: true,
      data: secondData,
      baseMap: 'photo',
      beforeLayerId: 'visit-spots-clusters',
    });

    expect(sources.get(PREFECTURE_SOURCE_ID)?.setData).toHaveBeenCalledWith(secondData);
    for (const id of [
      PREFECTURE_FILL_LAYER_ID,
      PREFECTURE_LINE_CASING_LAYER_ID,
      PREFECTURE_LINE_LAYER_ID,
    ]) {
      expect(layers.find((l) => l.id === id)?.layout.visibility).toBe('visible');
    }
    expect(layers.map((l) => l.id)).toEqual([
      'base-osm',
      'terrain-hillshade',
      PREFECTURE_FILL_LAYER_ID,
      PREFECTURE_LINE_CASING_LAYER_ID,
      PREFECTURE_LINE_LAYER_ID,
      'visit-spots-clusters',
      'visit-spots-pins',
    ]);
  });
});
