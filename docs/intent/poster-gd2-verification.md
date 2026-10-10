# GĐ2 — Bản nháp và luồng duyệt: kiểm chứng

Ngày: 2026-10-10 · Nhánh: `feat/poster-postiz-ui` · Spec: `docs/specs/2026-10-10-poster-gd2-drafts-design.md` · Plan: `docs/plans/2026-10-10-poster-gd2-drafts.md`

## Kiểm chứng tự động (lần chạy cuối, sau mọi sửa)

| Lệnh | Kết quả |
|---|---|
| `npx tsc -p tsconfig.electron.json --noEmit` | exit 0 |
| `npx tsc -p tsconfig.json --noEmit` | exit 0 |
| `npx jest` (trừ 4 suite SQLite) | 36 suite / 623 test pass |
| 4 suite SQLite (Store, Scheduler, Service, drafts) chạy bằng `ELECTRON_RUN_AS_NODE=1 electron jest` | 4 suite / 93 test pass |
| `npx vite build` | exit 0 |

Ghi chú: 3 suite Store/Scheduler/Service trước đây "đỏ" với `npx jest` chỉ vì `better-sqlite3` build cho ABI Electron;
chạy bằng runtime Electron thì xanh. Không phải lỗi code.

## Kiểm thử trên app thật (CDP, 2 vòng, mỗi vòng 14 mục)

| # | Mục | Vòng 1 | Vòng 2 |
|---|---|---|---|
| 1 | Lưu nháp chỉ có nội dung → dải "Nháp chưa xếp lịch"; toast "Đã lưu nháp" | Đạt | Đạt |
| 1b | DB: `draft=1`, `enabled=0`, `next_run_at=NULL` | Đạt | Đạt |
| 2 | Bấm ＋ ở ô 14:00 → nháp có giờ dự kiến, nằm trên lưới, viền nét đứt | Đạt | Đạt |
| 3 | Sửa nháp: modal "Sửa bản nháp" nạp đúng nội dung, lưu, giữ giờ dự kiến | Đạt | Đạt |
| 4 | Kéo nháp sang 16:00 → đổi giờ dự kiến, vẫn tắt | Đạt | Đạt |
| 5 | Duyệt nháp thiếu profile → báo "Chưa chọn profile", nháp giữ nguyên | Đạt | Đạt |
| 6 | Nháp đủ thông tin → Duyệt & hẹn giờ 05/01/2027 09:30 → lịch thật đã bật đúng giờ → tạm dừng ngay | Đạt | Đạt |
| 6b | `scheduleUpdate({enabled:true})` trên nháp bị từ chối | Đạt | Đạt |
| 7 | Đăng ngay → hộp xác nhận → Hủy → nháp còn nguyên | Đạt (sau sửa) | Đạt |
| 8 | Bỏ chọn kênh → nháp chưa có profile vẫn hiện | Đạt | Đạt |
| 9 | 1440 / 390 px × dark / light: không tràn ngang | Đạt ×4 | Đạt ×4 |

Không có lỗi JS trên console ở mọi lần chạy. Chạy thêm 2 lần sau vòng 2: không mục nào trượt.

### Lỗi tìm ra khi chạy thật, đã sửa

- **Hộp xác nhận "Đăng ngay" bị che, không bấm được.** Hộp chi tiết là `<dialog>` mở bằng `showModal()` (top layer,
  phần còn lại inert); hộp xác nhận là `div` thường nên nằm dưới. Sửa như nút "Xoá lịch" có sẵn: đóng hộp chi tiết
  trước rồi mới hỏi; lỗi báo bằng toast. Mục 7 đỏ trước khi sửa, xanh sau khi sửa.
- **Nháp chưa chọn profile hiện "Profile đã xoá"** trên thẻ lịch — đổi thành "Chưa chọn profile".

### An toàn dữ liệu khi kiểm thử

- Không đăng Facebook thật. Lịch thật duy nhất được tạo ở năm 2027, tạm dừng ngay, xoá khi xong. "Đăng ngay" chỉ
  thử tới hộp xác nhận rồi Hủy.
- Dọn sạch sau khi xong: `fb_poster_schedules` còn 0 dòng, thư mục `facebook-poster-media` còn 0 thư mục.
- Migration chạy trên DB thật: cột `draft` được thêm, dữ liệu cũ giữ nguyên.

## Chưa kiểm

- Đăng Facebook thật qua "Đăng ngay"/lịch đã duyệt (cố ý không làm trên máy người dùng).
- Thêm/bỏ ảnh trong nháp qua giao diện (đã có unit test `replaceScheduleMedia` + `drafts.test`; UI chọn tệp cần hộp
  thoại hệ thống nên không tự động hoá).
