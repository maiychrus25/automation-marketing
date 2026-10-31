# Giao thức điều khiển MaiHub (MaiHub Control Protocol v1)

Tài liệu cho người viết bot. Đặc tả thiết kế gốc: `docs/specs/2026-10-14-maihub-control-protocol.md`; cài bridge trên VPS bot: `tools/maihub-bridge/README.md`. Khi tài liệu và mã khác nhau thì mã đúng: `GET /v1/describe` luôn trả danh sách thao tác và schema hiện hành.

## Ghi chú Task 8 — composition local, không thêm contract

`pageCampaignAutonomy.integration.test.ts` nối registry thật qua HTTPS loopback/SQLite và Python client ghim chứng chỉ; các method/schema giữ nguyên. Proposal/grant dùng receiver ticket thật với sender giả lập; scheduler/post task kiểm authority tới effect, không biến fixture thành live approval. Current-publish vẫn không chứng minh target: kết quả unconfirmed, collect unavailable, autonomous first comment bị từ chối. Bộ observation confirmed cho report/optimize là synthetic tách biệt. `get.latestDecision` vẫn là lịch sử scoped, không là authority; receiver chỉ tóm tắt latest và giữ dedup/uncertain bền.

Tasks 1–8 đã qua review local; broad review tìm thấy F1 ở public Python poll, đã sửa và qua scoped re-review không còn finding trong diff sửa lỗi (xem ghi chú mixed events bên dưới). Đây chưa phải nghiệm thu/release: gate thật false. Make/lint, lỗi randomized legacy `groupContactType` seeds 2707/3707, live identity/collector/current-publish, receiver isolation/fresh-HOME auth và packaging chưa được thông qua. Không thêm capability, bình luận độc lập hoặc nguồn ROI. Build scratch không phải gói production đã chứng nhận; UI không đổi, render N/A.

## Ghi chú independent background jobs Task 8 — không thêm contract

Suite composition `backgroundJobs.integration.test.ts` kiểm qua IPC handler registry thật: `facebookPoster:active` rỗng → `runs:[]`, `current` rỗng → `run:null`, cancel không ID khi 0 lượt giữ `{cancelled:true}`, khi 2 lượt sống trả lỗi chọn lượt (`CONFLICT` ở Control API), ID lạ hoặc của workspace trước (A→B→A) → `NOT_FOUND`, lượt đã xong → `cancelled:false`. Method/schema/allowlist không đổi; `runs.*` của Control API dùng chung `posterOperations` nên envelope HTTP vẫn theo bảng bên dưới.

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

### 2.4 Khoá scoped theo Page (foundation local/dev, runtime đã nối; chưa kích hoạt vận hành)

Khoá hiện tại không có policy là `legacy`, giữ API và luồng ghép nối cũ. `ControlStore.createKey(name, policy?)` nhận policy bất biến cho `page_runner` hoặc `page_receiver`: `{kind, workspaceId, assignments:[{pageId,profileIds}]}`; receiver còn bắt buộc `ownerChatId`/`ownerSenderId` là chuỗi số nguyên Telegram chính xác, runner không có hai trường này. Chỉ lưu hash bí mật và policy JSON; không đổi quyền qua tên khoá/metadata hay workspace do client gửi. Đổi phạm vi bằng khoá mới và thu hồi khoá cũ. JSON policy hỏng không được coi là legacy. UI/cấp khoá scoped đã có trên dev (Task 4, staging); approvals và runtime binding đã nối local ở Tasks 6–7, consumer opt-in ở Task 8. Thiếu resolver runtime thì scoped nhận `FORBIDDEN` ngay; có resolver cũng chưa phải chứng nhận operational end-to-end.

Provisioning chỉ qua Settings/trusted local IPC ở Boss/Standalone, không qua method do runner gọi:

- `controlApi:getScopeOptions()` → `{workspaceId, workspaceGeneration, identities}` từ cùng active workspace; `createKey(name: string, policy?: ScopedKeyPolicy)` và `createPairing({name,botIp,publicHost,policy?})` đều kiểm schema + workspace/DB path + mọi Page/profile đang có identity `page` phù hợp và browser profile còn tồn tại. Chuyển workspace/employee bị chặn; pairing kiểm trước đổi settings và sau await restart trước cấp vé. Không tin checkbox UI. UI legacy dùng `null` sentinel nhưng **bỏ policy** khi gửi IPC; public metadata/lookup legacy vẫn omit policy, SQL NULL, không đổi clients cũ.
- Vé giữ policy server đã validate và sao chép sâu assignments. `/v1/pair` vẫn chỉ cần `{ticket}`; role/workspace/policy gửi thêm trong body bị bỏ qua, không nâng quyền vé. Wiring kiểm lại policy/workspace/identity lúc đổi vé lấy key. Mỗi IP chỉ một vé chờ; hoàn thành ghép nối role trước khi tạo vé role khác cùng IP.
- Lệnh legacy `pair ... --install` không đổi. Scoped chỉ tạo **staging** `pair ... --dir /root/maihub-page-runner` hoặc `pair ... --dir /root/maihub-page-receiver`, **không --install**, không tự đăng ký receiver vào MCP bot, không dùng chung export/.env/config receiver và runner. Không chạy trình cài legacy với receiver: nó ghi vào môi trường bot. Thư mục khác nhau chưa đủ chứng minh cách ly tài khoản hệ điều hành. Kiểm chứng cài đặt/isolation và bàn giao OS-user thuộc Task 8; runtime/capabilities thuộc Task 7, chưa triển khai ở đây.
- Receiver bắt buộc owner Chat ID (chuỗi số nguyên khác 0, có thể âm) và Sender ID (chuỗi số nguyên dương), giữ nguyên precision; operator xác nhận hai ID trước cấp. Raw API key chỉ hiện một lần. Đổi phạm vi bằng khoá mới/thu hồi cũ.
- Binding **local IPC**, không phải HTTP scope: `getConfig`/`setConfig` trả `{workspaceId, workspaceGeneration}`. `setConfig` có gate hoặc bất kỳ binding field nào phải gửi đủ binding từ view hiện tại; thiếu/sai workspace/generation bị từ chối trước ghi. Generation tăng ở `stopControlApi()`, chặn cả A→B→A; sau `await apply()` kiểm lại workspace/DB path/generation/mode trước trả view. Settings huỷ snapshot/xác nhận pending khi lifecycle đổi, bỏ response stale và đọc lại cả config khi refresh phạm vi. Refresh cùng workspace lọc assignment không còn hợp lệ, giữ role/lựa chọn hợp lệ/owner IDs; đổi workspace giữ role nhưng xoá assignments/owner IDs. Không rollback ghi đã hoàn tất ở workspace gốc sang workspace mới.
- Cấu hình local `protectedWritesEnabled: boolean` mặc định false, payload legacy không có field giữ gate đã lưu (kể cả khi pairing); không có API HTTP cho runner thay gate. Checkbox bật yêu cầu xác nhận đã kiểm cách ly receiver, chỉ là **khai báo vận hành**, không có kiểm chứng tự động và không đồng nghĩa hai khoá đã an toàn. Giữ tắt đến khi kiểm cài đặt cách ly hoàn tất. Task 4 chưa thêm runtime thực thi ghi được bảo vệ.

| Vai trò | Method được phép (tên chính xác, chỉ hiện trong describe khi đã đăng ký) |
|---|---|
| Runner | `system.capabilities`, `profiles.list`, `pages.list`, `pages.learn`, `pageBusiness.get`, `pageBusiness.propose`, `pageWork.list`, `pageWork.get`, `pageWork.claimDue`, `pageWork.research`, `pageWork.researchResult`, `pageWork.saveDraft`, `pageWork.draft`, `pageWork.waitVideo`, `pageWork.reconcile`, `pageWork.finish`, `pageWork.fail` |
| Receiver | `system.capabilities`, `profiles.list`, `pages.list`, `pageBusiness.get`, `pageWork.list`, `pageWork.get`, `pageWork.researchResult`, `pageWork.draft`, `pageApprovals.prepare`, `pageApprovals.bindMessage`, `pageApprovals.confirm`, `pageWork.events` |

Không có wildcard/prefix. Scoped không gọi API legacy broad, events/history/aggregates, research legacy, render, CRM, config, cancel global, duyệt/đăng nháp hoặc sửa/bật lịch; `confirm:true` không vượt quyền. Ba method `pageApprovals.*` trên chỉ receiver, legacy cũng không được gọi chúng; `drafts.approve` legacy vẫn như cũ. `profiles.list`/`pages.list` chỉ trả profile được giao **và** đúng danh tính Page; Page khác trên cùng browser profile bị ẩn. Runner `pages.learn` phải gửi profileIds được giao, không force/không mặc định mọi workspace; danh tính chưa biết được học lại.

- `/v1/describe` lọc theo policy; `/v1/call` kiểm quyền sau resolve method, **trước** cache và side effect, rồi kiểm lại sau await/cache replay cho từng request.
- `/v1/media` scoped bị từ chối trước khi đọc/lưu upload. `/v1/videos/file` chỉ nhận linked video trong Page/workspace được giao; không coi profileId hoặc origin bot là ownership. Ownership không cần work journal còn tồn tại. Kiểm trước mở và sau await, hủy stream stale; mất quyền giữa stream thì ngắt kết nối trước chunk tiếp theo. `/v1/health`/`/v1/bridge.py` vẫn theo IP/lockout cũ, không có dữ liệu Page.
- Scoped idempotency dùng fingerprint canonical params + method + principal/policy. Số không hữu hạn, kể cả `1e400`/`-1e400` trong object/array lồng nhau, bị từ chối `INVALID_PARAMS` trước tra cache; legacy không đổi. Cùng key nhưng khác payload/policy/method, hoặc row cũ thiếu fingerprint: `CONFLICT`; không chạy lại side effect mù. Khoá thu hồi/workspace chuyển khi đang chờ không nhận kết quả stale và không ghi cache/audit sang DB mới. Cache guard thứ sáu trong `IdempotencyCache.run(keyId, method, idemKey, fn, requestHash?, assertCurrent?)` chặn cả khe continuation sau await riêng của cache; callers 4/5 tham số vẫn tương thích.
- Resolver server `authorizationResources(principal)` phải capture principal, workspace ID, DB path và switch lifetime theo request; có `workspaceId`, `assertCurrent()`, `getPageIdentity(profileId)`, `getWork(workId)`, `getResourceOwner(ref)`. Thiếu resolver/callback nền tảng thì deny, không đoán legacy. Method context thêm `principal`, `assertCurrent`, `resources`; handler/service phải guard trước side effect và sau mỗi await trước ghi/expose.
- Receiver approvals còn yêu cầu `resources.authorizeApproval(method, params): void`: kiểm action Page/ticket ownership **và receiver key**, không consume/mutate ticket vì chạy nhiều lần khi replay. Ticket thiếu/ngoài scope dùng FORBIDDEN chung. Task 6 có module nội bộ bên dưới; Task 7 đã nối callback authorization/runtime local ở mục 2.4, không dùng payload request làm authority.

