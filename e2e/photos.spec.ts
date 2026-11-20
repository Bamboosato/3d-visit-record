import { expect, test, type Page } from '@playwright/test';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

interface FakeStoredDrivePhoto {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size: number;
  trashed: boolean;
  appProperties: Record<string, string>;
  data: Buffer;
}

interface FakeDriveState {
  counter: number;
  modifiedSeq: number;
  rootFolderId: string | null;
  photosFolderId: string | null;
  snapshotsFolderId: string | null;
  recordsFile: {
    id: string;
    name: string;
    modifiedTime: string;
    headRevisionId: string;
    content: string;
  } | null;
  photoFiles: Map<string, FakeStoredDrivePhoto>;
  uploadedPhotoIds: string[];
  trashedPhotoIds: string[];
  photoDownloadLog: string[];
  snapshots: Array<{ id: string; name: string; content: string }>;
}

function createFakeDriveState(): FakeDriveState {
  return {
    counter: 1,
    modifiedSeq: 1,
    rootFolderId: null,
    photosFolderId: null,
    snapshotsFolderId: null,
    recordsFile: null,
    photoFiles: new Map(),
    uploadedPhotoIds: [],
    trashedPhotoIds: [],
    photoDownloadLog: [],
    snapshots: [],
  };
}

function parseMultipartRelated(
  contentTypeHeader: string,
  rawBuf: Buffer
): { metadata: Record<string, unknown>; payload: Buffer } {
  const match = /boundary=([^;\s]+)/i.exec(contentTypeHeader);
  if (!match) {
    throw new Error(`Missing multipart boundary in header: ${contentTypeHeader}`);
  }
  const boundary = match[1].replace(/^"|"$/g, '');
  const marker = Buffer.from(`--${boundary}`);
  const headerSep = Buffer.from('\r\n\r\n');

  const firstMarkerPos = rawBuf.indexOf(marker);
  if (firstMarkerPos < 0) {
    throw new Error('First multipart boundary not found');
  }
  const part1HeadersEnd = rawBuf.indexOf(headerSep, firstMarkerPos + marker.length);
  if (part1HeadersEnd < 0) {
    throw new Error('Part 1 headers terminator not found');
  }

  const crlfMarker = Buffer.from(`\r\n--${boundary}`);
  const secondMarkerPos = rawBuf.indexOf(crlfMarker, part1HeadersEnd + headerSep.length);
  if (secondMarkerPos < 0) {
    throw new Error('Second multipart boundary not found');
  }

  const part1Body = rawBuf.subarray(part1HeadersEnd + headerSep.length, secondMarkerPos).toString('utf8');
  const metadata = JSON.parse(part1Body) as Record<string, unknown>;

  const part2HeadersEnd = rawBuf.indexOf(headerSep, secondMarkerPos + crlfMarker.length);
  if (part2HeadersEnd < 0) {
    throw new Error('Part 2 headers terminator not found');
  }

  let endPos = rawBuf.indexOf(crlfMarker, part2HeadersEnd + headerSep.length);
  if (endPos < 0) {
    endPos = rawBuf.indexOf(marker, part2HeadersEnd + headerSep.length);
  }
  if (endPos < 0) {
    throw new Error('Closing multipart boundary not found');
  }

  const payload = Buffer.from(rawBuf.subarray(part2HeadersEnd + headerSep.length, endPos));
  return { metadata, payload };
}

