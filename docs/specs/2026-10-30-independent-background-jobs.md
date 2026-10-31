# Tác vụ nền độc lập khi đăng Facebook

**Ngày:** 2026-10-30  
**Trạng thái:** Phát hành trong 26.32.0 (31/10/2026) sau review từng task (Tasks 1–8), review toàn nhánh (một vòng sửa + vòng sửa nốt) và lựa chọn "Thoát ngay" do anh chọn. Kiểm chứng bằng Jest/harness (131 suites/3426 tests); chưa kiểm trên app Electron thật hoặc Facebook thật.\
**Phạm vi:** Subproject điều phối đồng thời trong ứng dụng desktop, nền cho chế độ AI tự vận hành.  
**Nguồn thiết kế UI:** `DESIGN.md`, đặc biệt bộ token `poster` và mục Màn hình Đăng Facebook.

## 1. Mục tiêu và ý định

Anh cần tiếp tục soạn nội dung, xem dữ liệu, tạo video và chạy các công việc Facebook khác trong lúc một lượt đăng đang hoạt động. Đăng bài không được khóa cả màn hình hoặc chiếm một khóa chung cho mọi chức năng.

Yêu cầu liên quan nhưng có vòng spec → plan riêng:
- Chế độ AI tự vận hành các chức năng được cấp quyền, thay vì phải nhắn bot giao từng việc.
- Bình luận độc lập: tự tìm bài phù hợp và thực sự có quyền truy cập/bình luận, không cần danh sách URL cố định.
- Hoàn thiện bằng chứng bài vừa đăng và đo lường/tối ưu dựa trên dữ liệu có nguồn gốc.

**Doanh thu/ROI đã được anh loại khỏi phạm vi phát triển ngày 2026-10-30.** Không xây bộ đo tài chính, không suy doanh thu từ lead; không xóa đột ngột các trường API legacy đang trả unavailable.

Spec này không tự cấp quyền đăng/bình luận, không bật `protectedWritesEnabled`, không bỏ các cổng kiểm chứng live. “Chạy độc lập” nghĩa là công việc không tranh tài nguyên có thể tiến triển đồng thời khi ứng dụng đang mở, không phải tiếp tục chạy sau khi thoát app.

## 2. Hiện trạng đã kiểm tra trong mã

| Điểm | Hành vi hiện tại | Hệ quả |
|---|---|---|
| `FacebookPosterService.start` | Khởi chạy async và trả `runId` ngay; giữ một `active` và trạng thái stop/error của instance | Đã chạy nền, nhưng chỉ một lượt trong service |
| `getResearchBrowserSlot` và các slot trong `facebookPosterIpc.ts` | Research, học Page, kiểm tra đăng nhập, tracking và thu bình luận chia sẻ exclusive slot của poster | Profile khác nhau vẫn chặn nhau |
| `FacebookPosterView` / `PostTab` | Một cờ busy từ run khóa editor, media và lựa chọn profile | Muốn soạn nháp khác vẫn phải chờ; dù đường hẹn lịch có ý định cho phép chạy lúc bận |
| `BrowserProfileService` | Giữ profile trước await; cấm hai browser cùng profile; tối đa 30 profile đang mở | Có primitive tài nguyên cần giữ, không thay bằng cờ UI |
| Scheduler | Hàng chờ lịch, grace 60 giây, tối đa chờ 2 giờ; gặp busy thì dừng pump | Lịch không tranh profile cũng phải đợi lượt khác |
| Current/cancel/progress | Current/cancel mặc định một lượt; progress/log đã mang runId | Cần tương thích đường một lượt và điều khiển tường minh khi có nhiều lượt |
| Workspace retirement | Hủy và drain trước khi đóng DB | Phải bao phủ mọi công việc sau thay đổi |

`DESIGN.md` hiện quy định “Một việc một lúc”. Khi triển khai phải cập nhật đúng dòng đó và ghi thay đổi hành vi mới; không đổi visual identity hay các trang không liên quan.

## 3. Phạm vi kết quả

### Phải đạt

