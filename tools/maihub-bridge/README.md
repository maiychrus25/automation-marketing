# MaiHub bridge

Tệp Python một mình (`maihub_bridge.py`, chỉ dùng thư viện chuẩn, Python >= 3.6) để bot gọi giao thức điều khiển MaiHub: chạy như CLI hoặc như MCP server qua stdio (Claude CLI, Codex).

## Cài trên VPS của bot

Chạy bằng chính user dịch vụ của bot (ví dụ `botuser`), để khoá API chỉ user đó đọc được.

```bash
sudo mkdir -p /opt/bot/maihub
sudo cp maihub_bridge.py /opt/bot/maihub/
sudo chmod 755 /opt/bot/maihub/maihub_bridge.py

sudo tee /opt/bot/maihub/.env >/dev/null <<'ENV'
MAIHUB_URL=https://<ip-may-maihub>:47321
MAIHUB_API_KEY=mh_...
MAIHUB_CERT_SHA256=<dau-van-tay-sha256>
ENV
sudo chown botuser:botuser /opt/bot/maihub/.env
sudo chmod 600 /opt/bot/maihub/.env
```

Khoá API và dấu vân tay lấy ở màn hình Cài đặt, mục điều khiển bot của MaiHub (khoá chỉ hiện một lần lúc tạo). Dấu vân tay nhận cả dạng có dấu hai chấm lẫn không, chữ hoa lẫn thường.

Kiểm tra:

```bash
sudo -u botuser python3 /opt/bot/maihub/maihub_bridge.py --env-file /opt/bot/maihub/.env doctor
```

`doctor` kiểm lần lượt: cấu hình, kết nối TCP, ghim chứng chỉ, `/v1/health`, xác thực khoá; in phiên bản giao thức và số thao tác. Khoá được che trong đầu ra. Thoát khác 0 nếu có bước hỏng.

## Đăng ký MCP

Chạy lệnh dưới bằng đúng user sẽ chạy Claude CLI của bot (cấu hình MCP nằm theo user):

```bash
sudo -u botuser claude mcp add maihub -- python3 /opt/bot/maihub/maihub_bridge.py mcp --env-file /opt/bot/maihub/.env
```

`--env-file` đặt trước hoặc sau tên lệnh con đều được (`mcp --env-file X` hay `--env-file X mcp`).

Codex (`~/.codex/config.toml` của user đó):

```toml
[mcp_servers.maihub]
command = "python3"
args = ["/opt/bot/maihub/maihub_bridge.py", "mcp", "--env-file", "/opt/bot/maihub/.env"]
```

Danh sách tool sinh tự động từ `GET /v1/describe` (`maihub_<thao_tac>`, dấu chấm thành gạch dưới), cộng tool `maihub_upload_media` nhận `path`. Mỗi tool có thêm tham số tuỳ chọn `idempotencyKey` để chống gọi trùng. Nếu MaiHub chưa với tới được lúc liệt kê tool, bridge trả lỗi và thử lại ở lần liệt kê kế tiếp.

## CLI

```bash
python3 maihub_bridge.py --env-file .env describe
python3 maihub_bridge.py --env-file .env call system.status
python3 maihub_bridge.py --env-file .env call drafts.list '{"limit": 5}'
python3 maihub_bridge.py --env-file .env call drafts.create '{"mode":"group","text":"Xin chào"}' --idempotency-key bai-001
python3 maihub_bridge.py --env-file .env call drafts.approve '{"id":"<ma-nhap>","when":{"kind":"once","runAt":<epoch-ms-trong-tương-lai>}}'
python3 maihub_bridge.py --env-file .env call drafts.approve '{"id":"<ma-nhap>","when":"now","confirm":true}'
python3 maihub_bridge.py --env-file .env call runs.cancel '{"confirm": true}' --auto-idem
python3 maihub_bridge.py --env-file .env upload /duong/dan/anh.jpg
python3 maihub_bridge.py --env-file .env wait --after 0 --timeout 25
```

`runAt` là mili giây epoch, phải sau hiện tại ít nhất 1 phút (thay `<epoch-ms-trong-tương-lai>` bằng số thật, ví dụ lấy từ `date -d '+1 day' +%s000`); `when: "now"` đăng ngay nên bắt buộc `confirm: true`. `upload` chỉ nhận đuôi jpg, jpeg, png, gif, webp, mp4, mov, webm. Kết quả JSON ra stdout. Lỗi ra stderr dạng `<MÃ_LỖI>: thông báo`; mã thoát 1 là lỗi từ MaiHub, 2 là thiếu hoặc sai cấu hình, 3 là lỗi mạng hoặc ghim chứng chỉ. Khoá chống gọi trùng chỉ gửi khi có `--idempotency-key` hoặc `--auto-idem`. `wait` ghi nhớ `after` là việc của bot: lấy `seq` lớn nhất đã nhận. Kết quả `wait` kèm `workspaceId`; `seq` thuộc DB từng workspace nên khi `workspaceId` đổi thì đặt lại `after` về 0.

