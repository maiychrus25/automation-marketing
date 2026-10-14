# Intent: Giao thức để bot AI điều khiển MaiHub

Author: Claude (em), theo yêu cầu của Maiychrus. Status: approved (14/10/2026, trả lời phỏng vấn).

## Problem

Mỗi người dùng có:

- **Một bot Telegram AI riêng**, chạy trên VPS Linux. Mẫu là máy `161.248.81.164`, thư mục `/opt/bot`. Bot là Claude/Codex CLI được bọc qua Telegram. Nó tự lo việc lên ý tưởng, soạn nội dung và tạo hình ảnh. Bot gọi công cụ qua CLI (`ahv-plan`, `ahv-send`…) và MCP server (`memory_mcp_server.py`, `wakeup_mcp_server.py`).
- **Một MaiHub**, chạy 24/7 trên VPS Windows. Đây là nơi có profile trình duyệt, tài khoản và lịch Đăng Facebook.

Bot hiện không có cách nào điều khiển MaiHub. Muốn đưa nội dung bot đã làm vào MaiHub (tạo nháp, gắn ảnh, chọn nhóm, hẹn giờ, đăng, xem kết quả), người dùng phải Remote Desktop vào VPS Windows và thao tác tay.

MaiHub chưa có giao diện lập trình nào cho một tác nhân bên ngoài dùng:

- `HttpRelayService` chỉ phục vụ nhân viên. Nó chặn `facebookPoster:*`.
- Cổng webhook `9888` và `9889` chỉ nghe `127.0.0.1` và chỉ để kích hoạt workflow.

## Proposed outcome

Có một **giao thức điều khiển MaiHub** (MaiHub Control Protocol) để bot AI gọi như một bộ công cụ:

1. **Phía MaiHub: một API điều khiển có xác thực.**
   - Gồm một danh sách thao tác cố định, có phiên bản, và mô tả máy đọc được: tên thao tác, tham số, kết quả, mã lỗi.
   - Mỗi thao tác đi qua đúng lớp service và các kiểm tra như khi người dùng thao tác trong app (`validateStartParams`, giới hạn nội dung, ảnh, số đích, chống chạy trùng).
2. **Phía bot: một MCP server `maihub`** cài cạnh bot, cấu hình bằng địa chỉ MaiHub và khoá truy cập.
   - Claude CLI của bot dùng được ngay các công cụ như `maihub_list_profiles` hay `maihub_create_draft`.
   - Có kèm CLI tương đương để thử tay và để dùng trong script.
3. **Tải tệp:** bot gửi ảnh hoặc video nó vừa tạo lên MaiHub để gắn vào bài.
4. **Sự kiện:** bot nhận lại kết quả các việc chạy lâu: đăng xong, bị huỷ, bị lỡ, lỗi kèm link bài. Bot có thể tự hỏi lại (poll), hoặc MaiHub đẩy sự kiện (spec sẽ chọn).

Thao tác giai đoạn 1 (spec chốt danh sách chính xác):

- **Đọc:**
  - trạng thái máy (phiên bản, nhân trình duyệt, scheduler, việc đang chạy);
  - profile trình duyệt, nhóm đã quét của mỗi profile;
  - nháp, lịch, lịch sử lượt chạy và kết quả.
- **Ghi:**
  - tạo, sửa, xoá nháp; gắn media;
  - duyệt nháp: hẹn một lần, định kỳ, đăng ngay;
  - sửa, xoá, bật/tắt lịch;
  - huỷ việc đang chạy (cơ chế hủy dừng ngay của 26.17.0);
  - quét lại nhóm của một profile.

## Affected users and systems

| Đối tượng | Ảnh hưởng |
|---|---|
| Người dùng (một bot + một MaiHub mỗi người) | Ra lệnh cho MaiHub bằng cách chat với bot; không cần Remote Desktop |
| Bot trên VPS Linux | Thêm MCP server/CLI `maihub` cùng cấu hình kết nối; không sửa lõi bot |
| MaiHub, tiến trình chính | Máy chủ API điều khiển mới; quản lý khoá truy cập; nhật ký thao tác |
| `src/services/facebookPoster/*`, `electron/ipc/facebookPosterIpc.ts` | Đưa logic tạo lịch và duyệt nháp (`readTiming`, `copyScheduleMedia`…) xuống tầng service để IPC và API dùng chung |
| `src/services/browser/*` | Đọc danh sách profile và trạng thái nhân trình duyệt |
| Giao diện Cài đặt MaiHub | Bật/tắt API, tạo và thu hồi khoá, xem nhật ký lệnh gần đây |
| Tài liệu | `SYSTEM_DOCUMENTATION.md`, tài liệu giao thức (cho người viết bot), hướng dẫn cài MCP server |

## Constraints

- **Mạng:** bot (VPS Linux) và MaiHub (VPS Windows) là hai máy khác nhau. Kết nối phải chạy được giữa hai VPS và luôn đi qua kênh mã hoá.
- **Bảo mật:**
  - Không có khoá thì không làm được gì. Khoá lưu mã hoá (`safeStorage`), thu hồi được, không bao giờ in ra log.
  - Không có thao tác chạy lệnh tuỳ ý. Mọi thao tác nằm trong danh sách cố định, kiểm tham số chặt.
  - Thao tác không hoàn tác được (đăng ngay, xoá) cần cờ xác nhận tường minh trong lời gọi.
  - Có nhật ký ai làm gì, lúc nào.
  - Mặc định tắt; chủ máy bật trong Cài đặt.
- Không chạy trong chế độ nhân viên (giống IPC Đăng Facebook).
- Không gửi dữ liệu ra ngoài ngoài phản hồi cho bot đã được cấp khoá.
- **Không hồi quy:** IPC Đăng Facebook, scheduler, hủy, relay nhân viên, webhook workflow giữ nguyên hành vi.
- **Ổn định giao thức:** có số phiên bản; thêm thao tác mới không làm hỏng bot cũ.
- Không đăng thật lên Facebook trong test tự động.
- Định danh tiếng Anh; thông báo lỗi trả cho bot bằng tiếng Việt kèm mã lỗi máy đọc được.
- **Quy trình:** intent → spec → plan → triển khai bằng subagent Sonnet; tài liệu đi cùng code; `check-docs` sạch.

## Decisions (14/10/2026)

1. Kết nối: VPS Windows có IP công khai → MaiHub mở cổng HTTPS có khoá, chỉ nhận từ IP được phép (VPS bot).
2. Phạm vi giai đoạn 1: Đăng Facebook + profile trình duyệt + trạng thái máy. Zalo/CRM, hộp thư Page, Workflow để sau.
3. Phía bot: MCP server + CLI, Python stdlib.

## Open questions (spec quyết)

4. Sự kiện: bot tự hỏi lại kết quả hay MaiHub đẩy sự kiện tới bot?
5. Một MaiHub nhận lệnh từ nhiều bot/khoá không?
6. Về sau có cần CMS `bot.ahvclaw.com` tự cài MCP server và cấp khoá không?
