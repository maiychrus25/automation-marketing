# Bình luận góp ý có anh duyệt trong MaiHub

**Ngày:** 2026-11-02  
**Trạng thái:** Đã triển khai trên nhánh feat/approved-engagement (02/11/2026), chưa phát hành; chưa kiểm trên app Electron/Facebook thật. Trả lời bình luận (kind reply) làm ở nhánh feat/engagement-reply (03/11/2026), chưa kiểm gửi thật. Implementation plan: `docs/plans/2026-11-02-approved-engagement-comments.md`.  
**Phạm vi:** Bot tìm bài và bình luận đáng góp ý hoặc giải đáp theo chủ đề Page, soạn sẵn câu, đưa vào hàng chờ trong MaiHub. Anh duyệt từng gợi ý bằng nút trong app; app chỉ đăng câu anh đã duyệt. Bổ sung cho spec `docs/specs/2026-11-01-bounded-autonomous-operation.md` (dùng lại bộ giới hạn, vòng `auto-tick`, báo cáo 📊).  
**Nguồn thiết kế UI:** `DESIGN.md`, màn Facebook Poster và tab Tự vận hành hiện có.

## 1. Mục tiêu và ý định

Anh muốn Page có thêm tương tác bằng cách góp ý vào bài hay và giải đáp người đang gặp khó trong bình luận, như một người dùng bình thường. Bot lo phần tìm và soạn; **người quyết định từng bình luận là anh**.

**Ranh giới cứng:** bình luận vào bài của người khác chỉ được đăng khi anh bấm **Duyệt** trong app MaiHub. Bot (kể cả bằng khoá chủ qua Control API/MCP) không có thao tác nào để duyệt, sửa câu đã duyệt hay đăng bình luận vào bài của người khác. Anh nhắn bot "đã duyệt" cũng không thay được nút này.

**Tiêu chí thành công:**
- Bot đưa được tối đa 20 gợi ý/ngày/profile vào hàng chờ, mỗi gợi ý có link, trích đoạn, câu soạn sẵn, kiểu, profile và lý do.
- Anh xem, sửa câu, duyệt hoặc bỏ từng gợi ý trong app; không có duyệt hàng loạt.
- Sau khi duyệt, app đăng đúng câu đó vào đúng chỗ đó, đọc lại để xác nhận, báo kết quả.
- Không có đường nào để bot tự duyệt; có test khẳng định điều này.
- 📊 có số gợi ý, đã duyệt, đã đăng, đã bỏ.

**Ngoài phạm vi:** bot tự đăng bình luận vào bài của người khác không qua duyệt; duyệt qua Telegram; tự tham gia nhóm; nhắn tin riêng; đo "người trả lời lại" dưới bình luận của anh (để sau).

## 2. Quyết định của anh (02/11/2026)

| # | Quyết định |
|---|---|
| E1 | Hai kiểu: **bình luận mới** dưới bài, và **trả lời một bình luận** cụ thể trong bài. |
| E2 | Nguồn: bài đang nổi và bài hỏi mua theo chủ đề Page, không giới hạn ở nhóm đã tham gia. |
| E3 | Anh duyệt từng gợi ý bằng **nút trong app MaiHub** (không qua bot). Có thể sửa câu trước khi duyệt. |
| E4 | Trần mặc định: 20 gợi ý/ngày/profile, 10 bình luận được duyệt và đăng/ngày/profile. |
| E5 | Gợi ý hết hạn sau 24 giờ nếu chưa duyệt. Mỗi bài chỉ một bình luận được duyệt cho mỗi profile. |
| E6 | Trả lời khách dưới bài của anh (`comments.reply`) giữ tự động như hiện nay. |
| E7 | Bot nhắn Telegram báo có gợi ý mới chờ duyệt. |

## 3. Luồng

