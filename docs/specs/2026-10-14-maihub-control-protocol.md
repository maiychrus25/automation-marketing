# Thiết kế: Giao thức điều khiển MaiHub (MaiHub Control Protocol v1)

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 14/10/2026 |
| Trạng thái | Đã duyệt (14/10/2026) |
| Kế hoạch | `docs/plans/2026-10-14-maihub-control-protocol.md` |
| Intent | `docs/intent/2026-10-14-maihub-control-protocol.md` (đã duyệt) |
| Nhánh | `feat/maihub-control-protocol` |
| Môi trường thử | Bot: VPS Linux `161.248.81.164`; MaiHub: VPS Windows `161.248.81.230` (chỉ mở RDP) |

## 1. Tổng quan

```
Telegram ⇄ bot AI (VPS Linux, Claude CLI)
                │  công cụ MCP "maihub" (stdio)  /  CLI "maihub"
                ▼
        maihub_bridge.py  ── HTTPS + khoá + ghim chứng chỉ ──▶  MaiHub (VPS Windows)
                                                               Control API (tiến trình chính)
                                                               → cùng hàm với IPC của app
```

- **MaiHub** mở một máy chủ HTTPS trong tiến trình chính (Node `https`). Máy chủ mặc định tắt; chủ máy bật trong Cài đặt.
- **Phía bot** có một tệp Python stdlib `maihub_bridge.py` chạy được theo hai chế độ:
  - `mcp`: MCP server qua stdio, khai báo cho Claude CLI bằng `claude mcp add maihub -- python3 maihub_bridge.py mcp`;
  - CLI: ví dụ `maihub_bridge.py call drafts.list`.
- Danh sách công cụ MCP **sinh tự động** từ `GET /v1/describe`, nên MaiHub thêm thao tác mới thì bot dùng được ngay, không cần sửa bridge.

## 2. Vận chuyển và bảo mật

| Hạng mục | Thiết kế |
|---|---|
| Cổng | Mặc định `47321`, đổi được; nghe `0.0.0.0` |
| TLS | Chứng chỉ tự ký RSA-2048, tạo lần đầu bật, lưu ở `userData/control-api/` (khoá riêng mã hoá bằng `safeStorage`). Bridge **ghim dấu vân tay SHA-256** của chứng chỉ (`MAIHUB_CERT_SHA256`); sai thì từ chối, không cần tên miền hay CA |
| Thư viện | Thêm dependency `selfsigned` (dựa trên `@peculiar/x509` + `pkijs`, sửa khi triển khai, 14/10/2026) chỉ để tạo chứng chỉ X.509. Lý do: Node không tự tạo được chứng chỉ, và không nên tự viết bộ mã hoá ASN.1 |
| Xác thực | `Authorization: Bearer <khoá>`. Khoá 32 byte ngẫu nhiên, dạng `mh_<base64url>`, chỉ hiện **một lần** khi tạo. DB chỉ lưu SHA-256 của khoá kèm tên (ví dụ "Claude bot", "Codex bot"). Có nhiều khoá, thu hồi từng khoá |
| Giới hạn IP | Danh sách IP/CIDR được phép, **bắt buộc khác rỗng** mới bật được API (ví dụ `161.248.81.164`). Kết nối ngoài danh sách bị đóng ngay, trước TLS |
| Chống dò khoá | Sai khoá 10 lần trong 10 phút từ một IP thì chặn IP đó 15 phút. Mỗi khoá tối đa 60 lời gọi/phút |
| Chế độ nhân viên | Máy chủ không chạy; đang chạy mà chuyển sang chế độ nhân viên thì dừng |
| Tường lửa Windows | App không tự mở cổng (cần quyền admin). Cài đặt hiện sẵn lệnh `netsh advfirewall firewall add rule …` để chủ máy chạy |
| Nhật ký | Bảng `control_audit`: thời điểm, tên khoá, IP, thao tác, tóm tắt tham số (không có nội dung bài hay khoá), kết quả hoặc mã lỗi, thời gian xử lý. Giữ 30 ngày; Cài đặt hiện 100 dòng gần nhất. Lời gọi `/v1/call` bị từ chối (sai khoá, IP bị khoá, quá tốc độ) cũng được ghi, không đọc thân yêu cầu; quá tốc độ chỉ ghi lần đầu của mỗi khoá trong mỗi cửa sổ 60 giây (sửa khi triển khai, 14/10/2026) |

