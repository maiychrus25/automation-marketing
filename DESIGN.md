---
product:
  name: AHV Connect
  owner: Trung tâm Đào tạo Lái xe AHV
  platform: Electron desktop
  direction: macOS Workbench
  density: comfortable-compact
brand:
  primary: "#2563EB"
  primary-hover: "#1D4ED8"
  primary-pressed: "#1E40AF"
  focus: "#0A84FF"
  mark-fg: "#FFFFFF"
  unread: "#EF4444"
color:
  light:
    canvas: "#F5F5F7"
    sidebar: "rgba(235, 238, 243, 0.88)"
    surface: "#FFFFFF"
    surface-raised: "#FFFFFF"
    surface-muted: "#F0F1F4"
    border: "rgba(15, 23, 42, 0.10)"
    border-strong: "rgba(15, 23, 42, 0.16)"
    text: "#1D1D1F"
    text-secondary: "#5F636B"
    text-tertiary: "#7C818A"
  dark:
    canvas: "#111318"
    sidebar: "rgba(25, 28, 35, 0.90)"
    surface: "#1C1F26"
    surface-raised: "#252A33"
    surface-muted: "#171A20"
    border: "rgba(255, 255, 255, 0.09)"
    border-strong: "rgba(255, 255, 255, 0.15)"
    text: "#F5F5F7"
    text-secondary: "#B4BAC4"
    text-tertiary: "#8A929E"
  status:
    success: "#30A46C"
    warning: "#D99A19"
    danger: "#E5484D"
    info: "#0A84FF"
typography:
  family: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif"
  display-family: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif"
  size:
    caption: 11
    label: 12
    body: 14
    title: 18
    page-title: 28
  weight:
    regular: 400
    medium: 500
    semibold: 600
spacing:
  base: 4
  scale: [4, 8, 12, 16, 24, 32, 40]
radius:
  control: 10
  card: 14
  panel: 18
  pill: 999
elevation:
  card: "0 1px 2px rgba(15, 23, 42, 0.06), 0 8px 24px rgba(15, 23, 42, 0.05)"
  popover: "0 18px 48px rgba(0, 0, 0, 0.22)"
layout:
  titlebar-height: 52
  navigation-rail-width: 72
  expanded-sidebar-width: 256
  content-max-width: 1440
  minimum-window-width: 900
  minimum-window-height: 600
motion:
  fast: 160
  standard: 220
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)"
breakpoints:
  compact: 640
  medium: 900
  wide: 1280
accessibility:
  minimum-target: 44
  normal-text-contrast: "4.5:1"
  large-text-contrast: "3:1"
logo:
  source: resources/icons/icon.svg
  build: node scripts/build-icons.mjs
  geometry:
    canvas: 100
    corner-radius: 22
    mark-apex-y: 17
    mark-base-y: 84
    mark-width: [15, 85]
    road-vanishing-point: [50, 32]
    road-base: [30, 70]
    crossbar-y: [72, 79]
    crossbar-x: [26, 74]
  sizes:
    png: [128, 1024]
    ico: [16, 32, 48, 64, 128, 256]
    icns: [16, 32, 128, 256, 512, 1024]
---

# AHV Connect — hệ thống thiết kế

Tài liệu này là nguồn sự thật cho nhận diện và giao diện AHV Connect. Mọi màn
hình mới phải dùng token, hierarchy và interaction pattern ở đây trước khi tạo
biến thể riêng.

## Định hướng

**macOS Workbench** kết hợp sự điềm tĩnh của ứng dụng macOS với mật độ vừa đủ
cho phần mềm vận hành nhiều tài khoản. Giao diện phải giống một không gian làm
việc đáng tin cậy: chrome nhẹ, nội dung rõ, trạng thái có thứ bậc và hành động
chính luôn dễ tìm.

Đây không phải bản sao Finder hay System Settings. AHV Connect giữ màu xanh và
dấu hiệu con đường của thương hiệu, còn macOS cung cấp ngôn ngữ về vật liệu,
khoảng trắng, typography và phản hồi tương tác.

Ba nguyên tắc ưu tiên:

1. **Nội dung trước chrome:** sidebar và titlebar lùi lại để dữ liệu vận hành nổi lên.
2. **Bình tĩnh nhưng không mờ nhạt:** dùng tương phản, spacing và weight trước màu sắc.
3. **Một hierarchy cho hai theme:** light và dark khác giá trị token, không khác cấu trúc.

