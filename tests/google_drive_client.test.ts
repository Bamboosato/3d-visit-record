import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DriveApiError,
  downloadRemoteRecords,
  fetchDriveUserInfo,
  saveToGoogleDrive,
} from '../src/lib/googleDriveClient';
import { setGoogleAuthAdapterForTesting } from '../src/lib/googleAuth';
import { EMPTY_DRIVE_SYNC_META } from '../src/lib/visitStorage';
import { buildBackupEnvelope } from '../src/lib/visitMerge';
import type { VisitSpot } from '../src/types/visit';

const sampleSpot: VisitSpot = {
  id: 's1',
  name: '富士山',
  status: 'visited',
  category: 'nature',
  center: [138.7274, 35.3606],
  elevation: 3776,
  camera: { zoom: 11, pitch: 60, bearing: -15 },
  isPinned: true,
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
  entries: [
    {
      id: 'e1',
      kind: 'visited',
      date: { precision: 'day', start: '2026-07-20' },
      memo: '御来光',
      photos: [],
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
    },
  ],
};

describe('googleDriveClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setGoogleAuthAdapterForTesting({
      isConfigured: () => true,
      requestAccessToken: async () => 'refreshed-token',
      revoke: async () => {},
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setGoogleAuthAdapterForTesting(null);
    vi.restoreAllMocks();
  });

  it('requests about.get with mandatory fields=user(...) parameter', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain('/drive/v3/about');
      expect(url).toContain('fields=user');
      return new Response(
        JSON.stringify({ user: { displayName: 'Taro', emailAddress: 'taro@example.com' } }),
        { status: 200 }
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const user = await fetchDriveUserInfo('token-1');
    expect(user.emailAddress).toBe('taro@example.com');
  });

  it('creates folder & visit-records.json on initial save', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });

      if (method === 'GET' && url.includes('/drive/v3/files?')) {
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }
      if (method === 'POST' && url.includes('/drive/v3/files?fields=id')) {
        return new Response(JSON.stringify({ id: 'folder-root-1' }), { status: 200 });
      }
      if (method === 'POST' && url.includes('/upload/drive/v3/files')) {
        return new Response(
          JSON.stringify({
            id: 'file-rec-1',
            name: 'visit-records.json',
            modifiedTime: '2026-11-20T00:00:00.000Z',
            headRevisionId: 'rev-1',
          }),
          { status: 200 }
        );
      }
      return new Response('not mocked', { status: 500 });
    }) as typeof fetch;

    const res = await saveToGoogleDrive({
      accessToken: 'tok-1',
      spots: [sampleSpot],
      revision: 10,
      syncMeta: { ...EMPTY_DRIVE_SYNC_META },
    });

    expect(res.outcome).toBe('saved');
    if (res.outcome === 'saved') {
      expect(res.folderId).toBe('folder-root-1');
      expect(res.fileId).toBe('file-rec-1');
      expect(res.revision).toBe(10);
    }
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/upload/drive/v3/files'))).toBe(
      true
    );
  });

  it('detects conflict when remote file was modified elsewhere, and rotates snapshots on overwrite', async () => {
    const deletedSnapshotIds: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const q = url.includes('/drive/v3/files?') ? new URL(url).searchParams.get('q') ?? '' : '';

      if (method === 'GET' && url.includes('/drive/v3/files/folder-1?')) {
        return new Response(JSON.stringify({ id: 'folder-1', name: '3D Visit Record' }), {
          status: 200,
        });
      }
      if (method === 'GET' && url.includes('/drive/v3/files/file-1?')) {
        return new Response(
          JSON.stringify({
            id: 'file-1',
            name: 'visit-records.json',
            modifiedTime: '2026-11-20T09:00:00.000Z',
            headRevisionId: 'rev-2',
          }),
          { status: 200 }
        );
      }
      if (method === 'GET' && q.includes("role' and value='snapshots'")) {
        return new Response(JSON.stringify({ files: [{ id: 'snap-dir' }] }), { status: 200 });
      }
      if (method === 'POST' && url.includes('/copy?')) {
        return new Response(JSON.stringify({ id: 'snap-new' }), { status: 200 });
      }
      if (method === 'GET' && q.includes("role' and value='snapshot'")) {
        return new Response(
          JSON.stringify({
            files: [
              { id: 's1' },
              { id: 's2' },
              { id: 's3' },
              { id: 's4' },
              { id: 's5' },
              { id: 's6' },
            ],
          }),
          { status: 200 }
        );
      }
      if (method === 'DELETE' && url.includes('/drive/v3/files/s6')) {
        deletedSnapshotIds.push('s6');
        return new Response('', { status: 204 });
      }
      if (method === 'PATCH' && url.includes('/upload/drive/v3/files/file-1')) {
        return new Response(
          JSON.stringify({
            id: 'file-1',
            name: 'visit-records.json',
            modifiedTime: '2026-11-20T10:00:00.000Z',
            headRevisionId: 'rev-3',
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const conflict = await saveToGoogleDrive({
      accessToken: 'tok-1',
      spots: [sampleSpot],
      revision: 11,
      syncMeta: {
        ...EMPTY_DRIVE_SYNC_META,
        folderId: 'folder-1',
        fileId: 'file-1',
        lastDriveModifiedTime: '2026-11-20T08:00:00.000Z',
        lastDriveHeadRevisionId: 'rev-1',
      },
    });
    expect(conflict.outcome).toBe('conflict');
    if (conflict.outcome === 'conflict') {
      expect(conflict.reason).toBe('remote-newer');
    }

    const forced = await saveToGoogleDrive({
      accessToken: 'tok-1',
      spots: [sampleSpot],
      revision: 12,
      syncMeta: {
        ...EMPTY_DRIVE_SYNC_META,
        folderId: 'folder-1',
        fileId: 'file-1',
        lastDriveModifiedTime: '2026-11-20T08:00:00.000Z',
      },
      forceOverwrite: true,
    });
    expect(forced.outcome).toBe('saved');
    expect(deletedSnapshotIds).toEqual(['s6']);
  });

  it('refreshes token once on 401 and maps quota/404 errors clearly', async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('Authorization');
      if (url.includes('/about')) {
        attempts++;
        if (attempts === 1) {
          return new Response('', { status: 401 });
        }
        expect(auth).toBe('Bearer refreshed-token');
        return new Response(JSON.stringify({ user: { emailAddress: 'ok@example.com' } }), {
          status: 200,
        });
      }
      if (url.includes('missing-id')) {
        return new Response('', { status: 404 });
      }
      return new Response(
        JSON.stringify({ error: { errors: [{ reason: 'storageQuotaExceeded' }] } }),
        { status: 403 }
      );
    }) as typeof fetch;

    const info = await fetchDriveUserInfo('expired-token');
    expect(info.emailAddress).toBe('ok@example.com');

    await expect(downloadRemoteRecords('tok', 'missing-id')).rejects.toMatchObject({
      name: 'DriveApiError',
      kind: 'not-found',
    });

    const quotaErr = await saveToGoogleDrive({
      accessToken: 'tok',
      spots: [sampleSpot],
      revision: 1,
      syncMeta: { ...EMPTY_DRIVE_SYNC_META },
    }).catch((e) => e);
    expect(quotaErr).toBeInstanceOf(DriveApiError);
    expect(quotaErr.kind).toBe('quota');

    // Download valid envelope smoke test
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('alt=media')) {
        return new Response(JSON.stringify(buildBackupEnvelope([sampleSpot], 5)), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          id: 'file-1',
          name: 'visit-records.json',
          modifiedTime: '2026-11-20T00:00:00.000Z',
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const downloaded = await downloadRemoteRecords('tok', 'file-1');
    expect(downloaded.items).toHaveLength(1);
    expect(downloaded.items[0].name).toBe('富士山');
  });
});
