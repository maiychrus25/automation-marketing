# Báo cáo bước thử: cấu trúc API GraphQL cho Nghiên cứu chủ đề

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 19/10/2026 |
| Spec | `docs/specs/2026-10-19-topic-research.md` §2 |
| Cách làm | **Chưa đo trên trang thật.** Anh giao em tự làm. Trên máy dev không có profile Facebook nào đã đăng nhập; VPS chỉ mở RDP. Nội dung dưới đây tổng hợp từ cấu trúc API Facebook đã biết (gồm các đường dẫn trường mà repo `babyvibe/facebook-scan-data-extension` cho thấy; chỉ lấy thông tin về API, không chép code). |
| Hệ quả | Bộ đọc tìm theo **tên khoá** thay vì đường dẫn cố định; `doc_id` và biến mẫu được **học lúc chạy** từ request thật; khi đọc hỏng thì lưu **hình dạng phản hồi** (khoá và kiểu, không có giá trị). Lần chạy thật đầu tiên trên VPS là lần kiểm chứng. |

## 1. Mã phiên

| Giá trị | Nguồn trong trang (thử lần lượt) |
|---|---|
| `fb_dtsg` | `require('DTSGInitialData').token`; dự phòng: tìm `"DTSGInitialData",[],{"token":"…"}` trong HTML; hoặc `input[name="fb_dtsg"]` |
| `lsd` | `require('LSD').token`; dự phòng: `"LSD",[],{"token":"…"}` trong HTML |
| ID người dùng | `require('CurrentUserInitialData').USER_ID`; dự phòng: cookie `c_user` (đọc qua context, không lưu) |

Thân request `POST /api/graphql/` (dạng `application/x-www-form-urlencoded`):
- `av` và `__user` là ID người dùng;
- `__a=1`, `fb_dtsg`, `lsd`;
- `fb_api_caller_class=RelayModern`, `fb_api_req_friendly_name`;
- `variables` là chuỗi JSON;
- `server_timestamps=true`;
- `doc_id`.

Header kèm theo: `x-fb-friendly-name`, `x-fb-lsd`. Gọi từ trong trang nên `Origin` và `Referer` đúng sẵn.

## 2. Học truy vấn lúc chạy

- Trang đầu của kết quả tìm kiếm và bảng tin nhóm thường **nhúng sẵn trong HTML**. Request GraphQL chỉ xuất hiện khi **cuộn để tải thêm**.
- Vì vậy `ensureQuery`: mở URL kích hoạt, cuộn xuống tối đa 6 lần (mỗi lần nghỉ 1,5–3 giây) cho tới khi bắt được request có `fb_api_req_friendly_name` đúng tên. Lưu lại `doc_id` và `variables` của request đó làm mẫu.
- Khi gọi: lấy biến mẫu, thay `cursor`, `count` và từ khoá/bộ lọc (mục 3), giữ nguyên các biến `__relay_internal__…`.
- Trang đầu cũng lấy bằng chính truy vấn đó, với `cursor = null`, nên không cần đọc HTML.

| Nguồn | URL kích hoạt | `fb_api_req_friendly_name` |
|---|---|---|
| `posts` | `https://www.facebook.com/search/posts?q=<từ khoá>` | `SearchCometResultsPaginatedResultsQuery` |
| `groups` | `https://www.facebook.com/search/groups?q=<từ khoá>` | `SearchCometResultsPaginatedResultsQuery` |
| `pages` | `https://www.facebook.com/search/pages?q=<từ khoá>` | `SearchCometResultsPaginatedResultsQuery` |
| `group_feed` | `https://www.facebook.com/groups/<id>/?sorting_setting=CHRONOLOGICAL` | `GroupsCometFeedRegularStoriesPaginationQuery` |

**Ghi chú:**
- Ba nguồn tìm kiếm dùng chung một truy vấn, nên lưu mẫu theo khoá `<friendly_name>:<source>` để biến của từng tab không lẫn nhau.
- Nếu không bắt được tên dự kiến, chấp nhận request GraphQL đầu tiên có tên chứa `Search` + `Results` (cho tìm kiếm) hoặc `GroupsCometFeed` (cho bảng tin), và ghi tên thật vào báo cáo hình dạng.

## 3. Biến của truy vấn tìm kiếm

```json
{ "count": 5, "cursor": null,
  "args": { "text": "<từ khoá>", "experience": { "type": "POSTS_TAB | GROUPS_TAB | PAGES_TAB" },
            "filters": ["<chuỗi JSON bộ lọc>", "…"] } }
```

Bộ lọc là mảng các chuỗi JSON:
- gần đây: `{"name":"recent_posts","args":""}`;
- theo năm: `{"name":"creation_time","args":"{\"start_year\":\"2025\",\"start_month\":\"2025-1\",\"end_year\":\"2025\",\"end_month\":\"2025-12\"}"}`;
- nhóm công khai (không dùng): `{"name":"public_groups","args":""}`.

Chỉ thay `args.text`, `args.filters`, `cursor`, `count`. Giữ nguyên các khoá còn lại của mẫu.

## 4. Đường dẫn trường (dự kiến) và cách đọc bền

Phản hồi có thể bắt đầu bằng `for (;;);` và gồm nhiều dòng JSON (dòng sau là phần `@defer`/`@stream`). Gộp mọi dòng trước khi đọc.

### 4.1 Tìm kiếm

- **Kết quả:** `data.serpResponse.results.edges[]`.
- **Con trỏ:** `data.serpResponse.results.page_info.end_cursor`, có thể nằm ở dòng sau.
- Mỗi cạnh có `rendering_strategy` hoặc `relay_rendering_strategy` → `view_model`.

