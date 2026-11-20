import { useEffect, useState } from 'react';
import { getStoredPhoto } from './photoStorage';

export type PhotoVariant = 'thumb' | 'full';

const DEFAULT_MAX_THUMB_ENTRIES = 200;
const DEFAULT_MAX_FULL_ENTRIES = 20;

interface CacheEntry {
  key: string;
  url: string;
  refCount: number;
  pendingRevoke: boolean;
  revoked: boolean;
}

const caches: Record<PhotoVariant, Map<string, CacheEntry>> = {
  thumb: new Map(),
  full: new Map(),
};
const limits: Record<PhotoVariant, number> = {
  thumb: DEFAULT_MAX_THUMB_ENTRIES,
  full: DEFAULT_MAX_FULL_ENTRIES,
};

const inFlight = new Map<string, Promise<CacheEntry | null>>();
const entriesByUrl = new Map<string, CacheEntry>();
const pendingByKey = new Map<string, CacheEntry[]>();
const generationByPhotoId = new Map<string, number>();

function makeKey(photoId: string, variant: PhotoVariant): string {
  return `${variant}:${photoId}`;
}

function getGeneration(photoId: string): number {
  return generationByPhotoId.get(photoId) ?? 0;
}

function safeRevokeObjectUrl(url: string): void {
  try {
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(url);
    }
  } catch {
    // ignore
  }
}

function detachAndMaybeRevoke(entry: CacheEntry): void {
  entry.pendingRevoke = true;
  if (entry.refCount <= 0) {
    if (!entry.revoked) {
      entry.revoked = true;
      safeRevokeObjectUrl(entry.url);
    }
    entriesByUrl.delete(entry.url);
    const list = pendingByKey.get(entry.key);
    if (list) {
      const next = list.filter((e) => e !== entry);
      if (next.length > 0) pendingByKey.set(entry.key, next);
      else pendingByKey.delete(entry.key);
    }
    return;
  }
  const list = pendingByKey.get(entry.key) ?? [];
  if (!list.includes(entry)) {
    list.push(entry);
    pendingByKey.set(entry.key, list);
  }
}

function touchAndInsert(variant: PhotoVariant, key: string, entry: CacheEntry): void {
  const map = caches[variant];
  map.delete(key);
  map.set(key, entry);

  const limit = limits[variant];
  while (map.size > limit) {
    const oldest = map.entries().next();
    if (oldest.done) break;
    const [oldKey, oldEntry] = oldest.value;
    map.delete(oldKey);
    detachAndMaybeRevoke(oldEntry);
  }
}

export async function acquirePhotoUrl(
  photoId: string,
  variant: PhotoVariant
): Promise<string | null> {
  if (!photoId) return null;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;

  const key = makeKey(photoId, variant);
  const existing = caches[variant].get(key);
  if (existing && !existing.pendingRevoke) {
    // LRU 鮮度を更新
    caches[variant].delete(key);
    caches[variant].set(key, existing);
    existing.refCount++;
    return existing.url;
  }

  let promise = inFlight.get(key);
  if (!promise) {
    const startGen = getGeneration(photoId);
    promise = (async (): Promise<CacheEntry | null> => {
      const record = await getStoredPhoto(photoId);
      if (!record) return null;
      if (getGeneration(photoId) !== startGen) return null;

      const blob = variant === 'thumb' ? record.thumbnailBlob : record.fullBlob;
      if (!blob || blob.size <= 0) return null;

      const url = URL.createObjectURL(blob);
      const entry: CacheEntry = {
        key,
        url,
        refCount: 0,
        pendingRevoke: false,
        revoked: false,
      };
      entriesByUrl.set(url, entry);
      touchAndInsert(variant, key, entry);
      return entry;
    })().finally(() => {
      if (inFlight.get(key) === promise) {
        inFlight.delete(key);
      }
    });
    inFlight.set(key, promise);
  }

  const entry = await promise;
  if (!entry || entry.revoked) return null;
  entry.refCount++;
  return entry.url;
}

export function releasePhotoUrl(photoId: string, variant: PhotoVariant, url?: string): void {
  if (!photoId) return;
  const key = makeKey(photoId, variant);
  let entry: CacheEntry | undefined;

  if (url) {
    entry = entriesByUrl.get(url);
  }
  if (!entry) {
    entry = caches[variant].get(key);
  }
  if (!entry) {
    const list = pendingByKey.get(key);
    if (list && list.length > 0) {
      entry = list[0];
    }
  }
  if (!entry) return;

  entry.refCount = Math.max(0, entry.refCount - 1);
  if (entry.refCount === 0 && entry.pendingRevoke) {
    detachAndMaybeRevoke(entry);
  }
}

export function invalidatePhotoUrl(photoId: string): void {
  if (!photoId) return;
  generationByPhotoId.set(photoId, getGeneration(photoId) + 1);
  for (const variant of ['thumb', 'full'] as const) {
    const key = makeKey(photoId, variant);
    const entry = caches[variant].get(key);
    if (entry) {
      caches[variant].delete(key);
      detachAndMaybeRevoke(entry);
    }
  }
}

export function clearPhotoUrlCacheForTesting(options?: {
  maxThumbEntries?: number;
  maxFullEntries?: number;
}): void {
  for (const variant of ['thumb', 'full'] as const) {
    for (const entry of caches[variant].values()) {
      safeRevokeObjectUrl(entry.url);
    }
    caches[variant].clear();
  }
  for (const list of pendingByKey.values()) {
    for (const entry of list) {
      safeRevokeObjectUrl(entry.url);
    }
  }
  pendingByKey.clear();
  entriesByUrl.clear();
  inFlight.clear();
  generationByPhotoId.clear();
  limits.thumb = options?.maxThumbEntries ?? DEFAULT_MAX_THUMB_ENTRIES;
  limits.full = options?.maxFullEntries ?? DEFAULT_MAX_FULL_ENTRIES;
}

export function usePhotoObjectUrl(
  photoId: string | null | undefined,
  variant: PhotoVariant,
  refreshKey = 0
): { url: string | null; loading: boolean } {
  const [state, setState] = useState<{ url: string | null; loading: boolean }>({
    url: null,
    loading: Boolean(photoId),
  });

  useEffect(() => {
    if (!photoId) {
      setState({ url: null, loading: false });
      return;
    }

    let cancelled = false;
    let acquiredUrl: string | null = null;
    setState((prev) => ({ ...prev, loading: true }));

    void acquirePhotoUrl(photoId, variant).then((url) => {
      if (cancelled) {
        if (url) releasePhotoUrl(photoId, variant, url);
        return;
      }
      acquiredUrl = url;
      setState({ url, loading: false });
    });

    return () => {
      cancelled = true;
      if (acquiredUrl) {
        releasePhotoUrl(photoId, variant, acquiredUrl);
      }
    };
  }, [photoId, variant, refreshKey]);

  return state;
}
