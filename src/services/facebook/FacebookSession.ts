/**
 * FacebookSession.ts
 * Port từ Python _core/_session.py
 * Khởi tạo Facebook session từ cookie - parse fb_dtsg, jazoest, FacebookID, etc.
 */

import axios from 'axios';
import { FBSessionData } from './FacebookTypes';
import { dataSplit } from './FacebookUtils';
import Logger from '../../utils/Logger';
import { FB_SEC_CH_UA, FB_SEC_CH_UA_PLATFORM, FB_USER_AGENT } from './facebookIdentity';
import { mergeRefreshedCookies, refreshedCookiesFrom } from './facebookCookieRefresh';

const FB_HOME_URL = 'https://www.facebook.com/';

/** Các field bắt buộc phải parse được để session hợp lệ */
const REQUIRED_SESSION_FIELDS: (keyof FBSessionData)[] = [
  'fb_dtsg', 'jazoest', 'sessionID', 'FacebookID', 'clientRevision',
];

// Parse order: [name, startDelimiter, endDelimiter]
const SESSION_FIELDS: [keyof FBSessionData, string, string][] = [
  ['fb_dtsg',         'DTSGInitialData",[],{"token":"', '"'],
  ['fb_dtsg_ag',      'async_get_token":"',              '"'],
  ['jazoest',         'jazoest=',                        '"'],
  ['hash',            'hash":"',                         '"'],
  ['sessionID',       'sessionId":"',                    '"'],
  ['FacebookID',      '"actorID":"',                     '"'],
  ['clientRevision',  'client_revision":',               ','],
];

function hasValue(value: any): boolean {
  return value != null && String(value).trim() !== '';
}

/**
 * Full browser-like headers cho Facebook requests
 */
export function fbHeaders(cookie: string): Record<string, string> {
  return {
    'authority': 'www.facebook.com',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.6,en;q=0.5',
    'cache-control': 'max-age=0',
    'cookie': cookie,
    'sec-ch-ua': FB_SEC_CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': FB_SEC_CH_UA_PLATFORM,
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    'upgrade-insecure-requests': '1',
    'user-agent': FB_USER_AGENT,
  };
}

/**
 * Fetch Facebook homepage HTML với đầy đủ headers
 * @throws Error nếu HTTP request thất bại
 */
export async function fetchFBHomepage(cookie: string, httpsAgent?: any): Promise<string> {
  return (await loadHomepage(cookie, httpsAgent)).html;
}

/** Trang chủ Facebook kèm các dòng Set-Cookie của phản hồi. */
async function loadHomepage(cookie: string, httpsAgent?: any): Promise<{ html: string; setCookie: unknown }> {
  try {
    const response = await axios.get(FB_HOME_URL, {
      headers: fbHeaders(cookie),
      withCredentials: false,
      timeout: 60000,
      ...(httpsAgent ? { httpsAgent } : {}),
    });
    return { html: response.data as string, setCookie: response.headers?.['set-cookie'] };
  } catch (err: any) {
    const status = err.response?.status ?? '?';
    const msg = err.message || 'Unknown error';
    // Qua proxy, 403 / 407 thường là của chính máy chủ proxy (hết hạn, sai tài khoản, chặn đích) hoặc Facebook chặn địa chỉ
    // của proxy: đều không nói gì về cookie. Đánh dấu để isTransientFacebookError không coi là cookie hết hạn.
    const viaProxy = httpsAgent && (status === 403 || status === 407) ? ' qua proxy' : '';
    throw new Error(`[FacebookSession] Cannot fetch Facebook homepage (HTTP ${status}${viaProxy}): ${msg}`);
  }
}

/** Kết quả initSession được dùng lại trong khoảng này, để các lần kiểm tra cookie liên tiếp không tải lại trang chủ. */
export const SESSION_REUSE_MS = 60_000;
const recentSessions = new Map<string, { at: number; agent: unknown; session: FBSessionData }>();

/** Quên các session đang nhớ (test, hoặc khi cần buộc tải lại trang chủ). */
export function forgetRecentSessions(): void {
  recentSessions.clear();
}

