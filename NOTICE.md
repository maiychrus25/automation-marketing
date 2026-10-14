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
