# Giao thức điều khiển MaiHub (MaiHub Control Protocol v1)

Tài liệu cho người viết bot. Đặc tả thiết kế gốc: `docs/specs/2026-10-14-maihub-control-protocol.md`; cài bridge trên VPS bot: `tools/maihub-bridge/README.md`. Khi tài liệu và mã khác nhau thì mã đúng: `GET /v1/describe` luôn trả danh sách thao tác và schema hiện hành.

## 1. Tổng quan

```
Telegram ⇄ bot AI (VPS Linux, Claude CLI)
                │  công cụ MCP "maihub" (stdio)  /  CLI
                ▼
        maihub_bridge.py ── HTTPS + khoá Bearer + ghim chứng chỉ ──▶ MaiHub (máy Windows, tiến trình chính)
                                                                    → cùng hàm với IPC "Đăng Facebook" của app
```

- MaiHub mở một máy chủ HTTPS trong tiến trình chính, mặc định **tắt**; chủ máy bật trong Cài đặt.
- Bot không cần tên miền hay CA: chứng chỉ tự ký, bot **ghim dấu vân tay SHA-256**.
- Mọi thao tác gọi đúng hàm mà giao diện app dùng (Đăng Facebook: nháp, lịch, run), nên kiểm tra, giới hạn và thông báo lỗi giống hệt khi thao tác trong app.
- Bot không cần cho MaiHub gọi ngược: bot hỏi kết quả bằng `events.wait` (long-poll).
- API chỉ phục vụ **workspace đang mở** của MaiHub; cấu hình, khoá và sự kiện đều theo workspace (xem mục 2.3).

## 2. Cài đặt

### 2.1 Phía MaiHub (chủ máy làm một lần)

Cài đặt → **Điều khiển từ bot** (ẩn ở chế độ nhân viên):

1. Nhập **Cổng** (mặc định `47321`, hợp lệ `1024`–`65535`).
2. Nhập **IP được phép**, mỗi dòng một IP hoặc CIDR IPv4 (ví dụ `161.248.81.164` hay `10.0.0.0/24`). **Bắt buộc có ít nhất một mục** mới bật được. Chỉ IPv4: máy chủ lắng nghe IPv4 (`0.0.0.0`) nên IPv6 và `::1` không dùng được. Tránh dải rộng (như `/8`, `/0`): app cảnh báo khi dải rộng hơn `/16`.
3. Bật công tắc rồi lưu. Máy chủ chạy ngay; lỗi bind cổng (cổng bận, không đủ quyền) hiện ngay trong màn hình, app không bị lỗi.
4. Mục **Khoá truy cập** → đặt tên (1–60 ký tự, ví dụ `bot-telegram`) → **Tạo khoá**. Khoá dạng `mh_<base64url>` **chỉ hiện một lần**; sao chép ngay. MaiHub chỉ lưu SHA-256 của khoá. Thu hồi từng khoá bằng **Thu hồi**.
5. Mục **Thông tin kết nối** hiện địa chỉ `https://<ip-may-maihub>:<cổng>` và **dấu vân tay SHA-256** của chứng chỉ. Bot cần cả hai.
6. App không tự mở cổng Windows. Mục **Tường lửa Windows** hiện sẵn lệnh để chạy trong PowerShell quản trị:

```powershell
netsh advfirewall firewall delete rule name="MaiHub Control API"
netsh advfirewall firewall add rule name="MaiHub Control API" dir=in action=allow protocol=TCP localport=47321 remoteip=161.248.81.164
```

Lần đầu máy chủ lắng nghe, Windows có thể hiện hộp thoại Tường lửa của Windows: chọn **Cho phép truy cập** (Allow). Nếu đã bấm **Hủy** (Cancel), Windows tạo luật *chặn* cho `MaiHub.exe`: vào Windows Defender Firewall → Inbound Rules, xoá luật chặn đó rồi chạy lại lệnh trên.

Đổi cổng, danh sách IP hay cờ bật sẽ dừng rồi chạy lại máy chủ (kết nối cũ bị ngắt). **Tạo lại chứng chỉ** đổi dấu vân tay: mọi bot đã ghim phải cập nhật `MAIHUB_CERT_SHA256`.

### 2.2 Phía bot (VPS Linux)

Chi tiết từng lệnh ở `tools/maihub-bridge/README.md`. Tóm tắt:

```bash
# 1. Chép maihub_bridge.py (Python >= 3.6, chỉ stdlib) và tạo .env quyền 600
cat /opt/bot/maihub/.env
MAIHUB_URL=https://<ip-may-maihub>:47321
MAIHUB_API_KEY=mh_...
MAIHUB_CERT_SHA256=<dau-van-tay-sha256>

# 2. Kiểm tra: cấu hình, TCP, ghim chứng chỉ, /v1/health, xác thực khoá
python3 /opt/bot/maihub/maihub_bridge.py --env-file /opt/bot/maihub/.env doctor

# 3. Đăng ký MCP cho Claude CLI (chạy bằng đúng user chạy bot)
claude mcp add maihub -- python3 /opt/bot/maihub/maihub_bridge.py mcp --env-file /opt/bot/maihub/.env
```

Danh sách tool MCP sinh tự động từ `GET /v1/describe` (`maihub_<thao_tac>`, dấu chấm thành gạch dưới), cộng `maihub_upload_media`; MaiHub thêm thao tác mới thì bot dùng được ngay.

### 2.3 Phạm vi workspace

Cấu hình `{ enabled, port, allowList }` nằm trong `app_settings` của workspace; bảng `control_keys`, `control_audit`, `control_events`, `control_idempotency` nằm trong DB của workspace. Đổi hoặc xoá workspace đang mở thì API dừng, rồi chạy lại theo cấu hình của workspace mới: **khoá của workspace cũ không dùng được ở workspace mới** và ngược lại.

## 3. Vận chuyển và bảo mật

