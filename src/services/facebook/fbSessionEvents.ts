/**
 * Lịch sử ngắn các sự kiện phiên Facebook, lưu cục bộ trong app_settings (JSON thường).
 * Không có bí mật: chỉ tên cookie, mã trạng thái, mã vấn đề; `accountId` là fb_accounts.id nội bộ.
 * Ghi lịch sử không bao giờ được làm hỏng kết nối: mọi lỗi đều bị nuốt.
 */
export const FB_SESSION_EVENTS_KEY = 'fb_session_events';
export const FB_SESSION_EVENTS_MAX = 200;

export interface FbSessionEvent {
  at: number;
  accountId: string;
  kind: 'cookie_refreshed' | 'status' | 'cookie_check' | 'cookie_updated';
  detail: string;
}

interface SettingsDb {
  getSetting(key: string): string | null | undefined;
  setSetting(key: string, value: string): void;
}
interface Deps { db?: SettingsDb; now?: () => number }

export function appendFbSessionEvent(list: readonly FbSessionEvent[], event: FbSessionEvent, max = FB_SESSION_EVENTS_MAX): FbSessionEvent[] {
  return [...list, event].slice(-max);
}

/** Chỉ nhận tên cookie hợp lệ: một giá trị (có `=`, hoặc quá dài) không bao giờ lọt vào. */
export function formatCookieRefreshDetail(source: string, names: readonly string[], stored: boolean): string {
  const safe = names.filter((n) => /^[A-Za-z0-9_]{1,32}$/.test(n));
  return `source=${source} names=${safe.join(',')} stored=${stored}`;
}

function defaultDb(): SettingsDb {
  // Nạp muộn: tệp này thuần, không kéo cơ sở dữ liệu vào khi test.
  return (require('../database/DatabaseService').default as { getInstance(): SettingsDb }).getInstance();
}

export function readFbSessionEvents(db?: SettingsDb): FbSessionEvent[] {
  try {
    const raw = (db ?? defaultDb()).getSetting(FB_SESSION_EVENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordFbSessionEvent(event: Omit<FbSessionEvent, 'at'>, deps: Deps = {}): void {
  try {
    const db = deps.db ?? defaultDb();
    const list = appendFbSessionEvent(readFbSessionEvents(db), { at: (deps.now ?? Date.now)(), ...event });
    db.setSetting(FB_SESSION_EVENTS_KEY, JSON.stringify(list));
  } catch {
    /* ghi lịch sử thất bại không ảnh hưởng kết nối */
  }
}

/** Chuỗi detail của `cookie_check`: alive | unknown | expired [problem=...]. */
export function cookieCheckDetail(r: { state: 'alive' | 'expired' | 'unknown'; problem?: string }): string {
  return r.state === 'expired' && r.problem ? `expired problem=${r.problem}` : r.state;
}

const COOKIE_CHECK_GAP_MS = 60_000;
const lastCookieCheck = new Map<string, { at: number; detail: string }>();

/** `cookie_check` tối đa một lần / 60 s cho cùng tài khoản và cùng kết quả: vòng kết nối lại không làm đầy danh sách. */
export function recordCookieCheck(accountId: string, detail: string, deps: Deps = {}): void {
  try {
    const now = (deps.now ?? Date.now)();
    const last = lastCookieCheck.get(accountId);
    if (last && last.detail === detail && now - last.at < COOKIE_CHECK_GAP_MS) return;
    lastCookieCheck.set(accountId, { at: now, detail });
    recordFbSessionEvent({ accountId, kind: 'cookie_check', detail }, deps);
  } catch { /* như trên */ }
}