1. **Tìm (bot, trong `auto-tick`):** dùng `research.search` / `research.trending` / `research.scanGroupFeeds` (chỉ đọc) theo từ khoá và chủ đề của brief Page. Với kiểu trả lời, bot đọc bình luận của bài ứng viên bằng thao tác đọc mới `engagement.readComments({ profileId, postUrl })` (dùng lại bộ thu bình luận, chỉ đọc, không lưu thành lead).
2. **Đề xuất (bot):** `engagement.suggest(...)` (mục 5) đưa một gợi ý vào hàng chờ, trạng thái `pending`.
3. **Báo (bridge):** cuối mỗi `auto-tick` có tạo gợi ý, bridge gửi một tin Telegram: "🗂 Có N gợi ý bình luận mới chờ anh duyệt trong MaiHub", kèm tên profile và trích đoạn ngắn từng gợi ý. Không có nút duyệt trong tin.
4. **Duyệt (anh, trong app):** màn "Chờ duyệt" liệt kê gợi ý; anh mở link xem bài, sửa câu nếu muốn, bấm **Duyệt** hoặc **Bỏ** (kèm lý do tuỳ chọn).
5. **Đăng (app):** gợi ý đã duyệt vào hàng đăng của profile (side job trên `ProfileJobQueue`, mẫu `LeadReplier`). Job mở bài, kiểm bài còn và bình luận được, đăng **nguyên văn** câu đã duyệt, đọc lại xác nhận hiển thị dưới đúng profile.
6. **Kết quả:** `posted` / `skipped` (lý do) / `failed` / `uncertain`; phát `engagement.finished`; bot đọc lại qua `engagement.list` để rút kinh nghiệm từ gợi ý bị bỏ.

## 4. Dữ liệu

Bảng mới `fb_poster_engagement_items` (cộng thêm, không đổi bảng cũ):

| Cột | Ý nghĩa |
|---|---|
| `id` | khoá |
| `profile_id` | profile sẽ đăng |
| `kind` | `comment` (bình luận mới) \| `reply` (trả lời bình luận) |
| `post_url`, `post_key` | link bài; khoá bài chuẩn hoá (dùng lại chuẩn hoá của chống trùng lead) |
| `target_comment_id`, `target_author`, `target_excerpt` | chỉ với `reply`: bình luận được trả lời |
| `post_excerpt` | trích đoạn bài (≤ 500 ký tự) để anh đọc và để job kiểm đúng bài |
| `suggested_text` | câu bot soạn |
| `approved_text` | câu anh duyệt (có thể đã sửa); chỉ app ghi |
| `reason`, `source_ref` | lý do chọn; tham chiếu lượt nghiên cứu |
| `status` | `pending` → `approved` → `posting` → `posted` \| `skipped` \| `failed` \| `uncertain`; hoặc `rejected` \| `expired` |
| `reject_reason`, `result_reason` | lý do bỏ / lý do kết quả |
| `suggested_at`, `expires_at`, `decided_at`, `posted_at` | mốc thời gian |
| `reservation_id` | dòng giữ chỗ trong bộ giới hạn |

Mỗi `(profile_id, post_key)` chỉ có tối đa một dòng ở trạng thái `pending|approved|posting|posted|failed|uncertain`.

## 5. Control API (chỉ owner, không vào danh sách runner/receiver)

| Thao tác | Việc |
|---|---|
| `engagement.suggest` | `{ profileId, kind, postUrl, postExcerpt, text, reason, sourceRef?, targetCommentId?, targetAuthor?, targetExcerpt? }` → `{ id, status: 'pending', expiresAt }` |
| `engagement.list` | `{ status?, profileId?, limit?, offset? }` — đọc hàng chờ và kết quả (gồm `rejectReason`) |
| `engagement.withdraw` | `{ id }` — bot rút gợi ý còn `pending` của chính nó |
| `engagement.readComments` | `{ profileId, postUrl }` — đọc bình luận công khai của một bài (chỉ đọc) |

**Không có** `approve`, `edit` hay `post` trong Control API. Kiểm tra lúc `suggest`:
- `profileId` là profile có trong app; `kind` hợp lệ; `reply` phải có `targetCommentId` hoặc `targetAuthor` + `targetExcerpt`.
- `text` 1–600 ký tự sau trim; **không chứa link** (URL, `www.`, tên miền) — vượt thì `INVALID_PARAMS`.
- Trần 20 gợi ý/ngày/profile (bộ giới hạn, action mới `engagement_suggest`) → `LIMIT_REACHED`.
- Trùng `(profile_id, post_key)` còn hiệu lực → `CONFLICT`.
- Không gate theo công tắc Tự vận hành/`protectedWritesEnabled` vì `suggest` không thao tác Facebook; `readComments` là đọc Facebook nên chịu giờ im lặng và profile đang dừng.

