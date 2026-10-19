# Thiết kế: Nghiên cứu chủ đề trên Facebook (theo hướng babyvibe)

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 19/10/2026 |
| Trạng thái | Đã phát hành 26.20.0 (19/10/2026) |
| Kế hoạch | `docs/plans/2026-10-19-topic-research.md` (viết sau khi spec được duyệt) |
| Intent | `docs/intent/2026-10-19-topic-research.md` (đã duyệt) |
| Nhánh | `feat/topic-research` |
| Tham khảo | `github.com/babyvibe/facebook-scan-data-extension` (không có license, **không chép code**) |

## 1. Tổng quan

| Nguồn (`source`) | Mục thu được (`kind`) | Truy vấn GraphQL dự kiến (bước thử xác nhận) |
|---|---|---|
| `posts`: bài theo từ khoá | `post` | `SearchCometResultsPaginatedResultsQuery` (tìm bài) |
| `groups`: nhóm theo từ khoá | `group` | `SearchCometResultsPaginatedResultsQuery` (tìm nhóm) |
| `pages`: fanpage theo từ khoá | `page` | `SearchCometResultsPaginatedResultsQuery` (tìm trang) |
| `group_feed`: bài trong nhóm đã tham gia | `post` | Truy vấn phân trang bảng tin nhóm, ví dụ `GroupsCometFeedRegularStoriesPaginationQuery` |

Chạy bằng **các profile sẵn có**, xoay vòng và chia nhỏ lượng quét (mục 5); mỗi lúc một lượt quét. Kết quả lưu vào DB của workspace. Bot gọi qua Control API; người dùng dùng tab "Nghiên cứu".

## 2. Bước thử bắt buộc (Task 0, cần anh cho phép)

Facebook đổi cấu trúc thường xuyên. Vì vậy chi tiết bắt truy vấn và đường dẫn tới từng trường **không cố định trong spec**; chúng được chốt bằng bước thử, **chỉ đọc**, trên một profile có sẵn anh chỉ định. Bước thử phải trả lời 5 câu:

1. **Mã phiên:** lấy `fb_dtsg`, `lsd` và ID người dùng ở đâu trong trang (vd. module `DTSGInitialData`, `LSD`, `CurrentUserInitialData`, hoặc đọc từ HTML).
2. **Trang kết quả đầu tiên** của mỗi nguồn đến từ đâu: request GraphQL, hay dữ liệu nhúng sẵn trong HTML. Cách bắt `doc_id` và biến mẫu của truy vấn phân trang.
3. **Đường dẫn tới từng trường** ở mục 4.2 trong phản hồi của mỗi nguồn, gồm người đăng (tên, ID, link) và cách nhận biết người đăng là cá nhân hay trang.
4. **Lỗi khi phiên hỏng:** dạng phản hồi khi hết phiên, bị checkpoint, bị chặn tạm thời, hoặc `doc_id` không còn hợp lệ.
5. Bộ lọc "gần đây" và theo năm của tìm bài được truyền thế nào.

**Kết quả của bước thử:**
- Báo cáo `docs/reports/2026-10-19-topic-research-spike.md`.
- Mẫu phản hồi **đã làm sạch** (thay tên và ID cá nhân thật bằng dữ liệu giả, giữ cấu trúc) đặt trong `src/__tests__/research/fixtures/` để test bộ đọc. Dữ liệu thật chỉ nằm trong DB của app, không đưa vào repo.

Nếu bước thử cho thấy một nguồn không lấy được ổn định, nguồn đó được hoãn và ghi vào spec (mục 10). Các nguồn còn lại vẫn làm.

## 3. Cách quét (hướng babyvibe, chạy trong trình duyệt)