### 2.3 Ticket chủ Page — hợp đồng Task 6; binding local Task 7 ở mục 2.4

`createPageApprovalOperations` bind receiver principal/config tin cậy và một SQLite handle; `prepare(action, receiver)` trả `ApprovalTicket`, `bindMessage(ticketId,chatId,senderId,messageId)` gắn message đề nghị, `confirm(ticketId,OwnerUpdate,receiver)` trả Promise `{resourceId,replayed}`. Không đăng ký endpoint mới trong task này. Deployment gate `protectedWritesEnabled` giữ false; `assertCurrent` khi integration phải kiểm gate, key/workspace/generation. Không có bằng chứng cách ly live receiver/runner.

`OwnerAction` là union đóng có `pageId` và sáu kind: `confirmFact` (expectedRevision + factId hoặc fact mới `{topic,value,reason}`), `setPrimaryProfile` (expectedRevision + profileId), `setEnabled` (expectedRevision + enabled), `resolveWork` (workId + resolution `resume|cancel`), `linkResource` (workId + resource), `approveDraft` (draftId + expectedRevision + timing). Timing là `{when:'now'}`, `{when:'schedule',kind:'once',runAt}` hoặc `{when:'schedule',kind:'recurring',days,time}`. Không nhận arbitrary method hay confirmation/source metadata. Fact mới chủ Page có source owner qua seam trusted riêng; xác nhận fact observed giữ nguồn gốc.

`OwnerUpdate = {updateId,messageId,chatId,senderId,replyToMessageId}`; ba message/update IDs phải là số nguyên an toàn, chat/sender là chuỗi số nguyên giữ precision. Ticket gắn receiver key, workspace/Page, chat/sender, action/fingerprint/revision, message và TTL 15 phút. Sai sender/chat/reply/key/scope hoặc ticket thiếu bị FORBIDDEN; expired/stale snapshot/update trùng khác ticket bị CONFLICT. Cùng update hợp lệ trả lại một resourceId, không promote hai lần. “ok” không có ticket gắn reply rõ ràng không được tự tìm action.

Fingerprint dùng canonical JSON và bytes/hash tệp, toàn bộ text/params/target/profile/timing/revision; đổi nội dung/tệp/đích/lịch phải đề nghị mới. Duyệt dùng lại validator/timing hiện có, kể cả now; expectedRevision optional ở helper legacy, không đổi desktop clients. Bảng private `page_owner_approvals` và promotion dùng transaction cùng connection; wake/event chỉ sau commit qua callback đồng bộ `{resourceId,action,when?}` (không ticket/owner IDs). Callback integration dùng when now cho bypass chiến dịch hiện có. Ticket không được đưa vào runner describe/get/cache/events.

First-primary: khi `pageBusiness.get.business=null`, receiver được prepare `setPrimaryProfile` với `expectedRevision:0` và explicit learned profile được giao. Prepare/bind không tạo business row. Confirm kiểm lại current identity/assignment/snapshot và atomically ensure row + CAS primary/revision + consume ticket trên captured connection; vẫn disabled/protectedSince null cho tới `setEnabled` riêng. Row được tạo/identity đổi trước confirm làm snapshot conflict; cap 10/rollback giữ nguyên. Không runner bootstrap, không read-side initialization hay tự chọn primary.

Primary phải là learned Page được giao; work cũ không đổi profile. Khi primary đổi/disable/cancel, factory gọi trực tiếp `assertPagePreparationIdle(db,workId)` của Task5/R22, đọc counter actor-await/research-drain và live-media marker open/save trên cùng DatabaseService handle; không dùng browser isBusy hay callback no-op để suy ra readiness. Helper read-only, không cấp quyền/khẳng định effect đã thành công, không chứng minh đa process/đa connection; chặn effect chưa dừng an toàn; busy rejection giữ nguyên business/work/ticket; chờ effect kết thúc an toàn rồi kiểm lại snapshot, snapshot đổi thì gửi ticket mới. Không dùng `cancelOwned` làm preflight vì hàm đó ghi cancelled; không huỷ lịch approved hoặc remote render. Resolve resume chỉ nhận needs_review không còn effect mơ hồ và evidence còn hợp lệ; otherwise đối soát riêng hoặc cancel, không retry mù. `inspectResource` là callback local trusted, không phải input runner. Task7 `pageWork.finish` hoàn tất chuẩn bị khi đủ linked drafts, độc lập approval.

### 2.4 Task 7 — CORE/runtime local dev, chưa phát hành hoặc chứng nhận live receiver

`createPageOperationMethods({bindRequest}): ControlMethod[]` đã triển khai 18 method capabilities/business/work/approvals trong bảng quyền, với params đóng (field thừa bị từ chối), chỉ scoped principal. Electron per-request adapter, registry composition, pre-cache approval authorization, trusted resource inspector/hints và startup/workspace lifecycle đã nối local/dev. Đây **không phải chứng nhận end-to-end với live Telegram/OS isolation hoặc production release**; Tasks 8–9 và review local đã được chấp nhận, cổng vận hành thật vẫn chưa đạt. Không đổi legacy envelopes, không bật gate; thiếu resolver/lifetime hợp lệ vẫn fail closed. Handler validation không thay thế kiểm quyền trước cache. Resolver bổ sung `protectedWritesEnabled?():boolean`: callback hiện tại bắt buộc cho closed runner mutation set (gồm pages.learn), thiếu/false bị FORBIDDEN trước persisted/in-flight cache và sau await/replay/rejected await; không replay claim/lease cũ khi gate đã tắt. Allowlist/authorization/CORE dùng chung mutation membership, không wildcard; reads/receiver/legacy không bị gate này block toàn cục. Không xoá cache để thay authorization.

| Method | Params → result CORE |
|---|---|
| `system.capabilities` | `{}` → `{pageOperations:1,principal:{kind,workspaceId,assignments},protectedWritesEnabled}`; không key/receiver IDs/ticket |
| `pageBusiness.get` | `{pageId}` → `{business,evidenceAvailability:[{factId,available}]}` |
| `pageBusiness.propose` | `{workId,claimedAt,expectedRevision,fact}` → `{business}` |
| `pageWork.list` / `get` | `{}` → `{items}` / `{workId}` → `{work,preparation}` |
| `pageWork.claimDue` | `{pageId}` → `{work}` (null khi chưa có work đến hạn cho primary được giao) |
| `pageWork.research` / `researchResult` | `{workId,claimedAt,input}` → `{scanId}` / `{workId,scanId}` → `{scan,items}` |
| `pageWork.saveDraft` / `draft` | `{workId,claimedAt,draftIndex,draft}` → `{draftId,revision}` / `{workId,draftId}` → `{draft}` |
| `pageWork.waitVideo` / `reconcile` | `{workId,claimedAt,videoId}` / `{workId}` → `{work}` |
| `pageWork.finish` / `fail` | `{workId,claimedAt,reason,evidenceRefs}` / `{workId,claimedAt,code,reason}` → `{work}` |
| `pageApprovals.prepare` | `{action:OwnerAction}` → `{ticket:ApprovalTicket}`; receiver-only |
| `pageApprovals.bindMessage` | `{ticketId,chatId,senderId,messageId}` → `{bound:true}` |
| `pageApprovals.confirm` | `{ticketId,update:OwnerUpdate}` → `{resourceId,replayed}` |
| `pageWork.events` | `{after,timeoutSec?}` → `{events,nextCursor,workspaceId}`; receiver-only |

`controlApiIpc` ghép factory vào registry hiện có, mỗi request nhận principal từ credential. Server resources có callback non-consuming trước cache: prepare kiểm Page/action IDs; bind/confirm kiểm workspace/Page/ticket/receiver key và chat/sender/reply, không consume/create vé khi authorization lặp/replay. `ctx.assertCurrent` kiểm key active/policy, generation/retired, workspace/path, employee/switch và profile còn tồn tại. `dailyBriefIpc` cung cấp schema-per-db-path business/work getters. Vì DatabaseService là singleton có connection mutable, cùng wrapper chưa đủ: retirement/drain bắt buộc trước swap.

R23/R28: bound work dependency builder tái dùng nguyên live actor/shared browser slot, operations factory cũ delegate. Bound approval dependencies dùng cùng handle/readiness map; inspector chỉ nhận durable owner + originating work/profile + actual local identity/row/file, hash byte local. Không import/bootstrap unowned legacy media/video (kể cả source bot/specJson tự khai Page); resource thiếu proof bị từ chối. Shared post-promotion helper giữ now campaign bypass, draft.approved/reschedule/schedulesChanged; rollback/replay không promote hoặc phát hint lần hai.

Workspace switch/delete-active retire generation/authority trước await, invalidate running leases và đưa pending/waiting intent mơ hồ vào needs_review/uncertain; chỉ cancelOwned protected research, chờ protected promises/readiness tối đa 20 giây. Chưa settle/busy/reject thì không swap DB. Nếu active-delete bị từ chối/lỗi sau retirement hoặc cleanup research/poster thất bại, Control API được rebuild scope mới trên DB giữ lại trước bỏ switch exclusion; old callbacks vẫn bị từ chối, không unretire và không restart dịch vụ không liên quan. Tiếp tục giữ cleanup legacy research/poster/learner/control/video polling cũ; không huỷ approved schedules hoặc remote AHV render. A→B→A không khôi phục callback cũ. Startup trước claim chỉ recover journal running/unresolved thành needs_review, giữ waiting/review để reconcile, không gọi agent/render/adoption. Certificate/start await stale không mở listener cũ. Notifier hiện có chỉ wake sau commit/retirement, không ghi event bản sao. Startup/hourly housekeeping hiện có gọi prune terminal journals 30 ngày bằng `PageWorkStore.prune(now,workspaceId)` sau schema setup; callback capture handle/workspace/generation và guard lifetime trước maintenance. Giữ nguyên prune(now) cho callers cũ. Chỉ xoá journal/steps terminal hết hạn của workspace hiện tại, không xoá foreign rows, active/review, durable draft/video/resources/ownership hay approved schedules; không thêm timer. Callback retired không được chạy cleanup trên DB thay thế.

`PageOperationRequest` capture đúng SQLite handle/workspace/path và guard/gate/clock của request; concrete prepared-work/approval factories dùng lại handle đó, không mutable current principal, không authority/evidence mặc định. Mọi runner mutation (kể cả reconcile/adoption) cần gate true và context primary/business/brief còn bật; running cần lease chưa hết hạn, ngoại trừ reconcile tự phân loại expiry bằng server clock. `PageWorkStore.reconcileExpiredLease(workId,now)` chuyển running hết hạn không unresolved step sang pending (không tăng attempts); unresolved intent/uncertain sang needs_review. Live actor/research/media preparation trên captured handle giữ running và chặn direct reclaim. Sau pending, claimDue giữ daily admission và cấp token mới; token cũ không thể ghi. Không nuốt CONFLICT/FORBIDDEN hoặc đoán expiry từ clock bot. Waiting/pending polling không gọi agent/tăng attempts. ID ngoài scope dùng FORBIDDEN chung. `fail` phân loại server: rate_limited/no_profile_available/busy → pending/backoff; invalid_input/unsupported_source → failed; mã khác hoặc intent/uncertain → needs_review; không xoá uncertain/reset budget.

