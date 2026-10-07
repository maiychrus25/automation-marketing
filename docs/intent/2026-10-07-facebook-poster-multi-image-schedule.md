# Intent: Đăng Facebook — nhiều ảnh trong một bài và lên lịch đăng
Author: maiychrus. Status: draft.

## Problem

Tính năng Đăng Facebook của MaiHub (từ 26.10.0, `docs/intent/2026-10-02-facebook-poster.md`) đăng một bài lên nhiều nhóm hoặc Page qua nhiều browser profile. Hai giới hạn đang làm người dùng phải thao tác tay:

1. **Một bài chỉ đính kèm được một tệp.** Tab Đăng bài chỉ chọn được một ảnh hoặc một video (`facebookPoster:pickMedia` mở hộp chọn một tệp; `postToTargets` gọi `setInputFiles` với một đường dẫn). Bài tuyển dụng, bài bán hàng thường cần nhiều ảnh, nên người dùng phải ghép ảnh trước hoặc đăng tay.
2. **Chỉ chạy khi bấm "Bắt đầu đăng".** Không đặt được giờ đăng, không lặp lại theo ngày/tuần, không xếp sẵn nhiều bài. Muốn đăng vào giờ vàng (sáng sớm, tối) thì người dùng phải ngồi máy đúng giờ. MaiHub đã có bộ hẹn giờ cron trong Workflow (`trigger.schedule`, `node-cron`), nhưng Workflow chưa có bước Đăng Facebook.

## Proposed outcome

### Đợt 1 — Nhiều ảnh trong một bài

- Chọn **tối đa 10 ảnh** cho một bài (`jpg`, `jpeg`, `png`, `gif`, `webp`). Không trộn ảnh với video trong cùng một bài; một bài vẫn có thể có đúng **một video** như hiện nay.
- Xem trước dạng lưới ảnh nhỏ, đổi thứ tự, bỏ từng ảnh.
- Cùng bộ ảnh cho mọi profile và mọi nhóm trong một lượt, ở cả chế độ Nhóm và Page.
- Bằng chứng đăng xong giữ nguyên quy tắc "chỉ tin bằng chứng dương" hiện có; thêm điều kiện: mọi ảnh đã tải lên xong trước khi bấm Đăng.

### Đợt 2 — Lên lịch đăng trong màn Đăng Facebook

- Nút **"Lên lịch"** cạnh "Bắt đầu đăng" trong tab Đăng bài, và một tab mới **"Lịch đăng"** để xem, sửa, tạm dừng, xoá lịch.
- Ba kiểu lịch:
  - **Một lần:** một bài, một ngày giờ.
  - **Lặp lại:** cùng một bài, theo ngày hoặc theo thứ trong tuần, vào giờ cố định.
  - **Hàng đợi:** nhiều bài khác nhau, mỗi bài một giờ chạy riêng.
- Mỗi lịch chụp lại toàn bộ tham số của một lượt đăng như hiện nay: chế độ Nhóm/Page, nội dung, ảnh, bình luận đầu tiên, các profile và **danh sách nhóm cố định chọn lúc đặt lịch**, thời gian nghỉ, số profile song song, khoảng lệch giờ giữa các profile.
- Chỉ lên lịch được việc **đăng bài** (Nhóm và Page). Quét nhóm, xin vào nhóm, thu bình luận vẫn chạy tay.
- Đến giờ mà đang có việc khác chạy: **xếp hàng chờ**, chạy ngay khi việc trước xong. Chờ quá giới hạn thì bỏ lượt và báo.
- Đến giờ mà app đang tắt hoặc máy đang ngủ: **bỏ lượt và báo**. Lần mở app sau, các lượt đã lỡ được ghi vào lịch sử với trạng thái "đã lỡ" và người dùng được thông báo.
- Mỗi lượt chạy theo lịch tạo một run bình thường, xem được ở tab Lịch sử, ghi rõ chạy từ lịch nào.

### Đợt 3 — Bước Đăng Facebook trong Workflow

- Thêm bước "Đăng Facebook" vào trình soạn Workflow, dùng được với `trigger.schedule` (và các trigger khác như webhook).
- Bước này nhận cùng bộ tham số với một lịch đăng của đợt 2 và chạy qua cùng một cơ chế xếp hàng.

### Tiêu chí nghiệm thu

1. Đăng một bài 10 ảnh lên một nhóm thử và một Page thử: bài lên đủ 10 ảnh, đúng thứ tự đã chọn.
2. Một lịch "một lần" đặt trước 5 phút chạy đúng giờ, kết quả có trong Lịch sử và gắn với lịch đó.
3. Một lịch lặp lại hằng ngày chạy hai ngày liên tiếp.
4. Tắt app qua giờ hẹn rồi mở lại: lượt đó ghi "đã lỡ" và có thông báo; không tự đăng bù.
5. Đến giờ hẹn trong lúc đang có việc chạy: lượt theo lịch chạy ngay sau khi việc đó xong.
6. Mọi tính năng đang có của Đăng Facebook (đăng tay, quét nhóm, xin vào nhóm, thu bình luận, lịch sử, CSV) và Browser Profiles không đổi hành vi.

## Affected users and systems