## 3. Giao thức

### 3.1 Điểm cuối

| Phương thức | Đường dẫn | Mục đích |
|---|---|---|
| `GET` | `/v1/describe` | Phiên bản giao thức, danh sách thao tác kèm JSON Schema tham số/kết quả, mô tả tiếng Việt, cờ `destructive` |
| `POST` | `/v1/call` | Gọi một thao tác: `{ "method": "drafts.create", "params": {…}, "idempotencyKey": "…" }` |
| `POST` | `/v1/media` | Tải một tệp (thân là nhị phân; header `X-Filename`, `Content-Type`). Trả `{ mediaId, name, size, kind }` |
| `GET` | `/v1/health` | Không cần khoá, chỉ trả `{ ok: true, protocol: 1 }` (vẫn chịu giới hạn IP) |

### 3.2 Phản hồi

- Thành công: `{ "ok": true, "result": {…} }`
- Lỗi: `{ "ok": false, "error": { "code": "…", "message": "<tiếng Việt>", "details": {…} } }`, kèm HTTP 4xx/5xx phù hợp.
- Mã lỗi cố định:
  - `UNAUTHORIZED`, `FORBIDDEN_IP`, `RATE_LIMITED`;
  - `INVALID_PARAMS` (kèm `details.field`), `NOT_FOUND`;
  - `CONFIRMATION_REQUIRED`, `BUSY` (đang có việc chạy), `ENGINE_MISSING`;
  - `LIMIT_REACHED` (ví dụ 200 lịch), `PAYLOAD_TOO_LARGE`, `UNKNOWN_METHOD`, `INTERNAL`.

### 3.3 Quy tắc chung

- **Phiên bản:** đường dẫn có `/v1`. Trong cùng v1 chỉ được *thêm* thao tác hoặc tham số tuỳ chọn; đổi nghĩa thì sang `/v2`.
- **Xác nhận:** thao tác có `destructive: true` bắt buộc `params.confirm === true`, nếu thiếu thì trả `CONFIRMATION_REQUIRED` và không làm gì. Bot dùng mã này để hỏi người dùng trên Telegram trước, rồi gọi lại. Thao tác chỉ destructive có điều kiện (như `drafts.approve` khi `when = "now"`) có `destructive: true` kèm trường cộng thêm `destructiveWhen` trong `/v1/describe` (sửa khi triển khai, 14/10/2026).
- **Chống chạy trùng:** thao tác ghi nhận `idempotencyKey` (tuỳ chọn, ≤ 64 ký tự). Cùng khoá truy cập và cùng `idempotencyKey` trong 24 giờ thì trả lại kết quả cũ, không làm lại.
- **Cùng đường với app:** mỗi thao tác gọi đúng hàm mà IPC của app đang gọi (mục 5), nên kiểm tra, giới hạn và thông báo lỗi giống hệt khi thao tác trong app.
- **Kích thước:** thân `/v1/call` ≤ 1 MB. Tệp `/v1/media` theo giới hạn ảnh hiện có (`MAX_IMAGE_BYTES` 20 MB). Video tối đa 200 MB, chỉ khi luồng đăng hiện tại hỗ trợ video.

### 3.4 Thao tác v1