/**
 * Khởi tạo session từ cookie string
 * Trả về FBSessionData với tất cả thông tin cần thiết cho mọi request.
 *
 * Port từ Python _core/_session.py dataGetHome() - bao gồm:
 * - Parse tất cả session fields từ homepage HTML
 * - Validate REQUIRED_SESSION_FIELDS
 * - Throw error nếu thiếu field bắt buộc hoặc HTTP request thất bại
 *
 * @throws Error nếu không fetch được homepage hoặc thiếu session fields bắt buộc
 */
export async function initSession(cookie: string, httpsAgent?: any, opts: { fresh?: boolean } = {}): Promise<FBSessionData> {
  const now = Date.now();
  for (const [key, entry] of recentSessions) if (now - entry.at >= SESSION_REUSE_MS) recentSessions.delete(key);
  // Chỉ dùng lại khi đi cùng một đường mạng (cùng proxy agent): đổi proxy thì phải kiểm tra thật qua proxy mới.
  // `fresh`: bên gọi cần token mới (làm mới session), không lấy bản đang nhớ.
  const recent = opts.fresh ? undefined : recentSessions.get(cookie);
  if (recent && recent.agent === httpsAgent) return { ...recent.session };

  let html: string;
  let setCookie: unknown;
  try {
    ({ html, setCookie } = await loadHomepage(cookie, httpsAgent));
  } catch (err: any) {
    Logger.error(err.message);
    throw err;
  }

  const result: Partial<FBSessionData> = {};
  const parseErrors: string[] = [];

  for (const [name, start, end] of SESSION_FIELDS) {
    try {
      (result as Record<string, string>)[name] = dataSplit(html, start, end);
    } catch {
      parseErrors.push(name);
      result[name] = null as any;
    }
  }

  // Facebook có thể làm mới cookie phiên ngay trong phản hồi này: dùng bản mới cho mọi yêu cầu sau.
  const refreshed = mergeRefreshedCookies(cookie, refreshedCookiesFrom(setCookie));
  result.cookieFacebook = refreshed.cookie;
  if (refreshed.changed.length) result.refreshedCookieNames = refreshed.changed;

  // Validate required fields (port từ Python REQUIRED_SESSION_FIELDS)
  const missing = REQUIRED_SESSION_FIELDS.filter((f) => !hasValue(result[f]));
  if (missing.length > 0) {
    const errMsg = `[FacebookSession] Missing required session fields: ${missing.join(', ')}`
      + (parseErrors.length > 0 ? ` (parse errors: ${parseErrors.join(', ')})` : '');
    Logger.error(errMsg);
    throw new Error(errMsg);
  }

  // Validate FacebookID là số (port từ Python)
  const fbId = String(result.FacebookID || '').trim();
  if (fbId && !fbId.match(/^\d+$/)) {
    throw new Error(`[FacebookSession] FacebookID is not numeric: ${fbId}`);
  }

  const session = result as FBSessionData;
  // Nhớ theo cả cookie đầu vào lẫn cookie đã làm mới: bên gọi nào cũng tìm lại được.
  for (const key of new Set([cookie, session.cookieFacebook])) recentSessions.set(key, { at: Date.now(), agent: httpsAgent, session: { ...session } });
  return session;
}

const TRANSIENT_NETWORK_RE =
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|EPROTO|ERR_SOCKET_CLOSED)\b|ERR_SOCKET_CLOSED|socket hang up|Proxy connection ended|\b(?:network|socket|timeout|timed out)\b|fetch failed/i;
const TRANSIENT_STATUS_RE = /(?:status code|HTTP)\s*(?:407|429|5\d\d)\b|HTTP \d+ qua proxy/i;

/** Lỗi mạng/timeout/429/5xx — tạm thời, KHÔNG có nghĩa cookie hết hạn. Lỗi lạ khác → false (giữ nghĩa "hết hạn"). */
export function isTransientFacebookError(err: unknown): boolean {
  const msg = typeof err === 'string' ? err : String((err as any)?.message ?? '');
  return TRANSIENT_NETWORK_RE.test(msg) || TRANSIENT_STATUS_RE.test(msg);
}

/**
 * Trạng thái cookie: alive = parse được session; unknown = lỗi mạng tạm thời (chưa biết);
 * expired = Facebook từ chối (redirect login/checkpoint, thiếu field bắt buộc...).
 * `init` chỉ để test tiêm giả.
 */
