# Bằng chứng bài đã đăng, số liệu Page và chính sách thông báo

**Ngày:** 2026-10-31  
**Trạng thái:** Spec đã được anh duyệt ngày 31/10/2026; [implementation plan](../plans/2026-10-31-page-publish-proof-metrics.md) anh duyệt cùng ngày. Đã triển khai (2026-10-31), phát hành trong 26.34.0 (03/11/2026; bản 26.33.0 bị huỷ ở CI trước khi phát hành); chưa kiểm trên app Electron/Facebook thật, số người theo dõi chưa đọc được (chờ mẫu phản hồi thật). Chỗ code khác spec: mục 11.  
**Phạm vi:** Sub-project A của lộ trình sau 26.32.0. Là nền cho bật chạy thật có kiểm soát (B), vòng AI tự vận hành (C) và bình luận đầu cho bài bot đăng.  
**Nguồn thiết kế UI:** `DESIGN.md`, bộ token `poster` và màn "Hiệu quả" hiện có.

## 1. Mục tiêu và ý định

Sau mỗi bài đăng lên Page **qua app**, app phải biết chắc bài đã lên, có ID/link đúng của Page đó, đo được tương tác theo thời gian và ghi số người theo dõi Page theo ngày. Số liệu phục vụ hai người dùng (anh chọn cả hai):

- **Bot/AI tự học:** chiến dịch Page nhận số liệu thật thay vì `unavailable`, để điều chỉnh dạng bài và giờ đăng.
- **Anh tự xem:** trong màn "Hiệu quả" của app và qua báo cáo Telegram có lịch chỉnh được bằng cách nhắn bot.

Cùng đợt, sắp xếp lại thông báo Telegram để không spam và dễ nhận diện từng loại (anh yêu cầu ngày 31/10/2026).

**Tiêu chí thành công:** bài Page đăng qua app có trạng thái link rõ ràng (đã có / đang tìm / không tìm thấy); số liệu chỉ ghi từ bài đã xác nhận; không ghi số 0 giả hay đoán bài; mỗi kỳ báo cáo đúng một tin; tin khách tiềm năng được gom; mỗi loại tin có nhãn riêng.

## 2. Hiện trạng đã kiểm tra trong mã

| Thành phần | Hiện tại | Khoảng trống |
|---|---|---|
| Bắt link lúc đăng (`postToTargets.ts:777-797`, `:904-906`) | Nghe phản hồi GraphQL của mutation tạo bài, tối đa 8.000 ms | Bài đăng có `autonomyGuard` luôn trả `postUrl:null` (`:911-916`); không xác minh chủ bài là Page |
| Dòng theo dõi (`FacebookPosterService.ts:602-630`) | Tạo cho bài nhóm, trạng thái `known` / `missing` / `pending_approval` / `not_found` | Dừng ngay khi `mode !== 'group'` (`:605`) |
| Lịch tìm lại link (`postTracking.ts:18`) | `linkRetryMinutes` 30, 120, 360, 1440, 2880, 4320, 10080 phút | Chỉ áp cho bài nhóm |
| Mốc đo (`postTracking.ts:19`) | `statsAtMinutes` 60, 1440, 4320 phút, lưu `fb_poster_post_stats` | Chỉ bài nhóm |
| Đọc bài Page (`pageIdentity.ts:160-200`) | Đọc feed Page dưới vai trò Page: nội dung, giờ, link, reaction, bình luận, chia sẻ; tối đa `MAX_POSTS = 10` | Bỏ `post_id`; không đọc số người theo dõi |
| Số liệu chiến dịch (`PageCampaignExecutionStore.ts:139`, `PageCampaignStore.ts:143-170`) | `registerPostedResult(execution)` không kèm target nên luôn `unconfirmed_post_target` | Chưa có nơi gắn bài đã xác nhận vào lượt chiến dịch |
| Thông báo (`tools/maihub-bridge/maihub_bridge.py` `format_event`) | ✅/⚠️/⏹ lượt đăng, ⏰ lỡ lịch, 🔒 đăng nhập, 📈 mỗi lượt theo dõi, 🎯 mỗi lượt thu bình luận, 🎬 video, 📝 đề xuất | ⚠️ dùng chung cho 3 loại lỗi; 📈 và 🎯 gửi theo từng lượt chạy nền |

## 3. Phạm vi kết quả

