# Thiết kế: Bot AI tự làm được nhiều hơn (Đợt 2 tối ưu)

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 21/10/2026 |
| Trạng thái | Đã duyệt 21/10/2026; đã cài đặt (chờ phát hành 26.27.0) |
| Intent | `docs/intent/2026-10-21-bot-autonomy.md` |
| Kế hoạch | `docs/plans/2026-10-21-bot-autonomy.md` |
| Phiên bản dự kiến | 26.27.0 |
| Dùng lại | Control API (`ControlMethods.ts`, `controlEvents.ts`, `ControlStore.ts`), `CommentCollector` + `leadOperations` có sẵn, bridge `tools/maihub-bridge/maihub_bridge.py` |

## 1. Phạm vi

Làm (chỉ thêm, không đổi hành vi cũ):

| # | Việc | Nơi sửa |
|---|---|---|
| A | Lỗi tool MCP kèm `details` và gợi ý xử lý theo mã lỗi | bridge |
| B | Hướng dẫn vòng làm việc: gửi trong `initialize`, và tool `maihub_guide` | bridge |
| C | Tool `maihub_wait_for`: chờ một sự kiện khớp điều kiện trong một lần gọi | bridge |
| D | Thu bình luận: sự kiện `comments.collectFinished`, thao tác `comments.collectStatus`, `comments.collectCancel` | MaiHub |
| E | Sự kiện thêm mã: `leads.found` có `leadIds`, `campaignIds`; `run.finished` có `campaignId`. `system.status` có `serverNowMs`, `timezone`, `utcOffsetMin`, `lastEventSeq` | MaiHub |
| F | Kết quả tool MCP in JSON gọn (không thụt lề); `watch` không báo các lượt việc phụ thành công | bridge |

Không làm trong đợt này:
- luật xác nhận khi duyệt lịch;
- giới hạn bài mỗi profile;
- tự bỏ nhóm "kém";
- tạo ảnh qua API;
- `videos.attach`;
- các thao tác cấu hình còn thiếu (`research` config, `videos.delete`, cấu hình kiểm tra đăng nhập);
- rút gọn danh sách tool.

Các việc này để đợt sau hoặc chờ anh quyết.

## 2. Bridge (`maihub_bridge.py`)

### 2.1 Lỗi có chi tiết và gợi ý (A)

Khi tool lỗi, văn bản trả về gồm tối đa 3 dòng:

```
<MÃ>: <thông báo>
Chi tiết: <details dạng JSON gọn>        (chỉ khi có details)
Gợi ý: <cách xử lý theo mã>              (chỉ khi có gợi ý cho mã đó)
```

| Mã | Gợi ý |
|---|---|
| `BUSY` | MaiHub đang chạy việc khác. Xem bằng `maihub_runs_current`, chờ bằng `maihub_wait_for` (`types: ["run.finished"]`) rồi thử lại. |
| `RATE_LIMITED` | Quá 60 lời gọi/phút. Chờ khoảng 1 phút; dùng `maihub_wait_for` thay vì gọi lặp. |
| `NOT_FOUND` | Mã không tồn tại hoặc đã bị xoá. Lấy lại mã bằng thao tác `…list` tương ứng. |
| `INVALID_PARAMS` | Sửa đúng trường trong `details.field` rồi gọi lại. `mediaId` hết hạn sau 24 giờ: tải tệp lên lại. |
| `LIMIT_REACHED` | Đã chạm giới hạn (số lịch, hộp thư tệp hoặc máy chủ render). Xoá bớt hoặc chờ rồi thử lại. |
| `CONFIRMATION_REQUIRED` | Giữ nguyên hướng dẫn hiện có (`CONFIRM_GUIDANCE`). |
| `ENGINE_MISSING` | Báo người dùng: máy MaiHub chưa cài nhân trình duyệt. |
| `UNAUTHORIZED`, `PIN_MISMATCH` | Báo người dùng: cần ghép nối lại bot với MaiHub. |
| `UNREACHABLE` | MaiHub không phản hồi: thử lại sau ít phút; nếu vẫn lỗi thì báo người dùng. |

CLI giữ nguyên cách in hiện tại (đã in `details`).

### 2.2 Hướng dẫn vòng làm việc (B)

Một hằng `GUIDE` (tiếng Việt, khoảng 400–600 từ) trong bridge:

- **Gửi đi:** trả trong trường `instructions` của kết quả `initialize` (client MCP nào hỗ trợ sẽ đưa vào ngữ cảnh của bot).
- **Đọc lại:** tool `maihub_guide` không tham số trả lại đúng văn bản đó, cho client không đọc `instructions`.

