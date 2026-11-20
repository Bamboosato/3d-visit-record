import { bounded } from './asyncLifecycle';
import { HYAKUMEIZAN_PRESETS } from './hyakumeizanData';
import { MAX_ADDRESS_SUMMARY_LENGTH, type SpotCategory } from '../types/visit';

export interface OsmPlaceCandidate {
  name: string;
  category: string;
  suggestedSpotCategory?: SpotCategory;
  distanceMeters?: number;
  source: 'overpass' | 'nominatim' | 'local';
}

export interface OsmPlaceContext {
  candidates: OsmPlaceCandidate[];
  addressSummary?: string;
}

export interface OsmSearchLocation {
  id: string;
  name: string;
  subLabel: string;
  category: string;
  emoji: string;
  lat: number;
  lng: number;
  recommendedZoom: number;
  distanceMeters?: number;
}

export interface SearchReferenceLocation {
  lat: number;
  lng: number;
}

const CACHE_TTL_MS = 1000 * 60 * 30;
const MIN_SEARCH_INTERVAL_MS = 1000;
const SEARCH_TIMEOUT_MS = 4500;

const candidateCache = new Map<string, { context: OsmPlaceContext; timestamp: number }>();
const searchResultCache = new Map<string, { pool: OsmSearchLocation[]; timestamp: number }>();
let lastKeywordSearchAt = 0;

const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const GSI_SEARCH_URL = 'https://msearch.gsi.go.jp/address-search/AddressSearch';
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export function isWithinJapanBBox(lat: number, lng: number): boolean {
  return lat >= 24 && lat <= 46 && lng >= 122 && lng <= 154;
}

export function calcDistanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

export function formatDistanceLabel(meters?: number): string {
  if (meters === undefined || !Number.isFinite(meters) || meters < 0) return '';
  if (meters < 1000) {
    return `${Math.max(10, Math.round(meters / 10) * 10)}m`;
  }
  const km = meters / 1000;
  if (km < 10) {
    return `${km.toFixed(1)}km`;
  }
  return `${Math.round(km).toLocaleString()}km`;
}

function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      globalThis.clearTimeout(timer);
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  return bounded(
    fetch(url, { ...init, signal: controller.signal }).then(async (response) => {
      const body = await response.arrayBuffer();
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }),
    timeoutMs,
    controller.signal
  ).finally(() => {
    globalThis.clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  });
}

