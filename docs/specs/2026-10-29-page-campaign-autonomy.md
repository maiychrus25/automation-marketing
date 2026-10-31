# Thiết kế: Chiến dịch tự vận hành theo Page

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 29/10/2026 |
| Trạng thái | Phát hành trong 26.32.0 (31/10/2026) sau review local Tasks 1–8, broad review và sửa F1; quyền tự đăng thật vẫn tắt, nghiệm thu live chưa chạy |
| Kế hoạch | `docs/plans/2026-10-29-page-campaign-autonomy.md` |
| Phạm vi | Chiến dịch theo Page, uỷ quyền tự vận hành, đo tín hiệu quan sát được và điều chỉnh có bằng chứng |
| Nền khảo sát | `823db94`, cùng thay đổi local của Phase A; phiên bản local 26.32.0 chưa phát hành |
| Tiền đề | `docs/specs/2026-10-27-page-operations-foundation.md`, `docs/specs/2026-10-20-campaigns-variants.md` |
| Cách triển khai đã yêu cầu | Sau khi duyệt spec và kế hoạch: giao subagent triển khai theo task, review và kiểm chứng |

## Ghi chú triển khai local Task 8 trước final review — chưa phát hành

Giữ nguyên thân thiết kế lịch sử. Composition suite mới kiểm 28 cases ở hai seeds 2707/3707 với registry/SQLite/HTTPS/Python/scheduler thật và external boundaries giả lập; đây là characterization của hành vi đã có, không phải quyền live. Current-publish vẫn null/unconfirmed và autonomous first comment bị chặn; mẫu confirmed measurement/optimization là synthetic riêng. Hai full chuẩn 125 suites/3156 tests và Python 361 mỗi vòng; full randomized vẫn lỗi legacy `groupContactType:48`, Make/lint thiếu targets. Build scratch không phải packaging certification; UI không đổi. Tasks 1–7 chỉ qua continuation gates; Task 8/controller acceptance, runtime/live identity/collector/current-publish, receiver isolation/fresh-HOME auth, packaging còn blocked. Chưa triển khai bình luận độc lập hoặc ROI thực.

## Ghi chú sau final review — 29/10/2026, chưa phát hành

Task 8 qua spec/quality review local. Broad review phát hiện public receiver poll lỗi `KeyError: workId` với campaign events; đã sửa bằng phân loại hai campaign hint, giữ work/draft recovery, cursor và dedup. Có RED→GREEN unit/pinned HTTPS/public-poll, restart và mixed-event coverage; scoped re-review không còn finding trong diff sửa lỗi. Hai vòng sau sửa: matrix 29/29, full Jest chuẩn 125 suites/3157 tests, Python 363 mỗi vòng; TS/docs/diff exit 0. Controller kiểm chứng độc lập cùng kết quả. Full randomized mỗi seed vẫn 1 failed/3156 passed ở lỗi legacy đã nêu; Make mỗi lệnh exit 2. Không có nghiệm thu tổng thể, live proof hoặc quyền bật gate; các giới hạn trong dòng Trạng thái vẫn giữ nguyên, không viết lại thiết kế lịch sử bên dưới.

## 1. Mục tiêu và những gì chưa được coi là đã duyệt

Anh muốn MaiHub tự hiểu từng Page, tìm cơ hội, lập chiến dịch, chuẩn bị và thực hiện nội dung, theo dõi kết quả rồi điều chỉnh; không chỉ tạo nháp để khách xử lý từng bài. Anh cũng yêu cầu bình luận độc lập và đo doanh thu/ROI.

Yêu cầu đã rõ: **phạm vi tìm bài để bình luận không bị bó vào một danh sách bài, nhóm hoặc Page cố định**. Bot có thể tự phát hiện bài phù hợp trong phần Facebook mà danh tính được giao thực sự truy cập và bình luận được. Không yêu cầu khách đưa từng URL hoặc duyệt từng bình luận khi đã có uỷ quyền phù hợp. Đây là quyền khám phá mục tiêu, không phải quyền đăng vô hạn, giả danh, vượt checkpoint hoặc truy cập nơi bị hạn chế.

