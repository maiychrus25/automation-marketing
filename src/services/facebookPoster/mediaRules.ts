// Luật chọn ảnh/video cho bài đăng. Thuần chuỗi: dùng chung cho main và renderer, không import Node/electron.
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm'];
export const MAX_IMAGES = 10;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export interface MediaItem { path: string; size: number; }

/** Đuôi tệp viết thường, '' khi không có. */
export function extensionOf(path: string): string {
    const name = path.split(/[\\/]/).pop() ?? '';
    const dot = name.lastIndexOf('.');
    return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function isVideo(path: string): boolean {
    return VIDEO_EXTENSIONS.includes(extensionOf(path));
}

/** Bỏ đường dẫn trùng, giữ lần xuất hiện đầu. */
export function dedupePaths(paths: string[]): string[] {
    return [...new Set(paths)];
}

/** Lọc tệp kéo-thả: chỉ ảnh/video hợp lệ, bỏ path rỗng + trùng (với danh sách hiện có và trùng nhau). Trả các item MỚI để thêm. */
export function acceptDroppedMedia(dropped: MediaItem[], existing: MediaItem[]): MediaItem[] {
    const supported = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];
    const seen = new Set(existing.map((i) => i.path));
    const out: MediaItem[] = [];
    for (const d of dropped) {
        if (!d.path || seen.has(d.path) || !supported.includes(extensionOf(d.path))) continue;
        seen.add(d.path);
        out.push({ path: d.path, size: d.size });
    }
    return out;
}

/** null khi hợp lệ, ngược lại là thông báo tiếng Việt. Thứ tự kiểm tra: đuôi tệp, trộn video, số lượng, dung lượng từng ảnh, tổng dung lượng. */
export function validateMediaSelection(items: MediaItem[]): string | null {
    const supported = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];
    if (items.some((i) => !supported.includes(extensionOf(i.path)))) return `Chỉ hỗ trợ ảnh/video: ${supported.join(', ')}`;
    const videos = items.filter((i) => isVideo(i.path));
    if (videos.length && items.length > 1) return 'Một bài chỉ có 1 video, không kèm ảnh khác';
    if (items.length > MAX_IMAGES) return `Tối đa ${MAX_IMAGES} ảnh mỗi bài`;
    if (videos.length) return null;
    const big = items.find((i) => i.size > MAX_IMAGE_BYTES);
    if (big) return `Ảnh "${big.path.split(/[\\/]/).pop()}" lớn hơn 20 MB`;
    if (items.reduce((sum, i) => sum + i.size, 0) > MAX_TOTAL_BYTES) return 'Tổng dung lượng ảnh vượt 100 MB';
    return null;
}
