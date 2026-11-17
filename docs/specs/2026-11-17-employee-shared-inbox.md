# Nhân viên dùng chung qua máy boss: vá kiểm soát truy cập và mở hộp thư Page

**Ngày:** 2026-11-17  
**Trạng thái:** Anh duyệt ngày 17/11/2026. Đợt 1 đã triển khai trong 26.45.0 (plan: `docs/plans/2026-11-17-employee-relay-hardening.md`). Đợt 2 (hộp thư Page cho nhân viên) đã triển khai trong 26.46.0 (plan: `docs/plans/2026-11-17-employee-page-inbox.md`). Phần đặt boss lên máy chủ (đợt 6) bỏ theo yêu cầu của anh.  
**Phạm vi:** Máy chủ chuyển tiếp trên máy boss (`src/services/http/`, `src/services/socket/`), phần định tuyến lệnh ở máy nhân viên (`electron/ipc/proxyHelper.ts`), các handler `fb:*`, màn hình gán tài khoản. Không đổi cách MaiHub nối tới Zalo, Facebook, Telegram.  
**Nguồn:** Rà soát code ngày 17/11/2026 và thiết kế của dự án gốc `babyvibe/deplao-builder` tại commit `515f1dc` (bản 26.11.1, giấy phép MIT). Chuyển sang bằng tay, không sao chép nguyên tệp; ghi nhận nguồn trong `NOTICE.md` như các lần trước.

## 1. Mục tiêu

Nhiều nhân viên cài MaiHub trên máy riêng và dùng chung hộp thư mà không phải điều khiển từ xa vào máy boss. Mọi phiên đăng nhập (cookie, kết nối) chỉ nằm trên máy boss; nhân viên được dùng chứ không đăng nhập lại.

**Tiêu chí thành công:**
- Nhân viên chỉ đọc và thao tác được trên tài khoản được gán. Đổi mã tài khoản trong yêu cầu thì bị từ chối ở máy boss.
- Gán Page cho nhân viên không cho họ thấy tài khoản Facebook cá nhân đứng sau Page đó, ở bất kỳ đường nào (đọc, ghi, sự kiện trực tiếp, tệp).
- Nhân viên dùng được hộp thư Page: thấy hội thoại, nhận tin trong vài giây, gửi chữ, ảnh, tệp, nhãn dán, thả cảm xúc, kéo lên tải tin cũ.
- Boss thấy tin nào do nhân viên nào gửi, như Zalo hiện nay.
- Không hồi quy: boss dùng một mình, nhân viên dùng Zalo, và mọi tính năng không liên quan tới chế độ nhân viên giữ nguyên hành vi.

## 2. Hiện trạng (17/11/2026)

Cơ chế boss và nhân viên đã có: đăng nhập bằng tài khoản nhân viên, quyền theo 8 module, gán tài khoản, đọc dữ liệu qua REST, nhận sự kiện qua Socket.IO, tải tệp lên máy boss. Nó chỉ chạy đủ cho Zalo.

### 2.1 Lỗ hổng kiểm soát truy cập

Đã đọc code xác nhận. Chưa thử khai thác trên máy thật. Tất cả (trừ dòng 7) cần một tài khoản nhân viên đã đăng nhập.

