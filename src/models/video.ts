// Mô hình dữ liệu Video Studio (docs/specs/2026-10-20-video-studio.md mục 6.2).
export type VideoStatus = 'uploading' | 'queued' | 'rendering' | 'done' | 'failed' | 'cancelled';
export type VideoSource = 'app' | 'bot';

export interface VideoJob {
    id: string;
    remoteId: string | null;
    name: string;
    source: VideoSource;
    templateId: string | null; // null = HTML tự viết
    aspect: string;
    specJson: string;
    status: VideoStatus;
    progress: number;
    error: string;
    filePath: string | null;
    thumbPath: string | null;
    sizeBytes: number | null;
    durationSec: number | null;
    createdAt: number;
    finishedAt: number | null;
}