Bản này đặc tả hệ thống chiến dịch trước. Executor bình luận độc lập có vòng spec → kế hoạch → triển khai riêng, dùng chung liên kết chiến dịch và ranh giới quyền dưới đây; không được đánh dấu đã có chỉ vì chiến dịch hoạt động. Không yêu cầu cố định danh sách đích trong bản bình luận sau.

Ngày 27/10/2026 anh đã cho biết không có nguồn đơn hàng, doanh thu hoặc lợi nhuận. Chưa có nguồn thay thế: **ROI thực vẫn bị chặn bởi thiếu dữ liệu**, không thay bằng tương tác, trạng thái lead `won` hoặc số liệu do AI tự ước tính.

Toàn bộ lựa chọn kỹ thuật, giá trị mặc định và thuật toán dưới đây là **đề xuất của bản spec để duyệt**, không phải hạn mức anh đã chốt hoặc tính năng đang chạy.

## 2. Cách làm và phạm vi

Mở rộng campaign/draft/scheduler/research/lead cùng nền Page Operations hiện có. Không viết lại nền tảng agent, không tạo scheduler thứ hai và không thêm dependency nếu khả năng hiện có đáp ứng.

**Trong đợt này:**
- Chiến dịch gắn đúng một Page trong một workspace, tồn tại qua nhiều công việc hằng ngày.
- Chủ Page uỷ quyền một lần theo phạm vi và thời hạn; bot tự tạo nội dung và lịch trong quyền đó. Chế độ duyệt từng bài vẫn tồn tại.
- Đăng bài lên chính Page được giao; dùng ảnh/video có sẵn mà luồng media hiện tại xác nhận còn hợp lệ.
- Đo phản hồi công khai thực thu được cho bài Page, liên kết lead có bằng chứng, lưu lý do điều chỉnh.
- Tạm dừng, thu hồi quyền, khôi phục sau crash và báo cáo Telegram qua luồng hiện có.

**Ngoài đợt này:** bình luận độc lập/trả lời tiếp, inbox tự động, cảm xúc/chia sẻ/lời mời theo dõi, quảng cáo trả phí, tự render video có phí, tự giảm giá, quản lý đơn hàng, dashboard mới và nguồn nghiên cứu ngoài Facebook. Không sửa Make/lint hoặc cấu hình production như công việc kèm theo.

Bình luận đầu tiên của bài do MaiHub vừa đăng tiếp tục theo validation hiện có; nội dung này phải nằm trong phiên bản bài được uỷ quyền. Không biến chức năng đó thành executor bình luận bên ngoài.

## 3. Điểm mở rộng và trách nhiệm

| Thành phần hiện có | Dùng lại | Phần cần bổ sung |
|---|---|---|
| `src/models/facebookPoster.ts`, `campaignOperations.ts`, `FacebookPosterStore.ts` | Campaign CRUD, trạng thái, lịch và kết quả | Liên kết Page–campaign và bảo vệ các đường truy cập campaign được quản lý |
| `src/models/pageOperations.ts`, `PageWorkStore.ts`, `pageWorkOperations.ts` | Context, claim/lease, daily budget, effect journal, revision | Tham chiếu campaign qua nhiều work; quyết định tự vận hành có nguồn uỷ quyền |
| `controlAuthorization.ts`, `ControlMethods.ts`, trusted receiver | Phân quyền runner/receiver, ticket, kiểm trước cache | Method hẹp cho campaign; grant/revoke từ chủ Page, không mở toàn bộ `campaigns.*` |
| `FacebookPosterScheduler`, luồng promote draft/đăng bài | Một bộ thực thi, validation và browser-job slot chung | Kiểm grant khi tạo lịch, khi lấy khỏi hàng chờ và ngay trước effect |
| Research, `postTracking.ts`, `bestTimes.ts`, lead store | Nguồn post, snapshot, so sánh hiện có | Đường đo bài Page và báo cáo có provenance, coverage, unknown |
| Python bridge/runner/receiver, Telegram | Truyền tool, chạy lượt, thông báo | Công cụ đúng scope và tóm tắt quyết định; không trao bí mật receiver cho runner |

