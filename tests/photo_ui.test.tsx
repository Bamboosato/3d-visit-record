import React from 'react';
import { Blob as NodeBlob } from 'node:buffer';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotoLightbox } from '../src/components/PhotoLightbox';
import { SpotDetailSheet } from '../src/components/SpotDetailSheet';
import { SpotForm } from '../src/components/SpotForm';
import { SpotNavDrawer } from '../src/components/SpotNavDrawer';
import { StaticPolicyPage } from '../src/components/StaticPolicyPage';
import * as photoProcessor from '../src/lib/photoProcessor';
import { clearPhotoUrlCacheForTesting } from '../src/lib/photoUrlCache';
import { resetVisitStorageForTesting, saveSpotsWithPhotosAtomic } from '../src/lib/visitStorage';
import type { PhotoAttachment, StoredPhotoRecord, VisitSpot } from '../src/types/visit';

function makeAttachment(id: string, overrides: Partial<PhotoAttachment> = {}): PhotoAttachment {
  return {
    id,
    fileName: `${id}.webp`,
    mimeType: 'image/webp',
    width: 1600,
    height: 1200,
    bytes: 2048,
    checksumSha256: 'b'.repeat(64),
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
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
  };
}

describe('Phase 2 photo UI components', () => {
  const origCreateObjectURL = URL.createObjectURL;
  const origRevokeObjectURL = URL.revokeObjectURL;
  const origShowModal = HTMLDialogElement.prototype.showModal;
  const origClose = HTMLDialogElement.prototype.close;

  beforeEach(async () => {
    resetVisitStorageForTesting();
    clearPhotoUrlCacheForTesting();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('visit3d_db');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });

    let seq = 0;
    URL.createObjectURL = vi.fn(() => `blob:ui-mock-${++seq}`);
    URL.revokeObjectURL = vi.fn();

    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function (returnValue?: string) {
      if (returnValue !== undefined) this.returnValue = returnValue;
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    clearPhotoUrlCacheForTesting();
    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
    HTMLDialogElement.prototype.showModal = origShowModal;
    HTMLDialogElement.prototype.close = origClose;
  });

  it('supports photo attachment, EXIF date suggestion, reorder, caption sanitization, and planned-toggle preservation in SpotForm', async () => {
    const mockFull1 = new NodeBlob(['full1'], { type: 'image/webp' }) as unknown as Blob;
    const mockThumb1 = new NodeBlob(['thumb1'], { type: 'image/webp' }) as unknown as Blob;
    const mockFull2 = new NodeBlob(['full2'], { type: 'image/webp' }) as unknown as Blob;
    const mockThumb2 = new NodeBlob(['thumb2'], { type: 'image/webp' }) as unknown as Blob;

    vi.spyOn(photoProcessor, 'processPhotoFilesSerial').mockResolvedValue([
      {
        ok: true,
        result: {
          attachment: makeAttachment('new-p1', { takenAt: '2025-10-10T09:00:00+09:00' }),
          fullBlob: mockFull1,
          thumbnailBlob: mockThumb1,
          exifLocalDate: '2025-10-10',
        },
      },
      {
        ok: true,
        result: {
          attachment: makeAttachment('new-p2', { takenAt: '2025-10-12T15:30:00+09:00' }),
          fullBlob: mockFull2,
          thumbnailBlob: mockThumb2,
          exifLocalDate: '2025-10-12',
        },
      },
    ]);

    const onSubmit = vi.fn();
    const { container } = render(
      <SpotForm
        mode="create-spot"
        initialName="上高地"
        initialKind="visited"
        initialDate={{ precision: 'day', start: '2026-11-20' }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByText('写真（任意・最大 5 枚）')).toBeTruthy();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput.hasAttribute('capture')).toBe(false);

    const f1 = new File(['a'], 'a.jpg', { type: 'image/jpeg' });
    const f2 = new File(['b'], 'b.jpg', { type: 'image/jpeg' });
    fireEvent.change(fileInput, { target: { files: [f1, f2] } });

    await waitFor(() => {
      expect(screen.getByText('2 / 5')).toBeTruthy();
    });

    // EXIF date range suggestion appears and applies on click
    expect(screen.getByText(/2025\/10\/10 〜 2025\/10\/12/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '反映する' }));
    const dateInputs = container.querySelectorAll('input[type="date"]');
    expect((dateInputs[0] as HTMLInputElement).value).toBe('2025-10-10');
    expect((dateInputs[1] as HTMLInputElement).value).toBe('2025-10-12');

    // Move photo 2 to front & enter caption with surrounding spaces
    fireEvent.click(screen.getByRole('button', { name: '写真 2 を前へ移動' }));
    const captionInput = screen.getByLabelText('写真 1 のキャプション（任意）') as HTMLInputElement;
    fireEvent.change(captionInput, { target: { value: '  穂高連峰の朝焼け  ' } });

    // Toggle to planned -> photo picker hides, preservation notice appears
    fireEvent.click(screen.getByRole('button', { name: '訪問予定' }));
    expect(screen.queryByText('写真（任意・最大 5 枚）')).toBeNull();
    expect(screen.getByText(/訪問予定へ変更しても既存の添付写真（2枚）は保持されます/)).toBeTruthy();

    // Toggle back to visited, remove second photo (which is new-p1 after move), then submit
    fireEvent.click(screen.getByRole('button', { name: '訪問済み' }));
    fireEvent.click(screen.getByRole('button', { name: '写真 2 を削除' }));
    expect(screen.getByText('1 / 5')).toBeTruthy();
    expect(URL.revokeObjectURL).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '登録して保存' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    const submitted = onSubmit.mock.calls[0][0];
    expect(submitted.photos).toHaveLength(1);
    expect(submitted.photos[0].id).toBe('new-p2');
    expect(submitted.photos[0].caption).toBe('穂高連峰の朝焼け');
    expect(submitted.newPhotoRecords).toHaveLength(1);
    expect(submitted.newPhotoRecords[0].id).toBe('new-p2');
  });

  it('opens PhotoLightbox modal, switches photos via buttons and keyboard, and closes cleanly', async () => {
    const photos = [
      makeAttachment('lb-1', { caption: '一枚目', takenAt: '2025-10-10T09:30:00+09:00' }),
      makeAttachment('lb-2', { caption: '二枚目', takenAt: '2025-10-11T14:00:00+09:00' }),
    ];
    const spot: VisitSpot = {
      id: 'spot-lb',
      name: '涸沢カール',
      status: 'visited',
      category: 'nature',
      center: [137.66, 36.29],
      elevation: 2309,
      camera: { zoom: 13, pitch: 60, bearing: 0 },
      isPinned: false,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      entries: [
        {
          id: 'e-lb',
          kind: 'visited',
          date: { precision: 'day', start: '2025-10-10' },
          memo: '',
          photos,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    };

    await saveSpotsWithPhotosAtomic([spot], [makeStoredPhoto('lb-1'), makeStoredPhoto('lb-2')]);
    const onClose = vi.fn();

    const { container } = render(
      <PhotoLightbox
        isOpen={true}
        photos={photos}
        initialIndex={0}
        spotName="涸沢カール"
        onClose={onClose}
      />
    );

    const dialog = container.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.getAttribute('role')).toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBeNull();

    expect(screen.getByText('1 / 2')).toBeTruthy();
    expect(screen.getByText('2025/10/10 09:30')).toBeTruthy();
    expect(screen.getByText('一枚目')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByAltText('一枚目')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '次の写真' }));
    expect(screen.getByText('2 / 2')).toBeTruthy();
    expect(screen.getByText('二枚目')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByAltText('二枚目')).toBeTruthy();
    });

    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(screen.getByText('1 / 2')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByAltText('一枚目')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '写真を閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders entry thumbnails in SpotDetailSheet and opens PhotoLightbox when clicked', async () => {
    const photos = [
      makeAttachment('sd-1', { caption: '山頂の鳥居' }),
      makeAttachment('sd-2', { driveFileId: 'drv-remote-only' }),
    ];
    const spot: VisitSpot = {
      id: 'spot-sd',
      name: '御嶽山',
      status: 'visited',
      category: 'nature',
      center: [137.48, 35.89],
      elevation: 3067,
      camera: { zoom: 12, pitch: 55, bearing: 0 },
      isPinned: false,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      entries: [
        {
          id: 'e-sd',
          kind: 'visited',
          date: { precision: 'day', start: '2026-10-01' },
          memo: '快晴だった',
          photos,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    };

    await saveSpotsWithPhotosAtomic([spot], [makeStoredPhoto('sd-1')]);

    render(
      <SpotDetailSheet
        selectedSpot={spot}
        inspectedPoint={null}
        onClose={vi.fn()}
        onSelectExistingSpot={vi.fn()}
        onCreateSpot={vi.fn()}
        onUpdateSpotMeta={vi.fn()}
        onUpdateSpotCamera={vi.fn()}
        onDeleteSpot={vi.fn()}
        onAddEntry={vi.fn()}
        onUpdateEntry={vi.fn()}
        onDeleteEntry={vi.fn()}
        onSharePoint={vi.fn()}
        onFlyToSpot={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByAltText('山頂の鳥居')).toBeTruthy();
    });
    expect(screen.getByText('未取得')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '写真を拡大: 山頂の鳥居' }));
    await waitFor(() => {
      expect(screen.getByText('1 / 2')).toBeTruthy();
    });
    expect(screen.getByText('山頂の鳥居')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '写真を閉じる' }));
  });

  it('shows local cover thumbnails & photo count badges in SpotNavDrawer without network calls, and filters by caption', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const localSpot: VisitSpot = {
      id: 'spot-1',
      name: '上高地',
      status: 'visited',
      category: 'nature',
      center: [137.638, 36.248],
      elevation: 1505,
      camera: { zoom: 12, pitch: 55, bearing: 0 },
      isPinned: false,
      createdAt: '2026-10-10T00:00:00.000Z',
      updatedAt: '2026-10-12T00:00:00.000Z',
      entries: [
        {
          id: 'e1',
          kind: 'visited',
          date: { precision: 'day', start: '2026-10-10' },
          memo: '秋晴れ',
          photos: [
            makeAttachment('cached-1', { caption: '明神池の朝' }),
            makeAttachment('cached-2', { caption: '河童橋' }),
          ],
          createdAt: '2026-10-10T00:00:00.000Z',
          updatedAt: '2026-10-12T00:00:00.000Z',
        },
      ],
    };

    const remoteUncachedSpot: VisitSpot = {
      id: 'spot-2',
      name: '白馬岳',
      status: 'visited',
      category: 'nature',
      center: [137.758, 36.758],
      elevation: 2932,
      camera: { zoom: 12, pitch: 55, bearing: 0 },
      isPinned: false,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      entries: [
        {
          id: 'e2',
          kind: 'visited',
          date: { precision: 'day', start: '2026-10-01' },
          memo: '山頂山荘',
          photos: [makeAttachment('uncached-remote-1', { driveFileId: 'drv-r1', caption: '雲海' })],
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    };

    await saveSpotsWithPhotosAtomic(
      [localSpot, remoteUncachedSpot],
      [makeStoredPhoto('cached-1'), makeStoredPhoto('cached-2')]
    );

    render(
      <SpotNavDrawer
        isOpen={true}
        onClose={vi.fn()}
        spots={[localSpot, remoteUncachedSpot]}
        onSelectSpot={vi.fn()}
        onSelectSearchLocation={vi.fn()}
        onSelectMountain={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByAltText('上高地')).toBeTruthy();
    });

    expect(screen.queryByAltText('白馬岳')).toBeNull();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();

    // Filter by photo caption
    const filterInput = screen.getByLabelText('地点名・住所・メモ・写真キャプションで絞り込み');
    fireEvent.change(filterInput, { target: { value: '明神池' } });

    expect(screen.getByText('上高地')).toBeTruthy();
    expect(screen.queryByText('白馬岳')).toBeNull();
  });

  it('documents client-side photo compression, EXIF stripping, Drive photos folder, and share URL exclusion on privacy page', () => {
    render(<StaticPolicyPage page="privacy" />);

    expect(screen.getByText(/リサイズ・圧縮および EXIF 除去処理/)).toBeTruthy();
    expect(screen.getByText('3D Visit Record/photos/')).toBeTruthy();
    expect(screen.getByText(/GPS 位置情報や撮影機種情報等の EXIF メタデータが再エンコードにより自動的に除去/)).toBeTruthy();
    expect(screen.getByText(/写真・キャプション等の個人記録は一切含めません/)).toBeTruthy();
  });
});