| Thao tác | Tham số chính | Ghi chú |
|---|---|---|
| `system.status` | — | Phiên bản app, workspace đang mở, nhân trình duyệt (đã cài / sandbox), scheduler chạy hay không, việc đang chạy (`runs.current`) |
| `profiles.list` | — | `id`, `name`, nhóm profile, trạng thái đang mở, ngày quét nhóm gần nhất |
| `profiles.groups` | `profileIds[]` | Nhóm đã quét của mỗi profile (`url`, `name`) |
| `profiles.scanGroups` | `profileIds[]` | Bắt đầu việc quét nhóm (như nút trong app), trả `runId`; `BUSY` nếu đang có việc |
| `drafts.list` | `limit`, `offset` | Nháp (lịch `draft = 1`) |
| `drafts.get` | `id` | |
| `drafts.create` | `text`, `mediaIds[]`, `comment?`, `commentDelayMin?`, `profiles[{profileId, targets[]}]`, `mode`, giãn cách… | Cùng tham số và kiểm tra với "Lưu nháp" trong app. `mediaIds` ánh xạ sang tệp đã tải |
| `drafts.update` | `id` + trường cần đổi | |
| `drafts.delete` | `id`, `confirm` | destructive |
| `drafts.approve` | `id`, `when: "now" \| {kind:"once", runAt} \| {kind:"recurring", …}`, `confirm` khi `now` | "Đăng ngay" là destructive; `runAt` là mili giây epoch (sửa khi triển khai, 14/10/2026) |
| `schedules.list` | — | Kèm `queuedIds` |
| `schedules.update` | `id`, giờ / bật-tắt / tên | Cùng `planScheduleUpdate` |
| `schedules.delete` | `id`, `confirm` | destructive; từ chối khi lịch đang chạy (giống app) |
| `runs.current` | — | Run và tiến độ |
| `runs.list` | `limit`, `offset`, `kind?` | |
| `runs.get` | `runId` | Kèm kết quả từng đích, link bài, trạng thái bình luận |
| `runs.cancel` | `confirm` | destructive; dùng cơ chế hủy của 26.17.0 |
| `events.wait` | `after` (số thứ tự), `timeoutSec` ≤ 25 | Long-poll: trả ngay các sự kiện có `seq > after`, hoặc chờ tới khi có, tối đa `timeoutSec` |

### 3.5 Sự kiện

- Bảng `control_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type, payload JSON, created_at)`, giữ 7 ngày, tối đa 5.000 dòng.
- Loại v1:
  - `run.started`, `run.finished` (`status`, số `posted`/`failed`/`skipped`, `runId`, `scheduleId`);
  - `schedule.missed`;
  - `draft.approved`, ghi nhận cả khi duyệt trong app lẫn qua API.
- Nguồn: các nơi đã phát `facebookPoster:runFinished`, `facebookPoster:scheduleMissed` và luồng duyệt nháp. Chỉ ghi thêm, không đổi hành vi cũ.
- Bot tự hỏi lại bằng `events.wait`, nên MaiHub không cần gọi ngược về bot. `seq` bền qua khởi động lại; bot lưu `after` của mình.

### 3.6 Tệp media

- `/v1/media` lưu tệp vào `userData/control-api/inbox/<mediaId>`, chỉ nhận đuôi ảnh/video mà luồng đăng hỗ trợ. Kiểm tra kích thước và loại bằng `mediaRules` hiện có.
- `drafts.create`/`update` chuyển `mediaIds` thành đường dẫn tệp rồi gọi `saveDraft`. `saveDraft` đã sao tệp sang thư mục của lịch.
- Tệp trong inbox chưa dùng quá 24 giờ thì bị xoá.

## 4. Phía bot: `maihub_bridge.py`

- Python ≥ 3.6, chỉ stdlib (`ssl`, `http.client`, `json`, `hashlib`), khớp các script trên VPS 164. Nằm trong repo MaiHub tại `tools/maihub-bridge/`.
- Cấu hình qua biến môi trường hoặc tệp `.env` cạnh bot: `MAIHUB_URL` (`https://<ip>:47321`), `MAIHUB_API_KEY`, `MAIHUB_CERT_SHA256`.
- Kiểm chứng chỉ bằng ghim SHA-256: tắt kiểm tên miền và CA, so dấu vân tay chứng chỉ đầu cuối, lệch thì dừng.
- **Chế độ `mcp`:** MCP stdio (JSON-RPC 2.0, `initialize`, `tools/list`, `tools/call`).
  - Mỗi thao tác trong `/v1/describe` thành một tool `maihub_<tên>` (dấu chấm thành gạch dưới), mô tả và `inputSchema` lấy nguyên từ MaiHub.
  - Thêm tool `maihub_upload_media(path)`.
  - Lỗi `CONFIRMATION_REQUIRED` trả về cho model kèm hướng dẫn "hỏi người dùng rồi gọi lại với confirm: true".
- **Chế độ CLI:**
  - `describe`;
  - `call <method> [json]`;
  - `upload <path>`;
  - `wait [--after N]`;
  - `doctor`: kiểm kết nối, ghim chứng chỉ, khoá và đồng hồ.
- Test bằng `unittest` với máy chủ HTTPS giả (chứng chỉ tạo trong test bằng `ssl` + tệp mẫu trong `tools/maihub-bridge/tests/fixtures`).

## 5. Phía MaiHub: cấu trúc mã

