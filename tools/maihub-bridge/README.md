# MaiHub bridge

Tệp Python một mình (`maihub_bridge.py`, chỉ dùng thư viện chuẩn, Python >= 3.6) để bot gọi giao thức điều khiển MaiHub: chạy như CLI hoặc như MCP server qua stdio (Claude CLI, Codex).

## Ghi chú Task 8 — kiểm chứng composition local

Integration suite `src/__tests__/dailyBrief/pageCampaignAutonomy.integration.test.ts` gọi Python bridge thật bằng stdin với credential tạm và pinned loopback HTTPS, dùng registry/auth/SQLite/operations/scheduler thật. Sender được giả lập, không gửi Telegram hoặc chạy CLI/provider thật. Grant confirmation, latest-only report, dedup và uncertain send qua Python process restart được kiểm riêng; không chứng minh credential isolation hoặc fresh-HOME auth trên máy chạy thật. Mẫu confirmed measurement/optimization là synthetic, không phải proof từ production publisher; actual composition vẫn giữ unconfirmed/unavailable và chặn autonomous first comment.

Tasks 1–8 đã review local; final F1 public-poll correction bên dưới đã qua scoped re-review, không còn finding trong diff sửa lỗi. Controller chạy lại hai matrix 29/29, full Jest chuẩn 125 suites/3157 tests và Python 363; TS/docs/diff exit 0. Đây không phải nghiệm thu tổng thể: gate thật `protectedWritesEnabled=false`, không deploy/capability mới. Make/lint targets thiếu, randomized legacy `groupContactType` seeds 2707/3707 lỗi thứ tự, packaging/live identity/collector/current-publish/receiver isolation/fresh-HOME auth còn blocked. UI không đổi (render N/A); chưa bình luận độc lập, doanh thu/ROI vẫn unavailable.

## Ghi chú local dev — Page campaign autonomy Task 3

Task 3 bổ sung server methods scoped `pageCampaigns.schedule/updateSchedule/cancelSchedule`, variants của draft và reservation quota bền; **chưa thêm campaign tool flow vào protected runner**, không quảng bá `pageCampaigns:1`. Runtime execution vẫn bị service chặn trước tạo run/mở browser cho đến live guard Task 4; grant không có nghĩa sẵn sàng tự đăng. Gate thật `protectedWritesEnabled=false` giữ nguyên; không cài/deploy hay migration DB khách trong task này. Contract chi tiết ở mục 2.8 của `docs/protocol/maihub-control-protocol.md`.

Protected prompt chỉ dùng facts `confirmed` do `pageBusiness.get` server trả về cho giá, cam kết, vùng phục vụ và khả năng đáp ứng. Thiếu dữ kiện cần thiết thì giữ nháp và gọi `pageWork.fail` với `needs_review`, không tự xác nhận hoặc bịa. Server kiểm provenance/fact basis và content/media-byte fingerprints; metadata factIds **không chứng minh mọi câu tự do là đúng**. Customer preparation.notes giữ nguyên. Revoke/renew không chuyển lịch cũ sang grant mới; quota submitting/uncertain không trả lại để retry mù. Owner schedules và quyền Phase A độc lập được giữ.

### Ghi chú bổ sung Task 4 — server-only guard, chưa bật runner

Server local dev đã có execution guard kiểm live key/grant/captured context, selected payload/media và identity trong browser đang đăng tại publish/first-comment barriers; recovery giữ submitting/uncertain quota và không resend mù. Đây không phải capability advertisement hoặc cho phép bridge tự chạy campaign: không thêm tool flow, không giả owner, không đổi gate thật false. Owner effects thiếu immutable Page attribution được tính upper bound bảo thủ, có thể giảm capacity autonomy còn lại; không sửa owner history. Synthetic tests chưa chứng minh composer actor thật, receiver isolation hoặc packaging. Sau review Task 4, autonomous first comment bị bỏ qua (giữ posted, postUrl=null/commentStatus=no_post_url nếu có comment): own-feed/snippet và response-window Story/story_create không phải bằng chứng exact current publish. Guard không cấp comment authority chỉ từ Page identity; chưa có supported proof để bật comment. Autonomous click rejection không được Enter-resend; owner paths giữ nguyên. Chi tiết bổ sung ở protocol mục 2.9.

### Ghi chú bổ sung Task 5 — measurement server-only

Server local dev thêm `pageCampaigns.collect` (runner lease, một scoped milestone/shared slot) và `pageCampaigns.report` (read scoped, coverage/unknown/provenance, finance unavailable). Không thêm Python tool/runner flow hoặc capability. Production chưa có current-publish target đáng tin: registry giữ unavailable và không loại khỏi mẫu đủ tuổi; fixtures không phải live collector proof. Gate thật false, optimizer và release gates vẫn chưa mở. Contract ở protocol mục 2.10.

### Ghi chú bổ sung Task 6 — optimization server-only

