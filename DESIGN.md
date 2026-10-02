---
brand:
  name: AHV Connect
  owner: Trung tâm Đào tạo Lái xe AHV
color:
  logo:
    brand-900: "#1E40AF"   # điểm bắt đầu dải màu nền (góc trên trái)
    brand-500: "#3B82F6"   # điểm kết thúc dải màu nền (góc dưới phải)
    mark-fg:   "#FFFFFF"   # mặt đường và vạch kẻ
    badge:     "#EF4444"   # chấm báo tin chưa đọc
    badge-ring: "#1E40AF"  # vòng tách chấm khỏi thân chữ
  light:
    # nền đặc (kênh --rgb-*)
    bg-deep: "#e9e9ee"
    bg: "#f2f2f7"
    bg-mid: "#f7f7fa"
    surface: "#ffffff"
    surface-mid: "#f5f5f7"
    surface-raised: "#ffffff"
    control: "#ebebf0"
    control-hover: "#e0e0e5"
    control-strong: "#d1d1d6"
    # chữ
    text-primary: "#1d1d1f"
    text-primary-soft: "#1d1d1f"
    text-secondary-strong: "#3a3a3c"
    text-secondary: "#545458"
    text-tertiary: "#636366"
    text-disabled: "#aeaeb2"
    # viền đặc (dùng qua Tailwind)
    border-subtle: "#ececf0"
    border-solid: "#e3e3e8"
    border-strong-solid: "#d6d6db"
    border-heavy: "#c7c7cc"
    # màu nhấn
    accent: "#007aff"
    accent-text: "#0062c4"
    accent-fill: "#0071e3"
    accent-fill-hover: "#0068d6"
    accent-fill-pressed: "#0062c4"
    # trạng thái
    red: "#ff3b30"
    green: "#34c759"
    orange: "#ff9f0a"
    # lớp phủ trong suốt (CSS viết tay)
    hover: "rgba(0, 0, 0, 0.045)"
    selected: "rgba(0, 122, 255, 0.12)"
    border: "rgba(0, 0, 0, 0.075)"
    border-strong: "rgba(0, 0, 0, 0.12)"
    sidebar-material: "rgba(242, 242, 247, 0.82)"
    sidebar-solid: "#ececf1"
    toolbar: "rgba(250, 250, 252, 0.72)"
    overlay: "rgba(0, 0, 0, 0.25)"
    scrollbar-thumb: "rgba(128, 128, 128, 0.22)"
    scrollbar-thumb-hover: "rgba(128, 128, 128, 0.35)"
  dark:
    # nền đặc (kênh --rgb-*)
    bg-deep: "#0f0f10"
    bg: "#151516"
    bg-mid: "#1a1a1c"
    surface: "#1f1f21"
    surface-mid: "#262628"
    surface-raised: "#2c2c2e"
    control: "#2c2c2e"
    control-hover: "#3a3a3c"
    control-strong: "#48484a"
    # chữ
    text-primary: "#f5f5f7"
    text-primary-soft: "#e5e5ea"
    text-secondary-strong: "#d1d1d6"
    text-secondary: "#c0c0c5"
    text-tertiary: "#a5a5aa"
    text-disabled: "#636366"
    # viền đặc (dùng qua Tailwind)
    border-subtle: "#232325"
    border-solid: "#2a2a2c"
    border-strong-solid: "#3a3a3c"
    border-heavy: "#48484a"
    # màu nhấn
    accent: "#0a84ff"
    accent-text: "#5aabff"
    accent-fill: "#0071e3"
    accent-fill-hover: "#0068d6"
    accent-fill-pressed: "#0062c4"
    # trạng thái
    red: "#ff453a"
    green: "#30d158"
    orange: "#ff9f0a"
    # lớp phủ trong suốt (CSS viết tay)
    hover: "rgba(255, 255, 255, 0.055)"
    selected: "rgba(10, 132, 255, 0.2)"
    border: "rgba(255, 255, 255, 0.085)"
    border-strong: "rgba(255, 255, 255, 0.14)"
    sidebar-material: "rgba(29, 29, 31, 0.88)"
    sidebar-solid: "#1d1d1f"
    toolbar: "rgba(30, 30, 32, 0.78)"
    overlay: "rgba(0, 0, 0, 0.5)"
    scrollbar-thumb: "rgba(128, 128, 128, 0.22)"          # kế thừa từ light
    scrollbar-thumb-hover: "rgba(128, 128, 128, 0.35)"