function classifyOsmTags(tags: Record<string, string>): {
  category: string;
  priority: number;
  spotCategory: SpotCategory;
} | null {
  if (tags.boundary === 'administrative' || tags.boundary === 'postal_code') return null;
  if (
    tags.highway &&
    !['trailhead', 'bus_stop', 'rest_area', 'services', 'Mountain_pass'].includes(tags.highway) &&
    !tags.tourism &&
    !tags.amenity &&
    !tags.natural
  ) {
    return null;
  }
  if (tags.waterway && !tags.tourism && !tags.natural) return null;

  if (tags.natural === 'peak' || tags.natural === 'volcano') {
    return { category: '山頂', priority: 1, spotCategory: 'nature' };
  }
  if (tags.natural === 'saddle' || tags.mountain_pass === 'yes') {
    return { category: '峠・鞍部', priority: 2, spotCategory: 'nature' };
  }
  if (tags.highway === 'trailhead') {
    return { category: '登山口', priority: 1, spotCategory: 'nature' };
  }
  if (tags.tourism === 'alpine_hut' || tags.tourism === 'wilderness_hut') {
    return { category: '山小屋', priority: 1, spotCategory: 'nature' };
  }
  if (tags.tourism === 'camp_site' || tags.tourism === 'caravan_site') {
    return { category: 'キャンプ場', priority: 1, spotCategory: 'nature' };
  }
  if (tags.tourism === 'viewpoint') {
    return { category: '展望地', priority: 2, spotCategory: 'tourism' };
  }
  if (tags.natural === 'hot_spring' || tags.amenity === 'public_bath' || tags.bath === 'onsen') {
    return { category: '温泉', priority: 2, spotCategory: 'tourism' };
  }
  if (
    tags.natural === 'spring' ||
    tags.natural === 'cape' ||
    tags.natural === 'waterfall' ||
    tags.waterway === 'waterfall' ||
    tags.natural === 'water'
  ) {
    return { category: '自然・景勝', priority: 2, spotCategory: 'nature' };
  }
  if (
    tags.railway === 'station' ||
    tags.railway === 'halt' ||
    tags.public_transport === 'station'
  ) {
    return { category: '駅', priority: 1, spotCategory: 'lifestyle' };
  }
  if (tags.aerialway === 'station') {
    return { category: 'ロープウェイ', priority: 1, spotCategory: 'tourism' };
  }
  if (tags.highway === 'rest_area' || tags.highway === 'services') {
    return { category: 'SA・道の駅', priority: 2, spotCategory: 'tourism' };
  }
  if (tags.aeroway === 'aerodrome' || tags.aeroway === 'terminal') {
    return { category: '空港', priority: 1, spotCategory: 'tourism' };
  }
  if (
    tags.tourism === 'attraction' ||
    tags.tourism === 'museum' ||
    tags.tourism === 'theme_park' ||
    tags.tourism === 'zoo' ||
    tags.tourism === 'aquarium' ||
    tags.tourism === 'information'
  ) {
    return { category: '観光施設', priority: 2, spotCategory: 'tourism' };
  }
  if (
    tags.tourism === 'hotel' ||
    tags.tourism === 'guest_house' ||
    tags.tourism === 'chalet' ||
    tags.tourism === 'hostel' ||
    tags.tourism === 'motel'
  ) {
    return { category: '宿泊施設', priority: 2, spotCategory: 'tourism' };
  }
  if (
    tags.leisure === 'park' ||
    tags.leisure === 'nature_reserve' ||
    tags.leisure === 'garden' ||
    tags.leisure === 'stadium' ||
    tags.leisure === 'sports_centre'
  ) {
    return { category: '公園・レジャー', priority: 2, spotCategory: 'tourism' };
  }
  if (tags.amenity === 'place_of_worship' || tags.historic) {
    return { category: '寺社・史跡', priority: 2, spotCategory: 'tourism' };
  }
  if (tags.amenity === 'restaurant' || tags.amenity === 'cafe' || tags.shop) {
    return { category: '飲食店・店舗', priority: 3, spotCategory: 'lifestyle' };
  }
  if (tags.amenity || tags.office || tags.tourism || tags.leisure || tags.man_made) {
    return { category: '施設', priority: 3, spotCategory: 'other' };
  }
  if (tags.building) {
    return { category: '建物', priority: 4, spotCategory: 'other' };
  }
  if (tags.place) {
    return { category: '地名', priority: 4, spotCategory: 'other' };
  }
  return null;
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

async function fetchOverpassCandidates(
  lat: number,
  lng: number,
  signal?: AbortSignal
): Promise<OsmPlaceCandidate[]> {
  const query = `
[out:json][timeout:6];
(
  nwr["name"](around:350,${lat.toFixed(5)},${lng.toFixed(5)});
  nwr["name"]["natural"~"^(peak|volcano|saddle|hot_spring|spring|waterfall|cape)$"](around:1000,${lat.toFixed(5)},${lng.toFixed(5)});
  nwr["name"]["tourism"~"^(alpine_hut|wilderness_hut|camp_site|viewpoint|information|attraction)$"](around:1000,${lat.toFixed(5)},${lng.toFixed(5)});
  nwr["name"]["highway"="trailhead"](around:1000,${lat.toFixed(5)},${lng.toFixed(5)});
);
out center tags 40;
`.trim();

  let data: { elements?: OverpassElement[] } | null = null;
  let lastError: unknown = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    if (signal?.aborted) break;
    try {
      const res = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: `data=${encodeURIComponent(query)}`,
          signal,
        },
        SEARCH_TIMEOUT_MS,
        signal
      );

      if (!res.ok) throw new Error(`Overpass API HTTP ${res.status}`);
      data = (await res.json()) as { elements?: OverpassElement[] };
      break;
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
    }
  }

  if (!data) throw lastError ?? new Error('Overpass API failed');

  const elements = data.elements ?? [];
  const scored: Array<OsmPlaceCandidate & { score: number }> = [];

  for (const el of elements) {
    const tags = el.tags;
    if (!tags) continue;
    // 国際対応：name:ja -> name:en -> name の順にフォールバック
    const rawName = (tags['name:ja'] || tags['name:en'] || tags.name || '').trim();
    if (!rawName) continue;

    const classified = classifyOsmTags(tags);
    if (!classified) continue;

    const elLat = el.lat ?? el.center?.lat;
    const elLon = el.lon ?? el.center?.lon;
    const distanceMeters =
      typeof elLat === 'number' && typeof elLon === 'number'
        ? calcDistanceMeters(lat, lng, elLat, elLon)
        : undefined;

    const score = (distanceMeters ?? 300) + classified.priority * 65;

    scored.push({
      name: rawName,
      category: classified.category,
      suggestedSpotCategory: classified.spotCategory,
      distanceMeters,
      source: 'overpass',
      score,
    });
  }

  scored.sort((a, b) => a.score - b.score);

  const unique: OsmPlaceCandidate[] = [];
  const seen = new Set<string>();
  for (const item of scored) {
    const key = item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      name: item.name,
      category: item.category,
      suggestedSpotCategory: item.suggestedSpotCategory,
      distanceMeters: item.distanceMeters,
      source: item.source,
    });
    if (unique.length >= 6) break;
  }

  return unique;
}