Sự kiện: `engagement.suggested` (id, profileId, kind), `engagement.decided` (id, decision), `engagement.finished` (id, status, reason).

## 6. Duyệt trong app (IPC, không qua Control API)

IPC `engagement:list`, `engagement:approve { id, text? }`, `engagement:reject { id, reason? }`. Chỉ renderer của app gọi được; Control API không ánh xạ các kênh này.
- `approve` chỉ nhận gợi ý `pending` chưa hết hạn; `text` (nếu có) qua cùng kiểm tra như `suggest` (1–600, không link); ghi `approved_text`, `decided_at`; giữ chỗ trần đăng (mục 7); trạng thái `approved`; xếp job đăng.
- `reject` → `rejected` + lý do.
- Gợi ý `pending` quá `expires_at` → `expired` (quét khi đọc danh sách và theo timer có sẵn).
- Không có thao tác duyệt nhiều gợi ý trong một lệnh.

## 7. Giới hạn khi đăng

Dùng `AutonomyLimiter` (spec 2026-11-01 §4):
- Action mới `engagement_comment`: trần 10/ngày/profile (`engagementCommentsPerDay`), tính vào `facebookActionsPerDay`.
- Action mới `engagement_suggest`: trần 20/ngày/profile (`engagementSuggestionsPerDay`), không tính vào thao tác Facebook.
- Lúc đăng: giờ im lặng → chờ tới hết giờ im lặng nếu vẫn trong 24 giờ kể từ lúc duyệt, quá thì `skipped: expired_after_approval`; profile đang dừng (checkpoint/đăng xuất) → `skipped`, trả chỗ.
- Không phụ thuộc công tắc Tự vận hành và `protectedWritesEnabled`: lời duyệt của anh là quyền đăng.
- Giữ chỗ lúc duyệt; trả chỗ khi job dừng trước khi bấm gửi; giữ chỗ nếu đã bấm gửi (kể cả lỗi sau đó), không thử lại.

## 8. Đăng bình luận

- **Bình luận mới:** dùng routine `postFirstComment` (mở bài, kiểm bài hiển thị theo `post_excerpt`, gõ, gửi, đọc lại).
- **Trả lời bình luận:** routine mới `postCommentReply(page, { postUrl, target, text })`: tìm đúng bình luận theo `targetCommentId` (hoặc tác giả + trích đoạn khớp duy nhất), bấm "Trả lời", gõ, gửi, đọc lại xác nhận câu trả lời nằm dưới đúng bình luận. Không tìm thấy duy nhất → `skipped: target_not_found`, không đoán. Cần một mẫu HTML thật của bài công khai có bình luận (anh lưu như `me.html`) để viết bộ chọn và fixture.
- Bài trong nhóm chưa tham gia hoặc tắt bình luận → `skipped: cannot_comment`.
- Không log nội dung bình luận của người khác ngoài trích đoạn đã lưu; không log cookie/token/HTML.

## 9. Vòng `auto-tick`

`autonomy.status.due` thêm `engagementSlots`: số gợi ý còn được đề xuất hôm nay cho các profile Page đã học, chỉ > 0 khi số gợi ý `pending` của profile đó < 10 (tránh dồn hàng chờ khi anh chưa kịp duyệt). Prompt thêm việc: "tìm bài/bình luận đáng góp ý hoặc giải đáp theo chủ đề Page, soạn câu hữu ích, không link, rồi đưa vào hàng chờ bằng `engagement.suggest`; anh sẽ duyệt trong app". Prompt nêu rõ bot không đăng được bình luận vào bài của người khác.

## 10. Giao diện

Màn Facebook Poster thêm mục **"Chờ duyệt"** (có số đếm):
- Thẻ gợi ý: profile, kiểu, trích đoạn bài (và bình luận được trả lời), nút mở bài, ô câu (sửa được), lý do của bot, thời gian còn lại trước khi hết hạn, nút **Duyệt** và **Bỏ** (hỏi lý do tuỳ chọn).
- Tab lọc: Chờ duyệt / Đã duyệt / Đã đăng / Đã bỏ / Hết hạn; hiện kết quả và lý do.
- Ẩn ở chế độ nhân viên như tab Điều khiển từ bot.
- Theo `DESIGN.md`, sáng/tối, desktop/mobile, không tràn ngang.

