# Thiết kế: Hộp thư Page Facebook qua tài khoản cá nhân (đợt 1)

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 05/10/2026 |
| Trạng thái | Đã duyệt (05/10/2026) |
| Intent | `docs/intent/2026-10-03-facebook-page-inbox.md` (hướng A: giao thức không chính thức qua phiên cá nhân) |
| Bằng chứng kỹ thuật | `docs/reports/2026-10-03-facebook-page-inbox-spike.md` |
| Kế hoạch triển khai | `docs/plans/2026-10-03-facebook-page-inbox.md` |

## 1. Mục tiêu

Mỗi Page mà một tài khoản Facebook cá nhân trong MaiHub quản trị có thể được bật thành một **tài khoản con** dưới tài khoản cá nhân đó. Page đã bật có hộp thư riêng: danh sách hội thoại, nhận tin thời gian thực, trả lời văn bản và ảnh. Chat, CRM, nhãn, AI và Workflow coi Page là một tài khoản Facebook bình thường, nhận diện bằng `accountId` của chính nó.

Đợt 1 đạt khi:

1. Từ một tài khoản cá nhân đã kết nối, người dùng xem được danh sách Page mình quản trị (tên, ảnh) và bật/tắt từng Page.
2. Page đã bật hiện trong Sidebar ngay dưới tài khoản cha, thụt lề, có dấu hiệu "Page".
3. Có tin từ khách nhắn vào Page: hội thoại xuất hiện trong danh sách chat của Page, tin mới về thời gian thực, không lẫn sang hộp thư cá nhân.
4. Trả lời văn bản và ảnh từ MaiHub với vai Page. Khách nhận được tin từ Page, không phải từ tài khoản cá nhân.
5. Workflow có trigger "Khi nhận tin nhắn" (`fb.trigger.message`) chọn được Page trong danh sách tài khoản và chạy khi Page nhận tin. Khách nhắn Page thành liên hệ của Page.
6. Tắt Page: ngắt kết nối, ẩn khỏi Sidebar và các danh sách tài khoản, giữ lại dữ liệu. Bật lại thì thấy lại lịch sử.
7. Cập nhật cookie, xóa hoặc thêm lại tài khoản cá nhân thì các Page con đi theo (mục 10).
8. Messenger cá nhân, workflow Facebook và CRM Facebook của tài khoản cá nhân không đổi hành vi.

Tiêu chí 3, 4 và phần "chạy khi Page nhận tin" của tiêu chí 5 chỉ được coi là đạt sau khi anh kiểm tay bằng tin nhắn thật (mục 14.2). Đây là phần spike chưa chứng minh được.

## 2. Ngoài phạm vi

- Bình luận trên bài đăng của Page (đợt sau, theo intent).
- Instagram và WhatsApp trong hộp thư Business Suite.
- Graph API, Page Access Token, app Facebook Developers, webhook.
- Lấy lịch sử tin cũ của Page ngoài những gì `fb:getThreads` và luồng đồng bộ ban đầu đã làm cho tài khoản cá nhân.
- Quét dữ liệu (`FacebookScanService`), kết bạn, ghi chú (Notes), đổi giao diện thread và các tính năng E2EE với vai Page.
- Hướng dự phòng khi MQTT không phát tin Page (polling, LightSpeed, Business Suite). Nếu kiểm tay cho thấy không nhận được tin, em dừng và báo lại, không tự làm hướng khác.
- Thêm Page bằng cách dán cookie riêng của Page.

## 3. Giả định chưa được chứng minh

Spike đã xác nhận: liệt kê Page qua `bookmarks/pages`, và phiên dựng từ cookie cá nhân cộng `i_user=<id Page>` qua `initSession` trả `FacebookID` = id Page cùng `fb_dtsg` mới. Thread list cũ trả 200 không lỗi.

Spike chưa xác nhận ba điều sau, và thiết kế này giả định chúng đúng:

- **G1.** `getThreadList` với phiên Page trả hội thoại của Page khi Page có tin.
- **G2.** `FacebookMQTTListener` kết nối bằng phiên Page nhận được tin gửi vào Page.
- **G3.** `FacebookMessageSender.sendMessage` với phiên Page gửi được tin với vai Page.

