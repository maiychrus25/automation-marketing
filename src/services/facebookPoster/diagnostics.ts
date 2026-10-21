import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'playwright-core';
import { currentUrl } from './postToTargets';

/** Ảnh chẩn đoán giữ tối đa bấy nhiêu ngày / tệp trên máy (không gửi qua API hay Telegram). */
export const DIAGNOSTIC_RETENTION_MS = 7 * 86_400_000;
export const DIAGNOSTIC_MAX_FILES = 500;

/** Tên tệp (không đuôi): 8 ký tự đầu profileId, số thứ tự đích, lần thử. */
export function diagnosticFileBase(profileId: string, targetIndex: number, attempt: number): string {
    return `${profileId.slice(0, 8).replace(/[^A-Za-z0-9_-]/g, '_')}-${targetIndex}-l${attempt}`;
}

/**
 * Dọn thư mục chẩn đoán: xoá thư mục lượt cũ hơn DIAGNOSTIC_RETENTION_MS, rồi nếu còn
 * quá DIAGNOSTIC_MAX_FILES tệp thì xoá thư mục lượt cũ nhất cho tới khi đủ.
 * Không bao giờ xoá thư mục lượt mới nhất hay thư mục có tên trong `keep` (lượt đang chạy).
 * Thư mục gốc không tồn tại thì bỏ qua; lỗi trên một thư mục lượt không chặn các thư mục khác.
 */
export function pruneDiagnostics(dir: string, now: number, fsImpl: typeof fs = fs, keep: ReadonlySet<string> = new Set()): void {
    let names: string[];
    try {
        names = fsImpl.readdirSync(dir);
    } catch {
        return;
    }
    const runs: { path: string; mtime: number; files: number; keep: boolean }[] = [];
    for (const name of names) {
        const runPath = path.join(dir, name);
        try {
            const stat = fsImpl.statSync(runPath);
            if (!stat.isDirectory()) continue;
            if (!keep.has(name) && now - stat.mtimeMs > DIAGNOSTIC_RETENTION_MS) {
                fsImpl.rmSync(runPath, { recursive: true, force: true });
                continue;
            }
            runs.push({ path: runPath, mtime: stat.mtimeMs, files: fsImpl.readdirSync(runPath).length, keep: keep.has(name) });
        } catch { /* thư mục này hỏng thì bỏ qua, không chặn việc dọn các thư mục khác */ }
    }
    runs.sort((a, b) => a.mtime - b.mtime);
    let total = runs.reduce((sum, r) => sum + r.files, 0);
    // Thư mục mới nhất (cuối danh sách) là lượt vừa/đang chạy: giữ lại dù một mình nó vượt trần.
    for (const run of runs.slice(0, -1)) {
        if (total <= DIAGNOSTIC_MAX_FILES) break;
        if (run.keep) continue;
        try {
            fsImpl.rmSync(run.path, { recursive: true, force: true });
            total -= run.files;
        } catch { /* như trên */ }
    }
}

const TITLE_TIMEOUT_MS = 1000;

/** Tiêu đề trang; trang treo hoặc lỗi thì '' sau tối đa TITLE_TIMEOUT_MS (ảnh đã lưu, không để tiêu đề chặn). */
async function readTitle(page: Page): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            page.title().catch(() => ''),
            new Promise<string>((resolve) => { timer = setTimeout(() => resolve(''), TITLE_TIMEOUT_MS); }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Chụp vùng đang nhìn thấy + ghi chú (URL, tiêu đề, đích, mã lỗi, lần thử, giờ). Không ghi nội dung trang. Trả tên tệp ảnh. */
export async function saveDiagnosticFiles(
    dir: string,
    base: string,
    page: Page,
    meta: { targetUrl: string; attempt: number; errorCode: string; at: number },
): Promise<string> {
    const image = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${base}.jpg`), image);
    const title = await readTitle(page);
    fs.writeFileSync(path.join(dir, `${base}.txt`), [
        `Trang: ${currentUrl(page)}`,
        `Tiêu đề: ${title}`,
        `Đích: ${meta.targetUrl}`,
        `Mã lỗi: ${meta.errorCode}`,
        `Lần thử: ${meta.attempt}`,
        `Thời điểm: ${new Date(meta.at).toISOString()}`,
        '',
    ].join('\n'));
    return `${base}.jpg`;
}
