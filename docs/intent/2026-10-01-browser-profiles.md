# Intent: Trình duyệt antidetect đa profile cho AHV Connect (Browser Profiles)
Author: Maiychrus. Status: draft.

## Problem

Đội sales/marketing AHV phải vận hành nhiều tài khoản mạng xã hội (Facebook, TikTok, Zalo web) trên cùng một máy. Để các tài khoản không bị nền tảng liên kết và khóa chéo, đội đang thuê tool antidetect bên ngoài (loại như Polylogin). Việc này gây ra bốn vấn đề:

1. **Tốn phí thuê bao** cho một tool nằm ngoài AHV Connect, trong khi AHV Connect đã là nơi quản lý account, proxy, nhân viên và workflow.
2. **Dữ liệu phiên đăng nhập (cookie, storage) nằm ở bên thứ ba**, không nằm trong hạ tầng nội bộ.
3. **Chia sẻ tài khoản cho nhân viên phải đưa mật khẩu** hoặc phụ thuộc tính năng team của tool thuê, không gắn với mô hình employee/phân quyền đã có trong AHV Connect.
4. **AHV Connect chưa có khả năng tương đương.** Ứng dụng hiện kết nối Zalo/Facebook/Telegram ở tầng giao thức, không qua trình duyệt. Chỉ có một cửa sổ "Trình duyệt nội bộ" dùng chung session (`electron/main.ts`, handler `shell:openInApp`), không có khái niệm browser profile, fingerprint hay session cô lập. Proxy hiện chỉ gán được cho account Zalo (`electron/ipc/proxyIpc.ts`).

Tầm nhìn đầy đủ gồm sáu mảng: fingerprint riêng từng profile, quản lý nhiều profile, proxy riêng từng profile, quản lý team phân quyền, đồng bộ thao tác nhiều profile, automation không cần code. Sáu mảng này là các subsystem độc lập và không làm cùng lúc; tài liệu này chốt đợt đầu (MVP) và thứ tự các đợt sau.

## Proposed outcome

AHV Connect có một module mới, trong đó mỗi **profile** là một trình duyệt antidetect thật: cookie, storage, fingerprint và proxy riêng, mở được bất kỳ website nào. Module này độc lập với các kết nối chat tầng giao thức hiện có.

### MVP (đợt 1): Profile + fingerprint + proxy, trên một máy

- Tạo, sửa, xóa, nhân bản và nhóm profile; danh sách có tìm kiếm, lọc và thao tác hàng loạt.
- Mỗi profile có một fingerprint riêng, sinh một lần và **giữ ổn định giữa các lần mở**.
- Fingerprint ở mức sâu (canvas, WebGL, audio, font, WebRTC, múi giờ, ngôn ngữ, độ phân giải) nhờ **khởi chạy một nhân Chromium antidetect mã nguồn mở đã vá sẵn**. Đã chốt nền Chromium (không dùng Camoufox/Firefox); nhân được chọn sau spike là `adryfish/fingerprint-chromium` (BSD-3-Clause), xem `docs/reports/2026-10-01-antidetect-chromium-spike.md`. Không tự fork/build Chromium, không dùng lớp giả lập nông trong Electron.
- Mỗi profile gán một proxy lấy từ **kho proxy hiện có** của AHV Connect (http/https/socks4/socks5); múi giờ/ngôn ngữ/vị trí của profile khớp với IP proxy.
- Dữ liệu profile lưu cục bộ theo workspace.
- Profile tạo mới và đăng nhập lại từ đầu; không cần di trú từ tool cũ.

### Lộ trình sau MVP

| Đợt | Nội dung | Ghi chú |
|---|---|---|
| 2 | Chia sẻ profile cho nhân viên qua relay boss/employee, gán profile theo nhân viên/nhóm, khóa một-người-mở-một-lúc, log mở/đóng | Mở rộng mô hình employee hiện có |
| 3+ | Đồng bộ thao tác nhiều profile (synchronizer) | Thứ tự với automation chưa chốt |
| 3+ | Automation không cần code chạy trên profile | Mở rộng workflow editor hiện có |
| Sau | Thương mại hóa: license, gói cước, có thể cloud | Nội bộ trước, bán sau |

### Tiêu chí nghiệm thu