Bot đề xuất và lựa chọn trong phạm vi được cấp. MaiHub xác thực danh tính, dữ liệu, giới hạn, revision và thực thi; lời giải thích của bot không thay thế kiểm tra ở máy chủ. Nội dung Facebook/research là dữ liệu không tin cậy, không được làm thay đổi quyền, tools hoặc chính sách.

## 4. Campaign thuộc Page, không thuộc một lượt chạy

Campaign hiện tại chưa có `pageId`. Ownership của Phase A lại gắn tài nguyên với `workId` bất biến; không thể chuyển campaign của hôm trước sang work hôm nay bằng cách ghi đè owner.

Thiết kế bổ sung liên kết bền vững `workspaceId` + `pageId` + `campaignId`, có `revision` và dấu nhận biết campaign được quản lý tự động. Một campaign được quản lý chỉ thuộc một Page; không dùng tên campaign/Page làm khoá. Liên kết không mất khi dọn work kết thúc sau 30 ngày.

- Tạo campaign mới và liên kết Page trong cùng transaction; retry cùng ý định trả về cùng campaign. Không để lại campaign mồ côi khi lỗi giữa hai bước.
- Nếu có owner tài nguyên theo work, giữ nguyên owner đó. Các work sau tham chiếu campaign qua liên kết Page đã xác thực, **không** gọi lại `linkResource` để chiếm/chuyển owner.
- Quyền tham chiếu campaign không cho phép sửa draft/media/video thuộc work khác. Chỉ nới quy tắc tham chiếu campaign ở đúng service chuyên biệt; không nới bộ kiểm ownership chung.
- Không tự nhận campaign legacy làm campaign tự động, không tự gắn dữ liệu lịch sử theo tên hoặc URL gần giống. Campaign thủ công cũ giữ hành vi và báo cáo cũ.
- Các đường CRUD/IPC/Control API cũ vẫn kiểm campaign được quản lý: không cho runner dùng API tổng quát để né phạm vi. Lệnh thủ công hợp lệ của chủ được giữ, nhưng thay đổi mục tiêu, Page/profile, thời hạn hoặc nội dung ngoài phạm vi grant làm vô hiệu quyền tự động tương ứng.
- Tạm dừng/lưu trữ campaign không xoá lịch sử. Xoá vẫn chịu điều kiện tài nguyên liên quan của store hiện có; giữ provenance cần để giải thích kết quả cũ, không để ID tái sử dụng nhận quyền cũ.

## 5. Uỷ quyền và quyền tự vận hành

### 5.1 Grant do chủ Page xác nhận

Thêm quyết định uỷ quyền qua trusted receiver; dùng ticket gắn đúng đề nghị/revision và người gửi đã xác thực. Grant giữ `id`, `workspaceId`, `pageId`, `profileId`, `campaignId`, `revision`, `startsAt`, `expiresAt`, `status`, tập hành động, hạn mức và tham chiếu xác nhận từ máy chủ. Runner chỉ đọc phần cần thiết, không thấy ticket hoặc bí mật xác nhận.

Đề nghị cho chủ phải diễn đạt rõ: Page nào, mục tiêu nào, bot được tự làm gì, thời hạn, trần đăng, khung giờ và cách dừng. Không cần khách đọc JSON. Nói “ok” ngoài một đề nghị được ràng buộc không tạo grant.