function buildExifApp1Segment(dateTimeOriginal: string, includeGps = true): Buffer {
  const tiff = Buffer.alloc(512, 0);
  // Big-endian TIFF header ("MM" 0x002A, IFD0 offset 8)
  tiff[0] = 0x4d;
  tiff[1] = 0x4d;
  tiff.writeUInt16BE(0x002a, 2);
  tiff.writeUInt32BE(8, 4);

  const dateAscii = `${dateTimeOriginal}\0`;
  const ifd0Start = 8;
  const ifd0Entries: Array<{ tag: number; type: number; count: number; valueOrOffset: number }> = [];

  if (includeGps) {
    // 0x8825 GPSInfoIFDPointer -> offset 320, also write literal GPS signature so tests prove stripping
    ifd0Entries.push({ tag: 0x8825, type: 4, count: 1, valueOrOffset: 320 });
    tiff.writeUInt16BE(1, 320); // GPS tag count
    tiff.writeUInt16BE(0x0001, 322); // GPSLatitudeRef
    tiff.writeUInt16BE(2, 324); // ASCII
    tiff.writeUInt32BE(2, 326);
    tiff.write('N\0', 328, 'ascii');
    tiff.write('GPS', 350, 'ascii');
  }

  const ifd0Count = ifd0Entries.length + 1; // + ExifIFDPointer (0x8769)
  const exifIfdStart = ifd0Start + 2 + ifd0Count * 12 + 4;
  ifd0Entries.push({ tag: 0x8769, type: 4, count: 1, valueOrOffset: exifIfdStart });

  tiff.writeUInt16BE(ifd0Entries.length, ifd0Start);
  ifd0Entries.forEach((entry, idx) => {
    const pos = ifd0Start + 2 + idx * 12;
    tiff.writeUInt16BE(entry.tag, pos);
    tiff.writeUInt16BE(entry.type, pos + 2);
    tiff.writeUInt32BE(entry.count, pos + 4);
    tiff.writeUInt32BE(entry.valueOrOffset, pos + 8);
  });

  // ExifIFD with DateTimeOriginal (0x9003)
  tiff.writeUInt16BE(1, exifIfdStart);
  const exifEntryPos = exifIfdStart + 2;
  const dateDataOffset = exifIfdStart + 2 + 12 + 4;
  tiff.writeUInt16BE(0x9003, exifEntryPos);
  tiff.writeUInt16BE(2, exifEntryPos + 2);
  tiff.writeUInt32BE(dateAscii.length, exifEntryPos + 4);
  tiff.writeUInt32BE(dateDataOffset, exifEntryPos + 8);
  tiff.write(dateAscii, dateDataOffset, 'ascii');

  const trimmedTiff = tiff.subarray(0, 384);
  const segLen = 2 + 6 + trimmedTiff.length;
  const app1 = Buffer.alloc(2 + segLen);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(segLen, 2);
  app1.write('Exif', 4, 'ascii');
  app1[8] = 0;
  app1[9] = 0;
  trimmedTiff.copy(app1, 10);
  return app1;
}

async function createBrowserJpegWithExif(
  page: Page,
  width: number,
  height: number,
  fillColor: string,
  dateTimeOriginal: string,
  includeGps = true
): Promise<Buffer> {
  const base64 = await page.evaluate(
    ({ w, h, color }) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(Math.round(w * 0.2), Math.round(h * 0.2), Math.round(w * 0.4), Math.round(h * 0.3));
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      return dataUrl.split(',')[1];
    },
    { w: width, h: height, color: fillColor }
  );
  const rawJpeg = Buffer.from(base64, 'base64');
  if (rawJpeg[0] !== 0xff || rawJpeg[1] !== 0xd8) {
    throw new Error('Generated canvas buffer is not a valid JPEG');
  }
  const app1 = buildExifApp1Segment(dateTimeOriginal, includeGps);
  return Buffer.concat([rawJpeg.subarray(0, 2), app1, rawJpeg.subarray(2)]);
}

async function createBrowserPng(
  page: Page,
  width: number,
  height: number,
  fillColor: string
): Promise<Buffer> {
  const base64 = await page.evaluate(
    ({ w, h, color }) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, Math.min(w, h) / 4, 0, Math.PI * 2);
      ctx.fill();
      return canvas.toDataURL('image/png').split(',')[1];
    },
    { w: width, h: height, color: fillColor }
  );
  return Buffer.from(base64, 'base64');
}

