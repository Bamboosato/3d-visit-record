import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectReferencedPhotoIds,
  countTotalPhotos,
  hasUnuploadedPhotos,
  isValidPhotoAttachment,
  isValidVisitEntry,
} from '../src/lib/spotDomain';
import {
  getPhotoStorageStats,
  getStoredPhoto,
  hasStoredPhoto,
} from '../src/lib/photoStorage';
import {
  acquirePhotoUrl,
  clearPhotoUrlCacheForTesting,
  invalidatePhotoUrl,
  releasePhotoUrl,
} from '../src/lib/photoUrlCache';
import {
  loadAppState,
  patchPhotoDriveFileIds,
  resetVisitStorageForTesting,
  restoreUndoSnapshot,
  saveSpots,
  saveSpotsWithPhotosAtomic,
  saveSpotsWithUndoAtomic,
} from '../src/lib/visitStorage';
import { MAX_PHOTOS_PER_ENTRY, type PhotoAttachment, type StoredPhotoRecord, type VisitSpot } from '../src/types/visit';

function makePhotoAttachment(id: string, overrides: Partial<PhotoAttachment> = {}): PhotoAttachment {
  return {
    id,
    fileName: `${id}.webp`,
    mimeType: 'image/webp',
    width: 1600,
    height: 1200,
    bytes: 120,
    checksumSha256: 'a'.repeat(64),
    ...overrides,
  };
}

function makeStoredPhoto(id: string): StoredPhotoRecord {
  // happy-dom の Blob は Symbol 内部バッファが fake-indexeddb の structuredClone で欠落するため Node ネイティブ Blob を使用する
  const fullBlob = new NodeBlob(['full-data-' + id], { type: 'image/webp' }) as unknown as Blob;
  const thumbnailBlob = new NodeBlob(['thumb-' + id], { type: 'image/webp' }) as unknown as Blob;
  return {
    id,
    mimeType: 'image/webp',
    width: 1600,
    height: 1200,
    bytes: fullBlob.size,
    fullBlob,
    thumbnailBlob,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  };
}

function makeSpotWithPhotos(spotId: string, photos: PhotoAttachment[]): VisitSpot {
  return {
    id: spotId,
    name: '白馬岳',
    status: 'visited',
    category: 'nature',
    center: [137.758, 36.758],
    elevation: 2932,
    camera: { zoom: 12, pitch: 60, bearing: 0 },
    isPinned: false,
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
    entries: [
      {
        id: `${spotId}-e1`,
        kind: 'visited',
        date: { precision: 'day', start: '2026-10-10' },
        memo: '大雪渓',
        photos,
        createdAt: '2026-10-10T00:00:00.000Z',
        updatedAt: '2026-10-10T00:00:00.000Z',
      },
    ],
  };
}