### Ghép nối (`pair`)

```bash
python3 maihub_bridge.py pair 'mhp1.…' --dir /duong/dan/thu-muc
```

Mã ghép nối lấy từ giao diện MaiHub (sống 15 phút, dùng một lần, không chứa khoá API). Lệnh giải mã mã, kết nối và so ghim chứng chỉ TRƯỚC, rồi mới gửi vé tới `POST /v1/pair` (không gửi `Authorization`). Thành công thì ghi `MAIHUB_URL`, `MAIHUB_CERT_SHA256`, `MAIHUB_API_KEY` vào `<dir>/.env` (mặc định thư mục hiện tại, quyền 600 ngay từ lúc tạo), in khối `.env` với khoá đã che, rồi chạy `doctor`. Nếu `.env` đã có thì chỉ thay/nối đúng 3 khoá đó, giữ nguyên mọi dòng khác (`TELEGRAM_PROXY`, `MAIHUB_NOTIFY_CHAT_ID`, ...). `pair` (không `--install`) từ chối ghi vào tệp có `TG_TOKEN=` (đó là `.env` của bot) và không dùng vé; khi có service `maihub-watch-*` thì in lệnh `systemctl restart` (watch cũng tự nạp lại `.env` sau mỗi lần chờ khi bị từ chối khoá). Vé sai, hết hạn hoặc đã dùng thì thoát mã 1; mã sai định dạng thoát mã 2; ghim lệch hoặc không kết nối được thoát mã 3 và vé không được gửi đi.

### Cài cho bot AHV (`pair --install`)

```bash
sudo python3 maihub_bridge.py pair 'mhp1.…' --install [--bot <tên-service>] [--cli claude|codex] [--dir <thư mục>] [--no-watch]
```

Bắt buộc chạy bằng root. Lệnh quét `/etc/systemd/system/*.service` tìm unit bot AHV (có `User=` và `Environment=AHV_BOT_DATA_DIR=<dir>` với `<dir>/.env` chứa `TG_TOKEN`). Có đúng một bot thì dùng bot đó; nhiều bot thì bắt buộc `--bot <tên-service>` (lỗi liệt kê tên các unit và không sửa gì); không có bot nào thì báo lỗi. `--cli` mặc định suy ra từ `User=` (`claudeproxy` là claude, `codexproxy` là codex) hoặc tên service. `--dir` mặc định `/opt/bot/maihub/<tên-service>/`.

Thứ tự: kiểm tra mọi thứ trước (bot, CLI, user) rồi mới tạo thư mục (`root:<user>` 750, bridge 640, `.env` `<user>:<user>` 600, `state/` 700), ghép nối, ghi `.env`, chạy `doctor`, sao lưu cấu hình CLI vào `<dir>/<tên file>.before-maihub` (chỉ lần đầu), đăng ký MCP `maihub` dưới quyền user của bot, rồi cài service `watch` (`install-watch` bên dưới; bỏ qua bằng `--no-watch`). Trước khi đụng hệ thống, lệnh từ chối (lỗi cấu hình) nếu thư mục cài, `state/` hoặc thư mục `.env` là symlink, hoặc thư mục cha của thư mục cài không do root sở hữu / nhóm-người khác ghi được. Tóm tắt cuối in đường dẫn bản sao lưu cấu hình CLI (`.before-maihub`); lệnh `rm -rf <dir>` in ở phần gỡ cũng xoá luôn tệp này. Bước nào lỗi thì dừng và in tên bước; các bước đã xong không tự hoàn tác. Nếu ghi `.env` lỗi sau khi vé đã dùng thì MaiHub đã tạo một khoá: hãy thu hồi khoá đó rồi tạo mã ghép nối mới.

Gỡ cài đặt (lệnh cũng được in cuối lần cài):

```bash
sudo -u <user> -H claude mcp remove maihub -s user   # Codex: sudo -u <user> -H codex mcp remove maihub
sudo systemctl disable --now maihub-watch-<tên-service>.service
sudo rm /etc/systemd/system/maihub-watch-<tên-service>.service
sudo rm -rf /opt/bot/maihub/<tên-service>
```

### Thông báo chủ động (`watch`)

```bash
python3 maihub_bridge.py watch --env-file <.env MaiHub> --notify-env <.env của bot> [--state <tệp>] [--dry-run]
```

`watch` chờ sự kiện MaiHub (`events.wait`, 25 giây một lượt) rồi gửi tin tiếng Việt qua Telegram bằng chính token của bot (`TG_TOKEN` trong `--notify-env`; token chỉ đọc lúc chạy, không ghi ra đâu cả).

