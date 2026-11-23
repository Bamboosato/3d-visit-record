# 3D Visit Record

WebGPU（WebGL2 自動フォールバック）と JAXA AW3D30 の全球 3D 地形上に、**「訪問済み」** と **「訪問予定」** の地点を記録・計画・振り返りできるサーバーレス SPA / PWA です。

端末内の IndexedDB を正としてオフラインでも完結して利用でき、必要に応じてユーザー自身の Google Drive（`drive.file` 単一スコープ）へ記録データや写真を安全に保存・復元できます。

---

## 主な機能

### 1. 全球対応 3D 地形マップ
- **3D 地形レンダリング**: MapLibre GL JS（WebGPU 優先 / WebGL2 自動フォールバック）＋ JAXA AW3D30（`v3.2_global`）Terrain-RGB による立体表示
- **背景地図切替 & 標高強調**: OpenStreetMap（標準・全球）、航空写真（Esri World Imagery・全球）、国土地理院淡色地図（日本国内向け）の切替と、標高強調倍率（`1.0x〜3.0x`）の動的調整
- **高速タイルキャッシュ**: OPFS（Origin Private File System）を利用したタイルキャッシュ
- **視覚識別 & フィルタ**: ステータス（訪問済み / 訪問予定）× 4 カテゴリ（自然 / 観光 / 生活 / その他）別のピン描画とマップ上のクイックフィルタ

### 2. 地点・訪問ログ管理
- **多様な登録導線**: 地図タップ、地名・施設検索（OpenStreetMap Nominatim 全球検索 ＋ 国土地理院 地名検索 API、周辺施設サジェスト）、日本百名山（全 100 座プリセット）、GPS 現在地からの登録に対応
- **柔軟な日付・期間 & メモ**: 単日・From-To 期間・年月・年・時期未定の 4 精度と複数行メモ（最大 2,000 文字）を 1 地点あたり最大 50 ログまで記録可能
- **3D カメラ視点の保存・再現**: 登録・更新時のズーム・ピッチ・ベアリングを保存し、地点選択時に立体視点を再現
- **予定 → 訪問済み遷移**: 訪問予定地点の詳細からワンタップで訪問済みへ確定

### 3. 写真添付・閲覧（v2.0）
- **訪問済みログへの写真添付**: 1 ログあたり最大 5 枚の写真（JPEG / PNG / WebP / ブラウザ対応時は HEIC 等、SVG は拒否）を添付・並び替え・キャプション入力（最大 200 文字）が可能
- **クライアント完結のリサイズ & EXIF 処理**: 端末内で閲覧用本体（長辺最大 1,600px）とサムネイル（長辺最大 320px）を生成し、Canvas 再エンコードにより GPS 位置情報や機材情報等の EXIF を自動除去（撮影日時のみ訪問日入力の提案に利用）
- **ライトボックス & 検索**: サムネイル一覧、フルスクリーン拡大ライトボックス（前後切替・スワイプ・矢印キー・単体保存/共有）、写真キャプション横断検索に対応

### 4. Google Drive 同期 & ローカルバックアップ
- **Google Drive 保存・復元**: `https://www.googleapis.com/auth/drive.file` 単一スコープを使用し、マイドライブ内の `3D Visit Record/` 配下（`visit-records.json`、`snapshots/`、`photos/`）のみを管理
- **安全な同期機構**: 他端末更新の競合検知、上書き前のスナップショット退避（直近 5 世代）、差分プレビュー付きのマージ／置き換え復元、復元直前の 1 世代 Undo
- **写真のクラウド同期最適化**: SHA-256 ハッシュによる重複アップロード防止、途中中断からのレジューム、復元後のオンデマンド取得／任意の一括ダウンロード、未参照写真の自動ゴミ箱移動
- **ローカル JSON 入出力**: オフラインや Google 未連携環境向けの JSON エクスポート／インポート（`3d_rain_viewer` お気に入り JSON の変換インポートにも対応）