typography:
  font-family: '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", "Noto Sans", Ubuntu, sans-serif'
  size:
    body: 13        # 0.8125rem; text-sm, nền body
    small: 12       # text-xs
    label: 10       # nhãn nhóm, số đếm, phiên bản
    badge: 9        # huy hiệu nút toolbar
  weight:
    regular: 400
    medium: 500     # nút
    semibold: 600   # tiêu đề toolbar
    label: 650      # tên thương hiệu, nhãn nhóm, số đếm
    bold: 700       # huy hiệu
  label-tracking: 0.04em   # nhãn viết hoa (.app-group-title, .mac-popover-title)
  smoothing: antialiased
radius:
  sm: 7        # --radius-sm
  md: 10       # --radius-md
  lg: 14       # --radius-lg: hộp thoại (.mac-alert)
  xl: 18       # --radius-xl
  control: 8   # rounded-lg: nút, ô nhập, hàng sidebar, nút toolbar
  popover: 13  # .mac-popover
  toast: 9     # .mac-toast
  brand-mark: 8
elevation:
  shadow-card:
    light: "0 1px 2px rgba(0, 0, 0, 0.03), 0 5px 20px rgba(0, 0, 0, 0.045)"
    dark: "0 1px 2px rgba(0, 0, 0, 0.2), 0 5px 20px rgba(0, 0, 0, 0.25)"
  shadow-popover:      # cũng là shadow-2xl của Tailwind
    light: "0 20px 60px rgba(0, 0, 0, 0.18)"
    dark: "0 20px 60px rgba(0, 0, 0, 0.6)"
layout:
  sidebar-width: 240
  rail-width: 64
  rail-width-mac: 76     # chừa chỗ traffic light
  toolbar-height: 52
  nav-item-height: 33
  account-row-height: 36
  toolbar-button: 32
  window-button-width: 46   # nút tự vẽ khi không có nút gốc
  native-controls-height: 52
  page-size-browser: 50     # dòng mỗi trang, màn Trình duyệt
  breakpoints:
    md: hiện cột Nhóm và Proxy (màn Trình duyệt)
    lg: hiện cột Mở gần nhất (màn Trình duyệt)
motion:
  press: 100     # ms, .app-toolbar-btn:active scale(.94)
  hover: 140     # ms, hover hàng và nút; .mac-popover (macPopIn)
  control: 150   # ms, .btn-primary, .btn-secondary, chevron
  sidebar: 200   # ms, thu gọn/mở rộng sidebar
  reduced-motion: "prefers-reduced-motion: reduce đặt mọi animation/transition về 0,01 ms"
accessibility:
  text-contrast: "4.5:1"          # chữ thường, mọi cặp chữ/nền trong hai theme
  non-text-contrast: "3:1"        # viền, icon, focus ring, chấm trạng thái
  focus-ring: "3px accent 35%"    # .btn-primary, .btn-secondary, .input-field
  enforced-by: src/__tests__/ui/themeTokens.test.ts
geometry:
  canvas: 100            # viewBox 100x100, mọi số đo dưới đây theo đơn vị này
  corner-radius: 22
  mark-apex-y: 17
  mark-base-y: 84
  mark-width: [15, 85]   # mép ngoài trái/phải ở đáy
  road-vanishing-point: [50, 32]
  road-base: [30, 70]    # mép trong trái/phải ở đáy
  crossbar-y: [72, 79]
  crossbar-x: [26, 74]
source:
  file: resources/icons/icon.svg
  build: node scripts/build-icons.mjs
sizes:
  png: [128, 1024]
  ico: [16, 32, 48, 64, 128, 256]
  icns: [16, 32, 128, 256, 512, 1024]
---

# AHV Connect — nhận diện và hệ thiết kế

Tài liệu này là nguồn sự thật cho **nhận diện (logo) và toàn bộ giao diện** của
AHV Connect. Token ở đầu file khớp từng giá trị với `src/ui/index.css`
(`:root` cho light, `html[data-theme="dark"]` cho dark). Khi sửa token, sửa cả
hai nơi và để test tương phản chạy lại.

## Nguyên tắc (hướng North)

- **Nội dung trước khung.** Chrome (sidebar, toolbar) lùi về nền, viền mảnh,
  không màu nhấn; màu nhấn dành cho thứ đang chọn và hành động chính.
- **Light là nền xám nhạt, không phải trắng.** `bg` `#f2f2f7` là canvas; panel
  và thẻ trắng nổi lên trên. Dark có nhiều cấp surface (`bg-deep` → `bg` →
  `surface` → `surface-raised`) thay cho một nền đen phẳng.