| Hạng mục | Quy định |
|---|---|
| Giao thức | HTTPS (TLS) trên `0.0.0.0:<cổng>`, JSON UTF-8 |
| Chứng chỉ | Tự ký RSA-2048, CN `maihub-control`, hạn 10 năm, tạo lần đầu bật. Khoá riêng mã hoá bằng `safeStorage` (không có thì tệp quyền 0600 kèm cảnh báo trong Cài đặt) |
| Ghim chứng chỉ | SHA-256 của **chứng chỉ đầu cuối ở dạng DER**, viết dưới dạng **hex chữ thường, 64 ký tự, không dấu hai chấm**. Bridge chấp nhận cả có dấu hai chấm/chữ hoa và tự chuẩn hoá. Lệch ghim thì dừng trước khi gửi khoá |
| Xác thực | Header `Authorization: Bearer mh_...`. Khoá thiếu, sai hoặc đã thu hồi: `UNAUTHORIZED` |
| Danh sách IP | IP nguồn ngoài danh sách bị **đóng kết nối ngay, trước cả bắt tay TLS**, không có phản hồi nào (bot thấy kết nối bị ngắt/hết giờ). Bao gồm cả `/v1/health` |
| Khoá IP khi dò khoá | Sai khoá **10 lần trong 600 giây** từ một IP thì chặn IP đó **900 giây** (`RATE_LIMITED`, kể cả `/v1/health`). Gọi đúng khoá thì xoá bộ đếm |
| Giới hạn tốc độ | **60 lời gọi/phút/khoá** (cửa sổ trượt 60 giây), tính cho `/v1/describe`, `/v1/call`, `/v1/media`; vượt thì `RATE_LIMITED` |
| Kết nối | Tối đa **64** kết nối đồng thời; tối đa **4** lời gọi `events.wait` cùng lúc cho mỗi khoá (vượt: `RATE_LIMITED`) |
| Thời gian chờ | Tiêu đề yêu cầu 15 giây, bắt tay TLS 10 giây, toàn bộ thân yêu cầu 300 giây (đủ cho video 200 MB), keep-alive rảnh 5 giây. Long-poll 25 giây không bị cắt |
| Chế độ nhân viên | Máy chủ không chạy; đang chạy mà chuyển sang chế độ nhân viên thì dừng (kiểm mỗi 15 giây). Trong khoảng đó, lời gọi **đã xác thực** nhận `503 BUSY` |
| Nhật ký | Bảng `control_audit`: thời điểm, tên khoá, IP, thao tác, tóm tắt tham số, kết quả hoặc mã lỗi, thời gian xử lý. Giữ **30 ngày**; Cài đặt hiện 100 dòng gần nhất |

Thứ tự xử lý mỗi yêu cầu: (1) IP có trong danh sách? (2) IP đang bị khoá? (3) `GET /v1/health` trả ngay (không cần khoá, không tốn hạn mức) (4) `POST /v1/pair` và `GET /v1/bridge.py` (không cần khoá Bearer; vé một lần, mục 4.1) (5) xác thực khoá (6) giới hạn tốc độ (7) chế độ nhân viên (8) định tuyến và đọc thân.

**Nhật ký ghi gì.** Mọi lời gọi `/v1/call`, `/v1/media` đã vào tới thao tác. Lời gọi `/v1/call` bị từ chối trước đó (sai khoá, IP bị khoá, quá tốc độ, chế độ nhân viên) cũng được ghi, không đọc thân yêu cầu; quá tốc độ chỉ ghi lần đầu của mỗi khoá trong mỗi cửa sổ 60 giây. Tóm tắt tham số chỉ gồm tên trường, `id`/`runId`/`scheduleId`/`kind`/`when`/`mode` ngắn, và số phần tử của mảng; **không bao giờ có nội dung bài, bình luận hay khoá**.

## 4. Điểm cuối

| Phương thức | Đường dẫn | Cần khoá | Mục đích |
|---|---|---|---|
| `GET` | `/v1/health` | không | Trả `{ "ok": true, "protocol": 1 }`; vẫn chịu danh sách IP và khoá IP |
| `GET` | `/v1/describe` | có | Phiên bản giao thức và mọi thao tác kèm `description`, `destructive`, `destructiveWhen?`, `paramsSchema`, `resultSchema` (JSON Schema) |
| `POST` | `/v1/pair` | không (vé một lần) | Đổi mã vé ghép nối lấy khoá mới, xem mục 4.1 |
| `GET` | `/v1/bridge.py` | không | Tải `maihub_bridge.py` của chính bản MaiHub này (`text/x-python; charset=utf-8`); `404` khi MaiHub không có tệp |
| `POST` | `/v1/call` | có | Gọi một thao tác: `{ "method": "drafts.create", "params": {…}, "idempotencyKey": "…" }` |
| `POST` | `/v1/media` | có | Tải một ảnh/video/nhạc (thân nhị phân), xem mục 8 |
| `GET` | `/v1/videos/file?videoId=<id>&kind=video\|thumb` | có | Tải về MP4 (hoặc ảnh bìa JPG) của video đã render xong, xem mục 8.1 |

### 4.1 Ghép nối

Cả `/v1/pair` và `/v1/bridge.py` nằm sau bước kiểm tra danh sách IP, khoá IP và `/v1/health`, nhưng trước xác thực khoá. Chủ máy tạo vé trong MaiHub (gắn với IP của bot, sống 15 phút, dùng một lần); bot gửi `POST /v1/pair` thân JSON `{ "ticket": "…" }` (tối đa 1024 byte, quá thì `413`) và nhận `200 { "ok": true, "result": { "apiKey": "mh_…", "keyName": "…" } }`. Khoá nhận được dùng ngay được. Vé sai, đã dùng, hết hạn, gửi từ IP khác, JSON hỏng hoặc thiếu `ticket` đều trả `401` cùng thông báo `Mã ghép nối không hợp lệ hoặc đã hết hạn` và tính vào khoá IP (10 lần sai thì IP bị chặn như khoá sai). Chế độ nhân viên trả `503 BUSY`. Mọi lần ghép nối được ghi nhật ký với `method = "pair"` (không ghi vé).

Sai phương thức HTTP trên đường dẫn đã biết trả `405` kèm `Allow`, mã `INVALID_PARAMS`, `details.field = "httpMethod"`. Đường dẫn lạ trả `404 NOT_FOUND`. Mọi phản hồi có `Cache-Control: no-store`.

## 5. Phong bì và mã lỗi

Thành công: `HTTP 200` với `{ "ok": true, "result": {…} }`.

Lỗi: `{ "ok": false, "error": { "code": "…", "message": "<tiếng Việt>", "details": {…} } }`. `details` chỉ có khi cần (ví dụ `{ "field": "mediaIds" }`). Phản hồi `UNAUTHORIZED`, `RATE_LIMITED` (khoá IP và hạn mức 60/phút), `PAYLOAD_TOO_LARGE` và `503 BUSY` do chế độ nhân viên kèm `Connection: close`: client mở kết nối mới cho lần sau.

| Mã | HTTP | Khi nào |
|---|---|---|
| `UNAUTHORIZED` | 401 | Thiếu, sai hoặc đã thu hồi khoá. Mỗi lần tính vào bộ đếm khoá IP |
| `FORBIDDEN_IP` | 403 | Mã dành riêng. Trên thực tế IP ngoài danh sách bị ngắt kết nối mà không có phản hồi nên bot **không nhận** mã này |
| `RATE_LIMITED` | 429 | IP đang bị khoá do sai khoá quá nhiều; quá 60 lời gọi/phút/khoá; hoặc quá 4 `events.wait` cùng lúc cho một khoá |
| `INVALID_PARAMS` | 400 | Thân không phải JSON hợp lệ hoặc không phải đối tượng; thiếu `method`; `params` không phải đối tượng; `idempotencyKey` không phải chuỗi 1–64 ký tự; tham số sai kiểm tra của app (kèm `details.field` khi biết trường); lỗi header của `/v1/media`; `mediaId` lạ hoặc hết hạn. Sai phương thức HTTP: 405 |
| `NOT_FOUND` | 404 | Đường dẫn lạ; không có bản nháp / lịch / lần chạy với mã đã gửi |
| `CONFIRMATION_REQUIRED` | 409 | Thao tác `destructive` mà thiếu `confirm: true`. Không làm gì cả |
| `BUSY` | 409 | Đang có việc Đăng Facebook chạy (`Đang có việc chạy`), đang kiểm tra đăng nhập, đang theo dõi bài hoặc đang chuyển workspace (`posts.track`), thao tác cần máy rảnh |
| `BUSY` | 503 | MaiHub đang ở chế độ nhân viên, không nhận lệnh điều khiển |
| `ENGINE_MISSING` | 503 | Chưa cài nhân trình duyệt trong MaiHub |
| `LIMIT_REACHED` | 422 | Đã đủ tối đa 200 lịch cho workspace, hoặc hộp thư `/v1/media` đã đủ 200 tệp |
| `PAYLOAD_TOO_LARGE` | 413 | Thân `/v1/call` quá 1 MB, hoặc tệp `/v1/media` quá giới hạn, hoặc hộp thư `/v1/media` đã đầy 2 GiB |
| `UNKNOWN_METHOD` | 404 | `method` không có trong `/v1/describe` |
| `INTERNAL` | 500 | Lỗi nội bộ MaiHub (không lộ thông báo gốc); thử lại sau và xem nhật ký của app |