export async function checkCookieState(
  cookie: string,
  httpsAgent?: any,
  init: typeof initSession = initSession,
): Promise<'alive' | 'expired' | 'unknown'> {
  try {
    await init(cookie, httpsAgent);
    return 'alive';
  } catch (err: any) {
    Logger.warn(`[FacebookSession] checkCookieState error: ${err?.message}`);
    return isTransientFacebookError(err) ? 'unknown' : 'expired';
  }
}

/** Còn dùng được? Chỉ `expired` mới là false — mất mạng không bị coi là hết hạn. */
export async function checkCookieAlive(cookie: string, httpsAgent?: any): Promise<boolean> {
  return (await checkCookieState(cookie, httpsAgent)) !== 'expired';
}

/**
 * Decode HTML entities và Unicode escapes
 */
function decodeHtmlEntities(text: string): string {
  if (!text) return text;
  return text
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Lấy tên và avatar từ Facebook homepage HTML
 * - Avatar: parse từ thẻ <image xlink:href="..."> trong homepage
 * - Tên: parse từ "NAME":"..." trong homepage HTML
 * @param html  HTML trả về từ facebook.com homepage (cần Accept header đúng)
 */
export async function fetchBasicProfileFromHome(html: string): Promise<{ name: string; avatarUrl: string }> {
  let name = '';
  let avatarUrl = '';

  // ── Avatar: parse từ thẻ <image xlink:href="..."> trong homepage ──────
  try {
    const imgMatch = html.match(/xlink:href="(https:\/\/scontent[^"]+)"/);
    if (imgMatch?.[1]) {
      avatarUrl = decodeHtmlEntities(imgMatch[1]);
    }
  } catch {}

  // Fallback: profile_pic_uri trong JSON
  if (!avatarUrl) {
    try {
      const picMatch = html.match(/"profile_pic_uri":"([^"]+)"/);
      if (picMatch?.[1]) {
        avatarUrl = picMatch[1].replace(/\\\//g, '/');
      }
    } catch {}
  }

  // ── Tên: "NAME":"<display name>" từ homepage HTML ─────────────────────
  try {
    const nameMatch = html.match(/"NAME":"(.*?)"/);
    if (nameMatch?.[1] && !nameMatch[1].match(/^\d+$/) && nameMatch[1].length < 100) {
      name = decodeHtmlEntities(nameMatch[1]);
    }
  } catch {}

  // Fallback: "SHORT_NAME"
  if (!name) {
    try {
      const shortMatch = html.match(/"SHORT_NAME":"(.*?)"/);
      if (shortMatch?.[1] && !shortMatch[1].match(/^\d+$/) && shortMatch[1].length < 100) {
        name = decodeHtmlEntities(shortMatch[1]);
      }
    } catch {}
  }

  return { name, avatarUrl };
}

/**
 * Fetch avatar URL cho 1 user Facebook cụ thể bằng cách scrape profile page.
 * Không phụ thuộc vào GraphQL hay cache - luôn trả về URL CDN fresh.
 *
 * Chiến lược:
 *   1. www.facebook.com/profile.php?id={userId} - parse xlink:href hoặc profile_pic_uri
 *   2. Fallback: mbasic.facebook.com/{userId} - HTML nhẹ, parse <img src>
 */
export async function fetchUserAvatarFromProfile(cookie: string, userId: string, httpsAgent?: any): Promise<string | null> {
  // Dùng getUserInfoFacebookHtml để tái sử dụng logic fetch + parse
  const info = await getUserInfoFacebookHtml(cookie, userId, httpsAgent);
  return info?.avatarUrl || null;
}

/**
 * Fetch thông tin user Facebook (tên + avatar) từ profile page HTML.
 * Dùng cho E2EE / hội thoại mới không có contact info.
 * - Avatar: parse <image style="height:168px;width:168px"> xlink:href
 * - Tên: parse <h1> → <div role="button"> → text content
 */