Với campaign mới, đề nghị có `proposalId`/revision và nội dung đầy đủ nhưng chưa tạo campaign chạy. Khi chủ xác nhận, trusted receiver tạo campaign, liên kết Page và grant trong cùng transaction, ràng buộc ticket với kết quả để replay trả lại cùng ID. Như vậy không cần một grant trỏ tới campaign chưa tồn tại. Với campaign được quản lý đã có, gia hạn gắn ID/revision hiện tại. Runner không tự tạo campaign thứ hai dưới grant của campaign thứ nhất.

**Mặc định đề xuất:** chế độ tự động tắt; đề nghị đầu tiên kéo dài 7 ngày, tối đa 1 bài/ngày và 7 bài cho cả grant, không vượt giới hạn thấp hơn đã có của daily brief. Lập lịch một lần cho tối đa 7 ngày tới và không ngoài hạn grant. Thời gian dùng cùng quy ước giờ địa phương của daily brief hiện tại; grant ghi nhận múi giờ tại lúc xác nhận, thay đổi múi giờ máy làm tạm dừng tự động để tránh đổi ngày quota âm thầm. Không thêm lịch lặp vô thời hạn.

Gia hạn hoặc tăng quyền phải được chủ xác nhận; bot không tự gia hạn. Các giá trị này là cấu hình đề nghị pilot, không có nghĩa Facebook cho phép một mức hoạt động cụ thể.

### 5.2 Phân quyền có điều kiện, không giả duyệt của chủ

| Thao tác | Runner khi không có grant tự động hiệu lực | Runner khi có grant hiệu lực |
|---|---|---|
| Đọc/đề xuất, research, tạo nháp | Theo quyền Phase A và gate hiện có | Giữ nguyên giới hạn |
| Kích hoạt/cập nhật campaign riêng của Page | Chỉ lưu đề nghị; chủ xác nhận việc tạo campaign/grant | Chỉ campaign và mục tiêu đã được cấp |
| Chuyển nháp sang lịch một lần | Không; chờ chủ duyệt như cũ | Được nếu mọi kiểm tra ở §5–6 đạt |
| Sửa lịch/nội dung tự động chưa thực hiện | Không tự sửa lịch đã duyệt | Chỉ lịch do grant quản lý, trong revision và quota |
| Duyệt với danh nghĩa chủ, cấp quyền, đổi hồ sơ xác nhận | Không | Không |
| Bình luận độc lập, chi tiền, gửi CRM/inbox | Không | Không trong spec này |

Máy chủ ghi nguồn quyết định là `autonomy`, kèm grant/revision và dấu vân tay nội dung/đích/thời gian; không tạo chứng cứ giả rằng chủ đã duyệt từng bài. Bài do chủ duyệt riêng giữ nguồn `owner` và quy tắc cũ.

`protectedWritesEnabled` vẫn là gate bắt buộc và giữ `false` trong phát triển. `setEnabled` của Phase A không tự biến thành grant. Chế độ tự động không được khởi chạy bằng khoá legacy toàn quyền. Thiếu cách ly receiver/runner hoặc thiếu xác thực tích hợp thì chỉ đọc/đề xuất, không mở quyền đăng.

## 6. Vòng thực thi và bảo vệ side effect

Luồng: **đọc hồ sơ xác nhận → chọn campaign → research → chuẩn bị nháp/media → kiểm quyền và nội dung → giữ quota/tạo lịch → thực thi → thu bằng chứng → cân nhắc điều chỉnh**.

