# Nhân viên dùng chung: nối lại và đồng bộ nền, Telegram, Đăng Facebook

**Ngày:** 2026-11-17  
**Trạng thái:** Đã triển khai trong 26.47.0 (17/11/2026), phát hành một lần cho cả ba đợt. Chưa chạy trên cặp máy boss + nhân viên thật, chưa gọi Telegram và Facebook thật; xem "Ghi chú sau phát hành" ở cuối tài liệu cho các chỗ mã khác bản thiết kế này.  
**Phạm vi:** Đợt 3, 4, 5 của `docs/specs/2026-11-17-employee-shared-inbox.md`. Đợt 6 (đặt boss lên máy chủ) đã bỏ.  
**Nguồn:** Hai lượt rà code ngày 17/11/2026 (bản 26.46.0) và thiết kế của dự án gốc `babyvibe/deplao-builder` tại commit `515f1dc` (MIT), chuyển bằng tay.

## 1. Mục tiêu

- Nhân viên mất kết nối rồi nối lại (rớt mạng, máy ngủ, boss khởi động lại) thì dữ liệu trên màn hình tự đúng trở lại, không phải đăng nhập lại hay mở lại app.
- Việc đồng bộ lâu không chặn màn hình.
- Nhân viên được gán tài khoản Telegram dùng được hộp thư Telegram từ máy mình.
- Nhân viên có quyền "Đăng Facebook" soạn bài, lên lịch, chạy đăng bằng các hồ sơ trình duyệt được gán cho mình.

**Không đổi:** các nguyên tắc ở mục 3.1 của bản thiết kế trước (đóng mặc định, kiểm tra ở máy boss, một nguồn cho "thứ nhân viên được dùng", bí mật không rời máy boss, logic thuần tách riêng). Boss dùng một mình và các luồng nhân viên đã có giữ nguyên hành vi.

## 2. Hiện trạng (26.46.0)

| Việc | Hiện nay | Hệ quả |
|---|---|---|
| Số thứ tự sự kiện | Một bộ đếm trong bộ nhớ, bắt đầu lại từ 1 mỗi lần app boss khởi động; không có mã phiên | Boss khởi động lại thì máy nhân viên đang giữ số lớn không nhận bù được gì cho tới khi số của boss vượt qua |
| Nhận bù | Không báo cho máy nhân viên khi bộ đệm (5000 sự kiện) đã cắt mất phần cần; kết nối mới xin từ số 0 thì nhận lại cả bộ đệm, kể cả "đang soạn" | Dữ liệu thiếu mà không ai biết; phát lại thừa |
| Tải lại sau khi gián đoạn | Chỉ tải lại hội thoại khi danh sách đang trống; không có gì chạy khi máy thức dậy | Danh sách cũ nhưng không trống thì không bao giờ được làm mới |
| Sự kiện bị bỏ | Sáu loại sự kiện được boss chuyển đi nhưng máy nhân viên bỏ (số chưa đọc, xoá hội thoại, cập nhật hồ sơ khách, thẻ CRM, thư viện, xoá hồ sơ ERP) | Số chưa đọc và danh sách lệch dần |
| Đồng bộ chặn màn hình | Đăng nhập nhân viên chờ tải 200 hội thoại cho từng tài khoản, lần lượt; đồng bộ thành viên nhóm (CRM) phủ kín màn hình | Không làm gì khác được trong lúc chờ |
| Telegram | Lệnh `telegramUser:*` (68) và `telegram:*` (38) chạy tại máy nhân viên và báo "chưa kết nối"; tám loại sự kiện Telegram không được chuyển | Nhân viên không dùng được Telegram |
| Đăng Facebook | Bị chặn ở máy nhân viên và không có trong danh sách lệnh của boss; chạy theo hồ sơ trình duyệt, không theo tài khoản được gán | Nhân viên không dùng được |

## 3. Đợt 3: nối lại, nhận bù, đồng bộ nền

### 3.1 Mã phiên và nhận bù
- Mỗi lần máy chủ chuyển tiếp khởi động là một **luồng** mới, có `bootId` ngẫu nhiên. Số thứ tự bắt đầu từ `thời điểm khởi động (ms) × 1000 + 1`, nên luồng sau luôn có số lớn hơn luồng trước.
- Mỗi sự kiện gửi đi kèm `bootId`. Máy nhân viên nhớ cặp `{bootId, lastSeqId}`.
- Khi nối lại, máy nhân viên gửi `catch-up { proto: 2, bootId, lastSeqId }` và chờ trả lời:
  - cùng `bootId`, bộ đệm còn đủ từ `lastSeqId`, và số sự kiện cần phát không quá 500 → phát lại (đã lọc theo quyền hiện tại) rồi trả `{ status: 'replayed' }`;
  - còn lại → trả `{ status: 'reset', reason }` với `reason` là `boss-restart`, `gap` hoặc `fresh`, và không phát lại gì.
