# Ghi nhận nguồn gốc — MaiHub

**MaiHub** (tên trước 26.9.0: AHV Connect, bản phái sinh nội bộ của Trung tâm Đào
tạo Lái xe AHV; từ 26.9.0 là dự án cá nhân của Maiychrus) xây dựng trên mã nguồn mở:

- **Deplao** — https://github.com/babyvibe/deplao-builder
- Tác giả: babyvibe
- Giấy phép: **MIT** (xem `LICENSE`, giữ nguyên không sửa đổi)

Bản quyền của tác giả gốc được giữ nguyên theo đúng điều khoản MIT.

## Những thay đổi so với bản gốc

| # | Thay đổi | Lý do |
|---|---|---|
| 1 | **Tắt `TrackingService`** | Bản gốc gửi `pageId` (zalo_id / facebook_id / telegram id của tài khoản đang đăng nhập) và `machineId` lên máy chủ thượng nguồn. Trung tâm không gửi dữ liệu tài khoản ra ngoài |
| 2 | **Chặn toàn bộ `backendService`** (premium, quét nhóm qua máy chủ, thanh toán, affiliate, chia sẻ nhóm) | Các chức năng này gửi dữ liệu nhóm và tài khoản ra máy chủ thượng nguồn; bản nội bộ không dùng gói premium |
| 3 | **Tắt kiểm tra cập nhật tự động** (thời AHV Connect; từ MaiHub 26.11.0 đã bật lại, kiểm tra kho `maiychrus25/automation-marketing`, xem README) | Bản gốc lấy bản mới từ kho phát hành của tác giả; để nguyên thì bản nội bộ bị ghi đè. Bản nội bộ phát theo kênh riêng |
| 4 | **Gỡ 5 workflow CI và thư mục `landing/`** | Đây là hạ tầng phát hành và trang quảng bá của tác giả, không dùng cho bản nội bộ |
| 5 | **Đổi định danh ứng dụng** | `name` → `ahv-connect`, `appId` → `com.ahv.connect`, `productName` → `AHV Connect` (thời AHV Connect; hiện là `maihub`, `com.maihub.app`, `MaiHub`) |
| 6 | **Thêm nhà cung cấp AI `ahvchat`** | Tuỳ biến của trung tâm: thêm lựa chọn provider tương thích OpenAI, nhập tên mô hình tự do |
| 7 | **Sửa `tg.sendMessage` trong WorkflowEngineService** | Bản gốc đọc `segment.text` thay vì `segment.content`, khiến trả lời do AI soạn bị gửi thành tin rỗng qua Telegram |
| 8 | **Thay toàn bộ bộ biểu tượng** (`resources/icons/`) | Logo cũ là nhận diện của sản phẩm thượng nguồn. Bộ mới vẽ riêng: con đường thu xa, hai mép đường chụm thành chữ "A" của AHV. Nguồn gốc là `resources/icons/icon.svg`, dựng bằng `node scripts/build-icons.mjs`. Xem [DESIGN.md](./DESIGN.md) |
| 9 | **Đổi protocol deep link** `deplao://` → `ahvconnect://` (thời AHV Connect; hiện là `maihub://`) | Hai nơi khai báo (`package.json` và `electron/main.ts`) phải khớp nhau; giữ scheme cũ thì bản nội bộ giành đăng ký với bản gốc trên cùng một máy |
| 10 | **Gỡ trang "Donate & Ủng hộ"** kèm ảnh `src/assets/donate/qr.png` | Trang này chứa **mã QR ngân hàng, Telegram và Facebook cá nhân của tác giả gốc** — nhân sự trung tâm có thể chuyển tiền nhầm |
| 11 | **Gỡ luồng affiliate** (`AffiliateIntroPopup`, nút "Kiếm tiền", chấm đỏ nhắc) | Chương trình hoa hồng của sản phẩm thượng nguồn, không áp dụng cho bản nội bộ |
| 12 | **Gỡ/đổi hướng mọi liên kết ra ngoài trỏ về tác giả gốc** | GitHub issues, fanpage `fb.com/deplaoapp`, `t.me/babyvibe9`, nút sao GitHub. Thay bằng hướng dẫn báo lỗi trong ứng dụng |
| 13 | **Rút gọn `UpdateNotification` thành component rỗng** | Hộp thoại chứa 6 liên kết tải thẳng từ kho phát hành của tác giả; bấm vào sẽ cài đè bản nội bộ |
| 14 | **Đổi thông tin sản phẩm nhúng vào bản dựng** | `CompanyName`/`LegalCopyright` (Windows exe), maintainer gói `.deb`, tên bot mặc định trong workflow, nhãn nguồn đơn gửi sang POS (`deplaoapp` → `ahvconnect`) |
| 15 | **Thay `README.md`, xoá `README.en.md`** | README gốc là trang quảng bá sản phẩm thượng nguồn (badge kho, link website, hướng dẫn tải bản phát hành của họ) |

