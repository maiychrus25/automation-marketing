/**
 * Kiểm tham số và dựng payload `ad_video` của AHV AI (spec docs/specs/2026-10-27-ad-video.md mục 7).
 * Thuần, không I/O: nơi gọi cấp hàm `resolve` để đổi tệp cục bộ / mã hộp thư thành tệp sẽ tải lên AHV.
 *
 * Tham số vào theo quy ước MaiHub (camelCase); tên trường của AHV (snake_case) chỉ xuất hiện ở đây.
 * Cố ý KHÔNG kiểm tổng độ dài 10–60 giây và độ dài lời đọc: phép đó cần cách đếm âm tiết của AHV,
 * làm lại sẽ lệch và chặn oan — để AHV trả AD_TOTAL_DURATION / AD_LINE_TOO_LONG.
 */
import { AD_LANGUAGES, AD_LIMITS, AD_SCENE_TYPES } from '../../models/video';
import { RenderError } from './RenderClient';
import { AD_UPLOAD_MARK, type AdPayloadDraft, type AdUpload } from './VideoService';

export { AD_LANGUAGES, AD_LIMITS, AD_SCENE_TYPES };

export type AdAssetKind = 'path' | 'mediaId';
/** Đổi tệp cục bộ (ứng dụng) hoặc mã tệp hộp thư (bot) thành tệp sẽ tải lên AHV; ném lỗi nếu không dùng được. */
export type AdAssetResolver = (req: { kind: AdAssetKind; value: string; field: string }) => AdUpload;

const bad = (message: string): never => { throw new RenderError('invalid', message); };

function text(value: unknown, field: string, max: number, required: boolean): string | undefined {
    if (value === undefined || value === null || value === '') {
        if (required) bad(`Thiếu ${field}`);
        return undefined;
    }
    if (typeof value !== 'string') bad(`${field} phải là chữ`);
    const trimmed = (value as string).trim();
    if (!trimmed) { if (required) bad(`Thiếu ${field}`); return undefined; }
    if (trimmed.length > max) bad(`${field} tối đa ${max} ký tự`);
    return trimmed;
}

function number(value: unknown, field: string, min: number, max: number): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) bad(`${field} phải là số`);
    const n = value as number;
    if (n < min || n > max) bad(`${field} phải từ ${min} đến ${max}`);
    return n;
}

/**
 * Một chỗ nhận tệp: đúng một trong `<base>Url` (link công khai), `<base>Path` (ứng dụng) hoặc
 * `<base>MediaId` (bot). Trả link, hoặc chỗ cắm `{ __adUpload: n }` và đẩy tệp vào `uploads`.
 */
function asset(
    holder: any, base: string, field: string, uploads: AdUpload[], resolve: AdAssetResolver,
): string | { [AD_UPLOAD_MARK]: number } | undefined {
    const key = (suffix: string) => (base ? `${base}${suffix}` : suffix.charAt(0).toLowerCase() + suffix.slice(1));
    const url = holder?.[key('Url')];
    const filePath = holder?.[key('Path')];
    const mediaId = holder?.[key('MediaId')];
    const given = [url, filePath, mediaId].filter((v) => v !== undefined && v !== null && v !== '');
    if (given.length === 0) return undefined;
    if (given.length > 1) bad(`${field}: chỉ chọn một trong link, tệp trên máy hoặc mã tệp đã tải lên`);
    if (url !== undefined && url !== null && url !== '') {
        if (typeof url !== 'string' || !/^https?:\/\/\S+$/i.test(url.trim())) bad(`${field} phải là link http hoặc https công khai`);
        return (url as string).trim();
    }
    const kind: AdAssetKind = filePath ? 'path' : 'mediaId';
    const value = kind === 'path' ? filePath : mediaId;
    if (typeof value !== 'string' || !value) bad(`${field} không hợp lệ`);
    uploads.push(resolve({ kind, value: value as string, field }));
    return { [AD_UPLOAD_MARK]: uploads.length - 1 };
}

