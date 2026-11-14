# Đồng bộ lịch sử tin nhắn Zalo từ điện thoại

**Ngày:** 13/11/2026
**Trạng thái:** Đã triển khai, gộp vào `main` và phát hành trong 26.36.0 (14/11/2026); chưa thử với điện thoại thật. Xem "Ghi chú sau triển khai" ở cuối. Plan: `docs/plans/2026-11-13-zalo-phone-history-sync.md`.
**Nguồn tham chiếu:** `babyvibe/deplao-builder` (MIT) tại `2162f07`, thư mục `src/services/zalo/mobileSync/` và các chỗ nối của nó.

## 1. Mục tiêu

Anh bấm một nút trong MaiHub, xác nhận trên điện thoại, và tin nhắn Zalo cũ trong khoảng thời gian đã chọn được ghép vào đúng các hội thoại đang có trong MaiHub. Chạy lại nhiều lần không sinh tin trùng.

Không phải mục tiêu: tự động đồng bộ định kỳ; lấy lại ảnh/video cũ đã hết hạn trên máy chủ Zalo; lịch sử Facebook (spec riêng).

## 2. Hiện trạng (đã kiểm 13/11/2026)

- MaiHub chỉ có "Tải tin nhắn cũ" (`login:requestOldMessages`), lấy những gì Zalo Web tự trả về; không kéo được theo khoảng ngày.
- `zca-js` 2.1.2 đang cài đã có mọi thứ tính năng cần: `api.custom`, `utils.encodeAES/makeURL/request/resolve`, `api.zpwServiceMap`, `ctx.imei/cookie/userAgent/options.agent`, `listener.ws`, `listener.cipherKey`. `apis/listen.js` của 2.2.0 giống hệt từng byte; khác biệt hành vi duy nhất của 2.2.0 là `apiVersion` mặc định 671 → 685.
- Các lệnh `pull_mobile_msg`, `cancel_pull_mobile_msg`, `znoise` không có trong `zca-js` (cả hai bản); bản gốc tự gọi qua `api.custom`.
- File sao lưu nén kiểu XZ; Node 24 (Electron 41) không có sẵn bộ giải XZ.
- Bản 26.35.0 đã có: index `idx_messages_cli`, hàm `decodeWsEventData` (`src/services/zalo/zaloReadElsewhere.ts`), chuẩn hoá ảnh JPEG XL, `EventBroadcaster.runOnBossDb`, và `isDuplicateZaloDelivery` đã coi id dạng `mb_…` / `cli_…` là id tạm.
- Bản gốc không có test nào cho tính năng này.

## 3. Quyết định

| # | Quyết định |
|---|---|
| D1 | (anh) Làm tính năng này cho Zalo, theo cách của bản gốc. |
| D2 | (em) **Không nâng `zca-js`**, giữ 2.1.2. Nếu khi anh thử thật mà Zalo từ chối `pull_mobile_msg` vì phiên bản giao thức thì mới nâng lên 2.2.0 ở một bản sửa riêng. |
| D3 | (em) Thêm đúng một dependency: `xz-decompress` ghim `0.2.3` (MIT, không có dependency con, không có script cài đặt, giải nén bằng WebAssembly nhúng sẵn). Lý do: Node không giải được XZ. |
| D4 | (em) Phần giao thức (`zdbBackup`, `binNet`, `mobileMessageConverter`, `zcaMobileSync`) port sát bản gốc vì đó là bảng tra và định dạng dữ liệu của Zalo; ghi nguồn ở đầu từng file và trong `NOTICE.md`. Phần dịch vụ, DB, IPC, giao diện viết theo kiến trúc và quy ước của MaiHub. |
| D5 | (em) Thêm so với bản gốc: lúc mở app dọn thư mục làm việc còn sót của lần đồng bộ bị ngắt giữa chừng (bản sao lưu đã giải mã chứa tin nhắn riêng tư). |
| D6 | (em) Không lấy: trang trợ giúp `HistorySyncPanel`, gợi ý sau đăng nhập, chấm đỏ "tính năng mới", đăng ký bảng cho Cloudflare sync, biến môi trường giữ file tạm, cờ `media_expired` và giao diện "Ảnh đã hết hạn". |
| D7 | (em) Giữ nút "Tải tin nhắn cũ" hiện có; nút mới đặt cạnh nó trên thanh công cụ, chỉ hiện với tài khoản Zalo và ẩn với nhân viên. |

## 4. Luồng