| # | Lỗ hổng | Hệ quả |
|---:|---|---|
| 1 | Lệnh ghi cài đặt nhận mọi khoá; lệnh đọc trả về cả bảng cài đặt | Nhân viên đọc và ghi đè được khoá ký phiên đăng nhập, từ đó giả mạo phiên của người khác và giữ quyền sau khi bị khoá |
| 2 | Danh sách lệnh được chuyển tiếp mở theo tiền tố, gồm cả nhóm `db:` không kiểm quyền module | Nhân viên gọi được lệnh đổi thư mục dữ liệu của boss, ghi dòng tài khoản, mở hộp thoại trên màn hình boss |
| 3 | Nhận bù sự kiện phát lại một bộ đệm chung cho mọi nhân viên; sự kiện không có mã tài khoản thì gửi cho tất cả; nhân viên chưa được gán tài khoản nào thì nhận mọi sự kiện | Nhân viên nhận được tin của tài khoản không được gán |
| 4 | Tên tệp và mã tài khoản lúc tải lên không được làm sạch | Nhân viên ghi được tệp ra ngoài thư mục media của máy boss |
| 5 | Các đường đọc và ghi qua REST lấy mã tài khoản từ yêu cầu mà không đối chiếu với danh sách được gán; phần lớn không kiểm quyền module | Nhân viên đọc và sửa được dữ liệu của mọi tài khoản trên máy boss, kể cả Facebook cá nhân |
| 6 | Phiên đăng nhập không thu hồi được: khoá, xoá, đổi mật khẩu nhân viên vẫn để phiên cũ dùng tiếp tới 7 ngày; đăng nhập không giới hạn số lần thử | Không cắt quyền ngay được khi nhân viên nghỉ |
| 7 | Đường lấy tệp media và thư viện không cần đăng nhập | Ai biết đường dẫn tệp là tải được |
| 8 | Ảnh chụp trạng thái gửi cho nhân viên chứa danh sách mọi nhân viên kèm quyền và tài khoản; thông báo "nhân viên đã gửi" phát cho tất cả; dòng tích hợp trả nguyên cả cột thông tin xác thực đã mã hoá | Lộ thông tin giữa các nhân viên |

Ngày 17/11/2026 máy của anh không bật máy chủ chuyển tiếp (không có gì nghe ở cổng 9900), nên các lỗ hổng này hiện không bị lộ ra ngoài. Chúng phải được vá trước khi mời thêm nhân viên vào.

### 2.2 Facebook, Page, Telegram

- Máy boss từ chối mọi lệnh `fb:*` và Telegram từ nhân viên. Ở máy nhân viên, các lệnh này chạy tại chỗ trên một cơ sở dữ liệu trống rồi báo "chưa kết nối".
- Sự kiện `fb:on*` không được chuyển cho nhân viên.
- Ảnh chụp trạng thái không có cột kênh và cột tài khoản cha, nên máy nhân viên không phân biệt được Zalo, Page, Facebook cá nhân.
- Màn hình gán tài khoản liệt kê mọi tài khoản mọi kênh dưới tiêu đề "Tài khoản Zalo", không phân biệt Page với cá nhân.
- Việc ghi nhận "nhân viên nào đã gửi" chỉ chạy cho Zalo.

## 3. Thiết kế

### 3.1 Nguyên tắc

1. **Đóng mặc định.** Lệnh, khoá cài đặt, sự kiện, đường dẫn tệp: cái gì không có trong danh sách cho phép thì bị từ chối. Sự kiện gắn với tài khoản mà thiếu mã tài khoản thì không gửi cho ai.
2. **Kiểm tra ở máy boss.** Máy nhân viên chỉ ẩn nút cho gọn; quyền thật do máy boss quyết định trên từng yêu cầu.
3. **Một nguồn cho "tài khoản nhân viên được dùng".** Một hàm duy nhất trả về danh sách này; đọc, ghi, sự kiện, tệp, ảnh chụp trạng thái đều hỏi nó.
4. **Bí mật không rời máy boss.** Cookie, token, khoá ký, mật khẩu proxy, thông tin xác thực tích hợp không bao giờ nằm trong phản hồi cho nhân viên.
5. **Phần logic thuần tách riêng** khỏi `HttpRelayService` (hiện 2826 dòng) để kiểm thử được mà không cần mạng hay Electron. Không tái cấu trúc phần còn lại của tệp đó.

### 3.2 Đợt 1: vá kiểm soát truy cập (không thêm tính năng)

