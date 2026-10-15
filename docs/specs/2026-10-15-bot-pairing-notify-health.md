# Thiết kế: Ghép nối bot một lệnh, thông báo chủ động, sức khoẻ tài khoản Facebook

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 15/10/2026 |
| Trạng thái | Đã duyệt (15/10/2026) |
| Kế hoạch | `docs/plans/2026-10-15-bot-pairing-notify-health.md` (viết sau khi spec được duyệt) |
| Intent | `docs/intent/2026-10-15-bot-pairing-notify-health.md` (đã duyệt) |
| Nhánh | `feat/bot-pairing-notify-health` |
| Phiên bản dự kiến | 26.19.0 |
| Nền | MaiHub Control Protocol v1 (`docs/specs/2026-10-14-maihub-control-protocol.md`) |

## 1. Tổng quan

Có 3 phần, phát hành cùng nhau vì phần sau dùng phần trước:

| Phần | Phía MaiHub | Phía bot (`maihub_bridge.py`) |
|---|---|---|
| A. Ghép nối | Mục "Ghép nối bot mới", vé dùng một lần, `POST /v1/pair`, `GET /v1/bridge.py` | Lệnh `pair --install` |
| B. Sức khoẻ tài khoản | Kiểm tra đăng nhập, bảng trạng thái, kiểm tra hằng ngày, `profiles.check`, sự kiện | Không có lệnh riêng; bot dùng qua MCP |
| C. Thông báo | Thêm `scheduleName` vào `run.finished` | Lệnh `watch`, `install-watch`; unit systemd |

Mọi thay đổi giao thức chỉ là **thêm** (đúng quy tắc v1, mục 3.3 spec gốc). Bot đang dùng `.env` cũ không phải đổi gì.

## 2. Phần A: Ghép nối

### 2.1 Luồng người dùng

1. MaiHub → Cài đặt → Điều khiển từ bot → **Ghép nối bot mới**. Người dùng nhập:
   - **Tên bot** (1–60 ký tự), dùng làm tên khoá.
   - **IP VPS bot**: một địa chỉ IPv4.
   - **Địa chỉ MaiHub mà bot nhìn thấy**: IPv4 hoặc tên miền. Ô này tự điền IPv4 công khai đầu tiên tìm được trong `os.networkInterfaces()` (bỏ dải private, loopback, link-local), nếu không có thì để trống. Giá trị được nhớ trong cấu hình là `publicHost`.
2. Bấm **Tạo mã ghép nối**. MaiHub làm lần lượt:
   1. Thêm IP bot vào allow-list nếu chưa có.
   2. Bật API (hộp thoại ghi rõ việc này) và lưu cấu hình. Cách lưu giống nút Lưu hiện tại: server khởi động lại nếu cần và tạo chứng chỉ nếu chưa có.
   3. Tạo vé và hiện 2 bước:
      - **Bước 1:** lệnh tường lửa mới (PowerShell quản trị trên máy MaiHub). Đây là lệnh `buildFirewallCommand` hiện có, sinh lại với allow-list mới.
      - **Bước 2:** lệnh cài trên VPS bot, chạy bằng root (mục 2.4), có nút sao chép và đồng hồ đếm ngược 15 phút.
3. Khi vé được dùng, giao diện đổi sang **"Đã ghép nối: <tên bot>"**, và khoá mới xuất hiện trong danh sách khoá. Cập nhật đi qua sự kiện IPC `controlApi:paired`.

Luồng tay cũ (Tạo khoá, khối `.env` mẫu) giữ nguyên.

### 2.2 Vé ghép nối

- Vé gồm 32 byte ngẫu nhiên, mã hoá base64url (43 ký tự). Bộ nhớ chỉ giữ SHA-256 của vé, kèm `{ name, botIp, expiresAt }`.
- **Chỉ lưu trong bộ nhớ** main process. Khởi động lại app thì mọi vé mất hiệu lực, giao diện ghi rõ điều này.
- Hạn dùng **15 phút**, dùng **một lần**. Mỗi IP bot chỉ có 1 vé còn hiệu lực: tạo vé mới cho cùng IP sẽ huỷ vé cũ. Tổng cộng tối đa 5 vé còn hiệu lực; vượt quá thì huỷ vé cũ nhất.
- Vé gắn với IP: request đổi vé phải đến từ đúng `botIp`, so sánh sau `normalizeIp`.
- Lớp mới `PairingTickets` trong `src/services/control/PairingTickets.ts` có 3 hàm: `create`, `consume(ticket, ip)` (trả `{ name } | null`) và `prune`. Đồng hồ được tiêm vào để test.

