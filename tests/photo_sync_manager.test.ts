import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setGoogleAuthAdapterForTesting } from '../src/lib/googleAuth';
import { getStoredPhoto } from '../src/lib/photoStorage';
import {
  downloadAllMissingPhotos,
  ensurePhotoCached,
  findMissingRemotePhotos,
  isRemotePhotoKnownMissing,
  resetPhotoSyncStateForTesting,
  saveWithPhotosToGoogleDrive,
} from '../src/lib/photoSyncManager';
import {
  EMPTY_DRIVE_SYNC_META,
  resetVisitStorageForTesting,
  saveSpotsWithPhotosAtomic,
} from '../src/lib/visitStorage';
import type { PhotoAttachment, StoredPhotoRecord, VisitSpot } from '../src/types/visit';

function makePhoto(id: string, overrides: Partial<PhotoAttachment> = {}): PhotoAttachment {
  const hex = Array.from(id)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(64, '0')
    .slice(0, 64);
  return {
    id,
    fileName: `${id}.webp`,
    mimeType: 'image/webp',
    width: 1600,
    height: 1200,
    bytes: 128,
    checksumSha256: hex,
    ...overrides,
  };
}

function makeStoredPhoto(id: string): StoredPhotoRecord {
  const fullBlob = new NodeBlob(['full-' + id], { type: 'image/webp' }) as unknown as Blob;
  const thumbnailBlob = new NodeBlob(['thumb-' + id], { type: 'image/webp' }) as unknown as Blob;
  return {
    id,
    mimeType: 'image/webp',
    width: 1600,
    height: 1200,
    bytes: fullBlob.size,
    fullBlob,
    thumbnailBlob,
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
  };
}

function makeSpot(photos: PhotoAttachment[]): VisitSpot {
  return {
    id: 'spot-1',
    name: '槍ヶ岳',
    status: 'visited',
    category: 'nature',
    center: [137.647, 36.341],
    elevation: 3180,
    camera: { zoom: 12, pitch: 60, bearing: 0 },
    isPinned: false,
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    entries: [
      {
        id: 'entry-1',
        kind: 'visited',
        date: { precision: 'day', start: '2026-10-10' },
        memo: '快晴',
        photos,
        createdAt: '2026-11-20T00:00:00.000Z',
        updatedAt: '2026-11-20T00:00:00.000Z',
      },
    ],
  };
}

