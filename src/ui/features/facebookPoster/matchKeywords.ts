/** Bỏ dấu tiếng Việt, đ → d, chữ thường. Cùng quy tắc `boDau` của FB Poster (public/common.js@c135379). */
export function stripAccents(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    // Viết bằng mã escape: dấu thanh sau NFD là ký tự không nhìn thấy, dán thẳng vào mã nguồn thì không soát được.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

/**
 * Tên nhóm có khớp ô lọc không (FB Poster `khopTuKhoa`): nhiều từ khoá cách nhau dấu phẩy,
 * khớp BẤT KỲ từ nào, không phân biệt dấu. Ô rỗng (hoặc chỉ toàn dấu phẩy) = không lọc, trả true.
 */
export function matchesKeywords(name: string, filter: string): boolean {
  const keywords = String(filter ?? '').split(',').map((s) => stripAccents(s).trim()).filter(Boolean);
  if (!keywords.length) return true;
  const haystack = stripAccents(name);
  return keywords.some((k) => haystack.includes(k));
}