export async function getUserInfoFacebookHtml(cookie: string, userId: string, httpsAgent?: any): Promise<{ name: string; avatarUrl: string } | null> {
  try {
    const response = await axios.get(`https://www.facebook.com/${userId}`, {
      headers: { ...fbHeaders(cookie), 'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      timeout: 30000,
      maxRedirects: 5,
      ...(httpsAgent ? { httpsAgent } : {}),
    });
    const html = response.data as string;

    let name = '';
    let avatarUrl = '';

    // ── Avatar: <image style="height:168px;width:168px"> xlink:href ────────
    const imgTagRe = /<image[^>]*style="[^"]*height:\s*168px[^"]*width:\s*168px[^"]*"[^>]*>/i;
    const imgTagMatch = html.match(imgTagRe);
    if (imgTagMatch) {
      const hrefMatch = imgTagMatch[0].match(/xlink:href="(https:\/\/[^"]+)"/);
      if (hrefMatch?.[1]) avatarUrl = decodeHtmlEntities(hrefMatch[1]);
    }

    // Fallback avatar: collect all xlink:href → last
    if (!avatarUrl) {
      const allXlink: string[] = [];
      const xlinkRe = /xlink:href="(https:\/\/[^"]*scontent[^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = xlinkRe.exec(html)) !== null) {
        allXlink.push(m[1]);
      }
      if (allXlink.length > 0) avatarUrl = decodeHtmlEntities(allXlink[allXlink.length - 1]);
    }

    // Fallback avatar: profile_pic_uri
    if (!avatarUrl) {
      const picMatch = html.match(/"profile_pic_uri":"([^"]+)"/);
      if (picMatch?.[1]) avatarUrl = picMatch[1].replace(/\\\//g, '/');
    }

    // ── Tên: <svg aria-label="..." ... style="height:168px;width:168px"> ────
    // Facebook hiện đặt tên profile vào aria-label của thẻ <svg> bọc avatar tròn
    // (cùng thẻ 168px dùng để lấy avatar ở trên) — xác minh trực tiếp từ HTML thô 09/2026.
    if (imgTagMatch) {
      // imgTagMatch chỉ khớp <image>; cần khớp lại toàn bộ <svg ...> bao ngoài nó
      // để lấy aria-label, vì aria-label nằm trên thẻ svg cha chứ không phải <image>.
      const svgTagMatch = html.match(/<svg[^>]*style="[^"]*height:\s*168px[^"]*width:\s*168px[^"]*"[^>]*>/i);
      const ariaMatch = svgTagMatch?.[0].match(/aria-label="([^"]+)"/);
      if (ariaMatch?.[1]) name = decodeHtmlEntities(ariaMatch[1]).trim();
    }

    // Fallback tên: <h1> → <div role="button" tabindex="0"> text content
    if (!name) {
      const h1Match = html.match(/<h1[^>]*>[\s\S]*?<div[^>]*role="button"[^>]*>([^<&]+)/);
      if (h1Match?.[1]) {
        name = h1Match[1].trim();
      }
    }

    // NOTE: the previous "NAME":"..." JSON fallback was removed — verified live that it
    // matches the viewer's OWN name (appears earlier in the page's bootstrap JSON), not
    // the visited profile's name, causing every contact to be mislabeled with the logged-in
    // account's own name. Only the <h1> match above is trustworthy; leave name empty otherwise
    // rather than writing a confidently-wrong name.

    // ── Fallback CDN + mbasic cho avatar nếu www không có ────────
    if (!avatarUrl) {
      const cdnUrl = await tryFetchCdnRedirect(cookie, userId, httpsAgent);
      if (cdnUrl) avatarUrl = cdnUrl;
    }
    if (!avatarUrl) {
      const mbasicUrl = await tryFetchMbasic(cookie, userId, httpsAgent);
      if (mbasicUrl) avatarUrl = mbasicUrl;
    }

    if (!name && !avatarUrl) return null;
    return { name, avatarUrl: avatarUrl || '' };
  } catch (err: any) {
    Logger.debug(`[FacebookSession] getUserInfoFacebookHtml failed for ${userId}: ${err.message}`);
  }
  return null;
}

/**
 * Facebook /picture endpoint redirects directly to the CDN URL.
 * Dùng HEAD request để follow redirects mà không download image body.
 * KHÔNG BAO GIỜ nhầm avatar vì Facebook tự xác định ảnh đúng.
 */
