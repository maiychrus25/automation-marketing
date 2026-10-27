// Client API `ad_video` của AHV AI (spec docs/specs/2026-10-27-ad-video.md mục 5).
// Dùng lại RenderError của RenderClient để toControlError không cần mã lỗi mới.
import * as fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { RenderError, type RenderErrorCode } from './RenderClient';

export interface AdStep { name: string; k?: number; n?: number }

export interface AdJobResult {
    url?: string;
    thumb_url?: string;
    grid_url?: string;
    expires_at?: string;
    duration?: number;
    width?: number;
    height?: number;
    cost_usd?: { h3?: number; lipsync?: number; total?: number };
    scenes?: { index: number; type: string; status: string; model?: string | null; start?: number; end?: number; retry?: number }[];
    stt_text?: string;
    warnings?: { code?: string }[] | string[];
}

export interface AdJobView {
    status: string; // queued | running | succeeded | failed (tên lạ vẫn trả về nguyên văn)
    progress: number; // 0–100 theo hợp đồng AHV
    step?: AdStep;
    result?: AdJobResult;
    error?: { code?: number; reason?: string; message?: string };
}

export interface AdVoice { id: string; name: string; gender?: string; region?: string }

const META_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;
/**
 * Trần tải mp4/bìa kết quả. Ngắn hơn trần tải lên vì việc này chạy trong vòng theo dõi chung:
 * một lần tải treo sẽ làm mọi video khác không được hỏi trạng thái trong suốt thời gian đó.
 */
const RESULT_TIMEOUT_MS = 3 * 60_000;

/** Lỗi lúc chạy (5xx) là lỗi máy chủ; 400/401 là lỗi đầu vào; 429 và 503 là "chờ rồi gửi lại". */
function classify(status: number): RenderErrorCode {
    if (status === 429 || status === 503) return 'limit';
    if (status === 404) return 'not_found';
    if (status === 400 || status === 401 || status === 413 || status === 415) return 'invalid';
    return 'server';
}

const STEP_LABELS: Record<string, string> = {
    giong: 'Đọc lời',
    anh: 'Tạo ảnh',
    h3: 'H3',
    khop_moi: 'Khớp môi',
    nhuong_khach: 'Nhường máy cho khách khác',
};

/**
 * Chữ hiện cho người và cho bot từ `step` của AHV. Tên bước lạ không phải lỗi: hiện nguyên tên.
 * Không có `step` mà progress ≥ 85 nghĩa là đang dựng/kiểm (hợp đồng mục 11).
 */
export function adStepText(step: AdStep | undefined, progress: number): string {
    if (!step || typeof step.name !== 'string' || !step.name) return progress >= 85 ? 'Đang dựng video' : '';
    const label = STEP_LABELS[step.name] ?? step.name;
    const counted = Number.isFinite(step.k) && Number.isFinite(step.n) && step.name !== 'nhuong_khach';
    return counted ? `${label} ${step.k}/${step.n}` : label;
}

export class AhvAdClient {
    constructor(
        private readonly baseUrl: string,
        private readonly apiKey: string,
        private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    ) {}

    /** `/healthz` của AHV không đòi khoá: chỉ cho biết máy chủ còn sống. */
    health(): Promise<{ ok?: boolean }> {
        return this.json('GET', '/healthz', undefined, false);
    }

    /** Khoá có đúng hay không chỉ biết được qua một đường cần khoá; `/v1/audio/voices` là đường rẻ nhất. */
    async voices(): Promise<AdVoice[]> {
        const body = await this.json<{ data?: AdVoice[] }>('GET', '/v1/audio/voices');
        return Array.isArray(body?.data) ? body.data : [];
    }

    /** Tải tệp trên máy lên AHV, trả link công khai để đưa vào payload. */
    async upload(filePath: string, fileName: string): Promise<string> {
        let blob: Blob;
        try { blob = await fs.openAsBlob(filePath); } catch { throw new RenderError('invalid', `Không đọc được tệp ${fileName}`); }
        const form = new FormData();
        form.append('file', blob, fileName);
        const body = await this.json<{ ok?: boolean; url?: string; error?: unknown }>('POST', '/upload', form, true, TRANSFER_TIMEOUT_MS);
        if (!body?.ok || typeof body.url !== 'string' || !body.url) {
            throw new RenderError('invalid', this.redact(typeof body?.error === 'string' ? body.error : `Tải tệp ${fileName} lên AHV AI thất bại`));
        }
        return body.url;
    }

