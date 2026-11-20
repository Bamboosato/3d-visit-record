import { describe, expect, it } from 'vitest';
import {
  buildBackupEnvelope,
  detectBackupFormat,
  parseBackupJson,
  PHOTO_SYNC_VERSION,
  previewMerge,
  VisitTransferError,
} from '../src/lib/visitMerge';
import type { PhotoAttachment, VisitSpot } from '../src/types/visit';

function makeSpot(overrides: Partial<VisitSpot> = {}): VisitSpot {
  return {
    id: 'spot-1',
    name: '上高地',
    status: 'visited',
    category: 'nature',
    center: [137.638, 36.248],
    elevation: 1505,
    camera: { zoom: 12.5, pitch: 55, bearing: -10 },
    isPinned: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    entries: [
      {
        id: 'entry-1',
        kind: 'visited',
        date: { precision: 'day', start: '2025-10-10', end: '2025-10-12' },
        memo: '紅葉が最高だった',
        photos: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('visitMerge', () => {
  it('roundtrips envelope and preserves future v2 photo attachment metadata', () => {
    const spotWithPhoto = makeSpot({
      entries: [
        {
          id: 'entry-v2',
          kind: 'visited',
          date: { precision: 'day', start: '2026-05-01' },
          memo: '写真付きテスト',
          photos: [
            {
              id: 'p1',
              fileName: 'p1.webp',
              mimeType: 'image/webp',
              width: 1600,
              height: 1200,
              bytes: 120400,
              caption: '河童橋',
              driveFileId: 'drv-photo-1',
            },
          ],
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      ],
    });

    const envelope = buildBackupEnvelope([spotWithPhoto], 42);
    const parsed = parseBackupJson(JSON.stringify(envelope));
    expect(parsed.format).toBe('visit-record');
    expect(parsed.revision).toBe(42);
    expect(parsed.items[0].entries[0].photos).toHaveLength(1);
    expect(parsed.items[0].entries[0].photos[0].driveFileId).toBe('drv-photo-1');
  });

  it('rejects unsupported schemaVersion and invalid coordinates or control chars', () => {
    expect(() =>
      parseBackupJson(
        JSON.stringify({
          app: '3d-visit-record',
          kind: 'visit-records',
          schemaVersion: 99,
          items: [],
        })
      )
    ).toThrow(VisitTransferError);

    expect(() =>
      parseBackupJson(
        JSON.stringify({
          app: '3d-visit-record',
          kind: 'visit-records',
          schemaVersion: 1,
          items: [makeSpot({ center: [999, 35] })],
        })
      )
    ).toThrow(VisitTransferError);

    expect(() =>
      parseBackupJson(
        JSON.stringify({
          app: '3d-visit-record',
          kind: 'visit-records',
          schemaVersion: 1,
          items: [makeSpot({ name: 'bad\u0000name' })],
        })
      )
    ).toThrow(VisitTransferError);
  });

  it('detects and converts 3d_rain_viewer favorites JSON backups', () => {
    const rainJson = JSON.stringify({
      app: '3d-rain-viewer',
      kind: 'favorites',
      schema: 1,
      exportedAt: '2026-11-10T00:00:00.000Z',
      count: 1,
      items: [
        {
          id: 'fav-1',
          name: '槍ヶ岳',
          center: [137.647, 36.341],
          zoom: 12.2,
          pitch: 65,
          bearing: 20,
          elevation: 3180,
          category: 'nature',
          isPinned: true,
        },
      ],
    });

    expect(detectBackupFormat(rainJson)).toBe('rain-viewer');
    const asPlanned = parseBackupJson(rainJson, { rainViewerImportStatus: 'planned' });
    expect(asPlanned.items[0].status).toBe('planned');
    expect(asPlanned.items[0].category).toBe('nature');
    expect(asPlanned.items[0].entries[0].kind).toBe('planned');

    const asVisited = parseBackupJson(rainJson, { rainViewerImportStatus: 'visited' });
    expect(asVisited.items[0].status).toBe('visited');
  });

  it('union-merges entries across devices for the same spot and recalculates status', () => {
    const localSpot = makeSpot({
      id: 'local-id',
      status: 'planned',
      updatedAt: '2026-10-01T00:00:00.000Z',
      entries: [
        {
          id: 'plan-1',
          kind: 'planned',
          date: { precision: 'month', start: '2026-11' },
          memo: 'スマホで予定作成',
          photos: [],
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    });

    // Nearby spot (~10m away) with a different id and a visited entry recorded on PC
    const incomingSpot = makeSpot({
      id: 'pc-id',
      status: 'visited',
      center: [137.6381, 36.2481],
      updatedAt: '2026-10-15T00:00:00.000Z',
      entries: [
        {
          id: 'visit-pc',
          kind: 'visited',
          date: { precision: 'day', start: '2026-10-14' },
          memo: 'PCで記録追記',
          photos: [],
          createdAt: '2026-10-14T00:00:00.000Z',
          updatedAt: '2026-10-15T00:00:00.000Z',
        },
      ],
    });

    const preview = previewMerge([localSpot], [incomingSpot], 'merge');
    expect(preview.added).toBe(0);
    expect(preview.updated).toBe(1);
    expect(preview.entriesAdded).toBe(1);
    expect(preview.next).toHaveLength(1);
    // Existing ID kept, both entries retained, status promoted to visited
    expect(preview.next[0].id).toBe('local-id');
    expect(preview.next[0].entries.map((e) => e.id).sort()).toEqual(['plan-1', 'visit-pc']);
    expect(preview.next[0].status).toBe('visited');
  });

  it('computes replace preview counts accurately', () => {
    const a = makeSpot({ id: 'a' });
    const b = makeSpot({ id: 'b', center: [138.7, 35.3], name: '富士山' });
    const c = makeSpot({ id: 'c', center: [2.2945, 48.8584], name: 'エッフェル塔' });

    const preview = previewMerge([a, b], [a, c], 'replace');
    expect(preview.added).toBe(1);
    expect(preview.removed).toBe(1);
    expect(preview.unchanged).toBe(1);
    expect(preview.next.map((s) => s.id)).toEqual(['a', 'c']);
    expect(preview.photosAdded).toBe(0);
    expect(preview.photosRemoved).toBe(0);
  });
});

function makePhoto(id: string, overrides: Partial<PhotoAttachment> = {}): PhotoAttachment {
  return {
    id,
    fileName: `${id}.webp`,
    mimeType: 'image/webp',
    width: 1200,
    height: 900,
    bytes: 12345,
    createdAt: '2026-10-10T00:00:00.000Z',
    checksumSha256: 'a'.repeat(64),
    ...overrides,
  };
}

function makeSpotWithPhotos(
  id: string,
  photos: PhotoAttachment[],
  updatedAt = '2026-10-10T00:00:00.000Z'
): VisitSpot {
  return {
    id,
    name: `Spot ${id}`,
    status: 'visited',
    category: 'nature',
    center: [137.638, 36.248],
    elevation: 1500,
    camera: { zoom: 12, pitch: 55, bearing: 0 },
    isPinned: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt,
    entries: [
      {
        id: `${id}-entry-1`,
        kind: 'visited',
        date: { precision: 'day', start: '2026-10-10' },
        memo: 'テスト記録',
        photos,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt,
      },
    ],
  };
}

describe('v2 photo merge & backup transfer', () => {
  it('writes schemaVersion 1 with photoSyncVersion 2 and round-trips through parseBackupJson', () => {
    const spot = makeSpotWithPhotos('spot-p1', [
      makePhoto('photo-1', { caption: '  山頂の景色  ' }),
      makePhoto('photo-2', { caption: '   ' }),
    ]);

    const envelope = buildBackupEnvelope([spot], 4);
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.photoSyncVersion).toBe(PHOTO_SYNC_VERSION);
    expect(PHOTO_SYNC_VERSION).toBe(2);

    const parsed = parseBackupJson(JSON.stringify(envelope));
    expect(parsed.format).toBe('visit-record');
    expect(parsed.revision).toBe(4);
    expect(parsed.photoSyncVersion).toBe(2);
    expect(parsed.items[0].entries[0].photos[0].caption).toBe('山頂の景色');
    expect(parsed.items[0].entries[0].photos[1].caption).toBeUndefined();
  });

  it('respects full photo deletion when photoSyncVersion >= 2 and reports photo delta', () => {
    const prev = [
      makeSpotWithPhotos(
        'spot-1',
        [makePhoto('p1'), makePhoto('p2')],
        '2026-10-10T00:00:00.000Z'
      ),
    ];
    const incomingDeleted = [makeSpotWithPhotos('spot-1', [], '2026-10-12T00:00:00.000Z')];

    const v2Preview = previewMerge(prev, incomingDeleted, 'merge', { photoSyncVersion: 2 });
    expect(v2Preview.updated).toBe(1);
    expect(v2Preview.next[0].entries[0].photos).toEqual([]);
    expect(v2Preview.photosAdded).toBe(0);
    expect(v2Preview.photosRemoved).toBe(2);

    const incomingReplaced = [
      makeSpotWithPhotos(
        'spot-1',
        [makePhoto('p2', { caption: '並び替え後' }), makePhoto('p3')],
        '2026-10-13T00:00:00.000Z'
      ),
    ];
    const reorderPreview = previewMerge(prev, incomingReplaced, 'merge', { photoSyncVersion: 2 });
    expect(reorderPreview.next[0].entries[0].photos.map((p) => p.id)).toEqual(['p2', 'p3']);
    expect(reorderPreview.next[0].entries[0].photos[0].caption).toBe('並び替え後');
    expect(reorderPreview.photosAdded).toBe(1);
    expect(reorderPreview.photosRemoved).toBe(1);
  });

  it('preserves existing photos for legacy v1 backups when incoming photos is empty', () => {
    const prev = [
      makeSpotWithPhotos('spot-1', [makePhoto('p1')], '2026-10-10T00:00:00.000Z'),
    ];
    const legacyIncoming = [makeSpotWithPhotos('spot-1', [], '2026-10-12T00:00:00.000Z')];

    const v1Preview = previewMerge(prev, legacyIncoming, 'merge');
    expect(v1Preview.updated).toBe(1);
    expect(v1Preview.next[0].entries[0].photos.map((p) => p.id)).toEqual(['p1']);
    expect(v1Preview.photosAdded).toBe(0);
    expect(v1Preview.photosRemoved).toBe(0);
  });

  it('tracks photoAdded and photoRemoved in replace mode', () => {
    const prev = [makeSpotWithPhotos('spot-1', [makePhoto('p1'), makePhoto('p2')])];
    const incoming = [makeSpotWithPhotos('spot-2', [makePhoto('p2'), makePhoto('p3'), makePhoto('p4')])];

    const replacePreview = previewMerge(prev, incoming, 'replace', { photoSyncVersion: 2 });
    expect(replacePreview.photosAdded).toBe(2);
    expect(replacePreview.photosRemoved).toBe(1);
  });

  it('rejects path-traversal fileName and invalid caption in parseBackupJson, and caps/dedupes photos', () => {
    const badFileSpot = makeSpotWithPhotos('spot-bad-file', [
      makePhoto('p1', { fileName: '../secret.webp' }),
    ]);
    expect(() =>
      parseBackupJson(JSON.stringify(buildBackupEnvelope([badFileSpot])))
    ).toThrow(VisitTransferError);

    const slashFileSpot = makeSpotWithPhotos('spot-slash-file', [
      makePhoto('p1', { fileName: 'dir/p1.webp' }),
    ]);
    expect(() =>
      parseBackupJson(JSON.stringify(buildBackupEnvelope([slashFileSpot])))
    ).toThrow(VisitTransferError);

    const longCaptionSpot = makeSpotWithPhotos('spot-long-cap', [
      makePhoto('p1', { caption: 'あ'.repeat(201) }),
    ]);
    expect(() =>
      parseBackupJson(JSON.stringify(buildBackupEnvelope([longCaptionSpot])))
    ).toThrow(VisitTransferError);

    const controlCaptionSpot = makeSpotWithPhotos('spot-ctrl-cap', [
      makePhoto('p1', { caption: 'bad\u0007caption' }),
    ]);
    expect(() =>
      parseBackupJson(JSON.stringify(buildBackupEnvelope([controlCaptionSpot])))
    ).toThrow(VisitTransferError);

    const extraPhotosSpot = makeSpotWithPhotos('spot-many', [
      makePhoto('p1'),
      makePhoto('p1'),
      makePhoto('p2'),
      makePhoto('p3'),
      makePhoto('p4'),
      makePhoto('p5'),
      makePhoto('p6'),
    ]);
    const parsedMany = parseBackupJson(JSON.stringify(buildBackupEnvelope([extraPhotosSpot])));
    expect(parsedMany.items[0].entries[0].photos.map((p) => p.id)).toEqual([
      'p1',
      'p2',
      'p3',
      'p4',
    ]);
  });
});