1. **Trang kiểm tra fingerprint:** trên browserleaks, pixelscan, creepjs, iphey, mỗi profile cho fingerprint khác nhau, ổn định giữa các lần mở, không lộ IP thật (kể cả qua WebRTC/DNS). *(MVP)*
2. **Nuôi tài khoản thật:** tài khoản Facebook, TikTok, Zalo web chạy trong profile có tỉ lệ checkpoint/khóa không cao hơn tool đang thuê. *(MVP)*
3. **Thay được tool trả phí:** đội AHV chuyển toàn bộ sang AHV Connect và ngừng thuê bao. *(MVP)*
4. **Nhân viên mở được profile của boss:** nhân viên remote mở profile được gán, phiên đăng nhập còn nguyên, không cần mật khẩu. *(Đợt 2)*
5. **Quy mô:** một máy quản lý đến 1.000 profile và mở đồng thời đến 30 profile. *(MVP)*

## Affected users and systems

### Người dùng

- **Boss/Standalone:** tạo và quản lý profile, gán proxy, mở trình duyệt. Người dùng chính của MVP.
- **Employee (remote):** chưa bị ảnh hưởng ở MVP; từ đợt 2 mở profile được gán qua máy boss.
- **Khách hàng ngoài AHV:** chưa thuộc phạm vi; chỉ là định hướng sau này.

### Hệ thống trong AHV Connect

| Thành phần | Ảnh hưởng |
|---|---|
| Electron main process (`electron/main.ts`) | Quản lý vòng đời các tiến trình trình duyệt ngoài: khởi chạy, theo dõi, đóng, dọn dẹp khi thoát app |
| IPC + preload (`electron/ipc/`, `electron/preload.ts`) | Thêm nhóm IPC mới cho profile |
| SQLite (`src/services/database/DatabaseService.ts`) | Thêm bảng profile, nhóm profile, fingerprint, liên kết profile–proxy |
| Kho proxy (`src/models/proxy.ts`, `electron/ipc/proxyIpc.ts`) | Tái dùng; mở rộng để gán proxy cho profile ngoài account Zalo |
| Lưu trữ file theo workspace (`src/utils/WorkspaceManager.ts`) | Thêm thư mục dữ liệu trình duyệt cho từng profile |
| Renderer (`src/ui/`) | Màn hình mới quản lý profile; mục mới trên Sidebar |
| Build/đóng gói (`package.json`, `scripts/`) | Đóng gói hoặc tải về nhân trình duyệt cho Windows và Linux |
| Quyền module (`src/models/employee.ts`, `ALL_MODULES`) | Thêm module mới vào vocabulary quyền (cần ở đợt 2) |
| Relay boss/employee (`src/services/http/`) | Đồng bộ profile cho nhân viên (đợt 2) |
| Workflow engine (`src/services/workflow/WorkflowEngineService.ts`) | Automation trên profile (đợt 3+) |

### Hệ thống bên ngoài

- Dự án nhân Chromium antidetect mã nguồn mở (phụ thuộc mới).
- Nhà cung cấp proxy của người dùng.
- Facebook, TikTok, Zalo web: nền tảng đích dùng để nghiệm thu.

## Constraints

- **Nền tảng:** MVP chạy trên Windows và Linux. macOS ngoài phạm vi MVP.
- **Nhân trình duyệt:** dùng nhân Chromium đã patch, mã nguồn mở, có sẵn; không tự build Chromium. Hệ quả: phụ thuộc tiến độ và chất lượng của dự án ngoài, dung lượng cài đặt tăng đáng kể.
- **Lưu trữ:** cục bộ, không xây cloud/server mới. Chia sẻ team đi qua relay boss đã có, nên máy boss phải bật thì nhân viên mới lấy được profile.
- **Proxy:** tái dùng kho proxy hiện có, không tạo kho riêng, không tích hợp API nhà cung cấp ở MVP.
- **Quy mô:** ≤1.000 profile, ≤30 mở đồng thời trên một máy. Spike đo được khoảng 290 MB mỗi profile với một tab trang đăng nhập nhẹ, tức 30 profile cần ít nhất 8,5 GB; máy 16 GB không đủ khi dùng thật.
- **Phiên bản nhân trình duyệt:** `fingerprint-chromium` phát hành 2–4 tháng một bản và đang chậm hơn Chrome chính thức (bản 148 từ 06/2026). Dự án do một tác giả duy trì, không có hỗ trợ; lớp khởi chạy phải đổi được nhân khác.
- **Proxy có mật khẩu:** nhân trình duyệt không nhận username/password qua tham số proxy, trong khi kho proxy hiện có lưu hai trường này; AHV Connect phải tự xử lý xác thực proxy cho từng profile.
- **Thương mại:** MVP chỉ phục vụ nội bộ AHV; không làm license, gói cước, kích hoạt.
- **Thời hạn:** không có mốc cứng.
- **Bảo mật:** cookie/session của profile là dữ liệu nhạy cảm ngang mật khẩu. Hiện `safeStorage` có fallback plaintext (TD-04) và chưa có backup tự động (TD-05); thiết kế phải nêu rõ cách bảo vệ dữ liệu profile khi lưu và khi truyền qua relay.
- **Chính sách nền tảng:** vận hành nhiều tài khoản bằng fingerprint giả lập có rủi ro vi phạm điều khoản của Facebook/TikTok/Zalo và bị khóa tài khoản, cùng loại rủi ro đã ghi ở TD-06.
- **Giấy phép:** AHV Connect phát hành theo MIT; giấy phép của nhân trình duyệt phải tương thích, đặc biệt khi bán ra ngoài sau này.
- **Quy tắc dự án (`AGENTS.md`):** identifier bằng tiếng Anh, thay đổi nhỏ nhất an toàn, tái dùng pattern có sẵn, không regress tính năng đang chạy, làm ở dev trước, production chỉ chạy artifact đã build.