async function installPageMocks(page: Page, driveState: FakeDriveState): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__VISIT3D_GOOGLE_CLIENT_ID__ =
      'e2e-test-client-id';
    (window as unknown as Record<string, unknown>).google = {
      accounts: {
        oauth2: {
          initTokenClient: (cfg: {
            callback: (r: { access_token: string; expires_in: number }) => void;
          }) => ({
            requestAccessToken: () => {
              cfg.callback({ access_token: 'e2e-mock-token', expires_in: 3600 });
            },
          }),
          revoke: (_token: string, done?: () => void) => done?.(),
        },
      },
    };
  });

  await page.route('https://tile.openstreetmap.org/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(TINY_PNG_BASE64, 'base64'),
    });
  });
  await page.route('https://server.arcgisonline.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(TINY_PNG_BASE64, 'base64'),
    });
  });
  await page.route('https://cyberjapandata.gsi.go.jp/**', async (route) => {
    await route.fulfill({ status: 404, body: '' });
  });
  await page.route('https://data.earth.jaxa.jp/**', async (route) => {
    await route.abort();
  });
  await page.route('https://s3.ap-northeast-1.wasabisys.com/**', async (route) => {
    await route.abort();
  });
  await page.route('https://overpass-api.de/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"elements":[]}' });
  });
  await page.route('https://overpass.kumi.systems/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"elements":[]}' });
  });
  await page.route('https://msearch.gsi.go.jp/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('https://nominatim.openstreetmap.org/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/search')) {
      const q = (new URL(url).searchParams.get('q') ?? '').toLowerCase();
      if (q.includes('hakuba')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              place_id: 9102,
              lat: '36.7580',
              lon: '137.7580',
              name: '白馬岳',
              category: 'natural',
              type: 'peak',
              address: { city: 'Hakuba', country: 'Japan', country_code: 'jp' },
            },
          ]),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            place_id: 9101,
            lat: '36.2480',
            lon: '137.6380',
            name: '上高地',
            category: 'tourism',
            type: 'attraction',
            address: { city: 'Matsumoto', country: 'Japan', country_code: 'jp' },
          },
        ]),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        name: '長野県松本市',
        address: { city: 'Matsumoto', country: 'Japan', country_code: 'jp' },
      }),
    });
  });

  await page.route('https://www.googleapis.com/**', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();

    if (url.includes('/drive/v3/about')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { displayName: 'E2E Photo User', emailAddress: 'photo-e2e@example.com' },
        }),
      });
      return;
    }

    if (url.includes('/upload/drive/v3/files')) {
      const rawBuf = req.postDataBuffer() ?? Buffer.alloc(0);
      const ct = req.headers()['content-type'] ?? '';
      const { metadata, payload } = parseMultipartRelated(ct, rawBuf);
      const appProps = (metadata.appProperties as Record<string, string> | undefined) ?? {};
      const seq = driveState.modifiedSeq++;
      const mod = `2026-11-20T10:${String(seq).padStart(2, '0')}:00.000Z`;

      if (appProps.role === 'photo') {
        const photoId = `drv-photo-${driveState.counter++}`;
        const mimeType = typeof metadata.mimeType === 'string' ? metadata.mimeType : 'image/webp';
        const name = typeof metadata.name === 'string' ? metadata.name : `${photoId}.webp`;
        const entry: FakeStoredDrivePhoto = {
          id: photoId,
          name,
          mimeType,
          modifiedTime: mod,
          size: payload.byteLength,
          trashed: false,
          appProperties: appProps,
          data: payload,
        };
        driveState.photoFiles.set(photoId, entry);
        driveState.uploadedPhotoIds.push(photoId);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: entry.id,
            name: entry.name,
            modifiedTime: entry.modifiedTime,
            size: String(entry.size),
            appProperties: entry.appProperties,
          }),
        });
        return;
      }

      const jsonText = payload.toString('utf8');
      const rev = `rev-${seq}`;
      if (method === 'POST' || !driveState.recordsFile) {
        driveState.recordsFile = {
          id: `file-${driveState.counter++}`,
          name: 'visit-records.json',
          modifiedTime: mod,
          headRevisionId: rev,
          content: jsonText,
        };
      } else {
        driveState.recordsFile = {
          ...driveState.recordsFile,
          modifiedTime: mod,
          headRevisionId: rev,
          content: jsonText,
        };
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: driveState.recordsFile.id,
          name: driveState.recordsFile.name,
          modifiedTime: driveState.recordsFile.modifiedTime,
          headRevisionId: driveState.recordsFile.headRevisionId,
          size: String(Buffer.byteLength(jsonText, 'utf8')),
        }),
      });
      return;
    }

    if (method === 'GET' && url.includes('/drive/v3/files?')) {
      const q = new URL(url).searchParams.get('q') ?? '';
      if (q.includes("role' and value='root'")) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            files: driveState.rootFolderId
              ? [{ id: driveState.rootFolderId, name: '3D Visit Record' }]
              : [],
          }),
        });
        return;
      }
      if (q.includes("role' and value='photos'")) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            files: driveState.photosFolderId
              ? [{ id: driveState.photosFolderId, name: 'photos' }]
              : [],
          }),
        });
        return;
      }
      if (q.includes("role' and value='records'")) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            files: driveState.recordsFile
              ? [
                  {
                    id: driveState.recordsFile.id,
                    name: driveState.recordsFile.name,
                    modifiedTime: driveState.recordsFile.modifiedTime,
                    headRevisionId: driveState.recordsFile.headRevisionId,
                  },
                ]
              : [],
          }),
        });
        return;
      }
      if (q.includes("role' and value='photo'")) {
        const activePhotos = [...driveState.photoFiles.values()]
          .filter((p) => !p.trashed)
          .map((p) => ({
            id: p.id,
            name: p.name,
            modifiedTime: p.modifiedTime,
            size: String(p.size),
            trashed: false,
            appProperties: p.appProperties,
          }));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ files: activePhotos }),
        });
        return;
      }
      if (q.includes("role' and value='snapshots'")) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            files: driveState.snapshotsFolderId
              ? [{ id: driveState.snapshotsFolderId, name: 'snapshots' }]
              : [],
          }),
        });
        return;
      }
      if (q.includes("role' and value='snapshot'")) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ files: driveState.snapshots }),
        });
        return;
      }
    }

    if (method === 'PATCH' && url.includes('/drive/v3/files/')) {
      const idMatch = /\/drive\/v3\/files\/([^?]+)/.exec(url);
      const fileId = idMatch?.[1] ?? '';
      const patch = req.postDataJSON() as { trashed?: boolean } | null;
      const photoFile = driveState.photoFiles.get(fileId);
      if (photoFile && patch?.trashed) {
        photoFile.trashed = true;
        driveState.trashedPhotoIds.push(fileId);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: fileId, trashed: true }),
        });
        return;
      }
      await route.fulfill({ status: 404, body: '{}' });
      return;
    }

    if (method === 'GET' && url.includes('/drive/v3/files/')) {
      const idMatch = /\/drive\/v3\/files\/([^?]+)/.exec(url);
      const fileId = idMatch?.[1] ?? '';

      if (fileId === driveState.rootFolderId) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: fileId, name: '3D Visit Record', trashed: false }),
        });
        return;
      }
      if (fileId === driveState.photosFolderId) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: fileId, name: 'photos', trashed: false }),
        });
        return;
      }
      if (driveState.recordsFile && fileId === driveState.recordsFile.id) {
        if (url.includes('alt=media')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: driveState.recordsFile.content,
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: driveState.recordsFile.id,
            name: driveState.recordsFile.name,
            modifiedTime: driveState.recordsFile.modifiedTime,
            headRevisionId: driveState.recordsFile.headRevisionId,
            trashed: false,
          }),
        });
        return;
      }

      const photoFile = driveState.photoFiles.get(fileId);
      if (photoFile && !photoFile.trashed) {
        if (url.includes('alt=media')) {
          driveState.photoDownloadLog.push(fileId);
          await route.fulfill({
            status: 200,
            contentType: photoFile.mimeType,
            body: photoFile.data,
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: photoFile.id,
            name: photoFile.name,
            modifiedTime: photoFile.modifiedTime,
            size: String(photoFile.size),
            trashed: false,
            appProperties: photoFile.appProperties,
          }),
        });
        return;
      }

      await route.fulfill({ status: 404, body: '{}' });
      return;
    }

    if (method === 'POST' && url.includes('/copy?')) {
      const snapId = `snap-${driveState.counter++}`;
      driveState.snapshots.unshift({
        id: snapId,
        name: `${snapId}.json`,
        content: driveState.recordsFile?.content ?? '',
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: snapId }),
      });
      return;
    }

    if (method === 'POST' && url.includes('/drive/v3/files?fields=id')) {
      const meta = req.postDataJSON() as { appProperties?: { role?: string } };
      const id = `folder-${driveState.counter++}`;
      if (meta.appProperties?.role === 'root') driveState.rootFolderId = id;
      if (meta.appProperties?.role === 'photos') driveState.photosFolderId = id;
      if (meta.appProperties?.role === 'snapshots') driveState.snapshotsFolderId = id;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id }),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

