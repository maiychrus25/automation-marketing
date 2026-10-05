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
