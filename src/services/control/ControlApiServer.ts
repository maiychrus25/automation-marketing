import Logger from '../../utils/Logger';
import https from 'https';
import type { IncomingMessage, ServerResponse } from 'http';
import type { AddressInfo, Socket } from 'net';
import { Transform, type Readable } from 'stream';
import { IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, VIDEO_EXTENSIONS, extensionOf } from '../facebookPoster/mediaRules';
import type { ControlStore } from './ControlStore';
import type { IdempotencyCache } from './IdempotencyCache';
import { ControlError, describe, toControlError, type ControlErrorCode, type ControlMethod } from './ControlMethods';
import { hashKey, ipAllowed, normalizeIp, type AuthLockout, type RateLimiter } from './controlSecurity';

export const DEFAULT_CONTROL_PORT = 47321;
export const MAX_CALL_BODY_BYTES = 1_048_576;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 64;
const MAX_FILENAME_LENGTH = 200;
const MAX_SUMMARY_KEYS = 20;
const MAX_SUMMARY_CHARS = 500;
const MAX_CONNECTIONS = 64;
const CONNECTIONS_CHECK_INTERVAL_MS = 5_000;
const MAX_CONCURRENT_WAITS_PER_KEY = 4;
const RATE_AUDIT_WINDOW_MS = 60_000;
const INTERNAL_MESSAGE = 'Lỗi nội bộ của MaiHub, thử lại sau';

// Chống slowloris: tiêu đề và bắt tay TLS phải xong nhanh; cả thân yêu cầu có tối đa 5 phút (đủ cho video 200 MB trên LAN chậm).
// `requestTimeout` chỉ tính tới khi nhận xong yêu cầu nên long-poll 25 giây không bị cắt.
const HEADERS_TIMEOUT_MS = 15_000;
const TLS_HANDSHAKE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 300_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const CLOSE_GRACE_MS = 1_000;

const STATUS_BY_CODE: Record<ControlErrorCode, number> = {
    UNAUTHORIZED: 401, FORBIDDEN_IP: 403, RATE_LIMITED: 429, INVALID_PARAMS: 400, NOT_FOUND: 404,
    CONFIRMATION_REQUIRED: 409, BUSY: 409, ENGINE_MISSING: 503, LIMIT_REACHED: 422,
    PAYLOAD_TOO_LARGE: 413, UNKNOWN_METHOD: 404, INTERNAL: 500,
};

export interface SavedMedia { mediaId: string; name: string; size: number; kind: 'image' | 'video' }

export interface ControlApiServerOptions {
    tls: { key: string; cert: string };
    port: number;
    host: string;
    allowList: string[];
    store: ControlStore;
    methods: ControlMethod[];
    idempotency: IdempotencyCache;
    rateLimiter: RateLimiter;
    lockout: AuthLockout;
    /** Lưu tệp (Task 5: userData inbox). Stream sẽ lỗi nếu vượt giới hạn; nên xoá tệp dở khi stream lỗi. */
    saveMedia(name: string, contentType: string, stream: Readable): Promise<SavedMedia>;
    /** Chế độ nhân viên: mọi lời gọi đã xác thực bị từ chối 503 BUSY, kể cả khi server chưa kịp dừng. */
    isBlocked?: () => boolean;
    now?: () => number;
}

/** Tóm tắt tham số cho nhật ký: chỉ tên khoá, mã định danh và số phần tử; không bao giờ có nội dung bài/bình luận. */
function summarizeParams(params: unknown): string {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return '{}';
    const entries = Object.entries(params as Record<string, unknown>);
    const summary: Record<string, unknown> = { keys: entries.slice(0, MAX_SUMMARY_KEYS).map(([k]) => k.slice(0, 40)) };
    if (entries.length > MAX_SUMMARY_KEYS) summary.keyCount = entries.length;
    for (const [k, v] of entries.slice(0, MAX_SUMMARY_KEYS)) {
        if (/^(id|runId|scheduleId|kind|when|mode)$/.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).length <= 64) summary[k] = v;
        else if (Array.isArray(v)) summary[`${k.slice(0, 40)}Count`] = v.length;
    }
    const text = JSON.stringify(summary);
    return text.length <= MAX_SUMMARY_CHARS ? text : JSON.stringify({ truncated: true, keyCount: entries.length });
}