function buildScene(raw: any, index: number, uploads: AdUpload[], resolve: AdAssetResolver): Record<string, unknown> {
    const at = `cảnh ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad(`${at} không hợp lệ`);
    const type = raw.type;
    if (!AD_SCENE_TYPES.includes(type)) bad(`${at}: loại cảnh phải là ai, image hoặc presenter`);
    const scene: Record<string, unknown> = { type };

    if (type === 'presenter') {
        scene.line = text(raw.line, `lời thoại của ${at}`, AD_LIMITS.line, true);
        const setting = text(raw.setting, `bối cảnh của ${at}`, AD_LIMITS.setting, false);
        if (setting) scene.setting = setting;
        const lineAudio = asset(raw, 'lineAudio', `lời đọc sẵn của ${at}`, uploads, resolve);
        if (lineAudio) scene.line_audio_url = lineAudio;
        return scene;
    }

    if (type === 'ai') {
        scene.prompt = text(raw.prompt, `mô tả hình của ${at}`, AD_LIMITS.prompt, true);
    } else {
        const image = asset(raw, 'image', `ảnh của ${at}`, uploads, resolve);
        if (!image) bad(`${at}: thiếu ảnh`);
        scene.image_url = image;
    }
    const motion = text(raw.motion, `chuyển động của ${at}`, AD_LIMITS.motion, false);
    if (motion) scene.motion = motion;
    const voiceover = text(raw.voiceover, `lời đọc nền của ${at}`, AD_LIMITS.voiceover, false);
    if (voiceover) scene.voiceover = voiceover;
    const duration = number(raw.duration, `độ dài của ${at}`, AD_LIMITS.durationMin, AD_LIMITS.durationMax);
    if (duration !== undefined) scene.duration = duration;
    const voiceoverAudio = asset(raw, 'voiceoverAudio', `lời đọc sẵn của ${at}`, uploads, resolve);
    if (voiceoverAudio) scene.voiceover_audio_url = voiceoverAudio;
    return scene;
}

export function buildAdPayload(params: any, resolve: AdAssetResolver): AdPayloadDraft {
    const p = params ?? {};
    const uploads: AdUpload[] = [];
    const payload: Record<string, unknown> = {};

    const language = p.language === undefined || p.language === null ? 'vi' : p.language;
    if (!AD_LANGUAGES.includes(language)) bad('Ngôn ngữ phải là vi hoặc en');
    payload.language = language;

    if (!Array.isArray(p.scenes) || p.scenes.length < AD_LIMITS.minScenes || p.scenes.length > AD_LIMITS.maxScenes) {
        bad(`Kịch bản phải có từ ${AD_LIMITS.minScenes} đến ${AD_LIMITS.maxScenes} cảnh`);
    }
    const scenes = p.scenes.map((raw: any, i: number) => buildScene(raw, i, uploads, resolve));
    payload.scenes = scenes;

    const presenter: Record<string, unknown> = {};
    const presenterImage = asset(p.presenter, 'image', 'ảnh người dẫn', uploads, resolve);
    if (presenterImage) presenter.image_url = presenterImage;
    const presenterPrompt = text(p.presenter?.prompt, 'mô tả người dẫn', AD_LIMITS.presenterPrompt, false);
    if (presenterPrompt) presenter.prompt = presenterPrompt;
    if (presenterImage && presenterPrompt) bad('Người dẫn: chọn ảnh hoặc mô tả, không dùng cả hai');
    if (scenes.some((s: Record<string, unknown>) => s.type === 'presenter') && Object.keys(presenter).length === 0) {
        bad('Có cảnh người dẫn nên phải cho ảnh hoặc mô tả người dẫn');
    }
    if (Object.keys(presenter).length > 0) payload.presenter = presenter;

    if (p.voice !== undefined && p.voice !== null) {
        if (typeof p.voice !== 'object' || Array.isArray(p.voice)) bad('Giọng đọc không hợp lệ');
        const voice: Record<string, unknown> = {};
        const name = text(p.voice.name, 'tên giọng', 60, false);
        const speed = number(p.voice.speed, 'tốc độ giọng', AD_LIMITS.speedMin, AD_LIMITS.speedMax);
        const refAudio = asset(p.voice, 'refAudio', 'đoạn giọng mẫu', uploads, resolve);
        const refText = text(p.voice.refText, 'lời trong đoạn giọng mẫu', AD_LIMITS.voiceover, false);
        if (refAudio && !refText) bad('Có đoạn giọng mẫu thì phải kèm lời trong đoạn đó');
        if (!refAudio && refText) bad('Lời mẫu chỉ dùng kèm đoạn giọng mẫu');
        if (refAudio && name) bad('Giọng đọc: chọn giọng có sẵn hoặc đoạn giọng mẫu, không dùng cả hai');
        if (name) voice.name = name;
        if (speed !== undefined) voice.speed = speed;
        if (refAudio) { voice.ref_audio_url = refAudio; voice.ref_text = refText; }
        if (Object.keys(voice).length > 0) payload.voice = voice;
    }

    if (p.music !== undefined && p.music !== null) {
        if (typeof p.music !== 'object' || Array.isArray(p.music)) bad('Nhạc nền không hợp lệ');
        const file = asset(p.music, '', 'nhạc nền', uploads, resolve);
        const prompt = text(p.music.prompt, 'mô tả nhạc nền', AD_LIMITS.musicPrompt, false);
        if (file && prompt) bad('Nhạc nền: chọn tệp nhạc hoặc mô tả nhạc, không dùng cả hai');
        if (file) payload.music = { url: file };
        else if (prompt) payload.music = { prompt };
    }

    if (p.brand !== undefined && p.brand !== null) {
        if (typeof p.brand !== 'object' || Array.isArray(p.brand)) bad('Thông tin thương hiệu không hợp lệ');
        const brand: Record<string, unknown> = {};
        const logo = asset(p.brand, 'logo', 'logo thương hiệu', uploads, resolve);
        if (logo) brand.logo_url = logo;
        const website = text(p.brand.website, 'website', AD_LIMITS.website, false);
        if (website) brand.website = website;
        const endLine = text(p.brand.endLine, 'câu kết', AD_LIMITS.endLine, false);
        if (endLine) brand.end_line = endLine;
        const endAudio = asset(p.brand, 'endLineAudio', 'lời đọc sẵn của câu kết', uploads, resolve);
        if (endAudio) brand.end_line_audio_url = endAudio;
        // brand rỗng bị AHV bỏ qua im lặng: không gửi để payload gọn
        if (Object.keys(brand).length > 0) payload.brand = brand;
    }

    return { payload, uploads };
}
