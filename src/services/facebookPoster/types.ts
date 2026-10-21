import type { BrowserContext, Page } from 'playwright-core';

export type LogLevel = 'info' | 'success' | 'warning' | 'error';

export interface LaunchedPage { ctx: BrowserContext; page: Page; }

export interface TaskDeps {
    /** Opens the profile's automation browser. The task closes ctx itself when done (as FB Poster did). */
    launch: () => Promise<LaunchedPage>;
    getIsStopping: () => boolean;
    sendLog: (message: string, level: LogLevel) => void;
    updateProgress: (percent: number, label: string) => void;
    /** Bao thao tác không hoàn tác được (bấm Đăng, bấm Tham gia) tới khi có kết quả; Hủy không đóng trình duyệt trong đoạn này. */
    enterCritical?: () => void;
    leaveCritical?: () => void;
    /** Chỉ gọi khi chắc chắn chưa có cú bấm nào (lần thử lỗi trước khi bấm Đăng, sắp thử lại). */
    clearReachedCritical?: () => void;
    /** Lưu ảnh + ghi chú sau mỗi lần đăng thất bại; trả tên tệp (không kèm đường dẫn) hoặc null. Lỗi của hàm này không được làm hỏng lượt đăng. */
    saveDiagnostic?: (page: Page, info: { targetUrl: string; attempt: number; errorCode: string }) => Promise<string | null>;
}
