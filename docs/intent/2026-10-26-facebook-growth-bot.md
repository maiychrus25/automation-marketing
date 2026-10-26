# Intent: Bot AI tự tìm nội dung hot, bình luận và tương tác để kéo khách về Page Facebook

Author: Claude (em), phỏng vấn Maiychrus ngày 26/10/2026. Status: approved (26/10/2026).

## Problem

Anh bán hàng qua 1–3 Page Facebook. Mục tiêu là vừa có khách, vừa phát triển kênh, nhưng **ưu tiên bán hàng**: tương tác chỉ là phương tiện, đích cuối là khách tiềm năng và tin nhắn hỏi mua.

Hiện mọi việc kéo tương tác vẫn làm tay:

- **Chọn nội dung theo cảm tính.** Nghiên cứu chủ đề (26.20.0) đã quét được bài, nhóm và Page theo từ khoá, nhưng chưa có ai biến kết quả đó thành bài đề xuất hằng ngày.
- **Không có bình luận ở bài của người khác.** MaiHub chỉ bình luận đầu trên bài của chính mình (`firstComment.ts`) và thu bình luận để tìm khách. Chưa có thao tác nào bình luận vào bài hot của người khác để kéo người đọc về Page.
- **Không có tương tác cho Page.** Chưa có thao tác nào để các profile like, bình luận, chia sẻ bài của Page, mời người like Page, hay nuôi profile cho giống người thật.

> **Ghi chú 26/10/2026 (khi thiết kế tính năng 1):** người dùng thật là **khách dùng MaiHub**: không rành kỹ thuật, chỉ nhắn tin với bot Telegram, không cấu hình gì và không mở app để duyệt. Bot phải tự biết từng Page về gì (ví dụ một Page dạy lái xe, một Page bán quần áo) và tự làm việc. Spec: `docs/specs/2026-10-26-daily-post-suggestions.md`.

Anh đang có 10–30 browser profile. Mỗi profile là một tài khoản Facebook cá nhân đã đăng nhập sẵn, nhưng hiện chỉ dùng để đăng bài, quét và thu bình luận.

## Proposed outcome

**Bot AI trên VPS là bộ não**, giống mô hình hiện tại: bot chọn bài, viết nội dung, xếp lịch, rồi gọi Control API qua bridge MCP. MaiHub chỉ thêm **thao tác mới** và **giữ các giới hạn an toàn**.

Làm theo thứ tự **1 → 3 → 2**. Mỗi tính năng có spec, plan và bản phát hành riêng.

### 1. Đề xuất bài đăng hằng ngày theo nội dung hot (làm trước)

- **Chỉ dùng nguồn Facebook.** Bot dùng lại Nghiên cứu chủ đề (`research.search`, `research.scanGroupFeeds`) và xếp bài theo mức tương tác tăng nhanh giữa các lần quét.
- **Mỗi ngày bot tạo bản nháp** cho Page: nội dung, có thể kèm ảnh hoặc video từ Video Studio. Bot báo anh qua Telegram (`watch`).
- **Anh duyệt rồi mới đăng.** Luồng nháp → Duyệt → đăng ngay hoặc hẹn giờ đã có sẵn; bot không tự đăng bài lên Page.

### 3. Tương tác cho Page và nuôi profile (làm thứ hai)

Các profile được chọn tự động làm 4 việc:

- like, thả cảm xúc, bình luận, chia sẻ bài mới của Page;
- chia sẻ bài của Page vào các nhóm profile đã tham gia;
- mời người like hoặc theo dõi Page;
- **nuôi profile**: lướt, xem, like ngẫu nhiên theo chủ đề để profile giống người thật. Việc này cũng giảm nguy cơ bị khoá khi làm tính năng 2.

### 2. Bình luận vào bài hot của người khác (làm sau cùng, rủi ro nhất)

- **Tự động hoàn toàn** (anh chọn): bot tự chọn bài, tự viết bình luận riêng cho từng bài, tự đăng bằng các profile cá nhân. Không cần anh duyệt từng bình luận hay từng lô.
- **Phạm vi:** bài hot trong các nhóm profile đã tham gia, bài công khai tìm theo từ khoá, và bài của danh sách Page đối thủ hoặc Page cùng ngách do anh chỉ định.
- **Nội dung:** bot được bình luận về sản phẩm của anh, hoặc giải đáp thắc mắc ở các chủ đề khác để kéo người đọc về Page.

### Đo thành công sau 1–2 tuần

So trước và sau khi bật:

- số khách tiềm năng và tin nhắn hỏi mua (Leads và Hộp thư Page đã có);
- tương tác trung bình mỗi bài của Page (`posts.stats` đã đo);
- số người theo dõi Page theo ngày (**chưa đo, cần thêm**);
- số profile bị checkpoint hoặc khoá. Con số này phải thấp, vì đây là thước đo an toàn của tính năng 2 và 3.

## Affected users and systems

**Người dùng**
- Anh (chủ Page): duyệt nháp, cấu hình giới hạn, theo dõi kết quả.
- Bot AI trên VPS: gọi thao tác mới.
- Người đọc trên Facebook: thấy bình luận, chia sẻ và lời mời từ các profile.

**Hệ thống**

