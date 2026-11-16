# Hộp thư Page Facebook: nối trực tiếp, không qua trình duyệt

**Ngày:** 2026-11-16  
**Trạng thái:** Anh duyệt ngày 16/11/2026. Đợt 1 đã triển khai và phát hành trong 26.38.0 (16/11/2026), chờ anh kiểm trên Page thật (plan: `docs/plans/2026-11-16-facebook-page-inbox-direct.md`). Đợt 1 đã được anh xác nhận trên Page thật ngày 16/11/2026 (chữ, nhãn dán, tệp, ảnh động, ảnh về đúng loại). Đợt 2 phần gửi chữ và đã đọc phát hành trong 26.41.0 (16/11/2026); "Đồng bộ lịch sử" cho Page và đợt 3 chưa làm.  
**Phạm vi:** Tài khoản Page (dòng `fb_accounts` có `parent_facebook_id`): nhận tin, danh sách hội thoại, tin cũ, gửi tin. Tài khoản Facebook cá nhân, cầu nối Go và E2EE không đổi.  
**Nguồn:** Kết quả các bản thử 26.37.9–26.37.13 (`SYSTEM_DOCUMENTATION.md` mục 4.11) và một bản ghi mạng của Meta Business Suite do anh ghi ngày 16/11/2026 (chỉ lấy cấu trúc, không lưu vào repo). Số thứ tự trường của các bảng Messenger lấy từ mautrix-meta (`pkg/messagix/table`, commit đang ghim ở `scripts/build-bridge-e2ee.js`, giấy phép AGPL: chỉ tham chiếu số thứ tự trường, không chép mã).

## 1. Mục tiêu

Anh cần hộp thư Page dùng được hằng ngày: tin khách gửi về đủ loại, có tin cũ, gửi đi nhanh và chắc.

**Tiêu chí thành công:**
- Tin khách gửi vào Page hiện trong MaiHub trong vài giây, đúng loại: chữ, ảnh, nhãn dán, video, tệp, ghi âm.
- Mở app là có danh sách hội thoại của Page kèm tin cuối; cuộn lên trong một hội thoại thì tải được tin cũ.
- Gửi tin chữ từ MaiHub tới khách không cần cài lõi trình duyệt, không cần đăng nhập Business Suite riêng.
- Mất mạng ngắn thì tự nối lại, không mất tin trong lúc rớt.
- Không hồi quy: tài khoản cá nhân, E2EE, đăng bài Page, và luồng Page cũ (khi kết nối mới không chạy) giữ nguyên hành vi.

## 2. Hiện trạng (16/11/2026)

| Việc | Hiện nay | Hệ quả |
|---|---|---|
| Nhận tin | Qua thông báo `deltaBiiMPageMessageNotification` trên MQTT của tài khoản cha; thông báo chỉ có chữ | Ảnh, nhãn dán, video chỉ về dưới dạng dòng chữ thông báo, trừ khi đọc lại được qua trình duyệt Business Suite |
| Gửi tin | Trình duyệt không giao diện điều khiển Business Suite (`pagePlaywrightDriver.ts`) | Cần cài lõi trình duyệt và đăng nhập riêng; máy chưa cài thì mọi lần gửi đều lỗi; chậm |
| Tin cũ, danh sách hội thoại | Không có | Page chỉ có tin nhận được từ lúc mở app |

**Điều đã chứng minh trên tài khoản thật (26.37.13):** Business Suite dùng chính giao thức lightspeed của Messenger trên MQTT `edge-chat.facebook.com`. MaiHub nối được bằng thư viện `mqtt` + `ws` sẵn có, với bốn điểm bắt buộc:
1. Đăng nhập bằng cookie tài khoản cá nhân (không có `i_user`), `Origin: https://business.facebook.com`.
2. Username của gói CONNECT có `p` và `aids.PAGE` = `delegate_page_id`, `aid` = app id của Business Suite.
3. Hộp thư Page là cơ sở dữ liệu / nhóm đồng bộ **205** (tài khoản cá nhân là 1).
4. Trước khi nối phải tải trang `business.facebook.com/latest/inbox/all/?asset_id=<id Page>` để lấy: con trỏ đồng bộ của 205, phiên bản lược đồ, `bloks_version`, và **mã thiết bị** (`MqttWebDeviceID`). Kết nối phải dùng đúng mã thiết bị đó, nếu không Facebook không đẩy thay đổi về.