interface NominatimReverseResponse {
  name?: string;
  category?: string;
  type?: string;
  display_name?: string;
  address?: Record<string, string>;
}

export function formatAddressSummaryFromNominatim(address?: Record<string, string>): string | undefined {
  if (!address) return undefined;
  const countryCode = (address.country_code || '').toLowerCase();
  const country = (address.country || '').trim();
  const pref = (address.province || address.state || address.region || '').trim();
  const city = (
    address.city ||
    address.town ||
    address.village ||
    address.municipality ||
    address.county ||
    ''
  ).trim();
  const district = (address.city_district || address.ward || '').trim();

  if (countryCode === 'jp') {
    const baseCity =
      city && district && !city.endsWith(district) ? `${city}${district}` : city || district;
    const joined = [pref, baseCity].filter(Boolean).join('');
    return joined ? joined.slice(0, MAX_ADDRESS_SUMMARY_LENGTH) : undefined;
  }

  const locality = city || district || pref;
  const parts = [locality, country].filter((p, idx, arr) => Boolean(p) && arr.indexOf(p) === idx);
  if (parts.length === 0) return undefined;
  return parts.join(', ').slice(0, MAX_ADDRESS_SUMMARY_LENGTH);
}

async function fetchNominatimContext(
  lat: number,
  lng: number,
  signal?: AbortSignal
): Promise<{ candidates: OsmPlaceCandidate[]; addressSummary?: string }> {
  const url = new URL(NOMINATIM_REVERSE_URL);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', lat.toFixed(6));
  url.searchParams.set('lon', lng.toFixed(6));
  url.searchParams.set('zoom', '18');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', 'ja,en');

  const res = await fetchWithTimeout(
    url.toString(),
    {
      method: 'GET',
      headers: { Accept: 'application/json' },
    },
    SEARCH_TIMEOUT_MS,
    signal
  );

  if (!res.ok) throw new Error(`Nominatim API HTTP ${res.status}`);

  const data = (await res.json()) as NominatimReverseResponse;
  const results: OsmPlaceCandidate[] = [];

  if (data.name && data.category !== 'highway') {
    const categoryLabel =
      data.category === 'natural'
        ? '自然・山頂'
        : data.category === 'tourism'
          ? '観光・名所'
          : data.category === 'railway'
            ? '駅'
            : data.category === 'leisure'
              ? '公園・施設'
              : 'スポット';
    const spotCat: SpotCategory =
      data.category === 'natural'
        ? 'nature'
        : data.category === 'tourism' || data.category === 'leisure'
          ? 'tourism'
          : data.category === 'railway'
            ? 'lifestyle'
            : 'other';

    results.push({
      name: data.name.trim(),
      category: categoryLabel,
      suggestedSpotCategory: spotCat,
      distanceMeters: 0,
      source: 'nominatim',
    });
  }

  const addr = data.address;
  const addressSummary = formatAddressSummaryFromNominatim(addr);

  if (addr) {
    const countryCode = (addr.country_code || '').toLowerCase();
    const pref = addr.province || addr.state || '';
    const municipality =
      addr.city || addr.town || addr.village || addr.municipality || addr.county || '';
    const district = addr.city_district || addr.ward || '';
    const locality =
      addr.suburb || addr.quarter || addr.neighbourhood || addr.hamlet || addr.isolated_dwelling || '';
    const poiName =
      addr.peak || addr.alpine_hut || addr.camp_site || addr.tourism || addr.amenity || addr.leisure || '';

    if (poiName && !results.some((r) => r.name === poiName)) {
      results.push({
        name: poiName.trim(),
        category: '施設',
        source: 'nominatim',
      });
    }

    const baseCity =
      municipality && district && !municipality.endsWith(district)
        ? `${municipality}${district}`
        : municipality || district;

    if (countryCode === 'jp') {
      if (baseCity && locality && locality !== baseCity) {
        results.push({ name: `${baseCity}${locality}`, category: '地名', source: 'nominatim' });
      }
      if (locality && locality !== baseCity) {
        results.push({ name: locality, category: '町名・字', source: 'nominatim' });
      }
      if (baseCity) {
        results.push({
          name: pref && !baseCity.startsWith(pref) ? `${pref}${baseCity}` : baseCity,
          category: '自治体',
          source: 'nominatim',
        });
      }
    } else {
      if (locality && baseCity) {
        results.push({ name: `${locality}, ${baseCity}`, category: '地名', source: 'nominatim' });
      }
      if (baseCity) {
        results.push({ name: baseCity, category: '都市・地域', source: 'nominatim' });
      } else if (addressSummary) {
        results.push({ name: addressSummary, category: '地域', source: 'nominatim' });
      }
    }
  }

  return { candidates: results, addressSummary };
}

