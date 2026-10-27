import * as fs from 'fs';
import type { Readable } from 'stream';
import * as path from 'path';
import { buildVideoFinished } from '../control/controlEvents';
import { AUDIO_EXTENSIONS } from '../facebookPoster/mediaRules';
import type { AdResult, VideoJob, VideoStatus } from '../../models/video';
import { buildAdPayload, type AdAssetResolver } from './adVideoPayload';
import type { AhvAdClient } from './AhvAdClient';
import type { AhvSettings } from './ahvSettings';
import { RenderError, type RenderClient } from './RenderClient';
import { maskKey, type VideoSettings } from './videoSettings';
import type { VideoRenderInput, VideoService } from './VideoService';

const MAX_NAME_LENGTH = 100;
const MAX_FILES = 20;
const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;
const STATUSES: VideoStatus[] = ['uploading', 'queued', 'rendering', 'done', 'failed', 'cancelled'];

export type VideoOrigin = 'app' | 'bot';

/** Phần phụ thuộc ngoài (Electron, DB, hộp thư) được tiêm vào để kiểm tra tham số chạy được trong Jest. */
export interface VideoOperationsDeps {
    service(): Pick<VideoService, 'templates' | 'musicPreview' | 'render' | 'adCreate' | 'get' | 'list' | 'cancel' | 'delete'>;
    loadSettings(): VideoSettings;
    saveSettings(input: { url: string; apiKey?: string }): VideoSettings;
    client(): Pick<RenderClient, 'health' | 'templates'>;
    /** Cấu hình API AHV AI cho engine `ad_video` (26.31). */
    loadAhvSettings(): AhvSettings;
    saveAhvSettings(input: { baseUrl: string; apiKey?: string }): AhvSettings;
    adClient(): Pick<AhvAdClient, 'health' | 'voices'>;
    /** mediaId của hộp thư Control API -> đường dẫn tệp (ném lỗi nếu lạ hoặc hết hạn). */
    resolveMedia(mediaIds: string[]): string[];
    /** Hộp thoại lưu tệp; null = người dùng đóng hộp thoại. */
    pickSavePath(defaultName: string): Promise<string | null>;
}

const bad = (message: string): never => { throw new RenderError('invalid', message); };

/**
 * Bot không được thấy đường dẫn trên máy chủ MaiHub (spec video §6.5). `resultJson` thô được
 * thay bằng `adResult` đã phân tích (JSON hỏng -> null) để bot không phải tự parse.
 */
function publicView(job: VideoJob) {
    const { filePath, thumbPath, specJson, resultJson, ...rest } = job;
    return { ...rest, adResult: parseAdResult(resultJson) };
}

function parseAdResult(resultJson: string): AdResult | null {
    if (!resultJson) return null;
    try {
        const parsed = JSON.parse(resultJson);
        return parsed && typeof parsed === 'object' ? (parsed as AdResult) : null;
    } catch { return null; }
}

function readVideoId(params: any): string {
    const id = params?.videoId;
    if (typeof id !== 'string' || !id) bad('Thiếu tham số videoId');
    return id;
}

function readStringList(value: unknown, field: string, min: number): string[] {
    if (value === undefined && min === 0) return [];
    if (!Array.isArray(value) || value.length < min || value.length > MAX_FILES || value.some((v) => typeof v !== 'string' || !v)) {
        bad(`${field} phải là danh sách ${min}–${MAX_FILES} chuỗi không rỗng`);
    }
    return value as string[];
}