Cách xử lý gợi ý: `INVALID_PARAMS` thì sửa tham số theo `details.field` rồi gọi lại; `BUSY` 409 thì chờ `run.finished` rồi thử lại; `RATE_LIMITED` thì giãn lời gọi; `CONFIRMATION_REQUIRED` thì hỏi người dùng (mục 6).

## 6. Quy tắc chung

- **Phiên bản.** Đường dẫn có `/v1`. Trong v1 chỉ *thêm* thao tác hoặc tham số tuỳ chọn; đổi nghĩa thì sang `/v2`. Bot nên bỏ qua trường lạ trong kết quả.
- **Xác nhận (`confirm`).** Thao tác có `destructive: true` bắt buộc `params.confirm === true`, thiếu thì `CONFIRMATION_REQUIRED` và không làm gì. Bot dùng mã này để hỏi người dùng (ví dụ trên Telegram) rồi gọi lại. Thao tác chỉ nguy hiểm có điều kiện (`drafts.approve` khi `when = "now"`) có `destructive: true` kèm `destructiveWhen: { "when": "now" }` trong `/v1/describe`: chỉ cần `confirm` khi tham số khớp điều kiện đó. Đừng tự đặt `confirm: true` khi người dùng chưa đồng ý.
- **Chống chạy trùng (`idempotencyKey`).** Trường tuỳ chọn ở cấp ngoài của `/v1/call` (không nằm trong `params`), chuỗi 1–**64** ký tự. Cùng khoá truy cập, cùng thao tác (`method`) và cùng `idempotencyKey` trong **24 giờ** thì trả lại kết quả thành công cũ, không làm lại; dùng lại một `idempotencyKey` cho thao tác khác trong 24 giờ bị từ chối `400 INVALID_PARAMS` (`details.field = "idempotencyKey"`) và không chạy gì, nên mỗi lần ghi cần một khoá riêng; hai lời gọi đồng thời cùng khoá dùng chung một lần chạy. Lỗi không được lưu nên gọi lại sau lỗi sẽ chạy thật. Dùng cho mọi thao tác ghi khi mạng chập chờn.
- **Kích thước.** Thân `/v1/call` ≤ **1.048.576 byte** (1 MB). Ảnh ≤ 20 MB, video ≤ 200 MB (mục 8).
- **Phân trang.** `drafts.list` và `runs.list`: `limit` 1–200 (mặc định 50); `limit` ngoài khoảng này **không bị từ chối mà được cắt về khoảng** (nhỏ hơn 1 hoặc không phải số nguyên thì dùng 50, lớn hơn 200 thì dùng 200); `offset` ≥ 0.
- **Thời gian** là mili giây epoch (UTC), ví dụ `createdAt`, `plannedAt`, `runAt`.

## 7. Thao tác

Cột "Tham số" liệt kê theo `paramsSchema`; **đậm** là bắt buộc. "Nguy hiểm" = cần `confirm: true`. Tất cả thao tác đều nhận trường ngoài `idempotencyKey` (không nằm trong `params`).

Tham số dùng chung của bản nháp (`D`): `name` (chuỗi ≤ 100, mặc định 40 ký tự đầu của `text`), `plannedAt` (epoch ms hoặc `null`), `mode` (`"group"` hoặc `"page"`), `text`, `mediaIds` (mảng chuỗi), `comment`, `commentDelayMin` (0–60), `profiles` (mảng `{ profileId, targets[] }`; `profileId` bắt buộc, `targets` là link/mã nhóm, bỏ trống khi `mode = "page"`), `minDelaySec`/`maxDelaySec` (0–86400), `concurrency` (1–10), `staggerMinSec`/`staggerMaxSec` (0–3600), `variants` (mảng 0–4 chuỗi = biến thể B…E, mỗi chuỗi khác `text` và khác nhau; các đích lần lượt nhận A, B, …; `drafts.update` với `[]` = bỏ biến thể, bỏ trống = giữ nguyên biến thể hiện có; `drafts.create` bỏ trống hoặc `[]` = không chia), `campaignId` (mã chiến dịch, `null` để bỏ gắn, bỏ trống = giữ nguyên; chiến dịch `archived` bị từ chối).

Tham số giờ (`T`): `runAt` (epoch ms, sau hiện tại ít nhất 1 phút; cho lịch một lần), `days` (mảng 0–6, 0 = Chủ nhật; cho lịch lặp), `time` (`"HH:MM"`; cho lịch lặp).

**Nghiên cứu chủ đề (`research.*`).** Mỗi lượt quét chạy nền và tự xoay vòng các profile đủ điều kiện (không bị loại trừ, không đang mở, không nằm trong lượt Đăng Facebook, đăng nhập không `logged_out`/`checkpoint`, chưa chạm trần ngày); mỗi profile thu tối đa 50 mục rồi đổi sang profile khác, nghỉ 2–5 giây giữa hai trang kết quả và 5–10 giây giữa hai nhóm. Dữ liệu giữ 180 ngày. Mỗi mục trong `items` có tên, mã và link người đăng (`authorName`, `authorId`, `authorUrl`; kể cả cá nhân), `reactions`/`comments`/`shares` (`null` nếu không đọc được), `engagement` (= reactions + comments + shares, bỏ qua `null`; tất cả `null` thì `null`) và `engagementRate` (= engagement / số thành viên của nhóm nơi đăng; `null` nếu chưa biết số thành viên). Hoàn tất báo bằng sự kiện `research.finished`. `scan.details` (từ `research.get`/`research.list`): `profiles[id] = { items, error? }`, `groups[url]` (`group_feed`: `not_member` | `empty` | `unresolved`), `shape` (cấu trúc khoá để chẩn đoán) và `note`: `cursor_not_portable` (con trỏ phân trang không dùng được giữa các tài khoản, lượt quét dừng `done` với ít mục hơn `limit`, xoay vòng không giúp thêm) hoặc `no_groups` (`group_feed` không có nhóm nào để quét, kèm `error` giải thích; `errorCode` rỗng). Mỗi lệnh gọi Facebook quá 30 giây thì profile đó bị bỏ qua (`rate_limited`).

