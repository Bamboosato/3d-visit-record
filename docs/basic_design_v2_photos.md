# 3D Visit Record v2.0（写真機能）基本設計書

## 1. システムアーキテクチャ差分

### 1.1 v2.0 追加モジュール・全体構成（サーバーレス SPA 維持）

v2.0 でも開発者側のバックエンドサーバーおよび外部画像ストレージを持たず、初版（`docs/basic_design.md`）で定義した **Vercel 静的配信 ＋ クライアントブラウザ（IndexedDB `visit3d_db`）＋ ユーザー自身の Google Drive（`drive.file` 単一スコープ）** の構成を維持します。

```text
[ SpotForm.tsx ] ──> [ PhotoPickerField.tsx ]
                          │
                          ├──> [ photoExif.ts ]      (JPEG/WebP EXIF 撮影日時のみ軽量解析 / GPS非読取)
                          └──> [ photoProcessor.ts ] (SVG拒否 / 正立化 / 1600px本体 + 320pxサムネ生成 / SHA-256)
                                    │
                                    ▼ (確定保存時: 単一IDBトランザクション)
[ App.tsx ] ──> [ visitStorage.ts ] ──> IndexedDB: visit3d_db
                    ├── app_state ('primary') : VisitSpot[] / UndoSnapshot / DriveSyncMeta
                    └── photos    (photoId)   : { id, mimeType, fullBlob, thumbnailBlob, ... }
                                    │
                                    ├──(閲覧時)──> [ photoUrlCache.ts ] (ObjectURL 参照管理・自動解放)
                                    │                   ├──> [ SpotDetailSheet.tsx ]
                                    │                   ├──> [ PhotoLightbox.tsx ]
                                    │                   └──> [ SpotNavDrawer.tsx ]
                                    │
                                    └──(同期時)──> [ photoSyncManager.ts ] ──> [ googleDriveClient.ts ]
                                                        │                           └── Drive API v3 (drive.file)
                                                        │                                 └── 3D Visit Record/photos/
                                                        └── [ CloudSyncDialog.tsx ]
                                                            (並列UL / 進捗 / オンデマンドDL / 一括DL / 自動ゴミ箱)
```

### 1.2 モジュール一覧（新規・変更）

| 区分 | ファイルパス | 主な責務 |
| :--- | :--- | :--- |
| **変更** | `src/types/visit.ts` | 写真制限定数、`StoredPhotoRecord`、`VisitBackupEnvelope.photoSyncVersion`、`DriveSyncMeta.photosFolderId` 追加 |
| **変更** | `src/lib/spotDomain.ts` | `isValidPhotoAttachment` の制御文字・ファイル名検証強化、`MAX_PHOTOS_PER_ENTRY` / `MAX_TOTAL_PHOTOS` 検証追加 |
| **変更** | `src/lib/visitMerge.ts` | `photoSyncVersion === 2` 時の削除/更新反映マージ、`MergePreview` への写真増減集計追加 |
| **新規** | `src/lib/photoExif.ts` | 依存ゼロの EXIF 撮影日時抽出（`DateTimeOriginal` 等）と訪問日提案計算 |
| **新規** | `src/lib/photoProcessor.ts` | 入力形式/サイズ検証、Canvas リサイズ圧縮（WebP / JPEG フォールバック）、SHA-256 算出、iOS 向けメモリ解放 |
| **新規** | `src/lib/photoStorage.ts` | `visit3d_db` の `photos` ストア CRUD、未参照写真 GC、ストレージ容量集計（`visitStorage.ts` と同一トランザクション協調） |
| **変更** | `src/lib/visitStorage.ts` | `saveSpotsWithPhotosAtomic` / `saveSpotsWithUndoAtomic` / `restoreUndoSnapshot` での `['app_state', 'photos']` 原子書き込みと GC 連携 |
| **新規** | `src/lib/photoUrlCache.ts` | `URL.createObjectURL()` / `revokeObjectURL()` の一元管理（参照カウント・LRU キャッシュ） |
| **変更** | `src/lib/googleDriveClient.ts` | `photos/` フォルダ確保、`nextPageToken` 対応一覧取得、Blob `multipart/related` アップロード、バイナリダウンロード、ゴミ箱移動 |
| **新規** | `src/lib/photoSyncManager.ts` | 並列上限 3 アップロード＆レジューム、SHA-256 重複排除、オンデマンド取得合流（デデュプリケート）、一括 DL、保存後自動ゴミ箱整理 |
| **新規** | `src/components/PhotoPickerField.tsx` | 訪問済みフォーム内写真添付・並び替え・キャプション編集・EXIF 撮影日提案 UI |
| **新規** | `src/components/PhotoLightbox.tsx` | `<dialog>` ベース拡大モーダル（前後切替・スワイプ・キーボード・単体保存/共有） |
| **変更** | `src/components/SpotForm.tsx` | `kind === 'visited'` 時のみ `PhotoPickerField` 表示、一時写真ドラフト管理とキャンセル解放 |
| **変更** | `src/components/SpotDetailSheet.tsx` | ログ内サムネイル一覧、ライトボックス起動、未キャッシュ写真のオンデマンド自動取得 / 手動読込 UI |
| **変更** | `src/components/SpotNavDrawer.tsx` | 一覧カード代表サムネイル・総枚数バッジ表示、キャプションキーワード検索対応 |
| **変更** | `src/components/CloudSyncDialog.tsx` | 写真アップロード進捗・一括ダウンロード UI・端末写真ストレージ表示・JSON 非同梱注記・写真差分プレビュー |
| **変更** | `src/components/StaticPolicyPage.tsx` | `/privacy` への写真データ処理（端末内圧縮・EXIF 除去・Drive `photos/` 保存）追記 |
| **変更** | `src/lib/diagnostics.ts` / `src/App.tsx` | 写真系診断イベント追加、`hasUnsavedDriveChanges` 拡張、状態統合・Undo 時写真維持 |

---

## 2. データモデル・定数・スキーマ互換設計

### 2.1 定数・型定義追加（`src/types/visit.ts`）

既存の `PhotoAttachment`・`VisitEntry.photos`（v1 で予約済み）をそのまま活かしつつ、以下の定数および型を追加・拡張します。

