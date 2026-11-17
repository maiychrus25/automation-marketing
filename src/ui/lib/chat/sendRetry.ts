/** Mã kết quả của máy Boss mà gửi lại không thể thành công, hoặc có thể gửi trùng tin. */
const NEVER_RETRY_CODES = new Set([
    'TIMEOUT', // lệnh có thể đã được Boss thực hiện
    'BAD_RESPONSE', // câu trả lời không hợp lệ của Boss không chứng minh lệnh chưa được thực hiện
    'BOSS_ONLY', 'UPLOAD_FAILED', 'ACCOUNT_REQUIRED', 'ACCOUNT_FORBIDDEN', 'MODULE_FORBIDDEN', 'PATH_FORBIDDEN',
]);

/** Kết quả không có `code` (Zalo, máy Boss) giữ nguyên hành vi cũ: được gửi lại. */
export function isRetryableSendCode(code?: string): boolean {
    return !code || !NEVER_RETRY_CODES.has(code);
}

/** Chữ "timeout" trong lỗi (kể cả khi nơi gọi thêm tiền tố): không gửi lại. Phân biệt hoa/thường như cũ. */
export function isTimeoutErrorText(errorMsg: string): boolean {
    return errorMsg.includes('timeout');
}