Nội dung:

1. **Vòng làm việc:**
   - `research.search` / `scanGroupFeeds` → chờ `research.finished` → `research.get`;
   - viết nội dung, tải ảnh / video bằng `maihub_upload_media`, hoặc render bằng `videos.render`;
   - `drafts.create` (gắn `campaignId`, `variants`);
   - hỏi người dùng rồi `drafts.approve`;
   - `run.finished` → `runs.get`;
   - `posts.stats` / `groupScores` / `bestTimes`;
   - `comments.collect` → `comments.collectFinished` → `leads.list`.
2. **Quan hệ mã:**
   - `mediaId` sống 24 giờ;
   - `drafts.approve` giữ nguyên mã: mã nháp trở thành `scheduleId`;
   - `runId` có trong `run.started` / `run.finished`;
   - `videoId` → `mediaId` trong `videos.finished`.
3. **Thời gian:** mọi mốc là mili giây epoch; giờ trong ngày (`time`, `bestTimes`) là giờ của máy MaiHub, xem `system.status.timezone`; `runAt` phải sau hiện tại ít nhất 1 phút, tính theo `serverNowMs`.
4. **Chờ việc:** dùng `maihub_wait_for` kèm mã việc; giữ `after` để không bỏ sót sự kiện.
5. **Lệnh ghi:** luôn gửi `idempotencyKey` (gọi lại sau lỗi mạng không bị tạo trùng); thao tác nguy hiểm cần hỏi người dùng rồi mới gửi `confirm: true`.
6. **Mã lỗi khi đăng** (`runs.get`):
   - `uncertain_after_submit`: có thể đã đăng, phải kiểm tra trước khi đăng lại;
   - `not_logged_in`: báo người dùng đăng nhập lại;
   - các mã khác MaiHub đã tự thử lại.

Một test kiểm `GUIDE` có nhắc đúng tên các tool `maihub_wait_for`, `maihub_upload_media`, `maihub_download_video` và các sự kiện chính, để văn bản không lệch khỏi code.

### 2.3 `maihub_wait_for` (C)

Tham số:

| Tham số | Kiểu | Ý nghĩa |
|---|---|---|
| `types` | mảng chuỗi, tuỳ chọn | Chỉ nhận các loại sự kiện này |
| `match` | đối tượng, tuỳ chọn | Mọi cặp `trường: giá trị` phải bằng đúng trong `payload` (ví dụ `{"videoId": "…"}`, `{"jobId": "…"}`, `{"scanId": "…"}`); giá trị là chuỗi, số hoặc boolean |
| `after` | số nguyên ≥ 0, tuỳ chọn | Chỉ xét sự kiện có `seq > after`. Bỏ trống thì dùng **mốc của phiên** (xem dưới) |
| `maxSec` | 1–600, mặc định 50 | Chờ tối đa. Mặc định 50 vì một số client MCP cắt tool sau 60 giây |

**Mốc của phiên:** lúc `initialize`, bridge gọi `system.status` một lần và lấy `lastEventSeq`.
- Nếu MaiHub cũ không có trường này, hoặc lời gọi lỗi, thì bridge tính mốc ở lần `wait_for` đầu tiên (duyệt `events.wait timeoutSec=0` tới hết như `watch`).
- Nhờ mốc này, việc bot khởi chạy **sau khi** phiên bắt đầu sẽ không bị lỡ sự kiện, kể cả việc xong rất nhanh.
- Mốc của phiên không tự tiến: mỗi lần `wait_for` không có `after` đều xét lại từ mốc đó, nên chờ nhiều việc lần lượt không làm mất sự kiện của nhau.

**Vòng chờ:** gọi `events.wait(after = con trỏ, timeoutSec = min(25, thời gian còn lại))` rồi xét từng sự kiện theo `seq`:
- `workspaceId` đổi so với lần đầu → trả `{ "workspaceChanged": true }`.
- Sự kiện khớp `types` và `match` → trả `{ "event": {…}, "after": <seq của sự kiện> }`.
- Hết giờ → trả `{ "timedOut": true, "after": <seq lớn nhất đã xét> }`.

Mỗi vòng tốn một lời gọi trong tối đa 25 giây, nên không chạm giới hạn 60 lời gọi/phút. Lỗi (`UNREACHABLE`…) trả như mục 2.1.