describe('photoStorage & spotDomain photo rules', () => {
  beforeEach(async () => {
    resetVisitStorageForTesting();
    clearPhotoUrlCacheForTesting();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('visit3d_db');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearPhotoUrlCacheForTesting();
  });

  it('validates photo attachments and entry photo limits strictly', () => {
    const valid = makePhotoAttachment('p1', { caption: '頂上からの眺め', driveFileId: 'drv-1' });
    expect(isValidPhotoAttachment(valid)).toBe(true);

    expect(isValidPhotoAttachment(makePhotoAttachment('p1', { fileName: '../evil.webp' }))).toBe(false);
    expect(isValidPhotoAttachment(makePhotoAttachment('p1', { fileName: 'dir/pic.webp' }))).toBe(false);
    expect(isValidPhotoAttachment(makePhotoAttachment('p1', { caption: 'x'.repeat(201) }))).toBe(false);
    expect(isValidPhotoAttachment(makePhotoAttachment('p1', { caption: 'bad\u0000' }))).toBe(false);
    expect(isValidPhotoAttachment(makePhotoAttachment('p1', { checksumSha256: 'not-hex' }))).toBe(false);
    expect(isValidPhotoAttachment(makePhotoAttachment('p1', { driveFileId: '' }))).toBe(false);

    const tooMany = Array.from({ length: MAX_PHOTOS_PER_ENTRY + 1 }, (_, i) => makePhotoAttachment(`p${i}`));
    const spotTooMany = makeSpotWithPhotos('s1', tooMany);
    expect(isValidVisitEntry(spotTooMany.entries[0])).toBe(false);

    const dupIds = [makePhotoAttachment('dup'), makePhotoAttachment('dup')];
    expect(isValidVisitEntry(makeSpotWithPhotos('s2', dupIds).entries[0])).toBe(false);

    const spot = makeSpotWithPhotos('s3', [
      makePhotoAttachment('p1'),
      makePhotoAttachment('p2', { driveFileId: 'drv-2' }),
    ]);
    expect(collectReferencedPhotoIds([spot])).toEqual(new Set(['p1', 'p2']));
    expect(countTotalPhotos([spot])).toBe(2);
    expect(hasUnuploadedPhotos([spot])).toBe(true);
    expect(
      hasUnuploadedPhotos([makeSpotWithPhotos('s4', [makePhotoAttachment('p2', { driveFileId: 'drv-2' })])])
    ).toBe(false);
  });

  it('atomically saves spots with photo blobs and restores them across cache reset', async () => {
    const spot = makeSpotWithPhotos('s1', [makePhotoAttachment('p1')]);
    const rec = makeStoredPhoto('p1');

    const res = await saveSpotsWithPhotosAtomic([spot], [rec]);
    expect(res.success).toBe(true);

    resetVisitStorageForTesting();
    const state = await loadAppState();
    expect(state.spots).toHaveLength(1);
    expect(state.spots[0].entries[0].photos[0].id).toBe('p1');

    const stored = await getStoredPhoto('p1');
    expect(stored).not.toBeNull();
    expect(stored?.mimeType).toBe('image/webp');
    expect(stored?.fullBlob.size).toBe(rec.fullBlob.size);

    const stats = await getPhotoStorageStats();
    expect(stats.photoCount).toBe(1);
    expect(stats.totalBytes).toBe(rec.fullBlob.size + rec.thumbnailBlob.size);
  });

  it('protects photos referenced by 1-gen Undo and garbage-collects orphans once unreferenced', async () => {
    const spot1 = makeSpotWithPhotos('s1', [makePhotoAttachment('p1')]);
    await saveSpotsWithPhotosAtomic([spot1], [makeStoredPhoto('p1')]);
    expect(await hasStoredPhoto('p1')).toBe(true);

    // Replace via Drive restore: p1 stays referenced in undo snapshot
    const spot2 = makeSpotWithPhotos('s2', []);
    const restoreRes = await saveSpotsWithUndoAtomic([spot2], [spot1], 'drive-restore');
    expect(restoreRes.success).toBe(true);
    expect(await hasStoredPhoto('p1')).toBe(true);

    // Execute Undo: spot1 and p1 are both restored
    const undoRes = await restoreUndoSnapshot();
    expect(undoRes.success).toBe(true);
    expect(undoRes.state?.spots[0].id).toBe('s1');
    expect(await hasStoredPhoto('p1')).toBe(true);

    // Remove photo from spot1 without Undo snapshot -> p1 is GC'd
    await saveSpots([makeSpotWithPhotos('s1', [])]);
    expect(await hasStoredPhoto('p1')).toBe(false);
  });

  it('patches photo driveFileIds without bumping local revision', async () => {
    const spot = makeSpotWithPhotos('s1', [makePhotoAttachment('p1'), makePhotoAttachment('p2')]);
    const saveRes = await saveSpotsWithPhotosAtomic([spot], [makeStoredPhoto('p1'), makeStoredPhoto('p2')]);
    const prevRev = saveRes.state!.revision;

    const patchRes = await patchPhotoDriveFileIds({ p1: 'drv-p1' });
    expect(patchRes.success).toBe(true);
    expect(patchRes.state!.revision).toBe(prevRev);
    expect(patchRes.state!.spots[0].entries[0].photos[0].driveFileId).toBe('drv-p1');
    expect(patchRes.state!.spots[0].entries[0].photos[1].driveFileId).toBeUndefined();

    resetVisitStorageForTesting();
    const reloaded = await loadAppState();
    expect(reloaded.spots[0].entries[0].photos[0].driveFileId).toBe('drv-p1');
  });

  it('manages Object URLs with deduplication, LRU eviction deferred while referenced, and invalidation', async () => {
    let urlCounter = 0;
    const revoked: string[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;

    URL.createObjectURL = vi.fn(() => `blob:mock-${++urlCounter}`);
    URL.revokeObjectURL = vi.fn((u: string) => {
      revoked.push(u);
    });

    try {
      clearPhotoUrlCacheForTesting({ maxThumbEntries: 2, maxFullEntries: 2 });
      await saveSpotsWithPhotosAtomic(
        [
          makeSpotWithPhotos('s1', [
            makePhotoAttachment('p1'),
            makePhotoAttachment('p2'),
            makePhotoAttachment('p3'),
          ]),
        ],
        [makeStoredPhoto('p1'), makeStoredPhoto('p2'), makeStoredPhoto('p3')]
      );

      // Concurrent acquire deduplicates ObjectURL creation
      const [u1a, u1b] = await Promise.all([
        acquirePhotoUrl('p1', 'thumb'),
        acquirePhotoUrl('p1', 'thumb'),
      ]);
      expect(u1a).toBe('blob:mock-1');
      expect(u1b).toBe('blob:mock-1');
      expect(URL.createObjectURL).toHaveBeenCalledTimes(1);

      // Release one ref so p1 still has refCount = 1
      releasePhotoUrl('p1', 'thumb', u1a!);

      // Acquire p2 and release immediately (refCount = 0)
      const u2 = await acquirePhotoUrl('p2', 'thumb');
      releasePhotoUrl('p2', 'thumb', u2!);

      // Acquire p3 -> evicts p1 from LRU, but p1 still has refCount = 1 so it must NOT revoke yet
      const u3 = await acquirePhotoUrl('p3', 'thumb');
      expect(u3).toBe('blob:mock-3');
      expect(revoked).not.toContain('blob:mock-1');

      // Final release of p1 triggers deferred revoke
      releasePhotoUrl('p1', 'thumb', u1b!);
      expect(revoked).toContain('blob:mock-1');

      // Invalidate p2 -> revokes immediately because refCount === 0
      invalidatePhotoUrl('p2');
      expect(revoked).toContain('blob:mock-2');

      // Invalidate p3 while still referenced -> revokes only after release
      expect(revoked).not.toContain('blob:mock-3');
      invalidatePhotoUrl('p3');
      expect(revoked).not.toContain('blob:mock-3');
      releasePhotoUrl('p3', 'thumb', u3!);
      expect(revoked).toContain('blob:mock-3');
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });
});