Server thêm `pageCampaigns.optimize` scoped với decision bền/atomic apply/replay, chỉ từ bằng chứng server còn tồn tại và cohort run bất biến (≥5 mẫu, ≥80% coverage/mỗi ứng viên, cùng mốc tuổi/format/revision). Thiếu dữ liệu hoặc plannedAt thì keep, không tự chọn ngày; chỉ đổi một yếu tố, không tăng quota hoặc sửa owner/effect-started schedules. HTTP cached/pending retry vẫn revalidate durable authority/evidence. Không thêm Python tool/runner flow, không quảng bá capability, gate thật false. Current-publish targets production vẫn null/unconfirmed; synthetic tests không chứng minh live delivery, release blockers giữ nguyên. Contract đầy đủ ở protocol mục 2.11.

### Ghi chú bổ sung Task 7 — bridge/runner/receiver local dev, chưa bật vận hành

Giữ các interface `build_tools`, `protected_brief_tick`, `ProtectedWatcher.deliver/poll` và `handle_owner_update`. MCP vẫn lấy methods từ `/v1/describe` đã lọc; prompt chỉ bổ sung tên `pageCampaigns.*` thật được mô tả, không giả capability `pageCampaigns:1`. Không có grant thì chỉ nháp/đề nghị; read visibility không phải consent. Grant hiện hành mới cho phép scoped scheduling/collect/optimize trong lease và policy server. Các campaign vẫn dùng một claim/Page, cùng daily ledger tối đa ba agent invocation; receiver report không gọi agent. Fresh HOME/XDG/env/MCP và provider/model/sandbox không đổi.

Receiver render grant/revoke từ exact proposal/grant revision đọc qua scoped list/get, giữ prepare → compare normalized action → persist intent → send_once → bind. Reply phải đúng sender/chat/message/expiry và current revision; không parse JSON thành lệnh. Proposal nêu Page, mục tiêu, thời hạn UTC, giờ/timeZone, actions, quota và cách thu hồi; không tự gia hạn. Poll đọc campaign list/get/report độc lập work đã prune; report 28 ngày chốt tại đầu ngày UTC, khóa send-once gồm workspace/Page/campaign/revision, grant revisions/status và kỳ báo cáo. Mỗi kỳ báo một lần; cập nhật metrics đến muộn sẽ có ở kỳ kế tiếp. Delivery intent/uncertain không gửi lại mù, kể cả restart; cần đối soát qua transport tin cậy.

Coverage null/tương tác null giữ “chưa đo được”, lead không phải đơn; finance luôn unavailable, không ROI giả. Receiver không chứng minh quyết định từ output AI. **Bổ sung integration Task 7 theo ruling controller:** existing scoped `pageCampaigns.get` trả thêm `latestDecision:null|{decision:CampaignDecision,evidenceAvailable:boolean}`. Chọn decision mới nhất theo persisted createdAt rồi ID giảm dần, đúng workspace/Page/profile/campaign, không cần work cũ hoặc grant còn hiệu lực. Không trả requestHash/stateHash/action/executionRevision hay owner credentials. Evidence availability được kiểm lại từ observation và nguồn ResearchStore hiện tại; không refs/nguồn mất thì false, không tái tạo số liệu.

Receiver hiển thị keep/variant/time mới nhất cùng ID/ngày, before/after/reason, grant/revision, sampleSizes/coverage **tại thời điểm quyết định**, nguồn và availability hiện tại. Dedup key thêm decision ID và evidenceAvailable nên decision mới hoặc mất nguồn trong cùng kỳ vẫn có thông báo; uncertain vẫn không retry mù. `latestDecision` null/vắng trên server cũ là chưa có quyết định được ghi nhận, không fake success. Grant/history đọc được không chứng minh campaign/brief/identity đang runnable hoặc lịch tương lai còn tồn tại. Đây chỉ là latest-state summary: **không đảm bảo phát lại mọi quyết định trung gian**; không thêm endpoint, pagination, quyền hoặc migration.

Ghi chú final campaign review: `ProtectedWatcher.poll()` nhận mixed `pageWork.events`; hai campaign hint `pageCampaigns.proposalChanged/grantChanged` không có workId và không được gọi `pageWork.get`. Campaign đã được đối soát qua durable reads; work hints vẫn recovery/list/get/draft như cũ và cursor được persist. Restart không gửi lại sent/uncertain notification. Không blanket catch malformed work event hoặc lỗi auth/scope/workspace; test composition dùng pinned HTTPS và public poll, không chứng minh receiver live.

Ghi chú repair review Task 7: khi `pageApprovals.prepare` từ chối **grantCampaign** bằng `CONFLICT` (Page/brief/primary/campaign không còn eligible), `deliver` trả `{status:'ineligible',ticket:null}` trước persist/send. Proposal chưa có delivery intent nên poll sau có thể thử chuẩn bị lại nếu eligible; proposal khác, report và work/draft reconciliation vẫn tiếp tục. Chỉ xử lý conflict tại đúng prepare này; lỗi authorization/scope/transport/system và normalized-action mismatch vẫn propagate, không hạ authority.