### 2.4 Kết quả gọn và `watch` bớt ồn (F)

- **Kết quả tool:** in bằng `json.dumps(…, ensure_ascii=False, separators=(",", ":"))`. CLI giữ thụt lề như cũ.
- **`watch` / `run.finished`:** với `kind` là tham gia nhóm, quét nhóm hoặc thu bình luận, có `status = done` và `failed = 0` thì không gửi tin. Bị huỷ, có lỗi, hoặc lượt đăng bài thì gửi như cũ.
- **`watch` / `comments.collectFinished`:** không gửi tin; khách mới đã có tin `🎯`.

## 3. MaiHub

### 3.1 `system.status` (E)

Thêm vào kết quả, giữ nguyên các trường cũ:

| Trường | Giá trị |
|---|---|
| `serverNowMs` | `Date.now()` lúc trả lời |
| `timezone` | `Intl.DateTimeFormat().resolvedOptions().timeZone` (ví dụ `Asia/Ho_Chi_Minh`; có thể `UTC`) |
| `utcOffsetMin` | `-new Date().getTimezoneOffset()` (ví dụ 420) |
| `lastEventSeq` | `seq` lớn nhất trong `control_events` của workspace đang mở; 0 nếu chưa có |

`ControlStore` thêm `lastEventSeq()` (`SELECT MAX(seq)`); `ControlMethodDeps.events` thêm `lastSeq()`.

### 3.2 Thu bình luận: trạng thái, huỷ, sự kiện xong (D)

**`comments.collectStatus`** (không tham số, không nguy hiểm). Trả đúng `leadOperations.collectStatus()` đã có cho giao diện:
- `{ running, jobId, progress: { done, total }, last }`;
- `last` là lượt gần nhất `{ jobId, auto, finishedAt, cancelled, posts, collected, leads, errors }` hoặc `null`;
- `errors` cắt còn tối đa 10 dòng `{ postUrl, profileId, error }`.

**`comments.collectCancel`** (không tham số). Trả `{ cancelled }` từ `leadOperations.collectCancel()`. Không nguy hiểm (`destructive: false`), giống `posts.trackCancel` hiện có, vì thu bình luận chỉ đọc Facebook. Không có lượt nào thì trả `cancelled: false`.

**Sự kiện `comments.collectFinished`** (`buildCollectFinished`):
- payload `{ jobId, auto, cancelled, posts, collected, leads, errors }`, trong đó `errors` là số lỗi;
- phát trong `getCollector().emit` của `facebookPosterIpc.ts`, cùng lúc với `facebookPoster:commentCollectFinished` cho giao diện;
- phát cho cả lượt tự thu lẫn lượt do bot / người gọi; bot lọc bằng `jobId`;
- `CommentCollector` thêm `cancelled` vào payload `comments.collectFinished` đang phát (hiện thiếu).

Control API từ 47 lên **49** thao tác. `ControlEventType` thêm `comments.collectFinished`.

### 3.3 Sự kiện có thêm mã (E)

- **`leads.found`:**
  - thêm `leadIds`: tối đa 20 mã, mới nhất trước;
  - thêm `campaignIds`: các `campaignId` khác `null`, không trùng, tối đa 20;
  - `buildLeadsFoundPayload` đã nhận danh sách khách đầy đủ nên chỉ cần thêm trường;
  - giữ nguyên `count`, `samples`, `auto`.
- **`run.finished`:** thêm `campaignId` (từ run; `null` nếu không thuộc chiến dịch).

## 4. Tương thích

| Kết hợp | Kết quả |
|---|---|
| Bridge cũ + MaiHub mới | Trường mới bị bỏ qua. Sự kiện mới `comments.collectFinished` lọt qua `format_event` cũ (loại lạ → không gửi tin). Hai thao tác mới tự thành tool vì danh sách tool sinh từ `/v1/describe`. |
| Bridge mới + MaiHub 26.26.0 | Không có `lastEventSeq` thì `wait_for` tự tính mốc bằng cách duyệt sự kiện. Không có `comments.collectFinished` thì chờ theo `jobId` sẽ hết giờ; `GUIDE` ghi rõ cần MaiHub ≥ 26.27.0. |
| Hành vi cũ | Không đổi: luật xác nhận, mã lỗi, các trường cũ, cách in của CLI. |

## 5. Kiểm thử

