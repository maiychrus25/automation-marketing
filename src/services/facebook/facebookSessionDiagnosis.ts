/**
 * Vì sao trang chủ Facebook không có phiên đăng nhập. Chỉ đọc HTML và URL cuối đã có sẵn, không gọi thêm yêu cầu nào,
 * và không bao giờ trả lại nội dung trang.
 */
export type FbSessionProblem = 'logged_out' | 'checkpoint' | 'unrecognised_page';

/** Đường dẫn (không query) của một URL tuyệt đối hoặc tương đối; chuỗi lạ → ''. */
function pathOf(target: string | null | undefined): string {
  if (!target) return '';
  const t = target.replace(/\\\//g, '/').trim();
  try {
    return new URL(t, 'https://www.facebook.com').pathname;
  } catch {
    return '';
  }
}

const META_REFRESH_RE = /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*?url=([^"'>\s]+)/i;
const SCRIPT_REDIRECT_RE = /window\.location(?:\.href|\.replace\s*\(|\.assign\s*\()?\s*=?\s*\(?\s*["']([^"']+)["']/gi;

function redirectTargets(html: string): string[] {
  const targets: string[] = [];
  const meta = META_REFRESH_RE.exec(html);
  if (meta) targets.push(meta[1]);
  for (const m of html.matchAll(SCRIPT_REDIRECT_RE)) targets.push(m[1]);
  return targets;
}

export function diagnoseHomepage(html: string, finalUrl?: string | null): FbSessionProblem {
  const finalPath = pathOf(finalUrl);
  const page = typeof html === 'string' ? html : '';
  if (finalPath.startsWith('/checkpoint') || redirectTargets(page).some((t) => pathOf(t).startsWith('/checkpoint'))) return 'checkpoint';
  if (finalPath.startsWith('/login') || /"(?:actorID|USER_ID)"\s*:\s*"0"/.test(page)) return 'logged_out';
  return 'unrecognised_page';
}