1. Đang đăng A vẫn soạn, sửa và lưu nháp B; thay đổi B không làm thay đổi snapshot đang chạy của A.
2. Có thể chạy hai lượt thuộc nhóm `post`, `scan_groups`, `join`, `collect_comments` khi tài nguyên cho phép. Giới hạn đợt đầu là **2 lượt sống đồng thời trong nhóm này**, tính cả lượt đang chờ profile; lượt thứ ba bị từ chối rõ ràng, không tạo run rác. Các lịch tiếp tục dùng hàng chờ scheduler hiện có.
3. Research, học Page, kiểm tra đăng nhập, tracking và thu lead tự động giữ giới hạn một job của từng service hiện tại, nhưng không còn tranh một khóa toàn cục với poster.
4. Mỗi profile chỉ có một chủ điều khiển tại một thời điểm. Khác profile có thể chạy; cùng profile chờ có lý do và có thể hủy.
5. Giữ toàn bộ giới hạn concurrency/stagger/delay hiện có trong mỗi lượt và giới hạn tổng 30 browser profile đang mở. Không nhân giới hạn browser theo số worker.
6. Hủy một lượt không dừng lượt khác. Đổi workspace, cập nhật app hoặc thoát app phải nhận biết và xử lý tất cả lượt/side jobs.
7. Khi còn capacity run, lịch đăng trên tài nguyên rảnh không bị một lịch đang đợi profile khác chặn ở đầu hàng chờ.

### Không thuộc đợt này

- Chạy nhiều instance desktop cùng điều khiển một workspace, chạy khi app đã tắt, hoặc chuyển workload sang server mới.
- Thêm Redis, queue framework, process/thread pool hay dependency mới; tác vụ browser hiện đã async.
- Tăng quyền API/runner, thay đổi quota Page, tự xác nhận fact hoặc tự gia hạn grant.
- Viết executor bình luận độc lập, autonomous operating loop mới hoặc sửa current-publish proof trong cùng đợt.
- Thay đổi giới hạn video/provider, CRM/ERP/Chat hoặc các scheduler không dùng tài nguyên Facebook này.

## 4. Kiến trúc được chọn

**Coordinator trong main process + worker một lượt + quyền giữ profile theo chủ sở hữu.** Không chỉ mở lại nút UI, vì backend vẫn chặn. Không tách thành dịch vụ bên ngoài, vì không có bằng chứng cần một runtime mới và sẽ thêm bài toán auth/DB/deploy.

### 4.1 Coordinator của các lượt poster

Một coordinator theo captured workspace/DB/generation quản lý tối đa hai worker. Tái sử dụng `FacebookPosterService` như worker một lượt thay vì biến toàn bộ field nội bộ của nó thành biến dùng chung cho nhiều lượt. Run store, task implementations, validation và event payload có runId được giữ lại.

Worker factory chỉ tạo dependencies đã bind đúng workspace. Recovery/prune/khởi tạo schema chạy ở lifecycle workspace như hiện tại, **không chạy lại cho mỗi worker**. Không để callback của worker cũ gọi singleton DB vừa đổi.

State phụ thuộc lượt trong composition cũng phải tách theo runId, không chỉ `active`: execution retirement hiện dùng `campaignExecutionRunId`, manual lead batch/AI state, kết quả và trạng thái lỗi. Khi dọn diagnostics, bảo vệ tất cả thư mục của các lượt sống, không chỉ lượt vừa tạo.

### 4.2 Quyền giữ profile

Một bộ điều phối tài nguyên dùng chung cho poster và các side services, với owner token nội bộ ràng buộc workspace generation, job/run ID và profile ID. Token không nhận từ renderer, HTTP payload hoặc dữ liệu research.