`pageWork.get.preparation` chỉ `{niche,keywords,groupIds,tone,notes,time,draftsPerDay}` từ brief thật của work.profileId, không profile do caller gửi/secondary/foreign brief, không claim/budget fields. Brief không còn → null và giữ work status; mutations không tự tạo mặc định. Runner claim → get để đọc toàn bộ chỉ dẫn và target. `finish` kiểm **đủ draftsPerDay hiện tại** nháp linked đúng Page/workspace/work và row schedule bền vững đúng profile/Page target; nháp đầu không tự complete khi target lớn hơn 1. Không đợi approval, không promote draft.

Provenance được resolve từ local rows, không fetch URL:
- page: `page:<profileId>:<learnedAt>` hoặc URL exact trong current identity.recentPosts; identity đúng Page được giao, observedAt=learnedAt. Runner lấy timestamp/sample bằng scoped `pages.list`.
- research: `research:<scanId>` với observedAt=finishedAt; `research:<scanId>:<itemId>` hoặc exact item URL với observedAt=capturedAt. Scan done phải linked đúng work/workspace/Page và chứa đúng profile; item cũng phải đúng profile. Runner lấy IDs/timestamps qua scoped `researchResult`. Timestamps cũ/row mất/URL lạ không thành evidence. `finish.evidenceRefs` resolve thời gian thực từ hàng local, không lấy observedAt từ runner.
- `pageBusiness.get` giữ fact khi nguồn mất và đánh dấu availability false; confirmed không bị ghi đè, mâu thuẫn phải đề xuất mới. Response bỏ confirmationRef; owner sourceRef chỉ là `owner`, không receiver message metadata. Primary profile ngoài assignment hiện null. Research scan.profileIds/items/itemCount chỉ phạm vi work; không raw params/details/error hoặc counts từ Page khác. Draft view không params/mediaPaths/path. Không mặc định doanh thu/đơn hàng.

`pageWork.draft` trả `{draft:PageDraftProjection}`: actionable view giữ nguyên `{id,revision,text,...}`; durably-owned row đã promote trả `{id,status:'promoted'}` sau kiểm Page/profile/target/campaign/media; row không còn nhưng ownership đúng work/workspace/Page trả `{id,status:'removed'}`. Hai marker không có content/revision. Unknown/foreign/missing ownership và revoked scope vẫn fail closed; mutation/approval không nhận marker như actionable draft. Receiver poll bỏ qua đúng marker rồi tiếp tục nháp mới cùng/khác Page, giữ completed work, cursor và durable delivery intent/dedup; stale approval proposal/reply cần đề nghị mới, không crash hoặc gửi action cũ.

State/event cùng **SQLite transaction trên cùng handle** bằng triggers của PageWorkStore, dùng bảng control_events hiện có: status/claim → `pageWork.changed`; succeeded draft revision → `pageWork.draftSaved`; business revision → `pageWork.businessChanged` gắn work gần nhất của Page (không có work thì không có thông báo work). Một event/transition hoặc revision, không event replay; rollback cũng bỏ event. Payload chỉ IDs/status/revision, không ticket/receiver/reason/raw resource. Notifier chỉ post-commit wake hint, không ghi event thứ hai. `pageWork.events` đọc tối đa 100 hàng/truy vấn, tiếp tục trang ẩn và trả tối đa 100 visible events, nextCursor tiến qua hàng đã xét. timeoutSec nguyên 0–25, mặc định 25. `pageWork.events` và legacy `events.wait` dùng chung cap tối đa 4 request chờ/key; kiểm quyền trước cap/cache, vượt cap trả RATE_LIMITED trước handler/wait, capacity được trả trong finally khi success/error/abort. Event view `{seq,type,workId,pageId,createdAt,status?,draftId?,revision?}` kiểm lại work/profile assignment; rows legacy/foreign/malformed/work đã prune bị ẩn. Events không thay thế durable state; mất retention thì reconcile work/draft IDs.

### 2.5 Task 8 — consumer opt-in local/dev; activation blocked

Bridge thêm `brief-tick --protected` / `install-brief --protected`; default legacy giữ nguyên. Không đổi HTTP envelope hoặc mở listener/poller mới. `protected_brief_tick(client, run_agent_fn, clock, state_path)` đòi capabilities version 1, page_runner và gate true trước work; list/get các durable IDs rồi reconcile trước claim, không gọi AI khi waiting/running/needs_review; expired running được reconcile server phân loại trước claim. `attempts` là tổng đời work, bridge không dùng nó làm daily gate: server claimDue/daily ledger giữ ba invocation/ngày/Page xuyên các bước, cho carryover/video lifetime 4 ở ngày mới nếu được admit. ClaimDue → get giữ trọn preparation, server kiểm lease/attempts/target hiện tại; prompt yêu cầu draftIndex ổn định và get lại trước save/finish, không tự render/duyệt/đăng/CRM/doanh thu/ROI. Flock/timer 15 phút/budget 3300s/headroom 180s/process-group timeout giữ nguyên. Agent không settle running thì fail uncertain, không retry mù; hết budget trong claim/get trước agent thì fail busy đúng lease, server quản backoff.

Runner chỉ nhận env-file URL/scoped key/cert; child fresh HOME/XDG/cwd/MCP, không parent secrets/config, fixed CLI strict MCP/no builtin tools/no setting sources. Server scoped authorization mới là quyền thực, không --allowedTools. Installer đòi `--receiver-user`/`--receiver-env`, hai UID khác nhau, runner không root và env trong home riêng; receiver config phải tồn tại không symlink. OS-user access probe từ chối read/write/traverse receiver home/config/parent/.claude/.codex mà không đọc secret; inventory files và JSON systemctl unit-files/timers chặn timer cũ/mơ hồ. Operator phải retire timer rõ ràng, không auto delete/re-enable legacy; candidate protected dry-run đúng user trước unit writes. **Chỉ tests mock, chưa chứng minh host isolation/CLI login fresh HOME; gate vẫn false, không được kích hoạt protected writes/timer.**

`ProtectedWatcher(client,sender,state_path).poll()` dành riêng receiver đã xác thực transport: pageWork.events → nextCursor (kể cả visible page rỗng), list/get/draft durable IDs khôi phục missed/expired event history; không events.wait hoặc runner reconcile. Delivery key workspace/work/draft/revision, persist intent bằng fsync + atomic replace trước send. `TelegramSender.send_once` trả message ID/chat thật hoặc ném lỗi, không legacy bool/retry. Timeout/bind lỗi → uncertain; crash hoặc post-send save lỗi giữ intent chặn resend; disk-full trước intent không send; corrupt state fail closed. Đây không phải exactly-once Telegram.

Trusted receiver gọi `deliver(key,text,action,work_id)` với OwnerAction đóng; proposal key thêm ID yêu cầu thật để tạo đề nghị mới có chủ đích sau đối soát/hết hạn, không tự resend uncertain. Summary action/timing/revision và draft excerpt lấy từ current scoped draft đúng revision, rồi prepare/bindMessage với Telegram ID thực. `handle_owner_update(client,update,pending)` chỉ nhận message update từ transport receiver hiện có; không là endpoint tự khai chat/sender/JSON. Chỉ “ok”/“đồng ý”/“xác nhận” gắn reply đúng proposal còn hạn, đúng chat/sender/IDs/current draft revision mới confirm; server vẫn kiểm fingerprint/authority/replay. Mơ hồ trả clarify; NL chỉ là intent, edit/discard/callback tiếp tục receiver/desktop cũ, không giữ lease chờ người. Pending ticket chỉ ở private receiver state, không đưa sang runner.

Prompt tests không chứng minh AI thật tuân thủ; mocked filesystem/command không chứng minh live receiver/provenance/OS isolation. Chưa kiểm chứng Telegram/Facebook/AI/AHV/VPS thật hoặc bootstrap unowned legacy resources, không tuyên bố remote AHV đã huỷ. Review local đã được chấp nhận; vẫn giữ proposal/read-only/operational activation blocked cho đến kiểm chứng vận hành thật được phép riêng. Chi tiết caller/installation constraints ở README bridge; không đổi version/settings/dependencies.

**Task 8 review repair (đã được controller chấp nhận local/dev; live vẫn blocked):** installer chặn nested/overlapping homes và alias symlink của home/config; probe target UID kiểm receiver leaves như cũ, đồng thời chặn mọi ancestor có W+X để bảo vệ pathname khỏi rename/replace. Ancestor R/X bình thường được phép; writable+traversable sticky ancestor vẫn bị từ chối bảo thủ. Không đổi quyền OS hoặc coi probe là chứng nhận live. Tick/poll chỉ lưu workIds chưa terminal; reconcile/get/post-invocation cập nhật ID recovery để completed/failed/cancelled prune sau 30 ngày không đầu độc restart. Delivery dedup/intent/uncertain giữ nguyên. Pre-fix ID chưa biết status vẫn được kiểm quyền/get nếu list thiếu; đọc thấy terminal mới bỏ, FORBIDDEN không được coi là prune hoặc tự reset state. Recurring proposal chỉ cho phép normalization sort/deduplicate ngày nguyên 0–6; so toàn bộ JSON action còn lại, không cho đổi identity/revision/time/tập ngày/payload. Summary và pending state lấy đúng canonical ticket.action mà confirm sẽ thực thi; now/once tương thích. Không đổi wire/server authorization; gate giữ false, Task 9 và bản sửa final review đã được chấp nhận local; chưa chứng nhận vận hành thật.

### 2.6 Task 9 — integration coverage đã chấp nhận local, vận hành thật vẫn blocked

`src/__tests__/dailyBrief/pageOperations.integration.test.ts` chạy actual Electron registry/bound adapters, HTTPS server và SQLite tạm; chỉ fake external browser/research/video/clock. Sáu ca chứng minh cách ly ba Page tới draft completion, duplicate profiles một memory/claim, video qua runtime restart không render lại/adopt trùng, runner không có đường approvals/legacy schedules/render/upload/cấp khoá bằng vé sai, trusted approval current revision/owner binding/transaction rollback/replay và chặn stale draft/cache sau revoke/restart. Test giữ slot thật bị chiếm khi actor/research và trả lại sau kết thúc; không coi HTTP status đơn lẻ là bằng chứng.

