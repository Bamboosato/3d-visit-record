import type { BaseMapId, SpotCamera } from '../types/visit';
import { MAX_SPOT_NAME_LENGTH } from '../types/visit';

export const PUBLIC_APP_ORIGIN =
  (import.meta.env?.VITE_PUBLIC_APP_ORIGIN as string | undefined) ||
  'https://3d-visit-record.bamboosato.com';

export const DEFAULT_SHARE_TITLE = '3D Visit Record — 3D地形対応 訪問・予定地点記録アプリ';

export interface UrlViewState {
  lat: number;
  lng: number;
  zoom: number;
  pitch: number;
  bearing: number;
  spotName?: string;
  baseMap?: BaseMapId;
  exaggeration?: number;
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

export function cleanSpotName(rawLabel?: string | null): string {
  if (!rawLabel) return '';
  return rawLabel
    .replace(/^[^\p{L}\p{N}]+\s*/u, '')
    .replace(/（山頂）$/, '')
    .trim()
    .slice(0, MAX_SPOT_NAME_LENGTH);
}

export function parseUrlViewState(
  search: string = typeof window !== 'undefined' ? window.location.search : ''
): UrlViewState | null {
  if (!search) return null;
  const params = new URLSearchParams(search);

  const latRaw = params.get('lat');
  const lngRaw = params.get('lng');
  if (latRaw === null || lngRaw === null) return null;

  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }

  const zRaw = params.get('z');
  const pRaw = params.get('p');
  const bRaw = params.get('b');
  const nameRaw = params.get('name');
  const mapRaw = params.get('map');
  const exRaw = params.get('ex');

  const zoom = zRaw !== null && Number.isFinite(Number(zRaw)) ? clamp(Number(zRaw), 1.5, 18) : 10.5;
  const pitch =
    pRaw !== null && Number.isFinite(Number(pRaw)) ? clamp(Math.round(Number(pRaw)), 0, 85) : 55;
  const bearing =
    bRaw !== null && Number.isFinite(Number(bRaw)) ? clamp(Math.round(Number(bRaw)), -180, 180) : 0;

  const spotName = nameRaw ? cleanSpotName(nameRaw) || undefined : undefined;
  const baseMap: BaseMapId | undefined =
    mapRaw === 'osm' || mapRaw === 'hillshade' || mapRaw === 'photo' ? mapRaw : undefined;
  const exaggeration =
    exRaw !== null && Number.isFinite(Number(exRaw)) ? clamp(Number(exRaw), 1.0, 3.0) : undefined;

  return { lat, lng, zoom, pitch, bearing, spotName, baseMap, exaggeration };
}

export interface UrlSyncParams extends SpotCamera {
  lat: number;
  lng: number;
  spotName?: string;
  baseMap?: BaseMapId;
  exaggeration?: number;
}

/**
 * 3D視点リンク用パラメータを構築します。
 * プライバシー原則：地点ID・ステータス・訪問日時・メモ等の個人記録は一切含めません。
 */
export function buildUrlSearchParams(state: UrlSyncParams): URLSearchParams {
  const params = new URLSearchParams();
  params.set('lat', state.lat.toFixed(4));
  params.set('lng', state.lng.toFixed(4));
  params.set('z', state.zoom.toFixed(2));
  params.set('p', String(Math.round(state.pitch)));
  params.set('b', String(Math.round(state.bearing)));

  const cleanedName = cleanSpotName(state.spotName);
  if (cleanedName) params.set('name', cleanedName);
  if (state.baseMap && state.baseMap !== 'osm') params.set('map', state.baseMap);
  if (typeof state.exaggeration === 'number' && Math.abs(state.exaggeration - 1.5) >= 0.05) {
    params.set('ex', state.exaggeration.toFixed(1));
  }

  return params;
}

export function replaceUrlViewState(state: UrlSyncParams): void {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  if (window.location.pathname === '/privacy' || window.location.pathname === '/terms') return;
  const params = buildUrlSearchParams(state);
  const nextUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
  window.history.replaceState(null, '', nextUrl);
}

export function buildPublicShareUrl(state: UrlSyncParams): string {
  const params = buildUrlSearchParams(state);
  const baseOrigin =
    typeof window !== 'undefined' && window.location.hostname !== 'localhost'
      ? window.location.origin
      : PUBLIC_APP_ORIGIN;
  return `${baseOrigin}/?${params.toString()}`;
}

export async function shareOrCopyUrl(options: {
  url: string;
  title?: string;
}): Promise<'shared' | 'copied' | 'cancelled' | 'failed'> {
  const shareTitle = options.title || DEFAULT_SHARE_TITLE;
  const isMobileDevice =
    typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  if (isMobileDevice && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: shareTitle, url: options.url });
      return 'shared';
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return 'cancelled';
    }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(options.url);
      return 'copied';
    } catch {
      // fallback
    }
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = options.url;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    return 'copied';
  } catch {
    return 'failed';
  }
}