- **Vật liệu chỉ ở sidebar, và chỉ khi hệ điều hành hỗ trợ.** macOS dùng
  vibrancy, Windows 11 (build 22621 trở lên) dùng mica; renderer đặt
  `html[data-material]` (`vibrancy` | `mica` | `none`). Có vật liệu thì sidebar
  dùng `sidebar-material` bán trong suốt; không có thì `sidebar-solid` đặc.
  Vùng nội dung luôn có nền đặc `bg`.
- **Chữ 13 px, hệ thống font gốc.** Không đóng gói font; `text-sm` là 13 px.
- **Chuyển động ngắn và tắt được.** 140 ms cho hover, tắt hẳn khi người dùng
  chọn giảm chuyển động.
- **Một hệ cho mọi màn.** Màn Trình duyệt (`src/ui/features/browser/`) dùng
  chính các token và class dưới đây, không có bộ token riêng.

## Không viết mã màu hex trong component mới

Component mới dùng class Tailwind đã nối token (bảng dưới) hoặc `var(--…)` /
class shell. Cần màu chưa có thì **thêm token** vào `src/ui/index.css` (cả light
và dark) và vào đầu file này, không viết `#rrggbb` hay `rgb()` trong component.
Ngoại lệ có chủ đích: màu trạng thái đỏ nút cửa sổ đóng (`#c42b1c`), chữ trắng
trên nền màu, và ảnh xem trước theme trong Cài đặt (cố định để so sánh).

## Tailwind nối token như thế nào

`tailwind.config.js` khai báo bảng màu **riêng cho từng loại utility** dưới dạng
`rgb(var(--rgb-<tên>) / <alpha-value>)`, nên `bg-gray-800/80` vẫn chạy. Cùng một
sắc gray trỏ tới token khác nhau tuỳ vai trò: `bg-gray-700` là nền control,
`border-gray-700` là viền. Sắc không liệt kê giữ màu mặc định Tailwind.

| Utility | Sắc | Token |
|---|---|---|
| `bg-gray-*` | 950 | `bg-deep` |
| | 900 | `bg` |
| | 850 | `bg-mid` |
| | 800 | `surface` |
| | 750 | `surface-mid` |
| | 700 | `control` |
| | 600 | `control-hover` |
| | 500 | `control-strong` |
| `text-gray-*` | 100 | `text-primary` |
| | 200 | `text-primary-soft` |
| | 300 | `text-secondary-strong` |
| | 400 | `text-secondary` |
| | 500, 600 | `text-tertiary` |
| `border-gray-*`, `divide-gray-*` | 900, 800 | `border-subtle` |
| | 700 | `border` (đặc: `border-solid`) |
| | 600 | `border-strong` (đặc: `border-strong-solid`) |
| | 500, 400 | `border-heavy` |
| `placeholder-gray-*` | 600, 500, 400 | `text-tertiary` |
| `ring-gray-*` | 700 | `border-strong` (đặc) |
| `bg-blue-*` | 500, 600 | `accent-fill` |
| | 700 | `accent-fill-hover` |
| `text-blue-*` | 300, 400, 500, 600 | `accent-text` |
| `border-blue-*`, `ring-blue-*` | 400, 500, 600 | `accent` |
| `shadow-2xl` | | `shadow-popover` |
| `text-sm` | | 13 px, line-height 1,25 rem |
| `bg-sidebar`, `bg-sidebar-hover` | | `sidebar-solid`, `hover` |

Ghi chú: viền dùng giá trị đặc (tương đương token rgba trên `bg`) vì Tailwind
cần kênh màu đặc cho biến thể độ mờ. `text-white` ở light được ghi đè về
`var(--text-primary)` trong `src/ui/index.css`, trừ khi nằm trên nền màu. Trên
`bg-gray-500` chỉ dùng chữ primary hoặc secondary.

## Tương phản

- Chữ thường đạt **4,5:1**, thành phần không phải chữ (viền, icon, focus ring)
  đạt **3:1**, ở cả light và dark, trên nền xấu nhất của từng token chữ.
- `text-secondary`, `text-tertiary`, `accent-text` và `accent-fill` ở trên là
  giá trị đã chỉnh sáng/tối hơn bản gốc để đạt ngưỡng; đừng làm nhạt lại.