- Đăng ký người chờ/owner phải đồng bộ trước await; release/cancel chỉ tác động đúng token đã cấp. Callback cũ không được nhả khóa của chủ mới.
- Một profile plan giữ quyền suốt phần thao tác của nó, gồm các lần mở lại session trong cùng plan, cho tới khi mọi session đã đóng hoặc được xác nhận chấm dứt. Không giữ nhiều profile để chờ một bộ profile khác; từng plan chỉ yêu cầu profile của mình.
- Không nhả quyền giữa các bước đang dùng một phiên trình duyệt hoặc sau timeout đóng browser mà chưa biết phiên cũ đã kết thúc. Profile đó chuyển thành blocked với lý do cần xử lý; không ảnh hưởng profile độc lập.
- `BrowserProfileService` vẫn là kiểm tra cuối cùng về profile đang mở và giới hạn tổng. Tranh tài nguyên trước khi có effect được xử lý như chờ, không như lỗi đăng để retry. Lỗi auth, launch thực sự hoặc quyền stale không bị nuốt thành busy.
- Browser mở thủ công cũng chiếm tài nguyên; không tự đóng phiên của anh để nhường automation. Chọn profile rảnh trước nếu công việc cho phép lựa chọn; không tự đổi profile/Page đã bind của một lệnh ghi.
- Hàng chờ chỉ trong bộ nhớ, có thể hủy, tối đa **2 giờ** mỗi yêu cầu profile. Timeout trả lỗi chờ tài nguyên rõ ràng; không refresh thời điểm bắt đầu chờ qua mỗi lần thử. Số yêu cầu được chặn bởi hai poster workers, danh sách profile đã validate và giới hạn job hiện có của từng side service.
- Lịch đã đến hạn được ưu tiên trước background reads trên cùng tài nguyên; FIFO trong cùng nhóm ưu tiên. Không cướp session đang chạy và không chặn công việc dùng profile khác. Chờ quá hạn kết thúc tường minh, không treo vô hạn.
- Chỉ cấp lại lượt khi tài nguyên/capacity thay đổi hoặc đến hạn timeout, không thêm vòng poll dày hay vòng gọi AI.

Không đổi global busy thành luôn false. Global busy vẫn dùng để bảo vệ lifecycle; quyết định nhận/chạy việc dùng các điều kiện tài nguyên cụ thể.

### 4.3 Tác vụ không dùng browser

Soạn nội dung, quản lý nháp/lịch, đọc lịch sử, xem báo cáo và luồng video hiện có không lấy khóa profile. Chúng vẫn tuân theo validation, quyền, giới hạn của chính module đó. Không giữ transaction SQLite qua await hoặc qua thao tác browser/provider.

## 5. Luồng dữ liệu và vòng đời

1. Nhận request → kiểm quyền và workspace → validate → kiểm capacity của nhóm → chụp params riêng → tạo run như hiện tại → trả runId.
2. Mỗi profile plan đợi tài nguyên nếu cần. Progress giữ profile state `waiting`; lý do chờ là trường bổ sung, không giả đã mở browser hoặc đã đăng.
3. Khi được cấp: kiểm lại workspace/generation, cancel, quyền hiện hành và dữ liệu bắt buộc; rồi mở session. Giữ identity barrier và journal trước effect như đường hiện tại.
4. Kết quả/log/progress được ghi và phát theo đúng runId. Một worker kết thúc chỉ giải phóng state/resources của nó và đánh thức các việc đủ điều kiện.
5. Hủy khi chờ: xóa đúng waiter, không mở browser. Hủy khi chạy: giữ semantics graceful/critical/forced hiện tại; không biến uncertain-after-submit thành an toàn để gửi lại.
6. Restart: giữ cơ chế campaign journal recovery trước `failInterruptedRuns`. Hàng chờ profile thủ công không được hồi sinh tự động; run bị gián đoạn được đối soát theo cơ chế sẵn có. Lịch tiếp tục theo grace/missed/recovery hiện có, không chạy bù vô hạn.
7. Workspace switch/quit: khóa admission, hủy mọi waiter và owned job, drain toàn bộ worker/session/collector; chỉ đóng DB khi an toàn. Timeout giữ chuyển workspace/đóng DB bị chặn. Update check dùng tổng busy của tất cả công việc.

**Bất biến quyền:** nhiều profile cùng Page không nhân quota; grant revoked/expired, lease stale hoặc generation đổi trong lúc chờ phải được kiểm lại trước effect. Scheduler owner bypass không trở thành quyền cho autonomy. Kết quả effect đã xảy ra vẫn settle vào captured DB, kể cả quyền vừa bị thu hồi.

## 6. Scheduler và tương thích API

### Scheduler

Giữ `GRACE_MS=60000`, `QUEUE_MAX_WAIT_MS=7200000`, missed reasons và cách xử lý recurring/once hiện có. Pump xét các lịch còn hợp lệ và có thể nhận, không dừng toàn hàng chỉ vì một lịch tranh profile. Không nhận một lịch vào worker chỉ để chờ khi tất cả profile cần chạy của lịch đó đang bận; xét lịch khác có profile rảnh trước. Capacity hết thì giữ queued, không tiêu hao attempt hoặc tạo run giả. Kiểm campaign/authority/media/current state lại tại lúc nhận và ngay trước effect.