Không thay envelope/allowlist/limits hoặc đổi production config để test: gate true chỉ trong fixture DB tạm. **Cổng vận hành vẫn `protectedWritesEnabled=false`, INTEGRATION BLOCKED — proposal/read-only.** Chưa có receiver VPS entrypoint đã xác thực transport để nối `handle_owner_update`, chưa kiểm user/file/env/MCP separation hoặc fresh-HOME CLI auth. Telegram ingress của app không phải receiver VPS; không poller `getUpdates` thứ hai, không owner secret trong runner. Tasks 1–9 và bản sửa F1–F4 đã được chấp nhận local ngày 28/10/2026 sau review độc lập; scoped re-review không có finding tồn dư/hồi quy trực tiếp được xác minh trong delta sửa. Hai vòng controller sau sửa đều đạt 118 suites/2.791 test Jest, 346 test Python, types/production TS+strip/Vite/docs/diff/index exit 0; UI 16 cells desktop/mobile × light/dark, fake IPC. `make build/test/lint` vẫn exit 2 vì thiếu target; warning build vẫn còn, typecheck không thay lint. Không tuyên bố Phase A end-to-end hoàn tất hoặc đã có bộ cài production, không thêm hạ tầng ngoài scope.

### 2.7 Page campaign autonomy — Task 2, local dev; execution chưa sẵn sàng

Ba method mới chỉ cho scoped principal: `pageCampaigns.list {pageId}` → `{campaigns:PageCampaignLink[],proposals:CampaignProposal[]}`; `pageCampaigns.get {pageId,campaignId}` → `{campaign,grants}`; `pageCampaigns.propose {workId,claimedAt,input:CampaignProposalInput,expectedRevision:number|null}` → `CampaignProposal`. Read cho runner/receiver cùng workspace/Page/profile; propose chỉ runner với gate true, live lease và current enabled primary/brief/Page identity. Field thừa (kể cả owner/grant/confirm) bị từ chối. Missing/foreign IDs đều FORBIDDEN. expectedRevision null tạo pending, số nguyên dương cập nhật CAS. Policy explicit theo contract model; pilot 7 ngày/1 bài/ngày/7 bài/grant, trần ngày không vượt daily brief thấp hơn; không tự gia hạn hay chuyển work ownership.

Receiver dùng OwnerAction `{kind:'grantCampaign',pageId,proposalId,expectedProposalRevision}` hoặc `{kind:'revokeCampaignGrant',pageId,grantId,expectedGrantRevision}` qua prepare → bindMessage → confirm. Proposal revision không phải business revision. Fingerprint ràng buộc proposal/link/policy/business/brief/current identity/múi giờ, confirmation kiểm lại before commit. Grant mới cần policy chưa hết hạn và múi giờ máy khớp. Revoke không đòi identity còn hoạt động để chủ vẫn dừng được. Campaign/link/grant và ticket consumption/events dùng cùng transaction; replay cùng update trả `{resourceId,replayed:true}` (resourceId là campaignId khi grant, grantId khi revoke). Renewal tạo grant mới và revoke grant cũ, không gán lại lịch cũ. Không huỷ lịch owner.

Public grants và campaign tickets không có receiverKeyId; grants không có confirmationRef. Ticket private chỉ cho receiver, không xuất hiện trong runner/event. `getCampaignResource(kind,id)` là resolver captured DB, bắt buộc trước cache cho campaign IDs; không fallback broad ownership. Live key safe-reader không trả hash/secret. Kiểm revoked key/current context trước cache và sau await. `pageWork.events` bổ sung `pageCampaigns.proposalChanged` (`proposalId`) và `pageCampaigns.grantChanged` (`campaignId,grantId`), cùng `seq,type,pageId,status,revision,createdAt`; status/revision re-project từ durable rows, sống qua work prune, không raw payload/owner metadata. Consumer đọc lại list/get sau event.

`system.capabilities` chưa có `pageCampaigns:1`: schedule/update/cancel/collect/report/optimize và reservation cancellation chưa được đăng ký. Grant là bản ghi quyền của chủ, **không phải chứng nhận có runtime tự đăng**. Gate mặc định false không đổi. Không UI, legacy method role thay đổi, provider/timer mới hay customer migration.

### 2.8 Page campaign autonomy — Task 3, reservation local dev; execution vẫn bị chặn

Ghi chú bổ sung sau Task 2 (không sửa trạng thái lịch sử): scoped runner/gate/live lease có ba method local mới:

- `pageCampaigns.schedule {workId,claimedAt,input:{draftId,expectedDraftRevision,campaignId,grantId,expectedGrantRevision,runAt,variant,factIds}}` → `{scheduleId,revision}` (execution revision).
- `pageCampaigns.updateSchedule {workId,claimedAt,scheduleId,expectedExecutionRevision,input:{campaignId,grantId,expectedGrantRevision,runAt,variant,factIds,expectedScheduleRevision,content?}}` → `{scheduleId,revision}`. `content:{text,variants?,comment?,mediaIds?}` thay snapshot đầy đủ; bỏ comment/media nghĩa rỗng, không đổi draft/work/grant. CAS schedule row và execution tách biệt, validation/quota/media/facts atomic.
- `pageCampaigns.cancelSchedule {workId,claimedAt,scheduleId,expectedExecutionRevision}` → `{cancelled:true}`. Reserved cancellation idempotent; không trả submitting/uncertain quota.

`pageWork.saveDraft` và draft projection giữ `variants?:string[]` (text=A, variants=B–E theo validation cũ). Campaign link managed có thể được work sau tham chiếu cùng workspace/Page/profile; draft/media/video không chuyển owner. Field thừa/owner/authority_kind/authorityKind/contentRevision/provenance bị từ chối, không có payload đổi authority. IDs ngoài scope trả FORBIDDEN; stale CAS/quyền trả CONFLICT, hết quota LIMIT_EXCEEDED, facts chưa confirmed NEEDS_REVIEW. ContentRevision/fingerprint do server băm bytes/nội dung/đích/grant/basis/runAt, không tính nextRunAt/lastRunId; confirmed factIds là provenance, không phải semantic truth filter.

Quota chung Page/ngày + lifetime grant lưu qua restart, đếm owner schedules/recurring occurrences/posted runs không double-count cùng run, không huỷ lịch owner nhường chỗ. Timezone mismatch, trễ qua ngày, thiếu journal hoặc authority fail closed. Revoke/renew huỷ reserved autonomy và work gắn campaign, giữ submitting/uncertain cùng quota; owner CRUD không gia hạn authority cũ. Renewal chỉ phát grantChanged cho changed/revoked và grant mới; ID-only scheduleChanged là event local trong transaction, chưa có public pageWork.events projection cho loại này.

**Không quảng bá `pageCampaigns:1`, không runtime-ready:** service chặn autonomy trước tạo run/mở browser cho tới guard Task 4. scheduleId phải tồn tại trên server; missing/throw không coi là owner. Owner/manual legacy hợp lệ giữ nguyên. Gate thật false không đổi; bridge chưa thêm campaign execution flow, collect/report/optimize chưa làm. Schema execution explicit trên captured composition, không cài trong constructor/poster legacy hoặc chạy migration DB khách.

### 2.9 Ghi chú Task 4 — execution guard local dev, chưa runtime-ready

Bổ sung sau trạng thái Task 3 ở trên: scheduler/service chỉ chạy schedule autonomy khi tạo được guard main-process từ persisted authority và captured workspace/DB/generation. Guard không thuộc HTTP/IPC StartParams; không thêm method hoặc capability. Live runner/receiver key ID, gate/grant/link/ownership, selected variant, actual payload và media-byte fingerprint được kiểm lại trước publish; same-browser identity unknown/mismatch chặn effect. Direct/fallback publish có post-await/final synchronous barriers. Sau review, autonomous first comment **bỏ qua fail-closed**: own-feed/snippet và capture GraphQL Story/story_create chưa ràng buộc với current publish request, nên autonomy không suy postUrl từ chúng (postUrl=null, commentStatus=no_post_url nếu có comment). Guard từ chối firstComment khi chưa có nguồn bằng chứng exact current-publish được hỗ trợ; không thêm API cho caller tự khai authority. Comment path kiểm URL thực sau navigation và trước effect, không Enter-resend sau autonomous click rejection bất định. Owner fallback/retry giữ nguyên; bỏ qua/lỗi/thu hồi comment không xoá outcome posted.

Journal commit submitting trước gửi; crash/ambiguity giữ quota, recovery trước queue reload không resend uncertain. Đối soát chỉ dùng result/run/schedule/campaign/profile/target đúng captured workspace; explicit missed không chạy bù. Owner Page effects thiếu attribution bất biến được charge bằng upper bound trên các Page có thể bị ảnh hưởng, không khẳng định Page lịch sử từ identity hiện tại; có thể false-block/reduce remaining capacity. Owner history/manual rules không bị đổi để nhường quota.

Gate thật vẫn false, không quảng bá `pageCampaigns:1`. Synthetic tests không chứng minh live composer identity, receiver isolation hoặc packaging; chưa cho phép triển khai/bật quyền/provider thật.

### 2.10 Ghi chú Task 5 — measurement local dev, live verification pending

- `pageCampaigns.collect {workId,claimedAt,campaignId}` → `{checked,measured,unavailable}`. Runner-only, live lease/gate/primary/identity/campaign/grant/key checks trước và sau await; receiver không điều khiển browser. Một call xử lý tối đa một result/mốc qua shared research slot, không agent invocation. Schema đóng: không nhận counts, sourceRef, post target hoặc DB/clock từ payload.
- `pageCampaigns.report {pageId,campaignId,from?,to?}` → `{campaignId,pageId,from,to,published,eligible,measured,coverage,totalEngagement,uniqueLeads,lastObservedAt,missingReasons,finance,measurementWindow,observations}`. Read cho runner/receiver cùng workspace/Page/profile, surviving work prune; from mặc định to−28 ngày, to mặc định server now. `measurementWindow={milestoneMinutes:4320,minAgeHours:72,maxAgeHours:96}`. Observations là snapshot scoped có sourceRef/observedAt/milestone/counts nullable/status/reason và `sourceAvailable`; nguồn đã prune không được tính measured. Snapshot ngoài cửa sổ vẫn hiển thị, không dùng cohort so sánh. Missing/untrusted targets vẫn giữ published và eligible khi biết tuổi; unknown publishedAt không vào eligible. Tổng unknown nếu eligible chưa đủ counts; zero đầy đủ là số đo thật. Finance luôn `{status:'unavailable',reason:'missing_financial_source'}`; distinct lead ID theo exact canonical post attribution không phải doanh thu.

Collector chỉ tìm canonical URL Facebook dài 1–100 ký tự bằng posts search, limit 10; không cắt URL, không title/time/place fallback. Exact post ID/URL và Page author + scan/profile phải khớp. Stable scan/result/milestone association chỉ nhận scan mới của collector, không dùng cache flattened lịch sử. Mốc 60/1440/4320 dùng cùng timer 15 phút với group, luân phiên khi cả hai due; autoEnabled group không đổi. Internal timer không claim agent lease, nhường owner schedule và không tạo attempt khi busy. Owned cancellation/drain và generation guards bảo vệ DB retirement.

Production autonomy hiện vẫn postUrl=null; registry không nâng URL legacy/response-window Story thành current-publish proof. Fixture confirmed-target không chứng minh collector live; `protectedWritesEnabled=false` thật và không quảng bá `pageCampaigns:1`. Không optimize, runner tool flow, provider thật hoặc claim Page Insights/revenue/ROI đã đo. Các release blockers Task 4 và Make gates giữ nguyên.