- Sự kiện chỉ có nghĩa tức thời (`event:typing`, `event:userPresence`, `fb:onTyping`, `fb:onPresence`) không vào bộ đệm.
- Máy nhân viên bản cũ (không gửi `proto`) được phát lại như hiện nay, có lọc.

### 3.2 Tải lại sau khi gián đoạn
- Máy nhân viên phát `employee:resync` (kèm lý do) cho giao diện khi: nhận `reset`; boss không trả lời `catch-up` trong 10 giây; heartbeat thành công trở lại sau khi hỏng; máy thức dậy (`powerMonitor` `resume`).
- Giao diện gom các tín hiệu trong 500 ms, không chạy chồng, rồi tải lại qua REST: danh sách hội thoại của mọi tài khoản được dùng (kể cả khi đang có sẵn), tin của hội thoại đang mở, số chưa đọc. Trong lúc tải có một dòng trạng thái nhỏ, không chặn thao tác.
- Trạng thái kết nối Socket.IO được đưa lên giao diện cùng với heartbeat, để huy hiệu Online / Offline không lệch.

### 3.3 Sự kiện bị bỏ
Danh sách sự kiện được chuyển tiếp nằm ở một hằng dùng chung cho máy boss và máy nhân viên, nên hai phía không lệch nhau. Sáu loại đang bị bỏ được chuyển tới giao diện; loại nào mà phần xử lý ở giao diện chưa từng chạy thì không bật trong đợt này (cùng quy tắc với đợt 2).

### 3.4 Đồng bộ nền
- **Đăng nhập nhân viên:** vào app ngay sau khi xác thực; hội thoại của các tài khoản tải nền, song song tối đa 3 tài khoản, có dòng tiến độ ("Đang tải hội thoại 2/5").
- **Đồng bộ thành viên nhóm (CRM):** bỏ lớp phủ kín màn hình; chạy trong một bảng nổi thu nhỏ được, có tiến độ và nút dừng, vẫn chạy khi chuyển sang màn hình khác. Áp dụng cho cả boss.
- **Bảng khởi tạo tài khoản Zalo** không mở ở chế độ nhân viên (nó đọc cơ sở dữ liệu trống tại máy nhân viên).
- "Đồng bộ lịch sử" cả tài khoản và đồng bộ Zalo từ điện thoại vốn đã chạy nền trên máy boss; vẫn chỉ boss bấm được.

## 4. Đợt 4: Telegram cho nhân viên

- **Phân loại lệnh** trong `employeeChannelRoutes.ts`, cùng ba nhóm như Facebook, cho cả `telegramUser:*` và `telegram:*`. Chỉ boss: gửi mã, đăng nhập, 2FA, bật tắt listener / bot, kiểm tra bot, trạng thái phiên, ảnh đại diện của chính tài khoản, quét forum nền. Chuyển lên boss (quyền Tin nhắn; chặn / danh bạ cần Bạn bè hoặc Tin nhắn): gửi, sửa, xoá, chuyển tiếp, ghim, cảm xúc, đã đọc, hội thoại, nhóm / forum, danh bạ, nhãn dán / GIF, mini app, đọc tin và sửa media. Kiểm thử quét hai tệp IPC, báo đỏ khi có lệnh chưa xếp nhóm.
- **Tài khoản:** `accountId` bắt buộc và phải là tài khoản được dùng. Chuỗi phiên và token bot (cột `cookies`) không bao giờ có trong phản hồi.
- **Tệp:** các trường đường dẫn của Telegram (`photoPath`, `audioPath`, `stickerPath`, `animPath`) vào chung một hằng với các trường đã có; máy nhân viên tải lên theo hằng đó và máy boss kiểm theo đúng hằng đó.
- **Sự kiện:** thêm `event:telegramReaction`, `event:messageEdited`, `event:messagesDeleted`, `event:forumTopicsChanged`, `event:telegramEntityHydrated`, `event:groupMemberAvatar`, `event:telegramSync` vào danh sách chuyển tiếp (đều mang `zaloId`, giao diện đã có phần xử lý đang chạy trên boss).
- **Dữ liệu ở máy nhân viên:** tin Telegram được chuyển tới không ghi vào cơ sở dữ liệu tại máy bằng khuôn của Zalo; giao diện đọc từ máy boss. Dòng hội thoại và tin nhắn Telegram trả qua REST mang đủ các cột mà giao diện Telegram dùng.
- **Trạng thái trực tuyến** của tài khoản Telegram lấy từ listener / bot đang chạy trên boss.
- **Media:** thư mục ảnh đại diện Telegram được phục vụ cho nhân viên đã đăng nhập; thêm kiểu tệp `.webm`, `.tgs`, `.oga`, `.opus`, `.m4a`.
- **Ghi nhận người gửi:** như Page, theo mã tin.
- **Giao diện:** ẩn với nhân viên các nút chỉ boss làm được; không chạy kiểm tra trạng thái phiên tại máy nhân viên.

