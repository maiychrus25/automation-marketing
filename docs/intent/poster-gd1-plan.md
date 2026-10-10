# Kế hoạch triển khai GĐ1

> Thực hiện bằng Superpowers executing-plans trong worktree dev hiện tại. Không commit, push hoặc deploy.

**Mục tiêu:** tái tạo bố cục và cảm giác Postiz trong trang Đăng Facebook, giữ nguyên backend và chức năng vận hành.

**Brief:** [poster-gd1-handoff.md](poster-gd1-handoff.md). Tham chiếu source Postiz chỉ để hiểu thiết kế, không sao chép code/asset.

## Phạm vi và quyết định

- Sửa `FacebookPosterView.tsx`, `PostTab.tsx`, `ScheduleTab.tsx`, `ScheduleDialog.tsx`, `MediaPicker.tsx`, token CSS/Tailwind và `DESIGN.md`.
- Thêm `calendarModel.ts`, `ChannelsPanel.tsx`, `PostPreview.tsx`, test calendar và ghi chú kiểm chứng GĐ1.
- Tái dùng ProfilePicker, MediaPicker, RunPanel, JoinTab, CommentsTab, HistoryTab, IPC và scheduler.
- Kênh mang `provider` riêng; adapter Facebook ánh xạ profile hiện có. Không xây provider/backend mới.
- Calendar tuần/ngày có lưới giờ; tháng có ô ngày. Lịch lặp chỉ chiếu các lần tương lai, quá khứ dùng lần chạy được backend ghi nhận.
- Dời lịch một lần gửi `runAt`; dời lịch lặp đổi thứ nguồn thành thứ đích và giữ các thứ khác, cần xác nhận áp dụng những lần sau.
- Giữ thao tác bật/tạm dừng, sửa giờ, xoá có xác nhận, xem lịch sử. Giữ danh sách để quản lý cả lịch ngoài khoảng đang xem.
- Modal giữ nội dung trong phiên khi đóng/mở; lịch hẹn dùng dialog sẵn có, mặc định theo ô calendar đã chọn.
- Gỡ AI khỏi luồng soạn. Draft DB và duyệt bài thuộc GĐ2.
- Rủi ro: dời nhầm lịch, mất lựa chọn đích/profile, overflow hoặc mất tiến độ. Rollback bằng diff riêng GĐ1, giữ nguyên file operator đã có.

## Các bước

- [x] Viết test trước cho tuần bắt đầu T2, tháng qua năm, lịch lặp, lịch tạm dừng, lọc profile và patch dời giờ; chạy thấy đỏ rồi triển khai calendarModel.
- [x] Nối ScheduleTab vào dữ liệu scheduleList và schedulesChanged; thêm tuần/ngày/tháng, now-line, lọc trạng thái, chi tiết và kéo-thả; giữ quản lý lịch.
- [x] Thêm token scoped Postiz, font Plus Jakarta Sans, rail 80 px, top bar 80 px, panel Kênh 260 px, nhóm profile có thể thu gọn.
- [x] Đưa PostTab vào modal với preview Facebook trái/phải; giữ ảnh/video, chọn và quét nhóm, bình luận đầu, giới hạn nội dung, nghỉ và concurrency; gỡ AI.
- [x] Restyle các màn còn lại bằng token scoped; giữ các lời gọi IPC và RunPanel. Kiểm chứng thao tác runtime còn chờ.
- [x] Review diff, type-check Electron/renderer, Jest Facebook Poster và theme, Vite build; các tiến trình nặng chạy lần lượt.
- [ ] Stress vòng 1: desktop/mobile × dark/light, calendar, modal, chọn profile/đích, hẹn giờ.
- [ ] Stress vòng 2: dữ liệu dài/nhiều, lỗi IPC, kéo-thả, busy, join/collect/history, ảnh/video và bàn phím/focus.

Hai vòng đã kiểm phần logic/dữ liệu/SSR, nhưng chưa đủ điều kiện nghiệm thu UI: Vite không được mở cổng, trình duyệt bị sandbox chặn khởi động. Không đánh dấu hai vòng desktop/mobile là đạt. Kết quả, danh sách file và checklist còn lại ở [poster-gd1-verification.md](poster-gd1-verification.md).

## Trọng tâm review

1. Lịch lặp nhiều thứ: giữ các thứ không bị dời; không tự ghi lịch đã chạy/đang chờ.
2. Khoảng ngày qua năm/tháng, giờ địa phương: không sai thứ và không tạo lịch quá khứ.
3. Tên/nội dung dài, hàng trăm kênh và nhiều bài cùng giờ: không tràn trang hoặc che hành động.
4. IPC lỗi/không sẵn sàng: có lỗi và thử lại, không giả vờ lưu thành công.
5. Busy và dữ liệu soạn dở: chặn đăng đồng thời, vẫn cho hẹn giờ, giữ nội dung khi đóng/mở.

## Ghi chú môi trường

- `WORKFLOW.md` đọc từ `~/.codex/WORKFLOW.md`; `RULES.md`, wiki và checklist tạo file không có tại các đường dẫn chỉ định.
- Graph đã index nhưng truy vấn/coverage bị policy quyền chặn; dùng source trực tiếp, không khẳng định graph đầy đủ.
- RTK dùng binary trên PATH với `RTK_TELEMETRY_DISABLED=1`, `XDG_DATA_HOME=/tmp/poster-rtk` để thống kê không ghi ra ngoài sandbox.