### Người dùng

- **Boss/Standalone:** người dùng duy nhất của cả ba đợt, như tính năng Đăng Facebook hiện nay.
- **Employee:** chưa dùng được; phụ thuộc phân quyền module chưa làm.

### Hệ thống trong MaiHub

| Thành phần | Ảnh hưởng |
|---|---|
| `src/services/facebookPoster/postToTargets.ts` | Nhận danh sách ảnh; đợi tải lên xong trước khi bấm Đăng |
| `src/services/facebookPoster/validateStartParams.ts` | Kiểm tối đa 10 ảnh, đúng đuôi, không trộn video |
| `electron/ipc/facebookPosterIpc.ts` | Hộp chọn nhiều tệp; IPC cho lịch (tạo, sửa, tạm dừng, xoá, liệt kê) |
| `src/ui/features/facebookPoster/PostTab.tsx` | Lưới ảnh, nút Lên lịch; tab mới Lịch đăng |
| `FacebookPosterService` | Nhận việc từ lịch qua hàng chờ; ghi run gắn với lịch |
| `FacebookPosterStore` + schema | Bảng lịch đăng, bảng lượt chạy theo lịch (kể cả "đã lỡ") |
| Bộ hẹn giờ trong main process | Đặt và huỷ hẹn giờ khi app mở; dò lượt đã lỡ khi khởi động; hẹn lại khi đổi workspace |
| `WorkflowEngineService` (đợt 3) | Bước Đăng Facebook mới |
| Lưu trữ tệp theo workspace | Nơi giữ bản sao ảnh của lịch đăng |
| `SYSTEM_DOCUMENTATION.md`, `README.md` | Mô tả hai tính năng |

### Hệ thống bên ngoài

- Facebook: hộp soạn bài trong nhóm (dialog) và Page (`/post/create`) phải nhận nhiều tệp qua `input[type=file]`; giao diện thay đổi thường xuyên.

## Constraints

- **App desktop, không có máy chủ.** Lịch chỉ chạy khi MaiHub đang mở và máy không ngủ. Lỡ giờ thì bỏ lượt, không đăng bù.
- **Một việc một lúc.** Giữ nguyên quy tắc này; lịch đi qua hàng chờ, không chạy song song với việc khác.
- **Tối đa 10 ảnh, không trộn video.**
- **Danh sách nhóm của lịch cố định lúc đặt.** Profile hoặc nhóm bị xoá sau đó thì các đích đó ghi `failed`, không tự thay thế.
- **Không đăng thật khi kiểm thử** nếu chưa được phép; thử khô dừng trước khi bấm Đăng.
- **Quy tắc dự án (`AGENTS.md`):** identifier tiếng Anh; thay đổi nhỏ nhất an toàn; tái dùng pattern có sẵn; không regress; không đẩy lên, không deploy khi chưa được duyệt; chạy build, test, lint và dán kết quả trước khi báo xong; tệp tạm để ngoài kho.
- **Chính sách nền tảng:** đăng cùng một nội dung lặp lại theo lịch bằng nhiều tài khoản dễ bị Facebook coi là spam và hạn chế tài khoản.

## Open questions

1. **Facebook có nhận 10 ảnh qua một lần `setInputFiles` không**, trong cả dialog nhóm và trang `/post/create` của Page? Thứ tự ảnh có giữ đúng không, và bằng chứng nào cho biết mọi ảnh đã tải lên xong? Cần một spike đo trên trang thật trước khi chốt thiết kế đợt 1.
2. **Ảnh của lịch đăng lưu ở đâu?** Đề xuất chép vào thư mục dữ liệu của workspace lúc đặt lịch, để người dùng xoá hay đổi tên tệp gốc không làm hỏng lịch; cần chốt khi nào thì xoá bản sao.
3. **Giới hạn chờ trong hàng đợi** là bao lâu trước khi bỏ lượt? (Gợi ý 2 giờ.)
4. **Lịch lặp lại nhập theo kiểu nào:** chọn ngày trong tuần và giờ, hay cho nhập biểu thức cron? Giờ theo múi giờ của máy hay cố định `Asia/Ho_Chi_Minh`?
5. **Báo "đã lỡ" bằng cách nào:** thẻ thông báo khi mở app, mục trong Trung tâm thông báo, hay chỉ một dòng trong Lịch sử?
6. **Có giữ máy không ngủ khi còn lịch sắp chạy không** (`powerSaveBlocker` của Electron)? Đổi lại máy tốn điện hơn.
7. **Lịch lặp lại đăng cùng một nội dung:** có cần cảnh báo hoặc giới hạn tần suất để giảm rủi ro bị coi là spam không?
8. **Đợt 3, bước Workflow nhận nội dung và ảnh từ đâu:** nhập cố định trong bước, hay lấy từ biến của các bước trước?
9. **Đổi workspace:** lịch thuộc từng workspace (theo DB) — khi đổi workspace thì hẹn giờ của workspace cũ dừng và của workspace mới được nạp; cần xác nhận đây là hành vi mong muốn.
10. **Tổng dung lượng ảnh tối đa** cho một bài là bao nhiêu (giới hạn của Facebook và để lịch không làm đầy ổ đĩa)?