## 5. Đợt 5: Đăng Facebook cho nhân viên

### 5.1 Phạm vi anh đã chọn (17/11/2026)
1. Mức mở: **soạn, lên lịch và chạy**. Nhân viên xem lịch đăng, lịch sử, số liệu, khách tiềm năng, bình luận đã thu; soạn bài; tạo, sửa, xoá lịch đăng và chiến dịch; bấm chạy và huỷ. Chưa gồm Nghiên cứu, Video, Chờ duyệt.
2. Hồ sơ: **chỉ hồ sơ được gán** cho từng nhân viên.
3. Cấu hình khác: **không mở thêm**. Chỉ hai cấu hình nằm trong Đăng Facebook được mở: khách tiềm năng và theo dõi bài đăng.

### 5.2 Quyền và hồ sơ
- Khoá quyền mới `fb_poster` ("Đăng Facebook"), mặc định tắt. Danh sách module dùng chung một hằng cho mọi màn hình sửa quyền, để màn hình này không xoá khoá của màn hình kia khi lưu.
- Bảng mới `employee_profile_access(employee_id, profile_id)`. Boss gán hồ sơ trong màn hình nhân viên (mục "Hồ sơ đăng Facebook", hiện khi bật quyền). `allowedProfiles(employee)` = hồ sơ được gán và còn tồn tại.

### 5.3 Kiểm tra ở máy boss
Mỗi lệnh `facebookPoster:*` được chuyển lên phải qua, theo thứ tự: quyền `fb_poster`; mọi `profileId` / `profileIds` trong tham số thuộc hồ sơ được dùng; bản ghi gọi theo mã (lịch đăng, bản nháp, chiến dịch, lượt chạy, khách tiềm năng, theo dõi) thuộc toàn hồ sơ được dùng; kết quả dạng danh sách được lọc còn các dòng thuộc toàn hồ sơ được dùng; đường dẫn tệp (`mediaPaths`) nằm trong thư mục tải lên.

| Nhóm | Lệnh |
|---|---|
| Chuyển lên boss | lịch đăng, bản nháp, chiến dịch (xem, tạo, sửa, xoá); chạy, huỷ, đang chạy; lịch sử lượt chạy; nhóm và điểm nhóm, giờ đăng tốt; bình luận đã thu, thu bình luận; khách tiềm năng (xem, sửa); theo dõi bài đăng, số liệu; trạng thái đăng nhập của hồ sơ, kiểm tra đăng nhập; cấu hình khách tiềm năng và theo dõi (đọc, ghi); `browserProfile:list` (chỉ hồ sơ được dùng, chỉ mã, tên, trạng thái) |
| Tại máy | chọn ảnh, video cho bài (hộp thoại trên máy nhân viên; tệp được tải lên boss khi lưu hoặc chạy) |
| Chỉ boss | xuất tệp (hộp thoại lưu mở trên máy boss); cấu hình kiểm tra đăng nhập, thông báo; `engagement:*`; `autonomy:*`; `research:*`; `video:*`; mọi `browserProfile:*` khác |

### 5.4 Sự kiện
Thêm loại người nhận theo hồ sơ. Sự kiện mang nội dung (nhật ký, tiến độ, khách tiềm năng tìm thấy) chỉ tới nhân viên được dùng hồ sơ của lượt chạy đó; không xác định được hồ sơ thì không tới ai. Sự kiện chỉ báo "có thay đổi, hãy tải lại" tới nhân viên có quyền `fb_poster`, và danh sách tải lại đã được lọc.