- `electron/ipc/facebookPosterIpc.ts`: tách thân mỗi handler thành hàm có tên trong `posterOperations` (export), rồi `handle(channel, posterOperations.x)`. Hành vi IPC không đổi.
- `src/services/control/`, phần lõi thuần, test được:
  - `ControlApiServer` (HTTPS, giới hạn IP, xác thực, giới hạn tốc độ, định tuyến);
  - `ControlMethods` (bảng thao tác: schema, `destructive`, hàm gọi);
  - `ControlKeyStore` (băm và kiểm khoá);
  - `ControlEvents`;
  - `ControlAudit`;
  - `IdempotencyCache`.
  - Các phần này nhận phụ thuộc qua constructor (DI) để test không cần Electron.
- `electron/ipc/controlApiIpc.ts`: Cài đặt bật/tắt, cổng, IP được phép, tạo/thu hồi khoá, xem dấu vân tay và nhật ký. Bọc bằng `handle()` hiện có, có chặn chế độ nhân viên.
- **Giao diện:** mục "Điều khiển từ bot" trong Cài đặt, theo `DESIGN.md`. Hiện địa chỉ, dấu vân tay, khoá vừa tạo (một lần, có nút sao chép), lệnh `netsh`, và đoạn cấu hình mẫu cho bot.
- **DB:** bảng `control_keys`, `control_audit`, `control_events`, `control_idempotency` trong DB của workspace (giống lịch Đăng Facebook, vốn theo workspace). Đổi workspace thì API dùng DB mới; khoá theo workspace.

## 6. Tài liệu

- `docs/protocol/maihub-control-protocol.md`: tài liệu cho người viết bot, gồm điểm cuối, mã lỗi, từng thao tác, ví dụ `curl`/CLI, luồng mẫu "ý tưởng → nháp → duyệt → chờ kết quả".
- `tools/maihub-bridge/README.md`: cài trên VPS bot, `claude mcp add`, `.env`, `doctor`.
- `SYSTEM_DOCUMENTATION.md`: mục mới về API điều khiển, kèm dấu `docs-check` cho cổng mặc định và các giới hạn.

## 7. Kiểm thử

| Loại | Nội dung |
|---|---|
| Unit (jest) | Xác thực khoá (đúng, sai, thu hồi), chặn IP, giới hạn tốc độ, `CONFIRMATION_REQUIRED`, `idempotencyKey`, định tuyến và mã lỗi, `events.wait` (có ngay, chờ, hết giờ), tải media (đuôi, kích thước) |
| Unit | Mỗi thao tác gọi đúng hàm `posterOperations` với đúng tham số; lỗi kiểm tra của app thành `INVALID_PARAMS` |
| Hồi quy | Toàn bộ test Đăng Facebook hiện có không đổi; IPC trả đúng như trước |
| Python | `unittest` cho bridge: ghim chứng chỉ đúng/sai, MCP `tools/list`/`tools/call`, CLI |
| Tích hợp (máy dev) | Bật API trên MaiHub dev, gọi bằng bridge (CLI và MCP qua stdio) từ máy dev: `system.status`, tạo nháp có ảnh, duyệt hẹn giờ xa, `events.wait`, huỷ. Không đăng thật |
| Chủ sản phẩm | Cài bridge trên VPS 164, mở cổng trên VPS Windows, cho bot Telegram tạo một nháp |

## 8. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Lộ khoá → người lạ điều khiển MaiHub | Giới hạn IP bắt buộc, khoá chỉ hiện một lần, thu hồi được, nhật ký; thao tác nguy hiểm cần `confirm` |
| Mở cổng ra Internet | Chỉ nhận IP trong danh sách; TLS; mặc định tắt |
| Bot (AI) gọi sai tham số | Lỗi `INVALID_PARAMS` có `field` và lời giải thích tiếng Việt; dùng đúng kiểm tra của app |
| Bot gọi lại nhiều lần (mạng chập chờn) | `idempotencyKey` |
| Refactor IPC làm đổi hành vi | Chỉ tách thân handler thành hàm có tên, không sửa logic; toàn bộ test cũ phải xanh |
| Dependency mới (`selfsigned` (+ `@peculiar/x509`, `pkijs`)) | Chỉ dùng để tạo chứng chỉ một lần; ghi trong NOTICE nếu cần; không nạp lúc khởi động khi API tắt |