### 2.11 Ghi chú Task 6 — optimizer bảo thủ local dev, chưa bật vận hành

`pageCampaigns.optimize {workId,claimedAt,campaignId,draftId,expectedDraftRevision,grantId,expectedGrantRevision}` → `{decision,scheduleId:string|null}`. Params đóng: không nhận counts, cohort, current selection, winner hoặc owner confirmation. Runner-only với gate và lease hiện hành; đúng workspace/Page/profile, original work sở hữu draft, active grant/revision/live receiver key. Receiver/legacy không được dùng route này. `expectedDraftRevision` là revision row hiện tại kể cả sau promote; execution revision được server đọc và CAS trong transaction.

`decision` gồm `id,campaignId,grantId,grantRevision,kind,before,after,observationRefs,sampleSizes,coverage,reason,createdAt`. Kind `keep|variant|time`, sample/coverage keys dạng `variant:A` hoặc `time:600`; ID/bằng chứng do server cấp và lưu bền. So sánh mean reactions+comments+shares: đủ ba safe nonnegative counts, mốc 4.320 phút, snapshot tuổi 72–96h, cửa sổ 28 ngày, ít nhất 5 bài và coverage ≥80% **cho mọi ứng viên**. Dedup theo result, null không phải zero; ties/thiếu cặp/thiếu provenance/sources bị prune thì keep, không chọn thắng theo ID. Immutable run snapshot giữ format/minute/selection revision, không nhóm lịch sử theo lịch/config hiện tại. Variant giữ slot/format cố định; time giữ variant/contentRevision/format cố định. Ưu tiên variant, mỗi decision chỉ đổi một yếu tố.

Chỉ apply qua scheduling validation/quota hiện có cho draft hoặc reserved autonomy schedule cùng work. Draft thiếu plannedAt trả `keep/missing_planned_time`, không tự chọn ngày. Không đổi bài đã đăng/owner schedule, không tăng bài/ngân sách/Page, không đổi thứ tự text để relabel A–E. Decision+apply/reservation+work journal commit nguyên tử; keep có scheduleId=null và không mutation lịch. Replay cùng inputs trả đúng decision cũ khi authority/evidence/resulting state còn hợp lệ, không quota lần hai; stale grant/key/lease/revision, owner edit/effect-started hoặc source hết hạn thì từ chối. HTTP cached/in-flight retry riêng method này vẫn gọi durable replay validator sau kiểm idempotency method/requestHash collision; failed validation không trả cached success. Generic cache/TTL/dedup các method khác giữ nguyên.

Đây là học từ quan sát, không causal inference/ROI hoặc cam kết tăng trưởng; pilot 7 bài thường chưa đủ mẫu. Không Python/runner tool flow mới, không quảng bá pageCampaigns capability; gate thật false. Production current-publish target vẫn null/unconfirmed và optimizer không có proof để apply. Synthetic confirmed targets chỉ kiểm local math/flow; firstComment/current-publish/live lookup/identity/receiver isolation/packaging/Make vẫn chặn phát hành.

### 2.12 Ghi chú Task 7 — Python campaign continuation local dev

Bridge giữ interface và quyền server: `build_tools(describe_result)` không thêm method/capability campaign giả; runner lấy tên scoped campaign từ filtered describe, không fallback quyền legacy. Read/list/report không phải consent. Không grant thì chỉ nháp/đề nghị; scheduling/collect/optimize cần grant/lease/revision hiện hành và giới hạn server. Một claim/Page và daily ledger ba invocation vẫn dùng chung xuyên campaign; không agent loop riêng trong receiver.

`grantCampaign {pageId,proposalId,expectedProposalRevision}` và `revokeCampaignGrant {pageId,grantId,expectedGrantRevision}` được receiver resolve qua scoped list/get, render exact revision và policy. Prepare → so exact normalized action → persist intent → send_once → bindMessage giữ nguyên. Chỉ authenticated sender/chat/reply/expiry hiện hành mới gọi confirm, stale/cancelled proposal hoặc stale/revoked grant phải đề nghị lại; không JSON command từ tin nhắn. Proposal ghi Page/campaign/goal, ngày UTC và allowedMinutes/timeZone, quota/actions, pause/thu hồi và không auto-renew.

Poll campaign độc lập work journal, chạy scoped list/get/report ngay cả khi mất event/prune. Report dùng from/to cố định: 28 ngày kết thúc đầu ngày UTC; send-once identity gồm workspace/Page/campaign/revision, grant IDs/revisions/effective statuses và kỳ. Mỗi kỳ chỉ gửi một lần, late metrics ở kỳ tiếp theo; status/revision đổi có key mới. Intent/uncertain không blind retry. Report giữ eligible denominator, missingReasons, null≠zero; finance unavailable, lead≠order. Không khẳng định điều chỉnh đã diễn ra từ lời AI.

**Integration completion Task 7:** existing `pageCampaigns.get {pageId,campaignId}` trả `{campaign,grants,latestDecision}` với `latestDecision:null|{decision:CampaignDecision,evidenceAvailable:boolean}`. Public decision schema dùng lại nguyên schema của optimize, không expose StoredCampaignDecision requestHash/stateHash/action/executionRevision. Query latest theo persisted `decision.createdAt DESC, id DESC`, scope workspace/Page/profile/campaign; không cần work cũ, không replay/apply hoặc đòi grant hiện còn hiệu lực. Assert captured context trước/sau read giữ nguyên.

`evidenceAvailable` kiểm mọi observationRefs qua scoped observations/published rows và provenance/source validity hiện tại; không refs/nguồn bị prune thì false. Giữ nguyên historical samples/coverage, chỉ đánh giá nguồn còn sẵn, không xác nhận lại thống kê hay cấp quyền lịch mới. Receiver render latest keep/variant/time cùng ID/ngày, before/after/reason, grant revision, samples/coverage tại quyết định và refs/availability. Decision ID + availability nằm trong send-once key để thay đổi trong cùng kỳ không bị che; restart/uncertain không blind retry, không agent call. Null hoặc field vắng ở server cũ giữ unknown. Grant ghi nhận và lịch sử không chứng minh hiện đang runnable/lịch tương lai tồn tại. Read model chỉ tóm tắt **latest state**, không cam kết phát lại mọi intermediate decision. Không endpoint/pagination/permission/migration mới.

Final campaign review fix: `pageWork.events` có thể trộn work hints với `pageCampaigns.proposalChanged/grantChanged` không có `workId`. Public Python poll bỏ riêng hai campaign hint khỏi work lookup (campaign list/get/report đã reconcile), vẫn xử lý work hints, unfinished IDs, draft dedup và persist `nextCursor`. Không suy work ownership từ campaign/proposal ID; malformed work events và lỗi auth/scope/workspace vẫn propagate. Không thay API/projection/schema; regression pinned HTTPS chỉ là bằng chứng local.

Repair review Task 7: receiver chỉ coi `CONFLICT` từ `pageApprovals.prepare` cho grantCampaign là per-proposal ineligible, trả local `{status:'ineligible',ticket:null}` không persist/send, cho phép các proposal/report/work khác tiếp tục và thử prepare lại khi eligible. Không swallow lỗi auth/scope/transport/system hoặc mismatch sau prepare. Không thay server authority hay tạo consent từ read.

Protected text preflight giữ giới hạn Telegram 4.096, đếm UTF-16 bảo thủ cho non-BMP. Report dài được compact trong **một** message: grant status counts, lược chi tiết policy/history, bounded excerpts có omitted counts và scoped get/report pointers; giữ metrics nullable/finance unavailable, latest decision/evidence và cảnh báo history không phải current authority. Dedup key không đổi vì compact, ambiguous delivery vẫn không retry. Full consent grant/revoke tuyệt đối không bị clip/split; không vừa thì local `{status:'oversize',ticket:null}` trước prepare/send/intent, không tạo uncertain cho size failure đã biết. Text protected còn quá dài cũng bị chặn trước persist/send. Đây không phải thay transport limit, endpoint hoặc approval contract server.

Runtime gate false, không capability advertisement hoặc deployment. Receiver VPS authenticated entrypoint/isolation/fresh-HOME CLI auth/current-publish/firstComment/live lookup/packaging và Make gates vẫn chặn acceptance/release.

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

Cả `/v1/pair` và `/v1/bridge.py` nằm sau bước kiểm tra danh sách IP, khoá IP và `/v1/health`, nhưng trước xác thực khoá. Chủ máy tạo vé trong MaiHub (gắn với IP của bot, sống 15 phút, dùng một lần); bot gửi `POST /v1/pair` thân JSON `{ "ticket": "…" }` (tối đa 1024 byte, quá thì `413`) và nhận `200 { "ok": true, "result": { "apiKey": "mh_…", "keyName": "…" } }`. Khoá legacy nhận được dùng ngay được; khoá scoped ở foundation dev vẫn fail closed cho tới khi runtime resolver sẵn sàng (mục 2.4). Vé sai, đã dùng, hết hạn, gửi từ IP khác, JSON hỏng hoặc thiếu `ticket` đều trả `401` cùng thông báo `Mã ghép nối không hợp lệ hoặc đã hết hạn` và tính vào khoá IP (10 lần sai thì IP bị chặn như khoá sai). Chế độ nhân viên trả `503 BUSY`. Mọi lần ghép nối được ghi nhật ký với `method = "pair"` (không ghi vé).

Sai phương thức HTTP trên đường dẫn đã biết trả `405` kèm `Allow`, mã `INVALID_PARAMS`, `details.field = "httpMethod"`. Đường dẫn lạ trả `404 NOT_FOUND`. Mọi phản hồi có `Cache-Control: no-store`.

## 5. Phong bì và mã lỗi

Thành công: `HTTP 200` với `{ "ok": true, "result": {…} }`.

Lỗi: `{ "ok": false, "error": { "code": "…", "message": "<tiếng Việt>", "details": {…} } }`. `details` chỉ có khi cần (ví dụ `{ "field": "mediaIds" }`). Phản hồi `UNAUTHORIZED`, `FORBIDDEN` trước body/cache hoặc upload, `RATE_LIMITED` (khoá IP và hạn mức 60/phút), `PAYLOAD_TOO_LARGE` và `503 BUSY` do chế độ nhân viên kèm `Connection: close`: client mở kết nối mới cho lần sau.

