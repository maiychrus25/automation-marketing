import * as http from 'http';
import type { AddressInfo } from 'net';

export const TEST_KEY = 'secret-key-1234567890';
const MP4 = Buffer.from('fake-mp4-bytes');
const JPG = Buffer.from('fake-jpg');

export interface FakeJob { status: string; progress: number; error?: string; durationSec?: number; sizeBytes?: number }

/** Máy chủ render giả: một phần nhỏ của API thật (/v1/health, templates, jobs). */
export class FakeRenderServer {
    jobs = new Map<string, FakeJob>();
    uploads: { spec: any; files: string[]; rawLength: number }[] = [];
    downloads: string[] = [];
    failWith: number | null = null; // ép mọi /v1/jobs trả mã này
    private server!: http.Server;
    url = '';

    async start(): Promise<void> {
        this.server = http.createServer((req, res) => void this.handle(req, res));
        await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
        this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    }

    async stop(): Promise<void> {
        this.server.closeAllConnections();
        await new Promise((r) => this.server.close(r));
    }

    private send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json'): void {
        const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
        res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length });
        res.end(data);
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks);
        const p = req.url ?? '';
        if (p === '/v1/health') return this.send(res, 200, { ok: true, version: '1', hyperframes: '0.8.181', queue: { length: 0 } });
        if (req.headers.authorization !== `Bearer ${TEST_KEY}`) return this.send(res, 401, { error: { code: 'UNAUTHORIZED', message: `Sai khoá ${req.headers.authorization}` } });
        if (this.failWith && p.startsWith('/v1/jobs')) return this.send(res, this.failWith, { error: { code: 'X', message: 'Lỗi giả' } });
        if (p === '/v1/templates') {
            return this.send(res, 200, {
                templates: [{
                    id: 'flash-sale', name: 'Flash sale', description: 'd', aspects: ['9:16', '1:1'],
                    durationSec: { min: 15, max: 30, default: 20 }, imageSlots: { min: 1, max: 2 },
                    variables: {
                        title: { type: 'string', label: 'Tiêu đề', maxLength: 10, default: 'x' },
                        accent: { type: 'color', label: 'Màu nhấn', default: '#ff0000' },
                        durationSec: { type: 'number', label: 'Thời lượng', default: 20 },
                    },
                }],
                music: [],
            });
        }
        if (req.method === 'POST' && p === '/v1/jobs') {
            const text = raw.toString('latin1');
            const spec = JSON.parse(/name="spec"\r\n\r\n([\s\S]*?)\r\n--/.exec(text)![1]);
            const files = [...text.matchAll(/name="files"; filename="([^"]+)"/g)].map((m) => m[1]);
            this.uploads.push({ spec, files, rawLength: raw.length });
            const jobId = `remote-${this.uploads.length}`;
            this.jobs.set(jobId, { status: 'queued', progress: 0 });
            return this.send(res, 201, { jobId, status: 'queued', position: 0, files: Object.fromEntries(files.map((f, i) => [f, `img${i + 1}.jpg`])) });
        }
        const m = /^\/v1\/jobs\/([^/]+)(\/video|\/thumb)?$/.exec(p);
        const job = m ? this.jobs.get(m[1]) : undefined;
        if (!m || !job) return this.send(res, 404, { error: { code: 'NOT_FOUND', message: 'Không tìm thấy việc.' } });
        if (req.method === 'GET' && !m[2]) return this.send(res, 200, { jobId: m[1], createdAt: 1, ...job });
        if (req.method === 'GET' && job.status === 'done') {
            this.downloads.push(`${m[1]}${m[2]}`);
            return this.send(res, 200, m[2] === '/video' ? MP4 : JPG, m[2] === '/video' ? 'video/mp4' : 'image/jpeg');
        }
        if (req.method === 'DELETE') {
            if (job.status === 'queued') { job.status = 'cancelled'; return this.send(res, 200, { jobId: m[1], status: 'cancelled' }); }
            if (job.status === 'rendering') return this.send(res, 202, { jobId: m[1], status: 'rendering' });
            this.jobs.delete(m[1]);
            return this.send(res, 200, { jobId: m[1], status: job.status, deleted: true });
        }
        return this.send(res, 404, { error: { code: 'NOT_FOUND', message: 'Video chưa sẵn sàng.' } });
    }
}

export { MP4, JPG };
