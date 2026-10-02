/**
 * UpdateNotification - vô hiệu hóa trong bản nội bộ MaiHub.
 *
 * Bản gốc hiển thị hộp thoại cập nhật với các nút tải trỏ thẳng tới kho phát
 * hành của tác giả thượng nguồn; bấm vào sẽ cài đè bản nội bộ của trung tâm.
 * Auto-update đã tắt ở main process nên không có sự kiện update nào phát ra,
 * hộp thoại này không còn lý do tồn tại. Bản nội bộ phát hành theo kênh riêng.
 *
 * Giữ lại component rỗng để App.tsx không phải đổi cấu trúc.
 */
export function UpdateNotification() {
  return null;
}