async function tryFetchCdnRedirect(cookie: string, userId: string, httpsAgent?: any): Promise<string | null> {
  // Dùng maxRedirects:0 để bắt redirect, đọc Location header
  // HEAD request → không download image body
  try {
    const response = await axios.head(`https://www.facebook.com/${userId}/picture?type=large`, {
      headers: {
        'user-agent': FB_USER_AGENT,
        'cookie': cookie,
      },
      timeout: 15000,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      ...(httpsAgent ? { httpsAgent } : {}),
    });
    // Nếu không redirect (200 OK), thử request URL
    const reqUrl = response.request?.res?.responseUrl || (response.request as any)?.responseUrl || '';
    if (reqUrl.includes('fbcdn') || reqUrl.includes('scontent')) return reqUrl;
    // redirect URL trong Location header
    if (response.headers?.location) return response.headers.location;
  } catch (err: any) {
    // Khi maxRedirects=0, axios throw error với redirect info
    if (err.response?.headers?.location) {
      return err.response.headers.location;
    }
    Logger.debug(`[FacebookSession] tryFetchCdnRedirect failed for ${userId}: ${err.message}`);
  }

  // Fallback: GET request với maxRedirects=5 để axios tự follow
  try {
    const response = await axios.head(`https://www.facebook.com/${userId}/picture?type=large`, {
      headers: {
        'user-agent': FB_USER_AGENT,
        'cookie': cookie,
      },
      timeout: 15000,
      maxRedirects: 5,
      ...(httpsAgent ? { httpsAgent } : {}),
    });
    const finalUrl = response.request?.res?.responseUrl || (response.request as any)?.responseUrl || '';
    if (finalUrl.includes('fbcdn') || finalUrl.includes('scontent')) return finalUrl;
  } catch (err: any) {
    Logger.debug(`[FacebookSession] tryFetchCdnRedirect fallback failed for ${userId}: ${err.message}`);
  }
  return null;
}

async function tryFetchWww(cookie: string, userId: string, httpsAgent?: any): Promise<string | null> {
  try {
    const response = await axios.get(`https://www.facebook.com/${userId}`, {
      headers: { ...fbHeaders(cookie), 'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      timeout: 30000,
      maxRedirects: 5,
      ...(httpsAgent ? { httpsAgent } : {}),
    });
    const html = response.data as string;

    // Priority 1: <image style="height:168px;width:168px"> - profile picture circle
    // Facebook dùng 168px là kích thước cố định cho profile picture thumbnail
    // Match cả thẻ <image> có style 168px, rồi extract xlink:href
    const imgTagRe = /<image[^>]*style="[^"]*height:\s*168px[^"]*width:\s*168px[^"]*"[^>]*>/i;
    const imgTagMatch = html.match(imgTagRe);
    if (imgTagMatch) {
      const hrefMatch = imgTagMatch[0].match(/xlink:href="(https:\/\/[^"]+)"/);
      if (hrefMatch?.[1]) return decodeHtmlEntities(hrefMatch[1]);
    }

    // Priority 2: Collect ALL xlink:href → return LAST one
    const allXlink: string[] = [];
    const xlinkRe = /xlink:href="(https:\/\/[^"]*scontent[^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = xlinkRe.exec(html)) !== null) {
      allXlink.push(m[1]);
    }
    if (allXlink.length > 0) {
      return decodeHtmlEntities(allXlink[allXlink.length - 1]);
    }

    // Priority 3: profile_pic_uri trong JSON inline
    const picMatch = html.match(/"profile_pic_uri":"([^"]+)"/);
    if (picMatch?.[1]) {
      return picMatch[1].replace(/\\\//g, '/');
    }
  } catch (err: any) {
    Logger.debug(`[FacebookSession] tryFetchWww failed for ${userId}: ${err.message}`);
  }
  return null;
}

async function tryFetchMbasic(cookie: string, userId: string, httpsAgent?: any): Promise<string | null> {
  try {
    const response = await axios.get(`https://mbasic.facebook.com/${userId}`, {
      headers: {
        'user-agent': FB_USER_AGENT,
        'cookie': cookie,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 30000,
      ...(httpsAgent ? { httpsAgent } : {}),
    });
    const html = response.data as string;

    const imgMatch = html.match(/<img[^>]*src="([^"]*scontent[^"]+)"[^>]*>/);
    if (imgMatch?.[1]) return decodeHtmlEntities(imgMatch[1]);

    const xlinkMatch = html.match(/xlink:href="(https:\/\/[^"]*scontent[^"]+)"/);
    if (xlinkMatch?.[1]) return decodeHtmlEntities(xlinkMatch[1]);
  } catch (err: any) {
    Logger.debug(`[FacebookSession] tryFetchMbasic failed for ${userId}: ${err.message}`);
  }
  return null;
}

