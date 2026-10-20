import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import Logger from '../../utils/Logger';
import type { VideoJob, VideoSource, VideoStatus } from '../../models/video';
import { RenderError, type RenderCatalog, type RenderClient, type RenderJobView, type RenderTemplate } from './RenderClient';
import type { VideoStore } from './VideoStore';

export const POLL_INTERVAL_MS = 3000;
export const LOST_CONTACT_MS = 30 * 60_000;
const CATALOG_TTL_MS = 10 * 60_000;
const MAX_NAME_LENGTH = 100;
const CANCELLED_MESSAGE = 'Đã huỷ';
const LOST_CONTACT_MESSAGE = 'Mất liên lạc với máy chủ render';
const TERMINAL: VideoStatus[] = ['done', 'failed', 'cancelled'];
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export interface VideoRenderInput {
    name: string;
    source: VideoSource;
    /** `images`/`musicFile` là tên trong `files`. Một trong `template` hoặc `html`. */
    template?: { id: string; aspect: string; variables: Record<string, unknown>; images: string[]; musicId?: string | null; musicFile?: string };
    html?: { html: string; width: number; height: number };
    fps?: number;
    quality?: 'standard' | 'high';
    files: { path: string; name: string }[];
}

export interface VideoServiceDeps {
    store: VideoStore;
    client(): RenderClient;
    mediaInbox: { adopt(filePath: string): Promise<{ mediaId: string }> };
    emit(type: string, payload?: unknown): void;
    now(): number;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(handle: unknown): void;
    videosDir: string;
}

/** Kiểm tra đầu vào với template.json của máy chủ để báo lỗi dễ hiểu trước khi tải lên (máy chủ vẫn kiểm lại). */
export function validateTemplateInput(tpl: RenderTemplate, input: NonNullable<VideoRenderInput['template']>): void {
    const bad = (m: string): never => { throw new RenderError('invalid', m); };
    if (!tpl.aspects.includes(input.aspect)) bad(`Mẫu "${tpl.name}" không hỗ trợ khổ ${input.aspect}`);
    const count = input.images.length;
    if (count < tpl.imageSlots.min || count > tpl.imageSlots.max) {
        bad(`Mẫu "${tpl.name}" cần ${tpl.imageSlots.min}–${tpl.imageSlots.max} ảnh (đang có ${count})`);
    }
    for (const [key, value] of Object.entries(input.variables)) {
        const def = tpl.variables[key];
        if (!def) bad(`Mẫu "${tpl.name}" không có biến "${key}"`);
        if (def.type === 'number') {
            if (typeof value !== 'number' || !Number.isFinite(value)) bad(`"${def.label}" phải là số`);
        } else if (typeof value !== 'string') {
            bad(`"${def.label}" phải là chữ`);
        } else if (def.type === 'color' && !COLOR_PATTERN.test(value)) {
            bad(`"${def.label}" phải là mã màu dạng #rrggbb`);
        } else if (def.maxLength !== undefined && value.length > def.maxLength) {
            bad(`"${def.label}" dài quá ${def.maxLength} ký tự`);
        }
    }
}

export class VideoService {
    private catalog: { at: number; data: RenderCatalog } | null = null;
    private timer: unknown = null;
    private running = false;
    private ticking = false;
    private readonly lastContact = new Map<string, number>();

    constructor(private readonly deps: VideoServiceDeps) {}

    async templates(): Promise<RenderCatalog> {
        const now = this.deps.now();
        if (this.catalog && now - this.catalog.at < CATALOG_TTL_MS) return this.catalog.data;
        const data = await this.deps.client().templates();
        this.catalog = { at: now, data };
        return data;
    }