Protected delivery kiểm trước giới hạn Telegram 4.096 bằng đơn vị UTF-16 bảo thủ (ký tự ngoài BMP tính hai). Report dài dùng một summary bounded, lược chi tiết grant/policy và excerpt mẫu/coverage/refs với số ký tự/chi tiết bị lược cùng con trỏ `pageCampaigns.get/report`; vẫn giữ latest decision, nguồn hiện tại, null/finance và phân biệt recorded grant với quyền thực thi. Normal report vẫn đầy đủ và gửi một lần; identity/restart/uncertain semantics không đổi, không retry hoặc tăng transport limit. **Consent grant/revoke không bao giờ clip/split policy**: nếu bản đầy đủ không vừa thì trả `{status:'oversize',ticket:null}` trước prepare/send/local intent; cần đề nghị đầy đủ ngắn hơn qua luồng tin cậy. Mọi text protected còn vượt giới hạn cũng bị từ chối trước persist/send, không đánh dấu uncertain cho lỗi size đã biết.

Staging chỉ synthetic transport/providers; chưa chạy CLI thật hoặc send Telegram thật. `protectedWritesEnabled=false` giữ nguyên, không timer/service mới. Receiver VPS entrypoint thật, OS-user/file/env/MCP separation, auth của CLI với fresh HOME, current-publish proof/firstComment/live lookup và packaging vẫn chưa được chứng minh. Make build/test/lint là acceptance gates riêng, không thay bằng TypeScript checks. Không dùng các lệnh cài legacy bên dưới để vượt các blockers này.

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

Danh sách tool sinh tự động từ `GET /v1/describe` (`maihub_<thao_tac>`, dấu chấm thành gạch dưới), cộng tool `maihub_upload_media` nhận `path` và tool `maihub_download_video` (`videoId`, `kind` = `video` / `thumb`, `path` tuỳ chọn) tải video đã render xong (hoặc ảnh bìa) về máy bot, mặc định `~/maihub-videos/<videoId>.mp4|.jpg`, trả `{ path, sizeBytes }` để bot gửi tệp hoặc xem ảnh bìa; tool `maihub_wait_for` (`types?`, `match?`, `after?`, `maxSec` 1–600 mặc định 50) chờ một sự kiện khớp trong một lần gọi; tool `maihub_guide` trả bản hướng dẫn vòng làm việc (cũng gửi trong `instructions` của `initialize`). Tool lỗi trả kèm `Chi tiết` (`details`) và `Gợi ý` cách xử lý theo mã lỗi; kết quả là JSON gọn. Chi tiết: `docs/protocol/maihub-control-protocol.md` mục 10. Mỗi tool có thêm tham số tuỳ chọn `idempotencyKey` để chống gọi trùng. Nếu MaiHub chưa với tới được lúc liệt kê tool, bridge trả lỗi và thử lại ở lần liệt kê kế tiếp.

### Video quảng cáo AI nhiều cảnh (MaiHub từ 26.31.0)

Tool `maihub_videos_adCreate` (sinh tự động từ `videos.adCreate`) dựng video dọc 1080x1920 từ một **kịch bản** nhờ AHV AI: AI vẽ ảnh, đọc lời tiếng Việt, cho ảnh chuyển động, khớp môi người dẫn, nhạc nền và khung cuối. Khác `maihub_videos_render` (mẫu HyperFrames trên máy chủ render của anh).

Vòng gọi: `maihub_upload_media` (ảnh/nhạc có sẵn → `mediaId`) → `maihub_videos_adCreate` → `maihub_wait_for` (`types: ["videos.finished"]`, `match: {"videoId": "<videoId>"}`) → `drafts.create { mediaIds }` hoặc `maihub_download_video`.

```bash
python3 maihub_bridge.py --env-file .env call videos.adCreate '{
  "name": "Khai truong",
  "scenes": [
    {"type": "presenter", "line": "Chào bạn, cửa hàng mới khai trương."},
    {"type": "ai", "prompt": "bright clothing store, morning light", "motion": "slow dolly in", "voiceover": "Thiết kế tối giản, chất liệu thoáng mát."},
    {"type": "image", "imageMediaId": "<mediaId>"}
  ],
  "presenter": {"imageMediaId": "<mediaId>"},
  "voice": {"name": "hai_dang", "speed": 0.9},
  "music": {"prompt": "nhạc quảng cáo tươi vui, không lời"},
  "brand": {"website": "example.com", "endLine": "Ghé cửa hàng hôm nay."}
}'
```

- Chạy nền **rất lâu**: thường 20–60 phút, tối đa 150 phút. Theo tiến độ bằng `maihub_videos_status` (`progress` 0–1, `stepText` như `H3 3/7`, `Khớp môi 1/2`) hoặc chờ sự kiện; đừng hỏi dồn dập.
- `videos.finished` có thể kèm `warnings`: `stt_mismatch` (đọc sai chữ viết tắt/số/tên riêng), `fallback_still` (một cảnh thành ảnh tĩnh), `cut_by_cost_cap` / `cut_by_time`. Video dùng được nhưng nên cho người xem lại trước khi đăng.
- `maihub_videos_cancel` chỉ dừng theo dõi ở MaiHub: **job phía AHV AI vẫn chạy và vẫn tốn tiền máy**.
- Cần cấu hình AHV AI trong MaiHub (Cài đặt → Máy chủ render video → thẻ AHV AI); chưa cấu hình thì nhận `INVALID_PARAMS`.

