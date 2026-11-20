export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

export type GoogleAuthErrorCode =
  | 'unconfigured'
  | 'script_load_failed'
  | 'popup_closed'
  | 'access_denied'
  | 'unknown';

export class GoogleAuthError extends Error {
  code: GoogleAuthErrorCode;
  constructor(code: GoogleAuthErrorCode, message: string) {
    super(message);
    this.name = 'GoogleAuthError';
    this.code = code;
  }
}

interface TokenSession {
  accessToken: string;
  expiresAtMs: number;
}

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface GoogleAccountsOAuth2 {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    prompt?: string;
    callback: (response: GoogleTokenResponse) => void;
    error_callback?: (err: { type?: string; message?: string }) => void;
  }) => {
    requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
  };
  revoke: (token: string, done?: () => void) => void;
}

export interface GoogleAuthAdapter {
  isConfigured: () => boolean;
  requestAccessToken: (options?: { prompt?: '' | 'consent' | 'select_account' }) => Promise<string>;
  revoke: (token: string) => Promise<void>;
}

// アクセストークンはメモリ内のみに保持し、localStorage / IndexedDB へは一切保存しない
let memorySession: TokenSession | null = null;
let gisLoadPromise: Promise<void> | null = null;
let customAdapterForTesting: GoogleAuthAdapter | null = null;

export function getGoogleClientId(): string {
  const winOverride = (globalThis as Record<string, unknown>).__VISIT3D_GOOGLE_CLIENT_ID__;
  if (typeof winOverride === 'string' && winOverride.trim()) return winOverride.trim();
  const envId = import.meta.env?.VITE_GOOGLE_CLIENT_ID;
  return typeof envId === 'string' ? envId.trim() : '';
}

export function isGoogleAuthConfigured(): boolean {
  if (customAdapterForTesting) return customAdapterForTesting.isConfigured();
  return getGoogleClientId().length > 0;
}

export function hasActiveMemoryToken(): boolean {
  return Boolean(memorySession && memorySession.expiresAtMs - Date.now() > 60_000);
}

export function clearMemoryToken(): void {
  memorySession = null;
}

export function setGoogleAuthAdapterForTesting(adapter: GoogleAuthAdapter | null): void {
  customAdapterForTesting = adapter;
  memorySession = null;
}

function getGisOAuth2(): GoogleAccountsOAuth2 | null {
  const g = (globalThis as Record<string, unknown>).google as
    | { accounts?: { oauth2?: GoogleAccountsOAuth2 } }
    | undefined;
  return g?.accounts?.oauth2 ?? null;
}

function loadGisScript(): Promise<void> {
  if (getGisOAuth2()) return Promise.resolve();
  if (gisLoadPromise) return gisLoadPromise;

  gisLoadPromise = new Promise<void>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new GoogleAuthError('script_load_failed', 'ブラウザ環境でのみGoogle認証を利用できます。'));
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SCRIPT_URL}"]`);
    if (existing && getGisOAuth2()) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    const timer = setTimeout(() => {
      gisLoadPromise = null;
      reject(
        new GoogleAuthError(
          'script_load_failed',
          'Google 認証スクリプトの読み込みがタイムアウトしました。通信環境をご確認ください。'
        )
      );
    }, 10000);

    script.onload = () => {
      clearTimeout(timer);
      if (getGisOAuth2()) {
        resolve();
      } else {
        gisLoadPromise = null;
        reject(new GoogleAuthError('script_load_failed', 'Google 認証ライブラリを初期化できませんでした。'));
      }
    };
    script.onerror = () => {
      clearTimeout(timer);
      gisLoadPromise = null;
      reject(
        new GoogleAuthError(
          'script_load_failed',
          'Google 認証スクリプトを読み込めませんでした（オフラインまたはブロック）。'
        )
      );
    };
    document.head.appendChild(script);
  });

  return gisLoadPromise;
}

export async function requestDriveAccessToken(options?: {
  prompt?: '' | 'consent' | 'select_account';
  forceRefresh?: boolean;
}): Promise<string> {
  if (customAdapterForTesting) {
    if (!options?.forceRefresh && hasActiveMemoryToken() && options?.prompt !== 'consent' && options?.prompt !== 'select_account') {
      return memorySession!.accessToken;
    }
    const token = await customAdapterForTesting.requestAccessToken({ prompt: options?.prompt });
    memorySession = { accessToken: token, expiresAtMs: Date.now() + 3500 * 1000 };
    return token;
  }

  const clientId = getGoogleClientId();
  if (!clientId) {
    throw new GoogleAuthError(
      'unconfigured',
      'Google OAuth クライアント ID（VITE_GOOGLE_CLIENT_ID）が未設定です。ローカルJSONバックアップをご利用ください。'
    );
  }

  if (
    !options?.forceRefresh &&
    options?.prompt !== 'consent' &&
    options?.prompt !== 'select_account' &&
    hasActiveMemoryToken()
  ) {
    return memorySession!.accessToken;
  }

  await loadGisScript();
  const oauth2 = getGisOAuth2();
  if (!oauth2) {
    throw new GoogleAuthError('script_load_failed', 'Google 認証ライブラリが利用できません。');
  }

  return new Promise<string>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_DRIVE_SCOPE,
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          const code: GoogleAuthErrorCode =
            resp.error === 'access_denied' ? 'access_denied' : 'unknown';
          reject(
            new GoogleAuthError(
              code,
              resp.error === 'access_denied'
                ? 'Google Drive へのアクセス権限が許可されませんでした。'
                : resp.error_description || 'Google サインインに失敗しました。'
            )
          );
          return;
        }
        const expiresIn = typeof resp.expires_in === 'number' ? resp.expires_in : 3600;
        memorySession = {
          accessToken: resp.access_token,
          expiresAtMs: Date.now() + expiresIn * 1000,
        };
        resolve(resp.access_token);
      },
      error_callback: (err) => {
        const isClosed = err?.type === 'popup_closed' || err?.type === 'popup_failed_to_open';
        reject(
          new GoogleAuthError(
            isClosed ? 'popup_closed' : 'unknown',
            err?.type === 'popup_failed_to_open'
              ? '認証ポップアップがブラウザにブロックされました。許可してから再度お試しください。'
              : isClosed
                ? 'Google サインインのポップアップが閉じられました。'
                : err?.message || 'Google 認証が中断されました。'
          )
        );
      },
    });

    client.requestAccessToken({ prompt: options?.prompt ?? '' });
  });
}

export async function signOutGoogleDrive(): Promise<void> {
  const token = memorySession?.accessToken;
  memorySession = null;
  if (!token) return;
  if (customAdapterForTesting) {
    await customAdapterForTesting.revoke(token);
    return;
  }
  const oauth2 = getGisOAuth2();
  if (oauth2) {
    await new Promise<void>((resolve) => {
      try {
        oauth2.revoke(token, () => resolve());
      } catch {
        resolve();
      }
    });
  }
}