/** Chỉ lấy tên tệp: bỏ thư mục, ký tự điều khiển; null nếu rỗng. */
function sanitizeFilename(header: string | undefined): string | null {
    if (!header) return null;
    let name = header;
    try { name = decodeURIComponent(header); } catch { /* giữ nguyên */ }
    name = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_FILENAME_LENGTH);
    return name && name !== '.' && name !== '..' ? name : null;
}

class PayloadTooLargeError extends Error {}

export class ControlApiServer {
    private server: https.Server | null = null;
    private readonly now: () => number;
    private readonly activeWaits = new Map<string, number>();
    private readonly rateAuditedAt = new Map<string, number>();

    constructor(private readonly opts: ControlApiServerOptions) {
        this.now = opts.now ?? Date.now;
    }

    start(): Promise<{ port: number }> {
        return new Promise((resolve, reject) => {
            const server = https.createServer(
                { key: this.opts.tls.key, cert: this.opts.tls.cert, handshakeTimeout: TLS_HANDSHAKE_TIMEOUT_MS, connectionsCheckingInterval: CONNECTIONS_CHECK_INTERVAL_MS },
                (req, res) => { void this.handle(req, res); },
            );
            server.headersTimeout = HEADERS_TIMEOUT_MS;
            server.requestTimeout = REQUEST_TIMEOUT_MS;
            server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
            server.maxConnections = MAX_CONNECTIONS;
            // Sự kiện 'connection' chạy trên socket thô, trước bắt tay TLS: IP ngoài danh sách bị đóng ở đây.
            server.on('connection', (socket: Socket) => {
                socket.on('error', () => undefined);
                if (!this.isAllowed(socket.remoteAddress)) socket.destroy();
            });
            server.on('tlsClientError', () => undefined);
            server.once('error', reject);
            server.listen(this.opts.port, this.opts.host, () => {
                server.removeListener('error', reject);
                this.server = server;
                resolve({ port: (server.address() as AddressInfo).port });
            });
        });
    }

