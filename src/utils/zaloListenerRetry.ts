// Vòng đời websocket Zalo: để zca-js tự nối lại cùng phiên (retryOnClose), chỉ bỏ cuộc
// (đăng nhập lại đầy đủ) khi zca-js hết lượt ("closed") hoặc quá WATCHDOG mà chưa "connected".
export const ZCA_RETRY_WATCHDOG_MS = 90_000;

// Cờ ngắt-tay KHÔNG nằm ở đây: disconnectUser gỡ connection cũ nên so sánh connection đã đủ,
// còn cờ chỉ được xoá ở onConnected - đưa vào đây sẽ chặn vĩnh viễn lần kết nối lại sau khi ngắt tay.
export function isCurrentZaloListener(p: { removed: boolean; currentConnection: unknown; connection: unknown }): boolean {
    return !p.removed && p.currentConnection === p.connection;
}

export function wireZaloListenerLifecycle(listener: any, hooks: {
    isCurrent: () => boolean;
    onConnected: () => void;
    onGiveUp: (eventType: 'closed' | 'retry_timeout', code: number, reason: string) => void;
    log?: (message: string) => void;
}): void {
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let finished = false; // đã bỏ cuộc: listener này không bao giờ được tự chạy lại
    let started = false;
    let lastCode = 0;
    let lastReason = '';

    const clearWatchdog = () => {
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    };
    const giveUp = (eventType: 'closed' | 'retry_timeout') => {
        if (finished) return;
        finished = true;
        clearWatchdog();
        hooks.onGiveUp(eventType, lastCode, lastReason);
    };

    const origCanRetry = listener.canRetry.bind(listener);
    listener.canRetry = (code: number) => (finished || !hooks.isCurrent() ? false : origCanRetry(code));

    const origStart = listener.start.bind(listener);
    listener.start = (...args: any[]) => {
        // Lần start đầu luôn chạy; start do zca-js hẹn giờ phải bị chặn nếu listener đã cũ.
        if (started && (finished || !hooks.isCurrent())) {
            hooks.log?.('blocked scheduled start of stale listener');
            giveUp('closed'); // hết đời listener: không chờ watchdog (giveUp chỉ chạy một lần)
            return;
        }
        started = true;
        return origStart(...args);
    };

    listener.on('connected', () => {
        if (finished) return;
        clearWatchdog();
        if (!hooks.isCurrent()) {
            hooks.log?.('stale listener reconnected - stopping it');
            finished = true;
            listener.stop();
            return;
        }
        for (const entry of Object.values(listener.retryCount || {}) as any[]) entry.count = 0;
        hooks.onConnected();
    });

    listener.on('disconnected', (code: number, reason: string) => {
        if (finished) return;
        lastCode = code;
        lastReason = reason;
        clearWatchdog();
        watchdog = setTimeout(() => {
            watchdog = null;
            if (finished) return;
            try { listener.stop(); } catch { /* socket đã đóng */ }
            giveUp('retry_timeout');
        }, ZCA_RETRY_WATCHDOG_MS);
    });

    listener.on('closed', (code: number, reason: string) => {
        lastCode = code;
        lastReason = reason;
        giveUp('closed');
    });
}