## CLI

```bash
python3 maihub_bridge.py --env-file .env describe
python3 maihub_bridge.py --env-file .env call system.status
python3 maihub_bridge.py --env-file .env call drafts.list '{"limit": 5}'
python3 maihub_bridge.py --env-file .env call drafts.create '{"mode":"group","text":"Xin chào"}' --idempotency-key bai-001
python3 maihub_bridge.py --env-file .env call drafts.approve '{"id":"<ma-nhap>","when":{"kind":"once","runAt":<epoch-ms-trong-tương-lai>}}'
python3 maihub_bridge.py --env-file .env call drafts.approve '{"id":"<ma-nhap>","when":"now","confirm":true}'
python3 maihub_bridge.py --env-file .env call runs.active
python3 maihub_bridge.py --env-file .env call runs.cancel '{"confirm": true, "runId": "<ma-run>"}' --auto-idem
python3 maihub_bridge.py --env-file .env call runs.cancel '{"confirm": true}' --auto-idem   # chỉ khi tối đa một lượt đang chạy
python3 maihub_bridge.py --env-file .env upload /duong/dan/anh.jpg
python3 maihub_bridge.py --env-file .env download-video <ma-video> [--kind thumb] [-o /duong/dan/]
python3 maihub_bridge.py --env-file .env wait --after 0 --timeout 25
```

MaiHub chạy tối đa 2 lượt cùng lúc. `runs.active` liệt kê các lượt (mỗi phần tử có `run.id`); `runs.cancel` có từ 2 lượt đang chạy mà không gửi `runId` trả `CONFLICT` (không tự chọn lượt, không có đường dự phòng): gọi `runs.active`, chọn rồi gửi lại với `runId`. `runId` của lượt đã xong trả `{"cancelled": false}`, mã lạ trả `NOT_FOUND`. Tool MCP được dựng từ danh mục `describe` được cache theo phiên, nên sau khi nâng cấp MaiHub phải khởi động lại phiên MCP để thấy `maihub_runs_active` và tham số `runId`. Khoá scoped không có hai thao tác này. `runAt` là mili giây epoch, phải sau hiện tại ít nhất 1 phút (thay `<epoch-ms-trong-tương-lai>` bằng số thật, ví dụ lấy từ `date -d '+1 day' +%s000`); `when: "now"` đăng ngay nên bắt buộc `confirm: true`. `upload` chỉ nhận đuôi jpg, jpeg, png, gif, webp, mp4, mov, webm và nhạc mp3, m4a, wav (nhạc chỉ để làm `musicMediaId` của `videos.render`, không dùng cho bản nháp). Kết quả JSON ra stdout. Lỗi ra stderr dạng `<MÃ_LỖI>: thông báo`; mã thoát 1 là lỗi từ MaiHub, 2 là thiếu hoặc sai cấu hình, 3 là lỗi mạng hoặc ghim chứng chỉ. Khoá chống gọi trùng chỉ gửi khi có `--idempotency-key` hoặc `--auto-idem`. `wait` ghi nhớ `after` là việc của bot: lấy `seq` lớn nhất đã nhận. Kết quả `wait` kèm `workspaceId`; `seq` thuộc DB từng workspace nên khi `workspaceId` đổi thì đặt lại `after` về 0.

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

Các loại tin: `✅` lượt xong; `⚠️` lượt có lỗi (kèm tối đa 3 dòng `• đích: lỗi`); `⏹` lượt bị huỷ; `⏰` lỡ lịch; `🔒` profile hết phiên hoặc bị checkpoint; `📈` theo dõi bài đăng (`posts.trackFinished`, chỉ khi có link mới hoặc bài có thể đã bị xoá); `🎯` khách tiềm năng mới (`leads.found`, số khách kèm tối đa 3 dòng `tên: nội dung` cắt 80 ký tự; không báo khi không có khách mới); `🎬` video xong (`videos.finished`, `🎬 Video xong: <tên> (<giây>s)`; video ≤ 50 MiB được tải về thư mục trạng thái rồi gửi kèm bằng `sendVideo` với dòng đó làm chú thích, xoá tệp tạm sau khi gửi; quá giới hạn hoặc lỗi thì gửi chữ như cũ; `--dry-run` không tải) và `⚠️ Video lỗi: <tên> — <lỗi cắt 120 ký tự>` (video bị huỷ, `cancelled = true`, thì không báo); `⚠️` mất liên lạc MaiHub từ 300 giây (một tin) và `✅` khi kết nối lại; `🔑` khoá bị từ chối và `🔐` sai ghim chứng chỉ (một tin, thử lại mỗi 5 phút); "Đã chuyển workspace" khi MaiHub đổi workspace. Không báo `run.started`, `draft.approved`, `profiles.checkFinished`.

### Cài `watch` thành service (`install-watch`)

```bash
sudo python3 maihub_bridge.py install-watch --env-file <.env MaiHub> --notify-env <.env của bot> --user <user> --name <tên-service-bot> [--state-dir <thư mục>] [--skip-telegram-check]
```

