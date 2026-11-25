import React from 'react';
import { Blob as NodeBlob } from 'node:buffer';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportDialog } from '../src/components/ExportDialog';
import { LayerMenu } from '../src/components/LayerMenu';
import * as photoStorage from '../src/lib/photoStorage';
import type { StoredPhotoRecord, VisitSpot, WebGPUStatus } from '../src/types/visit';

const SAMPLE_GPU: WebGPUStatus = {
  backend: 'webgpu',
  webgpuAvailable: true,
  adapterInfo: 'Mock WebGPU',
  fps: 60,
};

function makeSpots(): VisitSpot[] {
  return [
    {
      id: 's1',
      name: '高尾山',
      status: 'visited',
      category: 'nature',
      center: [139.2438, 35.6251],
      elevation: 599,
      camera: { zoom: 13, pitch: 55, bearing: 0 },
      isPinned: true,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
      entries: [
        {
          id: 'e1',
          kind: 'visited',
          date: { precision: 'day', start: '2026-05-01' },
          memo: '山頂',
          photos: [
            {
              id: 'photo-1',
              fileName: 'p1.webp',
              mimeType: 'image/webp',
              width: 1000,
              height: 800,
              bytes: 100,
            },
            {
              id: 'photo-2',
              fileName: 'p2.webp',
              mimeType: 'image/webp',
              width: 1000,
              height: 800,
              bytes: 100,
            },
          ],
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      ],
    },
    {
      id: 's2',
      name: '浅草寺',
      status: 'planned',
      category: 'tourism',
      center: [139.7967, 35.7148],
      elevation: 5,
      camera: { zoom: 14, pitch: 50, bearing: 0 },
      isPinned: false,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      entries: [],
    },
  ];
}

describe('ExportDialog and LayerMenu export entrypoint', () => {
  const origCreateObjectURL = URL.createObjectURL;
  const origRevokeObjectURL = URL.revokeObjectURL;
  const origShowModal = HTMLDialogElement.prototype.showModal;
  const origClose = HTMLDialogElement.prototype.close;
  const origAnchorClick = HTMLAnchorElement.prototype.click;

  let createdUrls: string[] = [];
  let revokedUrls: string[] = [];

  beforeEach(() => {
    createdUrls = [];
    revokedUrls = [];
    let seq = 0;

    URL.createObjectURL = vi.fn(() => {
      const u = `blob:export-${++seq}`;
      createdUrls.push(u);
      return u;
    });
    URL.revokeObjectURL = vi.fn((u: string) => {
      revokedUrls.push(u);
    });
    HTMLAnchorElement.prototype.click = vi.fn();

    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
    HTMLDialogElement.prototype.showModal = origShowModal;
    HTMLDialogElement.prototype.close = origClose;
    HTMLAnchorElement.prototype.click = origAnchorClick;
  });

  it('opens ExportDialog from LayerMenu button', () => {
    const onToggleOpen = vi.fn();
    const onOpenExport = vi.fn();

    render(
      <LayerMenu
        exaggeration={1.5}
        onChangeExaggeration={vi.fn()}
        baseMap="osm"
        onChangeBaseMap={vi.fn()}
        prefectureFillEnabled={false}
        onTogglePrefectureFill={vi.fn()}
        prefectureStats={null}
        gpuStatus={SAMPLE_GPU}
        isOpen={true}
        onToggleOpen={onToggleOpen}
        onShareView={vi.fn()}
        onOpenExport={onOpenExport}
        onNavigatePolicy={vi.fn()}
      />
    );

    const btn = screen.getByRole('button', { name: /データ書き出し/ });
    fireEvent.click(btn);
    expect(onToggleOpen).toHaveBeenCalledTimes(1);
    expect(onOpenExport).toHaveBeenCalledTimes(1);
  });

  it('updates target summary when switching scope and filters and disables buttons when empty', () => {
    render(
      <ExportDialog
        isOpen={true}
        onClose={vi.fn()}
        spots={makeSpots()}
        mapStatusFilter="all"
        onLocalExportRecorded={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByTestId('export-target-summary').textContent).toContain('2 地点 / 1 件の記録 / 写真 2 枚');

    fireEvent.click(screen.getByRole('button', { name: '条件で絞り込む' }));
    fireEvent.click(screen.getByRole('button', { name: '訪問予定' }));
    expect(screen.getByTestId('export-target-summary').textContent).toContain('1 地点 / 0 件の記録 / 写真 0 枚');

    fireEvent.click(screen.getByRole('button', { name: '自然' }));
    expect(screen.getByTestId('export-target-summary').textContent).toContain('0 地点 / 0 件の記録 / 写真 0 枚');
    expect((document.getElementById('export-geojson-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('export-zip-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('downloads GeoJSON and revokes Object URL', async () => {
    vi.useFakeTimers();
    const onLocalExportRecorded = vi.fn().mockResolvedValue(undefined);

    render(
      <ExportDialog
        isOpen={true}
        onClose={vi.fn()}
        spots={makeSpots()}
        mapStatusFilter="all"
        onLocalExportRecorded={onLocalExportRecorded}
      />
    );

    await act(async () => {
      fireEvent.click(document.getElementById('export-geojson-btn')!);
      await Promise.resolve();
    });

    expect(onLocalExportRecorded).toHaveBeenCalledTimes(1);
    expect(createdUrls).toEqual(['blob:export-1']);
    expect(revokedUrls).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(revokedUrls).toEqual(['blob:export-1']);
  });

  it('shows progress, prevents double click during ZIP export, and reports missing photos', async () => {
    let resolveFirst!: (val: StoredPhotoRecord | null) => void;
    const firstPromise = new Promise<StoredPhotoRecord | null>((resolve) => {
      resolveFirst = resolve;
    });

    const getPhotoSpy = vi.spyOn(photoStorage, 'getStoredPhoto').mockImplementation(async (id) => {
      if (id === 'photo-1') return firstPromise;
      return null;
    });

    const onLocalExportRecorded = vi.fn().mockResolvedValue(undefined);

    render(
      <ExportDialog
        isOpen={true}
        onClose={vi.fn()}
        spots={makeSpots()}
        mapStatusFilter="all"
        onLocalExportRecorded={onLocalExportRecorded}
      />
    );

    const zipBtn = document.getElementById('export-zip-btn') as HTMLButtonElement;
    fireEvent.click(zipBtn);
    // Double-click while busy should not trigger a second export
    fireEvent.click(zipBtn);

    await waitFor(() => {
      expect(zipBtn.disabled).toBe(true);
      expect((document.getElementById('export-csv-btn') as HTMLButtonElement).disabled).toBe(true);
    });

    const blob = new NodeBlob(['zip-photo-1'], { type: 'image/webp' }) as unknown as Blob;
    resolveFirst({
      id: 'photo-1',
      mimeType: 'image/webp',
      width: 1000,
      height: 800,
      bytes: blob.size,
      fullBlob: blob,
      thumbnailBlob: blob,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    });

    await waitFor(() => {
      expect(onLocalExportRecorded).toHaveBeenCalledTimes(1);
    });

    expect(getPhotoSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/写真 1 枚同梱 \/ 端末未保存・欠損 1 枚をスキップ/)).toBeTruthy();
    expect(zipBtn.disabled).toBe(false);
  });
});