```ts
export const MAX_PHOTOS_PER_ENTRY = 5;
export const MAX_TOTAL_PHOTOS = 2000;
export const MAX_PHOTO_INPUT_BYTES = 25 * 1024 * 1024; // 25 MiB
export const MAX_PHOTO_CAPTION_LENGTH = 200;
export const PHOTO_DISPLAY_MAX_EDGE = 1600;
export const PHOTO_THUMBNAIL_MAX_EDGE = 320;
export const PHOTO_WEBP_QUALITY = 0.82;
export const PHOTO_JPEG_FALLBACK_QUALITY = 0.85;
export const PHOTO_THUMB_QUALITY = 0.75;

/** IndexedDB 'photos' ストアのレコード構造 */
export interface StoredPhotoRecord {
  id: string; // PhotoAttachment.id と一致
  mimeType: 'image/webp' | 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
  fullBlob: Blob;
  thumbnailBlob: Blob;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/** フォーム編集中に保持する未確定写真ドラフト（メモリ上のみ） */
export interface DraftPhotoItem {
  attachment: PhotoAttachment;
  fullBlob?: Blob;       // 新規追加時のみ保持
  thumbnailBlob?: Blob;  // 新規追加時のみ保持
  previewUrl: string;    // フォーム表示用の一時 Object URL（破棄時に必ず revoke）
  isNew: boolean;
}
```

#### `VisitBackupEnvelope` と `DriveSyncMeta` の拡張
- `schemaVersion: 1` は変更せず維持します（既存 v1 クライアントの `schemaVersion > 1` 拒否や既存テストとの後方互換を保つため）。
- 代わりにオプショナルフィールド `photoSyncVersion?: 2` を追加し、v2.0 以降が出力したバックアップ／Drive JSON には `photoSyncVersion: 2` を付与します。
- `DriveSyncMeta` に `photosFolderId: string | null` を追加します（既存保存データの読込時は未定義なら `null` としてパース）。

```ts
export interface VisitBackupEnvelope {
  app: '3d-visit-record';
  kind: 'visit-records';
  schemaVersion: 1;
  photoSyncVersion?: 2; // v2.0 以降は 2 を出力
  exportedAt: string;
  revision: number;
  count: number;
  items: VisitSpot[];
}

export interface DriveSyncMeta {
  folderId: string | null;
  photosFolderId?: string | null; // 追加: 3D Visit Record/photos フォルダIDキャッシュ
  fileId: string | null;
  lastSyncedRevision: number | null;
  lastDriveModifiedTime: string | null;
  lastDriveHeadRevisionId: string | null;
  lastSyncedAt: string | null;
  accountEmail: string | null;
}
```

### 2.2 バリデーション強化（`src/lib/spotDomain.ts`）