### 5. 共有・プライバシー・PWA
- **3D 視点共有 URL**: 緯度・経度・カメラ視点・背景地図・標高強調（および任意で地点名）のみを URL パラメータで共有（訪問日時・メモ・写真などの個人記録は含まれません）
- **プライバシー・規約ページ**: アプリ内に `/privacy` と `/terms` を内蔵
- **PWA 対応**: Web App Manifest と Service Worker によるホーム画面追加・オフライン閲覧/編集に対応

---

## 技術スタック

- **フロントエンド**: React 19, TypeScript, Vite 6, Tailwind CSS, Lucide React
- **3D 地図描画**: MapLibre GL JS, JAXA Earth API (`jaxa.earth.esm.js`)
- **ローカル永続化**: IndexedDB (`visit3d_db`), OPFS
- **クラウド連携**: Google Identity Services, Google Drive API v3
- **テスト**: Vitest (`happy-dom`, `fake-indexeddb`, Testing Library), Playwright
- **ホスティング**: Vercel（静的 SPA 配信、`vercel.json`）

---

## ディレクトリ構成

```text
.
├── docs/                  # 要件定義書・基本設計書（v1 / v2.0）
├── e2e/                   # Playwright E2E テスト
├── public/                # PWA マニフェスト、Service Worker、アイコン
├── src/
│   ├── components/        # UI コンポーネント（地図・フォーム・詳細・同期・ライトボックス等）
│   ├── lib/               # IndexedDB、Google Drive 同期、画像処理、EXIF、検索クライアント等
│   └── types/             # 型定義・バリデーション定数
├── tests/                 # Vitest ユニット / UI テスト
├── .env.example           # 環境変数テンプレート
├── index.html
├── package.json
├── playwright.config.ts
├── vercel.json
├── vite.config.ts
└── vitest.config.ts
```

---

## セットアップ & 開発

### 1. 依存パッケージのインストール

Node.js 22 以上の環境で実行してください。

```bash
npm install
```

### 2. 環境変数の設定（任意）

Google Drive 連携や共有リンク生成のオリジンを指定する場合は、`.env.example` をコピーして `.env` を作成します。

```bash
cp .env.example .env
```

| 変数名 | 説明 |
| :--- | :--- |
| `VITE_GOOGLE_CLIENT_ID` | Google Cloud Console で発行した OAuth 2.0 Web クライアント ID（未設定でもローカル専用アプリとして動作します） |
| `VITE_PUBLIC_APP_ORIGIN` | 3D 視点共有リンク生成時に使用する公開オリジン（既定: `https://3d-visit-record.bamboosato.com`） |

### 3. 主なコマンド

```bash
# 開発サーバー起動
npm run dev

# 型チェック & 本番ビルド（出力先: dist/）
npm run build

# ビルド結果のローカルプレビュー
npm run preview

# TypeScript 型チェック（lint）
npm run lint

# ユニット / UI テスト（Vitest）
npm test

# E2E テスト（Playwright）
npm run test:e2e
```

---

## ドキュメント

詳細な仕様・設計は [`docs/`](./docs/) を参照してください。

- [初版 要件定義書](./docs/requirements.md)
- [初版 基本設計書](./docs/basic_design.md)
- [v2.0（写真機能）要件定義書](./docs/requirements_v2_photos.md)
- [v2.0（写真機能）基本設計書](./docs/basic_design_v2_photos.md)

---

## 使用データソース・クレジット

- **3D 標高データ**: [JAXA Earth API](https://data.earth.jaxa.jp/)（AW3D30 DSM v3.2 global）
- **地図・地名・施設データ**: &copy; [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors（Nominatim / Overpass API）
- **日本国内背景地図・地名検索**: [国土地理院](https://maps.gsi.go.jp/development/ichiran.html) 地理院タイル（淡色地図）・地名検索 API
- **衛星航空写真**: Esri World Imagery（Esri, Maxar, Earthstar Geographics）
- **3D 地図描画エンジン**: MapLibre GL JS