### Phải đạt
1. Bài Page đăng qua app (đăng tay chế độ Page, lịch đăng, chiến dịch) được bắt ID ngay lúc đăng, **chỉ nhận khi chủ bài là đúng Page đang đăng**.
2. Bài Page có dòng theo dõi dùng chung bảng, lịch tìm lại link và mốc đo với bài nhóm.
3. Bài chưa có link được tìm lại trên Page theo lịch 30 phút → 7 ngày; chỉ xác nhận khi khớp **đúng một** bài.
4. Số liệu reaction / bình luận / chia sẻ ở mốc 1 giờ, 1 ngày, 3 ngày cho bài Page đã xác nhận.
5. Số người theo dõi Page ghi tối đa một lần mỗi ngày, ghép vào lượt mở Page sẵn có.
6. Lượt chiến dịch nhận bài đích đã xác nhận; lượt `uncertain` tìm thấy đúng bài thì thành `posted`, không bao giờ đăng lại.
7. Màn "Hiệu quả" hiển thị bài Page, trạng thái link, ô người theo dõi và lịch báo cáo.
8. Control API cho bot đọc số liệu và cho owner đổi lịch báo cáo, khoảng gom tin khách.
9. Báo cáo 📊 theo lịch tắt / ngày / tuần, mỗi kỳ đúng một tin.
10. Chính sách thông báo: bỏ 📈 theo từng lượt, nhãn ⚠️ riêng từng loại, gom 🎯 theo khoảng.

### Không thuộc đợt này
- Bài đăng thẳng trên Facebook ngoài app.
- Mở thẳng link bài đã trôi khỏi danh sách gần đây để đọc số liệu.
- Bật `protectedWritesEnabled`, live pilot, bình luận đầu cho bài bot đăng (sub-project B).
- Vòng AI tự vận hành (C), bình luận độc lập (D).
- Doanh thu/ROI; tương tác giả hoặc nuôi profile.
- Đổi cách theo dõi bài nhóm ngoài phần dùng chung bảng.

## 4. Kiến trúc được chọn

Mở rộng bộ theo dõi bài nhóm sẵn có sang bài Page (hướng 1, anh chọn). Một cơ chế lịch, lưu trữ và trạng thái duy nhất; thêm bộ đọc nguồn Page. Hai hướng đã loại: bộ theo dõi Page riêng qua "Nghiên cứu theo link" (hai cơ chế song song, đường tìm theo link chưa được kiểm chứng trả đúng bài của Page) và chỉ đọc số liệu mỗi ngày lúc học Page (không có mốc 1 giờ, không tìm lại link theo lịch).

### 4.1 Bắt link lúc đăng
- Bỏ nhánh trả `postUrl:null` cho bài có `autonomyGuard`.
- Với `mode === 'page'`, ID chủ giải từ phản hồi mutation (`S:_I<owner>:<post>` hoặc `owner_id`) phải bằng `pageId` của profile trong scope lượt đăng. Không khớp, thiếu chủ hoặc phản hồi lạ thì coi như chưa có link (`missing`), không ghi URL.
- Không thay đổi đường bắt link của bài nhóm.

### 4.2 Dữ liệu
- `fb_poster_post_tracking` thêm `target_kind TEXT NOT NULL DEFAULT 'group'` (`group` | `page`) và `page_id TEXT NOT NULL DEFAULT ''`. Dòng cũ tự là `group`. Với bài Page, `group_url` giữ URL đích hiện có của kết quả (không đổi nghĩa cột với bài nhóm).
- Bảng mới `fb_poster_page_followers(id, page_id, profile_id, captured_on TEXT /* YYYY-MM-DD giờ địa phương */, captured_at INTEGER, followers INTEGER)`, unique `(page_id, captured_on)`.
- Cấu hình thông báo lưu trong settings của workspace (cùng cách `readTrackingConfig`): `{ reportCadence: 'off'|'daily'|'weekly', reportHour: 0–23, reportWeekday: 1–7, leadDigestMinutes: 0|15|30|60|120|240 }`; mặc định `weekly`, 8 giờ, thứ Hai, 60 phút. `0` phút nghĩa là gửi ngay như trước.
- Trạng thái kỳ báo cáo đã phát (`lastReportPeriod`) và hàng chờ khách tiềm năng chưa báo được lưu bền trong DB, để khởi động lại không mất hay gửi trùng.
- Chỉ thêm cột/bảng qua `ensureSchema` hiện có; không xóa hay sửa dữ liệu cũ.

