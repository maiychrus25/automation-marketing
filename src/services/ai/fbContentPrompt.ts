/**
 * fbContentPrompt.ts
 * Gói USER message cho Trợ Lý viết/trau chuốt bài Facebook.
 * Giọng + cấu trúc brand nằm ở assistant.systemPrompt (cấu hình riêng) — file này chỉ đóng gói yêu cầu.
 */

export function buildWriteMessages(brief: string): { role: string; content: string }[] {
  const b = (brief || '').trim();
  if (!b) throw new Error('empty');
  return [{ role: 'user', content:
`Viết một bài đăng Facebook hoàn chỉnh theo ĐÚNG giọng và cấu trúc brand (tiêu đề in hoa, emoji, bullet, hashtag, thông tin liên hệ) dựa trên brief sau:

${b}

Chỉ trả về nội dung bài đăng, không giải thích.` }];
}

export function buildPolishMessages(draft: string): { role: string; content: string }[] {
  const d = (draft || '').trim();
  if (!d) throw new Error('empty');
  return [{ role: 'user', content:
`Viết lại bài đăng dưới đây theo ĐÚNG giọng và cấu trúc brand, giữ nguyên ý và thông tin, chuẩn hoá emoji/hashtag/liên hệ. Chỉ trả về nội dung đã viết lại:

${d}` }];
}
