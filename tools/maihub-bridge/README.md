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

`runAt` là mili giây epoch, phải sau hiện tại ít nhất 1 phút (thay `<epoch-ms-trong-tương-lai>` bằng số thật, ví dụ lấy từ `date -d '+1 day' +%s000`); `when: "now"` đăng ngay nên bắt buộc `confirm: true`. `upload` chỉ nhận đuôi jpg, jpeg, png, gif, webp, mp4, mov, webm. Kết quả JSON ra stdout. Lỗi ra stderr dạng `<MÃ_LỖI>: thông báo`; mã thoát 1 là lỗi từ MaiHub, 2 là thiếu hoặc sai cấu hình, 3 là lỗi mạng hoặc ghim chứng chỉ. Khoá chống gọi trùng chỉ gửi khi có `--idempotency-key` hoặc `--auto-idem`. `wait` ghi nhớ `after` là việc của bot: lấy `seq` lớn nhất đã nhận.

## Bảo mật

- Ghim chứng chỉ: bridge không kiểm CA hay tên miền, mà so SHA-256 chứng chỉ đầu cuối với `MAIHUB_CERT_SHA256` bằng so sánh hằng thời gian. Bắt tay TLS xong và khớp ghim thì mới gửi yêu cầu; lệch thì dừng, khoá API không rời máy.
- Khoá API: chỉ nằm trong `.env` (quyền 600, đúng user) hoặc biến môi trường; không nhập trên dòng lệnh, không in ra. Nghi lộ thì thu hồi và tạo khoá mới ở MaiHub.
- Thao tác nguy hiểm (xoá, huỷ, duyệt đăng...) bị MaiHub từ chối bằng `CONFIRMATION_REQUIRED` nếu thiếu `confirm: true`. Qua MCP, model nhận kèm hướng dẫn hỏi người dùng rồi mới gọi lại với `confirm: true`; đừng tự đặt `confirm: true` khi người dùng chưa đồng ý.
- MaiHub chỉ nhận IP trong danh sách cho phép và giới hạn tốc độ theo khoá; mọi lời gọi được ghi nhật ký.

## Kiểm thử

```bash
python3 -m unittest discover -s tools/maihub-bridge/tests -v
```
