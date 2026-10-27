// Form "Video quảng cáo AI" (spec docs/specs/2026-10-27-ad-video.md mục 10).
// Giới hạn lấy từ AD_LIMITS của adVideoPayload.ts để giao diện và main process không lệch nhau.
import { AD_LIMITS, type AdVideoRequest, type VideoEngine } from '../../../models/video';

export type AdSceneType = 'ai' | 'image' | 'presenter';
export type AdMusicMode = 'none' | 'file' | 'prompt';
export type AdPresenterMode = 'image' | 'prompt';

export interface AdSceneForm {
    type: AdSceneType;
    prompt: string;
    imagePath: string;
    motion: string;
    voiceover: string;
    /** Chuỗi để ô nhập trống nghĩa là "để hệ tự tính"; đổi sang số khi gửi. */
    duration: string;
    line: string;
    setting: string;
}

export interface AdVideoFormValues {
    name: string;
    language: 'vi' | 'en';
    scenes: AdSceneForm[];
    presenterMode: AdPresenterMode;
    presenterImagePath: string;
    presenterPrompt: string;
    voiceName: string;
    voiceSpeed: string;
    musicMode: AdMusicMode;
    musicPath: string;
    musicPrompt: string;
    brandLogoPath: string;
    brandWebsite: string;
    brandEndLine: string;
}

export const AD_ENGINE_LABEL: Record<VideoEngine, string> = {
    hyperframes: 'Mẫu HyperFrames',
    ahv_ad: 'Quảng cáo AI',
};

export const engineLabel = (engine: string): string => AD_ENGINE_LABEL[engine as VideoEngine] ?? engine;

export const AD_SCENE_LABEL: Record<AdSceneType, string> = {
    ai: 'AI vẽ ảnh',
    image: 'Ảnh của tôi',
    presenter: 'Người dẫn nói',
};

/** Mã cảnh báo của AHV đổi thành câu tiếng Việt cho người duyệt. */
export const AD_WARNING_LABEL: Record<string, string> = {
    stt_mismatch: 'Có câu đọc chưa khớp chữ — nên nghe lại',
    fallback_still: 'Có cảnh phải dùng ảnh tĩnh',
    cut_by_cost_cap: 'Bị cắt vì chạm trần tiền',
    cut_by_time: 'Bị cắt vì chạm trần thời gian',
    h3_8s_used: 'Có cảnh dùng clip dài hơn',
};
export const warningLabel = (code: string): string => AD_WARNING_LABEL[code] ?? code;

export function emptyScene(type: AdSceneType = 'ai'): AdSceneForm {
    return { type, prompt: '', imagePath: '', motion: '', voiceover: '', duration: '', line: '', setting: '' };
}

export function emptyAdForm(): AdVideoFormValues {
    return {
        name: '', language: 'vi',
        scenes: [emptyScene('presenter'), emptyScene('ai')],
        presenterMode: 'image', presenterImagePath: '', presenterPrompt: '',
        voiceName: '', voiceSpeed: '0.9',
        musicMode: 'none', musicPath: '', musicPrompt: '',
        brandLogoPath: '', brandWebsite: '', brandEndLine: '',
    };
}

const MAX_NAME = 100;
const tooLong = (value: string, max: number) => value.trim().length > max;