1. Chọn profile theo mục 5, rồi mở bằng `openForAutomation` (như Đăng Facebook). Profile đang mở hoặc đang bận thì chọn profile khác.
2. Vào `facebook.com` và đọc mã phiên. Không đọc được, hoặc bị chuyển tới `/login` hay `/checkpoint`, thì dừng với mã `logged_out` / `checkpoint`.
3. **Bắt truy vấn:**
   - Mở URL tìm kiếm hoặc URL nhóm thật, lắng nghe request `POST /api/graphql/` có `fb_api_req_friendly_name` đúng tên, và lưu `doc_id` cùng biến mẫu vào bảng `research_queries`.
   - Lần sau dùng lại. Nếu Facebook báo truy vấn không hợp lệ thì bắt lại **một lần** trong lượt quét đó; vẫn hỏng thì `query_changed`.
4. **Phân trang:** gọi `fetch('/api/graphql/', …)` bằng `page.evaluate`, trong cùng trang và cùng nguồn. Không sửa header và không gọi API từ Node.
   - Mỗi trang: đọc mục bằng bộ đọc thuần (mục 4) và lưu ngay.
   - Lấy `end_cursor` cho trang sau. Hết cursor thì dừng.
5. **Giới hạn** (mục 6). Huỷ thì dừng sau trang đang gọi.
6. Đóng phiên trình duyệt trong `finally`.

## 4. Dữ liệu

### 4.1 Bảng (DB workspace, `CREATE TABLE IF NOT EXISTS`)

**`research_scans`**

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | TEXT PK | uuid |
| `source` | TEXT | `posts` / `groups` / `pages` / `group_feed` |
| `query` | TEXT | từ khoá; với `group_feed` là `''` |
| `params_json` | TEXT | bộ lọc, giới hạn, danh sách nhóm |
| `profile_ids` | TEXT | JSON mảng các profile đã dùng trong lượt quét |
| `details_json` | TEXT | số mục theo từng profile, lỗi theo từng profile/nhóm (vd. `{"profiles":{"<id>":{"items":40,"error":""}},"groups":{"<url>":"not_member"}}`) |
| `origin` | TEXT | `manual` / `api` |
| `status` | TEXT | `running` / `done` / `failed` / `cancelled` |
| `error_code` | TEXT | `''` hoặc mã ở mục 7 |
| `error` | TEXT | câu lỗi tiếng Việt |
| `item_count` | INTEGER | |
| `started_at` | INTEGER | |
| `finished_at` | INTEGER NULL | |

**`research_items`**

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | INTEGER PK | |
| `scan_id` | TEXT | |
| `kind` | TEXT | `post` / `group` / `page` |
| `fb_id` | TEXT | ID bài / nhóm / trang |
| `url` | TEXT | link bài / nhóm / trang |
| `title` | TEXT | nội dung bài (≤ 5000 ký tự) hoặc tên nhóm/trang |
| `place_kind` | TEXT | bài: nơi đăng — `group` / `page` / `person` (trang cá nhân) / `unknown` |
| `place_id` | TEXT | ID nơi đăng |
| `place_name` | TEXT | tên nơi đăng |
| `author_kind` | TEXT | bài: `person` / `page` / `unknown` |
| `author_id` | TEXT | ID người đăng (`''` nếu không đọc được) |
| `author_name` | TEXT | tên người đăng |
| `author_url` | TEXT | link người đăng |
| `privacy` | TEXT | nhóm: `public` / `private` / `''` |
| `member_count` | INTEGER NULL | nhóm |
| `follower_count` | INTEGER NULL | trang |
| `reactions` | INTEGER NULL | bài |
| `comments` | INTEGER NULL | bài |
| `shares` | INTEGER NULL | bài |
| `posted_at` | INTEGER NULL | ms, bài |
| `captured_at` | INTEGER | |
| `profile_id` | TEXT | profile đã thu mục này |

Ràng buộc: `UNIQUE(scan_id, kind, fb_id)`. Mục trùng trong cùng lượt quét thì bỏ qua.

**`research_queries`**

| Cột | Kiểu |
|---|---|
| `friendly_name` | TEXT PK |
| `doc_id` | TEXT |
| `variables_template` | TEXT |
| `captured_at` | INTEGER |

**Dọn dữ liệu:** lượt quét quá 180 ngày bị xoá (cùng các mục của nó) khi app khởi động.