現行の `isValidPhotoAttachment` に対して以下を追加します：
1. `id` 形式チェック: `/^[\w.-]{1,80}$/` に一致すること。
2. `fileName` 安全性チェック: `hasControlCharacters(p.fileName, false)` が `false` であり、`/`・`\`・`..` を含まない単一ファイル名であること（パストラバーサル防止）。
3. `caption` 検証: 指定時は `typeof p.caption === 'string'`、`p.caption.length <= MAX_PHOTO_CAPTION_LENGTH`（200文字）、かつ `hasControlCharacters(p.caption, false)` が `false` であること。
4. `driveFileId` / `checksumSha256` 検証: 指定時は空文字不可・上限長（例: `driveFileId <= 200`, `checksumSha256` は 64 桁 hex `/^[a-f0-9]{64}$/i`）を検証。
5. `isValidVisitEntry` で `e.photos.length <= MAX_PHOTOS_PER_ENTRY`（5 枚）を検証し、配列内の `photo.id` 重複を拒否する。
6. `validateSpotsForWrite` で全地点合計写真枚数 `<= MAX_TOTAL_PHOTOS`（2,000 枚）を検証する。

### 2.3 マージ仕様の v2 刷新（`src/lib/visitMerge.ts`）

#### 問題点（現行 v1 コードとの競合）
現行 `src/lib/visitMerge.ts`（414〜422 行目）では、`entry.id` が一致し `inc.updatedAt > prev.updatedAt` のとき：
```ts
photos: inc.photos.length > 0 ? inc.photos.map((p) => ({ ...p })) : prev.photos,
```
という「v1 クライアントが誤って v2 写真を空配列で消さないための暫定保護」が入っています。しかし v2.0 では **「端末 A で写真を 0 枚に全削除したあと `updatedAt` を更新して Drive 保存 → 端末 B でマージ復元」** した際、上記コードのままだと端末 B の古い写真配列 `prev.photos` が残って写真が復活してしまいます。

#### 解決設計
1. `parseBackupJson` の戻り値に `photoSyncVersion?: number` を含める。
2. `mergeEntries(existingEntries, incomingEntries, options: { respectEmptyIncomingPhotos: boolean })` を導入：
   - **取り込み元が v2 以降（`photoSyncVersion !== undefined && photoSyncVersion >= 2`）の場合**: `respectEmptyIncomingPhotos = true`。`inc.updatedAt > prev.updatedAt` であれば `inc.photos` が空配列 `[]` であってもそのまま採用し、全削除・一部削除・並び替え・キャプション編集を正確に同期する。
   - **取り込み元が v1 旧データ（`photoSyncVersion === undefined`）の場合**: `respectEmptyIncomingPhotos = false`。従来どおり `inc.photos.length > 0 ? inc.photos : prev.photos` を維持し、v1 バックアップ取り込みで v2 写真が誤消去されるのを防ぐ。
3. **`MergePreview` への写真差分追加**:
   - `photosAdded: number`（ローカルになかった `photo.id` がマージ結果に増える数）
   - `photosRemoved: number`（ローカルにあった `photo.id` が置き換え・削除マージ等で結果から減る数）
   - ※同一 `spot.id` かつ `entries` に写真配列変更（追加・削除・並び順・キャプション変更）のみがあった場合も `updated` にカウントされるよう比較条件を調整する。
4. **`sanitizeEntry` のサニタイズ追加**:
   - `e.photos.slice(0, MAX_PHOTOS_PER_ENTRY)` とし、`caption` は前後空白トリム・連続空白整理（改行なし）を適用して検証する。

---

## 3. クライアント画像処理 & EXIF 抽出設計

### 3.1 撮影日時 EXIF 軽量解析（`src/lib/photoExif.ts`）

外部ライブラリを増やさずバンドルサイズとセキュリティリスクを抑えるため、約 150〜200 行の純粋 TypeScript バイナリパーサを実装します。

1. **走査対象と制限**:
   - ファイル先頭最大 **128 KB** のみ `file.slice(0, 131072).arrayBuffer()` で読み取り（巨大 JPEG 全体を読まない）。
   - **JPEG (`0xFF 0xD8`)**: セグメントを順に走査し、`APP1`（`0xFF 0xE1`）かつ `"Exif\0\0"` ヘッダを持つチャンクの TIFF ヘッダ（`II` リトルエンディアン / `MM` ビッグエンディアン）を解析。
   - **WebP (`RIFF....WEBP`)**: RIFF チャンクを走査し、`EXIF` チャンクを検出したら TIFF ヘッダを解析（先頭 6 バイトが `"Exif\0\0"` の場合スキップしてオフセット調整）。
   - **PNG / HEIC 等で EXIF ブロックが見つからない／解析失敗時**: 例外を投げず `null` を返し、後述フォールバックまたは提案スキップとする。
2. **読み取るタグ（最小限・GPS タグは意図的に無視）**:
   - IFD0（`0x0132 DateTime`, `0x8769 ExifIFDPointer`）
   - Exif IFD（`0x9003 DateTimeOriginal`, `0x9004 DateTimeDigitized`, `0x9011 OffsetTimeOriginal`）
   - **優先順位**: `DateTimeOriginal` > `DateTimeDigitized` > `DateTime`。
   - **GPS IFD (`0x8825`) や MakerNote には一切アクセスしない**。
3. **壁時計日付の保全（タイムゾーンズレ防止）**:
   - EXIF 文字列 `"YYYY:MM:DD HH:MM:SS"` から、まず撮影地の壁時計日付 **`localDate: 'YYYY-MM-DD'`**（例: `"2025-10-12"`）をそのまま抽出し、`isValidDatePart('day', localDate)` で実在日検証する。
   - `takenAt`（ISO 8601）は `OffsetTimeOriginal`（例: `"+09:00"`）があれば付与した ISO 文字列とし、無ければ現地時刻文字列＋ローカル解釈にせず日時のパース整合を保つ（提案日比較には必ず `localDate` を使用し、UTC 変換で日付が 1 日前後するバグを防ぐ）。
4. **訪問日への提案ロジック**:
   - 現在のフォーム内写真群から有効な `localDate` 集合を抽出。
   - 最小日 `minDate` と最大日 `maxDate` を求め、`minDate === maxDate` なら `{ precision: 'day', start: minDate }`、`minDate < maxDate` なら `{ precision: 'day', start: minDate, end: maxDate }` の候補を生成。
   - フォームの現在の日付値（`precision`, `startVal`, `endVal`）と異なる場合のみ提案バナーを表示する。

### 3.2 画像リサイズ・圧縮・無害化（`src/lib/photoProcessor.ts`）

1. **入力ガード**:
   - `file.type === 'image/svg+xml'` または拡張子 `.svg`（さらにファイル先頭 512 バイトに `<svg` を含むテキスト）を **即座に拒否** する（XSS 防止）。
   - `!file.type.startsWith('image/')`（ただし一部モバイルで `type === ''` の `.jpg/.jpeg/.png/.webp/.heic/.heif` は拡張子許可）を拒否。
   - `file.size > MAX_PHOTO_INPUT_BYTES`（25 MB）を拒否。
2. **デコード & EXIF 正立化**:
   - 第一選択: `createImageBitmap(file, { imageOrientation: 'from-image' })` を使用（モダン Chrome / Edge / Safari 16+ で EXIF Orientation を正しく自動回転）。
   - フォールバック: `createImageBitmap` がオプション非対応または失敗した場合は `<img>` + `URL.createObjectURL(file)` でデコード（モダンブラウザの `<img>` は CSS `image-orientation: from-image` 既定により正立描画される）。
   - 極端な画像（例: 20,000px 超等）のデコードエラー時は分かりやすい日本語エラーを返す。
3. **2 段階リサイズ & 実出力 MIME 検出**:
   - 元寸法 `(srcW, srcH)` から、拡大なし（`scale = Math.min(1, maxEdge / Math.max(srcW, srcH))`）でターゲット寸法を算出。
   - 本体（`maxEdge = 1600`）生成時、`canvas.toBlob(cb, 'image/webp', 0.82)` を呼び出し、返却された `blob.type` を検査する。
   - **重要（iOS Safari 対応）**: Safari 等 WebP エンコード非対応環境では `canvas.toBlob(..., 'image/webp')` がエラーを出さず暗黙的に `'image/png'` を返すため、`blob.type !== 'image/webp'` なら即座に `canvas.toBlob(cb, 'image/jpeg', 0.85)` で再エンコードし、拡張子を `.jpg`・`mimeType: 'image/jpeg'` として確定する。
   - サムネイル（`maxEdge = 320`）は本体で確定した有効 `mimeType`（`image/webp` または `image/jpeg`、品質 `0.75`）で生成する（本体 Canvas から縮小描画すればデコードは 1 回で済む）。
4. **SHA-256 算出 & EXIF 完全除去**:
   - Canvas 再エンコードにより得られた `fullBlob` は一切の EXIF/GPS/コメントチャンクを含まない純粋なピクセル再圧縮画像となる。
   - `crypto.subtle.digest('SHA-256', await fullBlob.arrayBuffer())` で 64 桁 16 進文字列 `checksumSha256` を算出する（非セキュアコンテキストで `crypto.subtle` 不在時のみフォールバックまたは省略可）。
5. **iOS Safari メモリスパイク防止**:
   - 複数枚選択時は `for (const file of files)` で **1 枚ずつ直列処理** する（並列デコードしない）。
   - 各画像の処理終了時（`finally` ブロック）に `bitmap.close()` を呼び、`canvas.width = 0; canvas.height = 0;` を代入して即座に GPU/メモリバッファを解放する。

---

## 4. ローカルストレージ & Object URL 管理設計

### 4.1 IndexedDB（`visit3d_db`）トランザクション & GC（`src/lib/photoStorage.ts` / `visitStorage.ts`）

`src/lib/visitStorage.ts` の `openVisitDb` は初版から `DB_VERSION = 1` のまま `STORE_APP_STATE ('app_state')` と `STORE_PHOTOS ('photos')` の両ストアを作成済みであるため、スキーママイグレーション不要でそのまま利用できます。

1. **単一トランザクション原子的書き込み（`saveSpotsWithPhotosAtomic`）**:
   - `operationQueue` 上で実行する。
   - 書き込み前に全 `spots` 検証＋`MAX_TOTAL_PHOTOS`（2,000 枚）チェックを実施。
   - `db.transaction([STORE_APP_STATE, STORE_PHOTOS], 'readwrite')` を開き、同一トランザクション内で：
     1. 新規追加された `StoredPhotoRecord[]` を `photos` ストアへ `put(record, record.id)`。
     2. 更新後の `LocalAppState` を `app_state` ストアの `'primary'` キーへ `put(bumpedState, 'primary')`。
   - トランザクション失敗時（`QuotaExceededError` 含む）は自動ロールバックされ、「メタデータのみ保存されて画像が欠損」「ゴミ画像だけ残存」のいずれも発生しない。
2. **1 世代 Undo 保護付き孤児 GC（`pruneOrphanPhotos`）**:
   - 参照可能 ID 集合 `referencedIds` を次のように定義する：
     ```ts
     referencedIds = collectPhotoIds(state.spots) ∪ collectPhotoIds(state.undo?.spots ?? [])
     ```
   - `saveSpots` / `saveSpotsWithUndoAtomic` / `restoreUndoSnapshot` の実行時、または専用メンテナンスタスクで `STORE_PHOTOS` の全キー（`getAllKeys()`）を走査し、`!referencedIds.has(key)` であるレコードのみを削除する。
   - これにより、以下の全ケースで整合性が保たれます：
     - 写真付き地点・ログ削除直後 → まだ復元は不要だが直ちに消して良いため `undo` に無ければ GC される（注: 地点削除自体には Undo を作らない現行仕様に準拠。Drive 復元／JSON インポート直前は `undo.spots` に入るため確実に保護される）。
     - Drive 復元（置き換え／削除マージ）時 → 復元前の写真が `state.undo.spots` で保護されるため、**復元後に「元に戻す（Undo）」を押しても写真画像が 100% 復活** する。その後、次の復元で `undo` が差し替わった時点で旧写真は自動 GC される。
3. **ストレージ使用量取得（`getPhotoStorageStats`）**:
   - `STORE_PHOTOS` 全レコード（`openCursor` または `getAll` ではなく軽量にメタデータ取得、件数増加時も安全なカーソル集計で `fullBlob.size + thumbnailBlob.size` を合算）からアプリ内写真総数・総バイト数を算出。
   - 併せて `navigator.storage?.estimate?.()` の `usage` / `quota` を取得し、`CloudSyncDialog` に参考表示する。
4. **`hasUnsavedDriveChanges` の拡張（`src/App.tsx`）**:
   - 既存条件 `lastSyncedRevision === null || revision > lastSyncedRevision` に加え、**ローカルの `spots` 内に `driveFileId` が未付与の `PhotoAttachment` が 1 件以上存在する場合** も「未保存の変更あり」と判定する（写真アップロード途中で中断した場合も未保存バッジが消えないようにするため）。

### 4.2 Object URL ライフサイクル管理（`src/lib/photoUrlCache.ts`）

React コンポーネントごとに無秩序に `URL.createObjectURL` を呼ぶとメモリリークするため、専用キャッシュモジュールを新設します。

- サムネイル用（`thumb:${photoId}`）と拡大用（`full:${photoId}`）の 2 系統で LRU キャッシュ（例: サムネイル最大 200 件、拡大用最大 20 件）＋ 参照カウントを管理。
- エントリがキャッシュ上限から追い出された際、参照カウントが `0` なら即 `URL.revokeObjectURL(url)`、参照中なら参照解放時（`releasePhotoUrl`）に遅延 `revoke` する。
- 特定 `photoId` がローカルから削除／更新された際は `invalidatePhotoUrl(photoId)` を呼んでキャッシュを破棄する。
- React 側はカスタムフック `usePhotoObjectUrl(photoId, variant: 'thumb' | 'full')` 経由で利用し、アンマウント時に確実に `release` する。

---

## 5. Google Drive 写真同期・オンデマンド取得・自動ゴミ箱移動設計

### 5.1 Google Drive フォルダ・ファイル構成

```text
マイドライブ /
└── 3D Visit Record /                    # appProperties: { app: "3d-visit-record", role: "root" }
      ├── visit-records.json             # appProperties: { app: "3d-visit-record", role: "records", schemaVersion: "1" }
      ├── snapshots/                     # appProperties: { app: "3d-visit-record", role: "snapshots" }
      │     └── visit-records-*.json     # 直近最大 5 世代保持
      └── photos/                        # appProperties: { app: "3d-visit-record", role: "photos" }
            └── <photoId>.webp (.jpg)    # appProperties: { app: "3d-visit-record", role: "photo", photoId: "<uuid>", checksumSha256: "<hex>" }