Với đủ bốn điểm, bản thử nhận được: trả lời đồng bộ, danh sách hội thoại (tác vụ 313), 20 tin cũ mỗi lần xin (tác vụ 228) kèm ảnh và nhãn dán, và tin mới đẩy về trực tiếp (chữ, nhãn dán, ảnh).

## 3. Thiết kế

### 3.1 Nguyên tắc

Kết nối mới đóng vai "cầu nối" của tài khoản Page: nó phát tin theo đúng dạng mà cầu nối Go đang phát cho tài khoản cá nhân, và có hàm `fetchMessages` cùng chữ ký. Nhờ vậy phần lưu tin, tải media, chống trùng, giới hạn tốc độ tải tin cũ và giao diện đã có được dùng lại, không viết đường lưu thứ hai.

Toàn bộ viết bằng TypeScript trong `src/services/facebook/`. Không sửa cầu nối Go, không vá thư viện ngoài, không thêm phụ thuộc.

### 3.2 Các phần

| Tệp (mới) | Trách nhiệm | Phụ thuộc |
|---|---|---|
| `lightspeedDecoder.ts` | Chạy chương trình `step` của một phản hồi `/ls_resp`, trả về danh sách lời gọi thủ tục `{ name, args }` theo thứ tự. Hàm thuần. | Không |
| `pageInboxTables.ts` | Đổi các lời gọi thủ tục thành dữ liệu có kiểu: tin, đính kèm, cảm xúc, đã xem, hội thoại, người liên hệ, khoảng tin cũ, con trỏ. Ghép tin với đính kèm thành tin dạng cầu nối. Hàm thuần. | `lightspeedDecoder.ts` |
| `pageInboxBootstrap.ts` | Tải trang hộp thư và đọc con trỏ, phiên bản, `bloks_version`, mã thiết bị. | `axios`, `fbHeaders` |
| `FacebookPageInbox.ts` | Một kết nối cho một Page: nối, đồng bộ, đánh số và ghép yêu cầu với trả lời, nối lại, `fetchMessages`, `sendText`, `markRead`. Phát sự kiện `message`, `reaction`, `readReceipt`, `thread`, `status`. | Ba tệp trên, `mqtt`, `ws` |

Sửa tệp sẵn có:
- `FacebookService.ts`: tài khoản Page khởi động và dừng `FacebookPageInbox` cùng vòng đời kết nối; đưa sự kiện `message` vào đường `handleIncomingMessage` hiện có; `historyFetcher` của Page dùng kết nối này làm nguồn tin cũ; gửi tin chữ đi qua kết nối này (đợt 2).
- `FacebookHistoryFetcher.ts`: nhận biết "tin của mình" khi người gửi là `delegate_page_id` (hiện chỉ so với `facebook_id`).
- `handlePageMessageNotification` (chạy trên tài khoản cha): bỏ qua thông báo của Page nào đang có kết nối mới hoạt động; chỉ xử lý khi kết nối đó không chạy.
- Gỡ `pageBridgeProbe.ts`, test của nó và cờ `MAIHUB_FB_PAGE_BRIDGE_PROBE`: phần dùng được chuyển vào các tệp trên.

### 3.3 Bộ giải mã lightspeed