`pair --install` tự gọi lệnh này; hai bot cài từ trước (`/opt/bot/maihub/.env`) thì chạy tay. Bắt buộc root. Thứ tự: kiểm tra đầu vào (tệp tồn tại, user có thật, tên service chỉ gồm `A-Za-z0-9@._-`, đường dẫn không có khoảng trắng) → tạo `--state-dir` (mặc định `state/` cạnh `--env-file`, `<user>:<user>` 700) → chạy thử `watch --dry-run` dưới quyền user khoảng 5 giây (chỉ chứng minh hai tệp `.env` đọc được và có chat nhận tin; không chứng minh MaiHub hoặc Telegram với tới được; thoát lỗi sớm thì dừng, chưa ghi gì) → chạy `watch --check-telegram` dưới quyền user (gọi Telegram `getMe`; lỗi thì dừng, chưa ghi unit; bỏ qua bằng `--skip-telegram-check`) → ghi `/etc/systemd/system/maihub-watch-<tên-service>.service` (0644, ghi nguyên tử) → `systemctl daemon-reload` → `systemctl enable` rồi `systemctl restart` (chạy lại lệnh sẽ áp dụng unit, bridge hoặc khoá mới cho service đang chạy). Unit chạy `python3 -I <bridge> watch ...` với `Restart=always`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ReadWritePaths=<state-dir>`, `PrivateTmp=yes`. Bridge dùng bản nằm cạnh `--env-file` nếu có, không thì chính tệp đang chạy.

### Cài đề xuất bài mỗi 15 phút (`install-brief`)

```bash
sudo python3 maihub_bridge.py install-brief --env-file <.env MaiHub> --user <user> --name <tên-service-bot> [--state-dir <thư mục>] [--agent-cmd 'codex exec -']
```

Bắt buộc root, chạy riêng cho từng bot đã ghép nối. Thứ tự: kiểm tra đầu vào (tệp tồn tại, user có thật, tên service chỉ gồm `A-Za-z0-9@._-`, đường dẫn không có khoảng trắng; từ chối thư mục `.env` hoặc trạng thái là symlink và thư mục cha trạng thái không đáng tin như `install-watch`) → chạy `brief-tick --dry-run` dưới quyền user; nếu có `--agent-cmd`, dùng bản `.env` ứng viên (quyền 600) trong thư mục tạm riêng (700), thuộc user bot và được dọn sau kiểm tra → chỉ khi dry-run thành công mới ghi `MAIHUB_AGENT_CMD` vào `.env` thật bằng cách gộp, giữ các khoá khác (quyền 600, thuộc user bot), rồi tạo hoặc chuẩn bị `--state-dir` (mặc định `state/` cạnh `--env-file`, `<user>:<user>` 700) → ghi nguyên tử `/etc/systemd/system/maihub-brief-<tên-service>.service` và `.timer` (0644) → `systemctl daemon-reload` → `systemctl enable --now maihub-brief-<tên-service>.timer`. Dry-run lỗi hoặc quá giờ thì giữ nguyên `.env` thật và thư mục trạng thái, không ghi unit và không gọi `systemctl`.

Service là `Type=oneshot`, chạy `python3 -I <bridge> brief-tick --env-file <.env MaiHub> --state <state-dir>/brief-state.json` với `User=<user>`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ReadWritePaths=<state-dir>`, `PrivateTmp=yes`, `TimeoutStartSec=3600`. Bridge dùng bản nằm cạnh `--env-file` nếu có, không thì chính tệp đang chạy. Timer có `OnCalendar=*:0/15`, `Persistent=true`, `WantedBy=timers.target`, gọi service mỗi 15 phút và chạy bù một lượt khi máy bật lại. `brief-tick` giữ khoá tệp để tránh chạy chồng; bot chỉ tạo nháp để khách duyệt, không tự đăng.

Trong `.env` MaiHub:

- `MAIHUB_AGENT_CMD`: mặc định `claude -p --allowedTools mcp__maihub`; đổi bằng `--agent-cmd` hoặc sửa khoá này. Lệnh được tách thành argv, không chạy qua shell; lời nhắc truyền qua stdin.
- `MAIHUB_AGENT_TIMEOUT_SEC`: số nguyên dương, mặc định `2700` giây cho mỗi lượt agent, clamp theo budget tick monotonic `3300` giây (`BRIEF_TICK_BUDGET_SEC`), gồm onboarding, API và mọi agent. Giữ `180` giây headroom (`BRIEF_TICK_HEADROOM_SEC`) cho TERM/KILL (grace 10 giây), kiểm ownership và API cleanup (client mặc định 30 giây); agent tối đa `3120` giây, phần dư dành cho agent sau. Service và lease đều `3600` giây; cấu hình timeout lớn hơn lease cũng bị clamp. Budget điều khiển admission/runtime agent, không phải deadline cứng khi API/OS treo.

