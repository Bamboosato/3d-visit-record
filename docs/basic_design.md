# 3D Visit Record 初版 基本設計書

## 1. システムアーキテクチャ設計

### 1.1 全体構成（サーバーレス SPA）
本システムは開発者側のバックエンドサーバーおよび専用データベースを持たず、Vercel から静的アセット（HTML / JS / CSS / PWA Assets）を配信する **サーバーレス SPA（Single Page Application）** として構成します。ユーザーの訪問記録は端末内 **IndexedDB** を正（Primary Store）とし、クラウド保存・復元にはユーザー自身の **Google Drive** を利用します。

```text
[ Vercel Edge Network ]  ──(静的配信: Vite Build)──>  [ エンドユーザー ブラウザ (PWA) ]
   (vercel.json SPA Rewrite / Cache-Control)                  │
                                                             ├── UI層: React + Tailwind CSS + View Transitions API
                                                             │     ├── / (メイン地図・記録画面)
                                                             │     ├── /privacy (プライバシーポリシー)
                                                             │     └── /terms   (利用規約・クレジット)
                                                             │
                                                             ├── 3D描画層: MapLibre GL JS (WebGPU優先 / WebGL2)
                                                             │     ├── AW3D30 全球DEM (jaxa-aw3d:// + OPFS SWR)
                                                             │     ├── ベースマップ (opfs-raster://: OSM / Esri / 地理院)
                                                             │     └── GeoJSON + Symbol/Circle GPU レイヤー (最大1,000地点)
                                                             │
                                                             ├── 位置・地名検索層 (明示操作トリガ)
                                                             │     ├── OSM Nominatim (全球検索 / 逆ジオコーディング)
                                                             │     ├── OSM Overpass API (周辺施設・ランドマーク候補)
                                                             │     └── 国土地理院 地名検索API (日本国内補完)
                                                             │
                                                             ├── ローカル永続層: IndexedDB (visit3d_db)
                                                             │     ├── app_state: 全地点・ログ・1世代Undo・同期メタ
                                                             │     └── photos   : [v2予約] 画像Blobストア
                                                             │
                                                             └── クラウド同期層: GIS Token Client + Fetch REST API
                                                                   └── Google Drive API v3 (drive.file 単一スコープ)
                                                                         └── マイドライブ / 3D Visit Record /
                                                                               ├── visit-records.json
                                                                               ├── snapshots/ (直近5世代退避)
                                                                               └── photos/    ([v2予約])
```

### 1.2 技術スタックおよび `3d_rain_viewer` からのモジュール対照表

- **ベーススタック**: Vite 6系 + React 19 + TypeScript + Tailwind CSS + MapLibre GL JS + `lucide-react` + Vitest + Playwright（`3d_rain_viewer` に準拠）

| 区分 | `3d_rain_viewer` のモジュール / 資産 | `3d_visit_record` での扱い | 設計変更・刷新内容 |
| :--- | :--- | :--- | :--- |
| **移植・拡張** | `src/lib/maplibreHelper.ts` | 移植・全球拡張 | `minZoom: 1.5`, `maxZoom: 18` へ拡張。地理院タイル海外404透過フォールバック追加 |
| **移植・縮小** | `src/lib/jaxaClient.ts` | 移植・AW3D30専用化 | GSMaP / 降水インスペクタ関連を削除。`fetchPointElevationFromAW3D` の経緯度クランプ（緯度 ±82°）実装 |
| **移植** | `src/lib/opfsTileCache.ts`, `asyncLifecycle.ts`, `viewTransition.ts`, `updateGuard.ts`, `diagnostics.ts` | そのまま移植（接頭辞整理） | `rain3d-*` イベント名・キャッシュ名等を `visit3d-*` へリネーム |
| **移植・拡張** | `src/lib/osmPlaceClient.ts` | 移植・全球対応化 | Nominatim `countrycodes=jp` 制限解除、多言語名称フォールバック、海外 `addressSummary` 生成、百名山近傍判定の日本BBox限定 |
| **移植** | `src/lib/hyakumeizanData.ts` | そのまま移植 | 全 100 座データを継承し、登録済み地点との達成状況照合に利用 |
| **移植・拡張** | `src/lib/favoriteCategories.ts` | `spotCategories.ts` として刷新 | `nature` / `tourism` / `lifestyle` / `other` を継承し、`visited` / `planned` の 2 状態用スプライト生成を追加 |
| **刷新** | `src/lib/favoritesStorage.ts` | `visitStorage.ts` として刷新 | IndexedDB（`visit3d_db`）を唯一の正とする原子的保存へ統一（`localStorage` 5MB制限回避） |
| **刷新** | `src/lib/favoritesTransfer.ts` | `visitMerge.ts` / `visitTransfer.ts` | ログ単位マージ、From-To 日付検証、Drive JSON 入出力、`3d_rain_viewer` JSON 取込変換を新設 |
| **新規** | — | `googleAuth.ts`, `googleDriveClient.ts` | GIS Token Client 認証 + Drive REST API v3 クライアント + 競合検知・スナップショット退避 |
| **削除** | `jmaNowcastClient.ts`, `pointTimeseriesClient.ts`, `weatherRequests.ts`, `frameBudget.ts`, `TimelineBar.tsx`, `RainfallChart.tsx`, `Legend.tsx` | 移植しない | 気象・時系列降水機能を完全排除 |

---

## 2. データモデル・スキーマ設計

### 2.1 中核型定義（`src/types/visit.ts`）