### 5.5 Giao diện
Nhân viên có quyền thấy mục Đăng Facebook với các tab: Lịch đăng, Chiến dịch, Tham gia nhóm, Thu bình luận, Khách tiềm năng, Lịch sử. Ẩn: Video, Nghiên cứu, Chờ duyệt, màn hình Trình duyệt, nút xuất tệp, cấu hình kiểm tra đăng nhập và thông báo. Bộ chặn điều hướng kiểm cả `facebookPoster` và `browser`.

### 5.6 Điều boss cần biết
Khi nhân viên bấm chạy, cửa sổ trình duyệt của hồ sơ hiện trên màn hình máy boss và dùng phiên Facebook của boss; tối đa 2 lượt chạy cùng lúc cho cả boss lẫn nhân viên.

## 6. Kiểm thử

- Mỗi tệp thuần mới có kiểm thử đơn vị; dữ liệu mẫu đúng hình dạng bảng thật.
- Nhận bù: cùng luồng thì phát lại đúng phần thiếu; khác `bootId`, thủng bộ đệm, quá 500 sự kiện, kết nối mới đều trả `reset`; nhân viên bị rút quyền không nhận lại sự kiện cũ.
- Telegram và Đăng Facebook: bảng phân loại khớp với handler thật theo cả hai chiều; tài khoản / hồ sơ không được dùng bị từ chối ở lệnh, bản ghi, danh sách và sự kiện; tệp ngoài thư mục tải lên bị từ chối.
- Hồi quy: cả bộ Jest ở ba cấu hình, kiểm kiểu, kiểm tài liệu, Python; hai vòng kiểm giao diện ở cỡ rộng và hẹp, sáng và tối cho các màn hình có thay đổi.
- Không gọi Facebook, Zalo, Telegram thật.

## 7. Rủi ro

| Rủi ro | Xử lý |
|---|---|
| Ba đợt chưa từng chạy trên cặp máy thật | Ghi rõ trong ghi chú phát hành; review toàn nhánh lần theo từng luồng qua mã thật |
| Đổi cách nhận bù làm máy nhân viên bản cũ lệch dữ liệu | Giữ đường phát lại cũ cho yêu cầu không có `proto`; yêu cầu cả hai máy cùng lên bản mới |
| Bỏ lớp phủ của đồng bộ nhóm làm người dùng tưởng đã dừng | Bảng nổi luôn hiện tiến độ; thu nhỏ vẫn còn huy hiệu |
| Nhân viên chạy đăng bằng hồ sơ không phải của mình | Kiểm hồ sơ ở lệnh, bản ghi, danh sách và sự kiện; kiểm thử cho từng đường |
| Tệp bài đăng trỏ ra ngoài thư mục tải lên | `mediaPaths` vào chung hằng trường đường dẫn; kiểm thử ghim mọi chỗ tải tệp |
| Một quyền `fb_poster` cho nhiều lệnh | Lệnh chạy trên màn hình boss, xuất tệp và cấu hình hệ thống xếp vào nhóm chỉ boss |

## 8. Ngoài phạm vi

- Facebook cá nhân cho nhân viên; Nghiên cứu, Video, Chờ duyệt, Trình duyệt, Proxy, Tự vận hành, Tài khoản, Nhân viên, Workspace, Điều khiển từ bot cho nhân viên.
- Nhân viên bấm "Đồng bộ lịch sử" cả tài khoản từ máy mình.
- Xuất tệp Đăng Facebook từ máy nhân viên.
- Màn hình xem lịch sử phiên Facebook.
- Các việc đang chờ anh quyết ở 26.45.0 và 26.46.0 (nhãn dùng chung, quyền Workflow, "Xóa (chỉ mình tôi)" trên Facebook, ba lỗi cũ ở chế độ nhân viên).

## Ghi chú sau phát hành (26.47.0)

Thân tài liệu giữ nguyên như lúc thiết kế. Các chỗ mã khác thiết kế:

