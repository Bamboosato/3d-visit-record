import { beforeEach, describe, expect, it } from 'vitest';
import {
  getVisitStorageWarning,
  isVisitStorageBlocked,
  loadAppState,
  loadUiPreferences,
  readRawRecoveryData,
  resetVisitStorageForTesting,
  restoreUndoSnapshot,
  saveSpots,
  saveSpotsWithUndoAtomic,
  saveUiPreferences,
  updateDriveSyncMeta,
} from '../src/lib/visitStorage';
import type { VisitSpot } from '../src/types/visit';

function createSampleSpot(id: string, name: string): VisitSpot {
  return {
    id,
    name,
    status: 'visited',
    category: 'tourism',
    center: [2.2945, 48.8584],
    elevation: 34,
    camera: { zoom: 14, pitch: 60, bearing: 15 },
    addressSummary: 'Paris, France',
    isPinned: true,
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-15T18:00:00.000Z',
    entries: [
      {
        id: `${id}-e1`,
        kind: 'visited',
        date: { precision: 'day', start: '2026-09-12', end: '2026-09-15' },
        memo: 'エッフェル塔の夜景\nシャイヨー宮からも綺麗',
        photos: [],
        createdAt: '2026-09-12T10:00:00.000Z',
        updatedAt: '2026-09-15T18:00:00.000Z',
      },
    ],
  };
}

describe('visitStorage', () => {
  beforeEach(async () => {
    resetVisitStorageForTesting();
    localStorage.clear();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('visit3d_db');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });

  it('persists spots with From-To dates and multiline memos into IndexedDB', async () => {
    const paris = createSampleSpot('paris-1', 'エッフェル塔');
    const saveRes = await saveSpots([paris]);
    expect(saveRes.success).toBe(true);

    // Clear in-memory cache and reload from IndexedDB
    resetVisitStorageForTesting();
    const reloaded = await loadAppState();
    expect(reloaded.spots).toHaveLength(1);
    expect(reloaded.spots[0].name).toBe('エッフェル塔');
    expect(reloaded.spots[0].entries[0].date).toEqual({
      precision: 'day',
      start: '2026-09-12',
      end: '2026-09-15',
    });
    expect(reloaded.spots[0].entries[0].memo).toContain('シャイヨー宮');
  });

  it('saves atomic undo snapshot and restores pre-import spots cleanly', async () => {
    const initial = createSampleSpot('s1', '初期スポット');
    await saveSpots([initial]);

    const imported = createSampleSpot('s2', '復元スポット');
    const importRes = await saveSpotsWithUndoAtomic([imported], [initial], 'drive-restore', {
      fileId: 'drv-file-1',
      accountEmail: 'user@example.com',
    });
    expect(importRes.success).toBe(true);
    expect(importRes.state?.spots.map((s) => s.id)).toEqual(['s2']);
    expect(importRes.state?.driveSync.fileId).toBe('drv-file-1');

    const undoRes = await restoreUndoSnapshot();
    expect(undoRes.success).toBe(true);
    expect(undoRes.state?.spots.map((s) => s.id)).toEqual(['s1']);
    expect(undoRes.state?.undo).toBeNull();
  });

  it('serializes concurrent updates without losing revision progression', async () => {
    const p1 = saveSpots([createSampleSpot('a', 'A')]);
    const p2 = saveSpots([createSampleSpot('a', 'A'), createSampleSpot('b', 'B')]);
    const p3 = updateDriveSyncMeta({ accountEmail: 'test@example.com' });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r3.success).toBe(true);

    const state = await loadAppState();
    expect(state.spots).toHaveLength(2);
    expect(state.driveSync.accountEmail).toBe('test@example.com');
  });

  it('blocks writes and preserves raw data for rescue if stored record is corrupted', async () => {
    // Initialize DB then write invalid payload directly
    await loadAppState();
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('visit3d_db', 1);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('app_state', 'readwrite');
        tx.objectStore('app_state').put({ version: 1, spots: 'CORRUPTED' }, 'primary');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });

    resetVisitStorageForTesting();
    await loadAppState();
    expect(isVisitStorageBlocked()).toBe(true);
    expect(getVisitStorageWarning()).toBeTruthy();

    const blockedSave = await saveSpots([createSampleSpot('x', 'ShouldNotOverwrite')]);
    expect(blockedSave.success).toBe(false);

    const raw = (await readRawRecoveryData()) as { primary: unknown };
    expect(raw.primary).toEqual({ version: 1, spots: 'CORRUPTED' });
  });

  it('loads and saves lightweight UI preferences in localStorage only', () => {
    expect(loadUiPreferences()).toEqual({
      baseMap: 'osm',
      exaggeration: 1.5,
      statusFilter: 'all',
      prefectureFillEnabled: false,
    });

    saveUiPreferences({
      baseMap: 'photo',
      exaggeration: 2.2,
      statusFilter: 'planned',
      prefectureFillEnabled: true,
    });
    expect(loadUiPreferences()).toEqual({
      baseMap: 'photo',
      exaggeration: 2.2,
      statusFilter: 'planned',
      prefectureFillEnabled: true,
    });

    // Legacy preferences without prefectureFillEnabled should default to false
    localStorage.setItem(
      'visit3d_ui_prefs_v1',
      JSON.stringify({ baseMap: 'hillshade', exaggeration: 1.8, statusFilter: 'visited' })
    );
    expect(loadUiPreferences()).toEqual({
      baseMap: 'hillshade',
      exaggeration: 1.8,
      statusFilter: 'visited',
      prefectureFillEnabled: false,
    });
  });
});