```ts
export type SpotStatus = 'visited' | 'planned';
export type SpotCategory = 'nature' | 'tourism' | 'lifestyle' | 'other';
export type VisitDatePrecision = 'day' | 'month' | 'year' | 'none';

export interface VisitDate {
  precision: VisitDatePrecision;
  /**
   * precision に応じた開始値:
   * - 'day'  : 'YYYY-MM-DD'
   * - 'month': 'YYYY-MM'
   * - 'year' : 'YYYY'
   * - 'none' : undefined
   */
  start?: string;
  /**
   * From-To 期間指定時の終了値（precision !== 'none' のとき任意）。
   * start と同じ精度であり、検証時に end >= start を満たすこと。
   * end === start の場合は正規化時に省略（undefined）とする。
   */
  end?: string;
}

/** v2以降の写真添付メタデータ（初版は常に photos: [] を保持し、前方互換を維持） */
export interface PhotoAttachment {
  id: string;                 // UUID v4
  fileName: string;           // 例: "<photoId>.webp"
  mimeType: 'image/webp' | 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
  caption?: string;
  takenAt?: string;           // ISO 8601
  driveFileId?: string;       // Drive上の photos/ 内ファイルID
  checksumSha256?: string;    // 重複アップロード防止用
}

export interface VisitEntry {
  id: string;                 // UUID v4
  kind: SpotStatus;           // 'visited' | 'planned'
  date: VisitDate;
  memo: string;               // 複数行テキスト（最大 2,000 文字）
  photos: PhotoAttachment[];  // 初版は空配列 []
  createdAt: string;          // ISO 8601
  updatedAt: string;          // ISO 8601
}

export interface SpotCamera {
  zoom: number;               // 1.5 〜 18.0
  pitch: number;              // 0 〜 85
  bearing: number;            // -180 〜 180
}

export interface VisitSpot {
  id: string;                 // UUID v4
  name: string;               // 最大 80 文字
  status: SpotStatus;         // 地点の主ステータス ('visited' | 'planned')
  category: SpotCategory;
  center: [number, number];   // [lng, lat]
  elevation: number | null;   // メートル (AW3D30)、範囲外や未取得は null
  camera: SpotCamera;
  addressSummary?: string;    // 例: "長野県松本市" / "Paris, France" (最大 120 文字)
  presetId?: string;          // 例: 百名山プリセットIDとの紐付け
  isPinned: boolean;
  entries: VisitEntry[];      // 訪問・予定ログ (1〜50件)
  createdAt: string;          // ISO 8601
  updatedAt: string;          // ISO 8601
}

export interface VisitBackupEnvelope {
  app: '3d-visit-record';
  kind: 'visit-records';
  schemaVersion: 1;
  exportedAt: string;         // ISO 8601
  revision: number;           // 単調増加リビジョン
  count: number;
  items: VisitSpot[];
}

export interface DriveSyncMeta {
  folderId: string | null;
  fileId: string | null;
  lastSyncedRevision: number | null;
  lastDriveModifiedTime: string | null;
  lastDriveHeadRevisionId: string | null;
  lastSyncedAt: string | null;
  accountEmail: string | null;
}

export interface LocalAppState {
  version: 1;
  revision: number;
  spots: VisitSpot[];
  undo: {
    savedAt: string;
    reason: 'drive-restore' | 'json-import';
    spots: VisitSpot[];
  } | null;
  driveSync: DriveSyncMeta;
  lastLocalExportAt: string | null;
}
```

### 2.2 制限値・バリデーション定数

| 定数名 | 値 | 備考 |
| :--- | :--- | :--- |
| `MAX_SPOTS` | `1,000` | 登録地点の上限 |
| `MAX_ENTRIES_PER_SPOT` | `50` | 1 地点あたりの訪問／予定ログ上限 |
| `MAX_SPOT_NAME_LENGTH` | `80` | 制御文字（`\u0000-\u001f`, `\u007f`）不可、前後空白トリム |
| `MAX_ADDRESS_SUMMARY_LENGTH` | `120` | 制御文字不可 |
| `MAX_MEMO_LENGTH` | `2,000` | 改行（`\n`）は許可、`\0` 等の制御文字は除去または拒否 |
| `MAX_BACKUP_FILE_BYTES` | `16 * 1024 * 1024` (16 MiB) | 1,000 地点 × 50 ログ × メモ＋メタデータを余裕をもって許容 |
| `SAME_COORDINATE_TOLERANCE_DEG` | `0.0005`（約 50m） | 重複地点判定・マージ突き合わせ基準 |

### 2.3 日付・From-To 期間の詳細仕様

#### A. 入力検証・正規化規則
| `precision` | `start` 形式・検証 | `end` 形式・検証 | 正規化ルール |
| :--- | :--- | :--- | :--- |
| `'day'` | `^\d{4}-\d{2}-\d{2}$` かつカレンダー上の実在日（例: `2026-02-30` は不可） | 任意。指定時は実在日かつ `end >= start` | `end === start` の場合 `end` を削除 |
| `'month'` | `^\d{4}-\d{2}$`（月 `01`〜`12`） | 任意。指定時は同一形式かつ `end >= start` | `end === start` の場合 `end` を削除 |
| `'year'` | `^\d{4}$`（`1900`〜`2100`） | 任意。指定時は同一形式かつ `end >= start` | `end === start` の場合 `end` を削除 |
| `'none'` | `undefined`（強制クリア） | `undefined`（強制クリア） | `start` / `end` を持たない |

#### B. 表示フォーマット・ソートキー・期間オーバーラップ判定

| 種別 | 格納例 | 表示例 | 比較用区間 `[rangeStart, rangeEnd]`（`YYYYMMDD` 数値または文字列） |
| :--- | :--- | :--- | :--- |
| 単日 | `{ precision: 'day', start: '2026-08-15' }` | `2026/08/15` | `['20260815', '20260815']` |
| 日期間 | `{ precision: 'day', start: '2026-08-14', end: '2026-08-16' }` | `2026/08/14 〜 2026/08/16` | `['20260814', '20260816']` |
| 単月 | `{ precision: 'month', start: '2025-10' }` | `2025年10月` | `['20251001', '20251031']` |
| 月期間 | `{ precision: 'month', start: '2025-09', end: '2025-10' }` | `2025年9月 〜 2025年10月` | `['20250901', '20251031']` |
| 単年 | `{ precision: 'year', start: '2019' }` | `2019年` | `['20190101', '20191231']` |
| 年期間 | `{ precision: 'year', start: '2018', end: '2020' }` | `2018年 〜 2020年` | `['20180101', '20201231']` |
| 未定 | `{ precision: 'none' }` | `時期未定` | フィルタ「すべて」のみ一致、ソート時は末尾 |

