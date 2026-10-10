# Intent: Làm lại giao diện trang đăng Facebook của MaiHub theo phong cách Postiz

Author: maiychrus (operator). Status: approved.

## Problem

Trang Facebook Poster hiện tại (`FacebookPosterView`) tổ chức theo **5 tab rời rạc theo tác vụ** —
Đăng bài · Lịch đăng · Tham gia nhóm · Bình luận · Lịch sử. Hạn chế:

- Không có cái nhìn **tổng thể lịch đăng** (calendar) — khó biết tuần này đã/ sẽ đăng gì, ở đâu.
- Tab "Đăng bài" soạn nội dung nhưng **không xem trước bài giống giao diện Facebook thật**, khó
  hình dung thành phẩm.
- Thiếu luồng **nháp → duyệt → đăng/hẹn giờ** rõ ràng; soạn và đăng bị dồn vào một chỗ.
- Thẩm mỹ và trải nghiệm chưa bằng các công cụ hiện đại (Postiz), trong khi anh muốn vận hành
  sản xuất nội dung theo tuần một cách trực quan, chuyên nghiệp.

Anh muốn làm lại **toàn bộ** trang đăng Facebook theo phong cách Postiz: vừa đẹp hơn, vừa đổi
bố cục + luồng sang kiểu Postiz, **lấy mọi yếu tố** (calendar kéo-thả, sidebar điều hướng, xem
trước bài kiểu Facebook, luồng draft → duyệt → đăng).

## Proposed outcome

Thiết kế lại trọn vẹn trang đăng Facebook của MaiHub lấy cảm hứng từ Postiz:

- **Calendar là trung tâm**: xem lịch đăng theo tuần/tháng, kéo-thả để dời bài, bấm ô ngày để soạn.
- **Sidebar điều hướng** gom các khu vực thay cho 5 tab ngang.
- **Soạn bài có xem trước** giống giao diện Facebook (bài nhóm/Trang), hiển thị ảnh + nội dung + bình luận đầu.
- **Luồng draft → duyệt → đăng/hẹn giờ** rõ ràng: nội dung (kể cả do AI sinh) đổ về **bản nháp**
  trên lịch, anh xem/sửa/duyệt rồi mới đăng hoặc hẹn giờ (khớp lựa chọn "duyệt trước khi đăng").
- **Thêm trạng thái draft thật ở backend** (DB), không chỉ là trạng thái tạm ở giao diện.
- **Giữ các chức năng đặc thù của MaiHub**, sắp xếp lại vào UI mới: đăng vào **nhiều nhóm**,
  **tham gia/tìm nhóm**, **thu bình luận**, **bình luận đầu**, **chọn profile antidetect**, **lịch sử**.
- **BỎ hẳn Trợ Lý AI** khỏi trang đăng: không còn **viết bài / trau chuốt / tạo ảnh AI** (gỡ `AIAssistPanel`
  khỏi luồng soạn bài). Người dùng tự soạn nội dung + tự chọn ảnh.
- **Giao diện bám sát phong cách Postiz** (yêu cầu rõ của anh — ưu tiên hơn style MaiHub mặc định cho
  trang này): cảm giác hiện đại, thoáng, calendar đẹp, avatar kênh nổi bật; vẫn giữ **dark/light** + responsive.
- Giao diện **đẹp, nhất quán dark/light**, **responsive** — chạy tốt trên desktop Electron hiện tại và
  sẵn sàng cho **bản app mobile trong tương lai**.
- **Kiến trúc & dữ liệu đa-nền-tảng-sẵn-sàng**: hiện chỉ làm Facebook, nhưng mô hình **"kênh / nền tảng"
  tổng quát** (kiểu provider registry của Postiz) để **sau thêm Instagram / LinkedIn / X / TikTok...**
  mà không phải đập đi làm lại khung UI hay dữ liệu.
- Triển khai theo **kế hoạch tổng thể, chia thành 2 giai đoạn**:
  - **GĐ1 — Redesign UI (frontend, dùng lại backend hiện có):** bố cục **sidebar** đa-nền-tảng thay 5 tab,
    **soạn bài có xem trước kiểu Facebook**, **Calendar** xem lịch tuần/tháng + kéo-thả đổi giờ. Mọi
    chức năng đặc thù (nhóm / tham gia / thu bình luận / lịch sử / Trợ Lý AI) được sắp vào khung mới.
  - **GĐ2 — Draft state + luồng duyệt + hoàn thiện:** thêm **trạng thái draft thật** (mở rộng bảng
    `fb_poster_schedules`), luồng **nháp → duyệt → đăng/hẹn giờ**, và chuẩn hoá responsive/mobile-ready.

## Affected users and systems

**Người dùng:**
- Operator (anh) và **nhân viên**.
- Nền tảng chính: **app MaiHub desktop (Electron)**; định hướng **app mobile về sau** → UI cần responsive
  và component tái dùng được.