## Màu sắc và vật liệu

`canvas` là nền sâu nhất. `sidebar` là vật liệu mờ duy nhất được dùng thường
xuyên. `surface` chứa nội dung; `surface-raised` dành cho popover, menu và card
đang được chú ý. Không xếp nhiều lớp blur lên nhau.

Màu xanh thương hiệu chỉ dùng cho selection, CTA chính, focus và thông tin có
tính hành động. Success, warning và danger giữ ý nghĩa cố định; không dùng chúng
làm màu trang trí.

Trong light mode, chữ body không nhạt hơn `text-secondary`. Trong dark mode,
surface phải đủ tách khỏi canvas bằng border hoặc chênh độ sáng, không dựa chỉ
vào shadow.

## Typography

Ứng dụng dùng system stack để nhận SF Pro trên macOS và Segoe UI trên Windows.
Tên trang dùng display family, phần còn lại dùng text family.

| Vai trò | Cỡ | Weight | Dùng cho |
|---|---:|---:|---|
| Page title | 28px | 600 | Tên workspace hoặc màn hình chính |
| Title | 18px | 600 | Tên section, dialog |
| Body | 14px | 400 | Nội dung và dữ liệu chính |
| Label | 12px | 500 | Control, metadata |
| Caption | 11px | 400 | Timestamp và mô tả phụ |

Không dùng toàn chữ hoa cho heading dài. Chữ hoa chỉ dành cho label nhóm ngắn,
kèm letter spacing nhỏ.

## Không gian và hình học

Mọi khoảng cách bám lưới 4px. Các nhóm gần nhau cách 8–12px; section cách
24–32px. Card mặc định bo 14px, panel lớn bo 18px, control bo 10px. Pill chỉ
dùng cho badge, filter và trạng thái, không dùng cho mọi button.

Shadow phải nhẹ ở card và rõ hơn ở popover. Hover không phóng to phần tử hoặc
làm layout dịch chuyển; chỉ đổi màu, border, shadow hoặc dịch tối đa 1px bằng
transform.

## Khung ứng dụng

### Unified titlebar

Titlebar cao 52px và là drag region của Electron. Trên macOS, 72px bên trái
được dành cho traffic lights. Thành phần tương tác phải đặt `no-drag`.

- Trái: tên sản phẩm và workspace switcher.
- Giữa hoặc vùng linh hoạt: trạng thái kết nối quan trọng.
- Phải: tìm kiếm/toàn cục, theme, tài khoản hiện tại và window controls trên
  nền tảng cần custom controls.

Thông báo cập nhật hoặc mất kết nối xuất hiện như status capsule, không làm đổi
chiều cao titlebar.

### Navigation rail

Rail rộng 72px, dùng icon SVG nhất quán. Mỗi target tối thiểu 44px. Mục active
dùng capsule nền xanh nhạt và indicator, không chỉ đổi màu icon. Tooltip xuất
hiện khi hover/focus; unread badge không che icon.

Trong Chat, danh sách tài khoản mở rộng thành panel 256px nhưng rail vẫn giữ
vai trò điều hướng. Không thay đổi thứ tự hoặc quyền hiển thị module hiện có.

### Content canvas

Content có padding 24px ở desktop, 16px ở compact. Nội dung rộng không quá
1440px và căn giữa khi cửa sổ rất rộng. Trang tự cuộn bên trong vùng content;
body không cuộn và không có horizontal overflow.

## Thành phần dùng chung

### Button

- Primary: một hành động chính trong mỗi cụm, nền xanh thương hiệu.
- Secondary: surface-muted và border.
- Quiet: không nền, chỉ hiện nền khi hover/focus.
- Danger: chỉ dùng cho hành động phá huỷ sau khi đã xác nhận.

Button có chiều cao 36px ở desktop; icon-only và target cảm ứng vẫn có vùng
click tối thiểu 44px. Mọi button phải có focus ring nhìn thấy được.

### Card và list row

Card dùng surface + border; shadow chỉ dùng khi card là đơn vị độc lập. List row
dùng selection nền nhẹ và không dùng shadow. Card tương tác phải có hover,
focus và cursor rõ ràng nhưng không scale.

### Field và search