Sau onboarding, tick đọc `briefs.list` một lần, thử mỗi profile tối đa một lần và chỉ `briefs.claimDue {profileId}` sát lúc chạy. Không giữ lease cho Page đang chờ. Trước agent, `briefs.get` phải còn `running` với `claimedAt` khớp; mất/đổi/đã hoàn tất ownership thì không agent hoặc stale finish. Budget hết thì không claim thêm; nếu hết trong lúc claim, xác minh ownership rồi finish lỗi `tick budget exhausted`, lỗi API/cleanup được cảnh báo. Dùng monotonic cho budget; đồng hồ tường chỉ phục vụ freshness/cooldown, không so giờ hai máy làm lease guard. Giữ `flock`, stdin prompt và process-group TERM/KILL.

Completion lỗi mới `briefs.finished` có `attempts`/`attemptDate` snapshot, gồm lease hết hạn. Watcher dùng snapshot để chỉ báo lần lỗi thứ ba trở lên; không đọc counter đang thay đổi của brief. Poll expiry chỉ settle/emit một lần sau commit transaction, kể cả đã exhausted hoặc ineligible. Legacy event thiếu snapshot vẫn đọc counter hiện tại như cũ; fallback này best-effort, có thể dư/mất cảnh báo lịch sử. Tin nháp thành công, media labels, mã #suffix và yêu cầu khách duyệt giữ nguyên.

Kiểm tra riêng trước khi cài:

```bash
sudo -u <user> -H python3 -I <bridge> brief-tick --env-file <.env MaiHub> --dry-run
```

Dry-run gọi `system.status`, kiểm phần tử đầu của lệnh agent có trong `PATH` bằng `shutil.which`, rồi thoát (mã 0 = được). Không gọi Claude, không nhận brief, không tạo nháp và không ghi trạng thái. CLI agent cần có trong `PATH` của user bot khi chạy dưới `sudo` và systemd, không chỉ trong shell tương tác. Theo dõi bằng `systemctl status maihub-brief-<tên-service>.timer` và `journalctl -u maihub-brief-<tên-service>.service`; dừng lịch bằng `sudo systemctl disable --now maihub-brief-<tên-service>.timer`.

## Page Operations Task 8 — opt-in local/dev, chưa kích hoạt vận hành

**Gate vẫn false. Installation/isolation và đường receiver Telegram thật chưa được chứng minh; hiện chỉ bàn giao proposal/read-only, không bật timer hoặc protected writes.** Không dùng hướng dẫn legacy ở trên để cài receiver chung user/env/MCP với bot. Không thêm public JSON listener hoặc poller `getUpdates` thứ hai.

- `brief-tick --protected --env-file <runner.env> [--state <path>]` và `install-brief --protected ... --receiver-user <receiver> --receiver-env <receiver.env>` là opt-in; bỏ cờ giữ nguyên legacy. Protected dry-run dùng `system.capabilities`, đòi `pageOperations:1`, `principal.kind:page_runner`, gate true và CLI có trong PATH; gate false là lỗi, không ghi unit/state hoặc gọi AI. Không gọi `system.status`/`briefs.*` trong nhánh này.
- `protected_brief_tick(client, run_agent_fn, clock, state_path)` giữ flock và budget monotonic 3300s/headroom 180s, tối đa 2700s/agent; timer vẫn 15 phút, service 3600s. List/get durable work IDs rồi reconcile việc cũ trước claim sát lúc invoke; waiting/running/review không gọi agent mới, pending chưa tới nextCheckAt không nhận lại. Reconcile dùng server clock: expired running không intent chưa rõ → pending để claim, unresolved intent → needs_review; live owned preparation giữ running, không bị reclaim khi còn thực thi. Poll không tiêu lượt; server quản budget ba lượt/ngày/Page xuyên mọi bước và lease 3600000ms. `attempts` là tổng đời work, không daily gate ở bridge: lifetime 4/carryover/video ngày mới vẫn chạy khi server claim cho phép. Claim → get giữ **tất cả** preparation niche/keywords/groupIds/tone/notes/time/draftsPerDay; không có preparation thì không gọi AI. Prompt yêu cầu đọc lại get trước save/finish, draftIndex ổn định và không chờ khách duyệt. Timeout/agent thoát khi lease còn running được fail `uncertain`, không tự coi hoàn tất hoặc retry mù. Nếu budget hết trong claim/get trước agent, fail `busy` trên đúng lease để server đối soát/backoff, không giữ lease treo. Không render lại video đã linked khi media hết hạn.
- Runner file chỉ có `MAIHUB_URL`, `MAIHUB_API_KEY` scoped và `MAIHUB_CERT_SHA256`; không nhận Telegram/owner secrets hoặc override agent-cmd/timeout. Child dùng fresh HOME/XDG config/cwd và MCP config riêng chứa **chỉ** runner key, PATH cố định; không thừa kế parent env/home/MCP/hooks. Tái dùng stdin và process-group TERM/KILL hiện có, không sudo trong agent, không đổi sandbox. CLI hiện cố định strict MCP/no built-in tools/no setting sources; allowlist server mới là ranh giới quyền. Fresh HOME **chưa có đường đăng nhập CLI/provider được kiểm chứng**; dry-run không chứng minh agent thật chạy được. Không nới cách ly để chữa đăng nhập trong task này.
- Installation mock kiểm runner/receiver là OS UID khác nhau, runner không root, env ở home riêng, receiver file tồn tại không symlink. Probe `os.access` dưới đúng runner user (kể supplementary groups/ACL) từ chối đọc/ghi hoặc traverse receiver home/env/parent/.claude/.codex; không đọc/in secret receiver. Scan unit files và JSON `systemctl list-unit-files/list-timers` từ chối timer cũ/không chứng minh được inventory; bảo thủ yêu cầu operator tự retire các maihub-brief timer, không xoá/tự bật lại legacy. Candidate protected dry-run dưới user đích phải thành công trước ghi units; sudo chỉ của installer operator. Tests không cài service thật. Probe tại một thời điểm không chứng nhận toàn bộ host/ACL/symlink thay đổi về sau.