1. Anh bấm nút "Đồng bộ từ điện thoại", chọn khoảng: **1 tuần gần nhất** (mặc định), **Chọn ngày** (từ–đến), **Toàn bộ**.
2. App sinh cặp khoá RSA-2048 (khoá riêng chỉ nằm trong bộ nhớ, xoá khi phiên kết thúc) và gọi `pull_mobile_msg` với khoá công khai, `pc_name: 'Web'`, `from_seq_id = fromTs` (0 nếu "Toàn bộ").
3. Chờ điện thoại, qua sự kiện điều khiển `syncmsgmb` trên websocket (cmd 601):
   - `user_confirm` với `user_action` 1 hoặc 3 → chờ điện thoại chuẩn bị dữ liệu; 0 → huỷ ("Bạn đã từ chối đồng bộ trên điện thoại"); 2 → lỗi ("Điện thoại đang khôi phục dữ liệu, vui lòng thử lại sau").
   - `transfer_error` `status` 1 → vẫn đang chuẩn bị; 2 → điện thoại đang tạm dừng (nhắc mở Zalo); `error_code` khác 0 → lỗi kèm mã.
   - `syncmsg_info` → có link tải và khoá đã mã hoá.
   - Sự kiện có `public_key` khác phiên hiện tại bị bỏ qua.