### 2.3 Điểm cuối mới

Cả hai điểm cuối đi qua đúng các lớp bảo vệ đầu pipeline như v1: allow-list đóng trước TLS, khoá lỗi theo IP, giới hạn kết nối. Chúng không cần `Authorization`.

| Điểm cuối | Hành vi |
|---|---|
| `POST /v1/pair` | Thân request: `{ "ticket": "<43 ký tự>" }`, tối đa 1 KiB.<br>**Vé hợp lệ:** đánh dấu đã dùng **trước** khi tạo khoá, rồi gọi `ControlStore.createKey(name)`. Trả `200 { ok: true, result: { apiKey, keyName } }`, ghi audit `method = "pair"` với `keyId` của khoá mới, và phát IPC `controlApi:paired`.<br>**Vé sai, hết hạn, đã dùng, hoặc sai IP:** trả `401 UNAUTHORIZED` với thông báo chung (không cho biết lý do cụ thể), cộng `lockout.recordFailure(ip)`, ghi audit bị từ chối. |
| `GET /v1/bridge.py` | Trả nội dung `maihub_bridge.py` đóng gói cùng app (`text/x-python; charset=utf-8`). Không cần khoá vì file không chứa bí mật. Vẫn chỉ IP trong allow-list mới tới được. |

- **Nguồn file bridge:**
  - Bản đóng gói: `electron-builder` `extraResources` chép `tools/maihub-bridge/maihub_bridge.py` vào `<resources>/maihub-bridge/maihub_bridge.py`.
  - Chạy dev: đọc thẳng từ `tools/maihub-bridge/`.
  - SHA-256 của file được tính một lần khi server khởi động. UI lấy giá trị này qua `controlApi:getConfig` để dựng lệnh cài.
- **Chế độ nhân viên:** khi app đang ở chế độ nhân viên, `/v1/pair` trả `503 BUSY` như các điểm cuối khác của v1. `/v1/bridge.py` vẫn phục vụ, vì file không chứa bí mật và không thay đổi gì.
- **Mất phản hồi:** nếu bot không nhận được phản hồi của `/v1/pair` (ví dụ đứt mạng), vé coi như đã dùng và khoá vẫn được tạo. Người dùng tạo mã mới; khoá thừa thấy được trong danh sách và thu hồi được. Đây là đánh đổi có chủ đích: không bao giờ phát cùng một khoá hai lần.

### 2.4 Mã ghép nối và lệnh cài

- **Mã ghép nối** có dạng `mhp1.` + base64url của JSON `{"u":"https://<publicHost>:<port>","f":"<dấu vân tay hex>","t":"<vé>","n":"<tên bot>"}`. Mã không chứa API key.
- **Lệnh cài** do UI dựng (một dòng, người dùng chạy bằng root trên VPS bot):

```sh
curl -fsSk https://<publicHost>:<port>/v1/bridge.py -o /root/maihub_bridge.py && echo "<sha256>  /root/maihub_bridge.py" | sha256sum -c - && python3 -I /root/maihub_bridge.py pair '<mã>' --install
```

- `-k` bỏ qua kiểm tra chứng chỉ khi tải file. Tính toàn vẹn của file được đảm bảo bằng `sha256sum -c` với giá trị băm lấy từ UI MaiHub (kênh tin cậy). Nếu file bị tráo, lệnh dừng trước khi chạy Python.
- File tải về nằm ở `/root/`, không đặt ở `/tmp` dùng chung.

### 2.5 Lệnh `pair` của bridge

Cú pháp:

```
maihub_bridge.py pair <mã> [--install] [--bot <tên-service>] [--cli claude|codex] [--dir <thư mục>] [--no-watch] [--notify-env <đường dẫn>]
```

**Chỉ có `<mã>` (không `--install`):**
1. Giải mã.
2. Kết nối có ghim chứng chỉ (dùng `f`).
3. Gọi `POST /v1/pair`.
4. In ra khối `.env` với khoá **đã che** và ghi file `.env` vào `--dir` (mặc định thư mục hiện tại), quyền `0600`.
5. Chạy `doctor`.

