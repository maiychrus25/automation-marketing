/**
 * FacebookPageBrowserSender.ts
 * Gửi tin vai Page bằng cách điều khiển client Meta Business Suite thật.
 *
 * File này chỉ chứa phần ĐIỀU PHỐI (mutex per-Page, ánh xạ lỗi, định dạng kết quả)
 * sau interface PageInboxDriver, để unit-test không cần trình duyệt. Driver DOM thật
 * (playwright) + vòng đời trình duyệt + factory get() nằm ở pagePlaywrightDriver.ts,
 * nạp động để file này không kéo theo playwright khi test.
 */

export interface PageSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface PageSendInput {
  text?: string;
  files?: { path: string; type: 'image' | 'video' | 'audio' | 'file' }[];
  replyToMessageId?: string;
}

/** Thao tác DOM tối thiểu trên inbox Business Suite; driver thật hoặc fake đều hiện thực. */
export interface PageInboxDriver {
  /** Mở đúng hội thoại; ném nếu không mở được / phiên hỏng. */
  openThread(threadId: string): Promise<void>;
  /** Gõ text và gửi (Enter hoặc nút gửi). */
  sendText(text: string): Promise<void>;
  /** Đặt file vào input đính kèm và chờ upload. */
  attachFiles(paths: string[]): Promise<void>;
  /** Chờ tin vừa gửi lên khung; ném nếu quá hạn. */
  waitSent(timeoutMs: number): Promise<void>;
}

const SENT_TIMEOUT_MS = 20000;

export class FacebookPageBrowserSender {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private deps: { driver: PageInboxDriver; delegatePageId: string }) {}

  /** Gửi một tin (text và/hoặc đính kèm). Các lệnh gửi cùng instance nối tiếp nhau. */
  send(threadId: string, input: PageSendInput): Promise<PageSendResult> {
    const run = this.queue.then(
      () => this.doSend(threadId, input),
      () => this.doSend(threadId, input),
    );
    this.queue = run.catch(() => {});
    return run;
  }

  private async doSend(threadId: string, input: PageSendInput): Promise<PageSendResult> {
    const hasText = !!(input.text && input.text.trim());
    const files = input.files || [];
    if (!hasText && files.length === 0) {
      return { success: false, error: 'Không có nội dung để gửi' };
    }
    try {
      await this.deps.driver.openThread(threadId);
      if (files.length) await this.deps.driver.attachFiles(files.map((f) => f.path));
      await this.deps.driver.sendText(input.text || '');
      await this.deps.driver.waitSent(SENT_TIMEOUT_MS);
      return { success: true, messageId: `page:${Date.now()}` };
    } catch (err: any) {
      return { success: false, error: `Chưa gửi được từ Page qua Business Suite: ${err?.message || err}` };
    }
  }
}