Phản hồi là một chương trình nhỏ. Bản ghi cho thấy máy chủ chỉ dùng các bước: khối (1), đọc biến (2), ghi biến (3), ghi mảng (4), gọi thủ tục (5), không có giá trị (9), số 64 bit từ chuỗi (19), điều kiện (23), phủ định (26) và vài phép phụ. Tin mới nằm trong nhánh `nếu tin chưa có thì chèn`.

Bộ giải mã theo đúng cách thư viện tham chiếu xử lý: lệnh kiểm tra phía máy khách luôn coi là "được", nên nhánh chèn luôn chạy. Việc "tin đã có chưa" để cho cơ sở dữ liệu quyết định theo mã tin (`saveFBMessage` đã chống trùng). Số 64 bit giữ ở dạng chuỗi để không mất chữ số. Bước lạ trả về trống và ghi một dòng log tên bước, không làm hỏng phần còn lại của phản hồi.

### 3.4 Luồng dữ liệu

**Lúc nối:** tải trang hộp thư → nối MQTT bằng mã thiết bị của trang → gửi `/ls_app_settings` → xin đồng bộ 205 từ con trỏ của trang → xin trang đầu danh sách hội thoại. Danh sách về thì lưu hội thoại, tên và ảnh người liên hệ, tin cuối của mỗi hội thoại (lưu như tin cũ: không cộng chưa đọc, không thông báo).

**Tin mới:** phản hồi đẩy về → giải mã → tin dạng cầu nối (`id`, `threadId`, `senderId`, `text`, `timestampMs`, `attachments[]`, `replyTo`) → `handleIncomingMessage` của tài khoản Page. Mã tin và mã hội thoại trùng với luồng thông báo cũ (`mid.$…`, id khách), nên một tin không bao giờ thành hai dòng.

**Tin cũ:** `historyFetcher` gọi `fetchMessages({ threadId, beforeTimestampMs, beforeMessageId })` → tác vụ 228 → chờ phản hồi có khoảng tin của đúng hội thoại → trả `{ messages, hasMoreBefore, minTimestampMs, minMessageId }`. Giới hạn tốc độ và thời gian nghỉ dùng `FacebookHistoryLimiter` sẵn có.

**Gửi chữ (đợt 2):** tác vụ 46 với mã tạm (`otid`) → chờ trả lời xác nhận mã tin thật → lưu và phát như các đường gửi khác; tin dội về được bỏ qua bằng cơ chế chống dội sẵn có (`_recentlySentMessageIds`).

### 3.5 Nối lại và lỗi

- Rớt kết nối: nối lại bằng cùng mã thiết bị và con trỏ mới nhất trong bộ nhớ, giãn cách theo `facebookBridgeBackoff.ts`. Facebook phát lại các thay đổi bị lỡ từ con trỏ đó.
- Không có trả lời đồng bộ trong 10 giây, hoặc nối lại thất bại 3 lần liên tiếp: tải lại trang hộp thư để lấy con trỏ và mã thiết bị mới.
- Trang hộp thư không cho con trỏ (cookie hết hạn, bị chuyển về trang đăng nhập): kết nối báo trạng thái lỗi, thử lại theo giãn cách; trong lúc đó luồng thông báo cũ của tài khoản cha tiếp tục nhận tin chữ.
- Yêu cầu không có trả lời trong 30 giây: báo lỗi cho bên gọi (tải tin cũ, gửi tin), không treo.
- Mở app sau thời gian tắt: con trỏ lấy từ trang là con trỏ hiện tại, nên tin đến lúc app tắt không được phát lại. Danh sách hội thoại lúc nối cho tin cuối của mỗi hội thoại; phần ở giữa tải khi mở hội thoại (cơ chế bù khoảng trống sẵn có của `historyFetcher`).

### 3.6 An toàn và quay lui

