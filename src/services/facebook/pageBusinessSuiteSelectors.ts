/**
 * pageBusinessSuiteSelectors.ts
 * Hằng số DOM + deep-link của Meta Business Suite inbox, dùng cho gửi tin vai Page.
 * Giá trị xác nhận bằng probe trực tiếp 05/10/2026 (ungoogled-chromium 148, headless).
 */

export interface PageBizSuiteSelectors {
  /** Ô soạn tin (contenteditable). */
  composer: string;
  /** Nút gửi (fallback khi Enter không gửi). */
  sendButton: string;
  /** Nút đính kèm; click sẽ bật file chooser của trình duyệt. */
  attachButton: string;
}

export const PAGE_BIZ_SUITE: PageBizSuiteSelectors = {
  composer: 'div[contenteditable="true"][role="textbox"]',
  sendButton: 'div[aria-label*="Gửi" i][role="button"]',
  attachButton: '[aria-label="Đính kèm file"]',
};

/**
 * Template URL mở một hội thoại cụ thể trong inbox Page (xác nhận từ href nav của Business Suite).
 * {asset} = delegate page id, {thread} = selected_item_id = id khách (threadId app lưu).
 */
export const THREAD_URL_TEMPLATE =
  'https://business.facebook.com/latest/inbox/all?asset_id={asset}&selected_item_id={thread}&thread_type=FB_MESSAGE';