| Thao tác | Tham số | Kết quả | Nguy hiểm |
|---|---|---|---|
| `system.status` | không | `{ appVersion, workspace: {id,name}\|null, browserEngine, sandbox, schedulerRunning, currentRun }` | không |
| `profiles.list` | không | `{ profiles: [{ id, name, groupId, groupName, running, lastOpenedAt, createdAt, lastScannedAt, loginState, loginCheckedAt, loginError }] }` (chỉ trường an toàn: không fingerprint, proxy, cookie). `loginState` là `ok`, `logged_out`, `checkpoint` hoặc `unknown` (chưa kiểm tra bao giờ); `loginCheckedAt` (epoch ms hoặc `null`) là lần xác định trạng thái gần nhất; `loginError` là lỗi của lần kiểm tra gần nhất (mạng, proxy…) hoặc `null` | không |
| `profiles.groups` | **`profileIds`** (mảng chuỗi) | `{ groups }`: nhóm đã quét của từng profile (`url`, `name`…) | không |
| `profiles.scanGroups` | **`profileIds`**, `concurrency`, `staggerMinSec`, `staggerMaxSec` | `{ runId }`. Bắt đầu việc quét như nút trong app; `BUSY` nếu đang có việc; không gửi concurrency/stagger thì dùng mặc định app | không |
| `profiles.check` | `profileIds` (mảng 1–50 chuỗi không rỗng; **bỏ trống tham số** = mọi profile, mảng rỗng `[]` bị từ chối) | `{ checkId, profileIds }`. Bắt đầu kiểm tra đăng nhập Facebook chạy nền, từng profile một; kết quả đến qua sự kiện `profiles.checkFinished` (cùng `checkId`). `INVALID_PARAMS` (`details.field = "profileIds"`) nếu mảng rỗng, quá 50 mã hoặc sai kiểu; `NOT_FOUND` với `details.missing` (mảng mã lạ); `BUSY` nếu đang có việc chạy hoặc đang kiểm tra | không |
| `drafts.list` | `limit`, `offset` | `{ total, items }`: nháp (lịch `draft = true`) | không |
| `drafts.get` | **`id`** | `{ draft, media: [{ path, size }] }` | không |
| `drafts.create` | **`mode`**, **`text`**, và các tham số `D` còn lại | `{ schedule }`; `schedule.id` là mã nháp. Cùng kiểm tra với "Lưu nháp" trong app. `mediaIds` ánh xạ sang tệp đã tải (mục 8) | không |
| `drafts.update` | **`id`** + bất kỳ tham số `D` | `{ schedule }`. Trường không gửi giữ nguyên; gửi `mediaIds` thì **thay toàn bộ** tệp đính kèm | không |
| `drafts.delete` | **`id`**, **`confirm`** | `{ deleted: true }`. Chỉ xoá bản nháp, không xoá được lịch thật | có |
| `drafts.approve` | **`id`**, **`when`**, `campaignId` (tuỳ chọn), `confirm` | `{ schedule }`. `when` là `"now"` (đăng ngay), `{ "kind": "once", "runAt": <epoch ms> }` hoặc `{ "kind": "recurring", "days": [..], "time": "HH:MM" }`. `when = "now"` vào chiến dịch đã lưu trữ bị từ chối (`INVALID_PARAMS`, "Chiến dịch đã lưu trữ"), không phát sự kiện. Phát sự kiện `draft.approved` | chỉ khi `when = "now"` (`destructiveWhen: {"when":"now"}`) |
| `schedules.list` | `campaignId` (tuỳ chọn; `""` = lịch không thuộc chiến dịch) | `{ schedules, queuedIds }` (mỗi lịch có `campaignId`): lịch thật (không gồm nháp) và các lịch đang chờ chạy | không |
| `schedules.update` | **`id`**, `name`, `enabled` (boolean), `campaignId` (chuỗi hoặc `null`), và tham số `T` | `{ schedule }`. Cùng quy tắc với app: `runAt` chỉ cho lịch một lần, `days`/`time` chỉ cho lịch lặp | không |
| `schedules.delete` | **`id`**, **`confirm`** | `{ deleted: true }`. Từ chối (`INVALID_PARAMS`) khi lịch đang chạy | có |
| `runs.current` | không | `{ run, progress }` (`null` nếu rảnh) | không |
| `runs.list` | `limit`, `offset`, `kind` (`post`, `join`, `scan_groups`, `collect_comments`) | `{ runs, total }`, mới nhất trước | không |
| `runs.get` | **`runId`** | `{ run, results }`: kết quả từng đích, link bài, trạng thái bình luận; mỗi kết quả có `errorCode` (mã lỗi, `""` khi không lỗi hoặc không phải việc đăng) và `attempts` (số lần thử, mặc định 1) và `variant` (nhãn biến thể đã đăng, `""` nếu bài không có biến thể); `run.campaignId` (chuỗi hoặc `null`; lượt `missed`/`failed` do scheduler ghi không mang `campaignId`, luôn `null`). Xem bảng mã lỗi bên dưới | không |
| `runs.cancel` | **`confirm`** | `{ cancelled: true }`. Dừng việc đang chạy | có |
| `events.wait` | **`after`** (≥ 0), `timeoutSec` (0–25) | `{ events: [{ seq, type, payload, createdAt }], workspaceId }` | không |
| `research.search` | **`source`** (`posts`/`groups`/`pages`), **`query`** (1–100 ký tự), `recent` (boolean, chỉ `posts`), `year` (chỉ `posts`, từ 2010 tới năm hiện tại), `limit` (1–500, mặc định 200), `profileIds` (mảng 1–50 mã; bỏ trống = mọi profile) | `{ scanId }`. Quét Facebook theo từ khoá, chỉ đọc, chạy nền; xong có sự kiện `research.finished`, rồi lấy kết quả bằng `research.get`. `INVALID_PARAMS` nếu tham số sai hoặc `profileIds` rỗng; `NOT_FOUND` với `details.missing` nếu `profileIds` có mã lạ; `BUSY` nếu đang có lượt quét khác | không |
| `research.scanGroupFeeds` | `groupUrls` (≤ 20 link nhóm; bỏ trống = 20 nhóm được quét gần nhất của các profile đủ điều kiện), `sinceDays` (1–30, mặc định 7), `limitPerGroup` (1–100, mặc định 30), `profileIds` | `{ scanId }`. Đọc bài mới trong nhóm; lỗi như `research.search` | không |
| `research.list` | `limit` (1–200), `offset`, `source` (`posts`/`groups`/`pages`/`group_feed`) | `{ total, scans[] }` (mới nhất trước) | không |
| `research.get` | **`scanId`**, `sort` (`engagement` mặc định / `recent` / `members`), `limit` (1–500), `offset` | `{ scan, total, items[] }`. `NOT_FOUND` nếu `scanId` lạ | không |
| `research.cancel` | không | `{ cancelled: boolean }`. Dừng lượt quét đang chạy (kể cả khi đang nghỉ giữa trang) | không |
| `posts.track` | `sinceDays` (1–14, mặc định 3), `groupUrls` (1–30 link nhóm), `profileIds` (mảng ≤ 50 mã; bỏ trống = mọi profile) | `{ jobId, pairs }`. Đọc bảng tin nhóm để lấy link và đo tương tác các bài đã đăng, chỉ đọc, chạy nền; xong có sự kiện `posts.trackFinished`. `INVALID_PARAMS` nếu tham số sai; `NOT_FOUND` với `details.missing` nếu `profileIds` có mã lạ; `BUSY` nếu đang đăng, đang kiểm tra đăng nhập hoặc đang theo dõi | không |
| `posts.trackStatus` | không | `{ running, jobId, progress: { done, total }, last }`; `last` là kết quả lần gần nhất (gồm lỗi từng nhóm) hoặc `null` | không |
| `posts.trackCancel` | không | `{ cancelled: boolean }`. Dừng sau trang đang đọc | không |
| `posts.list` | `from`, `to` (epoch ms; mặc định 30 ngày gần nhất), `linkStatus` (`known`/`missing`/`pending_approval`/`not_found`), `groupUrl`, `profileId`, `campaignId` (`""` = không thuộc chiến dịch), `scheduleId`, `limit` (1–500), `offset` | `{ total, rows[] }`: các bài theo dõi kèm `latestStats` (lần đo mới nhất hoặc `null`) | không |
| `posts.stats` | **`groupBy`** (`group`/`profile`/`schedule`/`day`/`post`/`campaign`/`variant`/`hour`/`weekday`; `hour` = giờ máy `00`–`23`, `weekday` = `1`–`7` là Thứ 2 … Chủ nhật), `campaignId` (`""` = không thuộc chiến dịch), `scheduleId`, `from`, `to`, `limit` (1–500) | `{ rows[] }`: số bài, có link, chờ duyệt, không tìm thấy, nghi bị xoá, reactions/comments/shares (lần đo mới nhất), tương tác trung bình, `engagementRate` (`null` nếu chưa biết số thành viên nhóm) | không |
| `posts.groupScores` | `from`, `to` (epoch ms; mặc định 30 ngày gần nhất), `campaignId` (`""` = không thuộc chiến dịch) | `{ groups[] }`: `{ groupUrl, label, score, grade, attempted, posted, failed, held, removed, withLink, measured, engagement, reasons[] }`; `grade` = `good` (≥ 70) / `fair` (40–69) / `poor` (< 40) / `insufficient` (dưới 3 lượt đăng, `score` = `null`); sắp `score` giảm dần, `insufficient` xếp cuối | không |
| `posts.bestTimes` | `from`, `to` (mặc định 60 ngày gần nhất), `groupUrl`, `campaignId` | `{ hours[], weekdays[], insufficient }`: tối đa 3 giờ và 2 thứ, mỗi mục `{ key, label, avgEngagement, measured }`, chỉ khung có ít nhất 5 bài đã đo; `insufficient` = `true` khi chưa có giờ nào đủ | không |
| `campaigns.list` | `status` (`active`/`paused`/`archived`; mặc định mọi trạng thái trừ `archived`) | `{ campaigns: [{ id, name, goal, status, startAt, endAt, createdAt, updatedAt, scheduleCount, draftCount, runnable, summary }] }`; `summary` là dòng báo cáo `groupBy campaign` từ lúc tạo chiến dịch hoặc `null` | không |
| `campaigns.get` | **`id`** | `{ campaign }` như trên kèm `schedules: [{ id, name, kind, enabled, draft, nextRunAt }]`. `NOT_FOUND` nếu `id` lạ | không |
| `campaigns.create` | **`name`** (1–100 ký tự, không trùng), `goal` (≤ 1000), `startAt`, `endAt` (epoch ms, `startAt ≤ endAt`) | `{ campaign }`. `INVALID_PARAMS` nếu tên trùng hoặc khoảng ngày sai | không |
| `campaigns.update` | **`id`**, và tuỳ chọn `name`, `goal`, `status`, `startAt`, `endAt` (`null` để bỏ giới hạn) | `{ campaign }`. Chiến dịch `paused`/`archived` hoặc ngoài khoảng ngày thì lịch của nó không tự chạy | không |
| `campaigns.delete` | **`id`**, **`confirm`** | `{ deleted: true }`. `INVALID_PARAMS` nếu còn lịch / bài nháp | có |
| `posts.trackConfig` | `config` (`{ autoEnabled, linkRetryMinutes[], statsAtMinutes[] }`; mỗi mảng 1–10 số tăng dần, 5–20160 phút). Không truyền = chỉ đọc | `{ config }`. `INVALID_PARAMS` nếu `config` sai | không |
| `comments.collect` | `postUrls` (1–50 link bài; bỏ trống = các bài đến hạn thu; mỗi lượt xử lý tối đa 10 bài) | `{ jobId, posts }`. Thu bình luận bài đã đăng (chỉ đọc), chạy nền; bình luận mới khớp thành khách thì có sự kiện `leads.found`. Link không có dòng theo dõi bị bỏ qua (`posts` không tính); không có phương thức hỏi trạng thái hay sự kiện xong cho lượt này. `BUSY` nếu đang đăng, kiểm tra đăng nhập hoặc đang thu | không |
| `comments.list` | `postUrl`, `since` (epoch ms, theo thời điểm thu), `limit` (1–500), `offset` | `{ total, comments[] }` | không |
| `leads.list` | `status` (`new`/`contacted`/`won`/`ignored`), `campaignId` (`""` = không thuộc chiến dịch), `from`, `to`, `search`, `limit` (1–500), `offset` | `{ total, leads[] }` (mới nhất trước) | không |
| `leads.update` | **`id`**, và `status` hoặc `note` (≤ 1000 ký tự; cần ít nhất một) | `{ lead }`. `NOT_FOUND` nếu `id` lạ; `INVALID_PARAMS` nếu tham số sai | không |
| `leads.config` | `config` (`{ autoCollect, collectAtMinutes[], keywords[], detectPhone, aiEnabled, aiMinScore }`; `collectAtMinutes` 1–10 số tăng dần, 30–20160 phút; `keywords` 1–100 mục, mỗi mục 1–40 ký tự; `aiMinScore` 0–100). Không truyền = chỉ đọc | `{ config }`. `INVALID_PARAMS` nếu `config` sai | không |
| `videos.templates` | — | `{ templates[], music[] }` lấy từ máy chủ render (mỗi mẫu có `aspects`, `imageSlots`, `variables` kèm giới hạn độ dài). `INVALID_PARAMS` "Chưa cấu hình máy chủ render video"; `INTERNAL` "Không kết nối được máy chủ render" | không |
| `videos.render` | **`name`** (1–100 ký tự) và **đúng một** trong hai kiểu. Kiểu mẫu: `templateId`, `aspect` (`9:16` / `1:1` / `16:9`), `variables`, `imageIds` (1–20 mã tệp `/v1/media`, theo thứ tự), nhạc tuỳ chọn `musicId` (nhạc có sẵn, `null` = không nhạc) **hoặc** `musicMediaId` (mã tệp `/v1/media` của một tệp nhạc `mp3` / `m4a` / `wav`; ảnh hoặc video thì `INVALID_PARAMS`). Biến chuỗi của mẫu mặc định bắt buộc không trống; chỉ biến có `required: false` trong `videos.templates` mới được để `""`. Kiểu HTML: `html`, `width`, `height`, `assetIds` (≤ 20 mã tệp `/v1/media`; trong HTML gọi tệp theo tên `asset1.<đuôi>`, `asset2.<đuôi>`… theo thứ tự; máy chủ đặt đuôi theo nội dung thật nên chỉ có `jpg`, `png`, `webp`, `mp3`, `m4a`, `wav`, `mp4`, ví dụ `.jpeg` thành `.jpg` và `.mov` thành `.mp4`). Chung: `fps` (24 / 30), `quality` (`standard` / `high`) | `{ videoId, status }`. Chạy nền; xong có sự kiện `videos.finished`. `LIMIT_REACHED` nếu hàng đợi máy chủ đầy, quá hạn mức tạo việc hoặc máy chủ render sắp hết dung lượng ("Máy chủ render sắp hết dung lượng", HTTP 507 ở máy chủ); `INVALID_PARAMS` nếu chưa cấu hình máy chủ render, sai tham số, `mediaId` lạ hoặc hết hạn; `INTERNAL` nếu không kết nối được máy chủ | không |
| `videos.status` | **`videoId`** | `{ video }` (`id`, `name`, `status`, `progress` 0–1, `error`, `durationSec`, `sizeBytes`, `createdAt`, `finishedAt`…; không có đường dẫn trên máy). `NOT_FOUND` nếu `videoId` lạ | không |
| `videos.list` | `status` (`uploading`/`queued`/`rendering`/`done`/`failed`/`cancelled`), `limit` (1–100, mặc định 50), `offset` | `{ total, videos[] }` (mới nhất trước) | không |
| `videos.cancel` | **`videoId`** | `{ cancelled }`; `false` nếu video không còn đang chờ hoặc đang render. `NOT_FOUND` nếu `videoId` lạ | không |

