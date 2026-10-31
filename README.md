<div align="center">

<img src="resources/icons/icon_128.png" alt="MaiHub" width="96" />

# MaiHub

**Ứng dụng desktop cá nhân của Maiychrus**
Vận hành tài khoản Zalo / Facebook / Telegram, CRM, workflow tự động và trợ lý AI trong một ứng dụng.

</div>

> Trước đây có tên **AHV Connect**. Từ bản 26.9.0 đổi tên thành MaiHub; xem mục
> [Nâng cấp từ AHV Connect](#nâng-cấp-từ-ahv-connect). Đọc [NOTICE.md](./NOTICE.md) về nguồn gốc.

---

## Page campaign autonomy — kiểm chứng local Task 8

Task 8 thêm `src/__tests__/dailyBrief/pageCampaignAutonomy.integration.test.ts`: registry/auth/SQLite/operations/scheduler/post task thật, HTTPS loopback ghim chứng chỉ qua Python bridge thật; browser/provider và sender được giả lập. Kiểm tra quota 50 contender, 100 replay + 100 cancel, 7 ngày/restart/DST, fault và quyền scoped. Đây là kiểm chứng hành vi đã có, không phải RED→GREEN cho production hoặc nghiệm thu live. Target current-publish vẫn unconfirmed; autonomous first comment không được cấp quyền. Bộ mẫu confirmed để đo/tối ưu là **synthetic riêng**, không chứng minh collector live.

Tasks 1–8 đã qua review trong phạm vi local; broad review phát hiện lỗi receiver poll với campaign event thiếu `workId`, đã sửa bằng phân loại đúng hai campaign hint và qua scoped re-review không còn finding. Regression mới có RED→GREEN qua public poll/HTTPS, restart và cursor/draft recovery; không thay ý nghĩa characterization ban đầu. Controller chạy lại hai matrix 29/29, Jest chuẩn 125 suites/3157 tests, Python 363; TS/docs/diff exit 0.

**Nghiệm thu tổng thể vẫn BLOCKED.** Giữ `protectedWritesEnabled=false`; chưa phát hành, chưa có bình luận độc lập. Make targets/lint, packaging, receiver isolation, fresh-HOME auth, live identity/collector/current-publish vẫn là các cổng chưa đạt. UI không đổi: kiểm tra render N/A, không dùng fake browser của posting để nhận là UI E2E.

**Cập nhật 30/10/2026:** đã sửa fixture phụ thuộc thứ tự trong `groupContactType` theo ngoại lệ được chủ sở hữu duyệt, không đổi logic DB hoặc bỏ assertion. Full Jest chuẩn và hai vòng randomized (2707/New York, 3707/Ho Chi Minh) đều 125 suites/3157 tests đạt, không skip; hai TypeScript checks exit 0. Vẫn có 12 console.error và 2 console.warn blocks như baseline, không nhận output pristine; ba Make targets vẫn thiếu. Doanh thu/ROI đã loại khỏi phạm vi phát triển, các trường legacy unavailable giữ nguyên. [Spec tác vụ nền độc lập](docs/specs/2026-10-30-independent-background-jobs.md) đã được duyệt; [kế hoạch triển khai 8 task](docs/plans/2026-10-30-independent-background-jobs.md) đã được duyệt và đang triển khai bằng subagent trong dev, chưa nghiệm thu concurrency. Chế độ AI tự vận hành mở rộng và bình luận độc lập vẫn là các đợt riêng.

## Tác vụ nền độc lập — kiểm chứng local Task 8

Spec `docs/specs/2026-10-30-independent-background-jobs.md`: tối đa 2 lượt đăng/quét/tham gia/thu sống cùng lúc, mỗi side service giữ 1 job riêng, 30 profile tổng, chờ profile tối đa 2 giờ. Task 8 thêm `src/__tests__/facebookPoster/backgroundJobs.integration.test.ts` ghép IPC/coordinator/queue/`BrowserProfileService`/scheduler/side services/SQLite thật với native launch, trang Facebook, render/AI transport và clock giả (researchIpc, WorkspaceManager, AppModeManager, workspaceIpc là stub); mở rộng `pageCampaignAutonomy.integration.test.ts` với hai Page campaign đồng thời và drain hai managed worker. Ca đồng thời làm lộ và đã sửa cục bộ lỗi quota chéo Page trong `PageCampaignExecutionStore` (fail-closed, không đăng vượt quota). **Phát hành vẫn BLOCKED:** thiếu Make targets build/test/lint, chưa đóng gói/native rebuild (cần anh xác nhận riêng), chưa kiểm app Electron thật/live Facebook; `protectedWritesEnabled=false`.

## Nhận diện

Logo là bông hoa mai năm cánh: "Mai" trong tên, năm cánh tỏa từ một tâm là
"hub" — một nơi, nhiều kênh. Nguồn gốc là `resources/icons/icon.svg`; mọi file PNG/ICO/ICNS
đều dựng ra từ đó bằng `npm run build:icons`. Lý do thiết kế và các ràng buộc
tỉ lệ: [DESIGN.md](./DESIGN.md).

## Nguồn gốc

MaiHub là bản phái sinh của dự án mã nguồn mở
[Deplao](https://github.com/babyvibe/deplao-builder) (tác giả: babyvibe), giấy
phép **MIT**. Bản quyền của tác giả gốc được giữ nguyên trong tệp
[LICENSE](./LICENSE). Danh sách đầy đủ những thay đổi so với bản gốc nằm ở
[NOTICE.md](./NOTICE.md).

## Đăng Facebook: nhiều ảnh, lên lịch và bản nháp

- Một bài có 1–10 ảnh (`jpg`, `jpeg`, `png`, `gif`, `webp`; mỗi ảnh tối đa 20 MB, tổng tối đa 100 MB) hoặc đúng 1 video; không trộn ảnh với video. Ảnh lên bài theo thứ tự đã sắp.
- Lên lịch một lần hoặc lặp lại theo thứ trong tuần và giờ cố định (giờ của máy, tối đa một lượt mỗi ngày mỗi lịch); tối đa 200 lịch mỗi workspace. Ảnh của lịch được chép vào `<thư mục DB của workspace>/facebook-poster-media/<scheduleId>/` và xoá cùng lịch.
- Lịch chỉ chạy khi app đang mở và máy thức. Quá giờ hẹn hơn 60 giây mà app chưa chạy thì lượt đó bị bỏ, ghi "Đã lỡ" vào Lịch sử và báo khi mở app; không đăng bù. Đang có việc khác thì lượt xếp hàng chờ tối đa 2 giờ.
- Sửa lịch đã duyệt chỉ đổi được tên và thời gian; muốn đổi nội dung hoặc ảnh thì xoá và lên lịch lại. Không xoá được lịch khi lượt của lịch đó đang chạy. Chế độ nhân viên chưa hỗ trợ.
- Từ 26.16.0 có bản nháp: **Lưu nháp** chỉ cần nội dung; nháp không bao giờ tự chạy, phải **Duyệt** rồi chọn đăng ngay hoặc hẹn giờ. Nháp tính vào giới hạn 200 lịch. Trên calendar chỉ lịch một lần kéo-thả được để dời giờ; lịch lặp đổi giờ bằng nút **Sửa giờ**.
- Bình luận đầu có thể đặt chạy sau 0–60 phút kể từ lúc bài lên (0 là ngay), cho cả nhóm lẫn Page.
- Bấm **Hủy**: trình duyệt của profile chưa tới bước bấm Đăng/Tham gia được yêu cầu đóng; profile đang ở bước không thể quay lại được chờ settlement để giữ dấu vết kết quả, kể cả `uncertain_after_submit`.
- **Lifecycle Task 5 trong dev, chưa phát hành:** đổi/xoá workspace đang mở và thoát hoàn toàn khóa nhận việc mới, chờ mọi lượt/side job/waiter cùng pending browser open/close. Chỉ đổi/đóng DB sau khi xác nhận owner đã dừng. Timeout hoặc cleanup lỗi thì giữ DB, báo chưa dừng an toàn, mở lại admission/scheduler cùng workspace và cho thử lại. Các pha có timeout riêng; không còn cam kết tổng cộng 55 giây hoặc thoát ngay sau 5 giây. Renderer, tray và OS quit dùng chung gate; nút **X** vẫn chỉ ẩn xuống tray. Khi thoát bị chặn, hộp thoại cho chọn **Để sau** hoặc **Thoát ngay** (hỏi xác nhận lần nữa): thoát ngay hủy việc đang chạy, yêu cầu đóng trình duyệt mà không chờ; bài đang gửi dở được đánh dấu cần kiểm tra ở lần mở sau và không gửi lại. Crash/force-kill bên ngoài không được bảo đảm drain.

## Điều khiển MaiHub từ bot (API điều khiển)

MaiHub có thể mở một máy chủ HTTPS tắt-theo-mặc-định để bot (ví dụ bot Telegram dùng Claude CLI) tạo nháp, tải ảnh, duyệt lịch và chờ kết quả Đăng Facebook. Bật trong Cài đặt → **Điều khiển từ bot**: bắt buộc nhập danh sách IP được phép, mỗi bot dùng một khoá riêng, chứng chỉ tự ký được bot ghim bằng dấu vân tay SHA-256. Đặc tả giao thức, mã lỗi, từng thao tác và luồng mẫu: [docs/protocol/maihub-control-protocol.md](./docs/protocol/maihub-control-protocol.md). Cài cầu nối Python (CLI và MCP) trên VPS của bot: [tools/maihub-bridge/README.md](./tools/maihub-bridge/README.md).

**Đề xuất bài hằng ngày — 26.32.0 chuẩn bị local, chưa phát hành (27/10/2026).** Bot học danh tính Page từ JSON đã tải trong DOM, lưu kế hoạch từng Page và dùng `research.trending` xếp bài từ các lượt quét Facebook đã lưu. Bridge `brief-tick` có timer `install-brief` mỗi 15 phút; không có việc làm quen hoặc kế hoạch đến giờ thì không gọi Claude. `watch` gửi một tin Telegram cho mỗi nháp; khách nhắn “đăng #xxxx”, “sửa #xxxx …” hoặc “bỏ #xxxx”, bot hỏi lại khi không xác định được nháp. Chỉ tạo nháp, không tự duyệt/đăng. Hiện chỉ đọc các bài tự đăng khả dụng trong DOM, chưa chủ động GraphQL/phân trang; live Facebook, người thật, browser macOS, systemd trên VPS và luồng bot thật chưa xác minh. Chi tiết hành vi, giới hạn và kiểm chứng: [SYSTEM_DOCUMENTATION.md, mục 4.16](./SYSTEM_DOCUMENTATION.md#416-đề-xuất-bài-hằng-ngày).

### Page Operations Foundation — local/dev, chưa phát hành

Tasks 1–9 và bốn bản sửa F1–F4 đã được chấp nhận trong phạm vi local/dev ngày 28/10/2026 sau review độc lập và hai vòng kiểm chứng của controller: mỗi vòng 118 suites/2.791 test Jest, 346 test Python; ma trận UI sau sửa gồm 16 trường hợp desktop/mobile × light/dark. Make build/test/lint vẫn thiếu target; chưa chứng nhận lint, bộ cài production hoặc vận hành thật. Kiểm thử `src/__tests__/dailyBrief/pageOperations.integration.test.ts` dùng registry/IPC adapters, HTTPS authority và SQLite thật với browser/video/transport giả: ba Page cách ly đến khi hoàn tất nháp, hai profile chung một bộ nhớ/lượt, video tiếp tục qua restart, runner không duyệt được, duyệt đúng revision và chặn ghi stale sau thu hồi/restart. Đây không phải kiểm chứng provider hoặc khách thật.

- Runner chỉ chuẩn bị nháp: không tự duyệt/đăng, bật lịch, gửi CRM, cấp khoá hay bắt đầu render tính phí. Receiver giữ credential/owner identity riêng; `confirm:true` không nâng quyền runner. Desktop và API legacy giữ hợp đồng cũ, không tự chuyển sang scoped hoặc fallback toàn quyền.
- Thử nghiệm dự kiến 1–3 Page; mỗi workspace tối đa 10 brief/10 hồ sơ kinh doanh, mỗi hồ sơ 100 facts. Một primary profile/Page, ba lượt gọi agent/ngày xuyên mọi bước; poll video không tiêu lượt và không giữ browser slot. Nháp lưu/liên kết đủ thì work completed, không giữ lease chờ khách duyệt. Chi tiết giới hạn có docs-check trong SYSTEM_DOCUMENTATION.
- **INTEGRATION BLOCKED — proposal/read-only, `protectedWritesEnabled=false`.** Chưa xác định/nối entrypoint transport đã xác thực của receiver VPS thật vào `handle_owner_update`, chưa chứng minh OS user/file/env/MCP separation hay CLI login trong fresh HOME. Telegram ingress của app không thay receiver VPS; không tạo poller `getUpdates` thứ hai hoặc đưa owner secrets vào runner.
- Không có bản cài production mới từ các test local; không tăng version, chạy migration khách, cài timer hay deploy. Chỉ sau phép riêng mới dev → tests/review → build artifact/image → deploy artifact/image, không sửa source trực tiếp trên production.

## Giới hạn đang áp dụng

| Hạng mục | Trạng thái |
|---|---|
| Gửi dữ liệu telemetry ra ngoài | **Đã tắt** (`TrackingService`) |
| Máy chủ thượng nguồn: premium, quét nhóm, thanh toán, affiliate | **Đã chặn** (`backendService`) |
| Tự động kiểm tra & tải bản cập nhật | **Bật từ 26.11.0** — xem mục [Tự cập nhật](#tự-cập-nhật) |
| Trang donate / giới thiệu hoa hồng / link kho mã nguồn của tác giả | **Đã gỡ** |
| Giờ im lặng, cơ chế từ chối nhận | **Chưa có** (trần gửi theo ngày và giờ bắt đầu ngày có trong campaign CRM, chỉ áp dụng khi được cấu hình) |

Vì chưa có giờ im lặng và cơ chế từ chối nhận ở dòng cuối, bản này **chỉ dùng để trải nghiệm và
đánh giá**, chưa dùng gửi tin hàng loạt cho khách thật.

## Rủi ro cần biết trước khi dùng

- Ứng dụng thao tác trên **tài khoản Zalo cá nhân** qua thư viện `zca-js`. Việc
  này **vi phạm chính sách của Zalo** và có thể dẫn tới khóa tài khoản. Dùng tài
  khoản riêng cho công việc.
- Bản dựng **chưa ký số**; Windows/macOS sẽ cảnh báo khi cài. Chỉ cài bản tải
  từ GitHub Releases của dự án.
- **Không bật tunnel Cloudflare** của webhook gateway: nó mở một địa chỉ công
  khai trỏ thẳng vào máy đang giữ phiên Zalo.

## Chạy ở môi trường phát triển

```bash
npm install          # cài phụ thuộc (chạy kèm scripts/patch-electron-icon.js trên Windows)
npm run dev          # Vite dev server + Electron
```

## Đóng gói

### Qua GitHub Actions (khuyến nghị)

Workflow [`.github/workflows/build.yml`](./.github/workflows/build.yml) build đủ
bốn bản trên runner của chính từng hệ điều hành: Linux x64 (AppImage, deb),
Windows x64 (bộ cài NSIS), macOS Apple Silicon và macOS Intel (dmg, zip).
Trước khi đóng gói, workflow chạy type-check và unit test.

- Chạy tay: tab **Actions** → **Build** → **Run workflow**, chọn nhánh.
- Hoặc đẩy một tag bắt đầu bằng `v`, ví dụ `git tag v26.9.0 && git push origin v26.9.0`.
- Tải bản cài ở mục **Artifacts** của lần chạy (giữ 14 ngày).

**Phát hành (Release):** sau khi build xong cả bốn bản, job "Phát hành" tạo một
GitHub Release kèm toàn bộ bản cài, khi:

- Run workflow có tick **Tạo Release**: tag là `v` + `version` trong
  [package.json](./package.json) (tăng `version` trước khi phát hành bản mới); hoặc
- đẩy tag `v*`: tag đó là tên Release.

Repo công khai, nên ai cũng tải được bản cài và app tự cập nhật được mà không cần token.

### Tự cập nhật

Từ 26.11.0, app hỏi GitHub Releases 15 giây sau khi mở rồi mỗi 6 giờ. Có bản mới thì hiện
thẻ thông báo ở góc trên bên phải (và chấm báo cạnh tên MaiHub ở Sidebar):

| Nền tảng | Cách cập nhật |
|---|---|
| Windows (bộ cài `.exe`) | Bấm **Cập nhật** → tải trong app → **Khởi động lại để cập nhật** |
| Linux AppImage | Như Windows |
| Linux `.deb`, macOS (chưa ký số) | Bấm **Tải bản mới** → mở trang Release, tải và cài tay |

- Đang có lượt Đăng Facebook, side job, research, waiter hoặc lease chưa release thì app từ chối khởi động lại để cài. Trong mã Task 5 hiện tại, bản tải xong còn phải qua drain gate **trước khi gọi trình cài đặt**; không chỉ chờ `before-quit`. Cập nhật không chiếm pause của lần chuyển workspace/quit khác. Chuẩn bị hoặc cài đặt thất bại thì nhả pause thuộc chính lần cập nhật đó, giữ bản đã tải để thử lại; chỉ cleanup/đóng DB khi quit được phép.
- Muốn bản mới đến được người dùng: tăng `version` trong `package.json`, gắn thẻ `v<version>`
  và đẩy thẻ. Release phải ở trạng thái đã công bố (không phải nháp, không phải pre-release).
- Bản 26.10.0 trở về trước chưa bật tự cập nhật: cài tay 26.11.0 một lần.
- Thiết kế: [docs/specs/2026-10-03-auto-update.md](./docs/specs/2026-10-03-auto-update.md).

Bản macOS chưa ký bằng chứng chỉ Apple (chỉ ký ad-hoc). Lần mở đầu, macOS sẽ
chặn: chuột phải vào app → **Open**, hoặc chạy
`xattr -cr "/Applications/MaiHub.app"`.

### Trên máy

```bash
npm run production   # build cầu nối Go E2EE, main, renderer, native module rồi đóng gói cho hệ điều hành đang chạy
```

Cần Go ≥ 1.26 cho cầu nối E2EE. Bản cài ra ở `dist-electron-build/`. Không build
chéo hệ điều hành: các thành phần native (better-sqlite3, ffmpeg, ngrok,
cloudflared, cầu nối E2EE) phải đúng nền tảng.

Cấu hình đóng gói (appId `com.maihub.app`, productName `MaiHub`, protocol
`maihub://`) nằm ở khối `build` trong [package.json](./package.json).

## Dữ liệu

Dữ liệu nằm hoàn toàn trên máy người dùng (SQLite trong thư mục `userData` của
ứng dụng). **Không có bản sao lưu tự động** — tự sao lưu định kỳ trước khi nâng
cấp phiên bản.

Thư mục dữ liệu là `%AppData%\MaiHub` (Windows), `~/.config/MaiHub` (Linux),
`~/Library/Application Support/MaiHub` (macOS). Tên tệp bên trong vẫn là
`deplao-tool.db` / `deplao-config.json` của dự án gốc: xem [NOTICE.md](./NOTICE.md).

## Trình duyệt trên Linux (sandbox)

Mọi trình duyệt do MaiHub mở (profile và trình duyệt Business Suite của Page) chạy có sandbox. Riêng Linux đang chặn user namespaces (AppArmor), MaiHub chạy không sandbox và màn **Trình duyệt** hiện dải cảnh báo kèm lệnh `sudo` để sao chép; làm theo rồi bấm **Kiểm tra lại**. App không tự chạy `sudo`. Tính năng này là mã sau 26.16.0, sẽ có trong bản tính năng kế tiếp.

## Nâng cấp từ AHV Connect

MaiHub có tên gói và appId khác, nên **cài song song** với AHV Connect chứ không
thay thế. Các bước:

1. Thoát AHV Connect hoàn toàn (kể cả biểu tượng ở khay hệ thống).
2. Cài và mở MaiHub. Lần đầu mở, nếu chưa có thư mục `MaiHub`, MaiHub tự chuyển
   thư mục dữ liệu `AHV Connect` thành `MaiHub` (tin nhắn, CRM, workflow, proxy, profile trình duyệt đi theo).
   Nếu AHV Connect còn chạy, MaiHub báo và thoát; thoát AHV Connect rồi mở lại.
3. Kiểm tra dữ liệu đã có trong MaiHub, rồi gỡ AHV Connect.

**Linux và macOS:** khóa mã hóa trong kho khóa hệ điều hành gắn với tên ứng
dụng, nên sau khi chuyển phải **đăng nhập lại** các tài khoản Zalo/Facebook/
Telegram và nhập lại khóa API, mật khẩu tích hợp một lần. Windows không bị
ảnh hưởng.

## Hỗ trợ

Báo lỗi tại mục Issues của kho GitHub, kèm ảnh chụp màn hình và log (trong ứng
dụng: **Cài đặt → Nhật ký**).