Theo quyết định của chủ sản phẩm ngày 05/10/2026, việc xây dựng đi trước. G1–G3 được kiểm ở mục 14.2 trước khi gộp nhánh. Nếu G1 hoặc G2 sai, tính năng không đạt và sẽ không gộp.

## 4. Kiến trúc

```
Renderer
  AddAccountModal (bước "Chọn Page" sau khi kết nối FB)   AccountCard (menu "Quản lý Page")
        └──────────────── FacebookPagesPanel ────────────────┘
                 │ ipc.fb.listPages / ipc.fb.setPageEnabled
  SidebarAccounts ── orderAccountsWithChildren(accounts): Page đứng sau tài khoản cha
Preload (contextBridge)
  facebookIpc.ts: fb:listPages, fb:setPageEnabled (+ sửa các chỗ đọc cookie, xóa, cập nhật cookie, thêm tài khoản)
        │
  FacebookPages.ts ── parseManagedPages(html), fetchManagedPages(cookie, agent), buildPageCookie(cookie, profileId)
  FacebookAccountCookie.ts ── resolveFBCookie(account): dựng cookie Page từ cookie cha lúc chạy
  FacebookService ── biết mình là Page (fb_accounts.parent_facebook_id), bỏ E2EE bridge, gửi qua REST
  DatabaseService ── 3 cột mới trên fb_accounts, các hàm đọc ghi Page
```

### 4.1 Các đơn vị

| Đơn vị | Vị trí | Trách nhiệm |
|---|---|---|
| `FacebookPages.ts` (mới) | `src/services/facebook/FacebookPages.ts` | Hàm thuần `parseManagedPages`, `stripPageCookie`, `buildPageCookie`; `fetchManagedPages` gọi HTTP. Không import `electron` để test được |
| `FacebookAccountCookie.ts` (mới) | `src/services/facebook/FacebookAccountCookie.ts` | `resolveFBCookie(account)`: tài khoản cá nhân thì đọc như hiện nay; Page thì đọc cookie cha rồi `buildPageCookie` |
| `DatabaseService` (sửa) | `src/services/database/DatabaseService.ts` | Migration 3 cột, `getFBPageChildren(parentFacebookId)`, `setFBPageEnabled` |
| `FacebookService` (sửa) | `src/services/facebook/FacebookService.ts` | Nhận diện Page; bỏ E2EE bridge; gửi văn bản và ảnh qua REST; `isSelf` tính cả `delegate_page_id` |
| `facebookIpc.ts`, `loginIpc.ts` (sửa) | `electron/ipc/` | Handler mới, đổi các chỗ đọc cookie sang `resolveFBCookie`, vòng đời theo tài khoản cha |
| `FacebookPagesPanel` (mới) | `src/ui/components/facebook/FacebookPagesPanel.tsx` | Danh sách Page có công tắc, dùng chung cho hai chỗ |
| `orderAccountsWithChildren` (mới) | `src/ui/lib/accountTree.ts` | Hàm thuần sắp Page sau tài khoản cha |
| Sidebar, AccountCard, AddAccountModal (sửa) | `src/ui/components/...` | Hiển thị con, menu, bước chọn Page |

## 5. Dữ liệu

Một Page đã từng bật có **một dòng `fb_accounts`** và **một dòng `accounts`**, giống tài khoản cá nhân:

- `fb_accounts.id` là uuid mới. `fb_accounts.facebook_id` là id profile của Page (dạng `6159…`, chính là `FacebookID` mà `initSession` trả về với cookie `i_user`).
- `accounts.zalo_id` = id profile Page, `channel = 'facebook'`, `proxy_id` = `proxy_id` của tài khoản cha tại lúc bật.
- Vì `facebook_id` của Page là duy nhất và khác id cá nhân, các hàm `resolveInternalId`, `getFBAccountByFacebookId`, `resolveInstanceKey` và mọi payload sự kiện (`fbAccountId`) dùng được nguyên trạng.

Ba cột mới trên `fb_accounts`, thêm bằng mẫu migration `PRAGMA table_info` + `ALTER TABLE ... ADD COLUMN` đang dùng ở `DatabaseService.ts` (cạnh migration `fb_messages.edit_history`):