`run.status` nhận một trong `running`, `done`, `cancelled`, `failed`, `missed`.

## 8. Tệp media

`POST /v1/media`: thân là nội dung nhị phân của đúng một tệp.

| Header | Quy định |
|---|---|
| `X-Filename` | Bắt buộc. Tên tệp (có thể mã hoá URL); chỉ lấy phần tên, bỏ thư mục. Đuôi quyết định loại |
| `Content-Type` | Bắt buộc, phải là `image/*` nếu đuôi là ảnh, `video/*` nếu đuôi là video hoặc `audio/*` nếu đuôi là nhạc |
| `Authorization` | `Bearer <khoá>` |

- Đuôi nhận: ảnh `jpg`, `jpeg`, `png`, `gif`, `webp`; video `mp4`, `mov`, `webm`; nhạc `mp3`, `m4a`, `wav` (chỉ để dùng làm `musicMediaId` / `assetIds` của `videos.render`; bản nháp và luồng đăng vẫn chỉ nhận ảnh/video). Khác thì `INVALID_PARAMS` (`details.field = "X-Filename"` hoặc `"Content-Type"`).
- Giới hạn: ảnh ≤ **20 MB** (`MAX_IMAGE_BYTES`), video ≤ **200 MB**, nhạc ≤ **15 MB** (`MAX_AUDIO_BYTES`). Vượt thì `413 PAYLOAD_TOO_LARGE`. Tải lên bị từ chối vì lý do khác (ví dụ hộp thư đầy, `422 LIMIT_REACHED`) thì MaiHub vẫn nhận hết phần thân còn lại rồi mới trả lời, nên client gửi-hết-rồi-đọc không bị treo hay lỗi `EPIPE`. Tệp rỗng: `INVALID_PARAMS` (`details.field = "body"`). Hộp thư (tất cả khoá cộng lại) chứa tối đa **200 tệp** và **2 GiB**: đủ số tệp thì `422 LIMIT_REACHED`, vượt dung lượng thì `413 PAYLOAD_TOO_LARGE` (kiểm trước khi ghi và cả khi đang nhận; tải song song được tính chung). Chờ tệp cũ bị dọn (24 giờ) rồi thử lại.
- Quy tắc của luồng đăng vẫn áp khi tạo nháp/duyệt: một bài có 1–10 ảnh (tổng ≤ 100 MB) **hoặc** đúng 1 video, không trộn.
- Kết quả: `{ "mediaId": "<uuid>", "name": "anh.jpg", "size": 123456, "kind": "image" }` (`kind` là `image`, `video` hoặc `audio`).
- Tệp lưu ở `userData/control-api/inbox/<mediaId>.<đuôi>` trên máy MaiHub và **bị xoá sau 24 giờ** (dọn mỗi giờ). Hết hạn thì `drafts.create/update` với `mediaId` đó trả `INVALID_PARAMS` (`details.field = "mediaIds"`): tải lại.
- Dùng: truyền `mediaIds: ["<uuid>", …]` cho `drafts.create` / `drafts.update`. App sao tệp sang thư mục của bản nháp nên sau khi tạo nháp, tệp trong inbox không còn cần thiết. Thứ tự `mediaIds` là thứ tự ảnh trong bài.

