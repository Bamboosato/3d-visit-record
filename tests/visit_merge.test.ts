import { describe, expect, it } from 'vitest';
import {
  buildBackupEnvelope,
  detectBackupFormat,
  parseBackupJson,
  previewMerge,
  VisitTransferError,
} from '../src/lib/visitMerge';
import type { VisitSpot } from '../src/types/visit';

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
  });
});