- Dùng cùng daily brief/runner và browser-job slot; không tăng ba lượt agent/ngày/brief, không tạo lượt riêng để né giới hạn. Các campaign của cùng Page chia sẻ quota, không nhân quota theo campaign/profile/work.
- Nội dung cần giá, cam kết, vùng phục vụ hoặc khả năng đáp ứng chưa được xác nhận thì chuyển chờ chủ, không tự bịa. Grant không biến hypothesis thành fact.
- Mọi ảnh/video phải thuộc scope hợp lệ; chờ job có sẵn và đối soát như Phase A. Không tự tạo render có phí trong quyền này.
- Tạo lịch giữ quota nguyên tử theo Page/ngày dự kiến và grant; khi thực thi kiểm thêm ngày thực tế. Lịch trễ không được dồn bù để vượt trần ngày mới. Lịch của các grant đang hiệu lực cùng Page bị tính chung; lịch chủ đã đặt được tính vào chỗ còn trống nhưng không bị sửa/huỷ để nhường chỗ.
- Lịch bị huỷ trước effect được trả reservation đúng một lần. Effect đã gửi nhưng chưa rõ kết quả giữ reservation; retry không được giải phóng quota để đăng lại. Reservation và kết quả bền vững qua restart.
- Kiểm key, grant, context `workspaceId/dbPath/generation`, Page/profile, revision và ownership trước cache, sau await và tại hàng rào cuối trước gửi. Snapshot quyền lúc tạo lịch không đủ cho lúc thực thi.
- Không dùng `drafts.approve` với `confirm: true` để giả quyền chủ. Đường tự động gọi cùng nghiệp vụ promote/đăng đã được kiểm tra nhưng có nguồn quyền riêng và đóng với runner không có grant.
- Quyết định/work/effect có key ổn định. Crash trước effect có thể thử lại theo lease; crash sau gửi nhưng chưa xác nhận chuyển `uncertain`, đối soát qua ID/bằng chứng. Không hứa exactly-once từ Facebook nếu không có cách xác nhận.
- Sai Page, đăng xuất, checkpoint, quyền bị thu hồi hoặc nội dung không còn hợp lệ: dừng ở điểm an toàn, báo lý do; không xoay tài khoản/profile để né hạn chế.

Chủ có thể dừng qua Telegram. Thu hồi grant chặn claim/effect mới và vô hiệu lịch tự động chưa gửi; không huỷ lịch độc lập có nguồn `owner`. Request đã gửi sang Facebook không thể bảo đảm thu hồi: giữ kết quả/uncertain và thông báo rõ, không tự xoá bài như một thao tác bù.

Tạm dừng campaign cũng chặn đăng ngay qua đường tự động, dù luồng thủ công legacy có quy tắc đăng ngay riêng. Resume không chạy bù lịch đã lỡ; chỉ xét lịch tương lai còn quyền. Thay profile/Page không tự chuyển grant.

## 7. Đo được gì và không đo được gì

Nhánh theo dõi hiện tại chỉ tạo tracking cho bài nhóm đăng thành công. Đợt này phải bổ sung đường theo dõi **bài Page có ID/URL được xác nhận**, không chỉ mở báo cáo cũ rồi gọi đó là Page Insights.

Mỗi quan sát lưu Page/campaign/post, nguồn, `observedAt`, thời điểm đăng nếu biết, tuổi bài, từng chỉ số có thể `null`, và trạng thái thu thập. Dùng dữ liệu cấu trúc đã parse qua research/tracking; không lưu HTML thô, cookie hoặc token. Runner không được tự nộp số liệu rồi coi là snapshot đã đo.

- Reactions/comments/shares chỉ có giá trị khi nguồn thực trả về; không đọc được phải là unknown kèm lý do.
- Khi thiếu thành phần, tổng tương tác dùng để so sánh cũng unknown; không cộng phần biết rồi trình bày như tổng đầy đủ.
- Reach, impressions, clicks, follower growth hoặc conversions không được hiển thị là đã đo nếu chưa có nguồn tương ứng. Không gọi số tương tác chia cho lượt xem không tồn tại là engagement rate.
- Lead chỉ gắn campaign khi có đường post ID/URL chuẩn hoá đã xác minh tới kết quả campaign. Không đoán liên kết từ từ khoá/tên khách. Đếm mã lead duy nhất theo quy tắc store; số lead không phải số đơn.
- Báo cáo ghi số bài đã đăng, số bài đo được/tổng bài đủ tuổi, kỳ đo, thời điểm cập nhật và lý do thiếu. Không trộn Page với nhóm, bài organic với quảng cáo hoặc các cửa sổ tuổi bài khác nhau.
- Bài xoá, quyền đọc mất, parser không đủ bằng chứng hoặc snapshot lỗi vẫn giữ dấu vết và trạng thái thiếu; không âm thầm bỏ khỏi mẫu để làm tỷ lệ đẹp hơn.