### 8.1 Tải video đã render về máy bot

`GET /v1/videos/file?videoId=<id>&kind=video|thumb` (`kind` mặc định `video`). Chịu cùng danh sách IP, khoá, giới hạn tốc độ và chế độ nhân viên như `/v1/call`; ghi nhật ký với tên `videos.download`.

- Thành công: `200`, thân là nội dung tệp (`video/mp4` hoặc `image/jpeg`), có `Content-Length` và `Content-Disposition: attachment; filename="<videoId>.mp4|.jpg"`. Không có phong bì JSON.
- Lỗi: phong bì JSON như mục 5. `videoId` sai dạng (`^[A-Za-z0-9-]{1,64}$`) hoặc `kind` lạ → `400 INVALID_PARAMS` (`details.field`); mã lạ, video chưa xong (`status` khác `done`), không có ảnh bìa hoặc tệp không còn trên máy MaiHub → `404 NOT_FOUND`; sai phương thức → 405.
- Bridge: tool MCP `maihub_download_video` (`videoId`, `kind?`, `path?`) và lệnh `download-video <videoId> [--kind thumb] [-o <tệp hoặc thư mục>]`; mặc định lưu `~/maihub-videos/<videoId>.mp4|.jpg` và trả `{ path, sizeBytes }`.

## 9. Sự kiện

`events.wait` trả các sự kiện có `seq > after`, tối đa **100** mỗi lần (nếu đủ 100 thì gọi tiếp với `after` mới ngay).