- **Jest:**
  - `system.status` có 4 trường mới;
  - `ControlStore.lastEventSeq` (rỗng → 0);
  - `comments.collectStatus` / `collectCancel` gọi đúng cổng;
  - `buildCollectFinished`, `buildLeadsFound` (cắt 20, bỏ trùng, bỏ `null`), `buildRunFinished` có `campaignId`;
  - `CommentCollector` phát `cancelled`;
  - `describe` liệt kê 49 thao tác.
- **Bridge unittest:**
  - lỗi có `Chi tiết` / `Gợi ý`;
  - `initialize` có `instructions`; `maihub_guide`;
  - `wait_for`: khớp ngay, khớp sau vài vòng, hết giờ, đổi workspace, `after`, mốc phiên khi có và khi không có `lastEventSeq`, sự kiện xảy ra trước lời gọi `wait_for` nhưng sau khi phiên bắt đầu;
  - JSON gọn;
  - `watch` im với lượt phụ thành công, vẫn báo khi lỗi;
  - `comments.collectFinished` im.
- **Tích hợp thật trên MaiHub dev (2 vòng):**
  - ghép bridge với app dev;
  - chạy vòng mẫu "thu bình luận → chờ xong → đọc khách" và "render video → chờ xong → tải về" qua MCP;
  - đếm số lời gọi trước và sau thay đổi;
  - thử bridge mới với MaiHub 26.26.0 và bridge 26.26.0 với MaiHub mới.
- Không có thay đổi giao diện, nên không cần chụp desktop / mobile.

## 6. Rủi ro

| Rủi ro | Cách giảm |
|---|---|
| `GUIDE` lệch khỏi code theo thời gian | Để `GUIDE` cạnh định nghĩa tool trong bridge; có test kiểm tên tool / sự kiện. |
| Client MCP cắt tool chạy lâu | `maxSec` mặc định 50; `GUIDE` dặn gọi lại với `after` khi `timedOut`. |
| `comments.collectFinished` của tự thu mỗi 15 phút làm nhiều dòng sự kiện | Chỉ phát khi có lượt thu thật (có bài đến hạn). Sự kiện vẫn giữ trong giới hạn 7 ngày / 5000 dòng hiện có. |

## Ghi chú sau cài đặt

- `initialize` trả lời trước rồi mới lấy mốc phiên (`system.status`), để MaiHub chậm không làm client MCP chờ; tin nhắn MCP xử lý tuần tự nên mốc vẫn có trước lời gọi tool đầu tiên.
- Mốc phiên lưu cả `workspace.id`; đổi workspace (trước hoặc trong lúc chờ) thì bridge lấy ngay mốc của workspace mới lúc phát hiện rồi trả `workspaceChanged` (lỗi mạng khi lấy mốc thì xoá mốc, lần sau tính lại). Kiểm tích hợp cho thấy nếu chỉ xoá mốc thì sự kiện xảy ra trước lần chờ kế tiếp bị bỏ lỡ.
- Đo trên harness tích hợp: chờ một việc 70 giây trong lúc có sự kiện khác mỗi 5 giây, cách cũ (`events_wait` lặp) tốn 17 lời gọi tool / 7712 byte kết quả, `maihub_wait_for` tốn 2 lời gọi / 224 byte.
- `match` so cả kiểu: `true` không khớp `1`.
- `watch` im với lượt tham gia nhóm / quét nhóm / thu bình luận xong không lỗi, kể cả khi lượt đó chạy từ lịch.
- `buildRunFinished` nhận `campaignId` tuỳ chọn (dữ liệu cũ không có thì `null`).
- `GUIDE` có thêm khối "Giới hạn cần nhớ" (60 lời gọi/phút, một việc một lúc, làm theo dòng Gợi ý).
- Sau review cuối: `maihub_wait_for` nhận thêm `workspaceId` (tuỳ chọn, đi cùng `after`) và trả `workspaceId` cùng `after`, vì bridge không biết `after` của bot thuộc workspace nào khi MaiHub đổi workspace nhiều lần. Không có `workspaceId` thì so với workspace của mốc phiên.
- Gợi ý `BUSY` không còn bảo chờ `run.finished` không kèm `after` (dễ nhận lại sự kiện cũ rồi lặp); nay bảo chờ 1–2 phút hoặc dùng `after = system.status.lastEventSeq`.
- Lấy mốc mới ưu tiên `system.status.lastEventSeq` (một lời gọi), chỉ duyệt `events.wait` khi MaiHub cũ không có trường này; mốc lỗi lúc `initialize` được thử lại trước lời gọi tool kế tiếp; hạn chờ dùng `time.monotonic`.
