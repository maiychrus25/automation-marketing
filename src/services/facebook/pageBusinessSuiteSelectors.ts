/**
 * pageBusinessSuiteSelectors.ts
 * Hằng số DOM + deep-link của Meta Business Suite inbox, dùng cho gửi tin vai Page.
 *
 * GIÁ TRỊ TẠM: các selector dưới đây là ứng viên mặc định; phải được xác nhận/
 * thay bằng giá trị probe thật (Task 1 của plan) trước khi driver DOM thật
 * (Task 4) dựa vào. Logic không phụ thuộc giá trị cụ thể — chỉ phụ thuộc tên field.
 */

export interface PageBizSuiteSelectors {
  /** Ô soạn tin (contenteditable/textarea). */
  composer: string;
  /** Nút gửi; null nếu gửi bằng phím Enter. */
  sendButton: string | null;
  /** input[type=file] để đính kèm ảnh/file. */
  fileInput: string;
  /** Selector xác nhận tin vừa gửi đã lên khung chat. */
  outgoingBubble: string;
}

export const PAGE_BIZ_SUITE: PageBizSuiteSelectors = {
  composer: 'div[contenteditable="true"][role="textbox"]',
  sendButton: null,
  fileInput: 'input[type="file"]',
  outgoingBubble: '[data-scope="messages"] [data-is-outgoing="true"]',
};

/**
 * Template URL mở một hội thoại cụ thể trong inbox Page.
 * {asset} = delegate page id, {thread} = threadId/threadKey của hội thoại.
 */
export const THREAD_URL_TEMPLATE =
  'https://business.facebook.com/latest/inbox/all?asset_id={asset}&selected_item_id={thread}&thread_type=FB_MESSAGE';
