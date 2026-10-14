import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import { Transform, type Readable } from 'stream';
import { IMAGE_EXTENSIONS, extensionOf } from '../facebookPoster/mediaRules';
import { ControlError } from './ControlMethods';
import type { SavedMedia } from './ControlApiServer';

export const INBOX_MAX_AGE_MS = 24 * 3_600_000;
export const INBOX_MAX_BYTES = 2_147_483_648; // 2 GiB
export const INBOX_MAX_FILES = 200;
const PART_SUFFIX = '.part';
const MEDIA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Hộp thư tệp tải lên qua /v1/media. Mỗi tệp là `<dir>/<mediaId>.<đuôi>`: đuôi giữ lại vì `validateStartParams` kiểm loại tệp theo đuôi.
 * Không có sidecar: tên gốc/loại nội dung chỉ cần lúc trả lời upload, không ai đọc lại sau đó.
 * Tệp đang ghi nằm ở `<mediaId>.<đuôi>.part` và chỉ được đổi tên khi ghi xong, nên `resolve` không bao giờ thấy tệp dở.
 */
export class InboxMediaStore {
    /** Đang ghi dở của mọi lần `save` đồng thời: cộng vào dung lượng đã có để tải song song không vượt trần. */
    private pendingFiles = 0;
    private pendingBytes = 0;
    /** Byte của các lần `save` đã xong từ khi instance tạo; trừ phần lúc bắt đầu để biết tệp nào vừa vào trong lúc đang nhận. */
    private committedBytes = 0;

    constructor(
        private readonly dir: string,
        private readonly limits: { maxBytes: number; maxFiles: number } = { maxBytes: INBOX_MAX_BYTES, maxFiles: INBOX_MAX_FILES },
    ) {}

    /** Số tệp và tổng byte của tệp đã lưu xong (bỏ `.part`: tệp dở được tính riêng qua pending*). */
    private usage(): { files: number; bytes: number } {
        let files = 0;
        let bytes = 0;
        let names: string[] = [];
        try { names = fs.readdirSync(this.dir); } catch { return { files, bytes }; }
        for (const name of names) {
            if (name.endsWith(PART_SUFFIX)) continue;
            try { bytes += fs.statSync(path.join(this.dir, name)).size; files++; } catch { /* tệp biến mất giữa chừng */ }
        }
        return { files, bytes };
    }

    async save(name: string, _contentType: string, stream: Readable): Promise<SavedMedia> {
        const ext = extensionOf(name);
        const mediaId = randomUUID();
        const finalPath = path.join(this.dir, `${mediaId}.${ext}`);
        const partPath = `${finalPath}${PART_SUFFIX}`;
        fs.mkdirSync(this.dir, { recursive: true });
        const used = this.usage();
        if (used.files + this.pendingFiles >= this.limits.maxFiles) {
            throw new ControlError('LIMIT_REACHED', `Hộp thư tải lên đã đủ ${this.limits.maxFiles} tệp, hãy đợi tệp cũ được dọn (24 giờ) rồi thử lại`);
        }
        if (used.bytes + this.pendingBytes >= this.limits.maxBytes) throw this.bytesError();
        this.pendingFiles++;
        const committedAtStart = this.committedBytes;
        let written = 0;
        // Đếm byte khi đang nhận: nhiều tải song song cùng vượt trần thì chỉ tệp làm tràn bị cắt.
        const guard = new Transform({
            transform: (chunk, _enc, cb) => {
                if (used.bytes + (this.committedBytes - committedAtStart) + this.pendingBytes + chunk.length > this.limits.maxBytes) { cb(this.bytesError()); return; }
                written += chunk.length;
                this.pendingBytes += chunk.length;
                cb(null, chunk);
            },
        });
        try {
            await pipeline(stream, guard, fs.createWriteStream(partPath, { flags: 'wx', mode: 0o600 }));
            const size = fs.statSync(partPath).size;
            if (size === 0) throw new ControlError('INVALID_PARAMS', 'Tệp rỗng', { field: 'body' });
            fs.renameSync(partPath, finalPath);
            this.committedBytes += size;
            return { mediaId, name, size, kind: IMAGE_EXTENSIONS.includes(ext) ? 'image' : 'video' };
        } catch (err) {
            fs.rmSync(partPath, { force: true }); // stream lỗi / vượt giới hạn / client ngắt: không để tệp dở
            throw err;
        } finally {
            this.pendingFiles--;
            this.pendingBytes -= written;
        }
    }

    private bytesError(): ControlError {
        return new ControlError('PAYLOAD_TOO_LARGE', `Hộp thư tải lên đã gần đầy (tối đa ${Math.round(this.limits.maxBytes / 1024 / 1024)} MB), hãy đợi tệp cũ được dọn (24 giờ) rồi thử lại`);
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