describe('photoSyncManager', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    resetVisitStorageForTesting();
    resetPhotoSyncStateForTesting();
    setGoogleAuthAdapterForTesting({
      isConfigured: () => true,
      requestAccessToken: async () => 'sync-token',
      revoke: async () => {},
    });
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('visit3d_db');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setGoogleAuthAdapterForTesting(null);
    vi.restoreAllMocks();
  });

  it('detects conflict before uploading or trashing any photos', async () => {
    const uploadSpy = vi.fn();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/upload/')) uploadSpy();
      if (url.includes('/drive/v3/files/folder-1?')) {
        return new Response(JSON.stringify({ id: 'folder-1', name: '3D Visit Record' }), { status: 200 });
      }
      if (url.includes('/drive/v3/files/file-1?')) {
        return new Response(
          JSON.stringify({
            id: 'file-1',
            name: 'visit-records.json',
            modifiedTime: '2026-11-20T12:00:00.000Z',
            headRevisionId: 'rev-remote',
          }),
          { status: 200 }
        );
      }
      if (init?.method === 'PATCH') uploadSpy();
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const spot = makeSpot([makePhoto('p1')]);
    const saveRes = await saveSpotsWithPhotosAtomic([spot], [makeStoredPhoto('p1')]);
    expect(saveRes.success).toBe(true);

    const res = await saveWithPhotosToGoogleDrive({
      accessToken: 'sync-token',
      spots: [spot],
      revision: 10,
      syncMeta: {
        ...EMPTY_DRIVE_SYNC_META,
        folderId: 'folder-1',
        fileId: 'file-1',
        lastDriveModifiedTime: '2026-11-20T08:00:00.000Z',
        lastDriveHeadRevisionId: 'rev-local',
      },
    });

    expect(res.outcome).toBe('conflict');
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('uploads pending photos with concurrency <= 3, deduplicates SHA-256, supports partial resume, and auto-trashes unreferenced photos after JSON save', async () => {
    let activeUploads = 0;
    let maxActiveUploads = 0;
    let failP3 = true;
    const trashedIds: string[] = [];
    let jsonSaved = false;

    const shaP2 = '2'.repeat(64);
    const p1 = makePhoto('p1');
    const p2 = makePhoto('p2', { checksumSha256: shaP2 }); // Matches existing remote by checksum
    const p3 = makePhoto('p3');
    const p4 = makePhoto('p4');
    const p5 = makePhoto('p5');

    const spot = makeSpot([p1, p2, p3, p4, p5]);
    const saveRes = await saveSpotsWithPhotosAtomic(
      [spot],
      [makeStoredPhoto('p1'), makeStoredPhoto('p2'), makeStoredPhoto('p3'), makeStoredPhoto('p4'), makeStoredPhoto('p5')]
    );
    expect(saveRes.success).toBe(true);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const q = url.includes('/drive/v3/files?') ? new URL(url).searchParams.get('q') ?? '' : '';

      if (method === 'GET' && url.includes('/drive/v3/files/folder-1?')) {
        return new Response(JSON.stringify({ id: 'folder-1', name: '3D Visit Record' }), { status: 200 });
      }
      if (method === 'GET' && url.includes('/drive/v3/files/file-1?')) {
        return new Response(
          JSON.stringify({
            id: 'file-1',
            name: 'visit-records.json',
            modifiedTime: '2026-11-20T08:00:00.000Z',
            headRevisionId: 'rev-1',
          }),
          { status: 200 }
        );
      }
      if (method === 'GET' && url.includes('/drive/v3/files/photos-dir?')) {
        return new Response(JSON.stringify({ id: 'photos-dir', name: 'photos' }), { status: 200 });
      }
      if (method === 'GET' && q.includes("role' and value='photo'")) {
        return new Response(
          JSON.stringify({
            files: [
              {
                id: 'drv-existing-p2',
                name: 'p2.webp',
                modifiedTime: '2026-11-20T00:00:00Z',
                appProperties: { app: '3d-visit-record', role: 'photo', photoId: 'other-id', checksumSha256: shaP2 },
              },
              {
                id: 'drv-orphan-old',
                name: 'orphan.webp',
                modifiedTime: '2026-11-20T00:00:00Z',
                appProperties: { app: '3d-visit-record', role: 'photo', photoId: 'deleted-id' },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (method === 'POST' && url.includes('/upload/drive/v3/files')) {
        activeUploads++;
        maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
        await new Promise((r) => setTimeout(r, 15));
        activeUploads--;
        const bodyStr = init?.body instanceof Blob ? await init.body.text() : '';
        if (failP3 && bodyStr.includes('"photoId":"p3"')) {
          return new Response('', { status: 403 }); // non-retried failure
        }
        const match = /"photoId":"([^"]+)"/.exec(bodyStr);
        const pid = match?.[1] ?? 'unknown';
        return new Response(
          JSON.stringify({
            id: `drv-${pid}`,
            name: `${pid}.webp`,
            modifiedTime: '2026-11-20T09:00:00Z',
          }),
          { status: 200 }
        );
      }
      if (method === 'GET' && q.includes("role' and value='snapshots'")) {
        return new Response(JSON.stringify({ files: [{ id: 'snap-dir' }] }), { status: 200 });
      }
      if (method === 'POST' && url.includes('/copy?')) {
        return new Response(JSON.stringify({ id: 'snap-1' }), { status: 200 });
      }
      if (method === 'GET' && q.includes("role' and value='snapshot'")) {
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      if (method === 'PATCH' && url.includes('/upload/drive/v3/files/file-1')) {
        jsonSaved = true;
        return new Response(
          JSON.stringify({
            id: 'file-1',
            name: 'visit-records.json',
            modifiedTime: '2026-11-20T10:00:00.000Z',
            headRevisionId: 'rev-2',
          }),
          { status: 200 }
        );
      }
      if (method === 'PATCH' && url.includes('/drive/v3/files/drv-orphan-old')) {
        // Must only trash AFTER JSON is saved
        expect(jsonSaved).toBe(true);
        trashedIds.push('drv-orphan-old');
        return new Response(JSON.stringify({ id: 'drv-orphan-old', trashed: true }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const uploadedCallbackMap: Record<string, string> = {};

    // First attempt: p3 fails; p1/p2/p4/p5 succeed and persist driveFileId for resume; JSON is NOT saved
    await expect(
      saveWithPhotosToGoogleDrive({
        accessToken: 'sync-token',
        spots: [spot],
        revision: 10,
        syncMeta: {
          ...EMPTY_DRIVE_SYNC_META,
          folderId: 'folder-1',
          photosFolderId: 'photos-dir',
          fileId: 'file-1',
          lastDriveModifiedTime: '2026-11-20T08:00:00.000Z',
          lastDriveHeadRevisionId: 'rev-1',
        },
        onPhotoUploaded: (pid, drvId) => {
          uploadedCallbackMap[pid] = drvId;
        },
      })
    ).rejects.toThrow();

    expect(maxActiveUploads).toBeLessThanOrEqual(3);
    expect(jsonSaved).toBe(false);
    expect(trashedIds).toEqual([]);
    expect(uploadedCallbackMap.p2).toBe('drv-existing-p2');
    expect(uploadedCallbackMap.p1).toBe('drv-p1');
    expect(uploadedCallbackMap.p3).toBeUndefined();

    // Resume attempt with already-recorded driveFileIds applied
    failP3 = false;
    const resumedSpot = makeSpot(
      spot.entries[0].photos.map((p) =>
        uploadedCallbackMap[p.id] ? { ...p, driveFileId: uploadedCallbackMap[p.id] } : p
      )
    );
    const secondRes = await saveWithPhotosToGoogleDrive({
      accessToken: 'sync-token',
      spots: [resumedSpot],
      revision: 11,
      syncMeta: {
        ...EMPTY_DRIVE_SYNC_META,
        folderId: 'folder-1',
        photosFolderId: 'photos-dir',
        fileId: 'file-1',
        lastDriveModifiedTime: '2026-11-20T08:00:00.000Z',
        lastDriveHeadRevisionId: 'rev-1',
      },
    });

    expect(secondRes.outcome).toBe('saved');
    if (secondRes.outcome === 'saved') {
      expect(secondRes.uploadedPhotoCount).toBe(1); // Only p3 needed uploading!
      expect(secondRes.trashedPhotoCount).toBe(1);
    }
    expect(jsonSaved).toBe(true);
    expect(trashedIds).toEqual(['drv-orphan-old']);
  });

  it('handles on-demand caching (needs-auth, deduplication, 404 tracking) and abortable bulk download', async () => {
    const thumbFactory = async () =>
      new NodeBlob(['regen-thumb'], { type: 'image/webp' }) as unknown as Blob;

    const pRemote1 = makePhoto('r1', { driveFileId: 'drv-r1', bytes: 10 });
    const pRemote2 = makePhoto('r2', { driveFileId: 'drv-r2', bytes: 20 });
    const pMissing = makePhoto('r-missing', { driveFileId: 'drv-404', bytes: 30 });

    // Without active token and interactiveAuth=false -> returns needs-auth without network calls
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('drv-404')) {
        return new Response('', { status: 404 });
      }
      await new Promise((r) => setTimeout(r, 15));
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'image/webp' }),
        blob: async () => new NodeBlob(['remote-full-bytes'], { type: 'image/webp' }) as unknown as Blob,
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const needsAuthRes = await ensurePhotoCached(pRemote1, {
      interactiveAuth: false,
      generateThumbnail: thumbFactory,
    });
    expect(needsAuthRes.status).toBe('needs-auth');
    expect(fetchMock).not.toHaveBeenCalled();

    // Concurrent calls for the same photo deduplicate into 1 fetch
    const [d1, d2] = await Promise.all([
      ensurePhotoCached(pRemote1, {
        interactiveAuth: true,
        accessToken: 'tok',
        generateThumbnail: thumbFactory,
      }),
      ensurePhotoCached(pRemote1, {
        interactiveAuth: true,
        accessToken: 'tok',
        generateThumbnail: thumbFactory,
      }),
    ]);
    expect(d1.status).toBe('downloaded');
    expect(d2.status).toBe('downloaded');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await getStoredPhoto('r1')).not.toBeNull();

    // 404 remembers missing ID and skips future fetches
    const missingRes1 = await ensurePhotoCached(pMissing, {
      interactiveAuth: true,
      accessToken: 'tok',
      generateThumbnail: thumbFactory,
    });
    expect(missingRes1.status).toBe('missing-remote');
    expect(isRemotePhotoKnownMissing('r-missing')).toBe(true);
    const missingRes2 = await ensurePhotoCached(pMissing, {
      interactiveAuth: true,
      accessToken: 'tok',
      generateThumbnail: thumbFactory,
    });
    expect(missingRes2.status).toBe('missing-remote');
    expect(fetchMock).toHaveBeenCalledTimes(2); // Not called again

    // Bulk download finds only r2 (r1 cached, r-missing known missing) and downloads it
    const spot = makeSpot([pRemote1, pRemote2, pMissing]);
    const summary = await findMissingRemotePhotos([spot]);
    expect(summary.photos.map((p) => p.id)).toEqual(['r2']);
    expect(summary.totalBytes).toBe(20);

    const bulkRes = await downloadAllMissingPhotos({
      spots: [spot],
      accessToken: 'tok',
      generateThumbnail: thumbFactory,
    });
    expect(bulkRes.total).toBe(1);
    expect(bulkRes.downloaded).toBe(1);
    expect(await getStoredPhoto('r2')).not.toBeNull();

    // Bulk download abort stops cleanly
    const pRemote3 = makePhoto('r3', { driveFileId: 'drv-r3', bytes: 40 });
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    const abortedRes = await downloadAllMissingPhotos({
      spots: [makeSpot([pRemote3])],
      accessToken: 'tok',
      signal: abortCtrl.signal,
      generateThumbnail: thumbFactory,
    });
    expect(abortedRes.aborted).toBe(true);
    expect(abortedRes.downloaded).toBe(0);
  });
});