### 4.3 Bộ đọc Page
- `pageIdentity` giữ `post_id` trong mẫu bài (`PagePostSample.postId`) và đọc số người theo dõi khi trường có trong phản hồi. Trường người theo dõi chỉ dùng sau khi xác định bằng mẫu phản hồi thật đã lọc token/cookie; trước đó trả `null`.
- Không mở thêm trang ngoài lượt đọc Page sẵn có.

### 4.4 Bộ theo dõi
- `PostTracker` nhặt dòng `page` đến hạn cùng lịch 15 phút hiện có, gom theo (profile, Page) để mỗi Page chỉ mở một lần mỗi lượt, rồi ghi người theo dõi nếu hôm nay chưa ghi.
- `known`: khớp theo `postId`, ghi số liệu mốc đến hạn.
- `missing`: chỉ nhận khi đúng một bài cùng Page có đầu nội dung khớp `text_head` và `postedAt` trong ±15 phút; 0 hoặc nhiều hơn một bài thì giữ chờ.
- Việc chạy qua hàng chờ profile và giới hạn một job như hiện nay; nhường giờ đăng sắp tới như bài nhóm.

### 4.5 Chiến dịch
- Khi dòng `page` thuộc một lượt chiến dịch chuyển `known`, gọi `registerPostedResult(execution, { postId, postUrl, sourceRef })` với `sourceRef` trỏ tới dòng theo dõi.
- Lượt `uncertain` tìm thấy đúng bài thì `settle(..., 'posted', resultId)`; không tìm thấy hết hạn thì giữ `uncertain` để chủ kiểm tra. Không có đường nào tạo lượt đăng mới.
- Số liệu chiến dịch mốc 4320 phút lấy từ `fb_poster_post_stats` của dòng đã gắn; runner không có thao tác nào tự khai số liệu.

## 5. Luồng xử lý và lỗi

| Tình huống | Xử lý |
|---|---|
| Checkpoint / đăng xuất | Dừng lượt theo dõi, báo lỗi đăng nhập như hiện nay; mốc sau thử lại |
| Mạng lỗi, phản hồi lạ | Không tính là không tìm thấy; thử lại mốc sau |
| 0 hoặc nhiều hơn 1 bài khớp | Giữ `missing`; hết lịch 7 ngày thì `not_found` |
| Bài đã có ID nhưng không còn trong 10 bài gần nhất | Mốc đó ghi "không có dữ liệu"; không kết luận bài bị xóa |
| Lỡ mốc quá 24 giờ | Bỏ mốc như bài nhóm (`STATS_OVERDUE_LIMIT_MS`) |
| Đổi workspace / thoát app | Theo cơ chế dừng an toàn hiện có; ghi đúng workspace đã capture |
| App tắt qua giờ gửi báo cáo | Lần mở sau gửi bù đúng một tin cho kỳ gần nhất |

## 6. Control API và thông báo

### Control API
- `pages.metrics({ pageId?, days })` (đọc, không nguy hiểm): bài Page đã xác nhận, số liệu theo mốc, trạng thái link, chuỗi người theo dõi. Theo RBAC hiện có; không thêm vào allowlist của runner/receiver ngoài phạm vi đọc đã duyệt.
- `notifications.config` (đọc) và `notifications.setConfig({ reportCadence?, reportHour?, reportWeekday?, leadDigestMinutes? })` (chỉ owner, validate miền giá trị; runner/receiver bị từ chối).
- `pageCampaigns.report` giữ shape, chỉ khác là có số liệu thật khi bài đã xác nhận.
- Sự kiện mới: `metrics.report` (một lần mỗi kỳ, payload tổng hợp) và `leads.digest` (một lần mỗi khoảng gom, gộp mọi bài). Khi `leadDigestMinutes > 0`, `leads.found` vẫn ghi vào event log cho bot đọc nhưng bridge không gửi tin riêng cho nó.

### Telegram (bridge `watch`)

| Loại | Nhãn đầu tin |
|---|---|
| Báo cáo định kỳ | `📊 Báo cáo hiệu quả · <khoảng ngày>` |
| Khách tiềm năng (gom) | `🎯 <n> khách tiềm năng mới · <khoảng giờ>` |
| Lượt đăng lỗi | `⚠️ Đăng bài lỗi: …` |
| Video lỗi | `⚠️ Video lỗi: …` |
| Đề xuất lỗi | `⚠️ Đề xuất lỗi: …` |
| Theo dõi bài | Không gửi theo lượt; đưa vào 📊 |