    async createJob(payload: unknown, webhookUrl?: string): Promise<{ jobId: string; predictTime: number }> {
        const body = await this.json<{ ok?: boolean; job_id?: string; predict_time?: number }>(
            'POST', '/v1/jobs',
            JSON.stringify({ task: 'ad_video', payload, ...(webhookUrl ? { webhook_url: webhookUrl } : {}) }),
        );
        if (!body?.job_id) throw new RenderError('server', 'AHV AI không trả mã việc');
        return { jobId: body.job_id, predictTime: Number(body.predict_time) || 0 };
    }

    async job(jobId: string): Promise<AdJobView> {
        const body = await this.json<any>('GET', `/v1/jobs/${encodeURIComponent(jobId)}`);
        const step = body?.step && typeof body.step === 'object' && typeof body.step.name === 'string' ? (body.step as AdStep) : undefined;
        return {
            status: String(body?.status ?? ''),
            progress: Number.isFinite(body?.progress) ? Number(body.progress) : 0,
            ...(step ? { step } : {}),
            ...(body?.result && typeof body.result === 'object' ? { result: body.result as AdJobResult } : {}),
            ...(body?.error && typeof body.error === 'object' ? { error: body.error } : {}),
        };
    }

    /** Tải tệp kết quả về `dest` qua tệp tạm rồi đổi tên: không bao giờ để lại tệp dở ở `dest`. */
    async download(url: string, dest: string): Promise<void> {
        const res = await this.requestUrl('GET', url, undefined, false, RESULT_TIMEOUT_MS);
        if (!res.body) throw new RenderError('server', 'AHV AI trả về tệp rỗng');
        const part = `${dest}.part`;
        try {
            await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(part));
            fs.renameSync(part, dest);
        } catch (e) {
            fs.rmSync(part, { force: true });
            throw this.toError(e);
        }
    }

    private async json<T>(method: string, path: string, body?: FormData | string, auth = true, timeoutMs = META_TIMEOUT_MS): Promise<T> {
        if (!this.baseUrl.trim() || (auth && !this.apiKey)) throw new RenderError('unconfigured', 'Chưa cấu hình API AHV AI cho video quảng cáo');
        const res = await this.requestUrl(method, `${this.baseUrl.replace(/\/+$/, '')}${path}`, body, auth, timeoutMs);
        try { return (await res.json()) as T; } catch (e) { throw this.toError(e); }
    }

    private async requestUrl(method: string, url: string, body: FormData | string | undefined, auth: boolean, timeoutMs: number): Promise<Response> {
        const headers: Record<string, string> = {};
        if (auth && this.apiKey) headers['X-API-Key'] = this.apiKey;
        if (typeof body === 'string') headers['Content-Type'] = 'application/json';
        let res: Response;
        try {
            res = await this.fetchImpl(url, { method, body, headers, signal: AbortSignal.timeout(timeoutMs) });
        } catch (e) {
            throw this.toError(e);
        }
        if (res.ok) return res;
        throw new RenderError(classify(res.status), this.redact(await this.messageOf(res)));
    }

    /**
     * Thông báo của AHV: `error.message` (dạng AD_*), `error` chuỗi, `detail` (lỗi toàn cục), hoặc câu mặc định.
     * 401 luôn nói bằng câu của mình: thân thật của AHV chỉ có chữ `unauthorized`, không giúp gì người dùng.
     */
    private async messageOf(res: Response): Promise<string> {
        if (res.status === 401) return 'Khoá API AHV AI không đúng';
        let body: any = null;
        try { body = await res.json(); } catch { /* thân không phải JSON */ }
        const text = typeof body?.error === 'object' && body?.error
            ? String(body.error.message ?? body.error.reason ?? '')
            : String(body?.error ?? body?.detail ?? '');
        if (text) return text;
        if (res.status === 404) return 'AHV AI không còn việc này';
        return `AHV AI trả lỗi ${res.status}`;
    }

    private toError(e: unknown): RenderError {
        if (e instanceof RenderError) return e;
        return new RenderError('unreachable', 'Không kết nối được AHV AI');
    }

    /** Khoá API không bao giờ nằm trong thông báo lỗi. */
    private redact(text: string): string {
        return this.apiKey ? text.split(this.apiKey).join('***') : text;
    }
}
