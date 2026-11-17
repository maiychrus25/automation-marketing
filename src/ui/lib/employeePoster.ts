// Đăng Facebook trên máy nhân viên: mục nào hiện, view nào mở được, và các dòng nhắc cố định. Thuần, không đọc store.
export const EMPLOYEE_POSTER_SECTIONS: readonly string[] = ['schedule', 'campaigns', 'join', 'comments', 'leads', 'history'];

export const POSTER_EMPLOYEE_NOTICE = 'Lượt chạy diễn ra trên máy Boss, dùng hồ sơ được gán cho bạn.';
export const POSTER_HISTORY_EMPLOYEE_NOTICE = 'Chỉ hiện các lượt chạy dùng hồ sơ của bạn, trong 1000 lượt gần nhất.';
export const POSTER_NO_PROFILE_NOTICE = 'Bạn chưa được gán hồ sơ đăng Facebook nào. Hãy nhờ Boss gán hồ sơ cho bạn.';

export function visiblePosterSections<T extends { id: string }>(sections: readonly T[], isEmployee: boolean): T[] {
  return isEmployee ? sections.filter((s) => EMPLOYEE_POSTER_SECTIONS.includes(s.id)) : [...sections];
}

/** Mục bị ẩn với nhân viên (mục đã lưu, đường dẫn trực tiếp, phím tắt) rơi về `schedule`. */
export function posterSectionFor(section: string, isEmployee: boolean): string {
  return !isEmployee || EMPLOYEE_POSTER_SECTIONS.includes(section) ? section : 'schedule';
}

/** Chỉ hai view có luật riêng ở chế độ nhân viên; view khác để bộ chặn quyền hiện có lo. */
export function canOpenView(view: string, isEmployee: boolean, hasPermission: (module: string) => boolean): boolean {
  if (!isEmployee) return true;
  if (view === 'browser') return false;
  if (view === 'facebookPoster') return hasPermission('fb_poster');
  return true;
}

/** Dung lượng tệp của bản nháp lưu ở máy Boss (không xem trước được): rỗng khi không có số hợp lệ. */
export function formatFileSize(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Nhân viên có quyền nhưng boss chưa gán hồ sơ nào: màn hình chỉ hiện lời nhắc, không tab nào chạy (boss không bao giờ vào nhánh này). */
export function showsNoProfileNotice(isEmployee: boolean, assignedCount: number): boolean {
  return isEmployee && assignedCount === 0;
}

/** So hai danh sách hồ sơ được gán theo nội dung (không theo thứ tự hay identity mảng). */
export function sameProfileIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((id) => set.has(id));
}

/** Khoá ổn định theo nội dung của danh sách hồ sơ: hai danh sách `sameProfileIds` cho cùng một khoá. */
export function profileIdsKey(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join('|');
}

/** Gộp các sự kiện "đã đổi" dồn dập thành một lần tải lại (chỉ máy nhân viên). */
export const EMPLOYEE_POSTER_RELOAD_DEBOUNCE_MS = 250;

const fileNameOf = (path: string) => path.split(/[\\/]/).pop() || path;

/** Danh sách tên tệp (không đường dẫn) cách nhau dấu phẩy: nhân viên không được thấy đường dẫn trên máy Boss. */
export function joinFileNames(paths: readonly string[]): string {
  return paths.map(fileNameOf).join(', ');
}

export { redactPaths, REDACT_MAX_LENGTH } from '../../services/facebookPoster/redactPaths';

/** Boss bỏ gán hồ sơ giữa phiên: giữ lại các id còn được gán (cùng mảng khi không bỏ id nào). */
export function keepAssigned(ids: string[], assigned: readonly string[]): string[] {
  const kept = ids.filter((id) => assigned.includes(id));
  return kept.length === ids.length ? ids : kept;
}

/** Bộ lọc kênh sau khi đổi hồ sơ được gán: lựa chọn rỗng vì mất hết hồ sơ quay về "tất cả" (null); [] (bỏ chọn hết) giữ nguyên. */
export function keepSelectedChannels(selected: string[] | null, assigned: readonly string[]): string[] | null {
  if (selected === null || selected.length === 0) return selected;
  const kept = keepAssigned(selected, assigned);
  return kept.length === 0 ? null : kept;
}