### 4.2 Bộ đọc thuần

Hàm thuần, không phụ thuộc trình duyệt, nằm trong `src/services/research/parsers.ts`. Mỗi hàm nhận phản hồi GraphQL (chuỗi JSON, có thể nhiều dòng, có thể mở đầu bằng `for (;;);`) và trả `{ items, endCursor, error }`:
- `parseSearchPosts`
- `parseSearchGroups`
- `parseSearchPages`
- `parseGroupFeed`

**Quy tắc đọc:**
- Số dạng chữ như "1,2K" hay "3 N" đổi thành số nguyên.
- Trường không đọc được thì `null`, **không** ghi 0.
- Mục thiếu ID thì bỏ qua.
- Người đăng (cá nhân hoặc trang) được lưu tên, ID và link để truy vết (anh yêu cầu 19/10/2026). Đọc không được thì để `''` / `author_kind = 'unknown'`.

## 5. Chọn profile để quét (xoay vòng các profile sẵn có)

Không cần profile riêng. Đổi theo yêu cầu của anh, 19/10/2026.

**Profile đủ điều kiện:**
- không nằm trong danh sách loại trừ;
- không đang mở và không có lượt Đăng Facebook đang chạy;
- trạng thái đăng nhập (tính năng 26.19) không phải `logged_out` / `checkpoint` (`unknown` vẫn được);
- chưa chạm trần ngày của chính nó.

**Quét theo từ khoá** (`posts` / `groups` / `pages`):
- Thứ tự ưu tiên: profile có số mục quét trong 24 giờ ít nhất, rồi đến profile quét lâu nhất chưa dùng.
- Mỗi profile thu tối đa `PER_PROFILE_CHUNK = 50` mục cho một lượt, rồi chuyển sang profile kế tiếp. Profile mới tiếp tục **cùng truy vấn từ con trỏ hiện tại**; con trỏ không dùng được ở profile khác thì bắt đầu lại và bỏ qua mục trùng.
- Hết profile đủ điều kiện trước khi đủ `limit`: dừng, `status = done`, mã `no_profile_available`.

**Bài trong nhóm** (`group_feed`):
- Mỗi nhóm quét bằng một profile **đã tham gia nhóm đó**, theo `fb_poster_groups`; ưu tiên profile ít dùng nhất.
- Nhóm không có profile nào đã tham gia: thử bằng profile đủ điều kiện bất kỳ (nhóm công khai đọc được); đọc không được thì ghi `groups[<url>] = "not_member"` và sang nhóm khác.

**Gặp `logged_out` / `checkpoint` / `rate_limited` ở một profile:**
- Dừng dùng profile đó trong lượt quét, ghi lỗi vào `details_json`, chuyển sang profile khác.
- Với `logged_out` / `checkpoint`: cập nhật trạng thái đăng nhập qua `LoginChecker.observe(..., 'run')`, nên phát `profile.loginProblem` và có tin 🔒 Telegram như 26.19.

**Bot chỉ định:** `profileIds?` trong thao tác quét giới hạn việc xoay vòng trong danh sách đó. Profile trong danh sách vẫn phải đủ điều kiện.

**Cấu hình:** `app_settings` khoá `research_config`:
- `excludedProfileIds`: string[], mặc định `[]`;
- `perProfileDailyCap`: số nguyên, mặc định `500`, khoảng 50–5000.

## 6. Giới hạn an toàn

| Hằng số | Giá trị |
|---|---|
| `limit` mỗi lượt quét từ khoá | mặc định 200, tối đa 500 |
| `group_feed` | tối đa 20 nhóm mỗi lượt; `limitPerGroup` mặc định 30, tối đa 100; `sinceDays` mặc định 7, khoảng 1–30 (dừng nhóm đó khi gặp bài cũ hơn) |
| Nghỉ giữa hai trang | ngẫu nhiên 2–5 giây; giữa hai nhóm 5–10 giây |
| Trần mỗi ngày **theo từng profile** | tổng số mục profile đó thu trong 24 giờ gần nhất ≤ `perProfileDailyCap` (mặc định 500); chạm trần thì chuyển profile khác |
| Phần mỗi profile trong một lượt | `PER_PROFILE_CHUNK = 50` mục |
| Đồng thời | một lượt quét mỗi lúc (khe riêng của Nghiên cứu, độc lập với khe Đăng Facebook) |