- Chat nhận tin, theo thứ tự: `MAIHUB_NOTIFY_CHAT_ID` (`.env` MaiHub), `ALLOWED_CHAT_ID` (kèm `ALLOWED_TOPIC_ID` nếu có; nhiều giá trị cách nhau dấu phẩy thì lấy giá trị đầu), `ADMIN_USER_ID` (`.env` bot). Không có giá trị nào thì dừng với lỗi cấu hình.
- Đường tới Telegram: đặt `TELEGRAM_API_BASE` (thay cho `https://api.telegram.org`) hoặc `TELEGRAM_PROXY` (`http://` hoặc `https://`; SOCKS không được hỗ trợ) trong `.env` MaiHub nếu VPS cần đi qua proxy để tới Telegram. `TELEGRAM_API_BASE` bắt buộc `https://` (token nằm trong đường dẫn). Bridge không tự đọc `/opt/bot/telegram-proxy.url`: `install-watch` in CẢNH BÁO nếu tệp đó tồn tại mà `.env` MaiHub chưa đặt cả hai khoá trên. `watch --check-telegram` gọi Telegram `getMe` một lần qua tuyến đã chọn rồi thoát (mã 0 = được; không in token).
- `--state`: mặc định `state/watch-state.json` cạnh `--env-file` (ghi nguyên tử, lưu con trỏ sự kiện). Lần chạy đầu bỏ qua sự kiện cũ. Gửi ít nhất một lần: tiến trình chết giữa lúc gửi và lưu thì có thể trùng một tin.
- `--dry-run`: in tin ra stdout, không gửi Telegram.
- Gửi lỗi thì thử lại sau 2, 10, 30 giây (HTTP 429 thì chờ `retry_after`), vẫn lỗi thì ghi stderr và bỏ tin đó.

Các loại tin: `✅` lượt xong; `⚠️` lượt có lỗi (kèm tối đa 3 dòng `• đích: lỗi`); `⏹` lượt bị huỷ; `⏰` lỡ lịch; `🔒` profile hết phiên hoặc bị checkpoint; `⚠️` mất liên lạc MaiHub từ 300 giây (một tin) và `✅` khi kết nối lại; `🔑` khoá bị từ chối và `🔐` sai ghim chứng chỉ (một tin, thử lại mỗi 5 phút); "Đã chuyển workspace" khi MaiHub đổi workspace. Không báo `run.started`, `draft.approved`, `profiles.checkFinished`.

### Cài `watch` thành service (`install-watch`)

```bash
sudo python3 maihub_bridge.py install-watch --env-file <.env MaiHub> --notify-env <.env của bot> --user <user> --name <tên-service-bot> [--state-dir <thư mục>] [--skip-telegram-check]
```

`pair --install` tự gọi lệnh này; hai bot cài từ trước (`/opt/bot/maihub/.env`) thì chạy tay. Bắt buộc root. Thứ tự: kiểm tra đầu vào (tệp tồn tại, user có thật, tên service chỉ gồm `A-Za-z0-9@._-`, đường dẫn không có khoảng trắng) → tạo `--state-dir` (mặc định `state/` cạnh `--env-file`, `<user>:<user>` 700) → chạy thử `watch --dry-run` dưới quyền user khoảng 5 giây (chỉ chứng minh hai tệp `.env` đọc được và có chat nhận tin; không chứng minh MaiHub hoặc Telegram với tới được; thoát lỗi sớm thì dừng, chưa ghi gì) → chạy `watch --check-telegram` dưới quyền user (gọi Telegram `getMe`; lỗi thì dừng, chưa ghi unit; bỏ qua bằng `--skip-telegram-check`) → ghi `/etc/systemd/system/maihub-watch-<tên-service>.service` (0644, ghi nguyên tử) → `systemctl daemon-reload` → `systemctl enable` rồi `systemctl restart` (chạy lại lệnh sẽ áp dụng unit, bridge hoặc khoá mới cho service đang chạy). Unit chạy `python3 -I <bridge> watch ...` với `Restart=always`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ReadWritePaths=<state-dir>`, `PrivateTmp=yes`. Bridge dùng bản nằm cạnh `--env-file` nếu có, không thì chính tệp đang chạy.

## Bảo mật

- Ghim chứng chỉ: bridge không kiểm CA hay tên miền, mà so SHA-256 chứng chỉ đầu cuối với `MAIHUB_CERT_SHA256` bằng so sánh hằng thời gian. Bắt tay TLS xong và khớp ghim thì mới gửi yêu cầu; lệch thì dừng, khoá API không rời máy.
- Khoá API: chỉ nằm trong `.env` (quyền 600, đúng user) hoặc biến môi trường; không nhập trên dòng lệnh, không in ra. Nghi lộ thì thu hồi và tạo khoá mới ở MaiHub.
- Thao tác nguy hiểm (xoá, huỷ, duyệt đăng...) bị MaiHub từ chối bằng `CONFIRMATION_REQUIRED` nếu thiếu `confirm: true`. Qua MCP, model nhận kèm hướng dẫn hỏi người dùng rồi mới gọi lại với `confirm: true`; đừng tự đặt `confirm: true` khi người dùng chưa đồng ý.
- MaiHub chỉ nhận IP trong danh sách cho phép và giới hạn tốc độ theo khoá; mọi lời gọi được ghi nhật ký.

## Kiểm thử

```bash
python3 -m unittest discover -s tools/maihub-bridge/tests -v
```