- Đợt 1 chỉ đọc. Không đánh dấu đã đọc, không gửi gì thay người dùng.
- Log không chứa nội dung tin, cookie, con trỏ, mã thiết bị; chỉ có số đếm và vài ký tự cuối của mã.
- Tải tin cũ đi qua bộ giới hạn sẵn có (cùng ngưỡng với tài khoản cá nhân).
- Tắt nhanh không cần hạ phiên bản: mở app với `MAIHUB_FB_PAGE_INBOX=0` thì Page quay về hoàn toàn luồng cũ.
- Luồng cũ (thông báo qua tài khoản cha, gửi qua trình duyệt) giữ nguyên trong mã ở cả ba đợt; chỉ gỡ sau khi luồng mới chạy ổn và anh đồng ý.

## 4. Các đợt

Mỗi đợt là một bản phát hành riêng, kiểm trên Page thật của anh trước khi sang đợt sau.

| Đợt | Nội dung | Điều kiện xong |
|---|---|---|
| 1. Nhận và tin cũ | Bộ giải mã, bảng dữ liệu, kết nối, nối lại; tin mới đủ loại; danh sách hội thoại lúc nối; tải tin cũ khi cuộn; gỡ bản thử | Anh nhắn chữ, ảnh, nhãn dán, video vào Page: đều hiện đúng. Cuộn lên tải được tin cũ. Rút mạng 1 phút rồi cắm lại: tin gửi trong lúc rớt vẫn về. |
| 2. Gửi chữ, đã đọc, đồng bộ cả Page | Gửi tin chữ và trả lời qua kết nối mới; đánh dấu đã đọc khi mở hội thoại; cho tính năng "Đồng bộ lịch sử" chạy với Page | Gửi từ MaiHub trên máy chưa cài lõi trình duyệt: khách nhận được trong vài giây. |
| 3. Gửi ảnh và tệp | Tải tệp lên và gửi qua kết nối mới | Cần anh ghi thêm một bản ghi lúc gửi ảnh trong Business Suite; thiết kế chi tiết viết bổ sung khi có bản ghi. |

## 5. Kiểm thử

- Dữ liệu mẫu tự dựng (id, chữ, đường dẫn đều giả); không gọi Facebook thật trong test.
- `lightspeedDecoder`: từng loại bước, nhánh điều kiện như trong phản hồi thật (kiểm tra-rồi-chèn), bước lạ, số 64 bit lớn hơn 2^53.
- `pageInboxTables`: mỗi loại tin (chữ, ảnh, nhãn dán, video, tệp, ghi âm, trả lời, tin hệ thống), tin của chính Page, đính kèm trùng, tin thiếu trường.
- `FacebookPageInbox` với máy khách MQTT giả: trình tự lúc nối, ghép yêu cầu với trả lời, quá hạn, nối lại bằng con trỏ cũ, tải lại trang sau 3 lần hỏng, hai lần `fetchMessages` cùng hội thoại.
- `FacebookService`: tin từ kết nối mới được lưu một lần; thông báo của tài khoản cha bị bỏ qua khi kết nối mới chạy và được xử lý khi nó không chạy; tài khoản cá nhân không khởi động kết nối này.
- Hồi quy: toàn bộ bộ test hiện có ba lượt (thường, ngẫu nhiên hai múi giờ), kiểm kiểu hai dự án, `check-docs`.
- Kiểm trên app thật do anh làm theo cột "Điều kiện xong" của từng đợt.

## 6. Rủi ro

