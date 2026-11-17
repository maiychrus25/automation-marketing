/**
 * Pure (no imports): shared by the employee renderer and the boss relay.
 */

/** Chuỗi dài hơn mức này bị cắt trước khi xử lý: mẫu tìm đường dẫn có dấu cách chạy theo bình phương độ dài, và chuỗi lỗi có thể chứa nội dung do máy nhân viên gửi lên. */
export const REDACT_MAX_LENGTH = 2000;

/**
 * Thay đường dẫn tuyệt đối trong một chuỗi lỗi/nhật ký bằng tên tệp; link http(s) giữ nguyên.
 * Chỉ là cố gắng tối đa để không hiện đường dẫn máy Boss cho nhân viên, không phải ranh giới bảo mật:
 * đường dẫn không có đuôi tệp, có dấu cách và nằm ngoài thư mục nhà vẫn có thể còn lại một phần.
 */
export function redactPaths(text: string): string {
  const input = text.length > REDACT_MAX_LENGTH ? `${text.slice(0, REDACT_MAX_LENGTH)}…` : text;
  return input
    // 1. Đường dẫn tới một tệp có đuôi: thư mục được phép có dấu cách ("Application Support", tên người dùng)
    .replace(/[A-Za-z]:\\(?:[^\\/"'<>|:*?\n]+\\)*?([^\\/"'<>|:*?\n]*?\.[A-Za-z0-9]{2,5})(?![A-Za-z0-9\\/])/g, '$1')
    // \p{L}: dấu gạch chéo đứng sau một chữ cái (kể cả chữ có dấu, "đã/chưa") không mở đầu đường dẫn
    .replace(/(?<![\p{L}\p{N}_:/.])\/(?=[^\s/])(?:[^/"'<>|:\n]+\/)+?([^/"'<>|:\n]*?\.[A-Za-z0-9]{2,5})(?![A-Za-z0-9\\/])/gu, '$1')
    // 2. Phần còn lại (không có đuôi tệp): bỏ thư mục nhà để không lộ tên người dùng
    .replace(/[A-Za-z]:\\Users\\[^\\\n"'<>|:*?]+\\/g, '')
    .replace(/(?<![\p{L}\p{N}_:/.])\/(?:Users|home)\/[^/\n"'<>|:]+\//gu, '')
    // 3. Đường dẫn tuyệt đối không dấu cách còn sót: chỉ giữ phần cuối
    .replace(/[A-Za-z]:\\(?:[^\s\\/"'<>|:*?]+\\)*([^\s\\/"'<>|:*?]+)/g, '$1')
    .replace(/(?<![\p{L}\p{N}_:/.])\/(?:[^\s/"'<>|:]+\/)+([^\s/"'<>|:]+)/gu, '$1');
}