Dùng các mốc snapshot 60/1.440/4.320 phút của tracking hiện có khi phù hợp. Bài Page chưa có collector kiểm chứng được thì báo cáo giữ unavailable và tối ưu bị khoá; đây là tiêu chí nghiệm thu chưa đạt, không phải đã hoàn thành bằng mock.

## 8. Điều chỉnh tăng trưởng có bằng chứng

Đợt đầu dùng quy tắc nhỏ, kiểm thử được thay vì engine tối ưu tổng quát. Bot có thể đề xuất nội dung theo hồ sơ/research, nhưng chỉ được gọi là điều chỉnh từ hiệu quả đã đo khi có dữ liệu đạt điều kiện:

1. Cùng Page/campaign, cùng định dạng và cùng mốc đo 4.320 phút; lấy các quan sát hợp lệ trong 28 ngày gần nhất. Snapshot thực thu trong khoảng tuổi 72–96 giờ mới dùng cho so sánh này; ngoài khoảng vẫn hiển thị trong báo cáo nhưng không coi là cùng mốc.
2. Mỗi lựa chọn cần ít nhất 5 bài có đủ reactions/comments/shares và coverage tối thiểu 80% trong tập bài đã đủ tuổi. Đây là ngưỡng vận hành đề xuất, không phải bảo đảm ý nghĩa thống kê.
3. Xếp hạng bằng trung bình tổng tương tác thực đo mỗi bài. Điểm bằng nhau hoặc thiếu dữ liệu thì giữ cách phân bổ/khung giờ hiện tại; không chọn thắng bằng ID hoặc ngẫu nhiên mà báo là kết luận dữ liệu.
4. Chỉ đổi **một yếu tố** cho lượt kế tiếp: ưu tiên biến thể nội dung nếu có so sánh hợp lệ; nếu không thì khung giờ trong các giờ chủ đã cho phép. Không đồng thời đổi nội dung và giờ rồi kết luận nguyên nhân.
5. Không tăng số bài, chi phí hoặc mở thêm Page/đích từ kết quả này. Không sửa bài đã đăng, lịch do chủ duyệt hoặc lịch đã tới bước effect.

Lựa chọn nội dung dùng biến thể A–E và validation hiện có; bổ sung vận chuyển qua nháp scoped nếu cần, không mở API nháp toàn workspace. Nội dung của một lựa chọn đổi thì mang revision mới, không gộp mẫu cũ vào tên A–E tái sử dụng. Khung giờ và biến thể thực đăng được chụp cùng run/result; không phân nhóm lịch sử bằng cấu hình hiện tại.

Mỗi quyết định ghi yếu tố đổi, giá trị trước/sau, snapshot/bài nguồn, cỡ mẫu, coverage, quy tắc áp dụng và grant/revision. Thay đổi có thể được hoàn lại cho lịch tương lai; không viết lại lịch sử số liệu.

Pilot mặc định 7 bài có thể **chưa đủ mẫu** để so sánh hai lựa chọn. Khi đó bot vẫn vận hành chiến dịch nhưng báo “chưa đủ dữ liệu để điều chỉnh”, không tự gia hạn pilot hoặc hạ ngưỡng. Các lần gia hạn được chủ duyệt có thể tiếp tục thu mẫu trong campaign đó.