function findNearbyHyakumeizanCandidates(lat: number, lng: number): OsmPlaceCandidate[] {
  if (!isWithinJapanBBox(lat, lng)) return [];
  const matches: OsmPlaceCandidate[] = [];
  for (const m of HYAKUMEIZAN_PRESETS) {
    const [mLng, mLat] = m.center;
    const dist = calcDistanceMeters(lat, lng, mLat, mLng);
    if (dist <= 2500) {
      matches.push({
        name: m.name,
        category: '百名山',
        suggestedSpotCategory: 'nature',
        distanceMeters: dist,
        source: 'local',
      });
    }
  }
  matches.sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0));
  return matches.slice(0, 2);
}

function mergeCandidates(
  overpassList: OsmPlaceCandidate[],
  nominatimList: OsmPlaceCandidate[],
  localList: OsmPlaceCandidate[]
): OsmPlaceCandidate[] {
  const merged: OsmPlaceCandidate[] = [];
  const seen = new Set<string>();

  const add = (item: OsmPlaceCandidate) => {
    const normalized = item.name.trim();
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push({ ...item, name: normalized });
  };

  for (const item of nominatimList) {
    if (item.distanceMeters === 0) add(item);
  }
  for (const item of overpassList) add(item);
  for (const item of localList) add(item);
  for (const item of nominatimList) {
    if (item.distanceMeters !== 0) add(item);
  }

  return merged.slice(0, 7);
}

