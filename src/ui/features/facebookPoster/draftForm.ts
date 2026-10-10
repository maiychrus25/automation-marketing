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