/** Lỗi theo ô (rỗng khi hợp lệ). Khoá: name, scenes, scene:<i>:<ô>, presenter, voice, music, brand. */
export function validateAdVideoForm(form: AdVideoFormValues): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!form.name.trim()) errors.name = 'Nhập tên video.';
    else if (tooLong(form.name, MAX_NAME)) errors.name = `Tên video tối đa ${MAX_NAME} ký tự.`;

    if (form.scenes.length < AD_LIMITS.minScenes) errors.scenes = `Cần ít nhất ${AD_LIMITS.minScenes} cảnh.`;
    else if (form.scenes.length > AD_LIMITS.maxScenes) errors.scenes = `Tối đa ${AD_LIMITS.maxScenes} cảnh.`;

    form.scenes.forEach((scene, i) => {
        const at = (field: string, message: string) => { errors[`scene:${i}:${field}`] = message; };
        if (scene.type === 'ai') {
            if (!scene.prompt.trim()) at('prompt', 'Nhập mô tả hình của cảnh này.');
            else if (tooLong(scene.prompt, AD_LIMITS.prompt)) at('prompt', `Mô tả tối đa ${AD_LIMITS.prompt} ký tự.`);
        }
        if (scene.type === 'image' && !scene.imagePath) at('image', 'Chọn ảnh cho cảnh này.');
        if (scene.type === 'presenter') {
            if (!scene.line.trim()) at('line', 'Nhập lời thoại của người dẫn.');
            else if (tooLong(scene.line, AD_LIMITS.line)) at('line', `Lời thoại tối đa ${AD_LIMITS.line} ký tự.`);
            if (tooLong(scene.setting, AD_LIMITS.setting)) at('setting', `Bối cảnh tối đa ${AD_LIMITS.setting} ký tự.`);
        } else {
            if (tooLong(scene.motion, AD_LIMITS.motion)) at('motion', `Chuyển động tối đa ${AD_LIMITS.motion} ký tự.`);
            if (tooLong(scene.voiceover, AD_LIMITS.voiceover)) at('voiceover', `Lời đọc nền tối đa ${AD_LIMITS.voiceover} ký tự.`);
            if (scene.duration.trim()) {
                const n = Number(scene.duration);
                if (!Number.isFinite(n) || n < AD_LIMITS.durationMin || n > AD_LIMITS.durationMax) {
                    at('duration', `Độ dài phải từ ${AD_LIMITS.durationMin} đến ${AD_LIMITS.durationMax} giây.`);
                }
            }
        }
    });

    const hasPresenterScene = form.scenes.some((s) => s.type === 'presenter');
    if (hasPresenterScene) {
        if (form.presenterMode === 'image' && !form.presenterImagePath) errors.presenter = 'Chọn ảnh người dẫn.';
        if (form.presenterMode === 'prompt' && !form.presenterPrompt.trim()) errors.presenter = 'Nhập mô tả người dẫn.';
    }
    if (tooLong(form.presenterPrompt, AD_LIMITS.presenterPrompt)) errors.presenter = `Mô tả người dẫn tối đa ${AD_LIMITS.presenterPrompt} ký tự.`;

    if (form.voiceSpeed.trim()) {
        const speed = Number(form.voiceSpeed);
        if (!Number.isFinite(speed) || speed < AD_LIMITS.speedMin || speed > AD_LIMITS.speedMax) {
            errors.voice = `Tốc độ giọng phải từ ${AD_LIMITS.speedMin} đến ${AD_LIMITS.speedMax}.`;
        }
    }

    if (form.musicMode === 'file' && !form.musicPath) errors.music = 'Chọn tệp nhạc hoặc đổi sang không nhạc.';
    if (form.musicMode === 'prompt') {
        if (!form.musicPrompt.trim()) errors.music = 'Nhập mô tả nhạc hoặc đổi sang không nhạc.';
        else if (tooLong(form.musicPrompt, AD_LIMITS.musicPrompt)) errors.music = `Mô tả nhạc tối đa ${AD_LIMITS.musicPrompt} ký tự.`;
    }

    if (tooLong(form.brandWebsite, AD_LIMITS.website)) errors.brand = `Website tối đa ${AD_LIMITS.website} ký tự.`;
    else if (tooLong(form.brandEndLine, AD_LIMITS.endLine)) errors.brand = `Câu kết tối đa ${AD_LIMITS.endLine} ký tự.`;
    return errors;
}

/** Tham số cho IPC `video:adCreate`: bỏ mọi ô trống, đường dẫn tệp đi theo `...Path`. */
export function adVideoRequest(form: AdVideoFormValues): AdVideoRequest {
    const text = (value: string) => (value.trim() ? value.trim() : undefined);
    const request: AdVideoRequest = {
        name: form.name.trim(),
        language: form.language,
        scenes: form.scenes.map((scene) => {
            if (scene.type === 'presenter') {
                return { type: 'presenter' as const, line: scene.line.trim(), ...(text(scene.setting) ? { setting: scene.setting.trim() } : {}) };
            }
            const duration = scene.duration.trim() ? Number(scene.duration) : undefined;
            return {
                type: scene.type,
                ...(scene.type === 'ai' ? { prompt: scene.prompt.trim() } : { imagePath: scene.imagePath }),
                ...(text(scene.motion) ? { motion: scene.motion.trim() } : {}),
                ...(text(scene.voiceover) ? { voiceover: scene.voiceover.trim() } : {}),
                ...(duration !== undefined ? { duration } : {}),
            };
        }),
    };

    if (form.scenes.some((s) => s.type === 'presenter')) {
        request.presenter = form.presenterMode === 'image'
            ? { imagePath: form.presenterImagePath }
            : { prompt: form.presenterPrompt.trim() };
    }

    const voice: NonNullable<AdVideoRequest['voice']> = {};
    if (text(form.voiceName)) voice.name = form.voiceName.trim();
    if (form.voiceSpeed.trim()) voice.speed = Number(form.voiceSpeed);
    if (Object.keys(voice).length > 0) request.voice = voice;

    if (form.musicMode === 'file') request.music = { path: form.musicPath };
    else if (form.musicMode === 'prompt') request.music = { prompt: form.musicPrompt.trim() };

    const brand: NonNullable<AdVideoRequest['brand']> = {};
    if (form.brandLogoPath) brand.logoPath = form.brandLogoPath;
    if (text(form.brandWebsite)) brand.website = form.brandWebsite.trim();
    if (text(form.brandEndLine)) brand.endLine = form.brandEndLine.trim();
    if (Object.keys(brand).length > 0) request.brand = brand;

    return request;
}