export async function fetchOsmPlaceContext(
  lat: number,
  lng: number,
  options?: {
    signal?: AbortSignal;
    onPartialUpdate?: (context: OsmPlaceContext) => void;
  }
): Promise<OsmPlaceContext> {
  const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = candidateCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    options?.onPartialUpdate?.(cached.context);
    return cached.context;
  }

  const localResults = findNearbyHyakumeizanCandidates(lat, lng);
  let overpassResults: OsmPlaceCandidate[] = [];
  let nominatimResults: OsmPlaceCandidate[] = [];
  let addressSummary: string | undefined;

  if (localResults.length > 0) {
    options?.onPartialUpdate?.({ candidates: localResults });
  }

  const notifyPartial = () => {
    if (options?.signal?.aborted) return;
    const current = mergeCandidates(overpassResults, nominatimResults, localResults);
    if (current.length > 0 || addressSummary) {
      options?.onPartialUpdate?.({ candidates: current, addressSummary });
    }
  };

  const overpassPromise = fetchOverpassCandidates(lat, lng, options?.signal)
    .then((res) => {
      overpassResults = res;
      notifyPartial();
      return res;
    })
    .catch(() => [] as OsmPlaceCandidate[]);

  const nominatimPromise = fetchNominatimContext(lat, lng, options?.signal)
    .then((res) => {
      nominatimResults = res.candidates;
      addressSummary = res.addressSummary;
      notifyPartial();
      return res;
    })
    .catch(() => ({ candidates: [] as OsmPlaceCandidate[], addressSummary: undefined }));

  await Promise.all([overpassPromise, nominatimPromise]);

  if (options?.signal?.aborted) {
    return { candidates: [] };
  }

  const finalContext: OsmPlaceContext = {
    candidates: mergeCandidates(overpassResults, nominatimResults, localResults),
    addressSummary,
  };
  if (finalContext.candidates.length > 0 || finalContext.addressSummary) {
    candidateCache.set(cacheKey, {
      context: finalContext,
      timestamp: Date.now(),
    });
  }

  return finalContext;
}

interface NominatimSearchItem {
  place_id: number;
  lat: string;
  lon: string;
  name?: string;
  display_name?: string;
  category?: string;
  type?: string;
  address?: Record<string, string>;
}

interface GsiAddressSearchItem {
  geometry?: { coordinates?: [number, number] };
  properties?: { title?: string };
}

function classifyNominatimSearchResult(
  category?: string,
  type?: string
): { label: string; emoji: string; zoom: number } {
  if (
    category === 'natural' &&
    ['peak', 'volcano', 'mountain_range', 'ridge', 'saddle', 'cliff'].includes(type ?? '')
  ) {
    return { label: '山岳', emoji: '⛰️', zoom: 12.2 };
  }
  if (category === 'natural') return { label: '自然', emoji: '🌿', zoom: 12.8 };
  if (type === 'alpine_hut' || type === 'wilderness_hut') return { label: '山小屋', emoji: '🛖', zoom: 13.8 };
  if (type === 'camp_site' || type === 'caravan_site') return { label: 'キャンプ場', emoji: '⛺', zoom: 13.8 };
  if (category === 'railway' || type === 'station' || type === 'halt') return { label: '駅', emoji: '🚉', zoom: 13.8 };
  if (category === 'aeroway' || type === 'aerodrome') return { label: '空港', emoji: '✈️', zoom: 12.5 };
  if (category === 'tourism' || category === 'historic') return { label: '観光・名所', emoji: '📍', zoom: 13.5 };
  if (category === 'leisure') return { label: '公園・施設', emoji: '🏞️', zoom: 13.5 };
  if (category === 'place' || category === 'boundary') {
    const isBroad = ['country', 'state', 'province', 'region', 'island', 'county'].includes(type ?? '');
    const isCity = ['city', 'town', 'village', 'municipality', 'ward', 'administrative'].includes(
      type ?? ''
    );
    return { label: '地名', emoji: '🗺️', zoom: isBroad ? 9.0 : isCity ? 11.2 : 12.8 };
  }
  return { label: '施設', emoji: '📍', zoom: 13.5 };
}

