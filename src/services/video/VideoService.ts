import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import Logger from '../../utils/Logger';
import type { AdResult, VideoJob, VideoSource, VideoStatus } from '../../models/video';
import { adStepText, type AdJobResult, type AdJobView, type AhvAdClient } from './AhvAdClient';
import { RenderError, type RenderCatalog, type RenderClient, type RenderJobView, type RenderTemplate } from './RenderClient';
import type { VideoStore } from './VideoStore';

export const POLL_INTERVAL_MS = 3000;
export const LOST_CONTACT_MS = 30 * 60_000;
/**
 * Tran theo doi job `ad_video`, tinh tu lan dau thay `running` (hop dong AHV: job chay toi da 150 phut
 * sau khi gianh luot, luc xep hang khong tinh). Moc giu trong bo nho nhu `lastContact`.
 */
export const AD_MAX_RUN_MS = 160 * 60_000;
/** Số lần tải tệp kết quả được thử trước khi coi là lỗi, để link chết không thành vòng tải vô hạn. */
export const AD_MAX_DOWNLOAD_TRIES = 3;
/** Trạng thái job mà hợp đồng `ad_video` công bố; tên ngoài danh sách này là lỗi, không phải "đang chờ". */
const AD_STATUSES = ['queued', 'running', 'succeeded', 'failed'];
const CATALOG_TTL_MS = 10 * 60_000;
const MAX_NAME_LENGTH = 100;
const CANCELLED_MESSAGE = 'Đã huỷ';
const LOST_CONTACT_MESSAGE = 'Mất liên lạc với máy chủ render';
const AD_LOST_CONTACT_MESSAGE = 'Mất liên lạc với AHV AI';
const AD_TIMEOUT_MESSAGE = 'Quá thời gian theo dõi video quảng cáo AI';
const AD_FAILED_MESSAGE = 'AHV AI báo video quảng cáo lỗi';
const AD_DOWNLOAD_MESSAGE = 'Không tải được video quảng cáo từ AHV AI';
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

/** Cho nhan tep trong payload `ad_video`: `{ __adUpload: n }` duoc thay bang link sau khi tai len AHV. */
export const AD_UPLOAD_MARK = '__adUpload';
export interface AdUpload { path: string; name: string }
/** Payload AHV con nguyen cho cam tep; `adVideoPayload.buildAdPayload` dung, `adCreate` tai tep roi thay link. */
export interface AdPayloadDraft { payload: Record<string, unknown>; uploads: AdUpload[] }

export interface AdRenderInput {
    name: string;
    source: VideoSource;
    draft: AdPayloadDraft;
    webhookUrl?: string;
}

export interface VideoServiceDeps {
    store: VideoStore;
    client(): RenderClient;
    adClient(): AhvAdClient;
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
        } else if (def.type === 'string' && def.required !== false && !value.trim()) {
            bad(`Nhập ${def.label.toLowerCase()}`);
        } else if (def.type === 'color' && !COLOR_PATTERN.test(value)) {
            bad(`"${def.label}" phải là mã màu dạng #rrggbb`);
        } else if (def.maxLength !== undefined && value.length > def.maxLength) {
            bad(`"${def.label}" dài quá ${def.maxLength} ký tự`);
        }
    }
}

/** Thay moi `{ __adUpload: n }` trong payload bang link da tai len; giu nguyen phan con lai. */
export function fillAdUploads(value: unknown, urls: string[]): unknown {
    if (Array.isArray(value)) return value.map((v) => fillAdUploads(v, urls));
    if (value && typeof value === 'object') {
        const mark = (value as Record<string, unknown>)[AD_UPLOAD_MARK];
        if (typeof mark === 'number') {
            const url = urls[mark];
            if (!url) throw new RenderError('invalid', 'Thiếu tệp đã tải lên cho video quảng cáo');
            return url;
        }
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillAdUploads(v, urls)]));
    }
    return value;
}