## 7. Mã lỗi của lượt quét

| Mã | Ý nghĩa | Hành vi |
|---|---|---|
| `logged_out` | Hết phiên (ở một profile) | Bỏ profile đó, chuyển profile khác (mục 5); ghi vào `details_json` |
| `checkpoint` | Facebook yêu cầu xác minh (ở một profile) | Như trên |
| `rate_limited` | Bị chặn tạm thời (ở một profile) | Như trên; mục đã thu vẫn giữ |
| `query_changed` | Bắt lại truy vấn vẫn hỏng | Dừng |
| `parse_failed` | Đọc phản hồi hỏng ở trang đầu | Dừng (ở trang sau thì dừng, giữ mục đã thu) |
| `no_profile_available` | Không còn profile đủ điều kiện (tất cả bận, bị loại trừ, hỏng phiên hoặc chạm trần ngày) | Dừng, giữ mục đã thu; lúc bắt đầu mà không có profile nào thì `status = failed` |
| `cancelled` | Người dùng hoặc bot huỷ | `status = cancelled` |

Lỗi ở một profile (`logged_out`, `checkpoint`, `rate_limited`) không làm hỏng cả lượt, chỉ ghi vào `details_json`. Lượt quét dừng sớm vì `no_profile_available` hoặc `parse_failed` ở trang sau: `status = done`, kèm `error_code` để biết là chưa đủ. `query_changed`, `parse_failed` ở trang đầu, và không có profile nào lúc bắt đầu: `status = failed`.

## 8. Control API (chỉ thêm)

| Thao tác | Tham số | Kết quả |
|---|---|---|
| `research.search` | `source` (`posts`/`groups`/`pages`), `query` (1–100 ký tự), `recent?` (chỉ `posts`), `year?` (chỉ `posts`, từ 2010 tới năm hiện tại), `limit?` (1–500), `profileIds?` (≤ 50) | `{ scanId }`, chạy nền |
| `research.scanGroupFeeds` | `groupUrls?` (≤ 20 URL nhóm; bỏ trống = 20 nhóm được quét gần nhất trong `fb_poster_groups` của các profile đủ điều kiện), `sinceDays?`, `limitPerGroup?`, `profileIds?` | `{ scanId }` |
| `research.list` | `limit?` (≤ 200), `offset?`, `source?` | `{ total, scans[] }` |
| `research.get` | `scanId`, `sort?` (`engagement` mặc định / `recent` / `members`), `limit?` (≤ 500), `offset?` | `{ scan, total, items[] }` |
| `research.cancel` | không | `{ cancelled: boolean }` |

**Trường thêm ở mỗi mục trả về:**
- `engagement` = `reactions + comments + shares` (bỏ qua giá trị `null`; tất cả `null` thì `null`).
- `engagementRate` = `engagement / member_count` của nhóm nơi đăng, nếu biết số thành viên. Số thành viên lấy từ lượt quét `groups` gần nhất có nhóm đó; không biết thì `null`.

**Lỗi:**
- `BUSY`: đang có lượt quét khác.
- `INVALID_PARAMS`: tham số sai; `profileIds` có mã lạ → `NOT_FOUND` với `details.missing`.
- `NOT_FOUND`: `scanId` lạ.

**Sự kiện mới** `research.finished`: `{ scanId, source, query, status, errorCode, itemCount }`. `watch` không báo sự kiện này vì bot tự gọi.

## 9. Giao diện: tab "Nghiên cứu" trong Đăng Facebook