Hai thay đổi 6–7 do phía trung tâm thực hiện trước; cách tắt telemetry cũng
lấy theo bản của trung tâm (trả về kết quả rỗng có thông báo, phủ đủ 7 hàm)
thay vì ném lỗi.

## Port từ Deplao 26.9.0–26.10.0 (MaiHub, 12/10/2026)

Các bản sửa dưới đây được **port bằng tay, từng đoạn** từ commit `206c35f` (26.9.0),
`d0abfd3` (26.10.0) và `c958a38` của https://github.com/babyvibe/deplao-builder
(MIT). Không gộp nhánh, không chép nguyên tệp. Thiết kế đầy đủ ở
`docs/specs/2026-10-12-upstream-26.10-fixes.md`.

| Nhóm | Commit nguồn | File đích | MaiHub khác bản gốc ở điểm nào |
|---|---|---|---|
| Chặn addon native của `ws` (crash Windows) | `206c35f` | `electron/bootstrap.ts`, `package.json` (`main`, `dev`) | Giữ ý gốc. Chỉ đổi điểm vào của tiến trình; `bootstrap.js` rồi mới `require('./main')` |
| Index messages và bước dọn chạy một lần | `206c35f` | `src/services/database/DatabaseService.ts` | Bước dọn hàng thiếu `contact_id`/`thread_id` **chạy thêm một lần** rồi mới ghi cờ nghỉ hưu (bản gốc bỏ ngay). Không port bước dọn "Zalo undo" vì MaiHub chưa từng có bước này |
| Giới hạn `db:getMessages` | `206c35f` | `src/services/database/messageQueryLimits.ts`, `electron/ipc/databaseIpc.ts` | Trần **5.000** tin mỗi lần gọi (bản gốc 200), vì `ChatHeader.tsx` đọc lại tới 5.020 tin sau khi tải 5.000 tin Telegram |
| Chuyển `local_paths` sang đường dẫn tương đối | `d0abfd3` | `src/services/database/DatabaseService.ts`, `electron/ipc/databaseIpc.ts`, `electron/main.ts` | Hai nơi đổi thư mục dữ liệu gọi `migrateAllAbsolutePathsToRelative({ force: true })` để bỏ qua cờ đã hoàn tất (vừa ghi đường dẫn tuyệt đối mới). Lần chạy lúc khởi động vẫn dùng cờ |
| Màn hình trắng và thứ tự kết nối lúc khởi động | `d0abfd3` | `electron/main.ts`, `electron/preload.ts`, `src/ui/App.tsx`, `src/ui/lib/ipc.ts` | Chạy kết nối kênh khi renderer báo sẵn sàng (dự phòng 30 s). **CRM `resumeActiveCampaigns` chạy 3 s sau khi connector bắt đầu**, không phải lúc khởi động. Dự phòng 8 s **bỏ qua cửa sổ đã hiện**. Bỏ phần `powerMonitor`/Vite-suspend của bản gốc |
| Zalo: ảnh/GIF/tệp vào nhóm, thất bại kết nối | `d0abfd3` | `electron/ipc/zaloIpc.ts`, `src/services/zalo/ZaloService.ts` | **Không** từ chối ảnh theo đuôi tệp hay khi không đọc được kích thước, để không chặn tệp hiện gửi được |
| Workflow `zalo.addReaction` và `cliMsgId` của trigger | `c958a38` | `src/services/workflow/zaloReaction.ts`, `src/services/workflow/WorkflowEngineService.ts` | Tham số dựng bằng hàm thuần `buildZaloReactionCall` có test; giữ giá trị cấu hình cũ `'1'`–`'6'` |
| `$trigger.groupName` | `c958a38` | `src/services/event/EventBroadcaster.ts`, `src/utils/ZaloLoginHelper.ts`, `src/utils/enqueuePerKey.ts` | Chờ thông tin nhóm **tối đa 3 s** (bản gốc chờ không giới hạn) và **tuần tự theo từng nhóm** để tin đến sau không vượt tin đang chờ |
| Lệnh thu hồi đi qua luồng tin thường; log lỗi hook | `c958a38` | `src/services/event/undoControlPayload.ts`, `src/services/event/EventBroadcaster.ts` | Giữ logic nhận diện của bản gốc, tách thành hàm thuần có test (kể cả JSON tin thật không bị nhận nhầm) |

