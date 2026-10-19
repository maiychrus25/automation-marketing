import type { ResearchErrorCode, ResearchScanStatus, ResearchSource } from '../../../models/research';

export const SOURCE_LABEL: Record<ResearchSource, string> = {
  posts: 'Bài viết', groups: 'Nhóm', pages: 'Fanpage', group_feed: 'Bài trong nhóm đã tham gia',
};

export const ERROR_LABEL: Record<ResearchErrorCode, string> = {
  logged_out: 'Hết phiên',
  checkpoint: 'Checkpoint',
  rate_limited: 'Bị giới hạn',
  query_changed: 'Facebook đổi truy vấn',
  parse_failed: 'Không đọc được dữ liệu',
  no_profile_available: 'Hết profile dùng được',
  cancelled: 'Đã huỷ',
};

export const SCAN_STATUS: Record<ResearchScanStatus, { label: string; cls: string }> = {
  running: { label: 'Đang chạy', cls: 'text-blue-400' },
  done: { label: 'Xong', cls: 'text-green-400' },
  failed: { label: 'Lỗi', cls: 'text-red-400' },
  cancelled: { label: 'Đã huỷ', cls: 'text-orange-400' },
};

export const errorLabel = (code: string): string => ERROR_LABEL[code as ResearchErrorCode] || code;

/** Số nguyên có dấu chấm ngăn cách hàng nghìn; null hoặc không hợp lệ thì '—'. */
export function formatCount(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('vi-VN') : '—';
}

/** Tỉ lệ tương tác (0.0123) thành phần trăm 2 chữ số thập phân; null thì '—'. */
export function formatRate(rate: number | null | undefined): string {
  return typeof rate === 'number' && Number.isFinite(rate) ? `${(rate * 100).toFixed(2)}%` : '—';
}

export function formatTime(at: number | null | undefined): string {
  return typeof at === 'number' && at > 0 ? new Date(at).toLocaleString('vi-VN', { hour12: false }) : '—';
}

/** Đọc ô số: rỗng hoặc ngoài khoảng thì trả null (để báo lỗi), ngược lại số nguyên. */
export function parseBoundedInt(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

/** Danh sách URL nhóm: mỗi dòng/dấu phẩy một URL, bỏ rỗng và trùng. */
export function parseUrlList(raw: string): string[] {
  return [...new Set(raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))];
}