Nếu một lượt đã nhận phải đợi profile sau đó, deadline còn lại không được kéo dài quá cửa sổ chờ ban đầu của occurrence. Không dùng thời điểm bắt đầu chờ mới để vượt deadline của lịch.

### Control API và IPC

- Thêm `runs.active` và IPC tương ứng để lấy danh sách snapshot các lượt sống; trả `[]` khi không có. Mỗi snapshot tái dùng `{run, progress}` cùng ID hiện có, không thêm generic task protocol song song.
- Giữ `runs.current` và IPC current với response shape cũ: null khi rỗng, lượt duy nhất khi có một, khi có nhiều trả lượt bắt đầu sớm nhất (tie-break runId). Đây là compatibility view, không phải nguồn đầy đủ của UI mới.
- `runs.cancel` và IPC cancel nhận **optional `runId`**. Có ID thì chỉ hủy lượt đó; ID hợp lệ nhưng không tồn tại trong workspace hiện tại trả `NOT_FOUND`, không tìm sang workspace khác. Run đã kết thúc trả `cancelled:false`, không chuyển lệnh hủy sang run khác; `cancelled:true` chỉ xác nhận đã nhận yêu cầu hủy, không chứng minh browser/effect đã dừng. Bỏ ID: 0/1 lượt giữ hành vi cũ; từ 2 lượt trả `CONFLICT`/lỗi tương ứng trước mọi side effect và yêu cầu chọn lượt. Không ngầm biến lệnh cũ thành cancel-all hoặc hủy một lượt bất kỳ.
- Trạng thái zero/one giữ tương thích; trạng thái nhiều lượt là trường hợp mới và phải được mô tả rõ trong protocol/client help. UI mới luôn gửi runId lấy từ lựa chọn hiện tại.
- Giữ `runs.list`, `runs.get`, ID lịch sử, run statuses và event names. Event listeners lọc theo runId; một `runFinished` không xóa progress/log của lượt khác.
- Read/cancel mới dùng cùng validation, RBAC, captured request context, audit và idempotency như đường cũ; không tự xuất hiện trong filtered tool catalog của protected runner khi chưa có quyền. Không mở rộng quyền principal vì có API mới.
- Các side services tiếp tục dùng job ID và cancel/status riêng hiện có; không cần một public API mới cho mọi loại task.

Đây là thay đổi additive API với một tình huống cancel mơ hồ mới bị từ chối. Khi viết kế hoạch phải kiểm tất cả callers gồm preload, IPC types, ControlMethods, Python bridge và tests, không chỉ React.

## 7. Giao diện

- Composer chỉ disabled theo trạng thái gửi/lưu của chính form, dữ liệu không hợp lệ hoặc thao tác cụ thể không được phép; không disabled chỉ vì có run khác.
- Lưu nháp và hẹn lịch giữ validation hiện có. Một request đang gửi không cho double-submit; IPC/backend vẫn quyết định capacity/ownership, không tin cờ UI.
- Progress panel tái dùng kiểu hiển thị và tokens hiện có, thêm danh sách/chọn các lượt đang chạy hoặc chờ. Mỗi mục có loại việc, profile, trạng thái chữ, tiến độ và hủy đúng ID qua `showConfirm`.
- Giữ log tối đa 500 dòng **mỗi lượt**, và chỉ giữ cache của tối đa hai lượt sống cùng lượt đang được xem; đóng view giải phóng cache. Lịch sử lấy từ store, không tạo bộ nhớ log tăng vô hạn. Không trộn log do event đến xen kẽ.
- Chuyển tab/đóng composer không hủy job; cập nhật progress không ghi đè nội dung đang soạn. Reload view lấy lại danh sách active trước khi nhận event tiếp; reconciliation theo ID không tạo bản sao.
- Empty/loading/error state và lý do “Chờ profile …”/“Đã đạt giới hạn lượt chạy” rõ ràng. Keyboard/focus và nhãn trạng thái không chỉ dựa vào màu.
- Dùng `--poster-*`, typography/spacing/radius hiện có. Desktop và mobile, light/dark không tràn ngang toàn trang hoặc đè chữ; không thay layout toàn ứng dụng.