## Open questions

1. **Hoàn tất kiểm chứng `fingerprint-chromium`.** Spike ngày 01/10/2026 đã đo bản Linux (màn hình ảo) và bản Windows (máy ảo không GPU): fingerprint ổn định theo seed và khác nhau giữa các seed trên cả hai. Còn thiếu: WebGL trên máy Windows có GPU thật, CreepJS/pixelscan/browserleaks/iphey trên Windows, rò IP qua proxy thật, và nuôi tài khoản Facebook/TikTok/Zalo thật.
   - Persona có được khác hệ điều hành máy thật không? Spike thấy font máy thật lọt ra theo cả hai chiều (Windows giả Linux và Linux giả Windows); đề xuất MVP chỉ cho persona trùng hệ điều hành máy thật.
   - Xử lý thế nào khi nhân trình duyệt chậm phiên bản nhiều tháng so với Chrome chính thức?
2. **Phân phối nhân trình duyệt:** đóng gói sẵn trong bộ cài hay tải về lần đầu dùng? Cập nhật phiên bản nhân bằng cách nào?
3. **Baseline nghiệm thu "không bị khóa":** bao nhiêu tài khoản, chạy bao lâu, tỉ lệ khóa hiện tại của tool đang thuê là bao nhiêu? Tool đang thuê cụ thể là tool nào và chi phí bao nhiêu?
4. **Nguồn fingerprint:** sinh ngẫu nhiên từ bộ dữ liệu thiết bị thật của nhân trình duyệt, hay cho người dùng chỉnh tay từng thông số? Hệ điều hành giả lập có được khác hệ điều hành thật của máy không?
5. **Bảo vệ dữ liệu profile:** mã hóa thư mục profile khi lưu ở mức nào, và xử lý fallback plaintext của `safeStorage` ra sao?
6. **Profile có liên kết với account Zalo/Facebook/Telegram hiện có không?** MVP coi là độc lập; có cần liên kết về sau không?
7. **Giới hạn tài nguyên:** cấu hình máy tối thiểu để mở 30 profile đồng thời; hành vi khi vượt ngưỡng (chặn, cảnh báo, xếp hàng)?
8. **Đợt 2 — đồng bộ profile qua relay:** truyền nguyên thư mục profile hay chỉ cookie/storage? Xử lý xung đột khi hai người cùng mở, và khi máy boss tắt?
9. **Đợt 2 — mô hình quyền:** quyền trên profile (xem/mở/sửa/xóa) dùng mô hình module employee hay mô hình ERP role? Hai mô hình này hiện chưa thống nhất (TD-09).
10. **Thứ tự đợt 3+:** synchronizer trước hay automation không code trước?
11. **macOS:** có cần hỗ trợ khi bán ra ngoài không, và khi nào?
12. **Thương mại hóa:** mô hình license, giới hạn theo gói, có cần cloud không; tên module/thương hiệu khi bán.
13. **Pháp lý:** có cần điều khoản sử dụng/miễn trừ trách nhiệm khi cung cấp công cụ antidetect cho khách ngoài không?