- **年・期間フィルタのオーバーラップ判定**:
  - 例として年 `Y`（区間 `[Y0101, Y1231]`）で絞り込む場合、ログの区間が `rangeStart <= Y1231 && rangeEnd >= Y0101` を満たせば一致とみなす。これにより、`2025/12/29 〜 2026/01/03` の年跨ぎ旅行が **2025 年・2026 年の双方で漏れなくヒット** する。
- **一覧ソート規則（訪問/予定日順）**:
  - 各スポットの代表日付キーは、現在のステータスフィルタが「訪問予定」なら `kind === 'planned'` のログ群から、それ以外は全ログから最新の `rangeStart`（`none` は除外）を採用する。日付を持たない（`none` のみ）スポットは常に日付付きスポットの後ろに配置し、`updatedAt` 降順で並べる。

### 2.4 地点ステータス（`spot.status`）と複数ログ（`entries`）の整合ルール

1. **主ステータスの決定**:
   - 初回登録時は入力されたログの `kind`（`'visited'` または `'planned'`）がそのまま `spot.status` になる。
   - ログの追加・編集・削除時に `entries` に 1 件以上の `'visited'` ログが存在すれば `spot.status = 'visited'` とし、`'visited'` ログが 0 件で `'planned'` ログが存在する場合は `spot.status = 'planned'` へ自動同期する。
2. **「訪問済み ＋ 再訪予定あり」のハイブリッド地点の扱い**:
   - すでに訪問した地点に将来の再訪予定（`kind: 'planned'`）を追加した場合、`spot.status` は `'visited'` を維持しつつ、詳細シートおよび一覧カードに **「再訪予定あり」サブバッジ** を表示する。
   - **フィルタ規則**:
     - マップ／一覧の `訪問済み` フィルタ: `spot.status === 'visited'` に一致。
     - マップ／一覧の `訪問予定` フィルタ: `spot.status === 'planned' || spot.entries.some(e => e.kind === 'planned')` に一致（再訪予定の計画確認時に見落とさない）。
3. **「訪問予定 → 訪問済み」ワンタップ遷移**:
   - `planned` のログ詳細（またはスポットヘッダー）にある「訪問済みにする」を押下すると、デフォルトで本日の日付（`precision: 'day'`, `start: 今日`）を初期値とした確定モーダル（またはインラインフォーム）を開き、日付・期間・感想メモを編集して保存することで対象ログの `kind` を `'visited'` へ更新し、`spot.status = 'visited'` へ遷移させる。

### 2.5 将来の写真機能（v2）に向けた前方互換設計

- 初版（v1）では UI 上の写真アップロード機能を提供しないが、すべての `VisitEntry` を `photos: []` 付きで保存する。
- インポート・Drive 復元・マージロジックは、`PhotoAttachment` オブジェクトを検証したうえでそのまま保持する（将来 v2 で写真を追加した後に v1 端末からテキストメモを編集・保存しても、既存の `photos` メタデータを消去・破損させない）。
- 画像バイナリを JSON へ混ぜないため、`visit-records.json` は 1,000 地点でも数百 KB〜数 MB 程度に収まり、高速なパースと同期を維持できる。

---

## 3. ローカルストレージ設計（IndexedDB）

### 3.1 IndexedDB データベース構成（`visit3d_db`）
`3d_rain_viewer` の二重保存（`localStorage` ＋ `IndexedDB`）は 1,000 地点×複数メモにおいて `localStorage` の約 5MB クォータに抵触する恐れがあるため、**本アプリでは IndexedDB を記録データの唯一の永続ストア** とし、`localStorage` は軽量な UI 環境設定（選択中のベースマップ、標高強調倍率、既定のフィルタタブ等、数百バイト）に限定する。

| Store 名 | Key | 用途 | 対象バージョン |
| :--- | :--- | :--- | :--- |
| `app_state` | `'primary'` | `LocalAppState` 全量を単一レコードとして格納（地点・ログ・1世代Undo・Drive同期メタ） | 初版（v1） |
| `photos` | `photoId` (UUID) | 圧縮済み画像 Blob（`{ blob, thumbnailBlob, updatedAt }`）を格納 | v2 予約（空ストアとしてスキーマ作成可） |

### 3.2 原子的コミット・直列化・破損保護
1. **単一レコード原子的コミット**: `app_state` の `'primary'` キーに `LocalAppState` 全体を 1 トランザクションで書き込むことで、地点リスト・Undo・Drive 同期メタのズレ（半端な状態）を防止する。
2. **直列化キュー（`operationQueue`）**: すべての書き込み・Drive 復元・Undo 処理は Promise キューに積んで直列実行し、連続操作や復元中のレースコンディションを排除する。
3. **破損保護（`storageBlocked`）と救済**: 起動時の読み出しで JSON/構造検証に失敗した場合、自動的に `storageBlocked = true` として以降の自動上書きをロックし、警告バナーとともに IndexedDB の生データを JSON ファイルとして救済ダウンロードできるボタンを表示する。
4. **ストレージ永続化**: 初回地点保存時に `navigator.storage?.persist()` を呼び出し、ブラウザによる自動ストレージ削除リスクを低減する。

---

## 4. Google Drive 連携・認証・同期設計

### 4.1 認証方式（Google Identity Services）
- 外部スクリプト `https://accounts.google.com/gsi/client` を利用し、`google.accounts.oauth2.initTokenClient` でブラウザ内から OAuth 2.0 アクセストークンを取得する。
- **要求スコープ**: `https://www.googleapis.com/auth/drive.file` **のみ**（非機密 Non-Sensitive スコープ）。
- **トークン保管**: 取得した `access_token` と有効期限（`expiresAt`）は **JavaScript メモリ内のみ** に保持し、`localStorage` / `sessionStorage` / IndexedDB には保存しない。
- **アカウント識別表示**: トークン取得直後に `GET https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,photoLink)` を呼び出し、UI に接続中ユーザー名・メールアドレスを表示する（`about.get` は `fields` パラメータ指定が必須）。
- **サインアウト / アカウント切替**: `google.accounts.oauth2.revoke(token)` を呼び出してメモリ上のトークンおよび `driveSync.accountEmail` 等をクリアする（ローカルの地点データは保持される）。