**Cố ý không port:** quét thành viên nhóm qua `deplaoapp.com` (gửi cookie và imei
Zalo ra máy chủ thượng nguồn, cùng loại với thay đổi số 2 ở bảng trên), tệp nhị
phân `.exe` đã commit, `go.mod`/submodule của bridge Go, Facebook cá nhân/E2EE,
Telegram User/Bot, Trung tâm tính năng và các tính năng lớn khác của bản gốc.

## Port từ Deplao 26.9.0–26.11.0 (MaiHub, 11/2026)

Đợt sửa độ tin cậy đồng bộ chat Zalo/Facebook, **port bằng tay, từng đoạn** từ
https://github.com/babyvibe/deplao-builder (MIT) tại commit `2162f07` (26.11.0).
Không gộp nhánh, không chép nguyên tệp (riêng `zaloReadElsewhere.ts` theo sát
bản gốc, xem bảng). Thiết kế ở `docs/specs/2026-11-13-chat-sync-reliability.md`.
Đường dẫn nguồn dưới đây tính từ thư mục gốc của kho thượng nguồn.

| Nhóm | Tệp nguồn (`2162f07`) | File đích | MaiHub khác bản gốc ở điểm nào |
|---|---|---|---|
| Z1 Đã nhận / đã xem Zalo | `src/utils/zalo/ZaloLoginHelper.ts`, `src/services/receipts/peerReceipts.ts` | `src/utils/ZaloLoginHelper.ts`, `src/services/receipts/peerReceipts.ts`, `src/ui/lib/chat/messageReceipt.ts` | Nhãn "Đã nhận"/"Đã xem" chỉ hiện **dưới tin mình gửi cuối cùng** (R1), không vẽ dấu ✓ trên từng bong bóng. Mốc là cột `contacts.peer_delivered_ts` / `peer_read_ts`, chỉ tiến lên; không tạo hội thoại mới chỉ vì một biên nhận |
| Z2 Lọc tin giao trùng | `src/services/database/DatabaseService.ts`, `src/services/event/EventBroadcaster.ts` | `src/services/database/DatabaseService.ts` (`isDuplicateZaloDelivery`, `idx_messages_cli`), `src/services/event/EventBroadcaster.ts` | Chỉ trùng khi cùng tài khoản + `cliMsgId` + hội thoại + người gửi + **nội dung** và cả hai là id thật (không `mb_`/`cli_`); chỉ xét dòng kênh Zalo; lỗi kiểm tra thì coi là tin mới. Không dọn cặp trùng đã lưu |
| Z3 Websocket tự nối lại | `src/utils/zalo/zaloListenerRetry.ts`, `src/utils/zalo/ZaloLoginHelper.ts` | `src/utils/zaloListenerRetry.ts`, `src/utils/ZaloLoginHelper.ts` | Trong lúc zca-js tự nối lại **không** phát `event:disconnected` và không đổi trạng thái kết nối (R6); watchdog 90 s rồi mới về đường đăng nhập lại cũ (tối đa 5 lần). Giữ cờ `manuallyDisconnectedAccounts` (ngắt tay không tự nối lại); listener cũ bị thay thì bị chặn nối lại |
| Z4 Ảnh JPEG XL | `src/utils/zalo/zaloImageUrl.ts` | `src/utils/zaloImageUrl.ts` và các nơi hiển thị ảnh ở renderer | **Chặt hơn bản gốc** (R4): chỉ đổi URL thuộc host media Zalo (`zdn.vn`, `zadn.vn`, `zalo.me`, `zaloapp.com`, kể cả subdomain, không khớp tên miền giả dạng); URL `?e2esession` giữ nguyên; không migration, tin cũ được sửa lúc hiển thị, file `.jxl` đã tải về bị bỏ qua để dùng URL CDN |
| Z5 Đọc ở máy khác | `src/services/zalo/zaloReadElsewhere.ts` | `src/services/zalo/zaloReadElsewhere.ts`, `src/utils/ZaloLoginHelper.ts`, `src/ui/lib/chat/readElsewhere.ts` | **Port theo sát bản gốc** (logic áp số chưa đọc, phạm vi 200 tin); phần giải mã frame (`decodeWsEventData`, Node `crypto` + `zlib`) viết lại cho MaiHub. Không gửi "đã xem" ngược lên Zalo; renderer chỉ giảm số chưa đọc |
| F1 Chưa đọc Facebook đúng một lần | `src/services/database/DatabaseService.ts`, `src/services/facebook/FacebookService.ts` | `src/services/database/DatabaseService.ts` (`FbSaveOutcome`), `src/services/facebook/FacebookService.ts` | Tin mới được xác định bằng bảng `messages` hợp nhất theo từng tài khoản (hai tài khoản MaiHub cùng thấy một id vẫn đếm riêng); luồng tin Page cũng chỉ phát khi `'new'` |
| F2 Sức khoẻ cookie / thử lại khi khởi động | `src/services/facebook/FacebookSession.ts`, `src/services/facebook/FacebookService.ts` | `src/services/facebook/FacebookSession.ts`, `src/services/facebook/facebookStartupRetry.ts`, `electron/ipc/facebookIpc.ts` | Thử lại sau 15 s, 60 s, 180 s; lúc timer nổ đọc lại DB, bỏ qua nếu tài khoản đã xoá/tắt/ngắt tay/đã kết nối; mỗi tài khoản một thế hệ timer để huỷ chắc chắn. Cookie bị Facebook từ chối thật vẫn báo hết hạn |
| F3 Tên hội thoại / chưa đọc | `src/services/facebook/FacebookThreadManager.ts` | `src/services/facebook/FacebookThreadManager.ts`, `src/services/database/DatabaseService.ts` | `unread_count` của Facebook **chỉ dùng khi tạo hội thoại lần đầu** (R7); làm mới danh sách hội thoại không còn ghi đè số trong máy |
| F4 Kết quả GraphQL | `src/services/facebook/FacebookGraphQLResult.ts` | `src/services/facebook/FacebookGraphQLResult.ts`, `FacebookThreadManager.ts`, `FacebookMessageSender.ts` | Phản hồi **không phải JSON** coi là "không rõ", giữ hành vi cũ (R5); thành công một phần (có `data` dùng được kèm `errors`) tính là thành công, chỉ cảnh báo; chỉ phản hồi phân tích được và không có dữ liệu dùng được mới thành thất bại. `sendMessage` không đổi |
| F5 Giám sát bridge / hàng đợi sự kiện | `src/services/facebook/FacebookEventPipeline.ts`, `src/services/facebook/FacebookEventRepeats.ts`, `src/services/facebook/FacebookService.ts` | `src/services/facebook/FacebookEventPipeline.ts`, `facebookBridgeBackoff.ts`, `FacebookService.ts` | Hàng đợi 500 (sự kiện quan trọng tới 2000), chống trùng 5 s theo loại + id; **chỉ bảo đảm thứ tự phát**, không chờ phần xử lý bất đồng bộ (tải media) nên không bảo đảm thứ tự hoàn tất. Backoff 10 s nhân đôi, trần 5 phút; giữ cờ ngắt tay. Thêm listener `error` log-only ngay khi tạo bridge |
| F6 Tin mẫu (template) | `src/services/facebook/FacebookMQTTListener.ts` | `src/services/facebook/facebookTemplateText.ts`, `FacebookMQTTListener.ts` | Lưu như **tin `text`** có nội dung đọc được (tiêu đề, mô tả, tối đa 6 nút kèm link; link chứa khoảng trắng/ký tự điều khiển bị bỏ) (R2); **không** làm thẻ `FacebookTemplateCard` / kiểu `fb.template` |
| §6 Mốc đã nhận / đã xem Facebook | `src/services/receipts/peerReceipts.ts`, `src/services/facebook/FacebookMQTTListener.ts` | `src/services/receipts/peerReceipts.ts`, `FacebookMQTTListener.ts`, `FacebookService.ts` | Ghi mốc từ MQTT và từ sự kiện `seen` của bridge E2EE (R3); chỉ cho hội thoại cá nhân, không cho hộp thư Page. `markRead` gửi thật để chặng D |