```

- **本体のみ保存**: Drive のファイル数・API コール数・ユーザー容量を半分近くに抑えるため、Drive 上には閲覧用本体（1,600px）のみを保存します。別端末でダウンロードした際は `photoProcessor.ts` のサムネ生成関数を用いて端末側で 320px サムネイルを即座に生成し、IndexedDB `photos` ストアへ格納します。

### 5.2 Google Drive REST API v3 拡張（`src/lib/googleDriveClient.ts`）

| 用途 | HTTP メソッド & エンドポイント | 設計ポイント |
| :--- | :--- | :--- |
| **`photos/` フォルダ確保** | `GET /drive/v3/files` / `POST /drive/v3/files` | `syncMeta.photosFolderId` が有効なら `getDriveFileMeta` で生存確認し、無ければ `role='photos'` で検索・新規作成。 |
| **`photos/` 全件一覧取得** | `GET /drive/v3/files` | **【重要改修】** 現行 `queryDriveFiles` は `pageSize=20` 単発取得のため、ページネーション対応関数 `listAllDriveFilesByQuery`（`pageSize=100` + `nextPageToken` ループ、安全上限ループガード付き）を新設し、20 枚超でも漏れなく一覧取得できるようにする。 |
| **画像バイナリアップロード** | `POST /upload/drive/v3/files?uploadType=multipart` | **【重要】** 既存のテキスト連結 `buildMultipartBody` を流用せず、`new Blob([metaHeader, JSON.stringify(metadata), mediaHeader, imageBlob, closingBoundary])` による **バイナリ安全 `multipart/related` リクエスト** を実装する（タイムアウトは画像サイズに応じ `30000ms` へ延長、`bounded` + `AbortSignal` 対応）。 |
| **画像バイナリダウンロード** | `GET /drive/v3/files/{fileId}?alt=media` | `driveFetchWithRetry` で取得後 `res.blob()` を返却（`timeoutMs: 30000`）。`Content-Type` またはヘッダ確認で HTML エラーページ等を誤格納しない。 |
| **不要写真のゴミ箱移動** | `PATCH /drive/v3/files/{fileId}` | JSON ボディ `{ "trashed": true }` を送信。物理 `DELETE` ではなくゴミ箱へ移動し、誤削除や `snapshots/` からの復旧余地（30日間）を残す。 |

### 5.3 「Google Drive に保存」シーケンス（競合検知 → 写真並列 UL → JSON 保存 → 自動ゴミ箱移動）

1. **Phase 1: 競合検知（先行実行）**
   - `inspectRemoteRecords` を実行し、`visit-records.json` の `modifiedTime` / `headRevisionId` をローカル `driveSync` と比較。
   - **競合（`remote-newer` / `remote-exists-unlinked`）かつ `!forceOverwrite` の場合**: 写真を 1 枚もアップロードせず直ちに競合ダイアログへ遷移する。
2. **Phase 2: `photos/` フォルダ確認 ＆ 既存ファイルインデックス取得**
   - `ensurePhotosFolderId` で `photosFolderId` を確定。
   - `listAllDriveFilesByQuery` で `photos/` 内の非ゴミ箱ファイル一覧（`id, name, appProperties, size`）を 1 回取得し、`checksumSha256 -> DriveFileMeta` および `photoId -> DriveFileMeta` マップを構築。
3. **Phase 3: 未アップロード写真の並列アップロード（上限 3 並列・レジューム対応）**
   - ローカルの全 `VisitSpot` / `VisitEntry` / `PhotoAttachment` を走査し、`!photo.driveFileId` の写真を抽出。
   - 各写真について：
     - **重複再利用**: `checksumSha256` が一致するファイルが Drive `photos/` 内に既に存在する場合はアップロードをスキップし、既存 `driveFileId` を再利用。
     - **ローカル Blob 読込**: IndexedDB `photos` から `fullBlob` を取得しアップロード。
     - **逐次メタ反映（レジューム保証）**: 1 枚完了するごとにコールバック `onPhotoUploaded(photoId, driveFileId)` でローカル `app_state` へ `driveFileId` を反映する（全完了前に通信切断やユーザー中断が起きても、完了分は次回スキップされる）。
   - 進捗イベント `{ phase: 'uploading-photos', completed, total }` を UI へ通知。
   - **失敗時の扱い**: 1 枚でもアップロードに失敗したまま進めると Drive 上に画像が無い欠損レコードになるため、アップロード未完了の写真が残った場合はエラーを報告して Phase 4（`visit-records.json` 保存）を中断する（取得済みの `driveFileId` はローカルへ保持される）。
4. **Phase 4: `visit-records.json` 保存（スナップショット退避付き）**
   - すべての写真に `driveFileId` が揃った状態で `buildBackupEnvelope(latestSpots, revision)`（`photoSyncVersion: 2` 付与）を生成し、5 世代スナップショット退避後に `visit-records.json` を `POST` / `PATCH` する。
5. **Phase 5: 不要写真の自動ゴミ箱移動（非致命・事後整理）**
   - **必ず Phase 4 成功後に実行** する（競合中や保存失敗時に他端末の写真を誤ってゴミ箱へ移さないため）。
   - 現行 `latestSpots` に含まれる全 `driveFileId` および `photoId` の集合 `activeIds` を作成。
   - Phase 2 で取得した `photos/` 一覧（または最新リスト）のうち、`role === 'photo'` かつ `!activeIds.has(file.id)` かつ `!activeIds.has(file.appProperties?.photoId)` に該当するファイルを抽出。
   - 抽出されたファイルを並列上限 3 で `trashDriveFile(accessToken, file.id)`（`PATCH { trashed: true }`）する。
   - ゴミ箱移動の一部が失敗（オフライン・一時エラー等）しても保存全体は成功扱いとし、次回保存時に未参照のままなら再度ゴミ箱移動を試みる。

### 5.4 オンデマンド取得 & 一括ダウンロード設計（`src/lib/photoSyncManager.ts`）

1. **オンデマンド取得の重複合流（In-flight Deduplication）**:
   - `ensurePhotoCached(photo: PhotoAttachment, options?: { interactiveAuth?: boolean; signal?: AbortSignal })` を提供。
   - 同一 `photo.id` に対する同時呼び出しは `Map<string, Promise<StoredPhotoRecord | null>>` で合流させ、詳細シートとライトボックスが同時に開いても重複ダウンロードしない。
   - **ローカル確認**: IndexedDB `photos` に既にあれば即返却。
   - **認証確認**:
     - `interactiveAuth === false`（詳細シート自動表示時）の場合：`hasActiveMemoryToken()` が `true` のときのみ自動ダウンロードを開始する。未認証（リロード直後等でトークン未取得）ならネットワーク呼び出しやポップアップを勝手に開かず `{ status: 'needs-auth' }` を返し、サムネイル枠に「Drive から写真を読み込む」ボタンを表示する。
     - `interactiveAuth === true`（ユーザーが読み込みボタン押下、またはライトボックスで取得要求時）：`requestDriveAccessToken({ prompt: '' })` 等で認証を取得してダウンロードを実行。
   - **ダウンロード ＆ サムネイル再生成**:
     - `downloadDrivePhotoBlob(token, photo.driveFileId)` で本体 Blob を取得。
     - `generateThumbnailFromBlob(fullBlob, photo.mimeType)` で 320px サムネイルを生成。
     - `saveDownloadedPhoto(photo, fullBlob, thumbnailBlob)` で IndexedDB `photos` へ保存。
   - **404 / オフライン保護**:
     - Drive から `404`（ユーザーが手動削除等）が返った場合、セッション内の `missingRemotePhotoIds: Set<string>` に記録して無限リトライを防止し、UI に「Drive 上に写真が見つかりません」プレースホルダを表示する。
2. **一括ダウンロード（`downloadAllMissingPhotos`）**:
   - 全 `spots` から「ローカル `photos` に未保存かつ `driveFileId` あり」の写真リストを抽出。
   - 推定サイズ合計（`sum(photo.bytes)`）と残り枚数を同期ダイアログに表示。
   - 実行時は並列上限 3、`AbortController` による途中キャンセル対応、1 枚ごとに IndexedDB へ保存して UI 進捗（`N / M 枚`）を更新する。途中キャンセルしても保存済み分はそのままキャッシュとして残る。

### 5.5 異常系・エラーハンドリング

| 事象 / HTTP コード | 発生箇所 | 挙動・リカバリ設計 |
| :--- | :--- | :--- |
| **`401 Unauthorized`** | 写真 UL / DL / ゴミ箱 | `driveFetchWithRetry` 既存機構で 1 回サイレント再取得。失敗時は認証エラーを返し、完了済み `driveFileId` は保持して再サインイン後にレジューム可能とする。 |
| **`403 storageQuotaExceeded`** | 写真 UL | 残りのアップロードを即座に中止し、「Google Drive の空き容量が不足しています」を表示。ローカル写真・完了済み分は保持。 |
| **`404 Not Found`** | オンデマンド DL | 対象写真に一時的 `not-found` 状態を記録しプレースホルダ表示。他の写真取得・アプリ操作は継続。 |
| **`404 Not Found` (`photosFolderId`)** | 写真 UL | キャッシュされていた `photosFolderId` が手動削除されていた場合は `photosFolderId: null` としてフォルダを再検索／再作成してリトライ。 |
| **IndexedDB `QuotaExceededError`** | ローカル保存 / DL キャッシュ | 一括ダウンロードや追加保存を安全に中断し既存データ保護。「端末の保存容量が不足しています」を案内。 |
| **デコード失敗 / 非対応形式** | 写真選択時 / DL 後生成 | 該当ファイルのみスキップ・エラー通知し、他の選択済み写真や入力中のフォーム内容（メモ・日付）は失わない。 |

---

## 6. UI・コンポーネント・アクセシビリティ設計

### 6.1 画面レイアウト・ワイヤーフレーム

#### A. フォーム内写真添付エリア（`PhotoPickerField.tsx` / `SpotForm.tsx`）
`kind === 'visited'` 時、メモ欄の下に配置（`kind === 'planned'` 時は非表示）：

```text
+-------------------------------------------------------+
| 写真（任意・最大 5 枚）                      [ 2 / 5 ] |
| ┌───────────────────────────────────────────────────┐ |
| │ 📷 写真を追加（複数選択・ドラッグ＆ドロップ）       │ |
| └───────────────────────────────────────────────────┘ |
| 💡 写真の撮影日（2025/10/10 〜 2025/10/12）を        |
|    訪問日に反映しますか？            [反映する] [×]  |
|                                                       |
| ┌──────────┐  ┌──────────┐                            |
| │ [Thumb1] │  │ [Thumb2] │   (1枚目に「代表」バッジ)  |
| │ [代表][×]│  │ [←][→][×]│                            |
| └──────────┘  └──────────┘                            |
| キャプション: [ 河童橋からの穂高連峰____________ ]    |
+-------------------------------------------------------+
```

#### B. 詳細シート内サムネイル ＆ ライトボックス（`SpotDetailSheet.tsx` / `PhotoLightbox.tsx`）

```text
詳細シート各ログカード内:
  [訪問] 📅 2025/10/10 〜 2025/10/12
  紅葉が最高だった。
  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────────────┐
  │ IMG1 │ │ IMG2 │ │ IMG3 │ │ ☁️ 未取得(2)  │
  └──────┘ └──────┘ └──────┘ │ [読み込む]   │
                             └──────────────┘