function classifyGsiTitle(title: string): { label: string; emoji: string; zoom: number } {
  if (/(山|岳|峰|嶺|富士|駒|槍|穂高|乗鞍|立山|白馬|八ヶ岳|アルプス)$/.test(title)) {
    return { label: '山岳', emoji: '⛰️', zoom: 12.2 };
  }
  if (/(高原|湿原|渓谷|峡|滝|湖|沼|池|峠|岬|島|半島|温泉)$/.test(title)) {
    return { label: '自然', emoji: '🌿', zoom: 12.6 };
  }
  if (/駅$/.test(title)) return { label: '駅', emoji: '🚉', zoom: 13.8 };
  if (/空港$/.test(title)) return { label: '空港', emoji: '✈️', zoom: 12.5 };
  if (/(市|区|町|村)$/.test(title)) return { label: '自治体', emoji: '🗺️', zoom: 11.5 };
  return { label: '地名', emoji: '🗺️', zoom: 13.0 };
}

function splitGsiTitle(rawTitle: string, query: string): { name: string; subLabel: string } {
  const cleaned = rawTitle.trim();
  const prefMatch = cleaned.match(/^(北海道|東京都|(?:京都|大阪)府|.{2,3}県)(.+)$/);
  if (!prefMatch) return { name: cleaned, subLabel: '国土地理院 地名検索' };
  const pref = prefMatch[1];
  const rest = prefMatch[2].trim();
  if (!rest) return { name: cleaned, subLabel: '都道府県' };

  const cityMatch = rest.match(/^((?:.+?市.+?区|.+?郡.+?[町村]|.+?[市区町村]))(.+)$/);
  if (cityMatch) {
    const cityPart = cityMatch[1].trim();
    const detailPart = cityMatch[2].trim();
    if (detailPart) {
      return {
        name: detailPart.length <= 1 ? `${cityPart}${detailPart}` : detailPart,
        subLabel: `${pref} ${cityPart}`,
      };
    }
  }

  if (query && rest.endsWith(query) && rest.length > query.length) {
    const prefix = rest.slice(0, rest.length - query.length).trim();
    return { name: query, subLabel: `${pref}${prefix ? ` ${prefix}` : ''}` };
  }

  return { name: rest, subLabel: pref };
}

function buildSearchSubLabel(
  primaryName: string,
  address?: Record<string, string>,
  displayName?: string
): string {
  const summary = formatAddressSummaryFromNominatim(address);
  if (summary && summary !== primaryName) return summary;

  if (displayName) {
    const segments = displayName
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !/^\d{3}-?\d{4}$/.test(s) && s !== primaryName);
    if (segments.length > 0) return segments.slice(-2).join(', ');
  }
  return 'グローバル検索';
}

async function fetchGsiSearchLocations(
  trimmed: string,
  signal?: AbortSignal
): Promise<OsmSearchLocation[]> {
  const url = new URL(GSI_SEARCH_URL);
  url.searchParams.set('q', trimmed);

  const res = await fetchWithTimeout(
    url.toString(),
    { method: 'GET', headers: { Accept: 'application/json' } },
    SEARCH_TIMEOUT_MS,
    signal
  );

  if (!res.ok) throw new Error(`GSI Search HTTP ${res.status}`);

  const rawItems = (await res.json()) as GsiAddressSearchItem[];
  const results: OsmSearchLocation[] = [];

  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i];
    const coords = item.geometry?.coordinates;
    const rawTitle = item.properties?.title?.trim();
    if (!coords || coords.length < 2 || !rawTitle) continue;

    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const { name, subLabel } = splitGsiTitle(rawTitle, trimmed);
    const meta = classifyGsiTitle(name);

    const isDuplicate = results.some(
      (r) => r.name === name && calcDistanceMeters(lat, lng, r.lat, r.lng) < 400
    );
    if (isDuplicate) continue;

    results.push({
      id: `gsi-${i}-${lat.toFixed(4)}-${lng.toFixed(4)}`,
      name,
      subLabel,
      category: meta.label,
      emoji: meta.emoji,
      lat,
      lng,
      recommendedZoom: meta.zoom,
    });
    if (results.length >= 60) break;
  }

  return results;
}