    async render(input: VideoRenderInput): Promise<VideoJob> {
        const name = input.name.trim();
        if (!name || name.length > MAX_NAME_LENGTH) throw new RenderError('invalid', `Tên video phải có 1–${MAX_NAME_LENGTH} ký tự`);
        if (!!input.template === !!input.html) throw new RenderError('invalid', 'Cần đúng một trong hai: mẫu hoặc HTML');
        let spec: Record<string, unknown>;
        let aspect: string;
        if (input.template) {
            const tpl = (await this.templates()).templates.find((t) => t.id === input.template!.id);
            if (!tpl) throw new RenderError('invalid', `Không có mẫu "${input.template.id}"`);
            validateTemplateInput(tpl, input.template);
            aspect = input.template.aspect;
            spec = { template: input.template };
        } else {
            aspect = `${input.html!.width}x${input.html!.height}`;
            spec = { ...input.html };
        }
        if (input.fps !== undefined) spec.fps = input.fps;
        if (input.quality !== undefined) spec.quality = input.quality;

        const created = await this.deps.client().createJob(spec, input.files);
        const job: VideoJob = {
            id: randomUUID(), remoteId: created.jobId, name, source: input.source,
            templateId: input.template?.id ?? null, aspect, specJson: JSON.stringify(spec),
            status: 'queued', progress: 0, error: '', filePath: null, thumbPath: null, sizeBytes: null, durationSec: null,
            createdAt: this.deps.now(), finishedAt: null,
        };
        this.deps.store.create(job);
        this.deps.emit('video:changed');
        this.startPolling();
        return job;
    }

    list(opts: { status?: VideoStatus; limit?: number; offset?: number } = {}) { return this.deps.store.list(opts); }
    get(id: string): VideoJob | null { return this.deps.store.get(id); }

    /** Việc còn dở khi mở lại app được theo dõi tiếp; chỉ chạy bộ đếm khi có việc. */
    startPolling(): void {
        this.running = true;
        this.schedule();
    }

    stop(): void {
        this.running = false;
        if (this.timer !== null) this.deps.clearTimer(this.timer);
        this.timer = null;
    }

    async cancel(id: string): Promise<{ cancelled: boolean }> {
        const job = this.requireJob(id);
        if (!job.remoteId || !['queued', 'rendering'].includes(job.status)) return { cancelled: false };
        try {
            const res = await this.deps.client().cancel(job.remoteId);
            if (res.status === 'cancelled' || res.deleted) this.finish(job, { status: 'cancelled', error: CANCELLED_MESSAGE }, true);
        } catch (e) {
            // Máy chủ không còn việc này: coi như đã huỷ; lỗi khác để người dùng thử lại.
            if (!(e instanceof RenderError) || e.code !== 'not_found') throw e;
            this.finish(job, { status: 'cancelled', error: CANCELLED_MESSAGE }, true);
        }
        return { cancelled: true };
    }

    async delete(id: string): Promise<void> {
        const job = this.requireJob(id);
        if (job.remoteId) await this.deps.client().cancel(job.remoteId).catch(() => undefined); // máy chủ tự dọn việc đã xong
        for (const file of [job.filePath, job.thumbPath]) if (file) this.removeInsideVideosDir(file);
        this.lastContact.delete(id);
        this.deps.store.delete(id);
        this.deps.emit('video:changed');
    }

    /** Chỉ xoá tệp nằm trong thư mục video (đường dẫn trong DB không được tin hoàn toàn). */
    private removeInsideVideosDir(file: string): void {
        const root = path.resolve(this.deps.videosDir);
        const target = path.resolve(file);
        let inside = target.startsWith(root + path.sep);
        if (inside) { // chống lối tắt symlink: thư mục chứa tệp phải thật sự nằm trong thư mục video
            try { inside = (fs.realpathSync(path.dirname(target)) + path.sep).startsWith(fs.realpathSync(root) + path.sep); } catch { inside = false; }
        }
        if (!inside) {
            Logger.warn(`[VideoService] Bỏ qua tệp ngoài thư mục video: ${path.basename(file)}`);
            return;
        }
        fs.rmSync(target, { force: true });
    }

    /** Dòng hiện tại nếu còn đang chạy; null khi đã bị xoá hoặc đã kết thúc (kết quả await cũ không còn giá trị). */
    private liveRow(id: string): VideoJob | null {
        const row = this.deps.store.get(id);
        return row && !TERMINAL.includes(row.status) ? row : null;
    }

    private requireJob(id: string): VideoJob {
        const job = this.deps.store.get(id);
        if (!job) throw new RenderError('not_found', 'Không tìm thấy video');
        return job;
    }

    private schedule(): void {
        if (!this.running || this.timer !== null || this.deps.store.listActive().length === 0) return;
        this.timer = this.deps.setTimer(() => { this.timer = null; void this.tick(); }, POLL_INTERVAL_MS);
    }