- **Đầu tab:** bảng nhỏ "Profile dùng để quét": mỗi profile có số mục đã quét trong 24 giờ / trần ngày, trạng thái đăng nhập, và ô **Không dùng để quét** (loại trừ). Có ô sửa trần ngày cho mỗi profile.
- **Form:** nguồn, từ khoá (hoặc chọn nhóm cho `group_feed`), bộ lọc (gần đây/năm), số lượng, nút **Quét**, tiến độ, nút **Huỷ**.
- **Danh sách lượt quét:** nguồn, từ khoá, thời gian, số mục, trạng thái/mã lỗi.
- **Bảng kết quả** của lượt quét đang chọn:
  - bài: nội dung (cắt), nơi đăng, người đăng (bấm mở link người đăng), cảm xúc, bình luận, chia sẻ, tổng tương tác, tỉ lệ, thời gian, nút mở link bài;
  - nhóm: tên, công khai/riêng tư, thành viên;
  - trang: tên, người theo dõi.
  - Sắp xếp theo cột, có phân trang.
- **Xuất Excel** cho lượt quét đang chọn (thư viện `xlsx` đã có sẵn).
- Theo `DESIGN.md`: sáng/tối, desktop và 390 px, không tràn ngang (bảng cuộn ngang trong khung riêng).

## 10. Cấu trúc mã

- `src/services/research/`:
  - `schema.ts`, `ResearchStore.ts`;
  - `parsers.ts` (thuần);
  - `graphqlSession.ts`: đọc mã phiên, bắt và lưu truy vấn, gọi `fetch` trong trang;
  - `ResearchService.ts`: chạy lượt quét, khe, giới hạn, huỷ, sự kiện;
  - `researchConfig.ts`.
- `electron/ipc/researchIpc.ts`, gồm:
  - kênh `research:getConfig`, `research:setConfig`, `research:search`, `research:scanGroupFeeds`, `research:list`, `research:get`, `research:cancel`, `research:exportXlsx`;
  - sự kiện `research:progress`, `research:finished`;
  - preload và typings.
- Control API: 5 thao tác trong `ControlMethods.ts`, sự kiện trong `controlEvents.ts`.
- UI: `src/ui/features/facebookPoster/ResearchTab.tsx`, tách các thành phần con nếu quá lớn, và mục điều hướng.
- **Tài liệu:**
  - `SYSTEM_DOCUMENTATION.md`;
  - `docs/protocol/maihub-control-protocol.md`;
  - báo cáo bước thử;
  - mục "Nguồn hoãn" ghi vào spec này nếu có.

## 11. Kiểm thử

- **Bộ đọc:** test trên mẫu đã làm sạch từ bước thử, với mỗi nguồn:
  - đủ trường;
  - phản hồi nhiều dòng;
  - trường thiếu → `null`;
  - đọc đúng người đăng (cá nhân và trang: tên, ID, link);
  - số dạng "1,2K";
  - phản hồi lỗi → mã ở mục 7.
- **`graphqlSession`:**
  - với trang giả: bắt truy vấn từ request;
  - lần sau dùng lại;
  - truy vấn hỏng → bắt lại một lần;
  - bị chuyển tới `/login` hoặc `/checkpoint` → mã đúng.
- **`ResearchService`** (giả trình duyệt và đồng hồ):
  - giới hạn `limit` và trần ngày;
  - nghỉ giữa trang;
  - huỷ;
  - một lượt mỗi lúc;
  - xoay vòng: chọn đúng profile ít dùng nhất, chuyển profile sau 50 mục, bỏ profile bị loại trừ, đang bận, hỏng phiên hoặc chạm trần;
  - một profile gặp `checkpoint` → chuyển profile, ghi `details_json`, gọi `observe` cập nhật trạng thái đăng nhập;
  - `group_feed` dùng profile đã tham gia nhóm; nhóm không ai tham gia → `not_member`;
  - không còn profile → `no_profile_available`;
  - `group_feed` dừng khi gặp bài quá `sinceDays`;
  - lưu ngay từng trang.