**Có `--install`** (bắt buộc chạy bằng root):
1. **Tìm bot.**
   - Quét `/etc/systemd/system/*.service` để tìm unit có `User=` và `Environment=AHV_BOT_DATA_DIR=<dir>`, trong đó `<dir>/.env` có `TG_TOKEN`.
   - Đúng 1 unit thì dùng unit đó. Có nhiều unit thì bắt buộc `--bot`, và thông báo lỗi liệt kê tên các unit. Không có unit nào thì báo lỗi kèm hướng dẫn chạy không `--install`.
2. **Loại CLI.**
   - Lấy từ `--cli`. Nếu thiếu thì suy ra: `User=claudeproxy` → `claude`, `User=codexproxy` → `codex`. Tên service chứa `claude` hoặc `codex` cũng dùng để suy ra.
   - Vẫn không xác định được thì báo lỗi yêu cầu `--cli`.
3. **Thư mục cài:** `--dir`, mặc định `/opt/bot/maihub/<tên-service>/`.
   - Thư mục: `root:<user>`, quyền `750`.
   - Bridge chép vào đây: `root:<user>`, `640`.
   - `.env`: `<user>:<user>`, `600`.
   - Thư mục con `state/`: `<user>:<user>`, `700`.
4. Gọi `POST /v1/pair` và ghi `.env` (ghi đè nếu đã có; khoá cũ vẫn còn hiệu lực cho tới khi thu hồi trong MaiHub). Rồi chạy `doctor` dưới quyền `<user>`.
5. **Đăng ký MCP** dưới quyền `<user>` (`sudo -u <user> -H`, thư mục làm việc là `$HOME`). Nếu đã có server `maihub` thì gỡ rồi thêm lại.
   - Claude: `claude mcp add --scope user maihub -- python3 -I <dir>/maihub_bridge.py mcp --env-file <dir>/.env`
   - Codex: `codex mcp add maihub -- python3 -I <dir>/maihub_bridge.py mcp --env-file <dir>/.env`
   - Trước khi đăng ký, sao lưu file cấu hình CLI (`~/.claude.json` hoặc `~/.codex/config.toml`) vào `<dir>/<tên file>.before-maihub`. Chỉ sao lưu lần đầu, không ghi đè bản sao lưu cũ.
6. Cài `watch` (mục 4.4) với `--notify-env <AHV_BOT_DATA_DIR>/.env`, trừ khi có `--no-watch`.
7. **In tóm tắt:** thư mục, CLI, kết quả `doctor`, tên service `watch`, và lệnh gỡ:
   - `<cli> mcp remove maihub` (Claude kèm `-s user`);
   - `systemctl disable --now maihub-watch-<tên-service>`;
   - xoá thư mục cài.

**Lỗi:**
- Mỗi bước lỗi đều dừng ngay và in bước nào lỗi. Các bước đã xong không bị hoàn tác tự động (đã in sẵn lệnh gỡ).
- Lệnh bên ngoài (`systemctl`, `sudo`, `claude`, `codex`) chạy qua một hàm `run(cmd)` được tiêm vào để test.

Hai bot đang chạy (`/opt/bot/maihub/` trên `.164` và `.38`) **không bị đổi**. Ta chỉ thêm `watch` cho chúng bằng `install-watch` (mục 4.4).

## 3. Phần B: Sức khoẻ tài khoản Facebook

### 3.1 Trạng thái

| `state` | Ý nghĩa |
|---|---|
| `ok` | Đang đăng nhập, trang chủ Facebook mở bình thường |
| `logged_out` | Hết phiên: không có cookie `c_user`, hoặc bị chuyển về trang đăng nhập |
| `checkpoint` | Facebook chuyển về `/checkpoint/` (cần xác minh) |
| `unknown` | Chưa kiểm tra lần nào (giá trị mặc định, không lưu) |

**Bảng mới** `fb_poster_login_state` (thêm vào `schema.ts` của Đăng Facebook, `CREATE TABLE IF NOT EXISTS`):

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `profile_id` | TEXT PRIMARY KEY | |
| `state` | TEXT NOT NULL | `ok` / `logged_out` / `checkpoint` |
| `checked_at` | INTEGER NOT NULL | Lần cuối xác định được trạng thái (mili giây epoch) |
| `source` | TEXT NOT NULL | `check` (kiểm tra) hoặc `run` (lượt đăng) |
| `last_error` | TEXT | Lỗi của lần kiểm tra gần nhất nếu không xác định được, null nếu lần đó thành công |
| `last_error_at` | INTEGER | |