### 4.2 Google Drive 上のフォルダ・ファイル構成

ユーザー自身のマイドライブ直下に専用フォルダを 1 つ作成し、`appProperties` メタデータで一意に識別する（ユーザーがリネームしても追跡可能）。

```text
マイドライブ /
└── 3D Visit Record /                    # mimeType: application/vnd.google-apps.folder
      │                                  # appProperties: { app: "3d-visit-record", role: "root" }
      ├── visit-records.json             # 最新の全地点・訪問/予定ログデータ (VisitBackupEnvelope)
      │                                  # appProperties: { app: "3d-visit-record", role: "records", schemaVersion: "1" }
      ├── snapshots/                     # 上書き保存時の自動退避先フォルダ
      │     │                            # appProperties: { app: "3d-visit-record", role: "snapshots" }
      │     └── visit-records-20261119-173000.json  # 直近最大 5 世代を保持（超過分は古い順に削除）
      └── photos/                        # [v2予約] 写真ファイル保管用フォルダ
                                         # appProperties: { app: "3d-visit-record", role: "photos" }
```

### 4.3 使用する Google Drive REST API v3 エンドポイント一覧

| 用途 | HTTP メソッド & エンドポイント | 主なパラメータ・説明 |
| :--- | :--- | :--- |
| 接続アカウント情報取得 | `GET /drive/v3/about` | `fields=user(displayName,emailAddress,photoLink)` |
| フォルダ／ファイル検索 | `GET /drive/v3/files` | `q="trashed = false and appProperties has { key='app' and value='3d-visit-record' } and appProperties has { key='role' and value='...' }"`、`fields=files(id,name,modifiedTime,headRevisionId,size,appProperties)` |
| フォルダ新規作成 | `POST /drive/v3/files` | `mimeType: application/vnd.google-apps.folder` + `appProperties` |
| 新規ファイル作成 (multipart) | `POST /upload/drive/v3/files?uploadType=multipart` | JSON メタデータ（`parents`, `appProperties`）＋ JSON 本文 |
| 上書き保存 (multipart) | `PATCH /upload/drive/v3/files/{fileId}?uploadType=multipart` | `fields=id,modifiedTime,headRevisionId,size` |
| メタデータ事前確認（競合検知） | `GET /drive/v3/files/{fileId}` | `fields=id,name,modifiedTime,headRevisionId,trashed` |
| レコード本体取得 | `GET /drive/v3/files/{fileId}?alt=media` | `visit-records.json` の中身を取得 |
| スナップショット削除（5世代超過） | `DELETE /drive/v3/files/{fileId}` | `snapshots/` 内が 5 件を超えた場合に最古ファイルを削除 |

### 4.4 保存シーケンス＆競合検知フロー

1. ローカルから「Google Drive に保存」を押下（未認証なら GIS サインインを実行）。
2. `appProperties`（`role='root'`, `role='records'`）で既存フォルダ・`visit-records.json` を検索。
   - **Drive 上にファイルがまだない場合**: フォルダを作成し `visit-records.json` を新規アップロード（`POST`）。完了後 `driveSync` メタを更新。
   - **Drive 上にファイルがすでに存在する場合**:
     1. 現在の Drive メタデータ（`modifiedTime`, `headRevisionId`）を取得し、さらに必要に応じ中身（`revision`）を確認。
     2. ローカル保持の `driveSync.lastDriveModifiedTime`（または `lastDriveHeadRevisionId`）と **一致する**（他端末で変更されていない）、あるいは初回連携で「ローカル優先」を明示選択済みの場合：
        - 現在の Drive ファイルを `snapshots/visit-records-YYYYMMDD-HHmmss.json` にコピー/保存（5世代ローテーション）。
        - 新しい `VisitBackupEnvelope` を `PATCH` で上書きアップロードし、`driveSync` を更新。
     3. Drive 側が **他端末によって更新されている場合（競合検知）**：
        - 上書きを即時実行せず **競合解決ダイアログ** を表示し、以下の 2 択を提示する：
          - **「先に Drive の変更を取り込んでマージする（推奨）」**: 復元＆マージフローへ遷移し、統合結果を再保存する。
          - **「ローカルの内容で Drive を上書きする」**: 現在の Drive 内容を `snapshots/` へ退避したうえで強制上書きする。

### 4.5 復元シーケンス＆マージアルゴリズム

1. Drive 上の `visit-records.json` を取得し、`VisitBackupEnvelope` を厳格検証する（`app === '3d-visit-record'`, `schemaVersion <= 1`, 各 `VisitSpot` / `VisitEntry` / `VisitDate` の形式・上限検証）。
2. **復元モード選択と差分プレビュー**:
   - **`merge`（推奨・既定）**:
     1. 同一地点判定: `spot.id` 一致、または `isSameCoordinate(a.center, b.center, 0.0005)`（約 50m 以内）で対応付け。
     2. 地点メタ情報（`name`, `status`, `category`, `camera`, `addressSummary`, `isPinned`）: `spot.updatedAt` が新しい方を採用（ただし既存ローカル ID を維持）。
     3. **`entries` ログ統合（重要）**: 双方の `entries` を `entry.id` 単位で **和集合マージ** する。同一 `entry.id` は `entry.updatedAt` が新しい方を採用する。これにより「PC で A 地点に再訪ログを追加、スマホで同じ A 地点に別のメモを追記」しても双方が消えずに統合される。統合後の `spot.status` は整合ルール（2.4節）で再計算し、`MAX_ENTRIES_PER_SPOT`（50件）を超えた場合は日付/更新日時新しい順で上限内保持する（切り捨て時は事前プレビューに警告表示）。
     4. 双方にのみ存在する新規スポットを追加し、`MAX_SPOTS`（1,000件）上限内で統合する。
   - **`replace`（置き換え）**:
     - Drive の `items` でローカルの `spots` を完全置換する。
   - 適用前に **差分プレビュー（追加件数・更新件数・ログ追記件数・変更なし・削除件数）** を UI に表示してユーザーの確定を得る。
