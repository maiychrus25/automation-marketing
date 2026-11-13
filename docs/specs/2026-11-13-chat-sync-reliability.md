# Đồng bộ tin nhắn Zalo và Facebook: lấy các bản sửa độ ổn định của Deplao 26.9.0–26.11.0

**Ngày:** 2026-11-13  
**Trạng thái:** Anh duyệt spec ngày 13/11/2026. Chặng A–C đã triển khai, gộp vào `main` và phát hành trong 26.35.0 (13/11/2026); chưa kiểm trên tài khoản Zalo/Facebook thật (plan: `docs/plans/2026-11-13-chat-sync-reliability.md`); chặng D (Go) chưa làm, có plan riêng sau.  
**Phạm vi:** Nhận tin, nối lại, số chưa đọc, trạng thái đã nhận/đã xem của Zalo và Facebook cá nhân (kể cả tin Page đi qua tài khoản cha). Fanpage (hộp thư Page riêng) để sau theo quyết định của anh.  
**Nguồn:** Deplao `d47ef56` (26.8.5, điểm tách) → `2162f07` (26.11.0, 06/11/2026) của https://github.com/babyvibe/deplao-builder (MIT). Port bằng tay, từng đoạn; không gộp nhánh, không chép nguyên tệp.

## 1. Mục tiêu

Anh muốn phần đồng bộ tin nhắn Zalo và Facebook của MaiHub ổn định như bản gốc hiện nay.

**Tiêu chí thành công:**
- Tin nhóm Zalo bị Zalo giao hai lần chỉ hiện một lần, không chạy workflow hai lần.
- Zalo bị đóng kết nối (mở Zalo PC, rớt mạng ngắn) thì tự nối lại trên cùng phiên; chỉ đăng nhập lại khi không nối được.
- "Đã nhận / Đã xem" chạy cho Zalo và Facebook.
- Ảnh JPEG XL từ Zalo điện thoại hiện được.
- Số chưa đọc Facebook tăng đúng 1 cho mỗi tin mới; đọc Zalo ở máy khác thì số chưa đọc trong app tự mất.
- Mở app lúc mất mạng: tài khoản Facebook tự nối lại khi có mạng, không bị coi là hết hạn cookie.
- Không hồi quy: gửi tin, Page qua Business Suite, workflow, "Ngắt kết nối" tay của Zalo giữ nguyên hành vi.

## 2. Hiện trạng đã kiểm tra (13/11/2026)

| Mục | MaiHub | Bản gốc |
|---|---|---|
| Sự kiện đã xem Zalo | Nghe `seen` (`src/utils/ZaloLoginHelper.ts:967`); zca-js 2.1.2 phát `seen_messages`/`delivered_messages` nên chưa từng chạy | Nghe đúng tên, ghi mốc đã nhận/đã xem |
| Tin Zalo giao trùng | Không lọc; không có index `idx_messages_cli` | `isDuplicateZaloDelivery` + index theo `(owner_zalo_id, cli_msg_id)` |
| Nối lại Zalo | `listener.start()` (`ZaloLoginHelper.ts:1197`), đóng là đăng nhập lại cả phiên, tối đa 5 lần | `listener.start({ retryOnClose: true })` + chặn listener cũ + watchdog 90 s |
| Ảnh JXL Zalo | Không xử lý | Đổi `/jxl/….jxl` sang `/jpg/….jpg` trên CDN Zalo |
| Đọc ở máy khác (Zalo) | Không có | Đọc frame websocket cmd 504/524 |
| Chưa đọc Facebook | Cộng ở `DatabaseService.saveFBMessage` và cộng lần nữa ở `FacebookService.handleIncomingMessage`; không xét tin đã có | Chỉ cộng khi hàng mới, không phải lịch sử |
| Kiểm cookie Facebook | Lỗi nào cũng trả "hết hạn" (`FacebookService.ts:500`) | Lỗi mạng/429/5xx là tạm thời; thử lại lúc khởi động 15 s / 60 s / 180 s |
| Bridge E2EE | Nối lại cố định 10 s; đăng ký thiết bị mới mỗi lần mở app (`e2eeMemoryOnly: true`); tin cũ trong lúc kết nối đi vào luồng tin mới | Backoff tới 5 phút, heartbeat, hàng đợi sự kiện, lưu thiết bị, không phát lại tin cũ |
| Đã đọc Facebook | `markRead` là hàm rỗng | Có `markRead` (Go) và ReadReceipt (MQTT) |
| Hộp thư Page | Nhận qua MQTT tài khoản cha, gửi qua Business Suite | Không có gì |