## 8. Ma trận nghiệm thu

Kiểm bằng service/SQLite thật và fake browser/provider boundary trong dev; không gọi Facebook/Claude/Telegram thật để chứng minh concurrency.

| Tình huống | Kết quả bắt buộc |
|---|---|
| Đăng A, sửa/lưu nháp B | B lưu được; params/text/media selection của A không đổi |
| Hai run khác profile | Cả hai tiến triển trước khi run kia kết thúc; log/result không lẫn |
| Đăng + research/check/learn/track/collect khác profile | Mỗi cặp có kiểm thử tiến triển đồng thời, giữ giới hạn riêng từng service |
| Hai job cùng profile, kể cả khác loại service | Chỉ một session điều khiển; job kia waiting và tiếp tục sau release |
| Join mở lại session trong một plan | Không có job khác chen vào cùng profile giữa các phase |
| 50 request tranh một profile | Không double-owner/double-browser; vượt capacity bị từ chối, không tạo run rác |
| Đạt 30 browser profiles tổng | Không mở profile thứ 31; giải phóng capacity đánh thức waiter hợp lệ |
| Hủy A trong khi B chạy | Chỉ A dừng; B tiếp tục và ghi kết quả đúng |
| Hủy lúc chờ/mở/đang critical | Không waiter rò rỉ; không mở session sau cancel; giữ uncertain semantics |
| Owner token cũ release sau owner mới | Không nhả khóa hoặc đóng session của owner mới |
| Close timeout nhưng browser chưa xác nhận kết thúc | Không cấp lại profile đó; profile khác vẫn dùng được |
| Lịch X đợi profile A, lịch Y dùng B rảnh và còn capacity run | Y chạy được; X giữ deadline và missed semantics |
| Grant/lease/quyền thay đổi trong lúc chờ | Không có effect dựa vào authority cũ |
| Hai profile cùng Page | Tổng quota Page không đổi, không nhân theo run/profile |
| Workspace switch khi nhiều job tồn tại | Không ghi vào DB mới; đợi mọi owned job hoặc chặn chuyển |
| Process restart ở chờ/trước submit/sau submit | Không tự gửi lại effect chưa xác định; không hồi sinh manual waiter |
| API zero/one/multiple runs | Shape cũ ở current; active đủ danh sách; cancel không ID từ chối mơ hồ |
| Legacy owner/manual/scheduler và protected campaign | Giữ validation, recurring/once, ownership, first-comment restriction, journaling và recovery |
| UI desktop/mobile × light/dark | Soạn/lưu/chọn lượt/hủy mượt, không đè chữ hoặc page overflow; focus và lỗi đọc được |

Hai stress-test rounds độc lập trước khi nhận hoàn tất; mỗi round gồm desktop và mobile ở hai theme. Chạy full Jest, bridge tests khi đổi protocol, cả hai TypeScript configs, docs-check, `make build`, `make test`, `make lint`. Thiếu Make targets vẫn là blocker, không dùng TypeScript thay cho build/lint. Review actual diff và regression của mọi đường tích hợp trước release.

## 9. Ranh giới file dự kiến và phát hành

- Core: `src/services/facebookPoster/FacebookPosterService.ts`, scheduler, coordinator mới trong cùng module, `BrowserProfileService.ts` và interfaces các side services dùng shared slot.
- Composition/lifecycle: `electron/ipc/facebookPosterIpc.ts`, `researchIpc.ts`, `workspaceIpc.ts` và callers update/quit liên quan. Chỉ sửa nơi cần thay global admission hoặc drain.
- Contracts: `src/services/control/ControlMethods.ts`, IPC/preload/type declarations, bridge adapter nếu cần theo contract additive; không đổi public identifier legacy chỉ để đổi tên.
- UI: `FacebookPosterView`, `PostTab`, `RunPanel`, `JoinTab`, `CommentsTab` và busy-state callers thực sự bị ảnh hưởng.
- Tests: các suite poster/research/browser/workspace/control/dailyBrief và UI hiện có; thêm test module coordinator thay vì dựng hệ test khác.
- Docs cùng thay đổi: `SYSTEM_DOCUMENTATION.md`, protocol, `DESIGN.md`, README và docs-check cho các giới hạn mới. Không tăng version trong đợt spec.