| Rủi ro | Mức | Cách xử lý |
|---|---|---|
| Facebook đổi cấu trúc trang hộp thư hoặc số thứ tự trường | Trung bình | Đọc phiên bản từ trang mỗi lần nối; trường thiếu thì bỏ tin đó và ghi log tên thủ tục, không dừng kết nối; luồng cũ vẫn nhận tin chữ |
| Mỗi Page thêm một phiên Business Suite chạy thường trực bằng cookie cá nhân | Thấp đến trung bình | Đây là hành vi của một tab Business Suite mở sẵn; đi qua proxy của tài khoản; nối lại có giãn cách; tắt được bằng cờ |
| Tin media đến lúc kết nối mới đang rớt | Thấp | Luồng cũ lưu dòng chữ thông báo; khi nối lại tin thật có cùng mã nên giữ nguyên dòng chữ. Chấp nhận ở đợt 1, ghi vào tài liệu |
| Tải trang hộp thư 1,6 MB mỗi lần khởi động và mỗi lần phải lấy lại con trỏ | Thấp | Chỉ tải lại sau 3 lần nối hỏng hoặc khi không có trả lời đồng bộ |
| Giấy phép: MaiHub là MIT, thư viện tham chiếu (mautrix-meta) được hiểu là AGPL-3.0 | Cần anh biết | Bộ giải mã và bảng dữ liệu viết mới từ giao thức quan sát được trong bản ghi; chỉ đối chiếu số thứ tự trường với thư viện, không chép mã. Ghi nguồn gốc này thành một dòng trong `NOTICE.md` |

## 7. Ngoài phạm vi

- Gửi nhãn dán, cảm xúc, thu hồi, sửa tin của Page qua kết nối mới (xem lại sau đợt 3).
- Lưu con trỏ xuống đĩa để phát lại tin đến lúc app tắt.
- Instagram và WhatsApp trong Business Suite.
- Gỡ luồng cũ qua trình duyệt.

## Ghi chú sau phát hành (26.38.0, đợt 1)

- Nối lại dùng bộ giãn cách sẵn có của bridge (`facebookBridgeBackoff.ts`: 10 giây nhân đôi, trần 5 phút) thay vì một bộ riêng.
- Sự kiện của kết nối đi qua một `FacebookEventPipeline` riêng rồi vào `handleBridgeEvent`, giống hệt sự kiện của bridge Go.
- Mục 3.6 nói "log không chứa nội dung tin": đúng với log của `FacebookPageInbox`. Đường xử lý chung (`handleBridgeEvent`, `handleIncomingMessage`) vẫn ghi đoạn đầu nội dung tin như với tài khoản cá nhân; đổi việc đó là việc riêng, ngoài phạm vi.
- Khách gỡ cảm xúc: giao diện cập nhật ngay nhưng cơ sở dữ liệu chưa xoá, vì đi chung nhánh `reaction` của bridge (chỉ lưu khi có cảm xúc).
- Khi kết nối mới đang sống, thông báo qua tài khoản cha không lưu ngay: nó điền tên và ảnh người gửi, chờ 10 giây, rồi chỉ lưu (như luồng cũ) nếu tin thật chưa về, đồng thời bảo kết nối lấy lại con trỏ. Mục 3.2 viết "bỏ qua"; cách này thêm vào sau lượt soát mã để một kết nối "sống nhưng không nhận được tin" không làm mất tin của khách.
- Thêm sau lượt soát mã, ngoài mô tả ở mục 3: tin Page gửi từ MaiHub qua trình duyệt (mã tạm `page:<ms>`) nhận mã thật từ tin dội của kết nối (dội về trong lúc đang gửi thì lượt gửi lấy luôn mã thật; dội về sau thì dòng mã tạm được đổi mã), thay vì hiện hai lần; `connect()` gọi lại không dựng lại kết nối đang chạy; phiên đồng bộ dưới 60 giây rồi bị đóng tính là một lần hỏng; cookie hết hạn thì dừng kết nối; trang tin cũ chỉ nhận tin cũ hơn mốc của yêu cầu; tin đã thu hồi thành sự kiện thu hồi; thẻ liên kết không chữ lấy địa chỉ làm nội dung.
- `fb_threads.id` là khoá chính toàn cục (có từ trước): một khách nhắn cho hai Page của cùng máy dùng chung một dòng `fb_threads`. Danh sách hội thoại trên giao diện đọc từ `contacts` (khoá theo từng Page) nên không ảnh hưởng; chưa sửa trong đợt này.

## Ghi chú sau phát hành (26.41.0, đợt 2 phần gửi chữ và đã đọc)