Tệp Facebook của MaiHub (trừ phần Page và một sửa tên/ảnh) còn giống hệt `d47ef56`, nên toàn bộ phần sửa Facebook của bản gốc từ 26.9.0 đều chưa có ở MaiHub. Bridge Go của MaiHub đã tồn tại sẵn (`src/bridge-e2ee/`, build bằng `scripts/build-bridge-e2ee.js`, ghim `mautrix/meta` `e012f9f`).

## 3. Quyết định

| # | Quyết định |
|---|---|
| D1 | (anh, 13/11) Làm Zalo và Facebook trước; fanpage để sau. |
| D2 | (đề xuất, chờ anh xác nhận khi duyệt spec) Spec này gồm phần **độ ổn định**. Hai tính năng lấy lịch sử — "đồng bộ từ điện thoại" của Zalo và "đồng bộ theo khoảng ngày" của Facebook — làm ở spec kế tiếp: chúng cần nâng `zca-js` lên 2.2.0, thêm thư viện giải nén và dựa vào giao thức không công bố. |
| D3 | Giữ các điểm MaiHub cố ý khác bản gốc: cờ `manuallyDisconnectedAccounts`, hàng đợi theo nhóm và chờ tên nhóm tối đa 3 s, luồng Page hiện có. |
| D4 | Không lấy bất cứ thứ gì gửi cookie/token ra máy chủ ngoài Zalo/Facebook, tệp `.exe` đã commit của bản gốc, bridge đăng nhập (`fbchat-login-bridge`), Cloudflare sync, Telegram, tính năng Zalo mới không thuộc đồng bộ tin. |

## 4. Zalo

**Z1 — Đã nhận / đã xem.** Nghe `seen_messages` và `delivered_messages` (mảng), xử lý từng phần tử; lỗi một phần tử không chặn phần tử khác. `seen_messages` phát `event:seen` qua `EventBroadcaster.broadcastSeen` hiện có và ghi mốc đã xem; `delivered_messages` ghi mốc đã nhận (mục 6). Bỏ handler `seen` cũ.

**Z2 — Lọc tin giao trùng.** Một tin là bản giao trùng khi đã có dòng khác cùng tài khoản, cùng hội thoại, cùng người gửi, cùng `cli_msg_id`, **cùng nội dung**, và cả hai mang id thật. Bản sau bị bỏ hẳn trước khi lưu: không lưu, không gửi giao diện, không chạy workflow/webhook; ghi một dòng log. Khác nội dung thì vẫn là tin khác. Lỗi khi kiểm tra thì xử lý như tin mới.
- Thêm index một phần `idx_messages_cli ON messages(owner_zalo_id, cli_msg_id) WHERE cli_msg_id IS NOT NULL` ở cả khối tạo schema và khối migration. Truy vấn tra chỉ lọc theo `(owner_zalo_id, cli_msg_id)` rồi so hội thoại/người gửi trong code, để SQLite luôn dùng index này.
- Lần mở đầu tiên sau cập nhật dựng index, có thể lâu với DB lớn (một lần cho mỗi DB).
- Không dọn các cặp trùng đã lưu.

**Z3 — Tự nối lại websocket.** Gọi `listener.start({ retryOnClose: true })` (có sẵn ở zca-js 2.1.2). Thêm `src/utils/zaloListenerRetry.ts` theo ý bản gốc:
- chỉ cho thử lại khi listener còn là listener đang dùng của tài khoản đó: chưa bị "Ngắt kết nối" tay (`manuallyDisconnectedAccounts`), tài khoản chưa xoá, chưa bị phiên mới thay;
- lần thử lại đã hẹn của listener cũ bị chặn, để không có hai listener cùng nhận tin;
- nối lại được thì trả lại lượt thử.
- Trong lúc zca-js tự nối lại, giao diện không báo "mất kết nối". Quá 90 s chưa nối lại, hoặc zca-js phát `closed`, thì đi đường đăng nhập lại hiện có (tối đa 5 lần như nay).

