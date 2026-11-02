import type { BrowserContext, Page } from 'playwright-core';

export type LogLevel = 'info' | 'success' | 'warning' | 'error';

export interface LaunchedPage { ctx: BrowserContext; page: Page; }

/** Giới hạn tự vận hành cho lượt của bot (origin 'api'): giữ chỗ trước, ghi nhận ngay trước cú bấm Đăng, trả lại nếu chưa bấm. reserve ném LIMIT_REACHED khi bị chặn. */
export interface AutonomyBudget {
    /** Kiểm không giữ chỗ, trước mọi thao tác trên trang; ném LIMIT_REACHED khi đích đã bị chặn. */
    check(targetUrl: string): void;
    reserve(targetUrl: string): number;
    commit(id: number): void;
    release(id: number): void;
}

export interface TaskDeps {
    /** Chỉ có khi lượt do bot duyệt (origin 'api'), là bài đăng và không có autonomyGuard; lượt của anh không bao giờ có. */
    autonomyBudget?: AutonomyBudget;
    autonomyGuard?: import('../../models/pageCampaigns').AutonomyExecutionGuard;
    /** Chỉ có khi đăng chế độ Page: id Page đã học của profile; '' = chưa học được Page → không nhận link nào. */
    expectedPageId?: string;
    /** Đồng hồ cho giờ bấm Đăng của bài Page (`publishedAt`); thiếu thì Date.now. */
    now?: () => number;
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
