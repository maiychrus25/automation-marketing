/**
 * Tải file sao lưu `.db.crypt` của Zalo (URL lấy từ sự kiện syncmsg_info).
 * Nguồn: adapted từ deplao-builder `backupDownload.ts` (không phải port byte-format; viết lại theo MaiHub).
 *
 * Dùng `https.request` (không dùng fetch) để kiểm soát đủ header như Zalo PC và đi qua proxy của tài khoản.
 * An toàn: chỉ https; cookie phiên quyết định THEO TỪNG REQUEST từ hostname đã parse của URL đang gọi
 * (sau mỗi lần chuyển hướng) — không bao giờ tới host ngoài Zalo. URL chứa token → không đưa vào lỗi/log.
 */
import * as fs from 'fs';
import * as https from 'https';
import * as zlib from 'zlib';
import { Transform, Readable } from 'stream';
import { pipeline } from 'stream/promises';

// Cùng danh sách host với ZALO_MEDIA_HOST_RE (utils/zaloImageUrl.ts, không export và nhận URL chứ không phải hostname).
const ZALO_HOST_RE = /(^|\.)(zdn\.vn|zadn\.vn|zalo\.me|zaloapp\.com)$/i;
const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MS = 60 * 1000;
const ERROR_BODY_MAX_BYTES = 1024;
const ERROR_BODY_WAIT_MS = 1000;

export function isZaloHost(hostname: string): boolean {
    return ZALO_HOST_RE.test(hostname);
}

export interface BackupDownloadOptions {
    cookieFor: (url: string) => string;
    userAgent: string;
    agent?: unknown;
    isCancelled?: () => boolean;
    onProgress?: (received: number, total: number) => void;
    request?: typeof https.request;
}

const invalidUrl = () => new Error('Đường dẫn tải bản sao lưu không hợp lệ');
// Chỉ https và không có userinfo (Node sẽ biến userinfo thành header Authorization).
function assertSafeUrl(url: URL): void {
    if (url.protocol !== 'https:' || url.username || url.password) throw invalidUrl();
}
const cancelled = () => Object.assign(new Error('Đã huỷ tải bản sao lưu'), { name: 'AbortError' });

function headersFor(userAgent: string, cookie: string): Record<string, string> {
    const headers: Record<string, string> = {
        'User-Agent': userAgent,
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US',
        'Cache-Control': 'no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'none',
        Connection: 'keep-alive',
    };
    if (cookie) headers.Cookie = cookie;
    return headers;
}

function requestOnce(url: URL, headers: Record<string, string>, opts: BackupDownloadOptions): Promise<any> {
    const request = opts.request || https.request;
    return new Promise((resolve, reject) => {
        const fail = (err: Error) => { clearTimeout(timer); reject(err); };
        const req = (request as any)(url, { method: 'GET', headers, agent: opts.agent }, (res: any) => {
            clearTimeout(timer);
            resolve(res);
        });
        const timer = setTimeout(() => {
            const err = new Error(`Máy chủ ${url.hostname} không phản hồi khi tải bản sao lưu`);
            req.destroy?.(err);
            fail(err);
        }, IDLE_TIMEOUT_MS);
        req.on('error', fail);
        req.end();
    });
}

/** Theo chuyển hướng; trả phản hồi cuối cùng và cho biết có gửi cookie ở request cuối hay không. */
async function fetchFollowing(start: URL, useCookie: boolean, opts: BackupDownloadOptions): Promise<{ res: any; url: URL; sentCookie: boolean }> {
    let url = start;
    for (let redirects = 0; ; redirects++) {
        assertSafeUrl(url);
        if (opts.isCancelled?.()) throw cancelled();
        if (!isZaloHost(url.hostname)) useCookie = false; // đã rời Zalo thì không gửi lại cookie dù sau đó quay về
        const cookie = useCookie ? opts.cookieFor(url.toString()) : '';
        const res = await requestOnce(url, headersFor(opts.userAgent, cookie), opts);
        const location = res.headers?.location;
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && location) {
            res.destroy(); // không giữ body: server treo sau header sẽ không giữ socket
            if (redirects >= MAX_REDIRECTS) throw new Error('Tải bản sao lưu bị chuyển hướng quá nhiều lần');
            try { url = new URL(location, url); } catch { throw invalidUrl(); }
            continue;
        }
        return { res, url, sentCookie: !!cookie };
    }
}