- `text-disabled` được miễn (trạng thái vô hiệu).
- **Test giữ quy tắc:** `src/__tests__/ui/themeTokens.test.ts` đọc token trực
  tiếp từ `src/ui/index.css` và `tailwind.config.js`, kiểm mọi cặp chữ/nền. Đổi
  token mà test đỏ thì sửa token, không sửa test.
- Trạng thái không chỉ dựa vào màu: cảnh báo "Không proxy" ở màn Trình duyệt dùng
  màu cảnh báo kèm chữ, vì profile không proxy lộ IP thật và phải nhìn thấy ngay.

## Cửa sổ theo hệ điều hành

| | macOS | Windows 11 | Windows 10 | Linux |
|---|---|---|---|---|
| Nút cửa sổ | Traffic light thật, căn giữa hàng đầu sidebar (`trafficLightPosition` 20,20) | Nút gốc qua `titleBarOverlay`, cao 52 px, màu theo theme | như Windows 11 | Traffic light tự vẽ bên phải toolbar (vàng thu nhỏ, xanh phóng to, đỏ đóng), cửa sổ không khung |
| Vật liệu | vibrancy `sidebar` | mica (build ≥ 22621) | nền đặc | nền đặc |

Nút cửa sổ do hệ điều hành vẽ trên macOS và Windows. Linux: overlay gốc vẽ nút
kiểu Windows, không theo theme KDE, nên toolbar vẽ `.app-traffic` (ba chấm 12 px,
cách nhau 8 px, ký hiệu hiện khi rê chuột vào nhóm; màu đèn là hằng số nền tảng).
`.app-window-btn` (46 × 52 px) chỉ còn là nhánh dự phòng khi Windows tắt nút gốc. Đổi theme thì main cập nhật màu overlay và nền
cửa sổ (`window:setAppearance`). Toolbar chừa chỗ cho nút gốc ở mép phải
(`.app-toolbar.has-native-controls`).

## Thành phần shell

Định nghĩa trong `@layer components` của `src/ui/index.css`; dùng lại, không
viết kiểu riêng.

| Class | Vai trò |
|---|---|
| `.app-sidebar` | Cột trái 240 px (`.is-collapsed`: 64 px), nền `sidebar-solid` hoặc `sidebar-material`, viền phải `border`. Con: `.app-brand`, `.app-group-title`, `.app-account`, `.app-nav-item` (33 px, bo 8, đang chọn `selected` + `accent-text`), `.app-count`, `.app-nav-dot` |
| `.app-toolbar` | Cao 52 px phía trên nội dung. Con: `.app-toolbar-title` (13 px, 600), `.app-toolbar-btn` (32 × 32, bo 8, hover `hover`, nhấn scale .94), `.app-toolbar-badge`, `.app-toolbar-sep`. Vùng kéo cửa sổ là `.app-drag`; nút và popup con tự `no-drag` |
| `.mac-popover` | Popover/menu: nền `surface-raised`, viền `border-strong`, bo 13, `shadow-popover`, vào bằng `macPopIn` 140 ms. `.mac-popover-title` là nhãn nhóm viết hoa |
| `.mac-menu-item` | Hàng menu cao tối thiểu 32 px, bo 8, hover `hover`; `.mac-menu-sep` là vạch ngăn |
| `.mac-alert` | Hộp thoại (ConfirmDialog): nền `surface-raised`, viền `border-strong`, bo 14, `shadow-popover`; `.mac-overlay` là lớp phủ `overlay` |
| `.mac-toast` | Toast: giữa đáy, nền `surface-raised`, bo 9, `shadow-popover`, giữ màu theo loại |
| `.btn-primary` | Nền `accent-fill`, hover `accent-fill-hover`, chữ trắng 13 px 500, bo 8, focus ring 3 px `accent` 35% |
| `.btn-secondary` | Nền `control`, chữ `text-primary`, viền `border`; trong `.mac-alert`/`.mac-popover` nền đậm hơn một bậc (`control-hover`) |
| `.input-field` | Nền `control`, không viền, bo 8, placeholder `text-tertiary`, focus ring như nút |

## Màn hình Trình duyệt

Màn `src/ui/features/browser/` là một phần của hệ chung, không có token riêng.
Nó dùng đúng các class gray/blue ở bảng trên, nên dark và light tự nhất quán.
Những quyết định còn hiệu lực:

- **Bảng thay vì thẻ.** Người dùng quản lý đến 1.000 profile, cần so sánh, chọn
  nhiều, thao tác hàng loạt. Ở chiều rộng hẹp, cột phụ ẩn đi (`md`, `lg`) thay
  vì cuộn ngang cấp trang. Mỗi trang 50 dòng.
