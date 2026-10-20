import * as fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

export type RenderErrorCode = 'unconfigured' | 'unreachable' | 'limit' | 'invalid' | 'not_found' | 'server';

export class RenderError extends Error {
    constructor(public readonly code: RenderErrorCode, message: string) {
        super(message);
        this.name = 'RenderError';
    }
}

export interface RenderTemplate {
    id: string; name: string; description: string; aspects: string[];
    durationSec: { min: number; max: number; default: number };
    imageSlots: { min: number; max: number };
    variables: Record<string, { type: 'string' | 'color' | 'number'; label: string; maxLength?: number; default: unknown }>;
}
export interface RenderMusic { id: string; name: string; durationSec: number; license: string; source: string }
export interface RenderCatalog { templates: RenderTemplate[]; music: RenderMusic[] }
export interface RenderJobView {
    jobId: string; status: 'queued' | 'rendering' | 'done' | 'failed' | 'cancelled'; progress: number;
    position?: number; error?: string; durationSec?: number; sizeBytes?: number; createdAt: number; finishedAt?: number;
}
export interface CreatedJob { jobId: string; status: string; position?: number; files: Record<string, string> }

const META_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;

export class RenderClient {
    constructor(
        private readonly baseUrl: string,
        private readonly apiKey: string,
        private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    ) {}

    health(): Promise<{ ok: boolean; version: string; hyperframes: string; queue: { length: number } }> {
        return this.json('GET', '/v1/health', undefined, false);
    }

    templates(): Promise<RenderCatalog> {
        return this.json('GET', '/v1/templates');
    }

    job(id: string): Promise<RenderJobView> {
        return this.json('GET', `/v1/jobs/${encodeURIComponent(id)}`);
    }

    cancel(id: string): Promise<{ jobId: string; status: string; deleted?: boolean }> {
        return this.json('DELETE', `/v1/jobs/${encodeURIComponent(id)}`);
    }

    async createJob(spec: unknown, files: { path: string; name: string }[]): Promise<CreatedJob> {
        const form = new FormData();
        form.append('spec', JSON.stringify(spec));
        for (const f of files) {
            let blob: Blob;
            try { blob = await fs.openAsBlob(f.path); } catch { throw new RenderError('invalid', `Không đọc được tệp ${f.name}`); }
            form.append('files', blob, f.name);
        }
        return this.json('POST', '/v1/jobs', form, true, TRANSFER_TIMEOUT_MS);
    }

    /** Tải về `dest` qua tệp tạm rồi đổi tên: không bao giờ để lại tệp dở ở `dest`. */
    async download(id: string, kind: 'video' | 'thumb', dest: string): Promise<void> {
        const res = await this.request('GET', `/v1/jobs/${encodeURIComponent(id)}/${kind}`, undefined, true, TRANSFER_TIMEOUT_MS);
        if (!res.body) throw new RenderError('server', 'Máy chủ render trả về tệp rỗng');
        const part = `${dest}.part`;
        try {
            await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(part));
            fs.renameSync(part, dest);
        } catch (e) {
            fs.rmSync(part, { force: true });
            throw this.toError(e);
        }
    }

    private async json<T>(method: string, path: string, body?: FormData, auth = true, timeoutMs = META_TIMEOUT_MS): Promise<T> {
        const res = await this.request(method, path, body, auth, timeoutMs);
        try { return (await res.json()) as T; } catch (e) { throw this.toError(e); }
    }

    private async request(method: string, path: string, body: FormData | undefined, auth: boolean, timeoutMs: number): Promise<Response> {
        if (!this.baseUrl.trim() || (auth && !this.apiKey)) throw new RenderError('unconfigured', 'Chưa cấu hình máy chủ render video');
        let res: Response;
        try {
            res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
                method, body,
                headers: auth ? { Authorization: `Bearer ${this.apiKey}` } : undefined,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (e) {
            throw this.toError(e);
        }
        if (res.ok) return res;
        let message = '';
        try { message = String((await res.json())?.error?.message ?? ''); } catch { /* thân không phải JSON */ }
        throw new RenderError(this.classify(res.status), this.redact(message || `Máy chủ render trả lỗi ${res.status}`));
    }

    private classify(status: number): RenderErrorCode {
        if (status === 429) return 'limit';
        if (status === 404) return 'not_found';
        if (status === 400 || status === 401 || status === 413 || status === 415) return 'invalid';
        return 'server';
    }

    private toError(e: unknown): RenderError {
        if (e instanceof RenderError) return e;
        return new RenderError('unreachable', 'Không kết nối được máy chủ render');
    }

    /** Khoá API không bao giờ nằm trong thông báo lỗi. */
    private redact(text: string): string {
        return this.apiKey ? text.split(this.apiKey).join('***') : text;
    }
}