Field cao 36px, nền surface-muted, border trong cả hai theme. Search dùng icon
SVG bên trái, clear button bên phải và label/aria-label đầy đủ. Placeholder không
thay thế label cho form nghiệp vụ.

### Badge và trạng thái

Trạng thái gồm dot/icon và text khi có đủ chỗ. Không dùng màu làm tín hiệu duy
nhất. Badge số giới hạn hiển thị ở `99+`; badge status dùng sentence case.

### Menu, popover và dialog

Popover dùng `surface-raised`, border-strong, radius 14px và elevation popover.
Dialog có width theo nội dung, tối đa 90vw; action chính đặt bên phải. Escape,
click backdrop và focus return phải nhất quán với component hiện có.

### Loading, empty và error

- Loading giữ kích thước vùng nội dung để tránh layout shift.
- Empty state nói rõ lý do và có tối đa một CTA chính.
- Error đặt gần hành động gây lỗi, giữ nội dung người dùng đã nhập.

## Dashboard

Dashboard là trang tổng quan vận hành, không chỉ là danh sách tài khoản.

### Cấu trúc

1. Header: tên workspace, mô tả chế độ và CTA **Thêm tài khoản**.
2. Summary: tổng tài khoản, đang online, cần xử lý và loại workspace; tất cả
   được suy ra từ state hiện có, không thêm API.
3. Toolbar: search, gộp tài khoản, thêm workspace và các trạng thái giả lập.
4. Account grid: card co giãn, tối thiểu 280px, giữ drag/reorder và toàn bộ menu.

### Account card

Tên và trạng thái kết nối là hierarchy đầu tiên; channel và ID/phone là metadata.
Menu ba chấm giữ vị trí góc trên phải. Khi listener lỗi, card dùng border danger
nhẹ cùng icon/text cảnh báo; không phủ toàn card bằng màu đỏ. CTA vào chat và
kết nối lại phải rõ nhưng không cạnh tranh với nhau.

### Trạng thái đặc biệt

Empty state phân biệt local, remote và simulation như hiện tại. Loading dùng
skeleton hoặc spinner có label. Search không có kết quả phải giữ toolbar và đưa
ra thông báo ngắn, không thay bằng empty state của toàn workspace.

## Responsive

macOS desktop là ưu tiên đầu tiên, nhưng layout phải bền ở viewport hẹp dùng
cho kiểm thử và cửa sổ thu nhỏ.

- `>=1280px`: summary 4 cột, account grid 3–4 cột.
- `900–1279px`: summary 2–4 cột, account grid 2–3 cột.
- `<900px`: toolbar wrap, account grid 1–2 cột; không mất hành động.
- `<640px`: content padding 16px, summary 2 cột, account grid 1 cột, CTA có
  label ngắn; tuyệt đối không cuộn ngang ở cấp trang.

## Motion

Transition mặc định 160–220ms với easing đã khai báo. Chỉ animate `opacity` và
`transform` cho reveal; hover ưu tiên color/border/shadow. Không dùng animation
lặp vô hạn ngoài spinner hoặc cảnh báo kết nối quan trọng.

Khi `prefers-reduced-motion: reduce`, tắt animation trang trí, smooth scroll và
transform không thiết yếu.

## Accessibility

- Tương phản body đạt tối thiểu 4.5:1.
- Mọi icon-only button có `aria-label` hoặc tên truy cập tương đương.
- Focus ring dùng màu `focus`, offset đủ tách khỏi surface.
- Target tối thiểu 44×44px cho navigation và hành động chính.
- Trạng thái luôn có text/icon bên cạnh màu khi không gian cho phép.
- Thứ tự tab đi theo thứ tự thị giác; drag-and-drop không được là cách duy nhất
  để sắp xếp nếu tính năng này được mở rộng sau demo.

## Nhận diện

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

## Điều không làm

- Không dùng glass cho mọi card hoặc xếp nhiều lớp blur.
- Không dùng gradient tím/xanh chung chung hay màu trang trí không có nghĩa.
- Không dùng emoji làm icon giao diện; dùng bộ SVG hiện có.
- Không scale card/button khi hover gây layout shift.
- Không tạo page-level horizontal overflow hoặc phụ thuộc duy nhất vào viewport height.
- Không đổi business logic, navigation, RBAC hay dữ liệu để phục vụ việc restyle.
