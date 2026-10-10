import fs from 'fs';
import path from 'path';

export const SCHEDULE_MEDIA_DIR = 'facebook-poster-media';

const ID_RE = /^[A-Za-z0-9-]+$/;

function assertValidId(scheduleId: string): void {
  if (!ID_RE.test(scheduleId)) throw new Error('Mã lịch không hợp lệ');
}

function sanitize(name: string): string {
  return path.basename(name).replace(/^\d{2}-/, '').replace(/[^A-Za-z0-9._-]/g, '_') || 'file';
}

export function scheduleMediaDir(baseDir: string, scheduleId: string): string {
  return path.join(baseDir, SCHEDULE_MEDIA_DIR, scheduleId);
}

/** Chép nguồn theo thứ tự thành "<NN>-<tên đã làm sạch>"; lỗi thì xoá thư mục và ném lại. */
export function copyScheduleMedia(baseDir: string, scheduleId: string, sources: string[]): string[] {
  assertValidId(scheduleId);
  const dir = scheduleMediaDir(baseDir, scheduleId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    return sources.map((src, i) => {
      const name = `${String(i + 1).padStart(2, '0')}-${sanitize(src)}`;
      fs.copyFileSync(src, path.join(dir, name));
      return name;
    });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

export function resolveScheduleMedia(baseDir: string, scheduleId: string, names: string[]): string[] {
  assertValidId(scheduleId);
  const dir = scheduleMediaDir(baseDir, scheduleId);
  return names.map(n => path.join(dir, path.basename(n)));
}

export function removeScheduleMedia(baseDir: string, scheduleId: string): void {
  if (!ID_RE.test(scheduleId)) return;
  try {
    fs.rmSync(scheduleMediaDir(baseDir, scheduleId), { recursive: true, force: true });
  } catch { /* không ném lỗi */ }
}

/**
 * Ghi lại toàn bộ ảnh của một lịch (sửa nháp). Chép `sources` — có thể gồm chính tệp đang nằm trong thư mục
 * của lịch — sang thư mục tạm rồi mới tráo, nên tệp cũ không bị xoá trước khi chép xong; tệp không còn dùng biến mất.
 */
export function replaceScheduleMedia(baseDir: string, scheduleId: string, sources: string[]): string[] {
  assertValidId(scheduleId);
  const stagingId = `${scheduleId}-staging`;
  removeScheduleMedia(baseDir, stagingId);
  const names = copyScheduleMedia(baseDir, stagingId, sources);
  const dir = scheduleMediaDir(baseDir, scheduleId);
  // Đổi chỗ có hoàn tác: rename có thể bị chặn (EPERM/EBUSY trên Windows) — khi đó trả ảnh cũ về, không mất ảnh.
  const oldId = `${scheduleId}-old`;
  removeScheduleMedia(baseDir, oldId);
  const hadOld = fs.existsSync(dir);
  if (hadOld) fs.renameSync(dir, scheduleMediaDir(baseDir, oldId));
  try {
    fs.renameSync(scheduleMediaDir(baseDir, stagingId), dir);
  } catch (err) {
    if (hadOld) fs.renameSync(scheduleMediaDir(baseDir, oldId), dir);
    removeScheduleMedia(baseDir, stagingId);
    throw err;
  }
  removeScheduleMedia(baseDir, oldId);
  return names;
}