| Cột | Kiểu | Ý nghĩa |
|---|---|---|
| `parent_facebook_id` | `TEXT NULL` | `facebook_id` của tài khoản cá nhân cha. `NULL` = tài khoản cá nhân |
| `delegate_page_id` | `TEXT NULL` | id Page cổ điển từ `bookmarks/pages` (ví dụ `1254744041053955`) |
| `enabled` | `INTEGER NOT NULL DEFAULT 1` | 0 = Page đã tắt |

Liên kết cha dùng `facebook_id` chứ không dùng uuid, vì thêm lại tài khoản cá nhân (`_addFBAccountCommon`) xóa dòng cũ và tạo uuid mới. Dùng `facebook_id` thì Page con vẫn gắn đúng cha.

Không thêm cột `page_profile_id` như bản kế hoạch bàn giao, vì nó trùng `facebook_id`.

Cookie của Page **không lưu**: không gọi `secureSet` cho Page, `cookie_encrypted = ''`. `session_data` của Page vẫn được ghi như tài khoản cá nhân. Như hiện nay, nó chứa `cookieFacebook`, ở đây là cookie cha cộng `i_user`.

Tắt Page: `fb_accounts.enabled = 0` và `accounts.is_active = 0`. `DatabaseService.getAccounts()` đã lọc `is_active = 1`, nên Page tắt tự biến mất khỏi Sidebar, Dashboard, Settings và bộ chọn tài khoản của Workflow. `fb_threads`, `fb_messages`, `contacts` và `messages` của Page được giữ nguyên.

## 6. Cookie và phiên

`stripPageCookie(cookie: string): string` tách cookie theo `;` và bỏ mọi cặp `i_user=…`, giữ nguyên các cặp khác. `buildPageCookie(cookie: string, profileId: string): string` = `stripPageCookie(cookie)` rồi nối thêm `i_user=<profileId>`. Cả hai là hàm thuần trong `FacebookPages.ts`.

`resolveFBCookie(account: FBAccountRow): string | null`:

- `parent_facebook_id` rỗng: trả `secureGet(fbCookieKey(account.id)) || account.cookie_encrypted || null`, đúng như các chỗ đọc hiện nay.
- Có `parent_facebook_id`: tìm cha bằng `getFBAccountByFacebookId`. Không có cha hoặc cha không có cookie thì trả `null`. Có thì trả `buildPageCookie(cookieCha, account.facebook_id)`.

Mọi chỗ đang đọc cookie Facebook theo mẫu `secureGet(fbCookieKey(id)) || cookie_encrypted` chuyển sang `resolveFBCookie`: `FacebookService.getInstance`, `getFBServiceOrReconnect`, `reconnectAllFBAccounts`, `fb:connect`, `fb:refreshProfile`. Kế hoạch sẽ liệt kê đủ danh sách bằng grep.

Proxy của Page lấy từ tài khoản cha mỗi lần kết nối: Page phải đi cùng IP với cookie cha. Chỗ tra `accounts.proxy_id` theo `facebook_id` khi kết nối dùng `parent_facebook_id` nếu có.

Mỗi Page có một `FacebookService` riêng (khóa theo uuid của Page, như hiện nay), tức là phiên riêng, `fb_dtsg` riêng và `FacebookMQTTListener` riêng. Kết nối kiểm thêm một điều: `initSession` phải trả `FacebookID === account.facebook_id`. Nếu khác, Facebook đã không chuyển vai, và kết nối thất bại với lỗi "Không chuyển được sang Page <tên>. Kiểm tra quyền quản trị Page."

## 7. Liệt kê Page

`fetchManagedPages(cookie: string, httpsAgent?: any): Promise<ManagedPage[]>`:

- GET `https://www.facebook.com/bookmarks/pages` với `fbHeaders(cookie)`, theo đúng spike (header tối giản bị 400).
- Trước khi gọi, hàm chạy `stripPageCookie(cookie)` để luôn hỏi với vai tài khoản cá nhân.

```ts
interface ManagedPage {
    profileId: string;        // node.id, id profile Page thế hệ mới
    name: string;
    delegatePageId: string | null;
    avatarUrl: string | null; // node.profile_picture.uri
}
```

`parseManagedPages(html: string): ManagedPage[]`:

