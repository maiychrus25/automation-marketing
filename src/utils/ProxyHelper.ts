import Logger from './Logger';
import type { ProxyConfig } from '../models';

/**
 * Tạo proxy URL từ cấu hình proxy.
 * Format: protocol://user:pass@host:port
 */
export function buildProxyUrl(proxy: ProxyConfig): string {
    const auth = proxy.username
        ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
        : '';
    return `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

/**
 * Tạo proxy agent tương thích với zca-js (agent option trong Zalo constructor).
 * Dùng proxy-agent để tự động nhận diện HTTP/HTTPS/SOCKS4/SOCKS5.
 * Trả về undefined nếu proxy là null/undefined hoặc nếu tạo thất bại.
 */
export function createProxyAgent(proxy: ProxyConfig | null | undefined): any {
    if (!proxy) return undefined;

    const proxyUrl = buildProxyUrl(proxy);

    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ProxyAgent } = require('proxy-agent');
        Logger.log(`[ProxyHelper] Creating proxy agent for ${proxy.host}:${proxy.port} (${proxy.name}) type=${proxy.type}`);
        // getProxyForUrl callback - proxy-agent auto-detects HTTP/HTTPS/SOCKS from URL protocol
        return new ProxyAgent({
            getProxyForUrl: () => proxyUrl
        });
    } catch (err: any) {
        Logger.error(`[ProxyHelper] Failed to create proxy agent for "${proxy.name}": ${err.message}`);
        return undefined;
    }
}

/**
 * Một lần thử qua proxy có thành công không, theo mã HTTP nhận được. Khi máy chủ proxy từ chối đường hầm (ví dụ 403 do
 * hết hạn hoặc sai tài khoản, 407 do thiếu xác thực), thư viện proxy đưa chính phản hồi đó về như phản hồi của trang đích,
 * nên "có phản hồi" chưa có nghĩa là proxy dùng được: chỉ mã 2xx / 3xx mới tính.
 */
export function isProxyProbeOk(status: number): boolean {
    return status >= 200 && status < 400;
}

/**
 * Gửi một yêu cầu HEAD tới `url` qua proxy. ok theo `isProxyProbeOk`; lỗi mạng hoặc quá hạn thì ok = false, status = 0.
 * Chỉ dùng với trang đích trả 2xx / 3xx cho HEAD khi nối thẳng.
 */
export function headThroughProxy(agent: any, url: string, timeoutMs = 10000): Promise<{ ok: boolean; status: number; ms: number }> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const https = require('https');
    return new Promise((resolve) => {
        const start = Date.now();
        const parsedUrl = new URL(url);
        const req = https.request(
            { hostname: parsedUrl.hostname, path: parsedUrl.pathname, method: 'HEAD', agent, timeout: timeoutMs },
            (res: any) => {
                resolve({ ok: isProxyProbeOk(res.statusCode || 0), status: res.statusCode || 0, ms: Date.now() - start });
                res.resume();
            }
        );
        req.on('error', () => resolve({ ok: false, status: 0, ms: Date.now() - start }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, ms: Date.now() - start }); });
        req.end();
    });
}

/** Hai trang trung lập dùng để thử một proxy; một trang vào được là đủ (trang kia có thể bị chặn hoặc chậm ở mạng đó). */
const PROXY_CHECK_URLS = ['https://www.google.com', 'https://httpbin.org/get'];

/**
 * Proxy có dùng được không: thử lần lượt các trang trung lập, dừng ở trang đầu tiên vào được. Dùng chung cho nút Test và
 * cho việc gán proxy vào tài khoản, để "Test báo được" và "gán được" luôn là một.
 */
export async function checkProxyWorks(agent: any): Promise<{ ok: boolean; status: number; ms: number }> {
    let last = { ok: false, status: 0, ms: 0 };
    for (const url of PROXY_CHECK_URLS) {
        last = await headThroughProxy(agent, url);
        if (last.ok) return last;
    }
    return last;
}