| Mã | HTTP | Khi nào |
|---|---|---|
| `UNAUTHORIZED` | 401 | Thiếu, sai hoặc đã thu hồi khoá. Mỗi lần tính vào bộ đếm khoá IP |
| `FORBIDDEN` | 403 | Scoped không có quyền hoặc lifetime/workspace đã đổi; ID ngoài scope không tiết lộ tồn tại |
| `CONFLICT` | 409 | Revision/fingerprint/idempotency xung đột; `runs.cancel` không có `runId` trong khi có từ 2 lượt đang chạy |
| `LIMIT_EXCEEDED` | 422 | Chạm giới hạn hồ sơ/thông tin/công việc Page, không tự xoá dữ liệu |
| `NEEDS_REVIEW` | 409 | Side effect cần đối soát/xem lại, không retry mù |
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
| `system.status` | không | `{ appVersion, workspace: {id,name}\|null, browserEngine, sandbox, schedulerRunning, currentRun, serverNowMs, timezone, utcOffsetMin, lastEventSeq }`. Từ 26.27.0: `serverNowMs` là giờ máy MaiHub (mili giây epoch, dùng để tính `runAt`), `timezone` (ví dụ `Asia/Ho_Chi_Minh`, có thể `UTC`) và `utcOffsetMin` là múi giờ của máy (giờ trong ngày của lịch lặp và `posts.bestTimes` theo múi này), `lastEventSeq` là `seq` sự kiện mới nhất của workspace đang mở (0 nếu chưa có), dùng làm `after` | không |
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
| `runs.current` | không | `{ run, progress }` (`null` nếu rảnh). View tương thích: khi có 2 lượt đang chạy chỉ trả lượt cũ nhất (`startedAt` nhỏ nhất, rồi `runId`). Không dùng để kiểm tra máy bận; dùng `runs.active` | không |
| `runs.active` | không | Mảng `[{ run, progress }]` các lượt đang chạy (kể cả đang chờ profile), tối đa 2, cũ nhất trước (`startedAt`, rồi `runId`); `[]` khi rảnh. Chỉ khoá owner/legacy; không có cho khoá scoped | không |
| `runs.list` | `limit`, `offset`, `kind` (`post`, `join`, `scan_groups`, `collect_comments`) | `{ runs, total }`, mới nhất trước | không |
| `runs.get` | **`runId`** | `{ run, results }`: kết quả từng đích, link bài, trạng thái bình luận; mỗi kết quả có `errorCode` (mã lỗi, `""` khi không lỗi hoặc không phải việc đăng) và `attempts` (số lần thử, mặc định 1) và `variant` (nhãn biến thể đã đăng, `""` nếu bài không có biến thể); `run.campaignId` (chuỗi hoặc `null`; lượt `missed`/`failed` do scheduler ghi không mang `campaignId`, luôn `null`). Xem bảng mã lỗi bên dưới | không |
| `runs.cancel` | **`confirm`**, `runId` (tuỳ chọn) | `{ cancelled }`. Có `runId`: lượt đang chạy → `true`; lượt đã xong → `false`; mã lạ hoặc của workspace khác → `NOT_FOUND`; `runId` rỗng/không phải chuỗi → `INVALID_PARAMS` (`details.field = "runId"`). Không `runId`: tối đa một lượt đang chạy (kể cả không có) → `true` (chỉ xác nhận đã gửi lệnh dừng, không phải bằng chứng lượt đã dừng; chờ `run.finished`); từ 2 lượt đang chạy → `CONFLICT`, hãy gọi `runs.active` rồi gửi lại với `runId`. `idempotencyKey` của khoá legacy phát lại kết quả đã lưu theo key (không so `runId`): dùng key riêng cho từng `runId`, key cũ với `runId` khác chỉ trả lại kết quả cũ và không dừng thêm lượt nào. Trong lúc chuyển workspace, sau khi coordinator cũ đã retire và trước khi coordinator mới được gắn: `runs.cancel` có `runId` trả `BUSY` (IPC `facebookPoster:cancel` trả `{success:false}`), còn không `runId` vẫn xác nhận `{cancelled:true}`. Chỉ khoá owner/legacy | có |
| `events.wait` | **`after`** (≥ 0), `timeoutSec` (0–25) | `{ events: [{ seq, type, payload, createdAt }], workspaceId }` | không |
| `research.search` | **`source`** (`posts`/`groups`/`pages`), **`query`** (1–100 ký tự), `recent` (boolean, chỉ `posts`), `year` (chỉ `posts`, từ 2010 tới năm hiện tại), `limit` (1–500, mặc định 200), `profileIds` (mảng 1–50 mã; bỏ trống = mọi profile) | `{ scanId }`. Quét Facebook theo từ khoá, chỉ đọc, chạy nền; xong có sự kiện `research.finished`, rồi lấy kết quả bằng `research.get`. `INVALID_PARAMS` nếu tham số sai hoặc `profileIds` rỗng; `NOT_FOUND` với `details.missing` nếu `profileIds` có mã lạ; `BUSY` nếu đang có lượt quét khác | không |
| `research.scanGroupFeeds` | `groupUrls` (≤ 20 link nhóm; bỏ trống = 20 nhóm được quét gần nhất của các profile đủ điều kiện), `sinceDays` (1–30, mặc định 7), `limitPerGroup` (1–100, mặc định 30), `profileIds` | `{ scanId }`. Đọc bài mới trong nhóm; lỗi như `research.search` | không |
| `research.list` | `limit` (1–200), `offset`, `source` (`posts`/`groups`/`pages`/`group_feed`) | `{ total, scans[] }` (mới nhất trước) | không |
| `research.get` | **`scanId`**, `sort` (`engagement` mặc định / `recent` / `members`), `limit` (1–500), `offset` | `{ scan, total, items[] }`. `NOT_FOUND` nếu `scanId` lạ | không |
| `research.trending` | `queries` (≤10 chuỗi, mỗi chuỗi 1–80 ký tự sau trim), `groupIds` (≤20 mã nhóm); cần ít nhất một từ khoá hoặc mã nhóm; `sinceHours` (số nguyên 1–168, mặc định 72), `limit` (số nguyên 1–100, mặc định 20) | `{ items: [{ fbId, url, text, placeName, placeId, engagement, score, basis, seen, postedAt }] }`. Chỉ đọc mục `post` của lượt `done` bắt đầu trong khoảng `sinceHours`: nguồn `posts` khớp `queries` sau trim, không phân biệt hoa thường; hoặc `group_feed` khớp `placeId`. Gom theo `fbId`, hai lần đầu/cuối cách nhau ≥1 giờ thì `score = (e_last - e_first) / số giờ`, `basis = 'growth'`; còn lại dùng lần cuối với `score = e_last / max(1, tuổi bài lúc quét tính bằng giờ)`, `basis = 'age'`. `e` là tổng tương tác (NULL tính 0); `engagement` lấy lần cuối, `seen` đếm quan sát. Bỏ bài không biết thời gian đăng hoặc cũ hơn 7 ngày; `text` cắt 500 ký tự; xếp `score` giảm dần rồi cắt `limit`. Không quét mới; không có dữ liệu khớp trả `items: []`. Tham số sai → `INVALID_PARAMS` | không |
| `research.cancel` | không | `{ cancelled: boolean }`. Dừng lượt quét đang chạy (kể cả khi đang nghỉ giữa trang) | không |
| `pages.learn` | `profileIds` (1–50 mã; bỏ trống = mọi profile), `force` (boolean, mặc định false) | `{ jobId }` ngay; chạy nền, xong phát `pages.learnFinished`. `BUSY` đồng bộ nếu khe Đăng Facebook bận hoặc Nghiên cứu đang chạy; Nghiên cứu cũng từ chối khi đang học. Mảng rỗng → `INVALID_PARAMS`, mã lạ → `NOT_FOUND` | không |
| `pages.list` | không | `{ identities: PageIdentity[] }`: mọi danh tính đã lưu của workspace; camelCase, `recentPosts` đã parse, kèm `learnedAt`, `errorCode`, `error` | không |
| `briefs.list` | không | `{ briefs }`: mọi kế hoạch Page của workspace, kèm `pageName` từ danh tính hiện tại | không |
| `briefs.get` | **`profileId`** | `{ brief }`, kèm `pageName`; chưa có kế hoạch → `NOT_FOUND` | không |
| `briefs.save` | **`profileId`**, `niche` (≤300 ký tự), `keywords` (1–10 chuỗi không rỗng, mỗi chuỗi ≤80), `groupIds` (0–20 mã nhóm không rỗng), `tone` (≤500), `notes` (≤1000), `time` (`HH:MM`, giờ máy MaiHub, mặc định `07:00`), `draftsPerDay` (nguyên 1–5, mặc định 1), `enabled` (boolean, mặc định true) | `{ brief }`. Profile phải còn tồn tại và có danh tính `kind = 'page'`, nếu không → `INVALID_PARAMS`. Tạo mới cần `keywords`; sửa chỉ đổi trường được gửi; bỏ qua trường trạng thái. Tối đa 10 kế hoạch/workspace, tạo dòng thứ 11 → `LIMIT_REACHED`; vẫn sửa được dòng cũ | không |
| `briefs.delete` | **`profileId`**, **`confirm:true`** | `{ deleted:true }`; chưa có kế hoạch → `NOT_FOUND` | **có** |
| `briefs.claimDue` | `profileId` (tuỳ chọn, chuỗi không rỗng; bỏ qua giữ batch) | `{ briefs }`: kế hoạch kèm `profileId, pageName, niche, keywords, groupIds, tone, notes, draftsPerDay, claimedAt` và trạng thái. Nhận trong giao dịch, không nhận trùng; chỉ Page còn tồn tại, bật, tới giờ, chưa thành công hôm nay và chưa đủ 3 lần lỗi. Lượt treo 60 phút được lưu idle và tính một lỗi cho ngày nhận trước khi xét nhận lại, kể cả hết lượt/tắt/ineligible; phát completion lỗi sau transaction thành công, không lặp khi polling. Claim ngày mới reset số lỗi về 0. Ngày/giờ theo máy MaiHub. Bot phải giữ `claimedAt` nguyên để hoàn tất đúng lượt | không |
| `briefs.finish` | **`profileId`**, **`claimedAt`** (nguyên, mili giây epoch từ `claimDue`), **`ok`** (boolean), `draftIds` (mảng chuỗi, mặc định `[]`), `error` (chuỗi, cắt 500 ký tự) | `{ brief }`. Yêu cầu lượt đang `running` và `claimedAt` khớp; sai/thiếu claim hoặc không đang chạy → `INVALID_PARAMS`, giữ nguyên lượt và không phát sự kiện. `ok:true` ghi ngày thành công bằng ngày nhận lượt (kể cả qua nửa đêm); `ok:false` tăng số lần lỗi của ngày nhận. Về `idle`, phát `briefs.finished` sau completion hợp lệ | không |
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
| `comments.collect` | `postUrls` (1–50 link bài; bỏ trống = các bài đến hạn thu; mỗi lượt xử lý tối đa 10 bài) | `{ jobId, posts }`. Thu bình luận bài đã đăng (chỉ đọc), chạy nền; bình luận mới khớp thành khách thì có sự kiện `leads.found`. Link không có dòng theo dõi bị bỏ qua (`posts` không tính); từ 26.27.0 lượt xong có sự kiện `comments.collectFinished` (lọc theo `jobId`), trạng thái xem bằng `comments.collectStatus`. `BUSY` nếu đang đăng, kiểm tra đăng nhập hoặc đang thu | không |
| `comments.collectStatus` | không | `{ running, jobId, progress: { done, total }, last }`; `last` là lượt gần nhất `{ jobId, auto, finishedAt, cancelled, posts, collected, leads, errors }` (`errors` tối đa 10 dòng `{ postUrl, profileId, error }`) hoặc `null`. Từ 26.27.0 | không |
| `comments.collectCancel` | không | `{ cancelled }` (`false` nếu không có lượt nào đang chạy); dừng sau bài đang đọc. Từ 26.27.0 | không |
| `comments.list` | `postUrl`, `since` (epoch ms, theo thời điểm thu), `limit` (1–500), `offset` | `{ total, comments[] }` | không |
| `leads.list` | `status` (`new`/`contacted`/`won`/`ignored`), `campaignId` (`""` = không thuộc chiến dịch), `from`, `to`, `search`, `limit` (1–500), `offset` | `{ total, leads[] }` (mới nhất trước) | không |
| `leads.update` | **`id`**, và `status` hoặc `note` (≤ 1000 ký tự; cần ít nhất một) | `{ lead }`. `NOT_FOUND` nếu `id` lạ; `INVALID_PARAMS` nếu tham số sai | không |
| `leads.config` | `config` (`{ autoCollect, collectAtMinutes[], keywords[], detectPhone, aiEnabled, aiMinScore }`; `collectAtMinutes` 1–10 số tăng dần, 30–20160 phút; `keywords` 1–100 mục, mỗi mục 1–40 ký tự; `aiMinScore` 0–100). Không truyền = chỉ đọc | `{ config }`. `INVALID_PARAMS` nếu `config` sai | không |
| `videos.templates` | — | `{ templates[], music[] }` lấy từ máy chủ render (mỗi mẫu có `aspects`, `imageSlots`, `variables` kèm giới hạn độ dài). `INVALID_PARAMS` "Chưa cấu hình máy chủ render video"; `INTERNAL` "Không kết nối được máy chủ render" | không |
| `videos.render` | **`name`** (1–100 ký tự) và **đúng một** trong hai kiểu. Kiểu mẫu: `templateId`, `aspect` (`9:16` / `1:1` / `16:9`), `variables`, `imageIds` (1–20 mã tệp `/v1/media`, theo thứ tự), nhạc tuỳ chọn `musicId` (nhạc có sẵn, `null` = không nhạc) **hoặc** `musicMediaId` (mã tệp `/v1/media` của một tệp nhạc `mp3` / `m4a` / `wav`; ảnh hoặc video thì `INVALID_PARAMS`). Biến chuỗi của mẫu mặc định bắt buộc không trống; chỉ biến có `required: false` trong `videos.templates` mới được để `""`. Kiểu HTML: `html`, `width`, `height`, `assetIds` (≤ 20 mã tệp `/v1/media`; trong HTML gọi tệp theo tên `asset1.<đuôi>`, `asset2.<đuôi>`… theo thứ tự; máy chủ đặt đuôi theo nội dung thật nên chỉ có `jpg`, `png`, `webp`, `mp3`, `m4a`, `wav`, `mp4`, ví dụ `.jpeg` thành `.jpg` và `.mov` thành `.mp4`). HTML phải theo quy ước HyperFrames: phần tử gốc có `data-composition-id`, `data-width`, `data-height`, `data-start="0"`, `data-duration`; mỗi cảnh có `id`, `class="clip"`, `data-start`, `data-duration`, `data-track-index`; hoạt ảnh chỉ bằng một `gsap.timeline({ paused: true })` gán vào `window.__timelines[<data-composition-id>]` (`gsap.min.js` có sẵn, gọi `<script src="gsap.min.js">`); animation/transition CSS và `setTimeout` không chạy vì máy chủ tua theo timeline. Máy chủ chạy `hyperframes lint` trước khi render, có lỗi thì `videos.finished` báo `ok = false` với lỗi "HTML chưa đúng quy ước HyperFrames: <mã> (…)" trong vài giây; khung mẫu ở `GUIDE` của bridge (`maihub_guide` mục 7). Chung: `fps` (24 / 30), `quality` (`standard` / `high`) | `{ videoId, status }`. Chạy nền; xong có sự kiện `videos.finished`. `LIMIT_REACHED` nếu hàng đợi máy chủ đầy, quá hạn mức tạo việc hoặc máy chủ render sắp hết dung lượng ("Máy chủ render sắp hết dung lượng", HTTP 507 ở máy chủ); `INVALID_PARAMS` nếu chưa cấu hình máy chủ render, sai tham số, `mediaId` lạ hoặc hết hạn; `INTERNAL` nếu không kết nối được máy chủ | không |
| `videos.adCreate` | **`name`** (1–100 ký tự), **`scenes`** (2–10 cảnh). Mỗi cảnh một trong: `{type:"ai", prompt}` (AI vẽ ảnh rồi cho chuyển động), `{type:"image", imageMediaId` / `imageUrl}`, `{type:"presenter", line}` (người dẫn nói, khớp môi; phải có `presenter.imageMediaId` / `imageUrl` hoặc `presenter.prompt`). Cảnh `ai` / `image` nhận thêm `motion` (≤ 120), `voiceover` (≤ 300, phủ tối đa 2 cảnh liền nhau), `duration` 2,0–4,3 giây; cảnh `presenter` nhận `setting` (≤ 500). `prompt` ≤ 500, `line` ≤ 300. Giọng `voice`: bỏ trống = mặc định; `name` + `speed` 0,7–1,3; hoặc `refAudioMediaId` + `refText` (nhân bản giọng). Nhạc `music`: bỏ trống = không nhạc; đúng một trong `mediaId` / `url` (tệp nhạc) hoặc `prompt` (AI tạo nhạc). `brand`: `logoMediaId` / `logoUrl`, `website` (≤ 100), `endLine` (≤ 300, được đọc lên). `language` `vi` / `en` (mặc định `vi`). Mọi chỗ nhận tệp dùng **đúng một** trong `<base>MediaId` (mã tệp `/v1/media`) hoặc `<base>Url` (link công khai) | `{ videoId, status }`. Chạy nền **rất lâu** (thường 20–60 phút, tối đa 150 phút); theo dõi bằng `videos.status` (`progress`, `stepText`) hoặc chờ `videos.finished` (có thể kèm `warnings`). `LIMIT_REACHED` nếu hàng chờ của AHV AI đầy, hết lượt trong ngày hoặc tính năng đang tắt (chờ vài phút rồi gửi lại); `INVALID_PARAMS` nếu chưa cấu hình AHV AI, sai kịch bản, `mediaId` lạ hoặc hết hạn; `INTERNAL` nếu AHV AI lỗi | không |
| `videos.status` | **`videoId`** | `{ video }` (`id`, `name`, `status`, `progress` 0–1, `error`, `durationSec`, `sizeBytes`, `createdAt`, `finishedAt`, `engine` `hyperframes` / `ahv_ad`, `stepText`, `adResult`…; không có đường dẫn trên máy). Video quảng cáo AI có `stepText` (`H3 3/7`) lúc chạy và `adResult` (`warnings`, `costUsd`, `scenes`, `sttText`, `expiresAt`) khi xong. `NOT_FOUND` nếu `videoId` lạ | không |
| `videos.list` | `status` (`uploading`/`queued`/`rendering`/`done`/`failed`/`cancelled`), `limit` (1–100, mặc định 50), `offset` | `{ total, videos[] }` (mới nhất trước) | không |
| `videos.cancel` | **`videoId`** | `{ cancelled }`; `false` nếu video không còn đang chờ hoặc đang render. Với engine `ahv_ad` việc này chỉ dừng theo dõi ở MaiHub: job phía AHV AI vẫn chạy tới cùng và vẫn tốn tiền máy. `NOT_FOUND` nếu `videoId` lạ | không |