| Phần | Tệp | Việc |
|---|---|---|
| Tài khoản được dùng | `src/services/http/employeeAccess.ts` (mới, thuần) | `allowedAccounts(employee)`; `checkEmployeeAccess(employee, pathname, params, hasPermission)` đối chiếu mọi tham số mang mã tài khoản và quyền module của nhóm đường dẫn (gồm cả các lệnh dùng khoá AI của boss). Danh sách tên tham số mang mã tài khoản lập từ mọi handler REST hiện có, tối thiểu: `zaloId`, `zalo_id`, `zaloIds`, `zalo_ids`, `ownerZaloId`, `owner_zalo_id`, `accountId`, `sourceZaloId`, `targetZaloId`; một kiểm thử quét các handler và báo đỏ khi gặp tên tham số tài khoản chưa có trong danh sách. Gọi trước khi điều phối mọi yêu cầu `/api/query/`, `/api/search/`, `/api/command/`, `/api/library/`. Nhân viên chưa được gán tài khoản nào bị từ chối ở các đường gắn với tài khoản |
| Cài đặt | cùng tệp | Danh sách khoá nhân viên được đọc và được ghi; đường đọc cả bảng chỉ trả các khoá đó |
| Lệnh chuyển tiếp | `src/services/http/relayChannelPolicy.ts` | Thay tiền tố bằng danh sách tên lệnh chính xác (đúng các lệnh máy nhân viên thật sự gửi), mỗi lệnh có module yêu cầu. Bỏ hẳn các lệnh quản trị máy boss. Mã tài khoản bắt buộc trừ một danh sách ngắn các lệnh không gắn tài khoản |
| Tệp | `src/services/http/bossFileAccess.ts` (mới, thuần) | Tên tệp tải lên chỉ giữ phần tên, mã tài khoản phải thuộc danh sách được dùng, đường dẫn sau khi phân giải phải nằm trong thư mục media. Mọi tham số đường dẫn tệp trong lệnh chuyển tiếp cũng qua phép kiểm này |
| Media và thư viện | `HttpRelayService`, `electron/main.ts` | Đường lấy tệp yêu cầu phiên đăng nhập và kiểm thư mục tài khoản. Máy nhân viên gắn phiên vào yêu cầu tới máy boss bằng `session.webRequest.onBeforeSendHeaders`, nên thẻ ảnh trong giao diện không phải đổi và phiên không nằm trong đường dẫn |
| Phiên đăng nhập | `src/services/employee/employeeTokenPolicy.ts` (mới, thuần), `EmployeeService` | Mỗi nhân viên có mốc "phiên hợp lệ từ"; khoá, xoá, đổi mật khẩu, đá ra đều đẩy mốc lên, phiên cũ hết hiệu lực ngay. Mỗi yêu cầu kiểm nhân viên còn tồn tại và còn bật. Khoá ký được đổi một lần cho mỗi cơ sở dữ liệu vì đã từng đọc được. Đăng nhập sai quá 5 lần trong 15 phút thì khoá tạm theo tên đăng nhập |
| Sự kiện | `src/services/socket/relayAudience.ts` (mới, thuần), `EventBuffer`, `SocketIOService` | Mỗi sự kiện được phân loại người nhận một lần (mọi người, theo tài khoản, theo nhân viên, không ai) và lưu kèm trong bộ đệm; phát trực tiếp và nhận bù đều lọc theo người nhận |
| Ảnh chụp trạng thái | `HttpRelayService.buildEmployeeSnapshot` | Dòng của nhân viên khác chỉ còn mã, tên hiển thị và ảnh (bỏ quyền và tài khoản được gán); thêm cột kênh và tài khoản cha cho các tài khoản được dùng. Dòng tích hợp trả cho nhân viên bỏ cột thông tin xác thực |

**Hệ quả với người dùng:** sau khi cập nhật, mọi nhân viên phải đăng nhập lại một lần (do đổi khoá ký). Máy boss và máy nhân viên phải cùng lên bản mới; máy nhân viên bản cũ sẽ không tải được ảnh.

### 3.3 Đợt 2: hộp thư Page cho nhân viên

**Quy tắc Page và cá nhân.** `allowedAccounts` loại mọi tài khoản Facebook cá nhân (dòng `fb_accounts` không có `parent_facebook_id`), kể cả khi đã lỡ gán. Vì mọi đường đều hỏi hàm này, tài khoản cá nhân biến mất khỏi ảnh chụp trạng thái, các đường đọc ghi, sự kiện và tệp cùng lúc. Mở Facebook cá nhân sau này là đổi một điều kiện ở đây cộng thêm phân loại lệnh, không phải rà lại từng đường.