4. Hạn chờ: 3 phút cho bước xác nhận, 30 phút cho bước chuẩn bị (đặt lại mỗi lần điện thoại báo tiến triển). Hết hạn thì gọi `cancel_pull_mobile_msg` và báo lỗi. Không tự thử lại.
5. Tải file `.db.crypt` về thư mục làm việc `userData/mobile-sync/<zaloId>/<thời điểm>/`: chỉ `https`; cookie phiên Zalo chỉ gửi tới host `zalo.me`, `zaloapp.com`, `zdn.vn`, `zadn.vn` (và subdomain); tối đa 5 lần chuyển hướng, bỏ cookie khi chuyển sang host khác; gặp 4xx thì thử lại một lần không cookie; đi qua proxy của tài khoản; ngắt nếu 60 giây không có dữ liệu.
6. Giải mã khoá bằng khoá riêng (RSA PKCS#1 v1.5; có đường dự phòng tự tính khi runtime chặn kiểu đệm này), giải mã file (ZDB4.0, `db_format` phải bằng 1: AES-256-CBC theo khối 64 KB, IV toàn 0), giải nén XZ theo luồng, ra các file SQLite `<uid>.db` và `group_<gid>.db`. Sai mã kiểm tra chỉ ghi cảnh báo. Tên file không an toàn bị bỏ.
7. Đổi ID: bản sao lưu dùng ID ngắn của điện thoại, MaiHub dùng ID dài của web. Gọi `znoise` theo lô 500, mỗi lô thử tối đa 3 lần; kết quả lưu vào bảng `zalo_plain_id_map` để lần sau khỏi hỏi lại. Hội thoại không đổi được ID (đã xoá, đã rời nhóm) bị bỏ và đếm riêng.
8. Đọc bảng `ChatContent` của từng file trong khoảng đã chọn, đổi từng dòng sang dạng tin `zca-js`, nhập theo lô 1000 dòng trong một transaction, nhường vòng lặp sự kiện giữa các lô.
9. Bổ sung tên và ảnh đại diện cho hội thoại mới tạo (tối đa 1000 người và 1000 nhóm mỗi lần).
10. Kết thúc: xoá khoá riêng và thư mục làm việc (kể cả khi lỗi hoặc huỷ), rồi mới báo trạng thái cuối; giao diện tải lại danh sách hội thoại và hội thoại đang mở.

Huỷ: khi đang chờ thì gọi `cancel_pull_mobile_msg`; khi đang tải/giải mã/nhập thì dừng ở điểm kiểm tra gần nhất. Mỗi tài khoản chỉ một phiên cùng lúc; tài khoản khác nhau chạy song song được.

## 5. Nhập tin và chống trùng

- Tin nhập là lịch sử: **không** tăng số chưa đọc, **không** thông báo, **không** chạy workflow/webhook, **không** tải media. Xem trước của hội thoại chỉ đổi khi tin nhập mới hơn tin đang hiển thị.
- Dòng tin được dựng bằng **cùng một hàm** với đường nhận tin trực tiếp (`saveMessage`), để hai đường không lệch nhau.
- ID tin: dùng id thật của Zalo; tin không có id thật (tin mình gửi từ máy khác) mang id tạm `mb_<cliMsgId>`.
- Trùng theo id → bỏ qua (`INSERT OR IGNORE`). Trùng theo cùng hội thoại + người gửi + `cliMsgId` dưới id khác → bỏ qua; riêng khi dòng đang có mang id tạm và dòng mới có id thật thì **nâng cấp dòng cũ** sang id thật và giờ máy chủ, không chèn dòng mới.
- Đường nhận tin trực tiếp cũng làm phép nâng cấp đó, để tin thật đến sau không thành bản thứ hai.
- Tin thu hồi nhập với cờ đã thu hồi. Không nhập: cảm xúc, bình chọn, video trực tiếp, thông báo nhóm/hệ thống, lệnh xoá của quản trị, và các kiểu tin không có trong bảng ánh xạ.
- Mọi ghi DB chạy trên DB chính (workspace mặc định), kể cả khi anh đang mở workspace khác.
- Schema chỉ cộng thêm: bảng `zalo_plain_id_map(owner_zalo_id, kind, plain_id, noise_id, updated_at)`, khoá chính `(owner_zalo_id, kind, plain_id)`.

## 6. Giao diện

- Nút trên thanh công cụ (cạnh "Tải tin nhắn cũ"), mở hộp thoại:
  - Trước khi chạy: mô tả ngắn, ba lựa chọn khoảng thời gian, nút "Bắt đầu đồng bộ". Với "Toàn bộ" có dòng nhắc có thể mất nhiều thời gian.
  - Đang chạy: năm bước — "Xác nhận trên điện thoại", "Điện thoại chuẩn bị dữ liệu", "Tải dữ liệu về máy", "Giải mã", "Ghép tin nhắn vào hội thoại"; dòng trạng thái; thanh tiến độ ở ba bước cuối; nút "Ẩn" và "Huỷ đồng bộ". Đóng hộp thoại không dừng việc đồng bộ.
  - Xong: số tin mới, số hội thoại, và các ghi chú (bỏ qua N tin đã có hoặc không hỗ trợ; N hội thoại không còn truy cập được; N tin ngoài khoảng đã chọn). Nút đổi thành "Đồng bộ lại".
- Khi hộp thoại đang đóng, kết thúc hoặc lỗi hiện bằng thông báo nổi.
- Theo `DESIGN.md`; sáng/tối; không tràn ngang ở chiều rộng hẹp.

## 7. IPC

`zalo:mobileSync:start { zaloId, fromTs, toTs }`, `zalo:mobileSync:cancel { zaloId }`, `zalo:mobileSync:status { zaloId }`; sự kiện `event:mobileSync` mang trạng thái `{ zaloId, stage, progress, message, range?, error?, stats?, startedAt?, updatedAt }`. Từ chối ở chế độ nhân viên: "Chỉ chủ tài khoản (máy đang đăng nhập Zalo) mới đồng bộ được từ điện thoại". Tiến độ gửi tối đa một lần mỗi 300 ms, trừ khi đổi bước.

## 8. An toàn và riêng tư

- Dữ liệu chỉ đi tới máy chủ Zalo. Không có host nào khác, không telemetry, không khoá bản quyền.
- Khoá riêng không ghi ra đĩa. File sao lưu đã giải mã chỉ tồn tại trong thư mục làm việc và bị xoá khi phiên kết thúc; lúc mở app dọn phần còn sót (D5).
- Không ghi log nội dung tin, cookie, khoá, link tải (link tải chứa mã truy cập).
- Tên file trong bản sao lưu được kiểm tra trước khi ghi ra đĩa (chống ghi ra ngoài thư mục làm việc).

## 9. Ngoài phạm vi

Lịch sử Facebook; tự động đồng bộ; tải lại media cũ và hiển thị "đã hết hạn"; nhập cảm xúc/bình chọn/thông báo nhóm; chủ đề (topic) của nhóm; nâng `zca-js`.

## 10. Kiểm thử

- **Tự động, không gọi Zalo:** giải mã khoá (cả đường dự phòng), đọc ZDB4.0 dựng trong test (kể cả tên file xấu, file cắt cụt, mã kiểm tra sai), phân tích `BinNet`, ánh xạ kiểu tin, lọc theo khoảng thời gian, đổi ID theo lô có thử lại, nhập và chống trùng (id thật / id tạm / nâng cấp / tin trực tiếp đến sau), không tăng chưa đọc, máy trạng thái phiên với đồng hồ giả (từ chối, điện thoại ngủ, hết hạn, huỷ ở từng bước, hai phiên), tải file qua lớp vận chuyển giả (https, cookie theo host, chuyển hướng, 4xx), dọn thư mục, DB chính khi mở workspace khác, hàm thuần của giao diện.
- **Như CI:** bộ lệnh kiểm chứng quen dùng, hai vòng.
- **Kiểm tay (anh, cần điện thoại thật):** 1 tuần gần nhất; từ chối trên điện thoại; để điện thoại ngủ giữa chừng; chạy lại xem không trùng; kiểm một tin mình đã gửi từ MaiHub không bị nhân đôi; "Toàn bộ" trên tài khoản nhiều tin.

## 11. Rủi ro

- Giao thức không công bố, lấy từ bản gốc; Zalo đổi là hỏng. Chỉ biết chắc chạy được khi anh thử trên điện thoại thật.
- Chưa biết máy chủ Zalo có đòi phiên bản giao thức 685 cho `pull_mobile_msg` hay không (D2).
- Sửa đường nhận tin trực tiếp (dựng dòng chung, nâng cấp id tạm) đụng tới mọi tin Zalo đến; có test hồi quy nhưng đây là chỗ cần nhìn kỹ nhất.
- "Toàn bộ" trên tài khoản rất nhiều tin có thể chạy lâu; mỗi lô 1000 dòng chặn tiến trình chính khoảng 50 ms (số của bản gốc, chưa đo trên máy anh).
- Ảnh/video cũ thường không còn trên máy chủ Zalo, sẽ hiện ảnh lỗi.

## Ghi chú sau triển khai

Thân spec ở trên giữ nguyên như lúc viết. Chỗ code khác hoặc bổ sung so với spec, và giới hạn đã biết:

- **Một file hội thoại hỏng không làm hỏng cả phiên:** file đó bị bỏ qua và đếm vào `stats.conversationsFailed` (giao diện hiện "N hội thoại không đọc được"); lỗi ghi DB hoặc lỗi lưu bảng đổi ID vẫn làm hỏng cả phiên.
- **`progress` là một tiến độ tổng 0–100 không giảm** (tải 0–40, giải mã 40–60, ghép ID 60–65, nhập 65–99), không phải tiến độ từng bước; giao diện có một thanh chung.
- **Gọi máy chủ có hạn:** `pullMobile` 30 s, `cancelPullMobile` 10 s; hết hạn vẫn kết thúc phiên. Người dùng huỷ thắng việc đóng do hết hạn; nếu `pullMobile` thành công muộn thì huỷ phía Zalo theo khả năng. Không cần websocket đang mở, chỉ cần api đã gắn.
- **Giải nén chặt hơn spec:** dừng sau mục cuối, kiểm tra dung lượng trống, tên trùng giữ mục đầu, tên thiết bị Windows bị bỏ; footer XZ tìm lùi từng khối nên đuôi dư dài hơn 128 KB vẫn xử lý đúng (lỗi phát hiện lúc tích hợp và đã sửa trong `zdbBackup.ts`).
- **Tải file chặt hơn spec:** URL có userinfo bị từ chối; cookie quyết định theo từng request.
- **Dọn khi khởi động:** `sweepLeftovers()` được gọi trong `electron/main.ts`.
- **Giới hạn đã biết (giao diện):** tin nhập cũ hơn cửa sổ tin đã tải của hội thoại đang mở chỉ hiện khi cuộn lên hoặc mở lại hội thoại; nếu `ChatWindow` đã đặt `hasMore = false` thì phải mở lại hội thoại.
- **Media cũ:** tin nhập không tải lại media; ảnh/tệp quá hạn trên máy chủ Zalo có thể hiện ảnh lỗi (không làm cờ `media_expired` theo D6).
- **Chưa kiểm chứng:** mọi thứ mới được kiểm bằng test với bản sao lưu giả và `api` giả; chưa chạy với điện thoại thật hay trong app đang chạy. Chưa biết Zalo có đòi phiên bản giao thức 685 cho `pull_mobile_msg` hay không (quyết định D2); nếu đòi thì cần xử lý riêng (chỉ biết được khi thử với điện thoại thật).
- **Review cuối:** đã sửa việc `start()` ghi đè trạng thái khi sự kiện từ điện thoại tới trước phản hồi của `pull_mobile_msg` (phiên đã huỷ/đang chờ bản sao lưu/đang nhập không bị đưa lại `waiting_confirm` hay gắn hạn 3 phút; lỗi `pullMobile` đến muộn bị bỏ qua).