**Cố ý không lấy:** đồng bộ lịch sử từ điện thoại (`mobileSync`, cần nâng
`zca-js` và dựa vào giao thức không công bố), `FacebookMetrics`, thẻ template
(`FacebookTemplateCard`), lưu trạng thái thiết bị E2EE (F8) và `markRead`
gửi thật (F7, nửa gửi), cả hai thuộc chặng D (Go), chưa làm; cùng các mục đã loại
ở đợt trước (gửi cookie/token/IMEI ra máy chủ ngoài, tệp nhị phân, bridge đăng
nhập, Cloudflare sync, Telegram).

### Bridge E2EE: nguồn gốc và giấy phép (ghi nhận sự việc)

Đây là ghi nhận sự việc đã có từ trước, **không phải kết luận pháp lý**.

- `scripts/build-bridge-e2ee.js` clone https://github.com/mautrix/meta khi build
  và ghim commit `e012f9f83ee0abd332b6160f57ecd07014c2d445` (`e012f9f`);
  `src/bridge-e2ee/go.mod` trỏ `go.mau.fi/mautrix-meta` tới bản clone đó. Kho
  `mautrix/meta` không nằm trong kho này nên giấy phép của nó (được hiểu là
  AGPL-3.0) **chưa được kiểm chứng tại đây**.