**Phân loại lệnh.** `src/services/http/employeeChannelRoutes.ts` (mới, thuần) xếp mỗi handler `fb:*` vào đúng một nhóm:

| Nhóm | Lệnh | Ở máy nhân viên |
|---|---|---|
| Chuyển lên boss (quyền Tin nhắn) | `fb:getThreads`, `fb:getMessages`, `fb:fetchThreadMessages`, `fb:fetchOlderMessages`, `fb:sendMessage`, `fb:sendAttachment`, `fb:sendAttachments`, `fb:listPageStickers`, `fb:sendPageSticker`, `fb:addReaction`, `fb:markAsRead`, `fb:sendSeen`, `fb:getUserInfoFacebookHtml`, `fb:refreshContactAvatar` | Tải tệp lên boss trước nếu có, gửi lệnh, trả về đúng kết quả của boss |
| Chỉ boss | Thêm, xoá, đăng nhập, cookie, kết nối, bật tắt Page, mã hoá đầu cuối, đồng bộ lịch sử cả tài khoản, quét dữ liệu, và mọi thao tác hội thoại Page chưa hỗ trợ (sửa, thu hồi, chuyển tiếp, ghim, bình chọn, nhóm, chặn) | Trả lỗi rõ ràng, không chạy tại chỗ |
| Tại máy | Lưu và đọc tab, nhật ký quét cục bộ | Chạy như cũ |

Một kiểm thử đọc `electron/ipc/facebookIpc.ts` và `fbHistoryIpc.ts`, báo đỏ khi có handler chưa được xếp nhóm.

**Luồng một lệnh gửi.**
1. Giao diện ở máy nhân viên gọi `fb:sendMessage` như thường.
2. `employeeRoutedIpcMain` (thêm vào `proxyHelper.ts`) thấy đang ở workspace từ xa và lệnh thuộc nhóm chuyển lên boss: tải tệp trong tham số lên boss, rồi gửi `POST /api/proxy/action`.
3. Máy boss kiểm lần lượt: phiên đăng nhập, `accountId` bắt buộc và thuộc `allowedAccounts`, quyền module, lệnh có trong danh sách đóng, đường dẫn tệp hợp lệ. Sau đó gọi chính handler `fb:sendMessage` của boss.
4. Kết quả thật trả về máy nhân viên. Nếu gửi thành công, boss ghi `handled_by_employee` cho tin đó và báo "nhân viên đã gửi" cho những người được dùng tài khoản đó.

**Sự kiện.** Thêm `fb:onMessage`, `fb:onReaction`, `fb:onSeen`, `fb:onUnsend`, `fb:onEdit`, `fb:onContactUpdate`, `fb:onThreadInfoUpdate`, `fb:onConnectionStatus` vào danh sách chuyển tiếp; người nhận tính theo `fbAccountId`. `fb:onTyping` và `fb:onPresence` không lưu bộ đệm. Máy nhân viên chuyển các sự kiện này vào giao diện.

**Giao diện.**
- Màn hình gán tài khoản: chia nhóm theo kênh, ghi rõ "Page" và "Facebook cá nhân"; dòng Facebook cá nhân bị khoá kèm ghi chú "chưa mở cho nhân viên".
- Máy nhân viên: tài khoản Page hiện trong danh sách tài khoản, hội thoại và tin nhắn dùng lại giao diện hiện có; kéo lên tải tin cũ được bật cho Page; ẩn nút "Đồng bộ lịch sử" và các nút quản lý tài khoản.

### 3.4 Lỗi và nối lại

- Mất kết nối tới boss: lệnh gửi trả lỗi "chưa nối được máy boss", giao diện không báo đã gửi.
- Boss chờ Facebook quá lâu: giới hạn 60 giây cho tin chữ và tải tin cũ, 90 giây cho tệp (dưới giới hạn 100 giây của Cloudflare Tunnel).
- Hộp thư Page trên boss đang nối lại: nhân viên nhận đúng thông báo lỗi mà boss nhận.
- Quyền hoặc tài khoản được gán thay đổi: boss đẩy cập nhật qua Socket.IO, máy nhân viên tải lại ảnh chụp trạng thái.