export function createVideoOperations(deps: VideoOperationsDeps) {
    const view = () => {
        const s = deps.loadSettings();
        return { url: s.url, apiKeyHint: maskKey(s.apiKey), configured: !!s.url && !!s.apiKey };
    };

    /** App gửi đường dẫn tệp; bot gửi mã tệp hộp thư. Kết quả luôn là đường dẫn tuyệt đối của tệp đọc được. */
    function resolveFiles(origin: VideoOrigin, params: any, pathsField: string, idsField: string, min: number): string[] {
        let paths: string[];
        if (origin === 'app') {
            paths = readStringList(params[pathsField], pathsField, min);
            if (paths.some((p) => !path.isAbsolute(p))) bad(`${pathsField} phải là đường dẫn tuyệt đối`);
        } else {
            const ids = readStringList(params[idsField], idsField, min);
            paths = ids.length ? deps.resolveMedia(ids) : [];
        }
        for (const p of paths) {
            let ok = false;
            try { ok = fs.statSync(p).isFile(); } catch { /* không đọc được */ }
            if (!ok) bad(origin === 'app' ? `Không đọc được tệp ${path.basename(p)}` : 'Có mediaId không tồn tại hoặc đã hết hạn');
        }
        return paths;
    }

    const ahvView = () => {
        const s = deps.loadAhvSettings();
        return { baseUrl: s.baseUrl, apiKeyHint: maskKey(s.apiKey), configured: !!s.baseUrl && !!s.apiKey };
    };

    /** App chỉ được gửi đường dẫn tuyệt đối; bot chỉ được gửi mã tệp hộp thư. Tệp phải đọc được. */
    const assetResolver = (origin: VideoOrigin): AdAssetResolver => ({ kind, value, field }) => {
        if (origin === 'app' && kind !== 'path') bad(`${field}: ứng dụng phải gửi tệp trên máy hoặc link`);
        if (origin === 'bot' && kind !== 'mediaId') bad(`${field}: bot phải gửi mã tệp đã tải lên hoặc link`);
        let file: string;
        if (kind === 'path') {
            if (!path.isAbsolute(value)) bad(`${field} phải là đường dẫn tuyệt đối`);
            file = value;
        } else {
            [file] = deps.resolveMedia([value]);
        }
        let ok = false;
        try { ok = fs.statSync(file).isFile(); } catch { /* không đọc được */ }
        if (!ok) bad(origin === 'app' ? `Không đọc được tệp ${path.basename(file)}` : 'Có mediaId không tồn tại hoặc đã hết hạn');
        return { path: file, name: `${path.basename(file).replace(/[^\w.-]+/g, '_')}` };
    };

    const extOf = (p: string) => path.extname(p).toLowerCase();

    return {
        settingsGet: () => view(),

        settingsSet: (params: any) => {
            if (typeof params?.url !== 'string') bad('Địa chỉ máy chủ render không hợp lệ');
            if (params.apiKey !== undefined && typeof params.apiKey !== 'string') bad('Khoá API không hợp lệ');
            deps.saveSettings({ url: params.url, apiKey: params.apiKey });
            return view();
        },

        /** Gọi /v1/health rồi /v1/templates (spec §6.1). */
        testConnection: async () => {
            const client = deps.client();
            const health = await client.health();
            const catalog = await client.templates();
            return { version: health.version, templateCount: catalog.templates.length };
        },

        templates: () => deps.service().templates(),

        render: async (params: any, origin: VideoOrigin): Promise<{ videoId: string; status: VideoStatus }> => {
            const p = params ?? {};
            const name = typeof p.name === 'string' ? p.name.trim() : '';
            if (!name || name.length > MAX_NAME_LENGTH) bad(`Tên video phải có 1–${MAX_NAME_LENGTH} ký tự`);
            const templateMode = p.templateId !== undefined;
            if (templateMode === (p.html !== undefined)) bad('Cần đúng một trong hai: mẫu (templateId) hoặc HTML (html)');
            if (p.fps !== undefined && p.fps !== 24 && p.fps !== 30) bad('fps phải là 24 hoặc 30');
            if (p.quality !== undefined && p.quality !== 'standard' && p.quality !== 'high') bad('quality phải là standard hoặc high');

            const input: VideoRenderInput = { name, source: origin, files: [], fps: p.fps, quality: p.quality };
            if (templateMode) {
                if (typeof p.templateId !== 'string' || !p.templateId) bad('templateId không hợp lệ');
                if (typeof p.aspect !== 'string' || !p.aspect) bad('Thiếu tham số aspect');
                const variables = p.variables ?? {};
                if (typeof variables !== 'object' || Array.isArray(variables) || variables === null) bad('variables phải là đối tượng');
                if (p.musicId !== undefined && p.musicId !== null && typeof p.musicId !== 'string') bad('musicId không hợp lệ');
                const hasMusicFile = origin === 'app' ? p.musicPath !== undefined : p.musicMediaId !== undefined;
                if (typeof p.musicId === 'string' && hasMusicFile) bad('Chỉ chọn một trong nhạc có sẵn hoặc tệp nhạc tải lên');

                const imagePaths = resolveFiles(origin, p, 'imagePaths', 'imageIds', 1);
                const images = imagePaths.map((file, i) => ({ path: file, name: `image${i + 1}${extOf(file)}` }));
                let musicFile: { path: string; name: string } | undefined;
                if (hasMusicFile) {
                    const one = origin === 'app' ? { musicPath: [p.musicPath] } : { musicMediaId: [p.musicMediaId] };
                    const [file] = resolveFiles(origin, one, 'musicPath', 'musicMediaId', 1);
                    if (!AUDIO_EXTENSIONS.includes(extOf(file).slice(1))) bad('Tệp nhạc phải là MP3, M4A hoặc WAV');
                    musicFile = { path: file, name: `music${extOf(file)}` };
                }
                input.template = {
                    id: p.templateId, aspect: p.aspect, variables, images: images.map((f) => f.name),
                    ...(p.musicId !== undefined ? { musicId: p.musicId } : {}),
                    ...(musicFile ? { musicFile: musicFile.name } : {}),
                };
                input.files = musicFile ? [...images, musicFile] : images;
            } else {
                if (typeof p.html !== 'string' || !p.html) bad('html phải là chuỗi không rỗng');
                for (const field of ['width', 'height']) {
                    if (!Number.isInteger(p[field]) || p[field] < 1) bad(`${field} phải là số nguyên dương`);
                }
                input.html = { html: p.html, width: p.width, height: p.height };
                const assets = resolveFiles(origin, p, 'assetPaths', 'assetIds', 0);
                input.files = assets.map((file, i) => ({ path: file, name: `asset${i + 1}${extOf(file)}` }));
            }
            const job = await deps.service().render(input);
            return { videoId: job.id, status: job.status };
        },

        status: (params: any, origin: VideoOrigin): { video: VideoJob | PublicVideoJob } => {
            const job = deps.service().get(readVideoId(params));
            if (!job) throw new RenderError('not_found', 'Không tìm thấy video');
            return { video: origin === 'bot' ? publicView(job) : job };
        },

        list: (params: any, origin: VideoOrigin) => {
            const p = params ?? {};
            if (p.status !== undefined && !STATUSES.includes(p.status)) bad('status không hợp lệ');
            const limit = p.limit === undefined ? DEFAULT_LIST_LIMIT : p.limit;
            if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) bad(`limit phải là số nguyên từ 1 đến ${MAX_LIST_LIMIT}`);
            const offset = p.offset === undefined ? 0 : p.offset;
            if (!Number.isInteger(offset) || offset < 0) bad('offset phải là số nguyên ≥ 0');
            const { videos, total } = deps.service().list({ status: p.status, limit, offset });
            return { total, videos: origin === 'bot' ? videos.map(publicView) : videos };
        },

        /** Đường dẫn tệp nhạc có sẵn đã tải về máy để nghe thử; chỉ dùng trong app. */
        musicPreview: async (params: any): Promise<{ path: string }> => {
            const id = params?.musicId;
            if (typeof id !== 'string' || !id) bad('Thiếu tham số musicId');
            return { path: await deps.service().musicPreview(id) };
        },

        ahvSettingsGet: () => ahvView(),

        ahvSettingsSet: (params: any) => {
            if (typeof params?.baseUrl !== 'string') bad('Địa chỉ API AHV AI không hợp lệ');
            if (params.apiKey !== undefined && typeof params.apiKey !== 'string') bad('Khoá API không hợp lệ');
            deps.saveAhvSettings({ baseUrl: params.baseUrl, apiKey: params.apiKey });
            return ahvView();
        },

        /**
         * Kiểm tra kết nối: `/healthz` (máy chủ sống) rồi `/v1/audio/voices` (đọc được dữ liệu, và là
         * danh sách form cần). Lưu ý: 27/10/2026 AHV chưa thật sự bắt buộc `X-API-Key` ở đường nào
         * (`"/"` trong `ALLOW_PATHS` của họ cho qua mọi đường), nên phép thử này KHÔNG khẳng định khoá đúng.
         */
        ahvTestConnection: async () => {
            const client = deps.adClient();
            await client.health();
            const voices = await client.voices();
            return { voiceCount: voices.length };
        },

        /** Danh sách giọng đọc để form chọn; chỉ dùng trong app. */
        voices: async () => ({ voices: await deps.adClient().voices() }),

        /**
         * Video quảng cáo AI nhiều cảnh (engine `ahv_ad`). App gửi đường dẫn tệp, bot gửi mã tệp hộp thư;
         * cả hai đều được MaiHub tải lên AHV rồi thay bằng link trong payload.
         */
        adCreate: async (params: any, origin: VideoOrigin): Promise<{ videoId: string; status: VideoStatus }> => {
            const p = params ?? {};
            const name = typeof p.name === 'string' ? p.name.trim() : '';
            if (!name || name.length > MAX_NAME_LENGTH) bad(`Tên video phải có 1–${MAX_NAME_LENGTH} ký tự`);
            const draft = buildAdPayload(p, assetResolver(origin));
            const job = await deps.service().adCreate({ name, source: origin, draft });
            return { videoId: job.id, status: job.status };
        },

        cancel: async (params: any) => deps.service().cancel(readVideoId(params)),

        delete: async (params: any): Promise<void> => deps.service().delete(readVideoId(params)),

        /**
         * Mở tệp mp4/ảnh bìa để Control API phát cho bot tải. Không theo symlink (O_NOFOLLOW; Windows không có thì bỏ qua)
         * và không bao giờ đưa đường dẫn máy chủ vào thông báo lỗi.
         */
        openFile: async (params: any): Promise<{ stream: Readable; size: number }> => {
            const id = readVideoId(params);
            const kind = params?.kind ?? 'video';
            if (kind !== 'video' && kind !== 'thumb') bad('kind phải là video hoặc thumb');
            const job = deps.service().get(id);
            if (!job) throw new RenderError('not_found', 'Không tìm thấy video');
            if (job.status !== 'done') throw new RenderError('not_found', 'Video chưa render xong');
            const target = kind === 'video' ? job.filePath : job.thumbPath;
            if (!target) throw new RenderError('not_found', kind === 'video' ? 'Video chưa render xong' : 'Video không có ảnh bìa');
            const gone = () => new RenderError('not_found', 'Tệp video không còn trên máy');
            let handle: fs.promises.FileHandle;
            try {
                handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
            } catch { throw gone(); }
            try {
                const stat = await handle.stat();
                if (!stat.isFile()) throw gone();
                // Đọc đúng `size` byte đã báo trong Content-Length, kể cả nếu tệp có bị ghi thêm sau fstat.
                return { stream: handle.createReadStream(stat.size > 0 ? { start: 0, end: stat.size - 1 } : undefined), size: stat.size };
            } catch (err) {
                await handle.close().catch(() => undefined);
                throw err instanceof RenderError ? err : gone();
            }
        },

        /** Lưu MP4 ra nơi người dùng chọn; chỉ dùng trong app (hộp thoại), không có trong Control API. */
        exportFile: async (params: any): Promise<{ saved: boolean; path?: string }> => {
            const job = deps.service().get(readVideoId(params));
            if (!job) throw new RenderError('not_found', 'Không tìm thấy video');
            if (job.status !== 'done' || !job.filePath) bad('Video chưa render xong');
            if (!fs.existsSync(job.filePath!)) bad('Tệp video không còn trên máy');
            const target = await deps.pickSavePath(`${job.name.replace(/[\\/:*?"<>|]+/g, '_')}.mp4`);
            if (!target) return { saved: false };
            await fs.promises.copyFile(job.filePath!, target);
            return { saved: true, path: target };
        },
    };
}

export type VideoOperations = ReturnType<typeof createVideoOperations>;
export type PublicVideoJob = ReturnType<typeof publicView>;

/** Một chỗ chuyển sự kiện của VideoService: renderer nhận `video:changed`, Control API nhận `videos.finished` với đúng các trường đã công bố. */
export function routeVideoEvent(
    sinks: { broadcast(channel: string): void; emitControl(type: 'videos.finished', payload: unknown): void },
    type: string,
    payload?: unknown,
): void {
    if (type === 'video:changed') sinks.broadcast(type);
    else if (type === 'videos.finished') sinks.emitControl(type, buildVideoFinished(payload as Parameters<typeof buildVideoFinished>[0]));
}