Đây là học từ quan sát, không phải thử nghiệm ngẫu nhiên chứng minh nhân quả, cam kết tăng trưởng hoặc mô hình tối ưu doanh thu.

## 9. Báo cáo, tài chính và dữ liệu nhạy cảm

Telegram dùng luồng thông báo hiện có, có ID chống gửi lặp. Tóm tắt: campaign/Page, việc đã làm và đang chờ, số liệu có coverage, thay đổi tiếp theo, quyền còn hiệu lực và lý do bị chặn. Không tạo dashboard/UI mới trong đợt này.

Khi anh hỏi doanh thu/ROI, trả trạng thái “chưa đo được — chưa có nguồn đơn hàng/chi phí có thể quy thuộc”. Không ép khách nhập đơn thủ công trái quyết định đã chốt. Không ghi 0 doanh thu hoặc 0% ROI để thay cho unknown; không triển khai adapter tài chính giả để đánh dấu đủ tính năng.

Nếu sau này có nguồn giao dịch/chi phí, cần spec riêng về nguồn, quyền truy cập, tiền tệ, hoàn/huỷ đơn, quy thuộc campaign, kỳ đo và công thức ROI. Số liệu đó không tự xuất hiện từ việc bật campaign autonomy.

Audit chỉ giữ dữ liệu cần để kiểm tra quyết định, ID và tham chiếu nguồn; không nhân bản hội thoại/PII không cần thiết. Không lưu/log cookie, token hoặc HTML thô trong facts, work, audit, test hay Telegram. Nguồn đã hết hạn phải hiện không còn bằng chứng; không dựng lại dữ liệu đã bị xoá.

## 10. Tương thích, dữ liệu và rollback

- Chỉ bổ sung schema theo cơ chế migration hiện có khi triển khai dev; không chạy migration trên database khách trong task này. Không đổi identifier/API legacy chỉ để chuẩn hoá tên.
- Không đổi mặc định/quyền của campaign và lịch thủ công cũ. Mọi hành vi bị siết thêm chỉ áp dụng tài nguyên đã được chủ chọn vào phạm vi bảo vệ mới.
- Không chuyển owner tài nguyên Phase A, không xoá khoá legacy, không đổi version/dependency ngoài task được duyệt.
- Tắt chế độ mới giữ được nháp, báo cáo và lịch sử; không xoá cột/bảng để rollback. Hạ binary về phiên bản không hiểu grant **không được coi là rollback an toàn**: phải dừng/vô hiệu lịch tự động trước, giữ bằng chứng và kiểm tương thích schema.
- Cập nhật `SYSTEM_DOCUMENTATION.md`, protocol và bridge README cùng thay đổi hành vi lúc triển khai; giữ thân spec lịch sử, cập nhật Trạng thái/Ghi chú sau phát hành khi thực sự đạt mốc.

## 11. Tiêu chí nghiệm thu và bằng chứng

Triển khai theo TDD và kiểm lại diff thật. Kiểm thử local dùng database tạm, clock/receiver/provider giả có kiểm soát; không gọi Facebook, Telegram, Claude hoặc video thật khi chưa có cho phép riêng.