3. **1 世代 Undo 退避**: 適用直前のローカル `spots` を `LocalAppState.undo` に 1 トランザクションで保存してから差し替える。復元完了後もダイアログおよび通知から「元に戻す（Undo）」を実行可能。

### 4.6 異常系・エラーハンドリング

| 事象 / HTTP コード | 想定原因 | 挙動・ユーザー案内 |
| :--- | :--- | :--- |
| `401 Unauthorized` | アクセストークンの有効期限切れ（約1時間） | まず `requestAccessToken({ prompt: '' })` でサイレント再取得を 1 回試行し、失敗時は再サインインボタンを案内（編集データはローカル保持） |
| `403` (`storageQuotaExceeded`) | ユーザーの Google Drive 空き容量不足 | 「Google Drive の空き容量が不足しています。ローカル保存は保持されています」と表示し中断 |
| `403` / ポップアップ閉じ | ユーザーが OAuth 同意を拒否・キャンセル | 未連携状態を維持し、ローカル編集・JSON 書き出しは継続可能 |
| `404 Not Found` | ユーザーが Drive 上の `3D Visit Record` フォルダ等を手動削除 | 「Drive 上の保存ファイルが見つかりません」と通知し、保存時は新規フォルダ再作成を案内 |
| `429` / `5xx` | Drive API 一時レート制限・障害 | 指数バックオフ付きで最大 2 回リトライ後、失敗時は再試行ボタンを表示 |
| オフライン時 | 電波圏外・機内モード | Drive 同期ボタンにオフライン状態を表示。ローカル閲覧・編集は通常どおり許可 |
| `schemaVersion > 1` / 破損 JSON | 新バージョンアプリで作られたデータ / 手動改変破損 | 取込・復元を即座に中止し、ローカルデータを一切変更しない |

---

## 5. 3D地図・マーカー描画・全球検索設計

### 5.1 MapLibre GL JS 描画設定（全球対応）
- **初期化パラメータ**: `minZoom: 1.5`, `maxZoom: 18`, `maxPitch: 85`, `fadeDuration: 0`。
- **初期表示位置の解決順序**:
  1. 起動 URL に `?lat=...&lng=...` がある場合はそのカメラ視点。
  2. ローカルに登録済み地点が 1 件以上ある場合は、最後に更新／アクセスした地点、または日本全体（`[137.5, 36.2]`, `zoom: 4.8`）を表示。
  3. 初回起動時は日本の俯瞰視点（または設定で海外含む現在地移動可）を表示。

### 5.2 最大 1,000 地点対応の GPU ピン描画設計
`3d_rain_viewer` は最大 100 件を DOM `maplibregl.Marker` で描画していたが、本アプリは最大 1,000 地点（および海外を含む全地球表示）に耐えるため、**GeoJSON Source ＋ MapLibre `symbol` レイヤーによる GPU 一括描画** を採用する。

- **8 種アイコンスプライト生成（Canvas → `map.addImage`）**:
  - 4 カテゴリ（`nature` 緑系, `tourism` アンバー系, `lifestyle` インディゴ系, `other` スレート系）× 2 ステータス：
    - **訪問済み（`visited`）**: 鮮やかなカテゴリ色の **実線丸型バッジ ＋ 白抜きアイコン ＋ 濃いドロップシャドウ**。
    - **訪問予定（`planned`）**: 半透明白/暗色ベースに **カテゴリ色の破線（点線）外枠 ＋ カテゴリアイコン（または予定小バッジ）** とし、一目で「まだ行っていない予定」と識別可能にする。
- **ズーム連動と視認性制御**:
  - `zoom < 9.0`: アイコンのみ表示（`text-field` 非表示）。`symbol-sort-key` で `isPinned` や `visited` 等の優先度を指定し、広域表示での過剰な重なりを制御する。
  - `zoom >= 9.0`: アイコン下部に地点名ラベルを表示（白文字＋濃い Halo 縁取り）。
  - **タップ判定**: `map.on('click', 'visit-spots-layer', ...)` でクリックされた Feature の `spotId` を取り出し、詳細シート表示＆カメラ移動（`flyTo`）を実行する。

### 5.3 全球対応のための `3d_rain_viewer` からの変更点

| 対象 | `3d_rain_viewer` の制約 | `3d_visit_record` での対応設計 |
| :--- | :--- | :--- |
| **AW3D30 標高取得** | 日本周辺中心の想定で境界クランプなし | `fetchPointElevationFromAW3D(lng, lat)` で経度 `[-180, 180]`・緯度 `[-82, 82]` を境界クランプ。`Math.abs(lat) > 82` の極地は即座に `null` を返却しエラーにしない |
| **ベースマップ 3 種** | 国土地理院淡色地図が日本域外でタイル 404 | ① **OSM（標準・全球）を既定**、② **航空写真（Esri・全球）**、③ **地理院淡色（日本国内向け）**。`opfs-raster://hillshade/...` で 404 応答時は透明 1×1 PNG を返して MapLibre のリトライループを防止し、UI に「※日本国内向け」注記を表示 |
| **キーワード検索** | Nominatim に `countrycodes=jp` をハードコード | **`countrycodes` 制限を撤廃**し `accept-language=ja,en` で世界中の都市・施設を検索可能にする。日本語を含むクエリまたは日本周辺検索では国土地理院 API も並列検索し、結果をマージ・距離/一致度ソート |
| **周辺候補サジェスト** | Overpass で `name:ja` / `name` のみ参照、住所組立が日本前提 | `tags['name:ja'] || tags['name:en'] || tags.name` の優先順位で名称抽出。Nominatim 逆ジオコーディングの `address.country_code === 'jp'` なら「都道府県＋市区町村」、海外なら「都市/地域, 国名」へ整形 |
| **百名山近傍候補** | 常に全 100 座と距離計算 | 日本 BBox（緯度 `24°〜46°`、経度 `122°〜154°`）内の地点タップ時のみ `findNearbyHyakumeizanCandidates` を実行 |

