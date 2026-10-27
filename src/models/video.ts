// Mô hình dữ liệu Video Studio (docs/specs/2026-10-20-video-studio.md mục 6.2).
export type VideoStatus = 'uploading' | 'queued' | 'rendering' | 'done' | 'failed' | 'cancelled';
export type VideoSource = 'app' | 'bot';
/** Máy dựng video: `hyperframes` = máy chủ render riêng; `ahv_ad` = task `ad_video` của AHV AI (26.31.0). */
export type VideoEngine = 'hyperframes' | 'ahv_ad';

/** Mã cảnh báo của `ad_video` (hợp đồng AHV mục 11); tên lạ vẫn được giữ nguyên để hiện cho người. */
export interface AdSceneResult { index: number; type: string; status: string; model?: string | null; start?: number; end?: number; retry?: number }
export interface AdResult {
    warnings: string[];
    costUsd?: { h3?: number; lipsync?: number; total?: number };
    scenes?: AdSceneResult[];
    sttText?: string;
    expiresAt?: string;
    gridUrl?: string;
}

export interface VideoJob {
    id: string;
    remoteId: string | null;
    name: string;
    source: VideoSource;
    engine: VideoEngine;
    templateId: string | null; // null = HTML tự viết (chỉ engine hyperframes)
    aspect: string;
    specJson: string;
    status: VideoStatus;
    progress: number;
    error: string;
    /** Bước đang chạy để hiện cho người và cho bot, ví dụ `H3 3/7`; chỉ engine `ahv_ad` ghi. */
    stepText: string;
    /** JSON `AdResult` của `ad_video` (rỗng với engine `hyperframes`). */
    resultJson: string;
    filePath: string | null;
    thumbPath: string | null;
    sizeBytes: number | null;
    durationSec: number | null;
    createdAt: number;
    finishedAt: number | null;
}

/**
 * Giới hạn của hợp đồng `ad_video` (mục 11 docs-webhook của AHV AI). Đặt ở models vì cả main process
 * (`adVideoPayload.ts`) và giao diện (`adVideoFormat.ts`) đều dùng, không được chép số ra hai nơi.
 */
export const AD_LIMITS = {
    minScenes: 2,
    maxScenes: 10,
    prompt: 500,
    motion: 120,
    voiceover: 300,
    line: 300,
    setting: 500,
    presenterPrompt: 500,
    musicPrompt: 500,
    website: 100,
    endLine: 300,
    durationMin: 2,
    durationMax: 4.3,
    speedMin: 0.7,
    speedMax: 1.3,
} as const;

export const AD_SCENE_TYPES = ['ai', 'image', 'presenter'] as const;
export const AD_LANGUAGES = ['vi', 'en'] as const;

/** Giọng đọc có sẵn của AHV AI (`GET /v1/audio/voices`). */
export interface AdVoiceOption { id: string; name: string; gender?: string; region?: string }

/**
 * Tham số `videos.adCreate` / IPC `video:adCreate` (camelCase theo quy ước MaiHub).
 * Mỗi chỗ nhận tệp dùng đúng một trong `<base>Url` (link công khai), `<base>Path` (ứng dụng)
 * hoặc `<base>MediaId` (bot, mã tệp `/v1/media`). Luật kiểm ở `adVideoPayload.ts`.
 */
export interface AdSceneRequest {
    type: 'ai' | 'image' | 'presenter';
    prompt?: string;
    imageUrl?: string;
    imagePath?: string;
    imageMediaId?: string;
    motion?: string;
    voiceover?: string;
    duration?: number;
    voiceoverAudioUrl?: string;
    voiceoverAudioPath?: string;
    voiceoverAudioMediaId?: string;
    line?: string;
    setting?: string;
    lineAudioUrl?: string;
    lineAudioPath?: string;
    lineAudioMediaId?: string;
}

export interface AdVideoRequest {
    name: string;
    language?: 'vi' | 'en';
    scenes: AdSceneRequest[];
    presenter?: { imageUrl?: string; imagePath?: string; imageMediaId?: string; prompt?: string };
    voice?: { name?: string; speed?: number; refAudioUrl?: string; refAudioPath?: string; refAudioMediaId?: string; refText?: string };
    music?: { url?: string; path?: string; mediaId?: string; prompt?: string };
    brand?: {
        logoUrl?: string; logoPath?: string; logoMediaId?: string;
        website?: string; endLine?: string;
        endLineAudioUrl?: string; endLineAudioPath?: string; endLineAudioMediaId?: string;
    };
}