- Tìm mọi chỗ xuất hiện khóa `"additional_profiles_with_biz_tools"` và lấy giá trị JSON cân ngoặc ngay sau dấu `:`.
- Duyệt đệ quy để gom mọi object có `id` và `name` là chuỗi, khử trùng theo `id`.
- Không tìm thấy khóa thì trả `[]`. JSON hỏng thì bỏ qua đoạn đó, không ném lỗi.
- Page không có `delegate_page_id` vẫn được nhận (Page cổ điển hoặc thiếu trường).

## 8. IPC mới

Cả hai handler nhận `accountId` theo kiểu `resolveInternalId` (uuid hoặc `facebook_id`) và trả `{ success: false, error }` thay vì ném lỗi.

**`fb:listPages({ accountId })`** → `{ success: true, pages: Array<ManagedPage & { enabled: boolean }> }`

- Tài khoản phải là tài khoản cá nhân. Gọi trên Page thì trả lỗi "Tài khoản này là Page".
- `enabled` = có dòng con `parent_facebook_id = cha.facebook_id`, `facebook_id = profileId`, `enabled = 1`.
- Dòng con có `enabled = 1` mà không còn trong kết quả của Facebook (mất quyền quản trị) vẫn được trả về, với `enabled: true` và tên/ảnh từ DB, để người dùng tắt được.

**`fb:setPageEnabled({ accountId, profileId, enabled })`** → `{ success: true }`

- Bật:
  1. Gọi lại `fetchManagedPages` bằng cookie cha. `profileId` phải có trong kết quả, nếu không trả lỗi "Tài khoản không quản trị Page này".
  2. Dựng cookie Page và chạy `initSession`, kiểm `FacebookID === profileId` (mục 6).
  3. Ghi dòng `fb_accounts`: dùng lại uuid nếu đã có dòng cũ, cập nhật tên, ảnh, `delegate_page_id`, `enabled = 1`.
  4. Upsert `accounts` với `is_active = 1` và proxy của cha.
  5. `FacebookConnectionManager.getOrCreate(uuid, cookiePage, proxyCha)`.
  6. Nếu bất kỳ bước nào sau bước 2 lỗi, dòng ở lại với `enabled = 0` và `is_active = 0`, rồi trả lỗi.
- Tắt: `FacebookConnectionManager.disconnect(uuid)`, `enabled = 0`, `accounts.is_active = 0`. Tắt một Page đã tắt hoặc chưa từng bật vẫn trả `success: true`.

Preload thêm `ipc.fb.listPages` và `ipc.fb.setPageEnabled` theo mẫu `fb:*` hiện có.

## 9. Kết nối, khởi động, nghe tin

- `reconnectAllFBAccounts` bỏ qua dòng `enabled = 0`. Page có cha không còn cookie thì ghi log và bỏ qua, không làm hỏng vòng lặp.
- `FacebookService` đọc dòng `fb_accounts` của mình khi kết nối để biết `isPage` (có `parent_facebook_id`) và `delegatePageId`.
- Với Page: **không gọi `startE2EEBridge`**. Bridge dùng `c_user` + `xs` và sẽ chạy với vai tài khoản cá nhân.
- `FacebookMQTTListener` được tạo như hiện nay bằng `dataFB` của Page. `dataFB.cookieFacebook` đã mang `i_user`, và `u` là id Page.
- `isSelf` của tin đến là `true` khi `userID` bằng `FacebookID` hoặc bằng `delegatePageId`, phòng trường hợp Facebook gắn tin của Page bằng id cổ điển.
- Sự kiện ra renderer giữ nguyên tên kênh và payload. `fbAccountId` = `facebook_id` của Page.
- Đồng bộ ban đầu (`fbInitUtils`, khóa theo id tài khoản) tự chạy cho Page mới, không cần sửa.

## 10. Vòng đời cùng tài khoản cha