### 5.4 外部 API 利用制限遵守と百名山プリセット連携
- **API 礼儀・流量制御**: キーワード検索は入力中の自動発火（ライブ検索）を行わず、検索ボタン押下／Enter キーでのみ発火する。連続タップ・連続検索をクライアント側スロットリング（最低間隔 1 秒＋`AbortController` による先行リクエスト中断）および 30 分メモリキャッシュで抑制する。
- **日本百名山プリセット連携**: 全 100 座について、`spot.presetId === mountain.id` または登録地点座標から `2,000m` 以内の一致を判定し、百名山タブに「踏破数（例: `12 / 100 座`）」および各山カードへの `訪問済み` / `予定` バッジを表示する。未登録の山を選択すると 3D カメラがその山頂へ移動し、詳細シートに「この山を訪問記録／予定に登録」ボタンを提示する。

---

## 6. 画面・UIコンポーネント・ルーティング設計

### 6.1 画面レイアウト（PC / モバイル共通ベース）

```text
+--------------------------------------------------------------------------------------+
| [3D Visit]                     [🔍 一覧・検索] [☁️ Drive同期●] [⚙️ 設定] [📍現在地]  |
+--------------------------------------------------------------------------------------+
|  [ すべて 32 ]  [ ✓ 訪問済み 24 ]  [ ★ 予定 8 ]        ← マップ上クイックフィルタ    |
|                                                                                      |
|                    【 WebGPU / MapLibre 3D 地形メインキャンバス 】                    |
|                                                                                      |
|        ● 訪問済みピン（実線塗り・カテゴリ色）   ◌ 訪問予定ピン（破線・予定バッジ）     |
|                                                                                      |
|  ┌──────────────────────────────────────────────┐                                    |
|  │ 📍 パリ エッフェル塔  [訪問済み] [📸 観光]    │ ← 地点詳細／記録ボトムシート       |
|  │ 📌 ピン留め  |  Paris, France  |  標高 34m    │   （スマホは画面下部・PCは左下）   |
|  │ ──────────────────────────────────────────── │                                    |
|  │ 📅 2025/09/12 〜 2025/09/15                  │                                    |
|  │    夜景が綺麗だった。次回は登頂予約を取る。   │                                    |
|  │ [＋訪問/予定を追加] [編集] [視点更新] [共有]  │                                    |
|  └──────────────────────────────────────────────┘                                    |
+--------------------------------------------------------------------------------------+
```

### 6.2 コンポーネント責務一覧

| コンポーネント名 | 主な責務 |
| :--- | :--- |
| `App.tsx` | 全体状態統合、IndexedDB 初期化・直列化操作、排他制御、Drive 未保存検知、URL 視点同期、`/privacy`・`/terms` ルーティング分岐 |
| `MapViewer.tsx` | WebGPU/WebGL2 地図生成、AW3D30 地形、GeoJSON スポットレイヤー描画（ステータスフィルタ適用）、ピンクリック・空白クリック検知 |
| `StatusFilterBar.tsx` | マップ上部に配置する `すべて` / `訪問済み` / `訪問予定` ピル切替（各件数表示） |
| `SpotDetailSheet.tsx` | 地点詳細（座標・標高・住所補助・カメラ再現・ログ一覧）表示、「訪問済みにする」ワンタップ遷移、新規登録／編集／再訪ログ追加フォーム（`SpotForm` 内包） |
| `SpotForm.tsx` | 地点名（OSM 周辺候補チップ付き）・カテゴリ・ステータス・日付/From-To 期間（`day`/`month`/`year`/`none` 切替）・複数行メモ入力とリアルタイム検証 |
| `SpotNavDrawer.tsx` | 3 タブモーダル（`登録地点`[既定] / `地名・施設検索` / `百名山`）。一覧のステータス/カテゴリ/年・期間オーバーラップ/キーワード絞り込み、ソート、件数サマリー |
| `CloudSyncDialog.tsx` | Google サインイン/サインアウト・アカウント表示、Drive 保存（競合ダイアログ含む）、Drive 復元（マージ/置き換え＋差分プレビュー）、1 世代 Undo、ローカル JSON 入出力・`3d_rain_viewer` 移行取込 |
| `LayerMenu.tsx` | 標高強調スライダー（1.0x〜3.0x）、ベースマップ切替（OSM / Esri 航空写真 / 地理院淡色[国内向け]）、設定・ヘルプ導線（`/privacy`, `/terms` リンク） |
| `StaticPolicyPage.tsx` | `/privacy`（プライバシーポリシー）と `/terms`（利用規約・免責・外部データクレジット）の静的情報画面 |

### 6.3 UI 状態制御・排他制御・URL 共有・静的ルーティング
- **モーダル / シート排他制御**: `SpotNavDrawer`、`LayerMenu`、`CloudSyncDialog` のいずれかを開く際は他を自動で閉じ、背面誤タップ防止のバックドロップを配置する。地点詳細シートは新規検索選択時に最新地点へ差し替える。
- **更新ブロッカー（`useUpdateBlocker`）**: フォーム編集中、Drive 保存/復元処理中、確認ダイアログ表示中は Service Worker の自動更新・リロードをロックし、入力中データの喪失を防ぐ。
- **共有 URL パラメータ仕様**:
  - 出力形式: `https://<公開ドメイン>/?lat=...&lng=...&z=...&p=...&b=...&map=...&ex=...&name=...`
  - **個人情報非含有の原則**: 地点の `id`、`status`、訪問日時・期間、`memo`、写真情報などの個人記録は URL パラメータへ一切含めない。共有リンクを開いた相手には 3D 地形視点と（任意で）一般地点名のみが表示される。