Lần kiểm tra lỗi (mở trình duyệt hỏng, hết giờ, proxy chết) **không đổi `state`**, chỉ ghi `last_error` và `last_error_at`. Lý do: một lỗi mạng không chứng minh được tài khoản hỏng.

### 3.2 Cách kiểm tra một profile

Hàm thuần `classifyLogin(session)` nằm trong file mới `src/services/facebookPoster/loginCheck.ts`, cạnh `loginState.ts`.

1. Mở bằng `openForAutomation(profileId)`.
   - Nếu profile đang mở (lỗi "Profile đang mở…") thì kết quả là `skipped`, không đụng tới bảng.
2. Không có cookie `c_user` → `logged_out`, không cần tải trang.
3. Có cookie thì `page.goto(FB_HOME, { waitUntil: 'domcontentloaded', timeout: 45 s })` và xem `page.url()`:
   - Đường dẫn bắt đầu bằng `/checkpoint` → `checkpoint`.
   - Bắt đầu bằng `/login`, hoặc cookie `c_user` biến mất sau khi tải → `logged_out`.
   - Còn lại → `ok`.
4. Luôn đóng phiên trong `finally`.

Không bấm, không gõ, không cuộn. Chỉ tải đúng một trang.

### 3.3 Không tranh với lượt đăng

- `FacebookPosterService` có thêm hàm `checkLogins(profileIds, source)`. Hàm dùng chung "khe việc" với lượt đăng:
  - Đang có lượt đăng chạy thì báo `BUSY_ERROR`.
  - Đang kiểm tra thì `start()` báo `BUSY_ERROR`.
  - `isBusy()` (đang truyền cho scheduler trong `facebookPosterIpc.ts`) trả `true` cả khi đang kiểm tra.
- Nhờ vậy lịch đăng đến giờ giữa lúc kiểm tra sẽ vào hàng đợi sẵn có của scheduler (chờ tối đa 2 giờ) và chạy ngay khi kiểm tra xong.
- Kiểm tra lần lượt từng profile (không song song) để nhẹ RAM. Mỗi profile tốn khoảng 10–20 giây.
- **Huỷ:**
  - Thoát app (`stop`) thì dừng sau profile đang dở.
  - `runs.cancel` và nút Huỷ của lượt đăng không áp dụng cho việc kiểm tra.

### 3.4 Khi nào kiểm tra

1. **Hằng ngày.**
   - Cấu hình `fb_poster_login_check` trong `app_settings` của workspace, dạng `{ enabled: boolean, time: "HH:MM" }`, mặc định `{ enabled: true, time: "07:00" }` (giờ máy).
   - Lớp `LoginCheckScheduler` (file mới, đồng hồ và timer được tiêm vào) tính lần chạy tiếp theo. Đến giờ thì kiểm tra **mọi profile**.
   - Nếu lúc đó đang bận: thử lại mỗi 5 phút, quá 2 giờ thì bỏ lượt hôm đó và ghi log.
   - App tắt lúc đến giờ thì không chạy bù.
2. **Sau mỗi lượt đăng** (không mở thêm trình duyệt):
   - Lần kiểm tra cookie đầu lượt không thấy `c_user` → ghi `logged_out` (`source = run`).
   - Lượt có ít nhất một kết quả `posted` cho profile → ghi `ok` (`source = run`).
3. **Theo yêu cầu:**
   - Nút **Kiểm tra đăng nhập** trong `ProfilePicker` kiểm tra mọi profile, hoặc chỉ profile đang chọn.
   - Thao tác API `profiles.check` (mục 3.5).

### 3.5 Control API (chỉ thêm)

- **`profiles.list`:** mỗi profile thêm 3 trường:
  - `loginState` (`ok` / `logged_out` / `checkpoint` / `unknown`);
  - `loginCheckedAt` (số hoặc null);
  - `loginError` (chuỗi hoặc null).
- **Thao tác mới `profiles.check`:**
  - Tham số: `{ profileIds?: string[] }`. Bỏ trống nghĩa là mọi profile; tối đa 50 mã.
  - Kết quả trả **ngay**: `{ checkId, profileIds }`. Việc kiểm tra chạy nền, xong thì phát sự kiện `profiles.checkFinished`.
  - Lỗi:
    - `BUSY`: đang có lượt đăng hoặc lượt kiểm tra khác.
    - `NOT_FOUND`: có mã profile không tồn tại; `details.missing` liệt kê các mã đó.
    - `INVALID_PARAMS`: tham số sai.
  - Không đánh dấu `destructive`. Có hỗ trợ `idempotencyKey`.
