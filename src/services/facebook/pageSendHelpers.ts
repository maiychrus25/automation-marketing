/**
 * pageSendHelpers.ts
 * Helper thuần cho gửi tin vai Page qua Business Suite: dựng deep-link hội thoại,
 * phân loại file theo đuôi. Không import electron/playwright để test được.
 */

import { THREAD_URL_TEMPLATE } from './pageBusinessSuiteSelectors';

export type PageFileType = 'image' | 'video' | 'audio' | 'file';

/** URL mở đúng một hội thoại trong inbox Page. */
export function buildThreadUrl(delegatePageId: string, threadId: string): string {
  return THREAD_URL_TEMPLATE
    .replace('{asset}', encodeURIComponent(delegatePageId))
    .replace('{thread}', encodeURIComponent(threadId));
}

const EXT_TYPE: Record<string, PageFileType> = {
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', bmp: 'image',
  mp4: 'video', webm: 'video', mov: 'video', avi: 'video', mkv: 'video',
  mp3: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', wav: 'audio',
};

/** Phân loại file theo đuôi; mặc định 'file'. */
export function classifyFile(path: string): PageFileType {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return (m && EXT_TYPE[m[1].toLowerCase()]) || 'file';
}

/** threadId gửi được của Page = selected_item_id, luôn là id khách toàn số. */
export function isSendableThreadId(threadId: string): boolean {
  return typeof threadId === 'string' && /^\d+$/.test(threadId);
}

/**
 * Phân loại media từ body thông báo Page (thông báo không kèm nội dung thật).
 * Thứ tự: sticker trước (vì "nhãn dán" không trùng ảnh/video), rồi video, rồi ảnh.
 */
export function classifyPageNotification(body: string): 'image' | 'video' | 'sticker' | null {
  const b = body || '';
  if (/nhãn dán|sent a sticker/i.test(b)) return 'sticker';
  if (/tin nhắn video|đã gửi.*video|sent .*video/i.test(b)) return 'video';
  if (/đã gửi.*ảnh|sent .*photo/i.test(b)) return 'image';
  return null;
}
