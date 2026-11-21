import { BrowserCookie, readLoginCookie } from './browserLoginCookie';

export const BROWSER_LOGIN_POLL_MS = 2000;
export const BROWSER_LOGIN_TIMEOUT_MS = 600000;

export type BrowserLoginStatus = 'opening' | 'waiting' | 'wrong_account' | 'check_failed' | 'saving';
export type BrowserLoginResult =
  | { success: true }
  | { success: false; code: 'CLOSED' | 'CANCELLED' | 'TIMEOUT' | 'OPEN_FAILED'; error: string };

export interface BrowserLoginWindow {
  readCookies(): Promise<BrowserCookie[]>;
  isClosed(): boolean;
  close(): Promise<void>;
}

interface BrowserLoginDeps {
  open(): Promise<BrowserLoginWindow>;
  expectedFacebookId: string;
  applyCookie(cookie: string): Promise<{ success: boolean; error?: string }>;
  onStatus(status: BrowserLoginStatus, detail?: string): void;
  signal: AbortSignal;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const messages = {
  CLOSED: 'Đã đóng trình duyệt, chưa lấy được cookie',
  CANCELLED: 'Đã huỷ đăng nhập bằng trình duyệt',
  TIMEOUT: 'Quá 10 phút chưa đăng nhập xong, đã đóng trình duyệt',
} as const;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runBrowserLogin(deps: BrowserLoginDeps): Promise<BrowserLoginResult> {
  let lastStatus: string | undefined;
  const emit = (status: BrowserLoginStatus, detail?: string): void => {
    const key = `${status}|${detail ?? ''}`;
    if (key === lastStatus) return;
    lastStatus = key;
    deps.onStatus(status, detail);
  };

  emit('opening');
  let win: BrowserLoginWindow;
  try {
    win = await deps.open();
  } catch (err) {
    return { success: false, code: 'OPEN_FAILED', error: errorMessage(err) };
  }
  const openedAt = deps.now();
  const closeQuietly = (): Promise<void> => win.close().catch(() => undefined);
  const fail = (code: keyof typeof messages): BrowserLoginResult => ({ success: false, code, error: messages[code] });
  let failedCookie: string | undefined;

  for (;;) {
    if (deps.signal.aborted) {
      await closeQuietly();
      return fail('CANCELLED');
    }
    if (win.isClosed()) return fail('CLOSED');
    if (deps.now() - openedAt >= BROWSER_LOGIN_TIMEOUT_MS) {
      await closeQuietly();
      return fail('TIMEOUT');
    }

    let cookies: BrowserCookie[] = [];
    try {
      cookies = await win.readCookies();
    } catch {
      if (win.isClosed()) return fail('CLOSED');
    }

    const read = readLoginCookie(cookies, deps.expectedFacebookId);
    if (read.state === 'waiting') emit('waiting');
    else if (read.state === 'wrong_account') emit('wrong_account');
    else if (read.cookie !== failedCookie) {
      emit('saving');
      let applied: { success: boolean; error?: string };
      try {
        applied = await deps.applyCookie(read.cookie);
      } catch (err) {
        applied = { success: false, error: errorMessage(err) };
      }
      if (applied.success) {
        await closeQuietly();
        return { success: true };
      }
      failedCookie = read.cookie;
      emit('check_failed', applied.error);
    }

    await deps.sleep(BROWSER_LOGIN_POLL_MS);
  }
}
