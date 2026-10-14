import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import type { Readable } from 'stream';
import { IMAGE_EXTENSIONS, extensionOf } from '../facebookPoster/mediaRules';
import { ControlError } from './ControlMethods';
import type { SavedMedia } from './ControlApiServer';

export const INBOX_MAX_AGE_MS = 24 * 3_600_000;
const PART_SUFFIX = '.part';
const MEDIA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Hộp thư tệp tải lên qua /v1/media. Mỗi tệp là `<dir>/<mediaId>.<đuôi>`: đuôi giữ lại vì `validateStartParams` kiểm loại tệp theo đuôi.
 * Không có sidecar: tên gốc/loại nội dung chỉ cần lúc trả lời upload, không ai đọc lại sau đó.
 * Tệp đang ghi nằm ở `<mediaId>.<đuôi>.part` và chỉ được đổi tên khi ghi xong, nên `resolve` không bao giờ thấy tệp dở.
 */
export class InboxMediaStore {
    constructor(private readonly dir: string) {}

    async save(name: string, _contentType: string, stream: Readable): Promise<SavedMedia> {
        const ext = extensionOf(name);
        const mediaId = randomUUID();
        const finalPath = path.join(this.dir, `${mediaId}.${ext}`);
        const partPath = `${finalPath}${PART_SUFFIX}`;
        fs.mkdirSync(this.dir, { recursive: true });
        try {
            await pipeline(stream, fs.createWriteStream(partPath, { flags: 'wx', mode: 0o600 }));
            const size = fs.statSync(partPath).size;
            if (size === 0) throw new ControlError('INVALID_PARAMS', 'Tệp rỗng', { field: 'body' });
            fs.renameSync(partPath, finalPath);
            return { mediaId, name, size, kind: IMAGE_EXTENSIONS.includes(ext) ? 'image' : 'video' };
        } catch (err) {
            fs.rmSync(partPath, { force: true }); // stream lỗi / vượt giới hạn / client ngắt: không để tệp dở
            throw err;
        }
    }

    /** mediaId → đường dẫn tuyệt đối; id lạ, sai định dạng hoặc đã bị dọn thì ném INVALID_PARAMS (field mediaIds). */
    resolve(mediaIds: string[]): string[] {
        let names: string[] = [];
        try { names = fs.readdirSync(this.dir); } catch { /* chưa có thư mục = chưa có tệp */ }
        return mediaIds.map((id) => {
            const found = MEDIA_ID_PATTERN.test(id)
                ? names.find((n) => n.startsWith(`${id}.`) && !n.endsWith(PART_SUFFIX))
                : undefined;
            if (!found) throw new ControlError('INVALID_PARAMS', 'Có mediaId không tồn tại hoặc đã hết hạn', { field: 'mediaIds' });
            return path.join(this.dir, found);
        });
    }

    /** Xoá tệp (kể cả `.part` bỏ dở) cũ hơn `maxAgeMs`; trả số tệp đã xoá. */
    cleanup(now: number, maxAgeMs: number = INBOX_MAX_AGE_MS): number {
        let removed = 0;
        let names: string[] = [];
        try { names = fs.readdirSync(this.dir); } catch { return 0; }
        for (const name of names) {
            const file = path.join(this.dir, name);
            try {
                if (now - fs.statSync(file).mtimeMs > maxAgeMs) { fs.rmSync(file, { force: true }); removed++; }
            } catch { /* tệp biến mất giữa chừng */ }
        }
        return removed;
    }
}
