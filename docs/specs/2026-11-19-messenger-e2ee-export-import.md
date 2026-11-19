# Nhập lịch sử Messenger mã hoá từ tệp xuất của Facebook

**Ngày:** 19/11/2026
**Trạng thái:** Anh duyệt thiết kế 19/11/2026 (gồm cả nhóm). Đã triển khai và phát hành trong 26.50.0 (19/11/2026). Phần ghép hội thoại đã đo chỉ-đọc trên một tệp xuất thật có hai chat 1-1; nhóm và đường ghi dữ liệu chưa thử với dữ liệu thật.
**Tài liệu liên quan:** `docs/specs/2026-11-14-facebook-history-sync.md` (lịch sử Facebook thường; mục "Ghi chú sau phát hành (26.49.0)" về phép thử tải tin trước khi mã hoá).

## 1. Vấn đề

Tin của hội thoại Messenger mã hoá đầu cuối không nằm trên máy chủ Facebook ở dạng đọc được. MaiHub chỉ có các tin nhận từ lúc kết nối; tin cũ hơn nằm trong kho lưu trữ an toàn của Messenger.

Ba đường đã xét (19/11/2026):

- Mở kho bằng mã PIN ngay trong cầu nối: bản gốc `mautrix-meta` làm được từ 26.10 nhưng ghi nhận Facebook thu hồi phiên sau lệnh tra kho, và tắt mặc định. Chưa làm.
- Hỏi lại phần tin từ trước khi hội thoại bị chuyển sang mã hoá bằng yêu cầu lịch sử thường (26.49.0, nút thử): lần thử thật đầu tiên trả về trang rỗng.
- Nhập tệp xuất chính thức của Facebook: tài liệu này.

## 2. Tệp xuất

Người dùng tải trên máy tính tại trang "tải bản sao lưu đoạn chat" của Facebook (nhập mã PIN). Kết quả là một tệp ZIP:

- Mỗi hội thoại một tệp JSON ở gốc, tên `<tên hội thoại>_<số>.json`; hội thoại trùng tên được phân biệt bằng số.
- Một thư mục chứa ảnh và tệp đính kèm.
- Mỗi tệp JSON: `participants` (danh sách tên), `threadName`, `messages`. Mỗi tin: `senderName`, `text`, `timestamp` (mili giây), `type` (`text` hoặc `media`), `isUnsent`, `media` (danh sách `{ uri }`), `reactions` (danh sách `{ actor, reaction }`).
- Tệp không có mã hội thoại, mã người dùng hay mã tin.

Đo trên một tệp thật (chỉ so số liệu, 19/11/2026): cả 7 tin có ở cả hai nơi lệch thời điểm dưới 1 giây. Tin gửi đi từ MaiHub qua cầu nối mã hoá **không có trong tệp**; tệp chỉ chứa tin nhận về và tin gửi từ thiết bị khác của chính tài khoản. (Bản nháp đầu của tài liệu này ghi "tin gửi từ MaiHub lệch tới khoảng 27 giây" — sai, do khi đó chỉ so độ dài và thời điểm.)

## 3. Hành vi

