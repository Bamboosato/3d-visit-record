import { expect, test } from '@playwright/test';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test.describe('3D Visit Record core E2E flows', () => {
  test('policy pages, global search, From-To registration, reload persistence, status transition, Drive sync/conflict/merge/undo, and 3d_rain_viewer JSON import', async ({
    page,
  }) => {
    // Stateful in-memory fake Google Drive v3 backend
    let driveCounter = 1;
    let driveModifiedSeq = 1;
    let rootFolderId: string | null = null;
    let snapshotsFolderId: string | null = null;
    let recordsFile: {
      id: string;
      name: string;
      modifiedTime: string;
      headRevisionId: string;
      content: string;
    } | null = null;
    const snapshots: Array<{ id: string; name: string; content: string }> = [];

    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__VISIT3D_GOOGLE_CLIENT_ID__ =
        'e2e-test-client-id';
      (window as unknown as Record<string, unknown>).google = {
        accounts: {
          oauth2: {
            initTokenClient: (cfg: { callback: (r: { access_token: string; expires_in: number }) => void }) => ({
              requestAccessToken: () => {
                cfg.callback({ access_token: 'e2e-mock-token', expires_in: 3600 });
              },
            }),
            revoke: (_token: string, done?: () => void) => done?.(),
          },
        },
      };
    });

    // Mock external map / geo / JAXA / Google endpoints deterministically
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
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              place_id: 9001,
              lat: '48.8584',
              lon: '2.2945',
              name: 'エッフェル塔',
              category: 'tourism',
              type: 'attraction',
              address: { city: 'Paris', country: 'France', country_code: 'fr' },
            },
          ]),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          name: 'Champ de Mars',
          address: { city: 'Paris', country: 'France', country_code: 'fr' },
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
            user: { displayName: 'E2E Test User', emailAddress: 'e2e@example.com' },
          }),
        });
        return;
      }

      if (url.includes('/upload/drive/v3/files')) {
        const body = req.postData() ?? '';
        const parts = body.split(/\r?\n\r?\n/);
        const jsonPayload = parts.slice(2).join('\r\n\r\n').replace(/\r?\n--visit3d_[^-]+--\s*$/, '');
        const mod = `2026-11-20T09:0${driveModifiedSeq}:00.000Z`;
        const rev = `rev-${driveModifiedSeq++}`;
        if (method === 'POST') {
          recordsFile = {
            id: `file-${driveCounter++}`,
            name: 'visit-records.json',
            modifiedTime: mod,
            headRevisionId: rev,
            content: jsonPayload,
          };
        } else {
          recordsFile = {
            id: recordsFile?.id ?? `file-${driveCounter++}`,
            name: 'visit-records.json',
            modifiedTime: mod,
            headRevisionId: rev,
            content: jsonPayload,
          };
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: recordsFile.id,
            name: recordsFile.name,
            modifiedTime: recordsFile.modifiedTime,
            headRevisionId: recordsFile.headRevisionId,
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
              files: rootFolderId ? [{ id: rootFolderId, name: '3D Visit Record' }] : [],
            }),
          });
          return;
        }
        if (q.includes("role' and value='records'")) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ files: recordsFile ? [recordsFile] : [] }),
          });
          return;
        }
        if (q.includes("role' and value='snapshots'")) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              files: snapshotsFolderId ? [{ id: snapshotsFolderId, name: 'snapshots' }] : [],
            }),
          });
          return;
        }
        if (q.includes("role' and value='snapshot'")) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ files: snapshots }),
          });
          return;
        }
      }

      if (method === 'GET' && url.includes('/drive/v3/files/')) {
        const idMatch = /\/drive\/v3\/files\/([^?]+)/.exec(url);
        const fileId = idMatch?.[1];
        if (url.includes('alt=media') && recordsFile && fileId === recordsFile.id) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: recordsFile.content,
          });
          return;
        }
        if (fileId === rootFolderId) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ id: rootFolderId, name: '3D Visit Record' }),
          });
          return;
        }
        if (recordsFile && fileId === recordsFile.id) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(recordsFile),
          });
          return;
        }
        await route.fulfill({ status: 404, body: '{}' });
        return;
      }

      if (method === 'POST' && url.includes('/copy?')) {
        const snapId = `snap-${driveCounter++}`;
        snapshots.unshift({ id: snapId, name: `${snapId}.json`, content: recordsFile?.content ?? '' });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: snapId }),
        });
        return;
      }

      if (method === 'POST' && url.includes('/drive/v3/files?fields=id')) {
        const meta = req.postDataJSON() as { appProperties?: { role?: string } };
        const id = `folder-${driveCounter++}`;
        if (meta.appProperties?.role === 'root') rootFolderId = id;
        if (meta.appProperties?.role === 'snapshots') snapshotsFolderId = id;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id }),
        });
        return;
      }

      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    // 1. Direct access to /privacy and /terms
    await page.goto('/privacy');
    await expect(page.getByRole('heading', { name: /プライバシーポリシー/ })).toBeVisible();
    await expect(page.getByText('https://www.googleapis.com/auth/drive.file')).toBeVisible();
    await page.getByRole('button', { name: '利用規約を見る' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /利用規約/ })).toBeVisible();
    await page.getByRole('button', { name: '地図アプリに戻る' }).click();

    // 2. Main app loads & status filter shows 0, and LayerMenu policy links work
    await expect(page.locator('#visit-map-container')).toBeVisible();
    await expect(page.locator('#status-filter-all')).toContainText('0');

    await page.locator('#layer-menu-toggle-btn').click();
    await page.getByRole('button', { name: 'プライバシーポリシー' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /プライバシーポリシー/ })).toBeVisible();
    await page.getByRole('button', { name: '地図アプリに戻る' }).click();
    await expect(page.locator('#visit-map-container')).toBeVisible();

    await page.locator('#layer-menu-toggle-btn').click();
    await page.getByRole('button', { name: '利用規約・クレジット' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /利用規約/ })).toBeVisible();
    await page.getByRole('button', { name: '地図アプリに戻る' }).click();
    await expect(page.locator('#visit-map-container')).toBeVisible();

    // 3. Global search for Paris ("Eiffel Tower") & register as planned with From-To + multiline memo
    await page.locator('#nav-toggle-btn').click();
    await page.locator('#nav-tab-search').click();
    await page.locator('#global-place-search-input').fill('Eiffel Tower');
    await page.locator('#global-place-search-submit').click();
    await page.getByRole('button', { name: /エッフェル塔/ }).click();

    await page.locator('#btn-register-planned').click();
    // Switch precision to day first so From-To range toggle is shown
    await page.getByRole('button', { name: '年月日' }).click();
    await page.getByLabel('期間（From - To）を指定').check();
    await page.getByLabel('開始（From）').fill('2026-12-28');
    await page.getByLabel('終了（To）').fill('2027-01-02');
    await page.getByLabel('メモ（任意・複数行可）').fill('パリの年越し旅行\n展望台予約する');
    await page.getByRole('button', { name: '登録して保存' }).click();

    await expect(page.getByText('2026/12/28 〜 2027/01/02')).toBeVisible();
    await expect(page.locator('#status-filter-planned')).toContainText('1');

    // 4. Reload browser and confirm IndexedDB persistence + cross-year filter hit for 2026 and 2027
    await page.reload();
    await expect(page.locator('#status-filter-all')).toContainText('1');
    await expect(page.locator('#status-filter-planned')).toContainText('1');

    await page.locator('#nav-toggle-btn').click();
    await page.getByLabel('年・時期で絞り込み').selectOption('2027');
    await expect(page.getByRole('button', { name: /エッフェル塔/ })).toBeVisible();
    await page.getByRole('button', { name: /エッフェル塔/ }).click();

    // 5. Convert planned -> visited & add re-visit plan
    await page.locator('#btn-convert-to-visited').click();
    await page.getByRole('button', { name: '訪問済みとして保存' }).click();
    await expect(page.locator('#status-filter-visited')).toContainText('1');

    await page.locator('#btn-add-planned-entry').click();
    await page.getByLabel('メモ（任意・複数行可）').fill('春に再訪したい');
    await page.getByRole('button', { name: '記録を追加' }).click();
    await expect(page.getByText('再訪予定あり')).toBeVisible();

    // 6. Save to Google Drive via native <dialog>
    await page.locator('#cloud-sync-open-btn').click();
    await expect(page.locator('#cloud-sync-dialog')).toBeVisible();
    await page.locator('#drive-save-btn').click();
    await expect(page.getByText(/Google Drive（3D Visit Record\/visit-records\.json）へ 1 件/)).toBeVisible();
    expect(recordsFile).not.toBeNull();

    // 7. Simulate another device updating Drive -> trigger conflict -> merge restore -> Undo
    recordsFile = {
      ...recordsFile!,
      modifiedTime: '2026-11-20T12:00:00.000Z',
      headRevisionId: 'rev-remote-device',
      content: JSON.stringify({
        app: '3d-visit-record',
        kind: 'visit-records',
        schemaVersion: 1,
        exportedAt: '2026-11-20T12:00:00.000Z',
        revision: 99,
        count: 1,
        items: [
          {
            id: 'remote-fuji',
            name: '富士山',
            status: 'visited',
            category: 'nature',
            center: [138.7274, 35.3606],
            elevation: 3776,
            camera: { zoom: 11, pitch: 60, bearing: 0 },
            isPinned: true,
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
            entries: [
              {
                id: 'fuji-e1',
                kind: 'visited',
                date: { precision: 'day', start: '2026-08-01' },
                memo: '別端末で登録した山頂記録',
                photos: [],
                createdAt: '2026-08-01T00:00:00.000Z',
                updatedAt: '2026-08-01T00:00:00.000Z',
              },
            ],
          },
        ],
      }),
    };

    await page.locator('#drive-save-btn').click();
    await expect(
      page.getByText('他の端末・セッションで Google Drive のデータが更新されています')
    ).toBeVisible();

    await page.locator('#conflict-merge-btn').click();
    await expect(page.getByText(/取り込み・復元の確認/)).toBeVisible();
    await page.locator('#confirm-import-btn').click();
    await expect(page.getByText(/追加 1件/)).toBeVisible();
    await expect(page.locator('#status-filter-all')).toContainText('2');

    // Undo restores back to 1 spot
    await page.locator('#undo-restore-btn').click();
    await expect(page.getByText('直前の状態に戻しました')).toBeVisible();
    await expect(page.locator('#status-filter-all')).toContainText('1');

    // 8. Import 3d_rain_viewer favorites JSON file
    await page.locator('summary', { hasText: 'ローカル JSON バックアップ' }).click();
    const rainPayload = JSON.stringify({
      app: '3d-rain-viewer',
      kind: 'favorites',
      schema: 1,
      items: [
        {
          id: 'rain-kamikochi',
          name: '上高地',
          center: [137.638, 36.248],
          zoom: 12.5,
          pitch: 55,
          bearing: 0,
          elevation: 1505,
          category: 'nature',
        },
      ],
    });
    await page.locator('input[type="file"]').setInputFiles({
      name: '3d-rainscape-favorites.json',
      mimeType: 'application/json',
      buffer: Buffer.from(rainPayload, 'utf8'),
    });
    await expect(
      page.getByText('3d_rain_viewer のお気に入りバックアップとして認識しました')
    ).toBeVisible();
    await page.locator('#confirm-import-btn').click();
    await expect(page.locator('#status-filter-all')).toContainText('2');
  });
});
