// Tin mẫu (template) từ Page/bot → chữ đọc được. Lưu như tin text thường, không có kiểu riêng.

const MAX_FIELD = 2000;
const MAX_BUTTONS = 6;

/** Gỡ link chuyển hướng l.facebook.com/l.php?u=…; chỉ trả http(s), còn lại ''. Không bao giờ ném lỗi. */
export function unwrapFacebookRedirect(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return ''; // khoảng trắng / ký tự điều khiển nhúng trong link: không tin
  try {
    const url = new URL(text, 'https://www.facebook.com');
    if (/^(l|lm)\.facebook\.com$|^www\.facebook\.com$/.test(url.hostname) && url.pathname === '/l.php') {
      const target = url.searchParams.get('u');
      return target ? unwrapFacebookRedirect(target) : '';
    }
    return /^https?:\/\//i.test(text) ? text : '';
  } catch {
    return '';
  }
}

const clean = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, MAX_FIELD).trim() : '';

const titleOf = (c: any): string => clean(c?.title_with_entities?.text) || clean(c?.title);
const descOf = (c: any): string => clean(c?.description?.text) || clean(c?.description);

function buttonLines(card: any): string[] {
  const links = Array.isArray(card?.action_links) ? card.action_links.slice(0, MAX_BUTTONS) : [];
  const lines: string[] = [];
  for (const b of links) {
    const title = clean(b?.title);
    if (!title) continue;
    const url = unwrapFacebookRedirect(b?.url);
    lines.push(url ? `• ${title} — ${url}` : `• ${title}`);
  }
  return lines;
}

/** `ext` = `{ story_attachment }` hoặc chính story. Không có gì đọc được → ''. */
export function templateTextFromStoryAttachment(ext: any): string {
  try {
    const story = ext?.story_attachment ?? ext;
    if (!story || typeof story !== 'object') return '';
    let card = story;
    if (!titleOf(story) && !descOf(story) && Array.isArray(story.subattachments) && story.subattachments[0]) {
      card = story.subattachments[0];
    }
    const lines = [titleOf(card), descOf(card), ...buttonLines(card)].filter((l, i, a) => l && a.indexOf(l) === i);
    if (!lines.length) {
      const fallback = clean(story.source?.text) || unwrapFacebookRedirect(story.url);
      if (fallback) lines.push(fallback);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}
