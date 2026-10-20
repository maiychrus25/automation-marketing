import { readVariants } from '../../../services/facebookPoster/variants';

/**
 * Đích của một nháp → trạng thái chọn nhóm của modal soạn bài: nhóm đã quét mà không nằm trong đích thì bỏ chọn;
 * đích không có trong danh sách đã quét (link nhập tay) thì đưa vào ô "link nhóm".
 */
export function hydrateTargets(targets: string[], scannedUrls: string[]): { uncheckedUrls: string[]; extraLinks: string } {
  const wanted = new Set(targets);
  const scanned = new Set(scannedUrls);
  return {
    uncheckedUrls: scannedUrls.filter((url) => !wanted.has(url)),
    extraLinks: targets.filter((url) => !scanned.has(url)).join('\n'),
  };
}

/**
 * Đích lưu cho một profile. Khi nhóm chưa tải xong (đang có việc chạy, tải chậm/lỗi) thì đích của nháp chưa được áp
 * vào form; lưu lúc đó phải giữ đích gốc, không lưu thành rỗng. `pending` = null khi đã áp xong.
 */
export function targetsToSave(profileId: string, formTargets: string[], pending: { profileId: string; targets?: string[] }[] | null): string[] {
  const original = pending?.find((p) => p.profileId === profileId);
  return original ? original.targets ?? [] : formTargets;
}

/** Biến thể B…E của một nháp/lịch (params.variants); thiếu hoặc sai kiểu = không có biến thể. */
export function hydrateVariants(params: { variants?: unknown } | undefined): string[] {
  const raw = params?.variants;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

/** Lỗi tiếng Việt của các tab biến thể (rỗng/trùng/quá dài), cùng luật với máy chủ; null khi hợp lệ. */
export function validateVariantTabs(text: string, extraTexts: string[]): string | null {
  try { readVariants({ text, variants: extraTexts }); return null; }
  catch (error) { return error instanceof Error ? error.message : 'Biến thể không hợp lệ'; }
}

/** `variants` chỉ có khi có ít nhất một tab phụ; bài không biến thể giữ nguyên tham số cũ. */
export function buildVariantParams(extraTexts: string[]): { variants?: string[] } {
  return extraTexts.length > 0 ? { variants: extraTexts } : {};
}