`run.status` nhận một trong `running`, `done`, `cancelled`, `failed`, `missed`.

Học Page (`pages.learn`) chỉ đọc `/me` và embedded JSON đã tải theo bộ đọc bảo thủ, không tự gọi GraphQL/pagination. Mỗi lần mở một profile; kiểm freshness trước khi nghỉ, profile fresh bị bỏ qua không gây nghỉ. Nghỉ ngẫu nhiên 20000–60000 ms chỉ giữa hai lần thử mở browser đủ điều kiện, không nghỉ trước lần thử đầu hoặc sau lần thử cuối; lỗi mở/profile đang mở tay vẫn tính là lần thử. Danh tính học thành công còn mới dưới 86400000 ms được bỏ qua trừ khi `force:true`. Profile đang mở tay hoặc phần chưa chạy khi dừng/nhường lịch có `kind:'skipped'`.

Checkpoint ghi `errorCode:'checkpoint'`; logout ghi `errorCode:'not_logged_in'`, còn `profile.loginProblem` vẫn dùng `state:'logged_out'`. Lỗi đọc/đóng session và kết quả `unknown` giữ metadata đã học cùng `learnedAt` trước đó, ghi lỗi lần gần nhất và không được coi là lần học thành công mới. Profile chưa có bằng chứng có `kind:'unknown', learnedAt:0`; lần học lỗi/unknown được thử lại dù metadata trước đó còn mới. `pages.list` có thể chứa metadata cũ kèm lỗi mới, nên bot phải đọc cả thời gian và lỗi.