Dev → test/stress/review → build artifact → chỉ deploy khi được anh cho phép. Không chỉnh production trực tiếp, không migrate DB khách hoặc sửa config thật trong bước viết spec/triển khai dev. Rollback chỉ phần thay đổi của subproject; không reset dirty work khác và không bỏ journal/evidence đã ghi.

**Sau spec:** anh duyệt bản này → viết implementation plan chi tiết → duyệt plan trước code feature. Tiếp theo là spec chế độ tự vận hành dựa trên scoped runner/work claims/grants hiện có; bình luận độc lập và publish-proof/metrics vẫn có gate riêng. Không coi spec hiện tại là đã có chức năng tự vận hành hoặc bình luận độc lập.

## Ghi chú sau phát hành

Chưa phát hành. Khi triển khai có khác biệt được duyệt so với spec, bổ sung tại đây và cập nhật dòng Trạng thái; không viết lại thân thiết kế lịch sử.

**2026-10-31 — Task 8 (dev, chưa phát hành, chưa review cuối):**
- Close timeout: `postToTargets` chờ `ctx.close()` không giới hạn, nên khi browser chưa xác nhận đóng thì lượt giữ profile **và** một chỗ trong 2 lượt sống tới khi native exit (giới hạn 5 giây của `BrowserProfileService` chỉ bao lời gọi close của worker). Đúng nguyên tắc không nhả khi chưa biết phiên cũ đã kết thúc; profile khác vẫn chạy được nhưng capacity còn 1 lượt.
- Hai Page campaign đến hạn cùng lúc trước đây đều bị `LIMIT_EXCEEDED` (fail-closed, không đăng vượt): quota owner tính run autonomy của Page khác chưa `beginSubmit` thành effect owner. Đã sửa cục bộ `PageCampaignExecutionStore`: chỉ bỏ qua run đang chạy khi execution của nó thuộc Page/workspace khác, còn `reserved` và chưa bind runId; execution đã bị vô hiệu (`cancelled`), run cùng Page và owner run vẫn charge bảo thủ. Scoped review lần 1 yêu cầu thêm điều kiện `reserved` (tránh vượt quota khi lịch autonomy bị owner sửa) và unit test; đã bổ sung.
- Hai vòng randomized đầu (2707/New York, 3707/Hồ Chí Minh) mỗi vòng có 3 test đỏ trong `facebookPosterIpcWiring.test.ts` do fixture phụ thuộc thứ tự, không phải lỗi production. Controller duyệt sửa test-only (không bỏ/giảm assertion): worker generation hiện tại, profile deferral riêng, xóa lịch sót trong ba test scheduler thật, teardown nhóm PageLearner trả lại generation đang nhận việc. Fix-2: 131 suites/3391 tests xanh ở seed 2707, 3707, 1, 2, 3, 42, 9001, 123456 và thứ tự chuẩn. Fix-3 (review Task 8): ca IPC registry hết phụ thuộc mili giây (thêm ca trùng mili giây theo runId đúng spec); restart giờ kiểm occurrence owner once/recurring bị ngắt sau submit không bị bắn lại (đột biến re-arm làm đỏ); thêm ca hai profile cùng Page; ca "revoke khi chờ" thu hẹp thành đổi danh tính workspace, thu hồi grant/lease khi chờ chỉ có ở unit test. Kết quả cuối: hai vòng 131 suites/3395 tests xanh, thứ tự chuẩn xanh.
- B3/F7 (quit bị chặn khi browser không bao giờ xác nhận đóng): anh chọn phương án (a) ngày 2026-10-31. Quit bị chặn có thêm lựa chọn **Thoát ngay** sau xác nhận hai bước: hủy việc và yêu cầu đóng browser không chờ, đóng DB không retire, `app.exit(0)`; recovery lần mở sau giữ nguyên (run `running` → lỗi bị ngắt, `submitting` → `uncertain`, không gửi lại). Cập nhật không có lựa chọn này và chuyển workspace vẫn fail-closed.
- Nghiệm thu release vẫn BLOCKED: `make build/test/lint` không có target, chưa chạy `npm run production`/native rebuild/installer, chưa kiểm app Electron thật, OS quit hay Facebook live.