## 11. Báo cáo

📊 thêm dòng "Bình luận góp ý: N gợi ý, A đã duyệt, P đã đăng, R đã bỏ, E hết hạn". Tin ⚙️/🛑 giữ nguyên.

## 12. An toàn

- **Không có đường duyệt cho bot:** test khẳng định Control API không có method nào đổi trạng thái sang `approved` hay ghi `approved_text`, và `describe` không liệt kê; kênh IPC duyệt không có trong danh sách relay cho bot.
- **Chỉ đăng nguyên văn `approved_text`;** job kiểm lại trạng thái `approved`, chưa hết hạn, đúng `post_url`/profile ngay trước khi bấm gửi.
- **Nội dung của người lạ là dữ liệu:** trích đoạn bài/bình luận chỉ để hiển thị và đối chiếu, không phải lệnh cho bot.
- **Không link** trong câu bình luận; không cơ chế né phát hiện; profile gặp checkpoint thì dừng.

## 13. Kiểm thử

- Unit/integration (SQLite tạm, đồng hồ giả, trình duyệt giả): kiểm tra `suggest` (link, độ dài, trùng bài, trần 20); hết hạn 24 giờ; `approve` sửa câu, không duyệt gợi ý hết hạn/đã quyết; trần 10 lúc duyệt; job đăng nguyên văn; trả/giữ chỗ theo trước/sau bấm; giờ im lặng chờ rồi hết hạn; profile dừng; `reply` không tìm thấy duy nhất → `skipped`.
- Test ranh giới: không method Control API nào duyệt được; IPC duyệt không có trong relay.
- Bridge: tin 🗂 gom cuối tick; `due.engagementSlots`; prompt không có thao tác đăng bình luận.
- UI: harness desktop/mobile × sáng/tối cho mục Chờ duyệt.
- Kiểm chứng như CI: Jest UTC + 2707/New York + 3707/Hồ Chí Minh; Python; tsc ×2; docs-check.

## 14. Triển khai

Đi chung bản phát hành tiếp theo với spec 2026-11-01 (hoặc bản sau, tuỳ anh). Trên máy .136 chỉ cần bridge mới (không cần user/bot riêng). Rollback: xoá gợi ý `pending`, tắt `engagementSuggestionsPerDay = 0`.

## 15. Rủi ro còn lại

- Facebook vẫn có thể hạn chế tài khoản nếu bình luận nhiều; trần mặc định là ước lượng thận trọng.
- Routine trả lời bình luận dựa trên mẫu giao diện; Facebook đổi giao diện thì về `skipped`, không đăng sai chỗ.
- Chất lượng gợi ý phụ thuộc AI; anh vẫn là người quyết từng câu.

## Ghi chú sau triển khai

Code khác hoặc bổ sung so với spec ở các điểm sau (thân spec giữ nguyên làm lịch sử):

