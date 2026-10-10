# GĐ1 — Thay đổi và kết quả kiểm chứng

**Ngày:** 10/10/2026. **Worktree:** `/home/maiychrus/deplao-builder-poster-ui`. **Nhánh:** `feat/poster-postiz-ui`.

**Trạng thái:** đã triển khai phạm vi mã nguồn GĐ1 và build renderer. Chưa đủ điều kiện nghiệm thu toàn bộ GĐ1 vì chưa chạy được hai vòng UI desktop/mobile × dark/light trong môi trường này. Không commit, push, deploy, migration hoặc sửa production.

## Phạm vi đã triển khai

- Thay năm tab bằng rail bốn mục, top bar, panel Kênh và Calendar; dùng branding MaiHub. Kích thước, màu và khoảng cách tham chiếu source Postiz thật, tự viết component trong React hiện có.
- Kênh lấy từ `browserProfile.list`, nhóm theo nhóm profile; tìm kiếm, thu gọn và lọc lịch theo kênh. Metadata nền tảng tách khỏi component panel. “Thêm kênh” mở màn Trình duyệt hiện có.
- Calendar ngày/tuần/tháng, tuần bắt đầu thứ Hai, header dính, now-line theo phút, chọn ô tương lai để soạn, lọc trạng thái và chi tiết bài. Dùng `scheduleList`, `schedulesChanged`, `runFinished`; không tạo dữ liệu giả.
- Kéo-thả chỉ áp dụng cho lịch một lần (cập nhật `runAt`). Lịch lặp không kéo được vì cả chuỗi dùng chung một giờ — dời một buổi sẽ ngầm dời/mất các buổi khác; đổi giờ lịch lặp qua "Sửa giờ". Chặn dời vào quá khứ, lịch đã chạy hoặc đang chờ; mobile có “Sửa giờ” thay thao tác kéo-thả.
- Giữ chế độ danh sách để quản lý lịch nằm ngoài khoảng ngày đang xem; giữ bật/tạm dừng, sửa giờ, xoá có xác nhận và liên kết lịch sử.
- Soạn bài trong dialog: editor và preview Facebook, nhóm/Trang, profile, chọn/quét/lọc nhóm, link nhóm thủ công, ảnh/video kéo-thả và sắp thứ tự, bình luận đầu, đăng ngay, lịch một lần/lặp lại. Giữ giới hạn nội dung, validation và tuỳ chọn vận hành.
- Gỡ `AIAssistPanel` khỏi trình soạn. Nội dung soạn dở giữ trong phiên đóng/mở dialog; không có draft DB.
- Tái dùng Tham gia nhóm, Thu bình luận, Lịch sử, ProfilePicker và RunPanel; scope token để đổi diện mạo. Tiến độ tự mở khi có việc, giữ subscription, giới hạn 500 dòng và thao tác huỷ hiện có.
- Plus Jakarta Sans lưu local, gồm subset tiếng Việt, Latin mở rộng, Latin và giấy phép SIL OFL. Đây là font bên thứ ba của Google Fonts, không phải asset thương hiệu Postiz. Tham chiếu giấy phép: [Google Fonts OFL](https://github.com/google/fonts/blob/main/ofl/plusjakartasans/OFL.txt).

## Danh sách file

### Đã sửa

| File | Thay đổi |
| --- | --- |
| [FacebookPosterView.tsx](../../src/ui/features/facebookPoster/FacebookPosterView.tsx) | Khung mới, adapter kênh, modal và tiến độ |
| [PostTab.tsx](../../src/ui/features/facebookPoster/PostTab.tsx) | Editor trong dialog, preview, gỡ AI, lỗi inline |
| [ScheduleTab.tsx](../../src/ui/features/facebookPoster/ScheduleTab.tsx) | Calendar, danh sách, chi tiết và dời lịch |
| [ScheduleDialog.tsx](../../src/ui/features/facebookPoster/ScheduleDialog.tsx) | Dialog native, thời điểm mặc định từ calendar |
| [MediaPicker.tsx](../../src/ui/features/facebookPoster/MediaPicker.tsx) | Vùng kéo-thả và lỗi hiện trong dialog |
| [index.css](../../src/ui/index.css) | Font, token scoped, layout và responsive |
| [tailwind.config.js](../../tailwind.config.js) | Ánh xạ token Poster |
| [DESIGN.md](../../DESIGN.md) | Token và quyết định thiết kế GĐ1 |

### Đã tạo

| File | Mục đích |
| --- | --- |
| [ChannelsPanel.tsx](../../src/ui/features/facebookPoster/ChannelsPanel.tsx) | Panel kênh nhận metadata nền tảng |
| [PostPreview.tsx](../../src/ui/features/facebookPoster/PostPreview.tsx) | Preview nhóm/Trang, media và bình luận đầu |
| [calendarModel.ts](../../src/ui/features/facebookPoster/calendarModel.ts) | Khoảng ngày, occurrence và patch dời lịch |
| [calendarModel.test.ts](../../src/__tests__/facebookPoster/calendarModel.test.ts) | 8 test logic calendar và dữ liệu lớn |
| [posterPreview.test.ts](../../src/__tests__/facebookPoster/posterPreview.test.ts) | 7 test SSR, escaping, media, kênh và tương phản |
| [plus-jakarta-sans-vietnamese.woff2](../../public/fonts/plus-jakarta-sans-vietnamese.woff2) | Font subset tiếng Việt |
| [plus-jakarta-sans-latin-ext.woff2](../../public/fonts/plus-jakarta-sans-latin-ext.woff2) | Font Latin mở rộng |
| [plus-jakarta-sans-latin.woff2](../../public/fonts/plus-jakarta-sans-latin.woff2) | Font Latin |
| [OFL.txt](../../public/fonts/OFL.txt) | Giấy phép font, được chép vào artifact |
| [poster-gd1-plan.md](poster-gd1-plan.md) | Kế hoạch và phạm vi |
| [poster-gd1-verification.md](poster-gd1-verification.md) | Báo cáo này |

Không sửa brief, intent, mockup của operator; không sửa backend, DB, IPC contract, dependency hoặc cấu hình production. `node_modules` là symlink dùng dependency đã cài ở worktree chính; không rebuild native dependency dùng chung. `dist/` là artifact build, không phải mã nguồn mới để commit.

## Kiểm chứng tự động

Các tiến trình nặng chạy lần lượt, không chạy đồng thời. RTK được dùng với `RTK_TELEMETRY_DISABLED=1`, `XDG_DATA_HOME=/tmp/poster-rtk`; các lỗi và log đầy đủ được giữ lại.

### Typecheck và build

| Lệnh | Kết quả |
| --- | --- |
| `npx tsc -p tsconfig.electron.json --noEmit` | Exit 0, không có lỗi/output |
| `npx tsc -p tsconfig.json --noEmit` | Exit 0, không có lỗi/output |
| `npx vite build` | Exit 0; 1.804 module; artifact `dist/` |
| `git diff --check` | Exit 0, không có output |

Output cuối của Vite:

```text
✓ 1804 modules transformed.
✓ built in 19.52s
```

Build có warning tại module ngoài GĐ1: `crypto` trong `backendService`, `eval` của `lottie-web`, import tĩnh/động cùng module và chunk lớn. Không thay bundling toàn app trong phạm vi UI này.

Đã kiểm font trong `dist/fonts/`, giấy phép `OFL.txt` và CSS artifact tham chiếu `../fonts/...woff2`, phù hợp base tương đối của Electron.

### Jest Facebook Poster và theme

```sh
npx jest src/__tests__/facebookPoster src/__tests__/ui/themeTokens.test.ts src/__tests__/ui/theme.test.ts --runInBand --testPathIgnorePatterns 'FacebookPoster(Service|Scheduler|Store)\.test\.ts'
```

Output:

```text
Test Suites: 20 passed, 20 total
Tests:       391 passed, 391 total
Snapshots:   0 total
```

Exit 0. Ba suite SQLite được loại khỏi lần chạy này theo ngoại lệ rõ trong brief; không xoá, sửa hay bỏ qua test khác. Log đầy đủ: `/tmp/poster-jest-round2.log`.

Các hành vi có bằng chứng test trong bộ này: validation tham số và media, first-comment flow, thời điểm/patch/media của lịch, CSV, parser mục tiêu, helper đăng/quét/tham gia nhóm/thu bình luận trên fixture, preview và tương phản. Subscription/log–progress của RunPanel được review source, chưa kiểm UI runtime. Đây là kiểm chứng module/fixture; không thay thế thao tác end-to-end trên UI hoặc Facebook thật.

### Toàn bộ test và lệnh Make

Đã chạy `npm test -- --runInBand`:

```text
Test Suites: 5 failed, 34 passed, 39 total
Tests:       90 failed, 603 passed, 693 total
```

Exit 1. Ba suite `FacebookPosterService`, `FacebookPosterScheduler`, `FacebookPosterStore` bị native `better-sqlite3` lệch `NODE_MODULE_VERSION 145` so với Node yêu cầu `137`. Hai suite `ProxyForwarder`, `BrowserEngineManager` bị `listen EPERM: operation not permitted 127.0.0.1` và timeout vì sandbox không cho mở cổng. Không báo toàn bộ test xanh. Log: `/tmp/poster-full-tests.log`.

Đã thử các lệnh quy định ở AGENTS, nhưng repo không có target/Makefile tương ứng:

```text
make: *** No rule to make target 'build'.  Stop.
make: *** No rule to make target 'test'.  Stop.
make: *** No rule to make target 'lint'.  Stop.
```

Mỗi lệnh exit 2. Không có script lint trong `package.json`; không thêm cấu hình lint ngoài phạm vi. Dùng các lệnh tsc/Jest/Vite đúng brief để kiểm chứng thay thế.

## Hai vòng stress và review

| Vòng | Phần đã kiểm | Desktop/mobile dark/light thực tế |
| --- | --- | --- |
| 1 | 1.000 lịch lặp trong tháng sáu tuần, lọc 500 lịch theo một kênh; tên kênh 300 ký tự, bài 63.206 ký tự, comment 8.000 ký tự; 10 ảnh/video; escaping và tương phản. Jest Poster: 18 suite / 274 test đạt. | Chưa chạy được: harness Vite bị `listen EPERM`, Chrome bị sandbox chặn khởi động. |
| 2 | Chạy lại stress dữ liệu cùng bộ hồi quy và theme: 20 suite / 391 test đạt; thêm regression cho queued occurrence, kiểm chuyển trạng thái chi tiết. Review source breakpoint desktop/mobile và nội dung dài. | Chưa chạy được: Chromium headless shell bị lỗi sandbox socket; Firefox headless bị quyền filesystem/runtime chặn. |

Không có screenshot hoặc bằng chứng hình học thực tế để kết luận không overflow/đè chữ. Không đánh dấu hai vòng UI đạt.

Review độc lập đã đọc diff và file mới. Đã xử lý: snapshot chi tiết bị cũ sau bật/tạm dừng; lịch recurring queued bị nhầm với lần tương lai; lỗi thao tác bị toast ngoài native dialog che; phân loại chi tiết không cập nhật khi queued/hoàn tất. Self-check ba chuyển trạng thái chi tiết đạt. Kiểm lại diff sau sửa. Không còn finding P1/P2 từ lượt review đã thực hiện; native focus vẫn cần kiểm thực tế.

## Phần còn phải xác minh để nghiệm thu GĐ1

Chạy hai vòng trên desktop và mobile width, mỗi vòng cả light/dark. Tối thiểu dùng desktop 1440×900 và mobile 390×844, thêm 320 px để kiểm nội dung hẹp:

1. Rail, nút Kênh, tìm/thu gọn/lọc kênh, Thêm kênh; không overflow ngang cấp trang.
2. Calendar ngày/tuần/tháng qua tháng/năm, now-line; nhiều bài cùng giờ, bộ lọc và lỗi tải/thử lại.
3. Composer nhóm/Trang; chọn nhiều profile, lọc/chọn nhóm, link thủ công; đóng/mở giữ dữ liệu. Preview đúng nhóm theo bộ lọc.
4. Chọn/kéo-thả ảnh và video, đổi thứ tự, xoá, quá giới hạn và IPC lỗi. Preview và thông báo phải thấy trong dialog.
5. Đăng ngay và hẹn một lần/lặp lại; busy chặn đăng ngay nhưng vẫn cho hẹn; tiến độ hiện, huỷ có xác nhận.
6. Kéo-thả lịch một lần/lặp lại, hủy xác nhận, đích quá khứ, bài đang chờ; “Sửa giờ” trên mobile. Lịch sử và danh sách vẫn mở được.
7. Join, quét nhóm, collect comments, tìm kiếm, xuất CSV, xem kết quả và log/progress với IPC thực tế.
8. Tab/focus, Escape chỉ đóng dialog trên cùng, quay lại nơi mở; kiểm chữ dài, không che hành động chính.

Không gửi bài, tham gia nhóm hoặc thu bình luận thật trong phiên này. Chưa xác minh automation Facebook end-to-end; các đường gọi và backend hiện có được giữ lại.

## Giới hạn có chủ đích và rollback

- Lịch lặp chiếu các lần tương lai và lần chạy gần nhất backend trả về; lịch sử đầy đủ vẫn ở màn Lịch sử. Không tự dựng các lần đăng quá khứ.
- Chi tiết lịch liệt kê tên tệp đã lưu; API hiện trả tên tệp media đã lưu, không cung cấp đường dẫn tuyệt đối để render thumbnail. Composer vẫn preview ảnh/video local thật. Không mở rộng backend để lấy ảnh lịch trong GĐ1.
- Draft DB, duyệt bài và provider khác thuộc GĐ2; không tạo abstraction/backend dự phòng. Không copy code/logo/asset thương hiệu Postiz.
- Thay đổi nhỏ nhất trong ranh giới UI: tái dùng component, IPC và helper đã có; chỉ thêm model lịch thuần, panel kênh và preview; không thêm dependency.
- Rollback bằng review/revert riêng diff GĐ1 và file mới được liệt kê ở trên; giữ nguyên intent/handoff/mockup của operator. Không dùng reset toàn worktree.

Graph đã index nhưng truy vấn và coverage bị policy quyền chặn; bằng chứng cấu trúc lấy từ source trực tiếp. Không khẳng định coverage graph đầy đủ. `WORKFLOW.md` đọc ở `~/.codex/WORKFLOW.md`; checklist tạo file và wiki/RULES được chỉ định không có ở đường dẫn đã tìm.