async function assertImageLoaded(locator: ReturnType<Page['locator']>): Promise<void> {
  await expect(locator).toBeVisible();
  await expect
    .poll(async () => locator.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
}

test.describe('3D Visit Record v2.0 Photo E2E flows', () => {
  test('full photo lifecycle: EXIF attach, reorder, reload, lightbox, limits, Drive upload/trash, cross-device lazy/bulk DL, v2 deletion/Undo, share URL & privacy', async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    const driveState = createFakeDriveState();
    await installPageMocks(page, driveState);

    await page.goto('/');
    await expect(page.locator('#visit-map-container')).toBeVisible();

    // Generate binary fixtures directly in browser Canvas (+ EXIF APP1 + GPS tag on JPEGs)
    const exifJpegLarge = await createBrowserJpegWithExif(
      page,
      2000,
      1200,
      '#0284c7',
      '2026:08:15 09:30:00',
      true
    );
    const exifJpegSmall = await createBrowserJpegWithExif(
      page,
      600,
      400,
      '#059669',
      '2026:08:17 14:20:00',
      true
    );
    expect(exifJpegLarge.includes(Buffer.from('Exif'))).toBe(true);
    expect(exifJpegLarge.includes(Buffer.from('GPS'))).toBe(true);

    // 1. Search Kamikochi -> register visited with 2 EXIF photos -> apply suggested date -> caption & reorder -> save
    await page.locator('#nav-toggle-btn').click();
    await page.locator('#nav-tab-search').click();
    await page.locator('#global-place-search-input').fill('Kamikochi');
    await page.locator('#global-place-search-submit').click();
    await page.getByRole('button', { name: /上高地/ }).click();

    await page.locator('#btn-register-visited').click();
    const photoInput = page.locator('input[type="file"][accept="image/*"]');
    await photoInput.setInputFiles([
      { name: 'kamikochi-1.jpg', mimeType: 'image/jpeg', buffer: exifJpegLarge },
      { name: 'kamikochi-2.jpg', mimeType: 'image/jpeg', buffer: exifJpegSmall },
    ]);

    await expect(page.getByText('2 / 5')).toBeVisible();
    await expect(page.getByText('2026/08/15 〜 2026/08/17')).toBeVisible();
    await page.getByRole('button', { name: '反映する' }).click();

    await page.getByLabel(/写真 1 のキャプション/).fill('河童橋の朝');
    await page.getByRole('button', { name: '写真 2 を選択' }).click();
    await page.getByLabel(/写真 2 のキャプション/).fill('明神池');
    await page.getByRole('button', { name: '写真 2 を前へ移動' }).click();

    await page.getByRole('button', { name: '登録して保存' }).click();

    const detailSheet = page.locator('section[aria-label="地点詳細シート"]');
    await expect(detailSheet.getByText('2026/08/15 〜 2026/08/17')).toBeVisible();
    await expect(detailSheet.locator('img')).toHaveCount(2);
    await assertImageLoaded(detailSheet.locator('img').nth(0));
    await assertImageLoaded(detailSheet.locator('img').nth(1));

    // Reload browser and verify IndexedDB persistence, drawer cover photo, badge, & caption filter
    await page.reload();
    await expect(page.locator('#status-filter-visited')).toContainText('1');

    await page.locator('#nav-toggle-btn').click();
    const drawer = page.locator('[aria-label="地点一覧・検索ナビゲーション"]');
    const kamikochiCard = drawer.getByRole('button', { name: /上高地/ });
    await assertImageLoaded(kamikochiCard.locator('img[alt="上高地"]'));
    await expect(kamikochiCard.getByText('2', { exact: true })).toBeVisible();

    const filterInput = drawer.getByLabel('地点名・住所・メモ・写真キャプションで絞り込み');
    await filterInput.fill('河童橋');
    await expect(drawer.getByRole('button', { name: /上高地/ })).toBeVisible();
    await filterInput.fill('存在しないキャプション');
    await expect(drawer.getByRole('button', { name: /上高地/ })).toHaveCount(0);
    await filterInput.fill('');
    await drawer.getByRole('button', { name: /上高地/ }).click();

    // 2. Lightbox inspection, ArrowRight/ArrowLeft navigation, and Escape close
    await detailSheet.getByRole('button', { name: '写真を拡大: 明神池' }).click();
    const lightbox = page.locator('dialog.visit-lightbox[open]');
    await expect(lightbox).toBeVisible();
    await expect(lightbox.getByText('1 / 2')).toBeVisible();
    await expect(lightbox.getByText('明神池')).toBeVisible();
    await assertImageLoaded(lightbox.locator('img'));

    await page.keyboard.press('ArrowRight');
    await expect(lightbox.getByText('2 / 2')).toBeVisible();
    await expect(lightbox.getByText('河童橋の朝')).toBeVisible();

    await page.keyboard.press('ArrowLeft');
    await expect(lightbox.getByText('1 / 2')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('dialog.visit-lightbox[open]')).toHaveCount(0);

    // 3. SVG rejection and 5-photo limit enforcement in edit form
    await detailSheet.getByRole('button', { name: '記録を編集' }).click();
    await photoInput.setInputFiles({
      name: 'evil.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8'),
    });
    await expect(detailSheet.getByRole('alert')).toContainText('SVG');
    await expect(detailSheet.getByText('2 / 5')).toBeVisible();

    const extraPng1 = await createBrowserPng(page, 200, 150, '#7c3aed');
    const extraPng2 = await createBrowserPng(page, 200, 150, '#db2777');
    const extraPng3 = await createBrowserPng(page, 200, 150, '#ea580c');
    const extraPng4 = await createBrowserPng(page, 200, 150, '#16a34a');
    await photoInput.setInputFiles([
      { name: 'extra-1.png', mimeType: 'image/png', buffer: extraPng1 },
      { name: 'extra-2.png', mimeType: 'image/png', buffer: extraPng2 },
      { name: 'extra-3.png', mimeType: 'image/png', buffer: extraPng3 },
      { name: 'extra-4.png', mimeType: 'image/png', buffer: extraPng4 },
    ]);
    await expect(
      detailSheet.getByText('1ログ最大 5 枚までのため、先頭 3 枚のみ処理しました。')
    ).toBeVisible();
    await expect(detailSheet.getByText('5 / 5')).toBeVisible();
    await expect(detailSheet.getByRole('button', { name: /上限（5枚）に達しました/ })).toBeDisabled();
    await detailSheet.getByRole('button', { name: 'キャンセル' }).click();

    // 4. Upload to Drive -> verify EXIF stripped, width<=1600, JSON metadata notice -> delete 1 photo -> auto-trash
    await page.locator('#cloud-sync-open-btn').click();
    const syncDialog = page.locator('#cloud-sync-dialog');
    await expect(syncDialog.getByText(/写真キャッシュ: 端末に 2 枚保存中/)).toBeVisible();

    await syncDialog.locator('summary', { hasText: 'ローカル JSON バックアップ' }).click();
    await expect(syncDialog.getByText(/写真ファイル本体は JSON には含まれません/)).toBeVisible();

    await page.locator('#drive-save-btn').click();
    await expect(syncDialog.getByText(/写真アップロード 2枚/)).toBeVisible();

    expect(driveState.photosFolderId).not.toBeNull();
    expect(driveState.photoFiles.size).toBe(2);
    for (const storedPhoto of driveState.photoFiles.values()) {
      expect(storedPhoto.data.byteLength).toBeGreaterThan(0);
      expect(storedPhoto.data.includes(Buffer.from('Exif'))).toBe(false);
      expect(storedPhoto.data.includes(Buffer.from('GPS'))).toBe(false);
    }

    const uploadedEnvelope = JSON.parse(driveState.recordsFile!.content) as {
      schemaVersion: number;
      photoSyncVersion: number;
      items: Array<{
        name: string;
        entries: Array<{
          photos: Array<{ width: number; height: number; driveFileId?: string }>;
        }>;
      }>;
    };
    expect(uploadedEnvelope.schemaVersion).toBe(1);
    expect(uploadedEnvelope.photoSyncVersion).toBe(2);
    const savedKamikochiPhotos = uploadedEnvelope.items[0].entries[0].photos;
    expect(savedKamikochiPhotos).toHaveLength(2);
    for (const meta of savedKamikochiPhotos) {
      expect(meta.driveFileId).toBeTruthy();
      expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(1600);
    }

    await syncDialog.locator('button[aria-label="閉じる"]').click();

    // Delete photo 2 ("河童橋の朝") and re-save -> Drive should auto-trash 1 unreferenced file
    await detailSheet.getByRole('button', { name: '記録を編集' }).click();
    await detailSheet.getByRole('button', { name: '写真 2 を削除' }).click();
    await detailSheet.getByRole('button', { name: '記録を更新' }).click();
    await expect(detailSheet.getByRole('button', { name: '記録を編集' })).toBeVisible();

    await page.locator('#cloud-sync-open-btn').click();
    await page.locator('#drive-save-btn').click();
    await expect(syncDialog.getByText(/旧写真ゴミ箱整理 1枚/)).toBeVisible();
    expect(driveState.trashedPhotoIds).toHaveLength(1);
    expect([...driveState.photoFiles.values()].filter((p) => !p.trashed)).toHaveLength(1);
    await syncDialog.locator('button[aria-label="閉じる"]').click();

    // 5. Add a 2nd spot ("白馬岳") with 1 photo & save so Drive holds 2 spots with 1 active photo each
    const hakubaPng = await createBrowserPng(page, 400, 300, '#2563eb');
    await page.locator('#nav-toggle-btn').click();
    await page.locator('#nav-tab-search').click();
    await page.locator('#global-place-search-input').fill('Hakuba');
    await page.locator('#global-place-search-submit').click();
    await page.getByRole('button', { name: /白馬岳/ }).click();

    await page.locator('#btn-register-visited').click();
    await photoInput.setInputFiles({
      name: 'hakuba.png',
      mimeType: 'image/png',
      buffer: hakubaPng,
    });
    await expect(page.getByText('1 / 5')).toBeVisible();
    await page.getByLabel(/写真 1 のキャプション/).fill('大雪渓');
    await page.getByRole('button', { name: '登録して保存' }).click();
    await assertImageLoaded(detailSheet.locator('img[alt="大雪渓"]'));

    await page.locator('#cloud-sync-open-btn').click();
    await page.locator('#drive-save-btn').click();
    await expect(syncDialog.getByText(/写真アップロード 1枚/)).toBeVisible();
    await syncDialog.locator('button[aria-label="閉じる"]').click();

    // 6. Device B (fresh IDB) restores from Drive: metadata-only first -> list zero DL -> on-demand DL -> bulk DL
    const deviceBContext = await browser.newContext();
    const deviceBPage = await deviceBContext.newPage();
    await installPageMocks(deviceBPage, driveState);
    driveState.photoDownloadLog.length = 0;

    await deviceBPage.goto('/');
    await expect(deviceBPage.locator('#visit-map-container')).toBeVisible();
    await deviceBPage.locator('#cloud-sync-open-btn').click();
    const syncDialogB = deviceBPage.locator('#cloud-sync-dialog');
    await deviceBPage.locator('#drive-restore-btn').click();
    await expect(syncDialogB.getByText('追加 +2枚')).toBeVisible();
    await deviceBPage.locator('#confirm-import-btn').click();

    const bulkBtnB = deviceBPage.locator('#drive-download-all-photos-btn');
    await expect(bulkBtnB).toBeVisible();
    await expect(bulkBtnB).toContainText('残り 2 枚');
    expect(driveState.photoDownloadLog).toHaveLength(0);
    await syncDialogB.locator('button[aria-label="閉じる"]').click();

    // Nav drawer must not download photos automatically
    await deviceBPage.locator('#nav-toggle-btn').click();
    const drawerB = deviceBPage.locator('[aria-label="地点一覧・検索ナビゲーション"]');
    await expect(drawerB.locator('img[alt="上高地"]')).toHaveCount(0);
    await expect(drawerB.getByRole('button', { name: /上高地/ }).getByText('1', { exact: true })).toBeVisible();
    await expect(drawerB.getByRole('button', { name: /白馬岳/ }).getByText('1', { exact: true })).toBeVisible();
    expect(driveState.photoDownloadLog).toHaveLength(0);

    // Selecting 上高地 fetches its photo on demand
    await drawerB.getByRole('button', { name: /上高地/ }).click();
    const detailSheetB = deviceBPage.locator('section[aria-label="地点詳細シート"]');
    await assertImageLoaded(detailSheetB.locator('img[alt="明神池"]'));
    expect(driveState.photoDownloadLog).toHaveLength(1);

    // Remaining 1 photo ("大雪渓") can be bulk-downloaded via CloudSyncDialog
    await deviceBPage.locator('#cloud-sync-open-btn').click();
    await expect(bulkBtnB).toContainText('残り 1 枚');
    await bulkBtnB.click();
    await expect(syncDialogB.getByText(/1 枚の写真を端末にキャッシュしました/)).toBeVisible();
    await expect(syncDialogB.getByText(/写真キャッシュ: 端末に 2 枚保存中/)).toBeVisible();
    await expect(bulkBtnB).toHaveCount(0);
    expect(driveState.photoDownloadLog).toHaveLength(2);
    await syncDialogB.locator('button[aria-label="閉じる"]').click();

    // 7. Device A deletes last photo on 上高地 & saves v2 -> Device B merges deletion -> Undo resurrects locally
    await page.locator('#nav-toggle-btn').click();
    await page.locator('#nav-tab-spots').click();
    await page.locator('[aria-label="地点一覧・検索ナビゲーション"]').getByRole('button', { name: /上高地/ }).click();
    await page.waitForTimeout(30);
    await detailSheet.getByRole('button', { name: '記録を編集' }).click();
    await detailSheet.getByRole('button', { name: '写真 1 を削除' }).click();
    await detailSheet.getByRole('button', { name: '記録を更新' }).click();
    await expect(detailSheet.getByRole('button', { name: '記録を編集' })).toBeVisible();

    await page.locator('#cloud-sync-open-btn').click();
    await page.locator('#drive-save-btn').click();
    await expect(syncDialog.getByText(/旧写真ゴミ箱整理 1枚/)).toBeVisible();
    await syncDialog.locator('button[aria-label="閉じる"]').click();

    await deviceBPage.locator('#cloud-sync-open-btn').click();
    await deviceBPage.locator('#drive-restore-btn').click();
    await expect(syncDialogB.getByText('削除 -1枚')).toBeVisible();
    await deviceBPage.locator('#confirm-import-btn').click();
    await syncDialogB.locator('button[aria-label="閉じる"]').click();

    await expect(detailSheetB.locator('img[alt="明神池"]')).toHaveCount(0);

    // Undo restores the deleted photo directly from local IndexedDB (0 Drive downloads)
    driveState.photoDownloadLog.length = 0;
    await deviceBPage.locator('#cloud-sync-open-btn').click();
    await deviceBPage.locator('#undo-restore-btn').click();
    await expect(syncDialogB.getByText('復元・取り込み直前の状態に戻しました。')).toBeVisible();
    await syncDialogB.locator('button[aria-label="閉じる"]').click();

    await assertImageLoaded(detailSheetB.locator('img[alt="明神池"]'));
    expect(driveState.photoDownloadLog).toHaveLength(0);

    // 8. Share URL omits photo metadata & /privacy documents v2 photo handling
    await deviceBPage.evaluate(() => {
      (window as unknown as Record<string, string | null>).__copiedShareUrl = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (window as unknown as Record<string, string>).__copiedShareUrl = text;
          },
        },
      });
    });
    await detailSheetB.getByRole('button', { name: '共有', exact: true }).click();
    await expect
      .poll(async () =>
        deviceBPage.evaluate(() => (window as unknown as Record<string, string | null>).__copiedShareUrl)
      )
      .not.toBeNull();
    const copiedShareUrl = await deviceBPage.evaluate(
      () => (window as unknown as Record<string, string>).__copiedShareUrl
    );
    const parsedShareUrl = new URL(copiedShareUrl);
    expect(parsedShareUrl.searchParams.get('lat')).toBeTruthy();
    expect(parsedShareUrl.searchParams.get('lng')).toBeTruthy();
    expect(parsedShareUrl.searchParams.get('z')).toBeTruthy();
    expect(parsedShareUrl.searchParams.get('p')).toBeTruthy();
    expect(parsedShareUrl.searchParams.get('b')).toBeTruthy();
    expect(parsedShareUrl.searchParams.get('name')).toBe('上高地');
    expect([...parsedShareUrl.searchParams.keys()].sort()).toEqual(['b', 'lat', 'lng', 'name', 'p', 'z']);
    expect(copiedShareUrl).not.toContain('photo');
    expect(copiedShareUrl).not.toContain('driveFileId');
    expect(copiedShareUrl).not.toContain('明神池');

    await deviceBPage.goto('/privacy');
    await expect(deviceBPage.getByText(/リサイズ・圧縮および EXIF 除去処理/)).toBeVisible();
    await expect(deviceBPage.getByText('3D Visit Record/photos/')).toBeVisible();
    await expect(deviceBPage.getByText(/GPS 位置情報や撮影機種情報等/)).toBeVisible();
    await expect(deviceBPage.getByText(/写真・キャプション等の個人記録は一切含めません/)).toBeVisible();

    await deviceBContext.close();
  });

  test('mobile viewport (390x844) layout, 16px caption input font, no capture attr, and >=44px Lightbox touch targets', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const driveState = createFakeDriveState();
    await installPageMocks(page, driveState);

    await page.goto('/');
    await expect(page.locator('#visit-map-container')).toBeVisible();

    await page.locator('#nav-toggle-btn').click();
    await page.locator('#nav-tab-search').click();
    await page.locator('#global-place-search-input').fill('Kamikochi');
    await page.locator('#global-place-search-submit').click();
    await page.getByRole('button', { name: /上高地/ }).click();

    await page.locator('#btn-register-visited').click();
    const photoInput = page.locator('input[type="file"][accept="image/*"]');
    await expect(photoInput).toHaveAttribute('multiple', '');
    expect(await photoInput.getAttribute('capture')).toBeNull();

    const p1 = await createBrowserPng(page, 400, 300, '#0ea5e9');
    const p2 = await createBrowserPng(page, 400, 300, '#10b981');
    await photoInput.setInputFiles([
      { name: 'm1.png', mimeType: 'image/png', buffer: p1 },
      { name: 'm2.png', mimeType: 'image/png', buffer: p2 },
    ]);
    await expect(page.getByText('2 / 5')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);

    const captionInput = page.getByLabel(/写真 1 のキャプション/);
    const fontSizePx = await captionInput.evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).fontSize)
    );
    expect(fontSizePx).toBeGreaterThanOrEqual(16);

    await page.getByRole('button', { name: '登録して保存' }).click();
    const detailSheet = page.locator('section[aria-label="地点詳細シート"]');
    await detailSheet.getByRole('button', { name: '写真 1 を拡大' }).click();

    const lightbox = page.locator('dialog.visit-lightbox[open]');
    await expect(lightbox).toBeVisible();
    await assertImageLoaded(lightbox.locator('img'));

    const lbBox = await lightbox.boundingBox();
    expect(lbBox).not.toBeNull();
    expect(lbBox!.x).toBeGreaterThanOrEqual(0);
    expect(lbBox!.y).toBeGreaterThanOrEqual(0);
    expect(lbBox!.x + lbBox!.width).toBeLessThanOrEqual(391);
    expect(lbBox!.y + lbBox!.height).toBeLessThanOrEqual(845);

    for (const label of ['写真を閉じる', '前の写真', '次の写真']) {
      const btnBox = await lightbox.getByRole('button', { name: label }).boundingBox();
      expect(btnBox, `${label} boundingBox`).not.toBeNull();
      expect(btnBox!.width, `${label} width`).toBeGreaterThanOrEqual(44);
      expect(btnBox!.height, `${label} height`).toBeGreaterThanOrEqual(44);
    }
  });
});