Các loại còn lại giữ nguyên. Báo cáo 📊 gồm: số bài, tổng tương tác, 3 bài nổi bật, người theo dõi tăng/giảm theo Page, số bài không tìm thấy link.

## 7. Giao diện

- Màn "Hiệu quả" (tab Lịch sử và Chiến dịch): tính bài Page; "Gom theo" thêm **Page**; chip trạng thái link **Đang tìm link** / **Không tìm thấy**; mốc thiếu số liệu hiện "—" kèm lý do.
- Ô **Người theo dõi** theo Page: hiện tại, thay đổi 7 và 30 ngày; thiếu dữ liệu ghi "chưa đủ dữ liệu".
- Popover cài đặt theo dõi thêm **Báo cáo qua bot** (Tắt / Hằng ngày / Hằng tuần, giờ, thứ) và **Gom tin khách tiềm năng** (Gửi ngay / 15 / 30 / 60 / 120 / 240 phút).
- Token `DESIGN.md`; desktop/mobile × sáng/tối, không tràn ngang, focus bàn phím.

## 8. Ma trận nghiệm thu

| Ca | Kỳ vọng |
|---|---|
| Phản hồi mutation có chủ = Page | `known`, có `postId`/URL |
| Chủ khác Page / thiếu / lạ | `missing`, không URL |
| Bài chiến dịch | Không còn `postUrl:null` cố định; vẫn qua xác minh chủ |
| Tìm lại: đúng 1 / 0 / 2 bài khớp | `known` / giữ chờ / giữ chờ; hết 7 ngày `not_found` |
| Mốc 1 giờ / 1 ngày / 3 ngày | Ghi số liệu từ bộ đọc Page; trôi khỏi danh sách thì "không có dữ liệu" |
| Người theo dõi | Tối đa 1 bản ghi/Page/ngày; trường chưa xác minh thì `null` |
| Lượt chiến dịch đã xác nhận | `registerPostedResult` có target; báo cáo có số liệu |
| Lượt `uncertain` tìm thấy bài | `posted`, 0 lần đăng lại |
| Runner tự khai số liệu / đổi cấu hình thông báo | Bị từ chối |
| 📊 tắt / ngày / tuần qua nhiều múi giờ | Đúng kỳ, 1 tin/kỳ; tắt app qua giờ gửi thì bù 1 tin |
| Gom 🎯 qua khởi động lại | Không mất khách, 1 tin/khoảng; `0` phút gửi ngay |
| Nhãn tin | Test Python cho mọi loại; 📈 không gửi theo lượt |
| Bài nhóm | Toàn bộ test theo dõi bài nhóm hiện có giữ xanh |
| Tích hợp | Tracker + hàng chờ + SQLite thật, browser giả |
| UI | Harness desktop/mobile × sáng/tối |
| Kiểm chứng như CI | Hai vòng full Jest randomized (2707/NY, 3707/HCM) + thứ tự chuẩn UTC; Python bridge; hai tsc; docs-check |

## 9. Rủi ro

- Facebook đổi định dạng phản hồi: số liệu thành "không có dữ liệu", không sai; cần cập nhật bộ đọc.
- Trường người theo dõi chưa xác định cho tới khi có mẫu phản hồi thật; có thể cần anh mở Page một lần để lấy mẫu.
- Page đăng dày hơn 10 bài trong 3 ngày làm mốc cuối thiếu dữ liệu.
- Gom 🎯 làm tin khách mới trễ tối đa bằng khoảng gom (mặc định 60 phút).
- Kiểm chứng cuối trên app Electron thật và Facebook thật cần anh.

## 10. Ranh giới file dự kiến

- `src/services/facebookPoster/postToTargets.ts`, `FacebookPosterService.ts`, `PostTracker.ts`, `postTracking.ts`, `schema.ts`, `FacebookPosterStore.ts`
- `src/services/dailyBrief/pageIdentity.ts`, `src/models/dailyBrief.ts`, `PageCampaignStore.ts`, `PageCampaignExecutionStore.ts`, `PageCampaignTracker.ts`
- Scheduler báo cáo/gom tin trong `src/services/facebookPoster/` (đặt cạnh `PostTrackScheduler.ts`)
- `src/services/control/ControlMethods.ts`, `controlEvents.ts`; `electron/ipc/facebookPosterIpc.ts`, `electron/preload.ts`, `src/ui/lib/ipc.ts`
- `src/ui/features/facebookPoster/PerformancePanel.tsx`, `TrackConfigPopover.tsx`, `trackingFormat.ts`
- `tools/maihub-bridge/maihub_bridge.py` và tests; `docs/protocol/maihub-control-protocol.md`; `SYSTEM_DOCUMENTATION.md`; `ChangelogSettings.tsx` khi phát hành