### 3.5 An toàn và quay lui

- Mỗi đợt là một bản phát hành riêng; lùi bằng cách cài lại bản trước. Đợt 1 có một thay đổi dữ liệu duy nhất là đổi khoá ký, không có đường lùi cần thiết (lùi bản cũ thì nhân viên đăng nhập lại).
- Không ghi cookie, token, nội dung tin, đường dẫn tải tệp vào log. Log từ chối chỉ ghi mã nhân viên, tên lệnh và lý do.
- Kho mã công khai: bản thiết kế này được commit cùng lúc với bản vá của đợt 1, không sớm hơn.

## 4. Các đợt

| Đợt | Nội dung | Bản dự kiến |
|---:|---|---|
| 1 | Vá kiểm soát truy cập (mục 3.2) | 26.45.0 |
| 2 | Hộp thư Page cho nhân viên (mục 3.3) | 26.46.0 |
| 3 | Nhận bù khi nối lại có mã phiên của boss, tự tải lại khi boss khởi động lại; đồng bộ chạy nền kèm tiến độ | 26.47.0 (`docs/specs/2026-11-17-employee-reconnect-telegram-poster.md`) |
| 4 | Telegram cho nhân viên | 26.47.0 (cùng tài liệu) |
| 5 | Quyền mới cho quản lý đăng Facebook và các trang cấu hình; vai trò quản trị từ xa | 26.47.0: quyền Đăng Facebook theo hồ sơ được gán (cùng tài liệu); các trang cấu hình khác và vai trò quản trị từ xa chưa làm (anh chọn "không mở thêm") |
| 6 | Đặt boss lên máy chủ luôn bật | anh bảo bỏ qua (17/11/2026) |

Facebook cá nhân cho nhân viên không nằm trong đợt nào; chỉ làm khi anh yêu cầu.

## 5. Kiểm thử

- Kiểm thử đơn vị cho từng tệp thuần mới (`employeeAccess`, `relayChannelPolicy`, `bossFileAccess`, `employeeTokenPolicy`, `relayAudience`, `employeeChannelRoutes`).
- Một bảng kiểm thử duyệt qua **mọi** đường REST: nhân viên A hỏi tài khoản chỉ gán cho B phải nhận 403. Thêm đường mới mà quên kiểm thì bảng báo đỏ.
- Từng lỗ hổng ở mục 2.1 có một kiểm thử tái hiện, chạy đỏ trước khi vá.
- Tài khoản Facebook cá nhân được gán nhầm: không có trong ảnh chụp trạng thái, bị từ chối ở đọc, ghi, lệnh `fb:*`, tệp, và không nhận sự kiện.
- Nhận bù: nhân viên mới nối chỉ nhận sự kiện của tài khoản mình được dùng.
- Không gọi Facebook, Zalo, Telegram thật; dữ liệu mẫu tổng hợp.
- Hồi quy: bộ kiểm thử hiện có (224 bộ, 5096 kiểm thử), kiểm kiểu, kiểm tài liệu; hai vòng kiểm trên máy thật với một boss và một nhân viên, mỗi vòng cả sáng lẫn tối, cả cửa sổ rộng lẫn hẹp.

## 6. Rủi ro

| Rủi ro | Xử lý |
|---|---|
| Danh sách lệnh đóng bỏ sót một lệnh nhân viên đang dùng với Zalo, làm hỏng tính năng đang chạy | Lập danh sách từ mọi chỗ máy nhân viên gọi lên boss; kiểm thử so danh sách với các chỗ gọi đó; thử tay các thao tác Zalo chính ở chế độ nhân viên |
| Danh sách khoá cài đặt cho nhân viên thiếu một khoá giao diện cần | Lập từ các chỗ giao diện đọc cài đặt ở chế độ nhân viên; thiếu thì giao diện dùng giá trị mặc định, không lỗi |
| Bắt đăng nhập cho media làm ảnh không hiện ở máy nhân viên | Kiểm trên máy thật qua cả mạng nội bộ lẫn đường hầm trước khi phát hành |
| Em chưa chạy thử chế độ nhân viên trên máy thật trong phiên này | Vòng kiểm đầu tiên của đợt 1 bắt đầu bằng việc dựng một boss và một nhân viên để ghi nhận hành vi hiện tại trước khi sửa |
| Dự án gốc không công bố bộ kiểm thử của họ | Tự viết kiểm thử từ hành vi mô tả trong mã của họ |