async function fetchNominatimSearchLocations(
  trimmed: string,
  signal?: AbortSignal
): Promise<OsmSearchLocation[]> {
  // 全球対応：countrycodes 制限を撤廃し、accept-language=ja,en を指定
  const url = new URL(NOMINATIM_SEARCH_URL);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('q', trimmed);
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '15');
  url.searchParams.set('accept-language', 'ja,en');

  const res = await fetchWithTimeout(
    url.toString(),
    { method: 'GET', headers: { Accept: 'application/json' } },
    SEARCH_TIMEOUT_MS,
    signal
  );

  if (!res.ok) throw new Error(`Nominatim Search HTTP ${res.status}`);

  const rawItems = (await res.json()) as NominatimSearchItem[];
  const results: OsmSearchLocation[] = [];

  for (const item of rawItems) {
    const lat = Number(item.lat);
    const lng = Number(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const primaryName = (item.name || item.display_name?.split(',')[0] || trimmed).trim();
    if (!primaryName) continue;

    const subLabel = buildSearchSubLabel(primaryName, item.address, item.display_name);
    const meta = classifyNominatimSearchResult(item.category, item.type);

    const isDuplicate = results.some(
      (r) =>
        r.name === primaryName &&
        (r.subLabel === subLabel || calcDistanceMeters(lat, lng, r.lat, r.lng) < 400)
    );
    if (isDuplicate) continue;

    results.push({
      id: `nominatim-${item.place_id}`,
      name: primaryName,
      subLabel,
      category: meta.label,
      emoji: meta.emoji,
      lat,
      lng,
      recommendedZoom: meta.zoom,
    });
    if (results.length >= 15) break;
  }

  return results;
}

const GENERAL_ADMIN_CATEGORIES = new Set(['自治体', '地名']);

function computeSearchPriorityTier(item: OsmSearchLocation, rawQuery: string): number {
  const q = rawQuery.trim().toLowerCase();
  const name = item.name.trim().toLowerCase();
  const isLandmark = !GENERAL_ADMIN_CATEGORIES.has(item.category);

  if (name === q) return isLandmark ? 1.0 : 1.2;
  if (isLandmark && name.startsWith(q)) return 2.0;
  if (isLandmark) return 3.0;
  return name.startsWith(q) ? 4.0 : 4.5;
}

function buildDeduplicatedPool(
  gsiItems: OsmSearchLocation[],
  nominatimItems: OsmSearchLocation[]
): OsmSearchLocation[] {
  const merged: OsmSearchLocation[] = [];

  const addIfUnique = (item: OsmSearchLocation) => {
    const existingIdx = merged.findIndex(
      (m) =>
        calcDistanceMeters(item.lat, item.lng, m.lat, m.lng) < 500 &&
        (m.name === item.name || m.name.includes(item.name) || item.name.includes(m.name))
    );
    if (existingIdx === -1) {
      merged.push(item);
    } else {
      const existing = merged[existingIdx];
      if (existing.category === '地名' && item.category !== '地名') {
        merged[existingIdx] = item;
      }
    }
  };

  for (const item of nominatimItems) addIfUnique(item);
  for (const item of gsiItems) addIfUnique(item);

  return merged;
}