- **静的ページルーティング**:
  - `window.location.pathname` が `/privacy` または `/terms` の場合は地図をロードせず軽量な `StaticPolicyPage` を即時描画する（Google OAuth クローラや利用規約リンクから直接参照可能にするため、ビルド時または Vercel 配信で直アクセス可能にする）。

---

## 7. セキュリティ・プライバシー・デプロイ運用設計

### 7.1 セキュリティ・プライバシー原則 & CSP
- **Google API Services User Data Policy 準拠**: Google Drive から取得したデータおよびアカウント情報はアプリ機能（本人の訪問記録の保存・復元・表示）にのみ使用し、外部送信・広告利用・AI 学習利用を行わないことを `/privacy` に明記する。
- **XSS 対策**: ユーザー入力（地点名・メモ）および外部 API 応答（OSM 施設名・住所）はすべて React のテキスト補間または `textContent` で描画し、`dangerouslySetInnerHTML` や未サニタイズ HTML 注入を禁止する。
- **Content-Security-Policy (CSP) 想定許可オリジン**:
  - `script-src`: `'self'`, `https://accounts.google.com/gsi/client`
  - `connect-src`: `'self'`, `https://accounts.google.com`, `https://oauth2.googleapis.com`, `https://www.googleapis.com`, `https://tile.openstreetmap.org`, `https://cyberjapandata.gsi.go.jp`, `https://server.arcgisonline.com`, `https://msearch.gsi.go.jp`, `https://nominatim.openstreetmap.org`, `https://overpass-api.de`, `https://overpass.kumi.systems`, `https://data.earth.jaxa.jp`, `https://s3.ap-northeast-1.wasabisys.com`
  - `frame-src`: `https://accounts.google.com`

### 7.2 Vercel デプロイ設定（`vercel.json` / 環境変数）
- **環境変数**: `VITE_GOOGLE_CLIENT_ID`（Google Cloud Console で発行する Web クライアント ID。OAuth クライアント ID は SPA 公開値であり、**Client Secret は SPA では一切使用・保持しない**）。
- **`vercel.json` 方針**:
  - `/`, `/index.html`, `/sw.js`: `Cache-Control: public, max-age=0, must-revalidate`
  - `/manifest.webmanifest`: `Content-Type: application/manifest+json`
  - `/privacy`, `/terms` の直アクセスで 404 にならないよう SPA リライト（`rewrites: [{ "source": "/(.*)", "destination": "/index.html" }]` — 静的ファイル実体優先の Vercel 標準動作、または専用静的 HTML 生成）を設定する。

### 7.3 Google Cloud Console 設定・知り合い公開手順
1. **Google Cloud プロジェクト作成 & Drive API 有効化**: `Google Drive API` を有効化。
2. **OAuth 同意画面設定**:
   - スコープに `https://www.googleapis.com/auth/drive.file` のみを登録（非機密 Non-Sensitive スコープ）。
   - アプリのホームページ URL・`/privacy` URL・`/terms` URL を登録。
3. **OAuth 2.0 クライアント ID（ウェブアプリケーション）発行**:
   - **承認済みの JavaScript 生成元**: `http://localhost:5173`（開発用）および本番 Vercel ドメイン（例: `https://3d-visit-record.bamboosato.com` 等のカスタムドメイン）を登録。
   - Token Client フローのみを使うためリダイレクト URI は基本不要（GIS 推奨設定に準拠）。
4. **段階的公開（テスト → 本番ブランド確認）**:
   - **Phase A（身内テスト）**: 公開ステータスを「テスト」にし、知り合いの Gmail アドレスをテストユーザーに追加して利用開始。
   - **Phase B（一般 URL 紹介）**: 公開ステータスを「本番」に切り替え、アプリアイコン・ドメイン所有権確認・プライバシーポリシーに基づく **ブランド確認（Brand Verification）** を申請・完了させる（`drive.file` 単一スコープのため CASA 監査は不要）。

#### OAuth テストモードの仕様・制約と公開ステータス比較
新規に OAuth 設定を作成した初期状態は「テスト（Testing）」モードになります。本アプリの構成（GIS Token Client × `drive.file` 単一スコープ）における各状態の挙動は以下のとおりです。

| 公開ステータス | 利用できるユーザー | Google 同意画面の警告 | 必要な手続き・特徴 |
| :--- | :--- | :--- | :--- |
| **① テストモード** | 事前登録したテストユーザーのみ（**最大 100 名**） | **あり**（テスト中警告。続行で許可可能） | ・**審査不要**で設定直後から利用可能。<br>・未登録ユーザーがサインインを試みると `403: access_denied` となる（ただし Google 未連携でのローカル利用・JSON 保存は可能）。 |
| **② 本番（ブランド未確認）** | 誰でも利用可（事前登録不要） | **あり**（「Google で確認されていません」→「詳細」から続行が必要） | ・Console 上で「本番に公開」へ切り替えるだけで即時移行可能。初見のユーザーには警告が心理的ハードルになりやすい。 |
| **③ 本番 ＋ ブランド確認済み** | 誰でも利用可（事前登録不要） | **なし**（アプリ名・ロゴ入りの正規同意画面） | ・`/privacy`・`/terms` 設置＋ドメイン所有権確認＋無料ブランド審査（通常数日〜1〜2週間）で移行。知り合い紹介の本運用に推奨。 |

- **7 日トークン失効制約について**: テストモードには「リフレッシュトークンが 7 日で失効する」仕様がありますが、本アプリはバックエンドでリフレッシュトークンを保持せず、ブラウザ側でその都度 1 時間有効なアクセストークンを取得する GIS Token Client 方式を採用しているため、7 日ごとに同期設定が切れる等の実害は発生しません（保存・復元時に必要に応じてサイレントまたは対話で再取得します）。
- **独自ドメイン運用の注意点**: ブランド確認では Google Search Console でのドメイン所有権確認が求められます。`.vercel.app` 等の共有ドメインでは審査要件を満たしにくいため、本番・知り合い紹介を見据える段階では `3d_rain_viewer` と同様に独自ドメイン配下のサブドメインを Vercel へ割り当てて運用することを推奨します。

