---
brand:
  name: AHV Connect
  owner: Trung tâm Đào tạo Lái xe AHV
color:
  brand-900: "#1E40AF"   # điểm bắt đầu dải màu nền (góc trên trái)
  brand-500: "#3B82F6"   # điểm kết thúc dải màu nền (góc dưới phải)
  mark-fg:   "#FFFFFF"   # mặt đường và vạch kẻ
  badge:     "#EF4444"   # chấm báo tin chưa đọc
  badge-ring: "#1E40AF"  # vòng tách chấm khỏi thân chữ
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

# AHV Connect — nhận diện

Tài liệu này chỉ nói về **dấu hiệu nhận diện (logo)**. Giao diện bên trong ứng
dụng được kế thừa nguyên trạng từ dự án nguồn (xem `NOTICE.md`) và chưa được
thiết kế lại; đừng coi file này là hệ thiết kế của toàn bộ giao diện.

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