- **Mục 3.1:** sự kiện tức thời không mang số thứ tự; socket vào phòng sau lần `catch-up` đầu (hoặc sau 2000 ms). Giới hạn 500 đếm số sự kiện mà chính nhân viên đó được nhận, không đếm cả luồng. Luồng chưa phát sự kiện nào và mã phiên khớp thì trả `replayed`, không `fresh`.
- **Mục 3.2:** sự kiện `employee:resync` mang thêm `workspaceId`. Tin của hội thoại đang mở được trộn theo mã; khi trang tải về không nối liền với phần đang có thì thay cả cửa sổ. Tải lại chỉ chạy sau khi lượt tải đầu xong.
- **Mục 3.3:** số kênh từng bị bỏ ở máy nhân viên nhiều hơn sáu kênh nêu trong thiết kế; `db:unreadChanged` có phần xử lý ở giao diện, các kênh được chuyển tiếp nhưng chưa có phần xử lý nằm trong `RENDERER_DORMANT_CHANNELS` (`src/services/socket/relayChannels.ts`).
- **Mục 3, giới hạn:** sau một lần `reset`, thông báo ERP, nhắc hẹn, tiến độ hàng đợi CRM, sự kiện workflow và tích hợp phát sinh trong lúc mất kết nối không được phát lại.
- **Mục 4:** chuyển tiếp tám kênh sự kiện (thêm `event:userPresence`), không phải bảy. `refreshMessages` (đồng bộ lại cả tài khoản) thuộc nhóm chỉ boss. Người gửi được ghi theo mã tin và đúng hội thoại; nhãn dán, GIF, chuyển tiếp, bình chọn, danh thiếp, vị trí chỉ có trong nhật ký hành động. Ghim của hội thoại Telegram ở máy nhân viên đọc từ máy boss.
- **Mục 5.2:** thay đổi quyền và hồ sơ được gán tới máy nhân viên qua `relay:permissionUpdate`.
- **Mục 5.3:** thêm hai lần từ chối: `WORKSPACE_MISMATCH` (cơ sở dữ liệu máy chủ chuyển tiếp ghim khác workspace boss đang mở) và từ chối khi tra cứu lỗi. Lịch đăng, bản nháp, lượt chạy và chiến dịch do Page tự vận hành quản lý chỉ boss dùng được. Huỷ lượt chạy và xoá lịch đăng cần bản ghi tồn tại. `takeMissed` thuộc nhóm chỉ boss. Tệp bài đăng của nhân viên tải lên với `X-Upload-Area: poster`. Nhân viên thấy lịch sử trong 1000 lượt chạy gần nhất. Trạng thái việc dùng chung (theo dõi bài, thu bình luận) chỉ còn đang chạy và tiến độ.
- **Mục 5.4:** nhật ký và tiến độ lượt chạy, tiến độ theo dõi bài và thu bình luận là sự kiện tức thời (không phát lại); nhật ký và tiến độ lượt chạy không tới nhân viên với lượt chạy do Page tự vận hành quản lý. Tiến độ kiểm tra đăng nhập vẫn được phát lại vì giá trị rỗng cuối cùng là tín hiệu kết thúc duy nhất. Sau `employee:resync`, màn hình Đăng Facebook gọi lại `active()` và khép các lượt chạy máy boss không còn báo.
- **Mục 5.5:** `research:openLink` (mở liên kết Facebook bằng trình duyệt của chính máy nhân viên) chạy cục bộ trên máy nhân viên; mọi lệnh Nghiên cứu khác vẫn bị chặn ở chế độ nhân viên. Nhân viên chưa được gán hồ sơ nào thấy lời nhắc thay cho các tab.
- **Ngoài thiết kế, làm cùng bản:** cổng `POST /event` trên máy nhân viên kiểm `X-Boss-Token`; tải tệp giới hạn 200 MB và lưu vào thư mục con riêng; lệnh nhắm vào một bản ghi theo mã bị từ chối khi boss đang ở workspace khác; lọc danh sách hội thoại trong bộ nhớ ở máy nhân viên; thân yêu cầu JSON tới máy chủ chuyển tiếp giới hạn 16 MB (đăng nhập và heartbeat 64 KB); mỗi lệnh ghi thành công của nhân viên ở Đăng Facebook để lại một dòng nhật ký trên máy boss.
- **Chưa làm, chờ anh quyết định:** khi boss ở workspace khác, lệnh không nhắm vào bản ghi theo mã (gửi tin, đánh dấu đã đọc…) vẫn chạy và ghi vào workspace đang mở; tìm kiếm tin nhắn ở máy nhân viên không trả kết quả (lỗi có từ trước); lịch đăng do nhân viên tạo không ghi người tạo và vẫn chạy sau khi boss gỡ hồ sơ hoặc gỡ quyền của người đó; chưa có hạn mức riêng cho từng nhân viên (số lịch đăng, chiến dịch, dung lượng tải lên, suất chạy). Việc ghi người tạo lịch đăng và tạm dừng lịch khi gỡ hồ sơ, gỡ quyền, vô hiệu hoá hoặc xoá nhân viên đã làm xong ở 26.48.0 (lịch tạo trước 26.48.0 không có người tạo nên không bị tạm dừng).