| Sự kiện trên tài khoản cha | Hành vi với các Page con |
|---|---|
| `fb:updateCookie` thành công | Mỗi Page con `enabled = 1`: ngắt kết nối và kết nối lại bằng cookie mới dựng lại |
| `fb:addAccount` / `fb:addAccountWithCredentials` (thêm lại cùng tài khoản) | Như trên, sau khi tài khoản cha đã lưu |
| `fb:removeAccount` | Mỗi Page con, kể cả đã tắt, bị xóa theo đúng đường của `fb:removeAccount` |
| `login:removeAccount` | Mỗi Page con đi cùng đường, cùng giá trị `deleteWithData` |
| `fb:disconnect` | Không động tới Page con. Mỗi tài khoản tự ngắt |
| Cookie cha hết hạn | Page con cũng hết hạn khi kết nối lại. Trạng thái hiện theo từng dòng như hiện nay |

`_addFBAccountCommon` chạy `stripPageCookie` trên cookie người dùng dán vào trước khi chạy `initSession`. Như vậy một cookie có sẵn `i_user` không biến thành "tài khoản cá nhân" mang id Page, và không xóa nhầm dòng Page có cùng `facebook_id`.

## 11. Gửi tin với vai Page

- Văn bản: `FacebookService.sendMessage` của Page luôn dùng REST `FacebookMessageSender.sendMessage(dataFB, …)`, không thử E2EE bridge, với cả `typeChat` `user` và `group`. Hàm này đặt người gửi = `dataFB.FacebookID` = id Page.
- Ảnh và tệp: `fb:sendAttachment` / `fb:sendAttachments` cho Page đi đường của nhóm cho mọi loại thread: `uploadAttachment` rồi `sendMessage` qua REST. Đường bắt buộc có bridge cho 1:1 không áp dụng.
- Thu hồi, cảm xúc, sửa tin dùng các hàm REST hiện có với `dataFB` của Page. Đợt này không kiểm riêng; lỗi trả về như hiện nay.
- Lưu tin đã gửi và chống tự vọng (`markMessageLocallySent`) giữ nguyên.

## 12. Giao diện

Theo `DESIGN.md`: dùng lại lớp `.app-account`, token màu, không mã hex trong component mới. Công tắc dùng `role="switch"`, `aria-checked` và `aria-label`. Light và dark mode như nhau.

**`FacebookPagesPanel`** (`accountId` của tài khoản cha):

- Đang tải: hàng xương.
- Lỗi: thông báo cùng nút "Thử lại".
- Danh sách rỗng: "Tài khoản này chưa quản trị Page nào".
- Mỗi hàng có ảnh Page, tên và công tắc. Công tắc khóa trong lúc chờ IPC. Lỗi thì trả công tắc về vị trí cũ và hiện thông báo lỗi trên hàng đó.

**AddAccountModal:** sau khi thêm tài khoản Facebook thành công (cả hai tab), gọi `fb:listPages`. Có ít nhất một Page thì chuyển sang bước "Chọn Page" với `FacebookPagesPanel` và nút "Xong". Không có Page, hoặc lỗi, thì đóng như hiện nay.

**AccountCard (Dashboard):**

- Tài khoản Facebook cá nhân có thêm mục menu "Quản lý Page", mở hộp thoại chứa `FacebookPagesPanel`.
- Với Page: ẩn "Cập nhật Cookie", và hiện dòng phụ "Page của <tên tài khoản cha>".
- "Xóa tài khoản" trên Page xóa Page như xóa tài khoản. Lần sau mở "Quản lý Page", Page đó hiện là tắt.

**SidebarAccounts:**

- `orderAccountsWithChildren(accounts)` sắp lại danh sách hiển thị. Mỗi tài khoản cha ở vị trí cũ, các Page con (theo `parent_zalo_id`) đứng ngay sau, theo thứ tự xuất hiện. Page có cha không nằm trong danh sách (cha đã bị ẩn hoặc lọc) đứng ở vị trí của chính nó.
- Hàng Page thụt lề và có biểu tượng Page nhỏ ở góc ảnh.
- Hàng Page không kéo thả được. Kéo tài khoản cha thì Page con đi theo, vì thứ tự được dựng lại mỗi lần render.
- Thu gọn Sidebar: không thụt lề, vẫn có biểu tượng góc ảnh.
- Ô lọc khớp tên Page thì hiện Page, không bắt buộc hiện cha.

`login:getAccounts` thêm trường `parent_zalo_id` (= `fb_accounts.parent_facebook_id`, `null` với mọi tài khoản khác) cho dòng Facebook. `AccountInfo` thêm trường tùy chọn này, và phép so sánh trong `setAccounts` tính cả nó.