- **Sự kiện mới:**

| `type` | `payload` | Khi nào |
|---|---|---|
| `profile.loginProblem` | `{ profileId, profileName, state, source }` | Trạng thái lưu **chuyển** sang `logged_out` hoặc `checkpoint` (từ trạng thái khác, kể cả `unknown`). Nếu vẫn giữ nguyên trạng thái hỏng thì không phát lại. |
| `profiles.checkFinished` | `{ checkId, source: "manual" \| "api" \| "daily", results: [{ profileId, profileName, outcome, error? }] }` | Một lượt kiểm tra kết thúc. `outcome` là `ok` / `logged_out` / `checkpoint` / `error` / `skipped`. |

- `run.finished` thêm `scheduleName` (string hoặc null). Đây cũng là thay đổi chỉ-thêm.

### 3.6 Giao diện

Theo `DESIGN.md`. Phải đúng ở cả sáng và tối, desktop và mobile 390 px, không tràn ngang.

- **Huy hiệu trong `ProfilePicker`, cạnh tên mỗi profile:**
  - `logged_out`: chip vàng "Hết phiên".
  - `checkpoint`: chip đỏ "Checkpoint".
  - `ok`: dấu chấm xanh nhỏ, tooltip "Đăng nhập ổn · kiểm tra lúc HH:MM dd/MM".
  - `unknown`: không hiện gì.
  - Có `loginError` thì tooltip thêm "Lần kiểm tra cuối lỗi: …".
- **Đầu `ProfilePicker`:**
  - Nút **Kiểm tra đăng nhập**. Đang chạy thì nút hiện "Đang kiểm tra… (2/5)"; nút bị khoá khi đang có lượt đăng.
  - Nút nhỏ ⚙ mở popover: bật/tắt "Tự kiểm tra mỗi ngày" và ô giờ (`<input type="time">`).
- **Sự kiện IPC mới:**
  - `facebookPoster:loginStateChanged`: danh sách trạng thái mới.
  - `facebookPoster:loginCheckProgress`: `{ done, total }` hoặc `null` khi xong.

## 4. Phần C: Thông báo chủ động (`watch`)

### 4.1 Lệnh

```
maihub_bridge.py watch --env-file <maihub .env> --notify-env <.env của bot> [--state <file>] [--dry-run]
```

- `--state`: mặc định là `state/watch-state.json`, đặt cạnh `--env-file`.
- `--dry-run`: in tin nhắn ra stdout thay vì gửi Telegram. Dùng để thử.

### 4.2 Gửi Telegram

- **Token** lấy từ `TG_TOKEN` trong `--notify-env`. Token chỉ được đọc khi chạy, không bao giờ chép sang file khác hay in ra.
- **Chat nhận tin**, theo thứ tự ưu tiên:
  1. `MAIHUB_NOTIFY_CHAT_ID` trong `.env` MaiHub;
  2. `ALLOWED_CHAT_ID` trong `.env` của bot, kèm `message_thread_id = ALLOWED_TOPIC_ID` nếu có;
  3. `ADMIN_USER_ID`.

  Không có giá trị nào thì `watch` dừng với lỗi rõ ràng.
- **Đường tới Telegram:**
  - `TELEGRAM_API_BASE` trong `.env` MaiHub nếu có.
  - Nếu không, dùng cách bot đang dùng: đọc `/opt/bot/telegram-proxy.url`. Có thể Việt Nam đang chặn `api.telegram.org`, đó là lý do bot dùng proxy.
  - **Định dạng file này phải xác minh trên VPS trước khi viết phần gửi** (việc đầu tiên của phần C trong kế hoạch). Bridge hỗ trợ 2 dạng thường gặp:
    - (a) URL thay cho gốc `https://api.telegram.org`;
    - (b) proxy HTTP/HTTPS chuyển tiếp, dùng `urllib.request.ProxyHandler`.

    Dạng khác (ví dụ SOCKS) thì báo lỗi rõ ràng: thư viện chuẩn không hỗ trợ.
- **Gửi:** `sendMessage`, văn bản thuần (không `parse_mode`, để khỏi phải escape), `disable_web_page_preview`.
  - Lỗi thì thử lại 3 lần (sau 2, 10 và 30 giây). Vẫn lỗi thì ghi log ra stderr rồi bỏ tin đó, để không chặn các tin sau.
  - HTTP 429 thì chờ đúng `retry_after`.