/** Phan ket qua them cua `ad_video` de luu vao `result_json` (ma canh bao giu nguyen ke ca ma la). */
export function toAdResult(result: AdJobResult): AdResult {
    // AHV phát stt_mismatch theo từng câu nên cùng một mã về nhiều lần: gộp lại, giữ thứ tự gặp đầu tiên.
    const warnings = Array.isArray(result.warnings)
        ? [...new Set(result.warnings.map((w) => (typeof w === 'string' ? w : String(w?.code ?? ''))).filter((c) => !!c))]
        : [];
    return {
        warnings,
        ...(result.cost_usd ? { costUsd: result.cost_usd } : {}),
        ...(Array.isArray(result.scenes) ? { scenes: result.scenes } : {}),
        ...(result.stt_text ? { sttText: result.stt_text } : {}),
        ...(result.expires_at ? { expiresAt: result.expires_at } : {}),
        ...(result.grid_url ? { gridUrl: result.grid_url } : {}),
    };
}

export class VideoService {
    private catalog: { at: number; data: RenderCatalog } | null = null;
    private timer: unknown = null;
    private running = false;
    private ticking = false;
    private readonly musicDownloads = new Map<string, Promise<void>>();
    private readonly lastContact = new Map<string, number>();
    /** Lan dau thay job `ad_video` khong con xep hang; chi de tinh tran AD_MAX_RUN_MS. */
    private readonly adRunStart = new Map<string, number>();
    /** So lan tai tep ket qua da that bai, theo tung job. */
    private readonly adDownloadTries = new Map<string, number>();

    constructor(private readonly deps: VideoServiceDeps) {}

    async templates(): Promise<RenderCatalog> {
        const now = this.deps.now();
        if (this.catalog && now - this.catalog.at < CATALOG_TTL_MS) return this.catalog.data;
        const data = await this.deps.client().templates();
        this.catalog = { at: now, data };
        return data;
    }