Workflow, CRM và Chat không sửa giao diện: Page có `channel = 'facebook'` và `zalo_id` riêng nên tự xuất hiện trong bộ chọn tài khoản của Workflow và được Chat/CRM coi là một tài khoản.

## 13. Tính năng không hỗ trợ cho Page

- `FacebookScanService.getCookie` trả lỗi rõ "Tính năng quét chưa hỗ trợ tài khoản Page" khi tài khoản là Page, thay vì báo thiếu cookie.
- E2EE: Page không có bridge. Thread E2EE (nếu có) của Page không được hỗ trợ.

## 14. Kiểm thử

### 14.1 Tự động (jest, `src/__tests__/facebook/`, `src/__tests__/ui/`)

- `parseManagedPages`: HTML mẫu tổng hợp theo đúng cấu trúc spike ghi (hai Page, một Page thiếu `delegate_page_id`, khóa xuất hiện hai lần trùng id); HTML không có khóa; JSON hỏng; chuỗi có ngoặc nhọn trong tên Page.
- `stripPageCookie` / `buildPageCookie`: cookie không có `i_user`, cookie đã có `i_user` khác, khoảng trắng và dấu `;` cuối.
- `orderAccountsWithChildren`: con sau cha; con mồ côi giữ vị trí; nhiều cha; tài khoản không phải Facebook không đổi chỗ.
- `isSelf` cho Page: so cả `FacebookID` và `delegatePageId`. Kế hoạch tách thành hàm thuần nếu cần test.
- `npm test`, `tsc -p tsconfig.electron.json --noEmit` và `vite build` đều sạch.

### 14.2 Kiểm tay với tin nhắn thật (anh thực hiện, bắt buộc trước khi gộp)

1. Mở "Quản lý Page" trên tài khoản cá nhân và bật một Page (Media Soec hoặc AHV Holding Careers).
2. Từ một tài khoản khác, nhắn vào Page. Kiểm G2: tin hiện ở hộp thư Page trong MaiHub trong vòng vài giây. Bấm "Đồng bộ tin cũ" trên TopBar của Page để kiểm G1.
3. Trả lời văn bản và một ảnh. Kiểm G3: tài khoản khác nhận được tin từ Page.
4. Workflow `fb.trigger.message` có chọn Page thì chạy, không chọn Page thì không chạy.
5. Tắt Page: nó biến mất khỏi Sidebar. Bật lại: lịch sử vẫn còn.
6. Hồi quy: nhắn vào tài khoản cá nhân thì tin hiện ở hộp thư cá nhân, không hiện ở Page. Workflow và CRM của tài khoản cá nhân chạy như cũ.
7. Hai vòng, mỗi vòng có light và dark, desktop và mobile, cho Sidebar, hộp thoại Quản lý Page và bước Chọn Page.

## 15. Lỗi và giới hạn đã biết

- **Trùng khóa `fb_threads.id`.** `fb_threads.id` và `fb_messages.id` là khóa chính toàn cục. Nếu cùng một khách nhắn cả tài khoản cá nhân và Page, và Facebook dùng cùng thread id cho hai bên, thì dòng cache `fb_threads` giữ `account_id` của bên ghi trước. Các bảng hợp nhất `contacts` và `messages` (mà Chat đọc) khóa theo `owner_zalo_id` nên không bị ảnh hưởng. Đổi khóa chính cần dựng lại bảng, nên để ngoài đợt này.
- **Tra cứu `contacts` không lọc theo chủ.** Các truy vấn `contacts` theo `contact_id` mà không lọc `owner_zalo_id` (`FacebookService.ts`, `saveFBMessage`) có thể lấy tên hiển thị của cùng người đó từ tài khoản kia. Tên của cùng một người thường giống nhau, nên giữ nguyên.
- **Rủi ro phía Facebook.** Facebook có thể coi nhiều phiên song song từ một cookie là bất thường (spike §5). Không có biện pháp giảm nhẹ trong đợt này, ngoài việc dùng cùng proxy với tài khoản cha.
- **Giao thức không chính thức.** `doc_id`, cookie và cấu trúc `bookmarks/pages` có thể đổi bất kỳ lúc nào.