### 4.3 Vòng lặp và trạng thái

- **Lần chạy đầu** (chưa có file trạng thái): đọc hết các trang `events.wait(after, timeoutSec=0)` để lấy `seq` lớn nhất, **không gửi** sự kiện cũ, rồi lưu file.
- **Vòng chính:**
  - `events.wait(after=cursor, timeoutSec=25)`.
  - Mỗi sự kiện: định dạng tin, gửi, rồi lưu `cursor = seq` (ghi file nguyên tử: ghi file tạm rồi `os.replace`).
  - Đảm bảo gửi ít nhất một lần: nếu tiến trình chết đúng lúc giữa gửi và lưu, có thể trùng một tin.
- **`workspaceId` đổi:** nhảy tới `seq` lớn nhất của workspace mới, không gửi lại tin cũ, và gửi 1 tin "Đã chuyển workspace: <tên>".
- **Phát hiện mất liên lạc:**
  - Lỗi kết nối hay hết giờ thì ghi thời điểm lỗi đầu tiên và thử lại sau 15 giây.
  - Lỗi liên tục **≥ 300 giây** thì gửi đúng 1 tin cảnh báo.
  - Kết nối lại được (sau khi đã cảnh báo) thì gửi 1 tin "đã kết nối lại sau X phút".
  - `UNAUTHORIZED` (khoá bị thu hồi) hoặc sai ghim chứng chỉ: gửi 1 tin riêng ngay lập tức, rồi thử lại mỗi 5 phút, không gửi lặp.
- File trạng thái lưu `{ cursor, workspaceId, downSince, downAlerted, authAlerted }`.

### 4.4 Cài như service

Lệnh `install-watch` (cũng là bước 6 của `pair --install`), chạy bằng root:

```
maihub_bridge.py install-watch --env-file <maihub .env> --notify-env <.env bot> --user <user> --name <tên-service-bot>
```

- Lệnh ghi file `/etc/systemd/system/maihub-watch-<tên-service-bot>.service`:
  - `User=<user>`
  - `ExecStart=/usr/bin/python3 -I <bridge> watch --env-file … --notify-env …`
  - `Restart=always`, `RestartSec=10`
  - `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ReadWritePaths=<thư mục state>`, `PrivateTmp=yes`
- Sau đó chạy `systemctl daemon-reload` và `systemctl enable --now`.
- Trước khi cài, lệnh chạy `watch --dry-run` khoảng 5 giây dưới quyền `<user>` để chắc chắn đọc được cả 2 file `.env` và kết nối được MaiHub.
- **Hai bot hiện có** được thêm service bằng lệnh này, dùng `.env` sẵn có ở `/opt/bot/maihub/.env`. Thư mục `state/` tạo mới với quyền `<user>` `700`.

### 4.5 Nội dung tin (tiếng Việt, văn bản thuần)

Tên lượt (`<nhãn>`) lấy theo thứ tự: `scheduleName`; nếu không có thì "Đăng ngay"; nếu kind khác `post` thì dùng nhãn theo kind:
- `join`: "Tham gia nhóm";
- `scan_groups`: "Quét nhóm";
- `collect_comments`: "Thu bình luận".

| Sự kiện | Tin |
|---|---|
| `run.finished`, `status = done`, `failed = 0` | `✅ <nhãn>: xong <posted>/<posted+failed+skipped>` |
| `run.finished`, `failed > 0` | `⚠️ <nhãn>: xong <posted>/<tổng>, lỗi <failed>`, kèm tối đa 3 dòng `• <tên đích>: <lỗi>`. Lỗi lấy từ `runs.get`; nếu `runs.get` lỗi thì gửi phần đầu, không kèm chi tiết. |
| `run.finished`, `status = cancelled` | `⏹ <nhãn>: đã huỷ (<posted>/<tổng>)` |
| `schedule.missed` | `⏰ Lỡ lịch "<name>": <reason>` |
| `profile.loginProblem` | `🔒 Profile "<profileName>": hết phiên đăng nhập` hoặc `bị checkpoint`, kèm dòng `Mở MaiHub để đăng nhập lại.` |
| Mất liên lạc | `⚠️ Không liên lạc được MaiHub (<host>) từ HH:MM. Lỗi: <tóm tắt>` |
| Có lại | `✅ MaiHub đã kết nối lại sau <X> phút` |
| Khoá bị từ chối / sai ghim | `🔑 MaiHub từ chối khoá truy cập…` hoặc `🔐 Chứng chỉ MaiHub không khớp…`, kèm lời khuyên ghép nối lại |

