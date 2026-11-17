import { isRetryableSendCode } from '../../ui/lib/chat/sendRetry';

describe('isRetryableSendCode', () => {
    it.each([undefined, '', 'NOT_CONNECTED', 'SOMETHING_ELSE'])('allows a retry for %p', (code) => {
        expect(isRetryableSendCode(code)).toBe(true);
    });
    it.each(['TIMEOUT', 'BAD_RESPONSE', 'BOSS_ONLY', 'UPLOAD_FAILED', 'ACCOUNT_REQUIRED', 'ACCOUNT_FORBIDDEN', 'MODULE_FORBIDDEN', 'PATH_FORBIDDEN'])('never retries %s', (code) => {
        expect(isRetryableSendCode(code)).toBe(false);
    });
});

import { isTimeoutErrorText } from '../../ui/lib/chat/sendRetry';

describe('isTimeoutErrorText', () => {
    const bossTimeout = 'Máy Boss chưa trả lời kịp (timeout). Lệnh có thể đã được thực hiện; hãy kiểm tra hội thoại trước khi thử lại.';
    it('matchesTheBossTimeoutSentenceAloneAndWithAPrefix', () => {
        expect(isTimeoutErrorText(bossTimeout)).toBe(true);
        expect(isTimeoutErrorText('Gửi video Facebook thất bại: ' + bossTimeout)).toBe(true);
    });
    it('keepsTheOldBehaviourForExistingMessages', () => {
        expect(isTimeoutErrorText('Send timeout (60s)')).toBe(true);
        expect(isTimeoutErrorText('Gửi tin nhắn Facebook thất bại')).toBe(false);
        expect(isTimeoutErrorText('Chưa nối được máy Boss')).toBe(false);
        expect(isTimeoutErrorText('Request Timeout')).toBe(false); // case-sensitive as before
        expect(isTimeoutErrorText('')).toBe(false);
    });
});