- `src/bridge-e2ee/README.md` (mục License) ghi thư mục `src/bridge-e2ee/bridge/`
  chứa mã sao chép từ https://github.com/yumi-team/meta-messenger.js, © 2026
  Yumi Team, **AGPL-3.0**; `main.go` và lớp bọc Python là mã gốc. Các tệp `.go`
  trong `bridge/` không mang tiêu đề giấy phép riêng.

## Thư mục dữ liệu và chuyển dữ liệu

### MaiHub (từ 26.9.0): tự chuyển từ AHV Connect

`electron/main.ts` đặt tên ứng dụng và `userData` là `<appData>/MaiHub`. Lần đầu
mở, nếu thư mục `MaiHub` chưa tồn tại mà `<appData>/AHV Connect` có, MaiHub **tự
đổi tên** thư mục `AHV Connect` thành `MaiHub` (`migrateLegacyUserData` trong
`src/services/app/legacyDataMigration.ts`, test ở
`src/__tests__/app/legacyDataMigration.test.ts`) và xóa các tệp khóa Chromium của
tiến trình cũ. Nếu AHV Connect còn chạy hoặc đổi tên lỗi, MaiHub hiện hộp thoại
"Chưa chuyển được dữ liệu" và thoát; thoát AHV Connect rồi mở lại.

Trên Linux và macOS, dữ liệu mã hóa bằng kho khóa hệ điều hành (`safeStorage`)
gắn với tên ứng dụng, nên sau khi chuyển phải đăng nhập lại các tài khoản và
nhập lại khóa API. Mã chỉ chuyển thư mục `AHV Connect`; thư mục `Deplao` của bản
gốc **không** tự chuyển.

### Thời AHV Connect (trước 26.9.0): bản cài Deplao cũ không tự chuyển sang

Phần này mô tả chuyện **Deplao → AHV Connect**, không còn là cách MaiHub hoạt động.
Khi đó `electron/main.ts` gọi `app.setName('AHV Connect')` trước `app.whenReady()`,
nên Electron phân giải `userData` thành `%AppData%\AHV Connect` thay vì
`%AppData%\Deplao`. Hệ quả: máy nào **đã dùng Deplao từ trước** thì khi cài AHV
Connect sẽ mở ra một cơ sở dữ liệu **rỗng** — dữ liệu cũ vẫn còn nguyên trong
thư mục `Deplao`, không mất, nhưng không tự nạp.

Đó là chủ ý lúc ấy (hai bản chạy song song được, danh tính tách bạch). Dữ liệu
Deplao vẫn chuyển bằng tay: chép `deplao-tool.db`, `deplao-config.json` và thư
mục `media` từ `%AppData%\Deplao` sang thư mục dữ liệu của bản đang dùng
(`%AppData%\MaiHub` với MaiHub) khi ứng dụng đang tắt.

*Chưa kiểm chứng bằng cách chạy thật* — máy dựng không có Xvfb và chưa tải
binary electron. Cần xác nhận lại ở lần chạy đầu tiên trên máy Windows.

## Những chỗ CỐ Ý giữ nguyên tên "deplao"