    /** Một vòng hỏi trạng thái; công khai để test và để giao diện ép làm mới. */
    async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            for (const job of this.deps.store.listActive()) {
                await this.poll(job);
            }
        } finally {
            this.ticking = false;
            this.schedule();
        }
    }

    private async poll(job: VideoJob): Promise<void> {
        const now = this.deps.now();
        if (!job.remoteId) { // việc dở từ lúc app đóng giữa chừng, không có gì để theo dõi
            this.finish(job, { status: 'failed', error: 'App đóng khi đang tải video lên máy chủ render' }, true);
            return;
        }
        if (!this.lastContact.has(job.id)) this.lastContact.set(job.id, now);
        try {
            const view = await this.deps.client().job(job.remoteId);
            const live = this.liveRow(job.id);
            if (!live) return;
            this.lastContact.set(job.id, this.deps.now());
            await this.apply(live, view);
        } catch (e) {
            if (e instanceof RenderError && e.code === 'not_found') {
                this.finish(job, { status: 'failed', error: 'Máy chủ render không còn việc này' }, true);
                return;
            }
            Logger.warn(`[VideoService] ${job.id}: ${e instanceof Error ? e.message : 'lỗi không rõ'}`);
            if (this.deps.now() - (this.lastContact.get(job.id) ?? now) > LOST_CONTACT_MS) {
                this.finish(job, { status: 'failed', error: LOST_CONTACT_MESSAGE }, true);
            }
        }
    }

    private async apply(job: VideoJob, view: RenderJobView): Promise<void> {
        if (view.status === 'failed' || view.status === 'cancelled') {
            this.finish(job, { status: view.status, error: view.error || (view.status === 'cancelled' ? CANCELLED_MESSAGE : 'Render lỗi') }, true);
            return;
        }
        if (view.status !== 'done') {
            if (view.status !== job.status || view.progress !== job.progress) {
                this.deps.store.update(job.id, { status: view.status, progress: view.progress });
                this.deps.emit('video:changed');
            }
            return;
        }
        // Xong: tải đúng một lần. Lỗi tải ném ra để vòng sau thử lại; tệp đã về (filePath) thì không tải lại.
        fs.mkdirSync(this.deps.videosDir, { recursive: true });
        let filePath = job.filePath;
        if (!filePath) {
            filePath = path.join(this.deps.videosDir, `${job.id}.mp4`);
            await this.deps.client().download(job.remoteId!, 'video', filePath);
            if (!this.liveRow(job.id)) { fs.rmSync(filePath, { force: true }); return; } // bị xoá/huỷ trong lúc tải
            this.deps.store.update(job.id, { filePath });
        }
        let thumbPath = job.thumbPath;
        if (!thumbPath) {
            const dest = path.join(this.deps.videosDir, `${job.id}.jpg`);
            try { await this.deps.client().download(job.remoteId!, 'thumb', dest); thumbPath = dest; } catch { /* không có bìa vẫn dùng được video */ }
            if (!this.liveRow(job.id)) {
                fs.rmSync(dest, { force: true });
                if (!this.deps.store.get(job.id)) fs.rmSync(filePath, { force: true });
                return;
            }
        }
        const sizeBytes = view.sizeBytes ?? fs.statSync(filePath).size;
        this.finish(job, { status: 'done', error: '', progress: 1, filePath, thumbPath, sizeBytes, durationSec: view.durationSec ?? null }, true);
    }

    private finish(job: VideoJob, patch: Partial<VideoJob>, announce: boolean): void {
        if (!this.liveRow(job.id)) return; // đã xoá hoặc đã kết thúc: không ghi, không phát sự kiện lần nữa
        this.deps.store.update(job.id, { ...patch, finishedAt: this.deps.now() });
        this.lastContact.delete(job.id);
        this.deps.emit('video:changed');
        if (!announce) return;
        const ok = patch.status === 'done';
        const event: Record<string, unknown> = { videoId: job.id, name: job.name, ok };
        if (!ok) event.error = patch.error;
        if (ok && patch.durationSec != null) event.durationSec = patch.durationSec;
        if (ok && patch.sizeBytes != null) event.sizeBytes = patch.sizeBytes;
        if (ok && job.source === 'bot' && patch.filePath) {
            void this.deps.mediaInbox.adopt(patch.filePath)
                .then((saved) => { event.mediaId = saved.mediaId; })
                .catch((e) => { event.error = `Không chép được video vào hộp thư: ${e instanceof Error ? e.message : 'lỗi không rõ'}`; })
                .then(() => this.deps.emit('videos.finished', event));
        } else {
            this.deps.emit('videos.finished', event);
        }
    }
}