**Hệ thống / mã nguồn bị ảnh hưởng (frontend `src/ui/features/facebookPoster/`):**
- `FacebookPosterView.tsx` (khung 5 tab — sẽ đổi sang bố cục sidebar + calendar).
- `PostTab.tsx`, `ScheduleTab.tsx`, `JoinTab.tsx`, `CommentsTab.tsx`, `HistoryTab.tsx`.
- `AIAssistPanel.tsx`, `MediaPicker.tsx`, `ProfilePicker.tsx`, `ScheduleDialog.tsx`, `RunPanel.tsx`.
- Cần component mới: Calendar view, Post preview (kiểu Facebook), Sidebar, Draft board.

**Backend / dữ liệu:**
- Scheduler và automation hiện có: `FacebookPosterScheduler`, `postToTargets` (đăng nhóm/Trang bằng
  browser automation), `FacebookPosterService`/`Store`.
- Bảng `fb_poster_schedules` / `fb_poster_runs` / `fb_poster_results` — **cần bổ sung trạng thái draft**
  (và ánh xạ draft → scheduled → posted).
- IPC liên quan (`facebookPosterIpc`, `browserProfileIpc`, `aiAssistantIpc`).

**Ràng buộc kỹ thuật nền tảng (không đổi):**
- Vẫn **đăng bằng browser automation** vì mục tiêu là **nhóm** — Graph API của Meta **không đăng được
  nhóm, không join nhóm, không scan nhóm**. Calendar/flow mới phải khớp với backend automation hiện có.

**Tài liệu:**
- `DESIGN.md` (đã có ở gốc repo) — nguồn chân lý về thị giác, phải tuân theo khi thiết kế.

## Constraints

- **Không bỏ chức năng nào**; **không regress** chức năng đang chạy (rule #11) — mọi tính năng hiện có
  phải còn hoạt động sau khi đổi UI.
- **Dev-first**: làm ở dev → test dev → build artifact → deploy; không sửa thẳng production.
- **UI**: nhất quán **dark/light**, **không tràn ngang trang**, **không đè chữ**, thao tác chính mượt,
  có trạng thái empty/loading/error; **responsive** (sẵn sàng mobile).
- Bám **DESIGN.md** + Design Rules; **định danh code bằng tiếng Anh** (copy user-facing tiếng Việt ổn).
- **Giữ browser automation** cho đăng nhóm/join/scan (không thay bằng API).
- **Đa-nền-tảng-sẵn-sàng**: không hard-code Facebook vào khung UI và mô hình "kênh"; Facebook là
  **provider đầu tiên**, các nền tảng khác thêm sau theo cùng abstraction (không đập đi làm lại).
- **Draft state** triển khai bằng cách **mở rộng bảng `fb_poster_schedules`** (thêm trạng thái `draft`),
  không tạo bảng mới — tránh di trú dữ liệu lớn.
- **Không copy code Postiz** — license AGPL-3.0; chỉ học **pattern/UX**, tự viết lại trong kiến trúc MaiHub.
- Triển khai **theo giai đoạn**: có kế hoạch tổng, rồi làm & kiểm thử từng giai đoạn độc lập.
- Mỗi giai đoạn phải qua **stress test desktop + mobile width, dark + light** trước khi coi là xong.

## Open questions

Đã chốt: **2 giai đoạn** (xem Proposed outcome); **draft = mở rộng `fb_poster_schedules`**;
**thiết kế đa-nền-tảng-sẵn-sàng** (Facebook là provider đầu tiên). Còn lại:

- **Mô hình "kênh" đa nền tảng**: trừu tượng hoá thế nào để Facebook chạy ngay mà sau thêm nền tảng khác
  không phải đập đi? Với Facebook: một "kênh" = **profile antidetect + nền tảng Facebook**, còn **nhóm/Trang**
  là **đích** của bài. Các nền tảng sau (IG/LinkedIn/X...) có thể dùng token/API thay vì browser — abstraction
  cần tách **"soạn/preview/lịch"** (chung) khỏi **"cách đăng"** (theo provider).
- **Calendar hiển thị thế nào** khi có **nhiều profile/kênh** và mỗi bài đăng vào **nhiều đích (nhóm)**:
  gom theo kênh, theo ngày, hay theo "chiến dịch/đợt"?
- **Mức độ giống thật của preview**: bài **nhóm** vs **Trang** hiển thị khác nhau — cần giống tới đâu? Sau này
  mỗi nền tảng có preview riêng — khung preview nên theo provider.
- **Bản mobile tương lai**: dùng **chung codebase React (responsive)** hay tách riêng (vd React Native)?
  Ảnh hưởng mức tái dùng component khi thiết kế bây giờ.
- **Thu bình luận / lịch sử**: giữ dạng bảng như hiện tại hay tích hợp vào calendar/preview?
