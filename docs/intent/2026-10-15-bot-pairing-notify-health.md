# Intent: Ghép nối bot một lệnh, thông báo chủ động, sức khoẻ tài khoản Facebook

Author: Claude (em), theo yêu cầu của Maiychrus. Status: approved (15/10/2026, trả lời phỏng vấn).

## Problem

MaiHub Control Protocol v1 (26.18.0) đã chạy với 2 cặp bot ↔ MaiHub:

- tg-claude-bot (`161.248.81.164`) điều khiển MaiHub `161.248.81.230`;
- tg-codex-bot (`161.248.81.38`) điều khiển MaiHub `161.248.81.202`.

Khi cài và dùng 2 cặp đó, lộ ra 3 vấn đề.

1. **Cài một cặp mất nhiều bước tay, dễ sai.** Phải:
   - sao chép dấu vân tay chứng chỉ, tạo khoá, gửi khoá qua chat;
   - sửa allow-list, chạy lệnh tường lửa;
   - nhờ người SSH vào VPS bot để chép `maihub_bridge.py`, ghi `.env` và đăng ký MCP.

   Lần cài thứ hai suýt dùng nhầm cổng RDP (`49152`) thay cho cổng MaiHub. API key và mật khẩu VPS đi qua chat nhiều lần. Mỗi người dùng sẽ có một cặp riêng, nên việc này lặp lại theo số người dùng.
2. **Bot không tự báo gì.** Bot chỉ biết tình hình khi người dùng hỏi. Lịch đăng lúc 3 giờ sáng lỗi, lỡ lịch, hay VPS Windows tắt thì đến sáng hôm sau mới phát hiện.
3. **Không biết trước tài khoản Facebook nào hỏng.**
   - Poster chỉ kiểm tra cookie `c_user`, và chỉ khi bắt đầu một lượt đăng.
   - Không nhận diện được checkpoint, không lưu kết quả kiểm tra, không có sự kiện nào báo ra ngoài.
   - Control API không trả trạng thái đăng nhập của profile.

## Proposed outcome

1. **Ghép nối bằng một lệnh.**
   - Trong MaiHub có nút "Ghép nối bot mới". Nút này thêm IP của bot vào allow-list, hiện lệnh tường lửa, và sinh **mã ghép nối dùng một lần** (hết hạn sau 15 phút).
   - Trên VPS bot, người dùng chạy một lệnh copy từ MaiHub. Lệnh này tải bridge (kiểm tra SHA-256), đổi mã lấy khoá thật qua kết nối đã ghim chứng chỉ, ghi `.env`, chạy `doctor`, đăng ký MCP cho Claude hoặc Codex, và cài service thông báo.
   - Khoá thật không bao giờ đi qua chat.
2. **Thông báo chủ động qua chính bot Telegram đó.** Một service trên VPS bot nghe sự kiện MaiHub rồi nhắn:
   - lượt đăng xong (1 dòng ngắn khi thành công hết; có lỗi thì kèm lý do);
   - lỡ lịch;
   - tài khoản Facebook hỏng;
   - MaiHub mất liên lạc quá 5 phút, và khi có lại.
3. **Sức khoẻ tài khoản Facebook.**
   - MaiHub phân loại từng profile: ổn, hết phiên đăng nhập, checkpoint.
   - Kiểm tra tự động mỗi ngày một lần (giờ đổi được, tắt được) và cập nhật sau mỗi lượt đăng. Bot hoặc người dùng gọi kiểm tra lúc nào cũng được.
   - Trạng thái hiện ở danh sách profile của Đăng Facebook và trong Control API. Khi một tài khoản chuyển sang hỏng thì phát sự kiện để thông báo.

## Affected users and systems

- Người dùng MaiHub có bot Telegram AI riêng (mẫu AHV trên VPS Linux).
- MaiHub, phần main process:
  - Control API: thêm `/v1/pair`, `/v1/bridge.py`, `profiles.check`, sự kiện mới;
  - Đăng Facebook: kiểm tra đăng nhập, lưu trạng thái, hẹn giờ hằng ngày.
- MaiHub, phần UI: tab "Điều khiển từ bot" và `ProfilePicker` của Đăng Facebook.
- `tools/maihub-bridge/maihub_bridge.py`: thêm lệnh `pair` và `watch`.
- VPS bot: thư mục `/opt/bot/maihub/` và một unit systemd cho `watch`.

## Constraints

- Giữ nguyên mọi bảo vệ của v1: allow-list đóng trước TLS, ghim chứng chỉ, khoá chỉ lưu dạng băm, khoá lỗi, audit, giới hạn tốc độ. Mã ghép nối không được mở thêm đường vào nào bỏ qua các bảo vệ này.
- Giao thức v1 chỉ được **thêm**: thêm thao tác, sự kiện, trường kết quả. Bot cũ vẫn chạy.
- Kiểm tra đăng nhập chỉ **tải trang**, không đăng, không bình luận, không tham gia nhóm. Kiểm thử dùng giả lập, không vào Facebook thật.
- Kiểm tra đăng nhập không được tranh profile với lượt đăng. Lịch đăng đến giờ trong lúc đang kiểm tra phải chờ như khi có việc khác chạy, không bị hỏng.
- Bridge vẫn chỉ dùng thư viện chuẩn Python ≥ 3.6.
- Không in API key hay token Telegram ra log hoặc màn hình.
- Không lưu mật khẩu hay token Telegram mới vào cấu hình MaiHub. Token Telegram ở yên trong `.env` của bot.

## Decisions (15/10/2026)

- Mã ghép nối là vé dùng một lần, hết hạn sau 15 phút, đổi lấy khoá qua `/v1/pair`.
- Kiểm tra tài khoản tự động mỗi ngày một lần (mặc định 07:00, đổi được, tắt được) và cập nhật sau mỗi lượt đăng.
- Lượt đăng thành công hết vẫn nhắn một dòng ngắn.

## Success criteria

- Một người không rành kỹ thuật tự ghép nối được một bot mới chỉ với: bấm nút trong MaiHub, chạy lệnh tường lửa, dán một lệnh vào VPS bot. Không cần gửi khoá hay dấu vân tay cho ai.
- Lịch đăng chạy xong thì Telegram nhận tin trong vòng 1 phút. Tắt MaiHub thì nhận cảnh báo sau khoảng 5 phút; bật lại thì nhận tin "đã kết nối lại".
- Profile hết phiên hoặc bị checkpoint được đánh dấu trong MaiHub và báo qua Telegram trước giờ đăng nếu kiểm tra hằng ngày phát hiện được.
- Không hồi quy: tg-claude-bot và tg-codex-bot đang chạy với `.env` cũ vẫn hoạt động; các thao tác v1 giữ nguyên.