### Receiver adapter (chỉ import từ receiver đã xác thực transport)

`ProtectedWatcher(client, sender, state_path).poll()` dùng **pageWork.events**, không events.wait/reconcile. `nextCursor` tiến cả trang visible rỗng; workspace đổi thì reset cursor. Mỗi poll đọc list/get/draft durable, gồm work IDs đã lưu, để khôi phục sau mất event/retention; không dựng nghiệp vụ từ text event. Key thông báo `[workspaceId,workId,draftId,revision]`; nháp mới/revision mới có thông báo riêng, không gửi lại cùng revision khi restart.

Draft lifecycle: `pageWork.draft` giữ actionable content/revision cũ; ID đã có durable ownership nhưng promoted/removed trả marker `{id,status:'promoted'|'removed'}` không content. Poll bỏ qua marker và tiếp tục nháp mới ở cùng/khác Page qua restart, không bỏ cả completed work, không xoá cursor/delivery dedup/intent. Unknown/foreign/malformed/revoked vẫn lỗi, không catch rộng. Proposal/reply approval gặp marker cần proposal mới, không gửi action cũ.

First-primary: trusted caller dùng `setPrimaryProfile` explicit profile và `expectedRevision:0` khi business null. Adapter cho phép đúng proposal/reply đó; server kiểm learned identity/assignment/snapshot. Prepare/bind không tạo row; confirm tạo profile disabled/protectedSince null cùng CAS primary/revision và consume transaction. Cần owner-approved `setEnabled` riêng trước claim; không runner bootstrap, không SQL seed hay tự chọn profile.

`deliver(key, text, action=None, work_id=None)` lưu intent bằng temp+fsync+atomic replace trước send. Với proposal, trusted caller cung cấp OwnerAction đóng và key gồm workspace/work/draft/revision **và proposal ID mới từ yêu cầu người thật**; NL parser chỉ đề xuất intent, không tự duyệt. Adapter đọc draft đúng revision, gửi action/timing/revision và trích đoạn nháp cụ thể (tối đa 2000 ký tự); chuẩn bị ticket rồi bind **message_id/chat thực từ Telegram**. Không dùng bool của legacy send hoặc tạo message ID giả. Dùng `TelegramSender.send_once`: đúng một attempt, validate response; timeout/bind lỗi → uncertain, không tự resend. Intent còn trên disk khi chết trước/sau send hoặc save hậu-send lỗi cũng chặn resend. Disk-full trước intent không gửi; state hỏng fail closed, không reset âm thầm. Không hứa exactly-once Telegram; intent/uncertain cần operator đối soát trước yêu cầu mới. Ticket chưa bind do crash có thể phải bỏ và đề nghị lại.

`handle_owner_update(client, update, pending)` nhận Telegram message update **đã được receiver hiện có xác thực transport**, không phải dữ liệu runner gửi công khai. Receiver lấy pending ticket từ delivery state; phải đúng owner chat/sender, reply đúng message đề nghị, chưa hết 15 phút, update/message IDs hợp lệ và draft revision còn khớp. Server kiểm lại ticket/fingerprint/authority/revision rồi confirm; replay update do server ledger xử lý, không gửi proposal lại. “ok” không gắn đề nghị/đã hết hạn/sai revision trả `intent:clarify`; cần người thật yêu cầu proposal mới với ID mới, không tự làm mới uncertain. Edit/discard/callback còn đi luồng receiver/desktop hiện có, không chuyển thành approval trong adapter này, không giữ work lease chờ người. ConfirmFact/primary/enabled/resource/work actions vẫn qua union server, không method tuỳ ý.

Prompt tách observed/hypothesis/unknown, cấm doanh thu/ROI bịa, không tự render/duyệt/đăng/CRM. Test prompt chỉ chứng minh payload được gửi, **không** chứng minh AI thật luôn tuân thủ. Không bootstrap legacy video/media chưa owned, không tuyên bố đã huỷ AHV remote. Controller review/Task 9 đã được chấp nhận local; gate vẫn phải giữ false và activation blocked cho tới kiểm chứng receiver/OS/CLI thật được phép riêng.

### Ghi chú sửa review Task 8 (đã được controller chấp nhận local/dev; live vẫn blocked)