Không thêm dependency; version tăng khi phát hành.

## 11. Ghi chú sau triển khai (31/10/2026, dev)

- **4.1 / 4.3:** bằng chứng theo dõi là trường riêng `verifiedPostUrl`; `postUrl` của kết quả (link bình luận đầu, `fb_poster_results.post_url`) vẫn bắt như cũ để bình luận đầu của lượt đăng tay chế độ Page không hồi quy, nhưng link đó không bao giờ thành dòng `known`. Ở chế độ Page chỉ đọc phản hồi của mutation tạo bài; phản hồi chỉ có `Story` (ví dụ bài cũ của Page) bị bỏ qua. Bộ đọc **chưa** đọc số người theo dõi (luôn `null`) vì chưa có mẫu phản hồi thật đã lọc: bảng người theo dõi trống trong app thật, UI và 📊 hiện "chưa đủ dữ liệu" cho tới khi anh gửi mẫu.
- **4.4:** đọc một lần cho mỗi cặp (profile, `group_url`, `page_id`); mọi dòng Page hiện có cùng `group_url` trang chủ nên tương đương một lần mỗi (profile, Page). Cặp Page chưa học (`page_id = ''`) không mở trình duyệt mà lên lịch lại như lần đọc lỗi; chỉ nghỉ 8–15 giây giữa hai cặp khi cặp trước đã mở trình duyệt; ghi người theo dõi lỗi không làm mất số đo của cùng lượt đọc.
- **4.5:** gắn qua `PageCampaignExecutionStore.bindTrackedPost` (lúc đăng và lúc tìm lại) và gắn bù lúc khởi động Control API (`bindKnownTrackedPosts`), nên lần gắn trực tiếp lỗi thì mốc có thể chưa xác nhận tới lần khởi động kế. `registerPostedResult` nhận kết quả `uncertain_after_submit` chỉ khi có target đã xác minh. Mốc của bài chiến dịch chưa gắn mà dòng theo dõi còn đang tìm (trong cửa sổ 24 giờ) giữ chờ thay vì ghi ngay `unconfirmed_post_target`.
- **5:** đọc Page lỗi ở mốc cuối xử lý như bài nhóm (dòng chưa có link thành `not_found`).
- **6:** `pages.metrics`, `notifications.config`, `notifications.setConfig` đều chỉ owner. `leads.found` chỉ mang `deferred: true` khi đang gom **và** con trỏ gom đã khởi tạo; đổi `leadDigestMinutes` trả `BUSY` khi có lượt thu bình luận (tự động hoặc tay) đang chạy. `pages.metrics` quét tối đa 5000 dòng không báo cắt. Bridge: danh sách người theo dõi của 📊 tối đa 20 Page kèm `… và N Page khác`.
- **7:** "—" kèm "Không có trong 10 bài gần nhất của Page" cũng hiện cho mốc khép lại mà không đọc được (lỗi đọc, back-off, quá hạn). Thay đổi 7/30 ngày so với lần chụp mới nhất vào hoặc trước ngày mới nhất − N ngày (cùng quy tắc với 📊); ô người theo dõi không lọc theo chiến dịch. Chế độ nhân viên không thấy màn Đăng Facebook.
- **Bản sửa cuối:** giờ đăng của dòng Page là lúc bấm Đăng (`publishedAt` từ bước đăng), không phải lúc có kết quả sau khi chờ bình luận đầu; hàng chờ tin gom 🎯 theo `id` của lead (thứ tự ghi) nên đồng hồ máy bị lùi không làm rơi lead; `text` của 📊 (bài nổi bật) và `pages.metrics` là nội dung gốc từ tham số lượt, lượt đã bị xoá thì là đầu bài đã chuẩn hoá chữ thường; số bài của 📊 và `pages.metrics` tính cả bài chiến dịch `uncertain` cho tới khi tìm lại được hoặc `not_found`.