- Làm trước phần gửi chữ vì máy của anh chưa cài lõi trình duyệt nên mọi tin gửi từ Page đều không đi được; "Đồng bộ lịch sử" cả tài khoản cho Page để lại sau.
- Gói gửi lấy đúng theo bản ghi Business Suite: tác vụ 46 và tác vụ 21 trong một yêu cầu, xác nhận bằng `replaceOptimsiticMessage`. Bản ghi cho thấy tin dội (`insertMessage`) về trước xác nhận, nên lượt gửi giữ tin dội lại và bỏ tin mang đúng mã của nó.
- Không gửi lại qua trình duyệt khi không có xác nhận (mục 3.5 chưa nói rõ điểm này).
- Trả lời (`reply_metadata`) lấy tên trường theo tác vụ gửi của Messenger; bản ghi không có mẫu trả lời nên chưa kiểm trên Page thật.

## Ghi chú sau phát hành (26.42.0, trạng thái tin)

- Thêm theo yêu cầu của anh ngày 16/11/2026, ngoài danh sách ban đầu của mục 4: trạng thái "đã nhận" (sự kiện `delivered`). "Đã xem" và "đang soạn tin" (khách gõ) đã có từ 26.38.0 qua các sự kiện `seen` / `typing`; 26.42.0 thêm test khóa lại hành vi này cho Page.
- Gửi trạng thái "Page đang soạn" tới khách chưa làm: cần một bản ghi Business Suite có thao tác gõ trong ô soạn tin để lấy đúng gói tin.

## Ghi chú sau phát hành (26.43.0, đợt 3: ảnh / tệp, nhãn dán, cảm xúc)

- Định dạng lấy từ bản ghi Business Suite thứ hai của anh (16/11/2026, 23:35): tải tệp lên `upload-business.facebook.com`, tác vụ 46 với `send_type: 3` (tệp) và `send_type: 2` (nhãn dán), tác vụ 29 cho cảm xúc. Chi tiết ở `SYSTEM_DOCUMENTATION.md` mục 4.11.
- Khác mục 4 của spec: nhãn dán không có trong danh sách ban đầu; bảng chọn nhãn dán lấy khay thẳng từ Business Suite (hai truy vấn GraphQL) thay vì tìm qua trình duyệt, vì gửi qua hộp thư cần mã nhãn dán mà đường trình duyệt không cho. Tìm theo từ khoá là lọc theo mô tả trong khay, không phải tìm trên máy chủ Facebook (bản ghi không có thao tác tìm).
- Sau lượt review độc lập trước khi phát hành: nhãn dán chọn từ khay không bao giờ gửi theo vị trí qua trình duyệt; lời nhắn kèm tệp không được xác nhận thì ở lại trên tin chứa tệp; tệp được đánh dấu là tin của lượt gửi trước khi gửi lời nhắn; từ khoá không khớp trong khay thì tìm qua trình duyệt; khay được thử lại một lần với mã phiên mới.
- Lời nhắn kèm tệp đi thành một tin riêng sau tệp: bản ghi chỉ có tệp không kèm chữ (`text: null`), nên không ghép chữ vào tác vụ gửi tệp khi chưa có bằng chứng Facebook nhận dạng đó cho hộp thư Page.
- Tải lên và danh sách nhãn dán chưa kiểm trên tài khoản thật lúc phát hành; cả hai rơi về đường trình duyệt khi hỏng. Gửi tệp / nhãn dán / cảm xúc đã phát lệnh mà không được xác nhận thì báo lỗi, không gửi lại.
- Chưa làm: Page hiện "đang soạn" cho khách (hai bản ghi đều không có gói này trên kết nối hộp thư), "Đồng bộ lịch sử" cả tài khoản cho Page (bản ghi không có thao tác kéo danh sách hội thoại vì Page có ít hội thoại), nhận lại tin đến lúc app tắt.