- **Integrity pathname receiver:** installer từ chối home trùng/lồng nhau và home/config qua alias symlink (yêu cầu đường dẫn canonical). Probe thật được sinh cho runner UID vẫn cấm R/W/X ở receiver leaves; với mọi ancestor lên root chỉ chặn **W và X cùng có** vì cho phép rename/replace pathname, không chặn ancestor chỉ đọc/traverse thông thường. Không chứng minh được thì từ chối. Kiểm tra bảo thủ này cũng từ chối ancestor writable+traversable có sticky bit; không tự thay permission, không chứng nhận host live hoặc thay đổi sau probe.
- **Retention state:** `workIds` trong cả tick/poll chỉ lưu work chưa terminal (gồm needs_review), không giữ completed/failed/cancelled để probe lại sau khi server prune journal 30 ngày. Tick cập nhật từ reconcile/get và bỏ ID đã terminal sau invocation thành công; list vẫn đọc nháp terminal còn retained để thông báo. Delivery keys/tickets/intent/uncertain và cursor không bị xoá khi bỏ terminal recovery IDs. State cũ không có status: ID còn thấy/đọc được sẽ được phân loại rồi lưu lại; ID cũ đã mất mà chưa biết terminal vẫn là unknown/active, FORBIDDEN phải dừng và cần đối soát có chủ đích, không tự xoá state hoặc nuốt lỗi quyền. Vì vậy retention bình thường của work đã quan sát terminal không còn làm kẹt các lượt mới; crash trước khi kịp quan sát terminal không được đoán là prune.
- **Canonical approval:** chỉ chấp nhận normalization server đã hỗ trợ cho recurring days: sort/deduplicate các ngày nguyên 0–6 (ví dụ [5,1,5] → [1,5]). So sánh toàn bộ action JSON sau normalization, vẫn chặn đổi kind/Page/draft/revision/payload/time/tập ngày hoặc field thừa. Summary, pending ticket ghi bền và confirm dùng cùng `ticket.action` canonical; không mutate input caller. Now/once giữ nguyên, không mở rộng quyền/API.

### Task 9 — coverage tích hợp và cổng bàn giao

Tasks 1–9 và bản sửa final review F1–F4 đã được chấp nhận local ngày 28/10/2026 sau review độc lập; không có finding tồn dư/hồi quy trực tiếp được xác minh trong scoped re-review bản sửa. Suite `src/__tests__/dailyBrief/pageOperations.integration.test.ts` đi qua registry/IPC và HTTPS authority thật với SQLite tạm, fake browser/video: cách ly ba Page, duplicate-profile claim/memory, video hơn 160 phút giả lập qua restart không render lại, runner không thể duyệt/cấp khoá/sửa lịch/render, receiver cần current revision và transaction consume+promotion nguyên tử, stale writes sau revoke/restart bị chặn. Tests Python tick/watch/pairing/install dry-run vẫn là hồi quy bắt buộc; chúng không xác nhận service/Telegram/CLI thật. Hai vòng controller sau sửa đều đạt 118 suites/2.791 test Jest, 346 test Python, renderer/Electron types và production TS+strip/Vite/docs/diff/index exit 0; UI 16 cells desktop/mobile × light/dark với fake IPC. Make build/test/lint vẫn exit 2 vì thiếu target, warning build còn nguyên; typecheck không phải lint, TS/Vite build không phải bộ cài production.

**INTEGRATION BLOCKED — proposal/read-only; `protectedWritesEnabled=false`.** Việc còn thiếu không phải thêm API: cần quyền truy cập riêng để xác định receiver VPS entrypoint thật, nối `handle_owner_update` vào sự kiện transport đã xác thực và chứng minh tách OS UID/home/env/files/MCP/owner credential cùng CLI login fresh HOME. Telegram ingress trong app không thay receiver VPS. Không tạo poller `getUpdates` thứ hai hoặc đưa owner token vào runner để vượt gate. Không tự cài timer/install, chuyển legacy hay kích hoạt ghi. Rollback dừng claims/owned preparation và thu hồi scoped runner key, giữ audit/memory/approved schedules; không xoá schema/state mơ hồ. Triển khai chỉ sau approval riêng bằng artifact/image đã build từ dev sau tests/review.

## Bảo mật

- Ghim chứng chỉ: bridge không kiểm CA hay tên miền, mà so SHA-256 chứng chỉ đầu cuối với `MAIHUB_CERT_SHA256` bằng so sánh hằng thời gian. Bắt tay TLS xong và khớp ghim thì mới gửi yêu cầu; lệch thì dừng, khoá API không rời máy.
- Khoá API: chỉ nằm trong `.env` (quyền 600, đúng user) hoặc biến môi trường; không nhập trên dòng lệnh, không in ra. Nghi lộ thì thu hồi và tạo khoá mới ở MaiHub.
- Thao tác nguy hiểm (xoá, huỷ, duyệt đăng...) bị MaiHub từ chối bằng `CONFIRMATION_REQUIRED` nếu thiếu `confirm: true`. Qua MCP, model nhận kèm hướng dẫn hỏi người dùng rồi mới gọi lại với `confirm: true`; đừng tự đặt `confirm: true` khi người dùng chưa đồng ý.
- MaiHub chỉ nhận IP trong danh sách cho phép và giới hạn tốc độ theo khoá; mọi lời gọi được ghi nhật ký.

## Kiểm thử

```bash
python3 -m unittest discover -s tools/maihub-bridge/tests -v
```