- Có sẵn sự kiện: trả ngay.
- Chưa có và `timeoutSec > 0`: giữ kết nối tới khi có sự kiện mới hoặc hết `timeoutSec` (tối đa **25** giây; nhỏ hơn 0 hoặc thiếu thì coi như 0, lớn hơn 25 thì cắt về 25), rồi trả `{ "events": [] }` nếu không có gì. Client ngắt kết nối thì lời chờ huỷ.
- `after` thiếu hoặc không phải số nguyên ≥ 0: `INVALID_PARAMS`. Bot tự lưu `after` của mình (lấy `seq` lớn nhất đã nhận); lần đầu dùng `0`.
- Kết quả luôn kèm `workspaceId` (workspace đang mở, `null` nếu chưa có). `seq` thuộc DB của từng workspace, nên bot lưu `workspaceId` cùng `after` và **đặt lại `after = 0` khi `workspaceId` đổi** (nếu không sẽ bỏ lỡ sự kiện của workspace mới).
- `seq` tăng đơn điệu và **bền qua khởi động lại**. Sự kiện giữ **7 ngày**, tối đa **5.000 dòng** (cũ hơn bị xoá); nhật ký giữ 30 ngày.
- Sự kiện được ghi **trong suốt thời gian API ở trạng thái bật** (cấu hình đang bật và app không ở chế độ nhân viên), kể cả khi cổng chưa bind được; **khi API tắt thì không ghi** nên có khoảng trống. Sự kiện phát sinh từ cả thao tác trong app lẫn qua API.

| `type` | Khi nào | `payload` |
|---|---|---|
| `run.started` | Bắt đầu một việc (đăng, quét nhóm, v.v.) | `{ runId, kind, scheduleId }` (`scheduleId` là `null` nếu không từ lịch) |
| `run.finished` | Việc kết thúc | `{ runId, kind, status, scheduleId, scheduleName, posted, failed, skipped }` (đếm theo kết quả từng đích; `scheduleName` là tên lịch, `null` nếu không từ lịch hoặc lịch đã bị xoá) |
| `schedule.missed` | Lịch bị lỡ (app tắt/máy ngủ quá giờ, chờ quá 2 giờ, hoặc app đóng khi lượt đang chờ) | `{ scheduleId, name, reason, at }`; `reason` là một trong `App tắt lúc đến giờ`, `Chờ quá 2 giờ vì đang có việc khác`, `App đóng khi lượt đang chờ` (`MISSED_APP_QUIT`) |
| `draft.approved` | Duyệt nháp (trong app hoặc qua API) | `{ scheduleId, name, when: "now"\|"scheduled", kind, nextRunAt }` |
| `profile.loginProblem` | Trạng thái đăng nhập lưu của profile chuyển sang `logged_out` hoặc `checkpoint` (từ trạng thái khác, kể cả `unknown`); giữ nguyên thì không phát lại | `{ profileId, profileName, state, source }`; `source` là `check` hoặc `run` |
| `profiles.checkFinished` | Một lượt kiểm tra đăng nhập kết thúc | `{ checkId, source: "manual"\|"api"\|"daily", results: [{ profileId, profileName, outcome, error? }] }`; `outcome` là `ok`, `logged_out`, `checkpoint`, `error`, `skipped`; `error` chỉ có khi `outcome = error` |
| `research.finished` | Một lượt quét Nghiên cứu kết thúc (xong, lỗi hoặc bị huỷ) | `{ scanId, source, query, status, errorCode, itemCount }`; lấy kết quả bằng `research.get` |
| `posts.trackFinished` | Một lượt theo dõi bài đăng kết thúc (xong, huỷ hoặc có lỗi; cả lượt do người dùng bấm hay MaiHub tự chạy) | `{ jobId, auto, cancelled, groups, checked, found, linked, removedSuspected, notFound, errors }`; `auto` là `true` khi MaiHub tự chạy, `errors` là số nhóm lỗi; chi tiết bằng `posts.trackStatus` |
| `leads.found` | Có khách tiềm năng mới sau một lượt thu bình luận (một sự kiện cho cả lượt, `count` là tổng khách của lượt chứ không phải mỗi bài, cả thu tay lẫn tự thu; không phát khi không có khách mới) | `{ count, samples: [{ authorName, text, postUrl }] (tối đa 3), auto }`; xem đầy đủ bằng `leads.list` |
| `videos.finished` | Một video render xong hoặc lỗi (cả video do ứng dụng tạo). Huỷ (bằng `videos.cancel` hoặc từ ứng dụng) cũng phát sự kiện này với `ok = false` và `cancelled = true`; bot nên coi đó là huỷ, không phải lỗi render, và không tự thử lại | `{ videoId, name, ok, cancelled?, error?, durationSec?, sizeBytes?, mediaId? }`; `cancelled` chỉ có (và luôn là `true`) khi video bị huỷ, kèm `error = "Đã huỷ"`; `error` chỉ khi `ok = false` (hoặc khi video xong nhưng không chép được vào hộp thư); `mediaId` chỉ có với video do bot tạo bằng `videos.render`, dùng ngay trong `drafts.create.mediaIds` (hết hạn sau 24 giờ như mọi tệp hộp thư) |

Sau `run.finished`, gọi `runs.get` với `runId` để lấy link bài và chi tiết từng đích.

Mã lỗi `errorCode` trong kết quả của `runs.get` (chỉ-thêm, bot cũ bỏ qua được):

| Mã | Ý nghĩa | Tự thử lại? |
|---|---|---|
| `navigation_failed`, `composer_not_found`, `media_failed`, `editor_not_focusable`, `submit_not_ready`, `submit_not_found`, `unexpected_error` | Lỗi **trước** cú bấm Đăng (tải trang, hộp soạn thảo, ảnh/video, ô nhập, nút Đăng, lỗi bất ngờ) | Có, tối đa 3 lần (`attempts` ≤ 3), chờ 10–30 giây |
| `uncertain_after_submit` | Đã bấm Đăng nhưng không xác nhận được, hoặc trình duyệt bị đóng cưỡng bức: **có thể bài đã lên**, kiểm tra trước khi đăng lại | Không |
| `draft_conflict` | Lần thử lại thấy bản nháp cũ không xoá được | Không |
| `not_logged_in` | Profile chưa đăng nhập Facebook | Không |
| `launch_failed` | Không mở được trình duyệt/profile | Không |
| `stopped` | Bị bỏ qua vì Huỷ (`outcome = skipped`) | Không |
| `unknown` | Không xác định | Không |

## 10. Luồng mẫu: ý tưởng → ảnh → nháp → duyệt → chờ kết quả

Quy ước: `BASE=https://<ip-may-maihub>:47321`, `KEY=mh_...`.

**Về chứng chỉ khi dùng `curl`.** `curl --pinnedpubkey` ghim *khoá công khai (SPKI)*, không phải dấu vân tay chứng chỉ SHA-256 nên **không** dùng thẳng được `MAIHUB_CERT_SHA256`. Cách an toàn cho script thật là dùng bridge (ghim đúng dấu vân tay). Để thử bằng `curl`, kiểm dấu vân tay bằng `openssl` trước, rồi mới dùng `-k` (bỏ kiểm CA vì chứng chỉ tự ký) trong cùng phiên:

```bash
openssl s_client -connect <ip-may-maihub>:47321 </dev/null 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256 | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f'
# so với dấu vân tay hiện trong Cài đặt MaiHub; khớp mới tiếp tục
```

`-k` chỉ an toàn sau khi đã đối chiếu dấu vân tay, vì nó không chống kẻ chen giữa. Đừng gửi khoá qua `curl -k` tới địa chỉ chưa đối chiếu.

**Bước 0. Kiểm tra sống** (không cần khoá):

```bash
curl -sk "$BASE/v1/health"
# {"ok":true,"protocol":1}
```

**Bước 1. Danh sách profile** (có thể gọi thêm `system.status` để xem tình trạng app):