**Z4 — Ảnh JPEG XL.** Hàm thuần dùng chung main/renderer: URL ảnh thuộc host media của Zalo (`zdn.vn`, `zadn.vn`, `zalo.me`, `zaloapp.com`) có `/jxl/….jxl` được đổi sang `/jpg/….jpg` và bỏ tham số `jxlstatus`; URL E2EE (`?e2esession`) giữ nguyên. Áp lúc nhận tin (trước khi lưu/tải) và lúc hiển thị (để tin đã lưu trước đó cũng hiện). Không chạy migration sửa DB cũ.

**Z5 — Đọc ở máy khác.** Đọc frame websocket cmd 504 (chat riêng) / 524 (nhóm) để biết hội thoại đã được đọc trên điện thoại/Zalo PC, đặt số chưa đọc trong DB và phát `db:unreadChanged`. Không gửi "đã xem" ngược lên Zalo. Phần giải mã frame tách thành hàm riêng, không kéo theo module "đồng bộ từ điện thoại". Việc này dựa vào thuộc tính nội bộ `ws` và `cipherKey` của listener zca-js (có ở 2.1.2); nếu lúc làm thấy không dùng được ổn định thì hoãn Z5 sang spec kế tiếp và ghi lại, không chặn các mục khác.

## 5. Facebook

**F1 — Số chưa đọc đúng một lần.** `saveFBMessage` trả kết quả `new` / `repaired` / `duplicate`. Chỉ `new`, không phải tin của mình, không phải tin lịch sử mới tăng `unread_count`. Bỏ lần cộng thứ hai ở `handleIncomingMessage` (vẫn cập nhật tin cuối/giờ cuối). Áp cho cả tin Page nhận qua tài khoản cha. Tin `duplicate` không phát thông báo, không chạy workflow lần hai.

**F2 — Mất mạng không phải hết hạn cookie.** `checkCookieHealth` chỉ trả "hết hạn" khi Facebook từ chối phiên; lỗi DNS/socket/timeout và 429/5xx là tạm thời (ghi log, coi như còn sống). Kết nối lúc khởi động thất bại vì lỗi tạm thời thì thử lại sau 15 s, 60 s, 180 s; hết ba lần thì dừng như nay.

**F3 — Tên và ảnh hội thoại.** Sửa chuỗi lỗi chữ ("Nhm khng tn", "Khng c tn") thành tiếng Việt đúng; ảnh đại diện chat riêng lấy của người kia; số chưa đọc ban đầu lấy từ `unread_count` Facebook trả về.

**F4 — Kết quả GraphQL.** Các lệnh đổi trạng thái (đặt tên, thêm/xoá thành viên…) chỉ báo thành công khi phản hồi không chứa lỗi, kể cả khi HTTP 200.

**F5 — Giám sát bridge E2EE.** Nối lại theo backoff tăng dần tới 5 phút thay cho cố định 10 s; heartbeat khi đang kết nối để phát hiện treo; sự kiện từ bridge đi qua hàng đợi có giới hạn, khoá chống trùng gồm loại sự kiện + id (để reaction/sửa/thu hồi đến ngay sau tin gốc không bị bỏ).

**F6 — Tin mẫu (template) từ Page/bot.** Phân tích tin template thành nội dung đọc được thay cho "File đính kèm không hiển thị"; tin đã lưu rỗng được sửa khi bản đủ nội dung đến (kết quả `repaired`).

**F7 — Đã đọc.** Nhận ReadReceipt từ MQTT và receipt từ bridge để ghi mốc đã nhận/đã xem (mục 6). `markRead` gửi thật: thêm lệnh `markRead` vào bridge Go cho hội thoại E2EE, đường MQTT/GraphQL cho hội thoại thường.

**F8 — Lưu thiết bị E2EE.** Lưu trạng thái thiết bị E2EE theo từng tài khoản trong thư mục dữ liệu của workspace, ghi nguyên tử; lần mở sau dùng lại thiết bị, bridge bỏ bước đăng ký khi thiết bị được khôi phục. Tệp trạng thái chứa khoá: không log nội dung, không gửi đi đâu, xoá khi xoá tài khoản.