| Nhóm | Ca bắt buộc |
|---|---|
| Ownership | Một campaign dùng qua nhiều work cùng Page; owner cũ không đổi; không truy cập chéo Page/workspace; prune work không mất campaign link; campaign legacy không bị tự nhận |
| Grant | Mặc định off; runner không tự cấp/gia hạn; giả `confirm`/owner/source bị từ chối; grant hết hạn/thu hồi/sai revision; scope lọc cả describe/events/cache/report |
| Lịch và quota | Hai worker/campaign tranh chỗ; reservation nguyên tử; sửa/huỷ/retry không nhân quota; đổi ngày/múi giờ; lịch trễ; không đẩy lịch chủ ra ngoài; pause/resume không đăng bù |
| Race và recovery | Thu hồi/đổi workspace A→B→A khi await/queue/effect; crash trước/sau gửi; stale lease/completion; uncertain không đăng lại mù; thiếu event vẫn đối soát được |
| Đo lường | Tracking cho bài Page thành công; null khác zero; sai ID/tuổi bài; thiếu quyền/parser lỗi/bài xoá; thiếu metric/coverage chặn tối ưu; lead không biến thành đơn |
| Điều chỉnh | Đủ/thiếu mẫu, hoà điểm, coverage biên; một yếu tố/lượt; không đổi bài/lịch ngoài quyền; thiếu dữ liệu giữ kế hoạch; mọi quyết định có provenance |
| Hồi quy | Campaign CRUD/pause/archived, nháp duyệt tay, lịch một lần/lặp, variants, nhóm tracking, first comment, collector/leads, daily brief/lease/facts, video/media, khoá/pairing/bridge/receiver |

Chạy hai vòng stress/recovery, toàn bộ test hiện có và `node scripts/check-docs.js`; thử `make build`, `make test`, `make lint` và báo đúng đầu ra. Các target Make hiện thiếu là blocker đã biết, không gọi typecheck là lint hoặc Vite build là installer. Không bỏ/sửa yếu assertion để cho test xanh. Nếu phát sinh UI trong kế hoạch, mỗi vòng phải có desktop/mobile, light/dark và kiểm overflow/focus/action theo `DESIGN.md`.

Local tests không chứng minh Facebook thật, receiver isolation hoặc package chạy đúng. Phát hành chỉ qua dev → test dev → build artifact/image → deploy khi được cho phép. Giữ `protectedWritesEnabled=false` cho tới khi tích hợp danh tính/receiver, packaging và kiểm thử live được phê duyệt riêng.

## 12. Thứ tự bàn giao

1. Anh duyệt bản spec này; chưa giao implementer trước mốc này.
2. Viết kế hoạch với task, file cụ thể, interface và test; anh duyệt kế hoạch. Cách thực thi bằng subagent đã được anh chọn, không hỏi lại lựa chọn đó.
3. Subagent triển khai từng task độc lập về trách nhiệm; controller review spec/quality, xử lý lỗi, kiểm chứng hai vòng và đối chiếu diff. Không cho nhiều writer sửa chung module đồng thời.
4. Hoàn tất bản local của chiến dịch, ghi riêng phần còn blocked; không nhận là đã phát hành.
5. Thực hiện vòng thiết kế riêng cho bình luận độc lập, giữ **khám phá mục tiêu mở**, danh tính thật, quyền truy cập thực, nội dung có ngữ cảnh, chống trùng và điều kiện dừng. Không biến danh sách URL cho sẵn thành điều kiện sử dụng.
6. ROI tiếp tục ghi thiếu nguồn cho đến khi có đầu vào tài chính thật và hợp đồng đo lường được duyệt.

Không stage/commit/push/deploy, bật gate, cài timer, sửa Downloads hoặc khởi chạy hoạt động ngoài hệ thống dev như hệ quả tự động của việc duyệt bản thiết kế.

## Ghi chú sau thiết kế

- **29/10/2026:** Anh yêu cầu “bắt đầu đi” sau khi nhận bản spec, chuyển sang bước lập kế hoạch tại §12.2. Thân spec được giữ nguyên như bản đã trình; các đề xuất trong đó nay là cơ sở của kế hoạch, không phải quyền bật tự động trên Page thật. Kế hoạch cần được duyệt trước khi giao subagent triển khai.
- **29/10/2026, sau khi nhận kế hoạch:** Anh yêu cầu “bắt đầu đi”, duyệt kế hoạch để triển khai local theo task bằng subagent. Phê duyệt này không bao gồm commit/push/deploy, bật gate hoặc thử nhà cung cấp thật.