- **R1 — trả lời bình luận hoãn.** Mẫu HTML đã lưu không có ô trả lời, chỉ một bình luận hiển thị và không có bình luận trả lời đã đăng để đọc lại, nên không viết được routine đăng/đọc lại an toàn. `engagement.suggest` từ chối `kind:'reply'` bằng `INVALID_PARAMS` "Trả lời bình luận chưa hỗ trợ"; `EngagementPoster` đưa dòng `reply` (nếu có) về `skipped` `reply_unsupported`. Cần thêm mẫu: ô trả lời đã mở với chữ đã gõ nhưng chưa gửi, và sau khi trả lời hiển thị.
- **Duyệt chỉ giữ chỗ trần (`capsOnly`).** `AutonomyLimiter.reserve(req, { capsOnly: true })` chỉ áp trần `engagementCommentsPerDay` và `facebookActionsPerDay`; giờ im lặng và profile đang dừng được kiểm lại lúc đăng (`assertEffect`), nên anh vẫn duyệt được ban đêm và việc đăng chờ hoặc bị `skipped` + trả chỗ.
- **Bộ nhận diện link** gồm scheme rõ ràng, `www.` và `nhãn.<đuôi miền thuộc danh sách cho phép>` (không phân biệt hoa thường; ví dụ com, net, org, vn, me, ly, io, co, info, biz, xyz, link, site, online, shop, store, app, page, to, gl) để "TP.HCM", "ok.Hay", "Dr.Martens" không bị chặn nhầm; đuôi hiếm lọt qua vẫn phải qua mắt anh khi duyệt.
- **Trường quá dài bị từ chối** (`postExcerpt`, `reason`, `sourceRef` vượt `maxLength`) bằng `INVALID_PARAMS`, không cắt âm thầm.
- **`engagement.readComments`** chờ profile bận tối đa 60 giây (`BUSY` khi hết), kiểm lại cổng giờ im lặng/profile dừng sau khi trình duyệt mở và trả `BUSY` nếu đổi workspace giữa chừng; không đếm trần và không ghi `fb_poster_comments`/`fb_poster_leads`.
- **Chờ nghiên cứu 4 giờ** (`ENGAGEMENT_RESEARCH_INTERVAL_MS`): mỗi profile chỉ có `engagementSlots` khi lần nghiên cứu gần nhất cũ hơn 4 giờ, để `auto-tick` không đốt hết 12 lượt AI/ngày; mốc ghi khi `engagement.suggest` thành công hoặc qua method owner-only mới `engagement.markResearched { profileIds }`. Chỗ gợi ý chỉ tính `pending` còn hạn (`expires_at > now`).
- **Tin 🗂** do `watch` gửi, gom mọi `engagement.suggested` trong một lô sự kiện thành một tin (tối đa 10 dòng); `auto-tick` không có đường Telegram.
- **Khối báo cáo 📊** tên `commentSuggestions` (`suggested|approved|posted|rejected|expired`), bỏ khi toàn 0.
- **Huỷ gợi ý đã duyệt và dừng khẩn.** IPC Boss `engagement:cancel { id }` (nút "Huỷ" ở lọc Đã duyệt, có xác nhận) chuyển dòng `approved` (không phải `posting`) sang `skipped` `cancelled_by_operator` và trả chỗ; Dừng khẩn tự vận hành cũng huỷ mọi dòng `approved` với `stopped_by_operator` và báo `cancelledEngagement` trong `autonomy.stopped`. Không có trong Control API.
- **Hỏng trước khi bấm gửi trả chỗ.** `CommentOutcome.sent` (cộng thêm) chỉ `true` từ lúc thử bấm nút gửi/nhấn Enter; `failed` chưa gửi → `skipped` `not_sent` + trả chỗ (bot gợi ý lại được), `failed` đã gửi → `failed` + giữ chỗ như cũ.
- **Kiểm lại ngay trước khi đăng.** Sau khi chờ được khe profile, `EngagementPoster` kiểm lại hạn 24 giờ kể từ lúc duyệt và giờ im lặng/profile dừng; bị chặn thì đóng phiên và hoãn / hết hạn / bỏ qua như lúc chưa mở.
- **R1 đã gỡ (Task 5, 03/11/2026).** Mẫu thứ hai có ô trả lời đang mở (đã gõ, chưa gửi). `engagement.suggest` nhận `kind:'reply'` (vẫn bắt `targetCommentId` hoặc `targetAuthor` + `targetExcerpt`); `EngagementPoster` đưa dòng `reply` vào `postCommentReply` (`src/services/facebookPoster/commentReply.ts`), mã `reply_unsupported` không còn. Kết quả: `posted` → giữ chỗ; `target_not_found`/`post_not_found` → `skipped` + trả chỗ; `failed` chưa bấm gửi → `skipped` `not_sent` + trả chỗ; `failed` đã bấm gửi → `failed` + giữ chỗ; ném → `uncertain`.
- **Luật khớp bình luận.** Có `targetCommentId` thì chỉ so theo id (số, `x_y`, `comment:x_y` hoặc base64 của nó; link câu trả lời lấy `reply_comment_id`); không thì tác giả phải là nguyên cụm từ trong nhãn khối ("Bình luận dưới tên <tác giả> …") **và** đầu trích đoạn (dòng đầu, 40 ký tự) nằm trong chữ của khối. Không có hoặc nhiều khối khớp → `target_not_found` trước mọi cú bấm. Ô trả lời là ô nhập mới duy nhất xuất hiện sau khi bấm "Trả lời" của chính khối đó (khối được kiểm lại cả nhãn lẫn id trước khi bấm), không nằm bên trong khối bình luận nào, được kiểm lại vị trí ngay lúc đánh dấu để gõ, và nằm trong chuỗi của khối: sau khối, trước bình luận đầu chuỗi kế tiếp (khối không mang `reply_comment_id`); không có bình luận đầu chuỗi kế tiếp (đích là bình luận cuối danh sách) thì không trả lời: `failed` chưa gửi → `skipped` `not_sent` + trả chỗ (đo được: ô nằm NGOÀI khối, trước bình luận kế tiếp).
- **Đọc lại theo vị trí, không theo nhãn.** Mẫu chưa có câu trả lời đã đăng, nên xác nhận = số khối (chữ của khối không tính chữ trong ô nhập con) chứa đúng đoạn chữ vừa gửi, nằm sau bình luận được trả lời và trước bình luận đầu chuỗi kế tiếp (ghi mốc bằng id trước khi gửi), phải tăng; đọc lại tối đa 3 lần; mất mốc hoặc mất bình luận → `failed` đã gửi (giữ chỗ), không mở rộng tới cuối trang.
- **Không có mã `cannot_comment`.** Bài tắt bình luận hoặc không cho trả lời (không thấy nút "Trả lời"/ô nhập/nút gửi) về `failed` chưa gửi → `skipped` `not_sent` + trả chỗ. `postCommentReply` chỉ nhận trang bài khớp `/posts/`, `story_fbid=`, `/permalink`, `/photo`; trang sau khi mở vẫn là `/videos/`, `/reel/` hay `/share/p/` (không được chuyển về một dạng trên) → `post_not_found` → `skipped` + trả chỗ.
- **`engagement.readComments` không thêm `commentId`.** Trên mẫu thật, mọi link tác giả trong khối bình luận đều mang `comment_id`, mà `readCommentsInPage` (bộ thu bình luận dùng chung với khách) bỏ qua mọi link có `comment_id` khi tìm tác giả, nên trên mẫu này gần như không bình luận nào được đọc đúng (khối có link ngoài qua `l.php` còn bị nhận `l.php` làm tác giả). Sửa bộ thu là việc riêng (ảnh hưởng thu khách); tới lúc đó bot nhắm bằng `targetAuthor` + `targetExcerpt` khi `readComments` trả được bình luận.
- **F1 — Dừng khẩn chặn cả dòng `posting` (03/11/2026).** Đường dừng khẩn ghi `app_settings.engagement_stop_epoch`; dòng duyệt trước hoặc đúng mốc mà đã sang `posting` (đang chờ khe profile) bị chặn ở bước kiểm lại sau khi mở phiên: `skipped` `stopped_by_operator` + trả chỗ. Dòng duyệt sau mốc không ảnh hưởng.
- **F2 — Huỷ sau khi mở phiên trả dòng về `approved` (03/11/2026).** Thoát app/đổi workspace trước cú bấm gửi (`sent !== true`): dòng về `approved`, giữ chỗ, đăng lại trong hạn 24 giờ; `failed` chưa gửi không do huỷ vẫn `skipped` `not_sent` + trả chỗ.
- **F3 — Trần bình luận theo ngày đăng (03/11/2026).** Duyệt giữ chỗ theo ngày duyệt; lúc đăng còn kiểm số bình luận đã gửi trong ngày địa phương đang đăng, chạm `engagementCommentsPerDay` thì hoãn tới nửa đêm kế nếu còn trong 24 giờ kể từ lúc duyệt, không thì `skipped` `expired_after_approval` + trả chỗ. Không thêm giãn nhịp.
- **F5 — `engagement.readComments` đổi workspace lúc chờ khe profile → `BUSY` (03/11/2026)**, kể cả khi hàng chờ bị dừng/thu hồi trước (`profile_wait_cancelled`, lỗi thu hồi workspace của hàng chờ); không còn `INTERNAL`.