function sortAndSliceSearchPool(
  pool: OsmSearchLocation[],
  query: string,
  refLocation?: SearchReferenceLocation
): OsmSearchLocation[] {
  const scored = pool.map((item, originalIndex) => {
    const distanceMeters =
      refLocation && Number.isFinite(refLocation.lat) && Number.isFinite(refLocation.lng)
        ? calcDistanceMeters(refLocation.lat, refLocation.lng, item.lat, item.lng)
        : undefined;
    const priorityTier = computeSearchPriorityTier(item, query);

    return {
      item: { ...item, distanceMeters },
      priorityTier,
      distanceMeters: distanceMeters ?? Number.MAX_SAFE_INTEGER,
      originalIndex,
    };
  });

  scored.sort((a, b) => {
    if (a.priorityTier !== b.priorityTier) return a.priorityTier - b.priorityTier;
    if (a.distanceMeters !== b.distanceMeters) return a.distanceMeters - b.distanceMeters;
    return a.originalIndex - b.originalIndex;
  });

  return scored.slice(0, 15).map((s) => s.item);
}

export function shouldQueryGsiInParallel(query: string, refLocation?: SearchReferenceLocation): boolean {
  if (/[\u3040-\u30ff\u4e00-\u9faf]/.test(query)) return true;
  if (refLocation && isWithinJapanBBox(refLocation.lat, refLocation.lng)) return true;
  return false;
}

export async function searchOsmLocationsByKeyword(
  query: string,
  signal?: AbortSignal,
  onPartialUpdate?: (items: OsmSearchLocation[]) => void,
  refLocation?: SearchReferenceLocation,
  options?: { skipThrottle?: boolean }
): Promise<OsmSearchLocation[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const cacheKey = trimmed.toLowerCase();
  const cached = searchResultCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    const sortedCached = sortAndSliceSearchPool(cached.pool, trimmed, refLocation);
    onPartialUpdate?.(sortedCached);
    return sortedCached;
  }

  // API礼儀：連続検索時のクライアントスロットリング
  if (!options?.skipThrottle) {
    const elapsed = Date.now() - lastKeywordSearchAt;
    if (elapsed < MIN_SEARCH_INTERVAL_MS) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, MIN_SEARCH_INTERVAL_MS - elapsed);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true }
        );
      });
    }
    lastKeywordSearchAt = Date.now();
  }

  let nominatimList: OsmSearchLocation[] = [];
  let gsiList: OsmSearchLocation[] = [];

  const notifyPartial = () => {
    if (signal?.aborted) return;
    const pool = buildDeduplicatedPool(gsiList, nominatimList);
    if (pool.length > 0) {
      searchResultCache.set(cacheKey, { pool, timestamp: Date.now() });
      onPartialUpdate?.(sortAndSliceSearchPool(pool, trimmed, refLocation));
    }
  };

  const gsiPromise = shouldQueryGsiInParallel(trimmed, refLocation)
    ? fetchGsiSearchLocations(trimmed, signal)
        .then((items) => {
          gsiList = items;
          notifyPartial();
          return items;
        })
        .catch(() => [] as OsmSearchLocation[])
    : Promise.resolve([] as OsmSearchLocation[]);

  const nominatimPromise = fetchNominatimSearchLocations(trimmed, signal)
    .then((items) => {
      nominatimList = items;
      notifyPartial();
      return items;
    })
    .catch(() => [] as OsmSearchLocation[]);

  await Promise.all([gsiPromise, nominatimPromise]);

  if (signal?.aborted) return [];

  const finalPool = buildDeduplicatedPool(gsiList, nominatimList);
  if (finalPool.length > 0) {
    searchResultCache.set(cacheKey, { pool: finalPool, timestamp: Date.now() });
  }

  return sortAndSliceSearchPool(finalPool, trimmed, refLocation);
}

export function resetSearchCachesForTesting(): void {
  candidateCache.clear();
  searchResultCache.clear();
  lastKeywordSearchAt = 0;
}