- **Store:** schema, `UNIQUE`, dọn 180 ngày, tính `engagement`/`engagementRate`.
- **Control API:** kiểm tham số, `BUSY`, `NOT_FOUND`, sự kiện.
- **Chạy thật** (sau bước thử, chỉ đọc, với profile anh chỉ định): mỗi nguồn một lượt nhỏ (`limit = 20`); giao diện ở 1280/390 px, sáng/tối; xuất Excel.
- **Hồi quy:** toàn bộ jest; Đăng Facebook chạy song song với một lượt quét không bị ảnh hưởng.

## 12. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Facebook giới hạn hoặc checkpoint một tài khoản vì quét | Xoay vòng nhiều profile, mỗi profile ≤ 500 mục/ngày và ≤ 50 mục mỗi lượt; nghỉ giữa trang; gặp tín hiệu thì bỏ profile đó ngay và báo 🔒; danh sách loại trừ cho tài khoản quan trọng |
| Facebook đổi `doc_id` / biến | Tự bắt lại từ request thật; mã `query_changed` khi không bắt được |
| Facebook đổi cấu trúc phản hồi | Bộ đọc thuần có test trên mẫu; trường không đọc được thì `null` thay vì sai; `parse_failed` khi hỏng hẳn |
| Trái điều khoản Facebook | Anh đã chấp nhận rủi ro; chỉ đọc, giới hạn số lượng, không thu danh sách người dùng |
| Hai trình duyệt chạy cùng lúc (đăng bài + quét) tốn RAM VPS | Một lượt quét mỗi lúc; lượt quét ngắn (vài phút) |
| Dữ liệu cá nhân (tên, ID người đăng) | Chỉ lưu người đăng của bài (không quét danh sách thành viên hay người tương tác); chỉ dùng nội bộ; tự xoá sau 180 ngày; mẫu test trong repo dùng dữ liệu giả |

## Ghi chú sau phát hành (26.20.0, 19/10/2026)

Những chỗ code khác thân spec ở trên (chi tiết ở mục "Điều chỉnh khi triển khai" của plan):

- **§2 Bước thử:** chưa đo được trên Facebook thật.
  - Bộ đọc dựa trên cấu trúc API đã biết (`docs/reports/2026-10-19-topic-research-spike.md`), tìm theo tên khoá.
  - `doc_id` và biến mẫu học lúc chạy.
  - Khi đọc hỏng hoặc ra 0 mục, lượt quét lưu `details.shape` (chỉ đường dẫn khoá và kiểu, không có giá trị) để sửa nhanh.
  - Lần chạy thật đầu tiên trên VPS là lần kiểm chứng.
- **§3, §6 Phân trang và giới hạn:**
  - Tối đa `MAX_PAGES_PER_SCAN = 200` trang mỗi lượt.
  - Lặp con trỏ hoặc 2 trang liền không có mục mới thì dừng phần của profile đó.
  - Hai profile liên tiếp không dùng lại được con trỏ thì dừng lượt quét với `details.note = 'cursor_not_portable'`.
  - Request treo quá 30 giây thì bỏ qua profile đó.
- **§7 Mã lỗi:**
  - Chỉ chuyển hướng tới `/login` hoặc `/checkpoint` mới tính là `logged_out` / `checkpoint` (cập nhật trạng thái đăng nhập).
  - HTTP 401/403 tính là `rate_limited`.
  - Lỗi không lường trước: `status = failed`, `error_code` rỗng, câu `Lỗi nội bộ: …`.
- **§4.1 `details_json`** có thêm:
  - `note`: `cursor_not_portable` / `no_groups`;
  - trạng thái nhóm: `not_member` / `unresolved` / `empty`;
  - `shape`.
- **Bảng tin nhóm:** link nhóm dạng tên (slug) được đổi sang ID thật bằng cách mở trang nhóm. Mỗi nhóm như vậy chậm thêm khoảng 18 giây.
- **An toàn:**
  - Link từ dữ liệu quét chỉ mở được qua kênh `research:openLink` (https, `facebook.com`).
  - Không bắt đầu quét khi đang đổi workspace.
  - Lượt quét chưa dừng thì không cho đổi workspace.
- **Thêm kênh** `research:status`.