1. Trong hộp thoại đồng bộ lịch sử Facebook của một tài khoản cá nhân, trên máy Boss, có nút "Nhập từ tệp Facebook (.zip)". Hộp chọn tệp do tiến trình chính mở; giao diện không truyền đường dẫn.
2. MaiHub đọc tệp ngay trên máy. Không có yêu cầu nào tới Facebook.
3. **Ghép hội thoại.** Mỗi hội thoại trong tệp được so với các hội thoại Facebook của tài khoản có tin trong cùng khoảng thời gian. Hai tin được coi là một khi nội dung (đã chuẩn hoá) giống nhau, không rỗng, và thời điểm lệch không quá 5 giây. Hội thoại trên máy có nhiều cặp khớp nhất được chọn khi có ít nhất 2 cặp và hội thoại đứng thứ hai có không quá một nửa số cặp đó; nếu chỉ có 1 cặp thì chỉ chọn khi nội dung dài từ 6 ký tự và không hội thoại nào khác có cặp khớp. Thêm điều kiện phủ: trong khoảng thời gian của hội thoại trong tệp, ít nhất một nửa số tin chữ nhận về (chưa thu hồi) của hội thoại trên máy phải có cặp khớp — để một vài tin giống nhau gửi cho nhiều người không kéo cả lịch sử vào nhầm hội thoại. Phải có ít nhất một tin chữ nhận về trùng nhau; chỉ trùng các tin do chính tài khoản gửi thì không ghép. Hai hội thoại trong tệp không được ghép vào cùng một hội thoại trên máy. Không ghép theo tên. Hội thoại không ghép được bị bỏ qua và được đếm.
4. **Ai là "tôi".** Mỗi cặp khớp là một phiếu: khớp với tin do tài khoản gửi thì tên đó là "tôi", khớp với tin nhận về thì tên đó không phải "tôi"; tên được chọn phải có nhiều phiếu thuận hơn phiếu nghịch và nằm trong danh sách người tham gia. Nếu không chọn được theo phiếu: với hội thoại 2 người, "tôi" là người còn lại so với các tin nhận về đã khớp; với nhóm, so với tên hiển thị của tài khoản; không xác định được thì mọi tin được coi là của người khác.
5. **Người gửi trong nhóm.** Tên trong tệp được gắn mã số khi khớp đúng một người gửi đã biết của nhóm đó trên máy. Không khớp hoặc khớp nhiều người thì tin vẫn được nhập, người gửi mang một mã riêng của MaiHub chứa tên trong tệp (không phải mã Facebook): khung chat hiện tên đó, ảnh đại diện mặc định, không tra cứu gì trên Facebook; số tin như vậy được đếm.
6. **Chống trùng.** Tin trong tệp đã có trên máy (cùng nội dung, cùng chiều khi biết, lệch không quá 5 giây; tin không có chữ thì so loại tin và chiều) không được nhập. Tin nhập mới mang mã ổn định tính từ tài khoản, hội thoại, thời điểm, tên người gửi và nội dung, nên nhập lại cùng tệp không sinh tin trùng.
7. **Ghi dữ liệu.** Tin mới được lưu như tin lịch sử: không tăng chưa đọc, không thông báo, không workflow, không đổi tin cuối của hội thoại. Nhập: chữ, thời điểm, cờ thu hồi, cảm xúc (chỉ của người gắn được mã số), ảnh và tệp đính kèm có trong ZIP.
8. Kết thúc, hộp thoại hiện số tin đã nhập, số hội thoại, và các số đếm bị bỏ qua.

## 4. An toàn

- Chỉ máy Boss, chỉ tài khoản Facebook cá nhân; lệnh thuộc nhóm chỉ boss, không nằm trong danh sách đóng của máy chủ chuyển tiếp.
- Tên mục trong ZIP được kiểm (không đường dẫn tuyệt đối, không `..`); có trần kích thước cho từng mục, tổng dung lượng JSON, tổng dung lượng media và số mục; chỉ đọc JSON và tệp media được tin tham chiếu. Tệp media lưu ra đĩa mang tên do MaiHub sinh và chỉ giữ đuôi thuộc danh sách ảnh, video, âm thanh đã biết; đuôi khác đổi thành `.bin`.
- Nhật ký chỉ ghi số đếm; không ghi tên, nội dung, đường dẫn tệp.
- Mỗi tài khoản một lượt nhập tại một thời điểm.

## 5. Giới hạn

- Tệp xuất là ảnh chụp tại lúc tải; muốn có tin mới hơn thì tải lại và nhập lại.
- Hội thoại chưa có tin nào trên máy không ghép được.
- Phần nhóm chưa được thử với tệp xuất thật có nhóm.
- Tin nhập từ tệp không mang mã tin của Facebook, nên các thao tác cần mã tin (thả cảm xúc, trả lời, thu hồi) không áp dụng cho các tin này: MaiHub từ chối ngay trên máy, không gửi gì tới Facebook.
- Tin gửi từ MaiHub không có trong tệp sao lưu của Facebook, nên chúng chỉ tồn tại trên máy; nhập tệp không tạo bản trùng của các tin này.
- Thêm thư viện `yauzl` (MIT, đã có gián tiếp qua `extract-zip`) làm phụ thuộc trực tiếp để đọc ZIP.

## 6. Kiểm chứng

- Tự động, không gọi Facebook: phân tích định dạng, ghép hội thoại (kể cả hai hội thoại trùng tên, hoà điểm, một cặp khớp), xác định "tôi", người gửi trong nhóm, chống trùng và nhập lại, ZIP độc hại hoặc hỏng, trần kích thước, lệnh chuyển tiếp bị từ chối.
- Sau khi cài: nhập tệp thật đã dùng để đo; kỳ vọng thêm 74 tin vào 2 hội thoại (số từ lần chạy thử chỉ đọc bằng chính mã ghép của bản này), 7 tin đã có sẵn, không tin trùng.