Learner dùng cùng khe với lượt đăng, login check, tracking và thu bình luận; nhường lịch đăng sắp đến giờ. Huỷ/chờ dừng khi đổi workspace bao gồm learner và chờ session đóng trước khi chuyển DB. Chế độ nhân viên chặn API theo guard 503 hiện có; kết quả muộn từ workspace/chế độ cũ không ghi hoặc phát vào context mới. Tính năng chưa phát hành; bằng chứng đọc hiện chỉ offline, chưa xác minh Facebook/người thật hoặc pagination.

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
| `run.finished` | Việc kết thúc | `{ runId, kind, status, scheduleId, scheduleName, campaignId, posted, failed, skipped }` (đếm theo kết quả từng đích; `scheduleName` là tên lịch, `null` nếu không từ lịch hoặc lịch đã bị xoá; `campaignId` từ 26.27.0, `null` nếu không thuộc chiến dịch) |
| `schedule.missed` | Lịch bị lỡ (app tắt/máy ngủ quá giờ, chờ quá 2 giờ, hoặc app đóng khi lượt đang chờ) | `{ scheduleId, name, reason, at }`; `reason` là một trong `App tắt lúc đến giờ`, `Chờ quá 2 giờ vì đang có việc khác`, `App đóng khi lượt đang chờ` (`MISSED_APP_QUIT`) |
| `draft.approved` | Duyệt nháp (trong app hoặc qua API) | `{ scheduleId, name, when: "now"\|"scheduled", kind, nextRunAt }` |
| `profile.loginProblem` | Trạng thái đăng nhập lưu của profile chuyển sang `logged_out` hoặc `checkpoint` (từ trạng thái khác, kể cả `unknown`); giữ nguyên thì không phát lại | `{ profileId, profileName, state, source }`; `source` là `check` hoặc `run` |
| `profiles.checkFinished` | Một lượt kiểm tra đăng nhập kết thúc | `{ checkId, source: "manual"\|"api"\|"daily", results: [{ profileId, profileName, outcome, error? }] }`; `outcome` là `ok`, `logged_out`, `checkpoint`, `error`, `skipped`; `error` chỉ có khi `outcome = error` |
| `research.finished` | Một lượt quét Nghiên cứu kết thúc (xong, lỗi hoặc bị huỷ) | `{ scanId, source, query, status, errorCode, itemCount }`; lấy kết quả bằng `research.get` |
| `pages.learnFinished` | Một lượt học kết thúc, kể cả bị dừng hoặc nhường lịch | `jobId, results: [{profileId, kind, pageName, error?}]`; `kind` là `page`/`person`/`unknown`/`skipped`. Không có HTML, session hay trường nội bộ |
| `briefs.finished` | Một lượt đề xuất Page được kết thúc bằng `briefs.finish` hợp lệ hoặc lease hết hạn được settle sau transaction thành công | `{ profileId, pageName, ok, draftIds, error?, attempts?, attemptDate? }`; mọi sự kiện lỗi mới có `attempts` (nguyên) và `attemptDate` (YYYY-MM-DD ngày nhận lượt) chụp lúc completion, kể cả expiry terminal không trả claim mới; polling không phát lại. Hai trường additive tuỳ chọn cho consumer cũ, không migration. `draftIds` mặc định `[]`, `error` tối đa 500 ký tự; chỉ giữ trường công bố. Watcher mới dùng snapshot; legacy thiếu snapshot đọc counter hiện tại best-effort, không bảo đảm chính xác lịch sử |
| `posts.trackFinished` | Một lượt theo dõi bài đăng kết thúc (xong, huỷ hoặc có lỗi; cả lượt do người dùng bấm hay MaiHub tự chạy) | `{ jobId, auto, cancelled, groups, checked, found, linked, removedSuspected, notFound, errors }`; `auto` là `true` khi MaiHub tự chạy, `errors` là số nhóm lỗi; chi tiết bằng `posts.trackStatus` |
| `leads.found` | Có khách tiềm năng mới sau một lượt thu bình luận (một sự kiện cho cả lượt, `count` là tổng khách của lượt chứ không phải mỗi bài, cả thu tay lẫn tự thu; không phát khi không có khách mới) | `{ count, samples: [{ authorName, text, postUrl }] (tối đa 3), auto, leadIds, campaignIds }`; từ 26.27.0 `leadIds` là tối đa 20 mã khách (mới nhất trước, dùng cho `leads.update`), `campaignIds` là tối đa 20 mã chiến dịch khác nhau của các khách đó (bỏ `null`); xem đầy đủ bằng `leads.list` |
| `comments.collectFinished` | Một lượt thu bình luận kết thúc (xong hoặc bị huỷ; cả lượt tự thu lẫn lượt do người dùng / bot gọi). Từ 26.27.0 | `{ jobId, auto, cancelled, posts, collected, leads, errors }`; `collected` là số bình luận mới, `leads` là số khách mới, `errors` là số lỗi (chi tiết bằng `comments.collectStatus`) |
| `videos.finished` | Một video render xong hoặc lỗi (cả video do ứng dụng tạo). Huỷ (bằng `videos.cancel` hoặc từ ứng dụng) cũng phát sự kiện này với `ok = false` và `cancelled = true`; bot nên coi đó là huỷ, không phải lỗi render, và không tự thử lại | `{ videoId, name, ok, cancelled?, error?, durationSec?, sizeBytes?, mediaId?, warnings? }`; `cancelled` chỉ có (và luôn là `true`) khi video bị huỷ, kèm `error = "Đã huỷ"`; `error` chỉ khi `ok = false` (hoặc khi video xong nhưng không chép được vào hộp thư); `warnings` chỉ có với video quảng cáo AI khi có cảnh báo (`stt_mismatch`, `fallback_still`, `cut_by_cost_cap`, `cut_by_time`, `h3_8s_used`) — video dùng được nhưng nên cho người xem lại; `mediaId` chỉ có với video do bot tạo bằng `videos.render` hoặc `videos.adCreate`, dùng ngay trong `drafts.create.mediaIds` (hết hạn sau 24 giờ như mọi tệp hộp thư) |

Sau `run.finished`, gọi `runs.get` với `runId` để lấy link bài và chi tiết từng đích.

Mã lỗi `errorCode` trong kết quả của `runs.get` (chỉ-thêm, bot cũ bỏ qua được):

| Mã | Ý nghĩa | Tự thử lại? |
|---|---|---|
| `navigation_failed`, `composer_not_found`, `media_failed`, `editor_not_focusable`, `submit_not_ready`, `submit_not_found`, `unexpected_error` | Lỗi **trước** cú bấm Đăng (tải trang, hộp soạn thảo, ảnh/video, ô nhập, nút Đăng, lỗi bất ngờ) | Có, tối đa 3 lần (`attempts` ≤ 3), chờ 10–30 giây |
| `uncertain_after_submit` | Đã bấm Đăng nhưng không xác nhận được, hoặc trình duyệt bị đóng cưỡng bức: **có thể bài đã lên**, kiểm tra trước khi đăng lại | Không |
| `draft_conflict` | Lần thử lại thấy bản nháp cũ không xoá được | Không |
| `not_logged_in` | Profile chưa đăng nhập Facebook, hoặc bị chuyển sang trang đăng nhập giữa lượt (từ 26.28.0 dừng profile, các đích còn lại cùng mã) | Không |
| `launch_failed` | Không mở được trình duyệt/profile | Không |
| `stopped` | Bị bỏ qua vì Huỷ (`outcome = skipped`) | Không |
| `unknown` | Không xác định | Không |
| `checkpoint` | Từ 26.28.0. Facebook bắt xác minh tài khoản (trang `/checkpoint`, `/two_step_verification`, `/auth_platform`); MaiHub dừng profile đó, các đích còn lại cùng mã, và phát `profile.loginProblem` | Không |
| `browser_closed` | Từ 26.28.0. Trình duyệt của profile đóng giữa chừng **trước** cú bấm Đăng (bài chưa lên); các đích còn lại cùng mã | Không |

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

Bridge có lệnh `watch` chạy liên tục: chờ `events.wait` (25 giây một lượt) rồi gửi tin tiếng Việt qua Telegram bằng token của bot (`TG_TOKEN` trong `.env` của bot). Tin gửi: lượt đăng/tham gia/quét/thu bình luận xong, có lỗi hoặc bị huỷ (`run.finished`), lỡ lịch (`schedule.missed`), profile hết phiên hoặc bị checkpoint (`profile.loginProblem`), video xong (`videos.finished`: gửi kèm tệp video khi ≤ 50 MiB, không thì chỉ gửi chữ), mất và có lại liên lạc với MaiHub, khoá bị từ chối hoặc sai ghim chứng chỉ. Không báo `run.started`, `draft.approved`, `profiles.checkFinished`, `comments.collectFinished`, và (từ bridge 26.27.0) các lượt tham gia nhóm / quét nhóm / thu bình luận xong không lỗi.

### Bridge MCP: hướng dẫn, gợi ý lỗi và chờ sự kiện (26.27.0)

- `initialize` trả `instructions` là bản hướng dẫn vòng làm việc (hằng `GUIDE` trong bridge); tool `maihub_guide` trả lại đúng văn bản đó cho client không đọc `instructions`.
- Tool lỗi trả tối đa 3 dòng: `<MÃ>: <thông báo>`, `Chi tiết: <details JSON>` (khi có) và `Gợi ý: …` theo mã (`ERROR_HINTS`). Kết quả thành công là JSON gọn (không thụt lề).
- `maihub_wait_for` (`types?`, `match?`, `after?`, `workspaceId?`, `maxSec` 1–600, mặc định 50; nên giữ ≤ 50 vì nhiều client MCP cắt tool sau 60 giây): gọi `events.wait` lặp (mỗi lần ≤ 25 giây) tới khi có sự kiện khớp; trả `{ event, after, workspaceId }`, `{ timedOut: true, after, workspaceId }` (gọi lại với đúng `after` và `workspaceId` đó) hoặc `{ workspaceChanged: true }` (gọi lại không kèm `after`). `workspaceId` cho biết `after` thuộc workspace nào; truyền kèm `after` để bridge nhận ra MaiHub đã đổi workspace. Không có `match` theo mã việc riêng thì luôn truyền `after` từ kết quả trước, nếu không có thể nhận lại sự kiện cũ. Bỏ trống `after` thì dùng mốc của phiên: `system.status.lastEventSeq` lấy ngay sau `initialize` (lỗi thì thử lại trước lời gọi tool kế tiếp; MaiHub cũ thì duyệt sự kiện tới hết), không tự tiến, nên việc xong trước khi bot kịp gọi chờ vẫn được trả về. Đổi workspace thì bridge lấy ngay mốc mới của workspace mới (lúc phát hiện) rồi trả `workspaceChanged`, nên sự kiện xảy ra trước lần chờ kế tiếp vẫn được trả về.

Khoá `.env` liên quan: `MAIHUB_NOTIFY_CHAT_ID` (`.env` MaiHub; mặc định lấy `ALLOWED_CHAT_ID`/`ADMIN_USER_ID` của bot), `TELEGRAM_API_BASE` (bắt buộc `https://`) và `TELEGRAM_PROXY` (`.env` MaiHub; đường tới Telegram khi VPS cần proxy; SOCKS không hỗ trợ). `watch --check-telegram` gọi Telegram `getMe` một lần qua tuyến đó rồi thoát. Khi khoá bị từ chối hoặc ghim lệch, `watch` báo một lần rồi nạp lại `.env` sau mỗi 300 giây nên ghép nối lại (`pair`, giữ nguyên các dòng khác của `.env`) tự có hiệu lực. Trạng thái (con trỏ sự kiện) lưu ở `state/watch-state.json`; `--dry-run` in tin ra stdout và không lưu gì.

Cài thành service systemd: `pair --install` tự cài (trừ khi có `--no-watch`); bot cài từ trước dùng `sudo python3 maihub_bridge.py install-watch --env-file <.env MaiHub> --notify-env <.env bot> --user <user> --name <tên-service-bot>`. Chi tiết trong `tools/maihub-bridge/README.md`.

## 11. Mẹo cho bot

- Gọi `GET /v1/describe` (hoặc tool MCP) để biết thao tác hiện có; đừng mã cứng danh sách.
- Mọi thao tác ghi nên có `idempotencyKey`; mọi thao tác nguy hiểm phải hỏi người dùng trước khi đặt `confirm: true`.
- Giữ ít hơn 60 lời gọi/phút; dùng một `events.wait` dài thay vì hỏi dồn `runs.current`.
- Nghi lộ khoá: thu hồi trong Cài đặt MaiHub, tạo khoá mới, cập nhật `.env`. Nhật ký trong Cài đặt cho biết khoá đã làm gì.
