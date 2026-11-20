import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatAddressSummaryFromNominatim,
  isWithinJapanBBox,
  resetSearchCachesForTesting,
  searchOsmLocationsByKeyword,
} from '../src/lib/osmPlaceClient';
import { fetchPointElevationFromAW3D } from '../src/lib/jaxaClient';
import { fetchRasterTileForBasemap } from '../src/lib/maplibreHelper';
import { buildUrlSearchParams, parseUrlViewState } from '../src/lib/urlSync';
import { deriveSpotStatus, matchesStatusFilter } from '../src/lib/spotDomain';
import type { VisitSpot } from '../src/types/visit';

describe('global geo, privacy URL sync, and spot domain helpers', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetSearchCachesForTesting();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('searches global locations via Nominatim without countrycodes=jp restriction', async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('nominatim.openstreetmap.org/search')) {
        return new Response(
          JSON.stringify([
            {
              place_id: 123,
              lat: '48.8584',
              lon: '2.2945',
              name: 'Eiffel Tower',
              category: 'tourism',
              type: 'attraction',
              address: { city: 'Paris', country: 'France', country_code: 'fr' },
            },
          ]),
          { status: 200 }
        );
      }
      return new Response('[]', { status: 200 });
    }) as typeof fetch;

    const results = await searchOsmLocationsByKeyword(
      'Eiffel Tower',
      undefined,
      undefined,
      { lat: 48.85, lng: 2.3 },
      { skipThrottle: true }
    );

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Eiffel Tower');
    expect(results[0].subLabel).toBe('Paris, France');
    expect(requestedUrls.some((u) => u.includes('countrycodes=jp'))).toBe(false);
    expect(requestedUrls.some((u) => u.includes('accept-language=ja%2Cen'))).toBe(true);
    expect(requestedUrls.some((u) => u.includes('msearch.gsi.go.jp'))).toBe(false);
  });

  it('queries GSI in parallel for Japanese keywords', async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('msearch.gsi.go.jp')) {
        return new Response(
          JSON.stringify([
            {
              geometry: { coordinates: [137.969, 36.238] },
              properties: { title: '長野県松本市丸の内松本城' },
            },
          ]),
          { status: 200 }
        );
      }
      return new Response('[]', { status: 200 });
    }) as typeof fetch;

    const results = await searchOsmLocationsByKeyword(
      '松本城',
      undefined,
      undefined,
      undefined,
      { skipThrottle: true }
    );
    expect(requestedUrls.some((u) => u.includes('msearch.gsi.go.jp'))).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it('formats domestic and overseas address summaries and checks Japan BBox', () => {
    expect(isWithinJapanBBox(35.68, 139.76)).toBe(true);
    expect(isWithinJapanBBox(48.85, 2.29)).toBe(false);

    expect(
      formatAddressSummaryFromNominatim({
        country_code: 'jp',
        province: '長野県',
        city: '松本市',
        country: '日本',
      })
    ).toBe('長野県松本市');

    expect(
      formatAddressSummaryFromNominatim({
        country_code: 'fr',
        city: 'Paris',
        country: 'France',
      })
    ).toBe('Paris, France');
  });

  it('returns null for AW3D30 elevation beyond ±82° latitude without calling JAXA SDK', async () => {
    await expect(fetchPointElevationFromAW3D(10, 85)).resolves.toBeNull();
    await expect(fetchPointElevationFromAW3D(10, -83)).resolves.toBeNull();
    await expect(fetchPointElevationFromAW3D(200, 35)).resolves.toBeNull();
  });

  it('excludes all personal record fields from share URL parameters', () => {
    const params = buildUrlSearchParams({
      lat: 48.8584,
      lng: 2.2945,
      zoom: 14.5,
      pitch: 60,
      bearing: 15,
      spotName: 'エッフェル塔',
      baseMap: 'photo',
      exaggeration: 2.0,
    });
    const str = params.toString();
    expect(str).not.toContain('memo');
    expect(str).not.toContain('status');
    expect(str).not.toContain('date');
    expect(str).not.toContain('entries');

    const parsed = parseUrlViewState(`?${str}`);
    expect(parsed).toEqual({
      lat: 48.8584,
      lng: 2.2945,
      zoom: 14.5,
      pitch: 60,
      bearing: 15,
      spotName: 'エッフェル塔',
      baseMap: 'photo',
      exaggeration: 2.0,
    });
  });

  it('handles hybrid visited spots that also carry upcoming planned entries', () => {
    const entries = [
      {
        id: 'e-visited',
        kind: 'visited' as const,
        date: { precision: 'year' as const, start: '2024' },
        memo: '',
        photos: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'e-planned',
        kind: 'planned' as const,
        date: { precision: 'year' as const, start: '2027' },
        memo: '',
        photos: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const spot: VisitSpot = {
      id: 'hybrid-1',
      name: '屋久島',
      status: deriveSpotStatus(entries),
      category: 'nature',
      center: [130.5042, 30.3358],
      elevation: 1936,
      camera: { zoom: 11, pitch: 60, bearing: 0 },
      isPinned: false,
      entries,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    expect(spot.status).toBe('visited');
    expect(matchesStatusFilter(spot, 'all')).toBe(true);
    expect(matchesStatusFilter(spot, 'visited')).toBe(true);
    expect(matchesStatusFilter(spot, 'planned')).toBe(true);
  });

  it('returns transparent 1x1 PNG on 404 for hillshade tiles outside Japan', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 404 })) as typeof fetch;

    const data = await fetchRasterTileForBasemap('hillshade', 10, 512, 350);
    const bytes = new Uint8Array(data);
    // PNG magic bytes: 137 80 78 71
    expect(Array.from(bytes.slice(0, 4))).toEqual([137, 80, 78, 71]);
    expect(bytes.byteLength).toBeLessThan(100);
  });
});
