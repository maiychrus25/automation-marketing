# Handoff: GĐ1 — Làm lại UI trang Đăng Facebook của MaiHub giống Postiz

Bạn đang ở worktree `/home/maiychrus/deplao-builder-poster-ui`, nhánh `feat/poster-postiz-ui`.
Chỉ sửa trong worktree này. Không commit, không push — để operator review.

## Mục tiêu
Làm lại giao diện trang **Đăng Facebook** (`src/ui/features/facebookPoster/`) để **giống Postiz nhất có thể**
về bố cục, cảm giác, khoảng cách, màu, font, calendar. Operator đã nói rõ: "bê nguyên giao diện Postiz sang,
chỗ nào MaiHub cần thêm thì thêm vào UI theo phong cách Postiz".

## Tham chiếu BẮT BUỘC — đọc trước khi code
Source Postiz thật ở `/home/maiychrus/Projects/postiz-app` (Next.js + Tailwind). Đọc kỹ để tái tạo đúng giao diện:
- `apps/frontend/src/components/new-layout/layout.component.tsx` — chrome: rail icon trái 80px, panel bo tròn,
  top bar 80px (Title + cụm icon phải), các khối cách nhau 1px trên nền `newBgLineColor`.
- `apps/frontend/src/components/launches/launches.component.tsx` — trang calendar: panel **Channels 260px**
  (Add Channel, Add post, danh sách kênh avatar 36px + badge nền tảng, nhóm theo customer, thu gọn được)
  + panel calendar (Filters + Calendar).
- `apps/frontend/src/components/launches/calendar.tsx`, `filters.tsx`, `calendar.context.tsx` — lưới giờ
  tuần/ngày/tháng, now-line, cách render post trong ô, preview.
- `apps/frontend/src/components/new-launch/` — modal soạn bài (editor + preview theo nền tảng).
- `apps/frontend/tailwind.config.cjs`, `src/app/global.scss` + biến CSS (`--new-bgColor`, `--new-bgColorInner`,
  `--new-bgLineColor`, `--new-btn-primary #612bd3`, `--new-table-text-focused #fc69ff`...) cho cả dark/light.
- Font: Plus Jakarta Sans.

Nếu chạy được, có thể chạy Postiz frontend để xem trực tiếp; nếu không, dựa vào source.

Mockup tham khảo (của Claude, operator CHƯA hài lòng vì vẫn khác Postiz): `docs/intent/poster-gd1-mockup.html`.
Bối cảnh + ràng buộc: `docs/intent/intent.md`. Hệ thiết kế MaiHub: `DESIGN.md`.

## Phạm vi GĐ1
1. Thay khung 5 tab ngang (`FacebookPosterView.tsx`) bằng bố cục kiểu Postiz:
   rail điều hướng (Lịch đăng / Tham gia nhóm / Thu bình luận / Lịch sử) + panel Kênh + panel Calendar.
2. **Calendar** giống Postiz: tuần (lưới giờ) / ngày / tháng, now-line, hiện bài từ dữ liệu lịch hiện có
   (`fb_poster_schedules` qua IPC sẵn có), kéo-thả đổi giờ nếu làm được với API cập nhật lịch hiện có.
3. **Panel Kênh**: kênh = profile antidetect (Facebook). Nút "Thêm kênh" (sau này thêm nền tảng khác —
   thiết kế không hard-code Facebook), nút "Soạn bài".
4. **Modal soạn bài** giống Postiz: editor trái + xem trước kiểu Facebook phải; giữ chọn profile, đích
   (nhóm/Trang), nội dung, ảnh (kéo-thả), **bình luận đầu**, đăng ngay / hẹn giờ.
5. Đưa các màn **Tham gia nhóm, Thu bình luận, Lịch sử** vào khung mới, restyle theo Postiz, giữ nguyên chức năng.

## Ràng buộc
- **BỎ hẳn AI** khỏi trang này: không viết bài / trau chuốt / tạo ảnh AI (gỡ `AIAssistPanel` khỏi luồng soạn bài).
- **Không regress**: mọi chức năng đang chạy (đăng nhóm/Trang, lên lịch, tham gia nhóm, thu bình luận,
  bình luận đầu, lịch sử, chọn profile, RunPanel tiến độ) phải còn chạy. Chỉ đổi UI, dùng lại IPC/backend hiện có.
- **Không copy code Postiz** (license AGPL-3.0): đọc để hiểu bố cục/kích thước/màu, rồi tự viết lại trong
  kiến trúc MaiHub (React + Tailwind của repo này). Không dùng logo/asset của Postiz; dùng branding MaiHub.
- Dark + light đều phải đẹp và nhất quán; không tràn ngang trang; responsive (sẵn sàng mobile).
- Màu Postiz: thêm thành token trong `src/ui/index.css` + `tailwind.config.js` (đừng rải hex trong component),
  có thể scope riêng cho màn này nếu cần.
- Định danh code bằng tiếng Anh; chữ hiển thị tiếng Việt.
- Máy dev 16 GB: chạy `tsc`/`jest`/build **từng cái một**, không song song.

## Kiểm tra trước khi báo xong
- `npx tsc -p tsconfig.electron.json --noEmit` và `npx tsc -p tsconfig.json --noEmit` sạch.
- `npx jest src/__tests__/facebookPoster` (bỏ qua 3 suite lỗi sẵn do better-sqlite3 NODE_MODULE_VERSION).
- `npx vite build` thành công.
- Liệt kê file đã sửa/tạo + những gì chưa làm được.