- **Xác nhận trước thao tác mất dữ liệu.** Xoá profile và tạo lại fingerprint
  đều qua `showConfirm`, nêu rõ hậu quả.
- **Trạng thái đầy đủ.** Đang tải, lỗi kèm nút thử lại, rỗng, không khớp bộ lọc,
  chưa cài nhân trình duyệt, hệ điều hành chưa hỗ trợ.
- **Truy cập.** Nút chỉ có icon đều có `aria-label`; ô nhập có `label` hoặc
  `aria-label`; modal có `role="dialog"` và `aria-modal`; lỗi dùng `role="alert"`.
- **Màu trạng thái** dùng bảng màu trạng thái mặc định của Tailwind (xanh lá =
  đang chạy, vàng = cảnh báo/không proxy, đỏ = xoá/lỗi), chưa nối token.

## Dấu hiệu

Một con đường nhìn theo phối cảnh. Hai mép đường chụm về điểm tụ, tạo thành
chữ **A** của AHV. Vạch kẻ ngang đường đồng thời là vạch ngang của chữ A. Hai
vạch tim đường thu nhỏ dần về phía xa.

Ý nghĩa đặt trong ngữ cảnh: sản phẩm dùng cho một trung tâm đào tạo lái xe, nên
dấu hiệu nói về **đường đi**, không phải về nhắn tin. Tên sản phẩm đã mang chữ
"Connect" rồi, logo không cần nhắc lại.

## Vì sao không dùng vô-lăng

Vô-lăng là hình đầu tiên ai cũng nghĩ tới cho trường lái, nhưng nó hỏng ở đúng
chỗ quan trọng nhất: **icon khay hệ thống cỡ 16px**. Nan vô-lăng ở cỡ đó mỏng
dưới một pixel, tan hết, chỉ còn lại một vòng tròn vô nghĩa. Bản thử đầu tiên
đã vẽ vô-lăng và đúng là như vậy.

Chữ A thì chịu được cỡ nhỏ: khi các chi tiết tan đi, thứ còn lại vẫn là một
chữ A đặc, vẫn nhận ra.

## Ràng buộc tỉ lệ (đã kiểm bằng mắt ở 16/24/32/48/64px)

| Quyết định | Lý do |
|---|---|
| Mép đường mảnh (~15 đơn vị ở đáy) | Chân chữ dày thì lòng đường hẹp lại, phối cảnh không đọc ra, chỉ còn là chữ A thường |
| Vạch ngang hạ thấp (y = 72…79) | Để phần lớn lòng đường nằm phía trên vạch, đủ chỗ cho vạch tim thu xa |
| Vạch ngang kéo từ x = 26 đến 74 | Nằm sâu trong hai chân chữ ở **mọi** độ cao của khoảng y = 72…79, nên mối nối luôn liền, không hở ở đáy vạch |
| Đỉnh chữ cắt bằng, không nhọn | Đỉnh nhọn ở cỡ nhỏ bị mảnh và tối đi |
| Chỉ **hai** vạch tim, khe giữa 5 đơn vị | Bản thử ba vạch: vạch xa nhất chỉ rộng 1 đơn vị nên thành sợi mờ, và ở 16–24px cả ba dính lại thành một sọc liền làm lấp lòng đường |

## Biến thể

`icon_dot.*` là cùng hình đó cộng chấm báo tin chưa đọc ở góc trên phải (dùng
cho icon khay khi có tin chưa xem). Chấm có vòng ngoài cùng màu nền để tách
khỏi thân chữ ở cỡ nhỏ.

Trong file gốc, lớp chấm (`.unread-badge`) **ẩn sẵn**; script dựng bật nó lên
để tạo biến thể. Nhờ vậy chỉ tồn tại một bản hình duy nhất — hai biến thể
không thể lệch nhau. Script có chốt chặn: nếu bản chấm dựng ra giống hệt bản
thường thì báo lỗi thay vì âm thầm xuất ra hai file giống nhau.

## Sửa logo

1. Sửa `resources/icons/icon.svg`.
2. Chạy `node scripts/build-icons.mjs` (cần Chrome; đặt `CHROME_BIN` nếu Chrome
   không ở đường dẫn mặc định).
3. Soi lại ở cỡ 16 và 24px trước khi commit — mọi lỗi tỉ lệ đều lộ ra ở đó.

**Không sửa tay file .png/.ico/.icns**: lần dựng sau sẽ ghi đè.