/** Thông báo lỗi JSON của máy chủ (error_code, error_message); bỏ qua nếu không phải JSON hoặc có chứa đường dẫn. */
function serverMessage(body: Buffer, res: any): string {
    try {
        const encoding = String(res.headers?.['content-encoding'] || '').toLowerCase();
        const partial = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
        if (encoding === 'gzip' || encoding === 'x-gzip') body = zlib.gunzipSync(body, partial);
        else if (encoding === 'deflate') body = zlib.inflateSync(body, partial);
        else if (encoding === 'br') body = zlib.brotliDecompressSync(body);
        const json = JSON.parse(body.toString('utf8'));
        const text = String(json?.error_message || json?.message || '').replace(/\s+/g, ' ').trim();
        if (!text || text.includes('://')) return '';
        return `${json?.error_code ?? ''} ${text}`.trim().slice(0, 120);
    } catch { return ''; }
}

/** Đọc tối đa 1 KB nội dung lỗi rồi huỷ phản hồi; máy chủ treo sau header chỉ giữ socket thêm ERROR_BODY_WAIT_MS. */
function readErrorMessage(res: any): Promise<string> {
    return new Promise(resolve => {
        const chunks: Buffer[] = [];
        let size = 0;
        const done = () => {
            clearTimeout(timer);
            res.destroy();
            resolve(serverMessage(Buffer.concat(chunks), res));
        };
        const timer = setTimeout(done, ERROR_BODY_WAIT_MS);
        res.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            size += chunk.length;
            if (size >= ERROR_BODY_MAX_BYTES) done();
        });
        res.on('end', done);
        res.on('error', done);
    });
}

function decoderFor(res: any): Transform | null {
    switch (String(res.headers?.['content-encoding'] || '').toLowerCase()) {
        case 'gzip': case 'x-gzip': return zlib.createGunzip();
        case 'deflate': return zlib.createInflate();
        case 'br': return zlib.createBrotliDecompress();
        default: return null;
    }
}

async function saveResponse(res: any, destPath: string, opts: BackupDownloadOptions): Promise<number> {
    const decoder = decoderFor(res);
    const total = decoder ? 0 : Number(res.headers?.['content-length']) || 0;
    let received = 0;
    let timer: NodeJS.Timeout | undefined;
    const meter: Transform = new Transform({
        transform(chunk: Buffer, _enc, cb) {
            if (opts.isCancelled?.()) return cb(cancelled());
            received += chunk.length;
            arm();
            opts.onProgress?.(received, total);
            cb(null, chunk);
        },
    });
    const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => meter.destroy(new Error('Máy chủ Zalo không gửi dữ liệu khi tải bản sao lưu')), IDLE_TIMEOUT_MS);
    };
    arm();
    const out = fs.createWriteStream(destPath);
    try {
        const source: Readable = res;
        if (decoder) await pipeline(source, decoder, meter, out);
        else await pipeline(source, meter, out);
    } catch (err) {
        // Dọn dẹp best-effort: đợi handle ghi đóng (Windows), không để lỗi dọn che lỗi gốc.
        if (!out.closed) await new Promise<void>(r => { out.once('close', () => r()); out.destroy(); });
        await fs.promises.rm(destPath, { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
        throw err;
    } finally {
        clearTimeout(timer);
    }
    return received;
}

export async function downloadBackupFile(url: string, destPath: string, opts: BackupDownloadOptions): Promise<{ bytes: number }> {
    let start: URL;
    try { start = new URL(url); } catch { throw invalidUrl(); }
    assertSafeUrl(start);

    // Lần 1 có cookie (nếu host Zalo); lần 2 (chỉ khi lần 1 đã gửi cookie và bị 4xx) không cookie.
    let lastStatus = 0;
    let lastHost = start.hostname;
    let detail = '';
    for (const useCookie of [true, false]) {
        const { res, url: finalUrl, sentCookie } = await fetchFollowing(start, useCookie, opts);
        const status = res.statusCode || 0;
        if (status >= 200 && status < 300) return { bytes: await saveResponse(res, destPath, opts) };
        const message = await readErrorMessage(res); // luôn huỷ phản hồi
        detail = detail || message; // lần có cookie nói đúng lý do hơn lần thử lại không cookie
        lastStatus = status;
        lastHost = finalUrl.hostname;
        if (!(sentCookie && status >= 400 && status < 500)) break;
    }
    // Chỉ hostname, mã HTTP và thông báo lỗi của máy chủ; URL có token nên không đưa vào lỗi.
    throw new Error(`Tải bản sao lưu thất bại (HTTP ${lastStatus}, ${lastHost}${detail ? `: ${detail}` : ''})`);
}