**F9 — Không phát lại tin cũ.** Tin bridge trả về thuộc về trước lúc kết nối được lưu im lặng như lịch sử (không tăng chưa đọc, không thông báo, không workflow). Chỉ tin đến sau lúc kết nối đi luồng tin mới.

**Phần Go (F7–F9):** sửa trong `src/bridge-e2ee/`, giữ ghim `mautrix/meta` `e012f9f`. Chỉ nâng ghim khi một bản sửa bắt buộc cần, và khi đó phải build được trên cả ba hệ điều hành ở CI. Không commit tệp nhị phân.

## 6. Mốc đã nhận / đã xem (dùng chung Zalo và Facebook)

Thêm hai cột cộng thêm vào `contacts`: `peer_delivered_ts`, `peer_read_ts` (ms, mặc định 0), chỉ tiến lên. Mỗi lần mốc đổi phát `event:receipt`. Tin mình gửi có thời điểm ≤ mốc hiện "đã nhận" / "đã xem" trong khung chat. Nhóm: một người đã xem là tính đã xem. Telegram không đổi.

## 7. Ngoài phạm vi

Fanpage (hộp thư Page riêng, Messenger Platform, `mautrix/meta` cho Page); "đồng bộ từ điện thoại" của Zalo; đồng bộ lịch sử Facebook theo khoảng ngày; bù tin Facebook lỡ khi app tắt (bản gốc cũng không có); đăng nhập Facebook bằng mật khẩu; chuẩn hoá emoji reaction và sửa QR đăng nhập Zalo (nhỏ, lấy sau nếu anh muốn); dọn dữ liệu trùng đã lưu.

## 8. Ghi nhận và giấy phép

- `NOTICE.md` thêm bảng "Port từ Deplao 26.9.0–26.11.0" như lần trước: nhóm, commit nguồn, tệp đích, điểm MaiHub khác bản gốc.
- `NOTICE.md` ghi rõ sự việc đã có từ trước: bridge E2EE build từ `mautrix/meta` (AGPL-3.0) và `src/bridge-e2ee/bridge/` có mã nguồn gốc `meta-messenger.js` (AGPL-3.0). Đây là ghi nhận sự việc, không phải kết luận pháp lý.
- Câu hỏi mở cho anh (không chặn spec): có gỡ hai tệp `.exe` đang nằm trong git ở `src/bridge-e2ee/build/` không (CI tự build).

## 9. Kiểm thử

- **Tự động (không gọi Zalo/Facebook thật):** hàm thuần và DB tạm cho Z2 (trùng/khác nội dung/id tạm), Z4 (URL), Z5 (frame mẫu tự dựng), F1 (kết quả lưu, chưa đọc), F2 (phân loại lỗi), F4, F6, mốc mục 6; listener giả cho Z1 và Z3 (chặn listener cũ, trả lượt thử, watchdog bằng đồng hồ giả); pipeline F5. Phần Go có test Go cho F8, F9.
- **Kiểm chứng như CI:** Jest UTC + New York seed 2707 + Hồ Chí Minh seed 3707, bridge Python, tsc ×2, `check-docs`; build bridge Go ở CI trên ba hệ điều hành.
- **Kiểm tay trên tài khoản thật (anh làm, sau khi cài):** mở Zalo PC rồi xem app tự nối lại; bấm "Ngắt kết nối" không tự nối lại; nhắn vào nhóm đông xem không trùng; đọc trên điện thoại xem số chưa đọc mất; gửi ảnh từ Zalo điện thoại; Facebook: nhận tin tăng đúng 1, mở app lúc tắt mạng rồi bật mạng, chat mã hoá sau khi mở lại app, tin Page vẫn về.

## 10. Triển khai

Chia chặng trong plan: (A) Zalo Z1–Z5, (B) Facebook TypeScript F1–F6, (C) mốc đã nhận/đã xem, (D) Facebook Go F7–F9. Phát hành A–C trước; D phát hành sau khi anh thử chat mã hoá trên tài khoản thật. Mỗi lần phát hành là bước anh duyệt riêng.

## 11. Rủi ro