| Hệ thống | Vị trí | Thay đổi |
|---|---|---|
| Control API | `src/services/control/` (`ControlMethods.ts`, sự kiện), `docs/protocol/maihub-control-protocol.md` | Thêm thao tác bình luận bài người khác, cảm xúc, chia sẻ, mời like Page, nuôi profile, và các sự kiện kết quả |
| Bridge | `tools/maihub-bridge/maihub_bridge.py` | Tool sinh tự động từ `describe`; cập nhật hướng dẫn `maihub_guide` |
| Đăng Facebook | `src/services/facebookPoster/` | Dùng chung khoá một việc (`acquireExclusive`), lịch, nháp, `PostTracker`, `CommentCollector`, `LeadDetector`. `firstComment.ts` là nền để viết bình luận vào bài người khác |
| Nghiên cứu chủ đề | `src/services/research/` | Nguồn bài hot; xoay vòng profile qua `profileRotation.ts` |
| Browser Profiles | `src/services/browser/` | `openForAutomation`; tối đa 30 profile mở cùng lúc |
| Video Studio | `src/services/video/` | Ảnh và video cho bài đề xuất (tuỳ chọn) |
| Telegram `watch` | | Báo nháp mới, báo profile bị checkpoint |
| Tài liệu | `SYSTEM_DOCUMENTATION.md` (thêm mục module mới, dấu `docs-check` cho các giới hạn), README | Cập nhật |

## Constraints

- **Chỉ thêm vào Control API:** thao tác và sự kiện mới; không đổi hay bỏ trường cũ. Bot cũ và bridge cũ vẫn chạy được.
- **MaiHub giữ giới hạn an toàn, không phải bot.** Vì tính năng 2 và 3 chạy tự động hoàn toàn, MaiHub phải tự chặn ngay cả khi bot gọi sai:
  - trần số hành động mỗi profile mỗi ngày, theo từng loại (bình luận, cảm xúc, chia sẻ, mời);
  - khoảng nghỉ ngẫu nhiên giữa các hành động;
  - giờ hoạt động trong ngày;
  - không lặp lại bình luận trên cùng một bài, không bình luận trùng nội dung giữa các profile;
  - **dừng profile ngay khi gặp checkpoint, chặn tạm thời hoặc hết phiên**, rồi báo Telegram;
  - **có nút dừng khẩn cấp** để tắt toàn bộ hành động tự động, cả trong app lẫn qua API;
  - có danh sách loại trừ cho các profile quan trọng.
- **Không tranh profile với việc đăng bài.** Hành động tương tác phải đi qua khoá việc chung, nhường lịch đăng sắp đến giờ, và không dùng profile đang bận. Khảo sát ngày 26/10/2026 phát hiện Nghiên cứu chủ đề mở profile mà không giữ khoá, làm lịch đăng thất bại. Không được lặp lại lỗi này.
- **Profile chỉ hành động trong phạm vi của nó:** bình luận và chia sẻ trong nhóm chỉ dùng profile đã là thành viên nhóm đó.
- **Trần 30 profile mở cùng lúc** của `BrowserProfileService`. Với 10–30 profile thì phải xoay vòng, không mở hết một lần.
- **Quy mô:** 10–30 profile, 1–3 Page. Không thiết kế cho quy mô lớn hơn.
- **Dữ liệu cá nhân:** không thu danh sách người bình luận hay người thả cảm xúc ngoài phạm vi Leads đã có. Giữ chính sách xoá sau 180 ngày (Nghị định 13/2023) như Nghiên cứu chủ đề.
- **Test:** dùng dữ liệu mẫu và trình duyệt giả lập, không gọi Facebook thật. Mọi lần thử trên Facebook thật cần anh cho phép trước.
- **Quy trình repo:** làm trên dev trước, tài liệu đi cùng code trong cùng commit, `node scripts/check-docs.js` phải sạch.

## Open questions

1. **Giới hạn cụ thể là bao nhiêu?** Ví dụ số bình luận, cảm xúc, chia sẻ, lời mời mỗi profile mỗi ngày, khoảng nghỉ và giờ hoạt động. Ai chốt con số mặc định: anh đặt, hay spec đề xuất rồi anh duyệt?
2. **Bình luận có được gắn link hoặc tag Page không?** Câu trả lời ngày 26/10 cho phép nhắc sản phẩm nhưng chưa nói tới link. Link giúp kéo khách trực tiếp nhưng dễ bị Facebook đánh dấu spam và ẩn bình luận nhất.
3. **Rủi ro tài khoản và pháp lý (anh cần quyết rõ):** nhiều profile cá nhân bình luận khen sản phẩm hoặc tương tác bài Page theo kịch bản là hành vi Facebook cấm (tương tác không chân thực, spam). Hậu quả có thể là khoá profile, giảm hiển thị hoặc hạn chế cả Page.
   - Ở Việt Nam, quảng cáo trá hình hoặc đánh giá không trung thực về sản phẩm có thể vi phạm Luật Quảng cáo và Luật Bảo vệ quyền lợi người tiêu dùng 2023.
   - Có cần quy tắc bắt buộc, ví dụ bình luận nhắc sản phẩm phải ghi rõ là người của shop?
4. **Mời người like Page bằng cách nào?** Facebook chỉ cho mời trong một số điều kiện: là bạn bè, hoặc người đã tương tác bài Page, và thường phải từ vai trò quản trị Page. Cần bước thử thật chỉ đọc để xác nhận profile cá nhân làm được tới đâu.
5. **Nuôi profile chạy lúc nào?** Theo lịch cố định do MaiHub chạy, hay để bot gọi? Đã chọn bot là bộ não, nhưng việc đều đặn có thể cần lịch riêng khi bot không chạy.
6. **Đo người theo dõi Page:** hiện chưa có. Lấy từ trang Page qua profile quản trị hay từ Business Suite?
7. **Tính năng 1 dùng nguồn nào cho mỗi Page?** Từ khoá và nhóm nguồn cấu hình riêng cho từng Page, hay dùng chung một bộ?
8. **Danh sách Page đối thủ:** anh nhập tay, hay bot tự gợi ý từ kết quả `research.search` loại Page rồi anh duyệt?
9. **Bot không chạy thì sao?** Khi bot trên VPS mất kết nối, các hành động đã xếp lịch có tiếp tục không, hay dừng hết?