**Không báo:**
- `run.started` và `draft.approved`: bot vừa tự làm hoặc sắp có `run.finished`.
- `profiles.checkFinished`: bot tự hỏi nên tự đọc kết quả. Kiểm tra hằng ngày cũng không gửi tin khi mọi tài khoản đều ổn.

Mọi chuỗi lấy từ MaiHub được cắt còn tối đa 200 ký tự; cả tin cắt còn tối đa 3500 ký tự.

## 5. Cấu trúc mã

**MaiHub:**
- `src/services/control/`:
  - `PairingTickets.ts` (mới).
  - `ControlApiServer.ts`: route `/v1/pair` và `/v1/bridge.py` trước bước xác thực khoá.
  - `ControlMethods.ts`: `profiles.check`; trường đăng nhập trong `profiles.list`.
  - `controlEvents.ts`: 2 sự kiện mới, `scheduleName`.
  - `controlProfiles.ts`: thêm trường.
  - `controlConfig.ts`: `publicHost`, dựng mã và lệnh cài.
- `electron/ipc/controlApiIpc.ts`: kênh `controlApi:createPairing`, `controlApi:cancelPairing`, sự kiện `controlApi:paired`; `getConfig` trả thêm `bridgeSha256`, `publicHost`, `detectedPublicHost`.
- `src/services/facebookPoster/`:
  - `loginCheck.ts` (mới): `classifyLogin`.
  - `LoginCheckScheduler.ts` (mới).
  - `FacebookPosterStore.ts`: đọc/ghi bảng trạng thái, phát `profile.loginProblem` khi có chuyển trạng thái.
  - `FacebookPosterService.ts`: `checkLogins`, chung khe việc, cập nhật bị động.
  - `schema.ts`: bảng mới.
- `electron/ipc/facebookPosterIpc.ts`:
  - kênh `facebookPoster:checkLogins`, `facebookPoster:getLoginStates`, `facebookPoster:getLoginCheckConfig`, `facebookPoster:setLoginCheckConfig`;
  - `isBusy` tính cả việc kiểm tra.
- **UI:**
  - `src/ui/components/settings/ControlApiSettings.tsx`: mục ghép nối. Tách thành `PairingPanel.tsx` nếu file vượt khoảng 450 dòng.
  - `src/ui/features/facebookPoster/ProfilePicker.tsx`: huy hiệu, nút kiểm tra, popover.
- `package.json` `build.extraResources`: thêm bridge.

**Bridge:**
- `tools/maihub-bridge/maihub_bridge.py`: `pair`, `install-watch`, `watch`. Nếu file vượt khoảng 900 dòng thì tách phần `watch` ra module trong cùng thư mục — nhưng **chỉ khi** lệnh cài vẫn chỉ cần tải 1 file.
  - Ràng buộc này có thật, vì `/v1/bridge.py` chỉ phục vụ 1 file. Nếu phải tách thì lệnh cài cần đổi, nên mặc định giữ 1 file.
- `tests/test_bridge.py`: test mới.

## 6. Tài liệu

- `docs/protocol/maihub-control-protocol.md`: điểm cuối, thao tác, sự kiện, trường mới; mục "Ghép nối" và mục "Thông báo Telegram (`watch`)".
- `tools/maihub-bridge/README.md`: `pair`, `install-watch`, `watch`.
- `SYSTEM_DOCUMENTATION.md`: Control API (điểm cuối mới, vé ghép nối), Đăng Facebook (kiểm tra đăng nhập, bảng mới, IPC mới), dòng phiên bản 26.19.0.
- `ChangelogSettings.tsx`: mục 26.19.0.
- `node scripts/check-docs.js` phải sạch.

## 7. Kiểm thử

**Jest (`--runInBand`, giả lập, không vào Facebook thật):**
- `PairingTickets`: hết hạn, dùng một lần, sai IP, tạo vé mới huỷ vé cũ cùng IP, trần 5 vé.
- `/v1/pair` qua pipeline thật của `ControlApiServer`:
  - không cần `Authorization`;
  - vé sai thì cộng khoá lỗi, quá ngưỡng thì bị chặn;
  - có audit;
  - IP ngoài allow-list bị đóng trước TLS;
  - khoá trả về dùng được ngay cho `/v1/describe`.