    /** Nhạc có sẵn để nghe thử: tải một lần về videosDir/music-cache/<id>.mp3, các lần sau dùng lại. Mã phải có trong danh sách của máy chủ. */
    async musicPreview(id: string): Promise<string> {
        if (!/^[a-z0-9-]+$/i.test(id)) throw new RenderError('not_found', 'Không tìm thấy bản nhạc'); // M6: id đi vào đường dẫn tệp
        if (!(await this.templates()).music.some((m) => m.id === id)) throw new RenderError('not_found', 'Không tìm thấy bản nhạc');
        const dest = path.join(this.deps.videosDir, 'music-cache', `${id}.mp3`);
        if (fs.existsSync(dest)) return dest;
        let pending = this.musicDownloads.get(id);
        if (!pending) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            pending = this.deps.client().downloadMusic(id, dest).finally(() => this.musicDownloads.delete(id));
            this.musicDownloads.set(id, pending);
        }
        await pending;
        return dest;
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
            id: randomUUID(), remoteId: created.jobId, name, source: input.source, engine: 'hyperframes',
            templateId: input.template?.id ?? null, aspect, specJson: JSON.stringify(spec),
            status: 'queued', progress: 0, error: '', stepText: '', resultJson: '',
            filePath: null, thumbPath: null, sizeBytes: null, durationSec: null,
            createdAt: this.deps.now(), finishedAt: null,
        };
        this.deps.store.create(job);
        this.deps.emit('video:changed');
        this.startPolling();
        return job;
    }

    /**
     * Video quang cao AI: tai tep cuc bo len AHV (`/upload`), gui job `ad_video`, luu dong roi theo doi.
     * Loi truoc khi AHV nhan job thi khong de lai dong nao (va chua ton GPU).
     */
    async adCreate(input: AdRenderInput): Promise<VideoJob> {
        const name = input.name.trim();
        if (!name || name.length > MAX_NAME_LENGTH) throw new RenderError('invalid', `Tên video phải có 1–${MAX_NAME_LENGTH} ký tự`);
        const client = this.deps.adClient();
        const urls: string[] = [];
        for (const file of input.draft.uploads) urls.push(await client.upload(file.path, file.name));
        const payload = fillAdUploads(input.draft.payload, urls) as Record<string, unknown>;
        const created = await client.createJob(payload, input.webhookUrl);
        const job: VideoJob = {
            id: randomUUID(), remoteId: created.jobId, name, source: input.source, engine: 'ahv_ad',
            templateId: null, aspect: '9:16', specJson: JSON.stringify(payload),
            status: 'queued', progress: 0, error: '', stepText: '', resultJson: '',
            filePath: null, thumbPath: null, sizeBytes: null, durationSec: null,
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
        // API ad_video khong co duong huy: chi dung theo doi o MaiHub, job phia AHV van chay (xem spec §8).
        if (job.engine === 'ahv_ad') {
            this.finish(job, { status: 'cancelled', error: CANCELLED_MESSAGE }, true);
            return { cancelled: true };
        }
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
        // engine ahv_ad: AHV tu don ket qua sau 7 ngay, khong co duong huy nen khong goi gi
        if (job.remoteId && job.engine !== 'ahv_ad') await this.deps.client().cancel(job.remoteId).catch(() => undefined); // máy chủ tự dọn việc đã xong
        for (const file of [job.filePath, job.thumbPath]) if (file) this.removeInsideVideosDir(file);
        this.lastContact.delete(id);
        this.adRunStart.delete(id);
        this.adDownloadTries.delete(id);
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
        if (job.engine === 'ahv_ad') return this.pollAd(job, now);
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
            Logger.warn(`[VideoService] ${job.id}: ${e instanceof Error && e.name === 'ControlError' ? e.message : 'lỗi không rõ'}`);
            if (this.deps.now() - (this.lastContact.get(job.id) ?? now) > LOST_CONTACT_MS) {
                this.finish(job, { status: 'failed', error: LOST_CONTACT_MESSAGE }, true);
            }
        }
    }

    /** Mot vong hoi AHV cho job `ad_video`. Loi mang va 5xx khong lam job loi (hop dong muc 11). */
    private async pollAd(job: VideoJob, now: number): Promise<void> {
        try {
            const view = await this.deps.adClient().job(job.remoteId!);
            const live = this.liveRow(job.id);
            if (!live) return;
            this.lastContact.set(job.id, this.deps.now());
            await this.applyAd(live, view);
        } catch (e) {
            if (e instanceof RenderError && e.code === 'not_found') {
                this.finish(job, { status: 'failed', error: 'AHV AI không còn việc này' }, true);
                return;
            }
            Logger.warn(`[VideoService] ad ${job.id}: ${e instanceof RenderError ? e.code : 'lỗi không rõ'}`);
            if (this.deps.now() - (this.lastContact.get(job.id) ?? now) > LOST_CONTACT_MS) {
                this.finish(job, { status: 'failed', error: AD_LOST_CONTACT_MESSAGE }, true);
            }
        }
    }

    private async applyAd(job: VideoJob, view: AdJobView): Promise<void> {
        if (view.status === 'failed') {
            this.finish(job, { status: 'failed', error: view.error?.message || AD_FAILED_MESSAGE }, true);
            return;
        }
        // Tên trạng thái ngoài hợp đồng (đổi tên, thêm trạng thái kết thúc mới, thân JSON lạ) từng làm job
        // nằm mãi ở "đang chờ" vì nhánh chờ không có trần nào: coi là lỗi và nói rõ nhận được gì.
        if (!AD_STATUSES.includes(view.status)) {
            this.finish(job, { status: 'failed', error: `AHV AI trả trạng thái không hiểu được: ${view.status || '(trống)'}` }, true);
            return;
        }

        const now = this.deps.now();
        // Trần thời gian áp cho mọi lúc job đã giành lượt chạy, kể cả lúc đang tải kết quả về.
        if (view.status !== 'queued') {
            if (!this.adRunStart.has(job.id)) this.adRunStart.set(job.id, now);
            if (now - this.adRunStart.get(job.id)! > AD_MAX_RUN_MS) {
                this.finish(job, { status: 'failed', error: AD_TIMEOUT_MESSAGE }, true);
                return;
            }
        }
        if (view.status === 'succeeded') return this.finishAd(job, view);

        const status: VideoStatus = view.status === 'running' ? 'rendering' : 'queued';
        const progress = Math.min(Math.max(view.progress / 100, 0), 1);
        const stepText = adStepText(view.step, view.progress);
        if (status !== job.status || progress !== job.progress || stepText !== job.stepText) {
            this.deps.store.update(job.id, { status, progress, stepText });
            this.deps.emit('video:changed');
        }
    }

    /**
     * Xong: tai mp4 (va bia neu co) dung mot lan, roi ghi ket qua. Loi tai duoc thu lai o vong sau,
     * nhung chi toi AD_MAX_DOWNLOAD_TRIES lan: link ket qua chet khong duoc thanh vong tai vo han.
     */
    private async finishAd(job: VideoJob, view: AdJobView): Promise<void> {
        const result = view.result ?? {};
        if (!result.url) {
            this.finish(job, { status: 'failed', error: 'AHV AI báo xong nhưng không có link video' }, true);
            return;
        }
        const client = this.deps.adClient();
        fs.mkdirSync(this.deps.videosDir, { recursive: true });
        let filePath = job.filePath;
        if (!filePath) {
            filePath = path.join(this.deps.videosDir, `${job.id}.mp4`);
            try {
                await client.download(result.url, filePath);
            } catch (e) {
                const tries = (this.adDownloadTries.get(job.id) ?? 0) + 1;
                this.adDownloadTries.set(job.id, tries);
                if (tries >= AD_MAX_DOWNLOAD_TRIES) {
                    this.finish(job, { status: 'failed', error: AD_DOWNLOAD_MESSAGE }, true);
                    return;
                }
                throw e; // vong sau thu lai
            }
            if (!this.liveRow(job.id)) { fs.rmSync(filePath, { force: true }); return; } // bi xoa/huy trong luc tai
            this.deps.store.update(job.id, { filePath });
        }
        let thumbPath = job.thumbPath;
        if (!thumbPath && result.thumb_url) {
            const dest = path.join(this.deps.videosDir, `${job.id}.jpg`);
            try { await client.download(result.thumb_url, dest); thumbPath = dest; } catch { /* khong co bia van dung duoc video */ }
            if (!this.liveRow(job.id)) {
                fs.rmSync(dest, { force: true });
                if (!this.deps.store.get(job.id)) fs.rmSync(filePath, { force: true });
                return;
            }
        }
        const ad = toAdResult(result);
        this.finish(job, {
            status: 'done', error: '', progress: 1, stepText: '', resultJson: JSON.stringify(ad),
            filePath, thumbPath, sizeBytes: fs.statSync(filePath).size,
            durationSec: Number.isFinite(result.duration) ? Number(result.duration) : null,
        }, true, ad.warnings);
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

    private finish(job: VideoJob, patch: Partial<VideoJob>, announce: boolean, warnings: string[] = []): void {
        if (!this.liveRow(job.id)) return; // đã xoá hoặc đã kết thúc: không ghi, không phát sự kiện lần nữa
        this.deps.store.update(job.id, { ...patch, finishedAt: this.deps.now() });
        this.lastContact.delete(job.id);
        this.adRunStart.delete(job.id);
        this.adDownloadTries.delete(job.id);
        this.deps.emit('video:changed');
        if (!announce) return;
        const ok = patch.status === 'done';
        const event: Record<string, unknown> = { videoId: job.id, name: job.name, ok };
        if (!ok) event.error = patch.error;
        if (patch.status === 'cancelled') event.cancelled = true; // người dùng huỷ: bridge không báo như lỗi
        if (ok && patch.durationSec != null) event.durationSec = patch.durationSec;
        if (ok && patch.sizeBytes != null) event.sizeBytes = patch.sizeBytes;
        if (ok && warnings.length > 0) event.warnings = warnings; // bot gan nhan can xem lai
        if (ok && job.source === 'bot' && patch.filePath) {
            void this.deps.mediaInbox.adopt(patch.filePath)
                .then((saved) => { event.mediaId = saved.mediaId; })
                .catch((e) => { event.error = `Không chép được video vào hộp thư: ${e instanceof Error && e.name === 'ControlError' ? e.message : 'lỗi không rõ'}`; })
                .then(() => this.deps.emit('videos.finished', event));
        } else {
            this.deps.emit('videos.finished', event);
        }
    }
}