**Bài (`POSTS_TAB`):** `view_model.click_model.story` là đối tượng `Story`.

| Trường | Đường dẫn dự kiến | Đọc bền |
|---|---|---|
| ID bài | `story.post_id` | khoá `post_id` đầu tiên trong `story` |
| Nội dung | `story.comet_sections.content.story.message.text` | khoá `message.text` đầu tiên |
| Cảm xúc | `…feedback.story.story_ufi_container.story.feedback_context.feedback_target_with_context.comet_ufi_summary_and_actions_renderer.feedback.reaction_count.count` | khoá `reaction_count.count` đầu tiên |
| Bình luận | `…feedback.comments_count_summary_renderer.feedback.comment_rendering_instance.comments.total_count` | `comment_rendering_instance.comments.total_count`, hoặc `comment_count.total_count` |
| Chia sẻ | `…feedback.share_count.count` | khoá `share_count.count` đầu tiên |
| Thời gian | `story.comet_sections.timestamp.story.creation_time` (giây) | khoá `creation_time` đầu tiên, nhân 1000 |
| Người đăng | `actors[0]` = `{ __typename: 'User' \| 'Page', id, name, url }` | mảng `actors` đầu tiên trong `story` |
| Nơi đăng | `story.to` = `{ __typename: 'Group' \| 'Page', id, name, url }` | nếu thiếu: lấy ID nhóm từ link bài `/groups/<id>/` |
| Link bài | `story.url`, `story.wwwURL` hoặc `permalink_url` | khoá đầu tiên có giá trị bắt đầu bằng `https://www.facebook.com/` và chứa `/posts/`, `/permalink/` hoặc `story_fbid` |

**Nhóm (`GROUPS_TAB`):**
- `view_model.profile` = `{ id, name, url, profile_picture.uri }`.
- `view_model.primary_snippet_text_with_entities.text`, ví dụ `"Công khai · 12K thành viên · 10+ bài viết/ngày"`. Tách theo ` · `: phần tử 0 là quyền riêng tư (`Công khai`/`Public` → `public`; `Riêng tư`/`Private` → `private`), phần tử 1 là số thành viên (`parseCompactNumber`).

**Trang (`PAGES_TAB`):**
- `view_model.profile` = `{ id, name, url }`.
- Đoạn mô tả có `"… · 1,2 Tr người theo dõi"`: tìm phần chứa `theo dõi` hoặc `follow`, rồi đọc số.

### 4.2 Bảng tin nhóm

- **Bài:** `data.node.group_feed.edges[].node`, mỗi bài là `Story` cùng cấu trúc với mục 4.1.
- **Con trỏ:** `data.node.group_feed.page_info.end_cursor`.
- **Nơi đăng:** chính nhóm đó. Lấy từ `story.to`, nếu thiếu thì dùng nhóm đang quét.

### 4.3 Số dạng chữ

| Dạng | Ví dụ |
|---|---|
| Hàng nghìn | `1,2K`, `1.2K`, `12 N`, `12 nghìn` → ×1.000 |
| Hàng triệu | `1,5M`, `1,5 Tr`, `1,5 triệu` → ×1.000.000 |
| Dấu phân cách hàng nghìn | `1.234`, `1,234` → 1234 (không có hậu tố) |

## 5. Lỗi

| Dấu hiệu | Mã |
|---|---|
| Điều hướng tới `/login` hoặc có form đăng nhập; GraphQL `error` hoặc `errors[].code` thuộc `1357001`, `1357004` (hết phiên / chưa đăng nhập) | `logged_out` |
| Điều hướng tới `/checkpoint`; thông báo chứa `checkpoint` | `checkpoint` |
| `errors[].code` thuộc `1390008`, `368`, `1675004`; thông báo chứa `temporarily blocked`, `tạm thời bị chặn`, `rate limit`, `too many` | `rate_limited` |
| Thông báo chứa `PersistedQueryNotFound`, `doc_id`, `not found` gắn với truy vấn; phản hồi rỗng sau khi đã bắt mẫu | **bắt lại một lần**; vẫn hỏng → `query_changed` |
| JSON hỏng; không có `data` và không có lỗi nhận diện được | `parse_failed` (lưu hình dạng) |

Các mã số trên là các mã thường gặp và **chưa đo**. Mọi lỗi không nhận diện được đều rơi về `parse_failed` kèm hình dạng phản hồi để sửa nhanh.

## 6. Chẩn đoán "hình dạng phản hồi"

Hàm `describeShape(json, maxDepth = 8, maxKeys = 400)` trả danh sách đường dẫn khoá kèm kiểu (`string`, `number`, `bool`, `null`, `array[n]`, `object`), **không kèm giá trị**. Nó được gọi khi:
- trang đầu ra 0 mục, hoặc
- gặp `parse_failed`.

Kết quả lưu vào `details_json.shape` của lượt quét (tối đa 20 KB) và hiện trong chi tiết lượt quét ở app và `research.get`.

## 7. Dữ liệu mẫu cho test

`src/__tests__/research/fixtures/` gồm **mẫu tổng hợp** theo cấu trúc ở mục 4, với toàn bộ tên, ID, link là giả:
- mỗi nguồn 1 trang kết quả nhiều dòng JSON có `for (;;);`;
- 1 trang thiếu trường;
- các mẫu lỗi ở mục 5.

Khi có dữ liệu thật (từ bản chẩn đoán trên VPS), thêm mẫu mới đã làm sạch vào cùng thư mục.