Không phải sót — đổi sẽ phá tương thích hoặc gây rủi ro không tương xứng:

| Chỗ giữ nguyên | Lý do |
|---|---|
| Tên tệp trong thư mục dữ liệu: `deplao-tool.db`, `deplao-config.json` | Tên tệp xuất hiện ở ~40 vị trí trong mã (`WorkspaceManager`, `DatabaseService`, IPC workspace/database) và trong cấu hình workspace đã lưu. Đổi tên là một việc riêng có bước di trú, không gộp vào đợt đổi thương hiệu |
| Khoá `localStorage`: `deplao_employee_login`, `deplao_employee_password`, `deplao_forum_topics_*` | Đổi khoá là đăng xuất toàn bộ nhân viên và mất cache |
| Khoá nhận dạng tệp workflow xuất ra: `_deplaoWorkflow` | Đổi thì không nhập lại được các tệp workflow đã xuất trước đó |
| Thư mục tạm: `deplao-clipboard`, `deplao-videometa`, `deplao-workflow-images` | Nội bộ, không hiển thị cho người dùng |
| Chú thích mô tả dịch vụ đã tắt (`TrackingService`, `backendService`) | Ghi đúng những gì đã bị chặn — là tài liệu, không phải nhận diện thương hiệu |

## Dependency runtime thêm cho API điều khiển (MaiHub, 14/10/2026)

`selfsigned` **5.5.0** (giấy phép **MIT**, khai báo trong `dependencies` của `package.json`) dùng để tạo chứng chỉ TLS tự ký cho API điều khiển (`src/services/control/certificate.ts`); chỉ được nạp khi cần tạo chứng chỉ. Các dependency runtime kéo theo (đối chiếu `node_modules/*/package.json` ngày 14/10/2026):

| Gói | Phiên bản | Giấy phép |
|---|---|---|
| `selfsigned` | 5.5.0 | MIT |
| `@peculiar/x509` | 1.14.3 | MIT |
| `@peculiar/asn1-schema`, `asn1-x509`, `asn1-cms`, `asn1-csr`, `asn1-ecc`, `asn1-pfx`, `asn1-pkcs8`, `asn1-pkcs9`, `asn1-rsa`, `asn1-x509-attr` | 2.11.0 | MIT |
| `@peculiar/utils` | 2.0.3 | MIT |
| `pkijs` | 3.4.1 | BSD-3-Clause |
| `asn1js` | 3.0.10 | BSD-3-Clause |
| `bytestreamjs` | 2.0.1 | BSD-3-Clause |
| `pvtsutils` | 1.3.6 | MIT |
| `pvutils` | 1.2.0 | MIT |
| `tsyringe` | 4.10.0 | MIT |
| `tslib` | 2.8.1 (và 1.14.1 lồng trong `tsyringe`) | 0BSD |
| `reflect-metadata` | 0.2.2 | Apache-2.0 |
| `@noble/hashes` | 1.8.0 (lồng trong `pkijs`) | MIT |

Bản quyền và văn bản giấy phép của từng gói nằm trong thư mục của gói đó trong `node_modules` và được giữ nguyên khi đóng gói.

## Lưu ý khi dùng

- Ứng dụng thao tác trên **tài khoản Zalo cá nhân** qua thư viện `zca-js`.
  Việc này **vi phạm chính sách của Zalo** và có thể dẫn tới khóa tài khoản.
  Dùng tài khoản riêng cho công việc, **không dùng tài khoản cá nhân của nhân
  viên**.
- Bản dựng **chưa ký số**; hệ điều hành sẽ cảnh báo khi cài. Chỉ cài bản do
  trung tâm phát, không tải bản trôi nổi.
- Campaign CRM có trần gửi theo ngày (`daily_send_limit`) và giờ bắt đầu ngày
  (`daily_start_time`) khi được cấu hình (`src/models/crm.ts`,
  `src/services/crm/CRMQueueService.ts`), nhưng **chưa có** giờ im lặng hay cơ
  chế từ chối nhận. Vì vậy bản này **chỉ dùng để trải nghiệm**, không dùng gửi
  tin hàng loạt cho học viên thật cho tới khi bổ sung các hàng rào đó.
- **Không bật tunnel Cloudflare** của webhook gateway: nó mở một địa chỉ công
  khai trỏ vào máy đang giữ phiên Zalo của trung tâm.