## 7. Ngoài phạm vi

- Facebook cá nhân và Telegram cho nhân viên.
- Quyền chi tiết cho đăng bài, hồ sơ trình duyệt, cấu hình.
- Đặt boss lên máy chủ; địa chỉ cố định qua Cloudflare.
- Tái cấu trúc `HttpRelayService` ngoài những chỗ phải sửa.
- Giới hạn tốc độ và hạn mức dùng khoá AI của boss theo từng nhân viên (hiện nhân viên có quyền Trợ lý AI dùng khoá của boss không giới hạn).

## Ghi chú sau phát hành (26.45.0, đợt 1)

Mã đã phát hành khác spec ở các điểm sau:

- Thêm một task cho bản ghi gọi theo mã riêng (nhãn, chiến dịch, thẻ, tin nhắn nhanh, mục thư viện): phải thuộc tài khoản nhân viên được dùng (`src/services/http/recordOwnership.ts`).
- Kiểm đường dẫn tệp mở rộng sang đường dẫn đã lưu (ảnh chiến dịch, đường dẫn khoá dịch vụ Google của workflow) và sang thân yêu cầu REST, không chỉ lệnh proxy.
- Đối tượng nhận của sự kiện có thêm loại `module` (ví dụ `workflow:executed` tới nhân viên có quyền Workflow).
- Sửa việc ghi cài đặt thông báo theo tài khoản: trước đó ghi vào khoá không ai đọc.
- Sửa lỗi mã trong route bật/tắt và sắp xếp nhãn (boss bỏ qua lệnh của nhân viên).
- Danh sách nhân viên khác trong snapshot được rút gọn (mã, tên hiển thị, avatar) chứ không bỏ hẳn.

## Ghi chú sau phát hành (26.46.0, đợt 2)

Mã đã phát hành khác mục 3.3 của tài liệu này ở các điểm sau:

- Sự kiện đang gõ và hiện diện (`fb:onTyping`, `fb:onPresence`) không được chuyển tiếp tới nhân viên (`FACEBOOK_RELAY_CHANNELS` trong `src/services/socket/relayAudience.ts`).
- Ba sự kiện Facebook (`fb:onSeen`, `fb:onContactUpdate`, `fb:onThreadInfoUpdate`) được chuyển tiếp nhưng listener ở giao diện vẫn tắt (danh sách cho phép trong `electron/preload.ts` không đổi), nên tên, ảnh liên hệ và tên hội thoại không làm mới trực tiếp; dấu đã xem tới giao diện qua `event:receipt`.
- Cờ "đây là Page" được suy từ `fb_accounts.parent_facebook_id` (`src/services/http/accountRows.ts`). Bản 26.45.0 dựa vào `parent_zalo_id`, cột không có trong `accounts`, nên loại nhầm cả Page; 26.46.0 sửa.
- Tin gửi được gắn nhân viên chỉ theo mã tin; không đoán theo hội thoại cho Facebook. Lần gửi không có mã tin thì được ghi log mà không gắn nhãn.
- Danh sách chỉ Boss (`boss_only`) rộng hơn mục 3.3: ngoài sửa, thu hồi, chuyển tiếp, ghim, bình chọn, nhóm, chặn còn có báo đang gõ, E2EE, kiểm tra sức khoẻ tài khoản, ghi chú, đồng bộ lịch sử và quét mạng (`src/services/http/employeeChannelRoutes.ts`).
- Hết thời gian chờ được báo riêng (`TIMEOUT`, lệnh có thể đã chạy) tách khỏi mất kết nối (`NOT_CONNECTED`).
- Nhân viên trên Page không thấy "Xoá (chỉ mình tôi)"; trên máy Boss nút này gọi thu hồi, hành vi có từ trước và chưa sửa.