    stop(): Promise<void> {
        const server = this.server;
        this.server = null;
        if (!server) return Promise.resolve();
        return new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
        });
    }

    private isAllowed(address: string | undefined): boolean {
        return address !== undefined && ipAllowed(address, this.opts.allowList);
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
            await this.pipeline(req, res);
        } catch (err) {
            Logger.error('[control] Lỗi xử lý yêu cầu:', err);
            this.sendError(res, new ControlError('INTERNAL', INTERNAL_MESSAGE));
        }
    }

    private async pipeline(req: IncomingMessage, res: ServerResponse): Promise<void> {
        // (1)-(2) IP: socket không có địa chỉ coi như không được phép; đóng ngay, không trả thân.
        const remote = req.socket.remoteAddress;
        if (!this.isAllowed(remote)) { req.socket.destroy(); return; }
        const ip = normalizeIp(remote as string);
        let path: string;
        try {
            path = new URL(req.url ?? '/', 'http://localhost').pathname;
        } catch {
            Logger.warn('[control] Bỏ qua yêu cầu có đường dẫn không hợp lệ');
            this.sendError(res, new ControlError('NOT_FOUND', 'Không có đường dẫn này'), true);
            return;
        }
        const { lockout, rateLimiter, store } = this.opts;

        // (3) IP đang bị khoá do sai khoá quá nhiều.
        if (lockout.isBlocked(ip)) {
            this.auditRejected(path, null, ip, '(unauthenticated)', 'RATE_LIMITED');
            this.sendError(res, new ControlError('RATE_LIMITED', 'Quá nhiều lần sai khoá, IP này tạm thời bị chặn'), true);
            return;
        }

        if (path === '/v1/health') {
            if (req.method !== 'GET') { this.sendMethodNotAllowed(res, 'GET'); return; }
            this.send(res, 200, { ok: true, protocol: 1 });
            return;
        }

        // (4) Xác thực: băm khoá nhận được rồi tra theo hash, không bao giờ tra bằng khoá thô.
        const match = /^bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''));
        const keyInfo = match ? store.findActiveKeyByHash(hashKey(match[1])) : null;
        if (!keyInfo) {
            lockout.recordFailure(ip);
            this.auditRejected(path, null, ip, '(unauthenticated)', 'UNAUTHORIZED');
            this.sendError(res, new ControlError('UNAUTHORIZED', 'Thiếu hoặc sai khoá truy cập'), true);
            return;
        }
        lockout.recordSuccess(ip);
        store.touchKey(keyInfo.id, this.now());

        // (5) Giới hạn tốc độ theo khoá.
        if (!rateLimiter.take(keyInfo.id)) {
            // Chỉ ghi nhật ký lần bị từ chối đầu tiên của mỗi khoá trong mỗi cửa sổ để kẻ gọi dồn dập không làm đầy bảng.
            const last = this.rateAuditedAt.get(keyInfo.id);
            if (last === undefined || this.now() - last >= RATE_AUDIT_WINDOW_MS) {
                this.rateAuditedAt.set(keyInfo.id, this.now());
                this.auditRejected(path, keyInfo.name, ip, '(rate-limited)', 'RATE_LIMITED');
            }
            this.sendError(res, new ControlError('RATE_LIMITED', 'Gọi quá nhanh (tối đa 60 lời gọi mỗi phút), hãy thử lại sau'), true);
            return;
        }

        if (this.opts.isBlocked?.()) {
            this.auditRejected(path, keyInfo.name, ip, '(employee-mode)', 'BUSY');
            this.send(res, 503, { ok: false, error: { code: 'BUSY', message: 'MaiHub đang ở chế độ nhân viên, không nhận lệnh điều khiển' } }, true);
            return;
        }

        // (6)-(7) Định tuyến và đọc thân (giới hạn kích thước áp khi đang nhận).
        if (path === '/v1/describe') {
            if (req.method !== 'GET') { this.sendMethodNotAllowed(res, 'GET'); return; }
            this.send(res, 200, { ok: true, result: describe(this.opts.methods) });
        } else if (path === '/v1/call') {
            if (req.method !== 'POST') { this.sendMethodNotAllowed(res, 'POST'); return; }
            await this.handleCall(req, res, keyInfo.id, keyInfo.name, ip);
        } else if (path === '/v1/media') {
            if (req.method !== 'POST') { this.sendMethodNotAllowed(res, 'POST'); return; }
            await this.handleMedia(req, res, keyInfo.name, ip);
        } else {
            this.sendError(res, new ControlError('NOT_FOUND', 'Không có đường dẫn này'));
        }
    }

    /** Ghi nhật ký lời gọi /v1/call bị từ chối trước khi vào thao tác; không đọc thân yêu cầu. */
    private auditRejected(path: string, keyName: string | null, ip: string, method: string, errorCode: string): void {
        if (path !== '/v1/call') return;
        try {
            this.opts.store.addAudit({ at: this.now(), keyName, ip, method, paramsSummary: null, ok: false, errorCode, durationMs: 0 });
        } catch (err) {
            Logger.error('[control] Không ghi được nhật ký:', err);
        }
    }

    private async handleCall(req: IncomingMessage, res: ServerResponse, keyId: string, keyName: string, ip: string): Promise<void> {
        const startedAt = this.now();
        let methodName: string | null = null;
        let params: unknown;
        let errorCode: string | null = null;
        let waitHeld = false;
        const abort = new AbortController();
        res.on('close', () => { if (!res.writableFinished) abort.abort(); });
        try {
            const raw = await this.readBody(req, MAX_CALL_BODY_BYTES);
            let parsed: any;
            try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new ControlError('INVALID_PARAMS', 'Thân yêu cầu không phải JSON hợp lệ'); }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ControlError('INVALID_PARAMS', 'Thân yêu cầu phải là một đối tượng JSON');
            if (typeof parsed.method !== 'string' || !parsed.method) throw new ControlError('INVALID_PARAMS', 'Thiếu tham số method', { field: 'method' });
            methodName = parsed.method;
            params = parsed.params ?? {};
            if (typeof params !== 'object' || params === null || Array.isArray(params)) throw new ControlError('INVALID_PARAMS', 'params phải là một đối tượng', { field: 'params' });
            const idem = parsed.idempotencyKey;
            if (idem !== undefined && (typeof idem !== 'string' || !idem || idem.length > MAX_IDEMPOTENCY_KEY_LENGTH)) {
                throw new ControlError('INVALID_PARAMS', `idempotencyKey phải là chuỗi 1–${MAX_IDEMPOTENCY_KEY_LENGTH} ký tự`, { field: 'idempotencyKey' });
            }
            const method = this.opts.methods.find((m) => m.name === methodName);
            if (!method) throw new ControlError('UNKNOWN_METHOD', `Không có thao tác "${methodName}"`);

            let result: unknown;
            if (methodName === 'events.wait') {
                if ((this.activeWaits.get(keyId) ?? 0) >= MAX_CONCURRENT_WAITS_PER_KEY) {
                    throw new ControlError('RATE_LIMITED', `Tối đa ${MAX_CONCURRENT_WAITS_PER_KEY} lời gọi events.wait cùng lúc cho mỗi khoá`);
                }
                this.activeWaits.set(keyId, (this.activeWaits.get(keyId) ?? 0) + 1);
                waitHeld = true;
            }
            try {
                result = await this.opts.idempotency.run(keyId, method.name, idem, () => method.run(params as Record<string, any>, { keyName, signal: abort.signal }));
            } catch (err) {
                if (!(err instanceof ControlError)) { Logger.error(`[control] Thao tác ${methodName} lỗi:`, err); }
                throw toControlError(err);
            }
            this.send(res, 200, { ok: true, result: result ?? null });
        } catch (err) {
            const controlError = err instanceof PayloadTooLargeError
                ? new ControlError('PAYLOAD_TOO_LARGE', 'Thân yêu cầu vượt quá 1 MB')
                : toControlError(err);
            errorCode = controlError.code;
            this.sendError(res, controlError, controlError.code === 'PAYLOAD_TOO_LARGE');
        } finally {
            if (waitHeld) {
                const left = (this.activeWaits.get(keyId) ?? 1) - 1;
                if (left > 0) this.activeWaits.set(keyId, left); else this.activeWaits.delete(keyId);
            }
            try {
                this.opts.store.addAudit({
                    at: startedAt, keyName, ip, method: methodName, paramsSummary: summarizeParams(params),
                    ok: errorCode === null, errorCode, durationMs: this.now() - startedAt,
                });
            } catch (err) {
                Logger.error('[control] Không ghi được nhật ký:', err);
            }
        }
    }

    private async handleMedia(req: IncomingMessage, res: ServerResponse, keyName: string, ip: string): Promise<void> {
        const startedAt = this.now();
        let errorCode: string | null = null;
        let summary = '{}';
        try {
            const name = sanitizeFilename(req.headers['x-filename'] as string | undefined);
            if (!name) throw new ControlError('INVALID_PARAMS', 'Thiếu hoặc sai header X-Filename', { field: 'X-Filename' });
            const ext = extensionOf(name);
            const kind = IMAGE_EXTENSIONS.includes(ext) ? 'image' : VIDEO_EXTENSIONS.includes(ext) ? 'video' : null;
            if (!kind) throw new ControlError('INVALID_PARAMS', `Chỉ nhận ảnh/video: ${[...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS].join(', ')}`, { field: 'X-Filename' });
            const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
            if (!contentType.startsWith(`${kind}/`)) throw new ControlError('INVALID_PARAMS', `Content-Type phải là ${kind}/* khớp với đuôi tệp`, { field: 'Content-Type' });
            const limit = kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
            const tooLarge = new ControlError('PAYLOAD_TOO_LARGE', `Tệp vượt quá ${limit / (1024 * 1024)} MB`);
            const declared = Number(req.headers['content-length']);
            if (Number.isFinite(declared) && declared > limit) { req.resume(); throw tooLarge; }

            let total = 0;
            let exceeded = false;
            const counter = new Transform({
                transform(chunk, _encoding, callback) {
                    total += chunk.length;
                    if (total > limit) { exceeded = true; callback(new PayloadTooLargeError()); } else callback(null, chunk);
                },
            });
            counter.on('error', () => { req.unpipe(counter); req.resume(); }); // dừng lưu nhưng vẫn rút cạn thân để trả được 413
            req.on('error', (err) => counter.destroy(err));
            req.pipe(counter);

            let saved: SavedMedia | undefined;
            try {
                saved = await this.opts.saveMedia(name, contentType, counter);
            } catch (err) {
                if (!exceeded) {
                    if (err instanceof ControlError) throw err;
                    Logger.error('[control] Lưu media lỗi:', err);
                    throw new ControlError('INTERNAL', 'Không lưu được tệp, thử lại sau');
                }
            }
            if (exceeded) throw tooLarge;
            if (!saved) { Logger.error('[control] saveMedia không trả kết quả'); throw new ControlError('INTERNAL', INTERNAL_MESSAGE); }
            summary = JSON.stringify({ kind: saved.kind, size: saved.size });
            this.send(res, 200, { ok: true, result: saved });
        } catch (err) {
            const controlError = toControlError(err);
            errorCode = controlError.code;
            this.sendError(res, controlError, controlError.code === 'PAYLOAD_TOO_LARGE');
        } finally {
            try {
                this.opts.store.addAudit({ at: startedAt, keyName, ip, method: 'media.upload', paramsSummary: summary, ok: errorCode === null, errorCode, durationMs: this.now() - startedAt });
            } catch (err) {
                Logger.error('[control] Không ghi được nhật ký:', err);
            }
        }
    }

    /** Đọc thân tới `limit` byte; vượt thì ném PayloadTooLargeError và rút cạn phần còn lại (không giữ trong bộ nhớ). */
    private readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const declared = Number(req.headers['content-length']);
            if (Number.isFinite(declared) && declared > limit) { req.resume(); reject(new PayloadTooLargeError()); return; }
            const chunks: Buffer[] = [];
            let total = 0;
            let failed = false;
            req.on('data', (chunk: Buffer) => {
                if (failed) return;
                total += chunk.length;
                if (total > limit) { failed = true; chunks.length = 0; reject(new PayloadTooLargeError()); return; }
                chunks.push(chunk);
            });
            req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
            req.on('error', reject);
        });
    }

    private send(res: ServerResponse, status: number, body: unknown, closeAfter = false): void {
        if (res.destroyed || res.writableEnded || res.headersSent) return;
        const payload = JSON.stringify(body);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(payload),
            'Cache-Control': 'no-store',
            ...(closeAfter ? { Connection: 'close' } : {}),
        });
        res.end(payload);
        if (closeAfter) {
            // Thân yêu cầu có thể chưa đọc hết: cho client một khoảng ngắn nhận phản hồi rồi đóng hẳn socket.
            res.once('finish', () => {
                const timer = setTimeout(() => res.socket?.destroy(), CLOSE_GRACE_MS);
                timer.unref();
                res.socket?.once('close', () => clearTimeout(timer));
            });
        }
    }

    private sendError(res: ServerResponse, err: ControlError, closeAfter = false): void {
        this.send(res, STATUS_BY_CODE[err.code], {
            ok: false,
            error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
        }, closeAfter);
    }

    private sendMethodNotAllowed(res: ServerResponse, allow: string): void {
        res.setHeader('Allow', allow);
        this.send(res, 405, { ok: false, error: { code: 'INVALID_PARAMS', message: `Đường dẫn này chỉ nhận ${allow}`, details: { field: 'httpMethod' } } });
    }
}