```bash
curl -sk -X POST "$BASE/v1/call" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"method":"profiles.list","params":{}}'
```

**Bước 2. Tải ảnh** (ý tưởng của người dùng kèm ảnh):

```bash
curl -sk -X POST "$BASE/v1/media" -H "Authorization: Bearer $KEY" \
  -H 'X-Filename: anh.jpg' -H 'Content-Type: image/jpeg' --data-binary @anh.jpg
# {"ok":true,"result":{"mediaId":"3f1c…","name":"anh.jpg","size":123456,"kind":"image"}}
```

**Bước 3. Tạo nháp** (`idempotencyKey` để gọi lại không tạo nháp thứ hai):

```bash
curl -sk -X POST "$BASE/v1/call" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{
  "method": "drafts.create",
  "idempotencyKey": "y-tuong-0001",
  "params": {
    "mode": "group",
    "text": "Nội dung bài đăng",
    "mediaIds": ["3f1c…"],
    "profiles": [{ "profileId": "<ma-profile>", "targets": ["https://www.facebook.com/groups/<ma-nhom>"] }]
  }
}'
# {"ok":true,"result":{"schedule":{"id":"<ma-nhap>", …}}}
```

Cho người dùng xem lại nội dung (`drafts.get`) và hỏi ý rồi mới duyệt.

**Bước 4a. Duyệt hẹn giờ** (không cần `confirm`):

```bash
curl -sk -X POST "$BASE/v1/call" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{
  "method": "drafts.approve",
  "params": { "id": "<ma-nhap>", "when": { "kind": "once", "runAt": <epoch-ms-trong-tuong-lai> } }
}'
```

`runAt` là số thật, sau hiện tại ít nhất 1 phút, ví dụ `$(date -d '+1 day' +%s000)`.

**Bước 4b. Đăng ngay** cần `confirm: true`. Gọi không có `confirm` sẽ nhận `409 CONFIRMATION_REQUIRED`; hỏi người dùng rồi gọi lại:

```bash
curl -sk -X POST "$BASE/v1/call" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"method":"drafts.approve","params":{"id":"<ma-nhap>","when":"now","confirm":true}}'
```

**Bước 5. Chờ kết quả** (lặp, lưu `seq` lớn nhất làm `after` cho lần sau):

```bash
curl -sk -X POST "$BASE/v1/call" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"method":"events.wait","params":{"after":0,"timeoutSec":25}}'
# {"ok":true,"result":{"events":[{"seq":7,"type":"run.finished","payload":{"runId":"<ma-run>","status":"done","posted":1,"failed":0,"skipped":0,…},"createdAt":…}]}}
```

**Bước 6. Chi tiết lần chạy**:

```bash
curl -sk -X POST "$BASE/v1/call" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"method":"runs.get","params":{"runId":"<ma-run>"}}'
```

### Cùng luồng bằng bridge CLI

Bridge ghim đúng `MAIHUB_CERT_SHA256` nên không cần `-k` (đặt `B="python3 maihub_bridge.py --env-file .env"`):

```bash
$B doctor
$B call profiles.list
$B upload anh.jpg                                   # in mediaId
$B call drafts.create '{"mode":"group","text":"Nội dung bài đăng","mediaIds":["3f1c…"],"profiles":[{"profileId":"<ma-profile>","targets":["https://www.facebook.com/groups/<ma-nhom>"]}]}' --idempotency-key y-tuong-0001
$B call drafts.approve '{"id":"<ma-nhap>","when":{"kind":"once","runAt":<epoch-ms-trong-tuong-lai>}}'
$B call drafts.approve '{"id":"<ma-nhap>","when":"now","confirm":true}'     # đăng ngay: sau khi người dùng đồng ý
$B wait --after 0 --timeout 25
$B download-video <ma-video>                         # sau videos.finished: lưu ~/maihub-videos/<ma-video>.mp4
$B call runs.get '{"runId":"<ma-run>"}'
```

Mã thoát của CLI: 0 thành công; 1 lỗi từ MaiHub (stderr `<MÃ_LỖI>: thông báo`); 2 thiếu hoặc sai cấu hình; 3 lỗi mạng hoặc sai ghim chứng chỉ. Qua MCP, cùng các thao tác này là các tool `maihub_drafts_create`, `maihub_drafts_approve`, `maihub_events_wait`, `maihub_upload_media`… (tham số như bảng mục 7, thêm `idempotencyKey` tuỳ chọn).

### Thông báo Telegram (`watch`)

Bridge có lệnh `watch` chạy liên tục: chờ `events.wait` (25 giây một lượt) rồi gửi tin tiếng Việt qua Telegram bằng token của bot (`TG_TOKEN` trong `.env` của bot). Tin gửi: lượt đăng/tham gia/quét/thu bình luận xong, có lỗi hoặc bị huỷ (`run.finished`), lỡ lịch (`schedule.missed`), profile hết phiên hoặc bị checkpoint (`profile.loginProblem`), video xong (`videos.finished`: gửi kèm tệp video khi ≤ 50 MiB, không thì chỉ gửi chữ), mất và có lại liên lạc với MaiHub, khoá bị từ chối hoặc sai ghim chứng chỉ. Không báo `run.started`, `draft.approved`, `profiles.checkFinished`.

Khoá `.env` liên quan: `MAIHUB_NOTIFY_CHAT_ID` (`.env` MaiHub; mặc định lấy `ALLOWED_CHAT_ID`/`ADMIN_USER_ID` của bot), `TELEGRAM_API_BASE` (bắt buộc `https://`) và `TELEGRAM_PROXY` (`.env` MaiHub; đường tới Telegram khi VPS cần proxy; SOCKS không hỗ trợ). `watch --check-telegram` gọi Telegram `getMe` một lần qua tuyến đó rồi thoát. Khi khoá bị từ chối hoặc ghim lệch, `watch` báo một lần rồi nạp lại `.env` sau mỗi 300 giây nên ghép nối lại (`pair`, giữ nguyên các dòng khác của `.env`) tự có hiệu lực. Trạng thái (con trỏ sự kiện) lưu ở `state/watch-state.json`; `--dry-run` in tin ra stdout và không lưu gì.

Cài thành service systemd: `pair --install` tự cài (trừ khi có `--no-watch`); bot cài từ trước dùng `sudo python3 maihub_bridge.py install-watch --env-file <.env MaiHub> --notify-env <.env bot> --user <user> --name <tên-service-bot>`. Chi tiết trong `tools/maihub-bridge/README.md`.

## 11. Mẹo cho bot

- Gọi `GET /v1/describe` (hoặc tool MCP) để biết thao tác hiện có; đừng mã cứng danh sách.
- Mọi thao tác ghi nên có `idempotencyKey`; mọi thao tác nguy hiểm phải hỏi người dùng trước khi đặt `confirm: true`.
- Giữ ít hơn 60 lời gọi/phút; dùng một `events.wait` dài thay vì hỏi dồn `runs.current`.
- Nghi lộ khoá: thu hồi trong Cài đặt MaiHub, tạo khoá mới, cập nhật `.env`. Nhật ký trong Cài đặt cho biết khoá đã làm gì.