拡大ライトボックス (<dialog class="visit-lightbox">):
+---------------------------------------------------------------+
|  2 / 5   2025/10/11 10:24                [保存/共有]   [×]    |
|                                                               |
|    [◀]              【 1600px 拡大画像 】              [▶]    |
|                                                               |
|  「河童橋からの穂高連峰」                                     |
+---------------------------------------------------------------+
```

#### C. 同期ダイアログ追加要素（`CloudSyncDialog.tsx`）

```text
クラウド同期セクション内:
  ┌──────────────────────────────────────────────────────┐
  │ 写真キャッシュ状況: 端末に 42 枚保存中（約 11.4 MB）    │
  │ 端末全体ストレージ使用量（目安）: 18.2 MB / 2.1 GB     │
  │ [ ☁️ 未取得の写真をすべてダウンロード (18枚 / 約 5.2MB) ]│
  └──────────────────────────────────────────────────────┘
  ※ 同期中プログレス: 「写真をアップロード中 (3 / 8)...」 / [中断]

ローカル JSON バックアップセクション内:
  ※ 写真ファイル本体は JSON には含まれません。写真の引き継ぎには
     Google Drive 保存をご利用ください。
```

### 6.2 コンポーネント設計詳細

1. **`PhotoPickerField.tsx`**:
   - ファイルドロップゾーン + `<input type="file" accept="image/*" multiple>`（`capture` なし）。
   - 選択・圧縮処理中はスピナー表示および送信ボタン一時無効化（`onProcessingChange` で `SpotForm` と `useUpdateBlocker` へ伝搬）。
   - サムネイルごとの並び替えボタン（`前へ` / `次へ`）、削除ボタン、選択中の写真のキャプション入力欄（`maxLength={200}`、16px 以上フォントで iOS 自動ズーム防止）。
   - EXIF 撮影日提案バナーは、現在表示中のログから取得した撮影日とフォーム日付を比較し、ユーザーが「反映する」を押したときのみ `SpotForm` の `precision='day'`, `startVal`, `useRange`, `endVal` を更新する。
2. **`SpotDetailSheet.tsx`**:
   - ログ表示時、その地点に属する「ローカル未保存かつ `driveFileId` あり」の写真があり、`hasActiveMemoryToken()` が `true` であれば `useEffect` で `ensurePhotoCached` を順次呼び出して自動取得する（一覧カード側では発火しない）。
   - 未接続で未取得写真がある場合は、ログのサムネイル枠または上部に「Drive から写真を読み込む（N枚）」ボタンを表示し、タップでサインイン＆取得を実行する。
   - 1 つ以上のサムネイルがタップされたら `PhotoLightbox` を開く（対象ログの写真配列と開始インデックスを渡す）。
3. **`PhotoLightbox.tsx`**:
   - ネイティブ `<dialog>`（`showModal()` + `closedby="any"` + Safari 向け pointerdown/up 外側タップクローズフォールバック）を採用し、`CloudSyncDialog.tsx` と同じアクセシビリティ基準を満たす。
   - `useUpdateBlocker(isOpen)` を呼び出し、閲覧中の不意の SW リロードを抑止。
   - キーボード操作：`ArrowLeft` / `ArrowRight` で前後切替、`Escape` でクローズ。
   - タッチ操作：水平スワイプ（しきい値 `45px`）で前後切替。
   - 「保存 / 共有」ボタン：モバイルで `navigator.canShare({ files: [file] })` 対応なら `navigator.share`、PC 等は `<a download>` でダウンロード。
   - 拡大対象写真がローカル未保存かつ `driveFileId` ありの場合は、ライトボックス内でもローディング表示してオンデマンド取得・即座に表示する。
4. **`SpotNavDrawer.tsx`**:
   - 一覧の各地点について、`spot.entries` を走査して最新ログの先頭写真（代表写真）と総写真枚数を算出。
   - 代表写真のサムネイルは `usePhotoObjectUrl(coverPhotoId, 'thumb', { localOnly: true })` で取得し、**IndexedDB にローカル保存済みの場合のみ表示**（未キャッシュ時は総写真枚数バッジとカメラ/写真アイコンプレースホルダのみ表示し、Drive API への自動一斉リクエストを一切行わない）。
   - キーワード絞り込み条件（112〜117 行目・154〜160 行目）に `spot.entries.some((e) => e.photos.some((p) => p.caption?.toLowerCase().includes(q)))` を追加。

---

## 7. セキュリティ・プライバシー・診断イベント設計

### 7.1 セキュリティ・プライバシー設計

1. **入力・画像無害化（XSS / 悪性ファイル対策）**:
   - SVG 拒否（MIME・拡張子・マジックバイト `<svg` 検査）。
   - Canvas 再描画・再エンコードにより、元の画像ファイルに含まれる埋め込みスクリプト・不正チャンク・EXIF GPS・撮影機材情報を完全に削除する。
   - 写真キャプションやファイル名は React のテキストノードで描画し、`dangerouslySetInnerHTML` は絶対に使用しない。
2. **CSP（Content-Security-Policy）方針**:
   - `docs/basic_design.md` §7.1 の CSP 想定に `img-src 'self' blob: data:` を明記する（生成した `blob:` Object URL および Canvas 描画に必要な範囲のみ許可し、任意の外部画像 URL は読み込まない）。
3. **3D 視点共有 URL 原則の維持**:
   - `src/lib/urlSync.ts` の `buildUrlSearchParams` / `buildPublicShareUrl` には一切写真フィールドを追加しない。
4. **`/privacy` ページ更新内容（`src/components/StaticPolicyPage.tsx`）**:
   - 第 1 項・第 2 項・第 3 項に以下を反映する：
     - 添付写真はお客様のブラウザ内でリサイズ・圧縮および EXIF 位置情報等のメタデータ除去を行ったうえで、端末内 IndexedDB およびお客様自身の Google Drive（`3D Visit Record/photos/`）にのみ保存され、開発者のサーバーへ送信されないこと。
     - 写真ファイル内の撮影日時（EXIF）は訪問日の入力補助のため端末内でのみ参照し、GPS 座標等の位置情報タグは読み取りおよび保存画像への保持を行わないこと。

### 7.2 診断イベント拡張（`src/lib/diagnostics.ts`）

`DiagnosticEvent['operation']` に `'photo-read' | 'photo-write' | 'photo-sync'` を追加し、失敗時（デコードエラー、容量超過、Drive 同期失敗）の原因切り分けをプライバシー非含有（ファイル名や座標を含めないバイト数・枚数・結果種別のみ）で記録します。

---

## 8. テスト戦略・実装フェーズ計画

### 8.1 単体テスト計画（Vitest + `happy-dom` + `fake-indexeddb`）

| テストファイル | 主な検証ケース |
| :--- | :--- |
| `tests/photo_exif.test.ts` | JPEG APP1（LE / BE）および WebP EXIF チャンクからの `DateTimeOriginal` 抽出、壁時計日付ズレ防止、GPS タグ無視、複数写真からの期間提案生成、破損バイナリ時の安全 `null` 返却 |
| `tests/photo_processor.test.ts` | SVG（MIME / 拡張子 / 内容 `<svg`）拒否、25 MB 超過拒否、拡大禁止（小画像の原寸維持）、1,600px/320px リサイズ比率、WebP→PNG フォールバック検知時の JPEG 再エンコード、SHA-256 算出 |
| `tests/photo_storage.test.ts` | `saveSpotsWithPhotosAtomic` の単一 Tx 原子的書き込み、Undo スナップショットに参照が残る間の GC 保護、`restoreUndoSnapshot` 後の写真復活、参照消滅後の自動 GC、`QuotaExceededError` 時の既存データ保護 |
| `tests/visit_merge.test.ts`（拡張） | `photoSyncVersion: 2` 指定時の写真全削除同期（旧写真が残らないこと）、v1 旧データ取り込み時の空配列保護維持、キャプション・並び替え更新マージ、`MergePreview` の写真増減集計、不正 `caption` / `fileName`（`../`）拒否 |
| `tests/google_drive_client.test.ts`（拡張） | `photos/` フォルダ作成、`nextPageToken` 複数ページ全件取得、`multipart/related` Blob アップロード、Drive 写真ゴミ箱移動（`PATCH { trashed: true }`） |
| `tests/photo_sync_manager.test.ts` | 競合検知優先（競合時に写真を UL しない）、並列上限 3、SHA-256 重複再利用、途中失敗からのレジューム（取得済み `driveFileId` 保持）、JSON 保存成功後の自動ゴミ箱移動、オンデマンド取得の同時呼出合流、404 時の無限リトライ防止、一括 DL の中断・再開 |

### 8.2 E2E テスト計画（Playwright / `e2e/app_core.spec.ts` 拡張または `e2e/photos.spec.ts` 新設）

- モック Google Drive v3 バックエンドへ `photos/` フォルダ、multipart Blob 受信、`alt=media` バイナリ返却、`PATCH trashed: true` ゴミ箱フラグ更新を追加し、以下を一気通貫で検証する：
  1. 訪問済み登録・再訪追加フォームで画像ファイル（EXIF 撮影日付き JPEG / PNG）を複数添付 → 撮影日反映提案タップ → 保存 → リロード後も詳細シート・一覧カードにサムネイルが表示される。
  2. サムネイルクリックでライトボックスが開き、前後切替・キャプション表示・Esc 閉じが動作する。
  3. SVG ファイルや 6 枚目の追加を試みた際、保存を壊さず適切なエラー案内が表示される。
  4. 「Google Drive に保存」実行で `photos/` へ画像がアップロードされ、`visit-records.json` 保存後に削除済み写真が自動で Drive ゴミ箱（`trashed: true`）へ移動される。
  5. 別セッション（ローカル IndexedDB 空）から「Drive から復元」した直後はメタデータのみ復元され、詳細シートを開くとオンデマンドで写真が取得表示されること、および同期ダイアログの「未取得の写真をすべてダウンロード」が動作すること。
  6. 端末 A で写真を全削除して Drive 保存 → 端末 B でマージ復元して写真が消えること → 「元に戻す（Undo）」で削除前写真ごと復活すること。
  7. 3D 視点共有 URL に写真情報が含まれないこと、`/privacy` に写真関連記述が表示されること。

### 8.3 段階的実装フェーズ計画

| Phase | マイルストーン | 主な作業内容 |
| :--- | :--- | :--- |
| **Phase 1** | データ基盤・画像処理・ローカル永続化 | `visit.ts` / `spotDomain.ts` 更新、`photoExif.ts` / `photoProcessor.ts` / `photoStorage.ts` / `photoUrlCache.ts` 実装、`visitStorage.ts` 原子的書き込み・Undo 保護・GC 連携、単体テスト整備 |
| **Phase 2** | 添付・閲覧・一覧 UI 実装 | `PhotoPickerField.tsx` / `PhotoLightbox.tsx` 新設、`SpotForm.tsx` / `SpotDetailSheet.tsx` / `SpotNavDrawer.tsx` / `App.tsx` 統合（一覧キャプション検索含む） |
| **Phase 3** | Google Drive 写真同期・オンデマンド・自動整理 | `googleDriveClient.ts` 拡張（ページネーション・Blob UL/DL・ゴミ箱移動）、`photoSyncManager.ts` 実装、`CloudSyncDialog.tsx` 進捗・一括 DL・ストレージ表示統合 |
| **Phase 4** | マージ刷新・プライバシー・診断仕上げ | `visitMerge.ts` v2 マージ仕様対応、`StaticPolicyPage.tsx`（`/privacy`）更新、`diagnostics.ts` 拡張、Service Worker 更新ブロッカー連動確認 |
| **Phase 5** | 総合テスト & 実機（iOS Safari / PC）検証 | Vitest 全件・Playwright E2E 実行、iOS Safari 実機での JPEG フォールバック・メモリ負荷・PWA セーフエリア動作確認 |

### 8.4 v2.1 以降の将来拡張メモ：Google Picker API 連携

将来的に「既に Google Drive 上に保存している写真」をアプリ内ボタンから直接選択・登録したい場合は、v2.0 のデータモデルや同期ロジックを変更せず、以下の方式で安全に拡張できます：

1. **非機密スコープ維持（CASA 審査不要）**: `drive.readonly` 等の制限スコープは追加せず、現行の `https://www.googleapis.com/auth/drive.file` 単一スコープのまま **Google Picker API**（環境変数 `VITE_GOOGLE_API_KEY` + `VITE_GOOGLE_APP_ID`）を利用し、ユーザーがモーダルで明示選択したファイルのみアクセス権を取得する。
2. **取り込み圧縮方式（直接参照しない）**: 選択された Drive ファイルをそのまま ID 参照するのではなく、ブラウザへ一時ダウンロードしたうえで v2.0 の `photoExif` / `photoProcessor` パイプラインに通し、1,600px 圧縮・EXIF GPS 除去済みの別画像として `3D Visit Record/photos/` へ取り込み保存する。これにより、元ファイルの整理・移動・削除によるリンク切れと、自動ゴミ箱整理の誤爆を構造的に防げる。
3. **環境制約に応じた段階表示**: iOS Safari / スタンドアロン PWA では ITP（サードパーティ Cookie 制限）により Picker iframe が動作不安定になりやすいため、環境変数設定時かつ PC / 非 iOS PWA 環境向けの補助ボタンとして段階表示し、モバイルでは OS 標準ファイル選択（`<input type="file">`）経由での Drive 写真選択を基本導線とする。