---

## 8. 想定ディレクトリ構成・テスト方針・開発フェーズ

### 8.1 想定ディレクトリ構成

```text
3d_visit_record/
├── docs/
│   ├── requirements.md            # 初版要件定義書
│   └── basic_design.md            # 初版基本設計書（本書）
├── public/
│   ├── icon.svg / icon-192.png / icon-512.png
│   ├── manifest.webmanifest
│   └── sw.js
├── src/
│   ├── components/
│   │   ├── CloudSyncDialog.tsx    # Drive保存/復元・差分プレビュー・Undo・JSON入出力
│   │   ├── LayerMenu.tsx          # 標高強調・ベースマップ・法務リンク
│   │   ├── MapViewer.tsx          # 3D地形 + GeoJSON GPUピン描画
│   │   ├── SpotDetailSheet.tsx    # 地点詳細・記録タイムライン・予定→訪問済み遷移
│   │   ├── SpotForm.tsx           # 地点/期間/メモ入力・OSM周辺候補サジェスト
│   │   ├── SpotNavDrawer.tsx      # 3タブナビ（登録地点 / 地名検索 / 百名山）
│   │   ├── StaticPolicyPage.tsx   # /privacy, /terms 表示
│   │   └── StatusFilterBar.tsx    # マップ上ステータスフィルタピル
│   ├── lib/
│   │   ├── asyncLifecycle.ts
│   │   ├── diagnostics.ts
│   │   ├── googleAuth.ts          # GIS Token Client ラッパー
│   │   ├── googleDriveClient.ts   # Drive REST API v3 & 競合検知・スナップショット
│   │   ├── hyakumeizanData.ts     # 日本百名山100座マスター
│   │   ├── jaxaClient.ts          # AW3D30標高専用クライアント（全球クランプ対応）
│   │   ├── maplibreHelper.ts      # WebGPU/WebGL2 + OPFSタイルキャッシュ
│   │   ├── opfsTileCache.ts
│   │   ├── osmPlaceClient.ts      # 全球Nominatim/Overpass + 国土地理院検索
│   │   ├── spotCategories.ts      # 4カテゴリ + visited/planned スプライト生成
│   │   ├── updateGuard.ts         # SW更新抑止ブロッカー
│   │   ├── urlSync.ts             # 3D視点リンク同期（個人情報除外）
│   │   ├── viewTransition.ts
│   │   ├── visitDate.ts           # 日付/From-To期間検証・正規化・オーバーラップ判定
│   │   ├── visitMerge.ts          # 厳格入力検証・ログ単位マージ・3d_rain_viewer取込
│   │   └── visitStorage.ts        # IndexedDB (visit3d_db) 原子的保存・Undo・救済
│   ├── types/
│   │   ├── jaxa.d.ts
│   │   └── visit.ts
│   ├── App.tsx
│   ├── index.css
│   └── main.tsx
├── tests/                         # Vitest 単体テスト
├── e2e/                           # Playwright E2E テスト
├── index.html
├── package.json
├── tsconfig.json
├── tailwind.config.js
├── vercel.json
└── vite.config.ts
```

### 8.2 テスト戦略（Vitest + Playwright）
- **単体テスト（Vitest）**:
  - `visitDate.ts`: 4 精度（`day`/`month`/`year`/`none`）× From-To 期間検証、うるう年/存在しない日付拒否、`end === start` 正規化、年跨ぎオーバーラップ判定。
  - `visitMerge.ts`: `spot.id` および 50m 座標重複突き合わせ、複数 `entries` の和集合マージ、v2 `photos` メタデータ保全、不正入力拒否、`3d_rain_viewer` JSON 変換。
  - `visitStorage.ts`: `operationQueue` 直列化、破損データ時の `storageBlocked` 保護、1 世代 Undo 復元。
  - `googleDriveClient.ts`: Fetch モックによるフォルダ作成、`about.get` 取得、`modifiedTime` 競合検知、5 世代スナップショットローテーション、401/403/404 エラー処理。
  - `osmPlaceClient.ts` / `jaxaClient.ts`: 海外検索クエリ（`countrycodes` なし）、海外座標での AW3D30 緯度クランプ・百名山近傍スキップ。
- **E2E テスト（Playwright）**:
  - 地図クリック・検索からの登録（予定/訪問済み、From-To 期間、複数行メモ）→ リロード保持。
  - 予定から訪問済みへのワンタップ遷移、再訪ログ追加、一覧絞り込み・マップフィルタ切替。
  - モック Google Drive API を用いた保存・競合ダイアログ・マージ復元・Undo の一連の操作。
  - `/privacy`・`/terms` 直アクセス表示確認。

### 8.3 実装フェーズ計画

| Phase | マイルストーン | 主な実装内容 |
| :--- | :--- | :--- |
| **Phase 1** | プロジェクト初期化 & 全球 3D 地形基盤 | Vite + React + TS 環境構築、`maplibreHelper` / `jaxaClient` / `opfsTileCache` / `osmPlaceClient` の全球対応移植、`/privacy`・`/terms` 静的ページ枠 |
| **Phase 2** | 訪問記録コア（地点・期間・メモ・ピン・一覧） | `visitStorage` / `visitDate` 実装、GeoJSON GPU マーカー（8 スプライト）、`StatusFilterBar`、`SpotDetailSheet` / `SpotForm`、`SpotNavDrawer`（百名山連携含む） |
| **Phase 3** | Google Drive 保存・復元 & ローカル JSON 移行 | `googleAuth` / `googleDriveClient` / `visitMerge` / `CloudSyncDialog`（保存・競合検知・5 世代スナップショット・差分プレビュー・マージ/置き換え・Undo・JSON 入出力） |
| **Phase 4** | PWA・モバイル最適化・テスト・公開整備 | Service Worker / Manifest / セーフエリア仕上げ、Vitest & Playwright 整備、Vercel デプロイ & Google OAuth 本番ブランド確認準備 |