- `/v1/bridge.py`: đúng nội dung và kiểu MIME; SHA-256 trong `getConfig` khớp.
- `classifyLogin` với context/page giả: 4 nhánh, đóng phiên cả khi lỗi, profile đang mở thì `skipped`.
- `FacebookPosterService`:
  - `start()` báo `BUSY` khi đang kiểm tra, `checkLogins` báo `BUSY` khi đang đăng;
  - scheduler xếp lịch đến giờ vào hàng đợi rồi chạy sau khi kiểm tra xong;
  - cập nhật bị động sau lượt đăng.
- Chuyển trạng thái: chỉ phát `profile.loginProblem` khi chuyển sang trạng thái hỏng. Lỗi kiểm tra không đổi `state`.
- `LoginCheckScheduler`: tính giờ kế tiếp qua nửa đêm, thử lại khi bận, bỏ lượt sau 2 giờ, đổi cấu hình thì hẹn lại.
- `profiles.check` và `profiles.list` (trường mới), `run.finished.scheduleName`.

**Python unittest (thư viện chuẩn):**
- Giải mã mã ghép nối (sai tiền tố, JSON hỏng).
- `pair` với server giả có TLS, dùng fixture sẵn có.
- Quyền file `.env`.
- Tìm bot từ thư mục systemd giả (0, 1, nhiều unit).
- Suy ra loại CLI.
- Lệnh đăng ký MCP dựng đúng, qua hàm `run` giả.
- Nội dung unit systemd.
- `watch`:
  - định dạng từng loại tin;
  - lần đầu bỏ qua sự kiện cũ;
  - lưu cursor nguyên tử;
  - đổi workspace;
  - mất liên lạc ≥ 300 giây thì báo đúng một lần, có lại thì báo một lần (đồng hồ giả);
  - 429 `retry_after`;
  - bỏ tin sau 3 lần lỗi;
  - không in token.

**Chạy thật ở dev:**
- MaiHub dev, allow-list `127.0.0.1`, ghép nối bằng lệnh UI với `pair` (không `--install`) và `watch --dry-run`.
- Kiểm tra đăng nhập với một profile thật **chỉ tải trang**.
- UI ở desktop và 390 px, sáng và tối, 2 vòng stress.

**Hồi quy:**
- Toàn bộ jest và unittest.
- `doctor` và `mcp` với `.env` cũ.
- Luồng tạo khoá tay.
- Đăng, lên lịch, huỷ lượt của Đăng Facebook.

## 8. Triển khai sau phát hành (cần anh duyệt từng bước)

1. Anh cập nhật MaiHub 26.19.0 trên `.230` và `.202`.
2. `.164` (tg-claude-bot) và `.38` (tg-codex-bot):
   - xác minh định dạng `telegram-proxy.url`;
   - chép bridge mới;
   - chạy `install-watch` với `.env` sẵn có;
   - thử bằng cách tắt hoặc bật MaiHub, và bằng một lượt "Đăng ngay" có sẵn trên một nhóm thử (anh chọn).
3. Bot mới sau này thì dùng luồng ghép nối.

## 9. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Tráo file bridge khi tải bằng `curl -k` | `sha256sum -c` với giá trị băm lấy từ UI tin cậy; tải từ IP đã nằm trong allow-list |
| Dò vé ghép nối | 256 bit ngẫu nhiên, 15 phút, một lần, gắn IP, khoá lỗi theo IP, allow-list trước TLS |
| Khoá thừa khi mất phản hồi `/v1/pair` | Hiện trong danh sách khoá, thu hồi được; tên khoá là tên bot |
| Kiểm tra đăng nhập chiếm profile đúng giờ đăng | Chung khe việc với lượt đăng; lịch vào hàng đợi chờ tối đa 2 giờ, kiểm tra thường chỉ vài phút |
| Facebook đổi đường dẫn checkpoint/login | Gom phân loại vào một hàm có test; lỗi không đổi `state` nên không báo nhầm |
| Không tới được Telegram (chặn mạng) | Dùng đúng proxy bot đang dùng (xác minh trước khi code); `watch` báo lỗi gửi ra journal |
| Báo dồn dập | Chỉ báo khi chuyển trạng thái; mất liên lạc chỉ báo 1 lần; không báo `run.started` |
| `pair --install` sửa cấu hình CLI của bot | Sao lưu một lần trước khi sửa, in lệnh gỡ; 2 bot đang chạy không bị đụng |
