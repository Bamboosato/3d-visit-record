import React from 'react';
import { ArrowLeft, ShieldCheck, FileText } from 'lucide-react';

interface StaticPolicyPageProps {
  page: 'privacy' | 'terms';
  onNavigateHome: () => void;
  onNavigatePage: (page: 'privacy' | 'terms') => void;
}

export const StaticPolicyPage: React.FC<StaticPolicyPageProps> = ({
  page,
  onNavigateHome,
  onNavigatePage,
}) => {
  const isPrivacy = page === 'privacy';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 px-4 py-8 sm:py-12">
      <div className="max-w-3xl mx-auto space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2.5">
            {isPrivacy ? (
              <ShieldCheck className="w-6 h-6 text-sky-400" aria-hidden="true" />
            ) : (
              <FileText className="w-6 h-6 text-emerald-400" aria-hidden="true" />
            )}
            <h1 className="text-xl sm:text-2xl font-bold text-white">
              {isPrivacy
                ? '3D Visit Record プライバシーポリシー'
                : '3D Visit Record 利用規約・データクレジット'}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onNavigatePage(isPrivacy ? 'terms' : 'privacy')}
              className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-xs font-medium text-slate-200 cursor-pointer"
            >
              {isPrivacy ? '利用規約を見る' : 'プライバシーポリシーを見る'}
            </button>
            <button
              type="button"
              onClick={onNavigateHome}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-xs font-semibold text-white cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
              <span>地図アプリに戻る</span>
            </button>
          </div>
        </header>

        {isPrivacy ? (
          <main className="space-y-6 text-sm leading-relaxed text-slate-300">
            <section className="space-y-2">
              <h2 className="text-base font-bold text-white">1. 基本方針（サーバーレス・個人データ非保持）</h2>
              <p>
                3D Visit Record（以下「本アプリ」）は、お客様の訪問済み・訪問予定地点の記録（座標、日付・期間、メモ、添付写真、カメラ視点等）を
                開発者のサーバーや外部データベースへ送信・保存しない完全クライアントサイドの Web アプリケーションです。
                添付写真を含むすべての記録データは、端末ブラウザ内でのみリサイズ・圧縮および EXIF 除去処理を行ったうえで
                ブラウザ内の IndexedDB、およびお客様ご自身の操作によって連携された Google Drive にのみ保存されます。
              </p>
            </section>

            <section className="space-y-2">
              <h2 className="text-base font-bold text-white">2. Google アカウント連携および Google API の利用</h2>
              <p>
                本アプリでは、訪問記録データのバックアップおよび別端末への復元機能を提供するため、
                Google Identity Services および Google Drive API v3 を利用します。
              </p>
              <ul className="list-disc pl-5 space-y-1.5">
                <li>
                  <strong>要求する権限スコープ:</strong> 本アプリが要求するスコープは非機密スコープである{' '}
                  <code className="px-1.5 py-0.5 rounded bg-slate-900 text-sky-300">
                    https://www.googleapis.com/auth/drive.file
                  </code>{' '}
                  のみです。お客様が本アプリを通じて作成した専用フォルダ（
                  <code className="px-1 py-0.5 rounded bg-slate-900">3D Visit Record/</code> および画像保管サブフォルダ{' '}
                  <code className="px-1 py-0.5 rounded bg-slate-900">3D Visit Record/photos/</code>
                  ）の配下に本アプリが作成したファイル以外（Google Drive 上の他ファイルや Google フォト等）へは一切アクセスしません。
                </li>
                <li>
                  <strong>取得するアカウント情報:</strong> 接続中のアカウントを画面上に明示するため、Google Drive API（about.get）を通じて表示名およびメールアドレスを取得し、ブラウザ上の状態表示にのみ利用します。
                </li>
                <li>
                  <strong>アクセストークンの取り扱い:</strong> 取得した OAuth アクセストークンはブラウザのメモリ内のみに一時保持され、
                  <code className="px-1 py-0.5 rounded bg-slate-900">localStorage</code> やサーバーへ保存・送信することはありません。
                </li>
                <li>
                  <strong>Google API Services User Data Policy 準拠:</strong>{' '}
                  Google API から受信した情報の本アプリによる使用および他アプリへの転送は、
                  <a
                    href="https://developers.google.com/terms/api-services-user-data-policy#additional_requirements_for_specific_api_scopes"
                    target="_blank"
                    rel="noreferrer"
                    className="text-sky-400 underline hover:text-sky-300"
                  >
                    Google API Services User Data Policy（Limited Use 要件を含む）
                  </a>
                  に完全に準拠します。広告配信、第三者へのデータ販売、AI モデル学習等には一切使用しません。
                </li>
              </ul>
            </section>

            <section className="space-y-2">
              <h2 className="text-base font-bold text-white">3. 位置情報・添付写真・地図・検索 API の通信について</h2>
              <ul className="list-disc pl-5 space-y-1.5">
                <li>
                  <strong>現在地情報:</strong> 「現在地へ移動」ボタンを押した際、ブラウザの Geolocation API を用いて地図移動にのみ使用し、外部へ送信・記録しません。
                </li>
                <li>
                  <strong>添付写真と EXIF メタデータ:</strong> 訪問記録へ写真を追加する際、端末ブラウザ内でのみリサイズ・圧縮処理を行い、元画像に含まれる GPS 位置情報や撮影機種情報等の EXIF メタデータは再エンコードにより自動的に除去されます。日付入力補助のために撮影日時のみを端末内で読み取りますが、元画像や EXIF 位置情報を外部サーバーへ送信することはありません。
                </li>
                <li>
                  <strong>地名・施設検索と標高取得:</strong> お客様が地図をタップまたは検索を実行した際、地点名サジェストや標高取得のために
                  OpenStreetMap（Nominatim / Overpass API）、国土地理院 地名検索 API、JAXA Earth API へ該当座標・検索語を直接照会します。
                </li>
                <li>
                  <strong>3D 視点共有 URL:</strong> 共有リンクには緯度・経度・ズーム・傾き・方角・背景地図・（任意で）地点名のみを含め、訪問日・期間・メモ・写真・キャプション等の個人記録は一切含めません。
                </li>
              </ul>
            </section>

            <section className="space-y-2">
              <h2 className="text-base font-bold text-white">4. データの削除と連携解除</h2>
              <p>
                Google Drive 連携画面の「サインアウト」によりメモリ上のアクセストークンを失効でき、Google アカウントのセキュリティ設定から本アプリへのアクセス権をいつでも取り消せます。
                Google Drive 上の <code className="px-1 py-0.5 rounded bg-slate-900">3D Visit Record</code> フォルダや端末のブラウザデータを削除することで、保存データを完全に消去できます。
              </p>
            </section>
          </main>
        ) : (
          <main className="space-y-6 text-sm leading-relaxed text-slate-300">
            <section className="space-y-2">
              <h2 className="text-base font-bold text-white">1. 利用規約および免責事項</h2>
              <ul className="list-disc pl-5 space-y-1.5">
                <li>本アプリは個人の旅行・登山・訪問記録の整理を支援するための無償 Web アプリケーションとして提供されます。</li>
                <li>
                  ブラウザのストレージ消去や端末故障等によるデータ喪失を防ぐため、定期的な Google Drive への保存またはローカル JSON バックアップの書き出しを推奨します。開発者はデータの消失・損害について責任を負いかねます。
                </li>
                <li>
                  地図上の標高値（JAXA AW3D30 等）および施設情報はオープンデータに基づく参考値であり、正確な測量・登山安全・航行判断の根拠には使用しないでください。
                </li>
                <li>予告なく機能の変更、仕様改善、公開停止を行う場合があります。</li>
              </ul>
            </section>

            <section className="space-y-2">
              <h2 className="text-base font-bold text-white">2. 使用データソース・クレジット</h2>
              <ul className="list-disc pl-5 space-y-1.5">
                <li>
                  <strong>3D 標高データ:</strong> JAXA Earth API for JavaScript（AW3D30 DSM v3.2 global） —{' '}
                  <a
                    href="https://data.earth.jaxa.jp/"
                    target="_blank"
                    rel="noreferrer"
                    className="text-sky-400 underline"
                  >
                    JAXA Earth API
                  </a>
                </li>
                <li>
                  <strong>地図・地名・施設データ:</strong> &copy; OpenStreetMap contributors（Nominatim / Overpass API） —{' '}
                  <a
                    href="https://www.openstreetmap.org/copyright"
                    target="_blank"
                    rel="noreferrer"
                    className="text-sky-400 underline"
                  >
                    OpenStreetMap
                  </a>
                </li>
                <li>
                  <strong>日本国内背景地図・地名検索:</strong> 国土地理院 地理院タイル（淡色地図）・地名検索 API —{' '}
                  <a
                    href="https://maps.gsi.go.jp/development/ichiran.html"
                    target="_blank"
                    rel="noreferrer"
                    className="text-sky-400 underline"
                  >
                    国土地理院
                  </a>
                </li>
                <li>
                  <strong>衛星航空写真:</strong> Esri World Imagery（Esri, Maxar, Earthstar Geographics）
                </li>
                <li>
                  <strong>3D 地図描画エンジン:</strong> MapLibre GL JS
                </li>
              </ul>
            </section>
          </main>
        )}

        <footer className="pt-4 border-t border-slate-800 text-xs text-slate-500">
          3D Visit Record — Client-side 3D Location Log Application
        </footer>
      </div>
    </div>
  );
};