- Z3, Z5, F8, F9 không kiểm được bằng test tự động với máy chủ thật; chỉ biết chắc sau khi anh thử.
- Z5 dựa vào nội bộ zca-js và giao thức không công bố, có thể hỏng khi Zalo hoặc zca-js đổi.
- F8 lưu khoá thiết bị ra đĩa: ghi sai có thể làm mất phiên mã hoá và phải đăng ký lại (như hiện nay).
- Sửa Go có thể đụng API của `mautrix/meta` ở bản ghim; nếu phải nâng ghim thì phạm vi chặng D tăng.
- Dựng index mới làm lần mở đầu chậm với DB lớn.

## Ghi chú sau triển khai

Chặng A–C (13/11/2026). Thân spec ở trên giữ nguyên; các điểm code khác hoặc chi tiết hơn spec:

- **Z5 đã làm, không hoãn:** `listener.ws` của zca-js 2.1.2 nhận `on('message')` ổn định nên R8 không kích hoạt. `src/services/zalo/zaloReadElsewhere.ts` theo sát bản gốc Deplao (MIT), phần giải mã frame viết lại; có ghi nhận ở `NOTICE.md`.
- **Ruling R1–R7 (code khác chữ của spec):** R1 nhãn "Đã nhận"/"Đã xem" chỉ dưới tin mình gửi cuối cùng; R2 tin mẫu lưu thành chữ, không có thẻ/kiểu `fb.template`; R3 nửa nhận của F7 (ghi mốc từ MQTT) làm ở chặng C, `markRead` gửi thật để chặng D; R4 JXL chỉ đổi URL thuộc host media Zalo, không migration; R5 phản hồi GraphQL không phải JSON giữ hành vi cũ; R6 trong lúc zca-js tự nối lại không phát `event:disconnected`; R7 `unread_count` Facebook chỉ dùng khi tạo hội thoại.
- **Ruling trong lúc triển khai:**
  - Truy vấn trùng Zalo thêm `AND cli_msg_id IS NOT NULL` để SQLite dùng được index một phần.
  - `isCurrent` của listener Zalo bỏ điều kiện cờ ngắt tay (ngắt tay xoá kết nối đồng bộ nên đối chiếu danh tính là đủ; cờ vẫn chặn đăng nhập lại).
  - Z5 thêm nhánh renderer cho `db:unreadChanged` nguồn `zalo_read_elsewhere`; cờ `has_mention` chỉ tắt trong DB.
  - F1: tin mới = `INSERT OR IGNORE` vào `messages` hợp nhất có thay đổi (theo từng tài khoản), không dựa `fb_messages`.
  - F4: lỗi chỉ ném khi phản hồi không có dữ liệu dùng được; có `data` kèm `errors` là thành công một phần (cảnh báo).
  - F5: pipeline chỉ bảo đảm thứ tự phát (xem giới hạn dưới).
  - F6: `repaired` báo giao diện bằng `fb:onEdit` kèm `repair: true`, không gắn nhãn "đã chỉnh sửa".
  - Sự kiện `seen` của bridge E2EE cũng ghi mốc đã xem (để chat mã hoá không mất "Đã xem").
- **Giới hạn đã biết:**
  - Mốc đã nhận/đã xem chỉ ghi cho hội thoại Facebook cá nhân, không cho hộp thư Page.
  - Bản sửa chỉ thêm đính kèm (không chữ) không phát gì, bong bóng cập nhật khi tải lại.
  - Pipeline bridge chỉ bảo đảm thứ tự phát, không bảo đảm thứ tự hoàn tất: huỷ/sửa đến trước khi tin gốc lưu xong vẫn có thể mất (như trước kế hoạch này).
  - Làm mới danh sách hội thoại không còn đặt lại chưa đọc Facebook, nên hội thoại đã đọc trên điện thoại giữ huy hiệu đến khi mở trong MaiHub.
  - Nhãn "Đã nhận"/"Đã xem" chưa được xem bằng mắt trong ứng dụng đang chạy (chỉ kiểm bằng test).
- Review cuối phát hiện và đã sửa việc ba luồng Zalo mới (lọc tin giao trùng, đọc ở máy khác, mốc nhận/xem) chạy sai DB khi đang mở workspace khác: nay chạy trên DB boss như nơi tin được lưu.
