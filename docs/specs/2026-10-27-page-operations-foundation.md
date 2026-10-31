# Thiết kế: Nền tảng vận hành kinh doanh cho từng Page

| Thuộc tính | Giá trị |
|---|---|
| Ngày | 27/10/2026 |
| Trạng thái | Spec/kế hoạch đã duyệt 27/10/2026; Tasks 1–9 và sửa F1–F4 được controller chấp nhận local ngày 28/10/2026 sau review độc lập/hai vòng kiểm chứng; Make/lint còn thiếu, chưa phát hành; live pilot INTEGRATION BLOCKED |
| Phạm vi bản này | Hồ sơ kinh doanh có nguồn, quyền của runner tự động, trạng thái công việc và bàn giao cho khách duyệt |
| Nền code khảo sát | `823db94`, phiên bản local 26.32.0 chưa phát hành |
| Tiền đề | `docs/intent/2026-10-26-facebook-growth-bot.md`, `docs/specs/2026-10-26-daily-post-suggestions.md` |
| Kế hoạch triển khai | `docs/plans/2026-10-27-page-operations-foundation.md` — đã duyệt ngày 27/10/2026 |

## 1. Ý định và quyết định đã chốt

Khách dùng MaiHub không rành kỹ thuật, làm việc với bot qua Telegram. Bot trên VPS là nơi suy luận; MaiHub giữ dữ liệu, thực thi thao tác và cưỡng chế giới hạn. Đích là tìm được nhu cầu và khách phù hợp cho từng Page, không phải tối đa số bài hoặc lượt thích.

Ngày 27/10/2026 anh xác nhận **không có nguồn dữ liệu đơn hàng, doanh thu hoặc lợi nhuận**. Không yêu cầu khách nhập bổ sung những số liệu này. Bot không được báo số đơn, tỷ lệ chốt, doanh thu, ROI hay lợi nhuận như kết quả đo được; không suy ra bán hàng từ trạng thái lead hoặc tương tác.

Vòng quan sát có thể khép kín: **hiểu Page → tìm cơ hội → lập chiến dịch → làm nội dung/video → duyệt và thực hiện → quan sát phản hồi → điều chỉnh**. Khâu mua hàng thực tế nằm ngoài phạm vi quan sát. “Phân tích khả năng kinh doanh” là nhận định có bằng chứng và giả thuyết cần thử, không phải cam kết doanh thu.

Giữ quy mô pilot 1–3 Page trên các profile đã có; không tự tăng giới hạn 10 daily brief/workspace. Không tự khám phá hoặc chuyển qua mọi Page mà một tài khoản quản lý. Không gọi Facebook, Telegram, nhà cung cấp video hay AI thật khi phát triển/kiểm thử nếu chưa được phép.

## 2. Hiện trạng: không nhầm kế hoạch với tính năng đã có

| Năng lực | Bằng chứng trong code hiện tại | Giới hạn |
|---|---|---|
| Học Page đang hoạt động trong profile | `src/services/dailyBrief/PageLearner.ts`, `src/models/dailyBrief.ts` | Không phải danh mục toàn bộ Page; không tự đổi danh tính |
| Đề xuất hằng ngày, nháp, duyệt/lịch đăng | `src/services/dailyBrief/briefOperations.ts`, `src/services/control/ControlMethods.ts` | Lời nhắc cấm runner duyệt chưa phải ranh giới quyền máy chủ |
| Bình luận đầu tiên dưới bài vừa đăng | `src/services/facebookPoster/firstComment.ts`, `src/services/facebookPoster/postToTargets.ts` | Không phải công cụ bình luận độc lập trên bài bên ngoài |
| Thu bình luận, tìm lead | `src/services/facebookPoster/CommentCollector.ts`, `src/models/facebookPoster.ts` | Tín hiệu nhu cầu, không phải xác nhận đã mua |
| Video HyperFrames và AHV | `src/services/video/VideoService.ts`, `docs/specs/2026-10-27-ad-video.md` | Chưa có vòng bền vững nối mọi lượt brief với video lâu và nháp tiếp theo |
| Chiến dịch, CRM | `src/models/facebookPoster.ts`, `src/models/crm.ts` | Tái dùng mã chiến dịch/lead; không coi CRM gửi tin là hệ thống đơn hàng |
| Thống kê bài | `src/services/facebookPoster/FacebookPosterService.ts` | Nhánh theo dõi hiện tại dành cho bài nhóm; không mặc nhiên coi là Page Insights |
| Tự tìm bài bên ngoài rồi bình luận, theo dõi và trả lời tiếp | Chưa có luồng công cụ hoàn chỉnh cho bot | Là hạng mục cần triển khai riêng, không đánh dấu đã xong |

Một số mô tả trong intent 26/10 là đề xuất lịch sử, không phải inventory. Đặc biệt, nhận định rằng `posts.stats` đã đo đầy đủ bài Page không được dùng làm tiền đề cho spec này. Không viết lại thân intent cũ; bản này ghi quyết định hiện tại.

## 3. Chia dự án và chọn cách làm

Chọn mở rộng kiến trúc hiện có. Chỉ thêm prompt không giải quyết được quyền, mất trạng thái và lẫn Page; viết lại một nền tảng agent/CRM mới thì nhân đôi dữ liệu và làm tăng rủi ro hồi quy.

| Đợt | Kết quả | Quan hệ với bản này |
|---|---|---|
| A. Nền tảng Page | Biết đang làm cho Page nào, dựa vào dữ liệu nào, được làm gì, việc đang ở bước nào | **Phạm vi triển khai của spec này** |
| B. Cơ hội và tương tác thật | Chọn cuộc trao đổi phù hợp, bình luận/trả lời bằng danh tính rõ ràng, ghi nhận phản hồi và lead | Spec riêng; có executor, chính sách và kiểm thử riêng trước khi bật |
| C. Chiến dịch và học từ kết quả | Liên kết nội dung/video/cơ hội với chiến dịch; đo tín hiệu thực có và điều chỉnh | Spec riêng; không giả định đã có Page Insights hay dữ liệu đơn hàng |

Không đưa tương tác giả, giả danh khách hàng, bình luận hàng loạt không liên quan hoặc hành vi làm tài khoản “giống người thật” vào thiết kế hiện tại. Tương tác tự động sau này phải phục vụ trao đổi có ngữ cảnh, trong phạm vi và quyền đã được chấp thuận.

## 4. Phạm vi đợt A

### Có làm

1. Hồ sơ kinh doanh tách biệt theo Page, thông tin có nguồn và mức xác nhận.
2. Danh tính runner có quyền hẹp, máy chủ từ chối việc vượt quyền kể cả khi nhận `confirm: true`.
3. Lưu quyết định và tiến độ cho luồng hiện có: đề xuất → chuẩn bị nội dung/tệp → tạo nháp → chờ khách duyệt.
4. Tiếp tục từ video/job đã có thay vì tạo lại khi lượt agent kết thúc; đối soát trạng thái khi bỏ lỡ sự kiện.
5. Tích hợp vào runner, bridge và Telegram hiện có; thông báo dễ hiểu, không yêu cầu khách cấu hình JSON.
6. Kiểm thử quyền, cách ly Page/workspace, khôi phục sau lỗi và hồi quy các luồng cũ.

### Không làm

- Chưa triển khai tự đăng bình luận trên bài bên ngoài, tự trả lời bình luận/inbox, cảm xúc, chia sẻ hay lời mời theo dõi.
- Không chạy quảng cáo, tự chi tiền, tự giảm giá hoặc hứa điều khoản chưa được xác nhận.
- Không thêm nguồn nghiên cứu ngoài Facebook, dashboard, framework agent, vector database, hệ CRM hoặc scheduler thứ hai.
- Không thay bằng chứng thiếu bằng số 0; không xây báo cáo doanh thu giả.
- Không đổi version, chạy migration trên dữ liệu khách, cài timer thật, push hoặc deploy trong bước viết spec.

## 5. Kiến trúc và ranh giới trách nhiệm

- **Bot VPS:** phân tích dữ liệu được cấp, đề xuất giả thuyết/chiến dịch, viết nội dung và giải thích quyết định. Không là nguồn xác nhận quyền hay sự thật kinh doanh.
- **MaiHub:** lưu hồ sơ, danh tính, trạng thái và audit; kiểm quyền/giới hạn trước side effect; dùng lại services đăng bài, research, video, nháp và lịch.
- **Luồng Telegram tin cậy:** nhận quyết định thật của khách, phân giải nháp và chuyển lệnh duyệt. Không cấp khoá duyệt cho runner tự động.
- **Bridge:** vận chuyển công cụ và thông báo; ẩn tool không đủ quyền để giảm nhầm lẫn, nhưng quyết định cho phép vẫn ở MaiHub.

Không tạo engine workflow tổng quát. Chỉ lưu các bước thực sự có trong luồng chuẩn bị nháp hiện tại. Giữ SQLite của workspace; lớp bảo vệ nằm ở biên API/service, không chỉ trong prompt hay giao diện.

## 6. Hồ sơ kinh doanh và danh tính

### 6.1 Khoá và cách ly

Hồ sơ mới dùng `pageId` đã học trong workspace, không dùng tên Page làm khoá. `profileId` là phương tiện truy cập, không phải danh tính kinh doanh. Có thể nhiều profile truy cập cùng Page; dữ liệu Page dùng chung nhưng quyền sử dụng profile vẫn kiểm riêng.

Không tự gán hồ sơ khi `kind` khác `page`, thiếu `pageId` hoặc danh tính đọc được không khớp. Đổi Page đang hoạt động trong một profile phải dừng công việc cũ, không chuyển trí nhớ sang Page mới. Giữ nguyên API/khóa `profileId` của daily brief cũ để tương thích; không âm thầm tái diễn giải hoặc đổi khoá dữ liệu đã tồn tại.

Mọi công việc giữ snapshot `workspaceId`, `pageId`, `profileId`. Trước khi thao tác trình duyệt hoặc tạo nháp phải kiểm lại context và danh tính đủ dùng; không biết thì chặn, không tự chuyển Page để vượt chặn.

Chế độ mới chỉ dùng một daily brief chính cho mỗi Page, trỏ bằng `primaryProfileId`. Nếu nhiều brief đang trỏ cùng Page mà chưa có lựa chọn chính đã xác nhận, báo khách chọn qua Telegram; không chạy cả hai, không tự xoá/tắt brief cũ. Profile phụ vẫn có thể cung cấp dữ liệu được phép, nhưng không tự trở thành runner thay thế.

### 6.2 Dữ liệu tối thiểu

Hồ sơ có `pageId`, `primaryProfileId`, `revision`, `updatedAt`, cùng danh sách thông tin phục vụ: sản phẩm/dịch vụ, đối tượng, khu vực phục vụ, giá, khả năng đáp ứng, điểm khác biệt, phong cách và điều không được hứa.

Mỗi thông tin gồm `id`, `topic`, `value`, `status`, `sourceType`, `sourceRef`, `reason`, `observedAt`, `updatedAt`. Khi xác nhận, máy chủ thêm `confirmedAt` và `confirmationRef` từ luồng tin cậy, giữ nguyên nguồn quan sát ban đầu; runner không được tự ghi hai trường này. `status` là `observed`, `hypothesis` hoặc `confirmed`; `sourceType` là `page`, `research` hoặc `owner`. `sourceRef` là mã bản ghi/URL hoặc tham chiếu thông điệp đã xác thực, không chứa token, cookie hoặc HTML thô.

- `observed`: đã đọc thấy ở nguồn, chưa đồng nghĩa còn đúng hoặc được chủ Page xác nhận.
- `hypothesis`: suy luận của bot; phải có lý do và dữ liệu hỗ trợ, không tự nâng thành sự thật.
- `confirmed`: chỉ luồng xác nhận tin cậy của chủ Page được ghi. Runner không tự chọn trạng thái này hoặc giả `sourceType: owner`.
- Khi nguồn thay đổi/mâu thuẫn: lưu đề xuất mới và báo cần xác nhận; không ghi đè thông tin đã xác nhận bằng suy đoán.
- Dùng `expectedRevision` khi cập nhật; xung đột phải đọc lại, không ghi đè mù.
- Nguồn do runner tham chiếu phải thuộc dữ liệu được phép của Page/công việc; URL hoặc lời khai trong params không tự trở thành bằng chứng đã đọc. API không tự tải URL tuỳ ý để hợp thức hoá nguồn.

Giới hạn đợt A: tối đa 10 hồ sơ/workspace, 100 thông tin/hồ sơ, `value` tối đa 2.000 ký tự, `reason` tối đa 1.000 ký tự, `sourceRef` tối đa 500 ký tự. Khi đầy trả lỗi giới hạn; không tự xoá thông tin của khách. Các giá trị này là đề xuất trong spec, chưa phải hằng số đã phát hành.

Không nhân bản danh sách khách hoặc hội thoại vào hồ sơ kinh doanh. Lưu liên kết tới dữ liệu lead/research hiện có, giữ chính sách lưu/xoá của nguồn; liên kết hết dữ liệu phải được hiển thị là không còn bằng chứng.

## 7. Quyền và xác nhận

### 7.1 Quyền của runner mới

Dùng khoá Control API bị giới hạn ở workspace và tập Page/profile được giao. MaiHub lấy quyền từ khoá đã xác thực, không từ `keyName`, tham số do bot gửi hoặc nội dung prompt. Khoá lưu dạng hash theo `ControlStore` hiện có.

| Nhóm thao tác | Runner tự động đợt A |
|---|---|
| Đọc dữ liệu cần cho Page được giao | Cho phép, lọc kết quả theo phạm vi |
| Research/page learning | Chỉ nguồn/profile được giao, qua khoá browser-job chung |
| Đề xuất thông tin kinh doanh | Cho phép `observed`/`hypothesis`; không xác nhận thay khách |
| Tạo/sửa nháp | Chỉ nháp thuộc công việc và Page được giao; giữ validation hiện có |
| Theo dõi video/job và dùng kết quả có sẵn | Cho phép trong công việc được giao |
| Khởi tạo render có thể phát sinh phí | Không cho runner tự khởi tạo trong đợt A; luồng yêu cầu video hiện tại của khách vẫn giữ |
| Duyệt nháp, đăng ngay, tạo/sửa/bật lịch đăng | Từ chối cả lệnh trực tiếp và đường vòng |
| Bình luận độc lập, gửi tin/chiến dịch CRM, đổi cấu hình, cấp khoá | Từ chối |

Từ chối mặc định mọi method mới chưa được xét. `describe`, events, lịch sử, thống kê tổng hợp và đường tải tệp cũng phải giữ phạm vi; method chưa thể lọc an toàn bị từ chối cho runner, không trả dữ liệu toàn workspace rồi nhờ AI tự bỏ qua. Kiểm quyền trước đọc cache idempotency, tải media/video và thực thi; khoá đã thu hồi không được lấy lại kết quả cũ. Lệnh ghi phải kiểm mọi ID lồng trong params, không chỉ Page ở cấp ngoài. Nháp đổi nội dung, tệp hoặc đích đăng sau xác nhận làm mất hiệu lực xác nhận cũ.

### 7.2 Không dùng prompt làm bằng chứng khách đã duyệt

Runner không có khoá chủ sở hữu. Luồng duyệt phải kiểm danh tính Telegram/chat được phép, nháp cụ thể, phiên bản nội dung, đích và thời điểm đăng. Kết quả phân tích ngôn ngữ của AI chỉ là đề xuất intent, không phải chứng cứ xác nhận. Tin nhắn mơ hồ hoặc chỉ “ok” mà không có đề nghị đang chờ được gắn rõ phải hỏi lại.

Bộ nhận sự kiện Telegram tin cậy phải nằm ngoài quyền đọc/ghi của runner; bí mật/khoá duyệt không nằm trong env, tệp, MCP config hay thư mục runner truy cập được. Chỉ `--allowedTools` không tạo ra cách ly này. Dùng danh tính hệ điều hành/quyền tệp phù hợp khi triển khai; không hạ sandbox hoặc cho runner sudo để chạy được.

Receiver của bot VPS cần tích hợp với luồng xác nhận này. Code trong repo chưa chứng minh toàn bộ đường nhận lệnh Telegram đó; **đây là điều kiện nghiệm thu tích hợp, không phải chức năng đã có**. Nếu môi trường chưa tách được bí mật và receiver, chỉ chạy chế độ đề xuất/đọc, không công bố đã có bảo vệ duyệt đầu-cuối.

### 7.3 Tương thích và dừng

Khoá/clients hiện tại không bị thu hồi hoặc đổi quyền âm thầm. Runner chế độ mới bắt buộc dùng khoá hẹp; từ chối khởi động chế độ được bảo vệ khi nhận khoá legacy toàn quyền. Không chạy đồng thời runner legacy và runner mới cho cùng daily brief khi chuyển giao.

Dừng chế độ mới ngăn claim/tác vụ mới và huỷ các thao tác do nó sở hữu ở điểm huỷ an toàn; không huỷ lịch đăng độc lập đã được khách duyệt. Đăng xuất, checkpoint, sai danh tính, đổi workspace hoặc thu hồi quyền phải dừng và báo lý do. Không tự tìm cách vượt checkpoint.

## 8. Trạng thái công việc bền vững

Mỗi công việc có `id`, `workspaceId`, `pageId`, `profileId`, `briefDate`, `campaignId` nếu có, `status`, `step`, `claimedAt`, `attempts`, `nextCheckAt`, các ID kết quả (`researchId`, `videoId`, `draftIds`), `reason`, `evidenceRefs`, `lastError`, `updatedAt`.

`status` gồm `pending`, `running`, `waiting`, `needs_review`, `completed`, `failed`, `cancelled`. Trong đợt A, `waiting` chỉ chờ video, với `waitFor: video`. Khi nháp đã lưu và liên kết bền vững, công việc chuyển `completed`; khách duyệt theo lifecycle nháp hiện có, không giữ công việc mở để chờ. `completed` **không** nghĩa là có đơn hàng hoặc đã đăng Facebook.

- Dùng lại timer và claim theo từng Page, tối đa ba lượt agent/ngày/brief, không phải ba lần cho từng bước. Các lần chỉ đối soát trạng thái chờ không gọi agent và không tiêu lượt thử. Thêm trạng thái dài hạn bên cạnh, không kéo dài lease agent đến bằng thời gian render.
- Lưu quyết định, liên kết và ý định của bước trước side effect. Mỗi bước có idempotency key ổn định theo công việc/bước, không sinh key mới mỗi lần retry.
- Chỉ bên có đúng `claimedAt` được chuyển bước; completion trễ không được hoàn tất lượt mới. Cập nhật trạng thái và liên kết kết quả trong transaction khi cùng database.
- Đang chờ video: kết thúc lượt agent, lưu `videoId`, không giữ browser-job slot và không tính lượt chờ là lỗi. Timer kế tiếp kiểm trạng thái job cũ; không tạo lại video.
- Mất sự kiện: đọc trạng thái job bằng ID; event chỉ để đánh thức nhanh, không là nguồn sự thật duy nhất. Không giả định event còn tồn tại mãi.
- Video xong nhưng `mediaId` hết hạn: lấy lại tệp từ thư viện video theo luồng hiện có, tạo tham chiếu media mới và tiếp tục; không render lại.
- Nếu không biết side effect đã được chấp nhận hay chưa: đối soát bằng ID/idempotency record. Không đối soát được thì `needs_review`, báo khách; không retry mù hoặc hứa “exactly once” với dịch vụ bên ngoài.
- Nháp tạo thành công nhưng agent mất kết nối: khôi phục đúng nháp đã liên kết, không tạo bản thứ hai. Quá TTL idempotency vẫn cần liên kết công việc/kết quả để chống trùng.
- Chuyển workspace/danh tính: vô hiệu lease cũ và chặn mọi completion ghi vào context mới. Dữ liệu cũ giữ ở workspace cũ để xem lại.

Chỉ một công việc ở `pending`, `running`, `waiting` hoặc `needs_review` cho mỗi Page/brief chính. Công việc chờ video tiếp tục qua ngày; không tạo công việc mới chồng lên để né giới hạn. `needs_review` chặn việc kế tiếp cho đến khi chủ Page xử lý hoặc huỷ. Nháp chờ duyệt thuộc công việc đã `completed`, không giữ lease/browser slot; brief tiếp theo vẫn tuân thủ số nháp/ngày hiện có. Hàng đợi ưu tiên lịch đăng đã đến giờ; không mở thêm browser vượt giới hạn hiện có.

Bản ghi công việc kết thúc giữ 30 ngày theo thời điểm cập nhật cuối, dùng lại thời hạn audit hiện có. Không dọn công việc đang chạy/chờ/cần xem lại. Dọn nhật ký không xoá nháp, video, hồ sơ hoặc lead nguồn; lịch sử cũ không còn phải được báo là không có dữ liệu, không dựng lại bằng suy đoán.

AHV hiện không có endpoint huỷ remote job: dừng theo dõi hoặc dừng công việc cục bộ không được báo là đã huỷ render hoặc ngừng tính phí phía nhà cung cấp.

## 9. Luồng khách qua Telegram

1. Bot học Page, đọc brief và hồ sơ; thiếu thông tin quan trọng thì chỉ hỏi điều thực sự chặn hành động, không bắt khách điền bảng dài.
2. Bot ghi lý do chọn nội dung và bằng chứng, chuẩn bị nháp. Giá/chính sách/lời hứa chưa xác nhận phải bỏ khỏi lời khẳng định hoặc chuyển khách xem lại.
3. Nếu có video được khách yêu cầu qua luồng hiện tại, gắn job vào công việc và tiếp tục khi xong. Cảnh báo video bị cắt/đọc sai phải đi cùng nháp để khách xem.
4. Khách nhận nháp kèm Page, mục tiêu, đích/thời gian dự kiến và cách duyệt/sửa/bỏ. Không có phản hồi không đồng nghĩa đồng ý.
5. Phản hồi của khách được luồng tin cậy kiểm tra theo §7.2. Duyệt phiên bản cũ không được áp sang nội dung mới.
6. Có lỗi thì báo hành động cần làm, không đẩy stack trace, cookie hoặc khoá ra Telegram. Lỗi lặp cùng công việc không tạo một chuỗi thông báo vô hạn.

Không hứa bot đã tự đi bình luận ngoài Page trong đợt A. Có thể báo “đã tìm thấy cơ hội để trao đổi”, nhưng không báo “đã bình luận” nếu chưa có executor và bằng chứng gửi thành công.

## 10. Quan sát và đánh giá

Dữ liệu kinh doanh có ba lớp: **đã quan sát**, **nhận định**, **chưa biết**. Mỗi nhận định phải trỏ tới nguồn và khoảng thời gian; dữ liệu quá ít, cũ hoặc không so sánh được phải được nói rõ.

Đợt A lưu lý do và bằng chứng để đợt C đánh giá, không xây thuật toán chấm điểm chiến dịch giả. Các tín hiệu tương lai gồm câu hỏi đúng nhu cầu, hội thoại có ý định tìm hiểu, phản hồi cần xử lý và thay đổi tương tác khi thực sự thu được. Phân loại bằng AI là dự đoán có lý do, không phải khách đã mua.

Không tự quy mọi lead về một chiến dịch chỉ vì nó xảy ra sau bài đăng. Chỉ gắn quan hệ khi có nguồn/ID liên kết; không biết thì giữ chưa xác định. Không so nhóm và Page như cùng một tập đo, không cộng lượt từ các snapshot lặp.

## 11. Điểm tích hợp và tái sử dụng

| Khu vực | Vai trò dự kiến trong triển khai |
|---|---|
| `src/models/dailyBrief.ts`, `src/services/dailyBrief/` | Kiểu hồ sơ/công việc, lưu và đối soát; giữ contract brief cũ |
| `src/services/control/ControlStore.ts`, `src/services/control/ControlApiServer.ts`, `src/services/control/ControlMethods.ts` | Danh tính khoá, quyền máy chủ, lọc phạm vi, API hồ sơ/trạng thái và lỗi có cấu trúc |
| `electron/ipc/dailyBriefIpc.ts` | Nối lifecycle workspace và browser-job slot theo mẫu hiện có |
| `src/services/video/VideoService.ts` | Đọc trạng thái, kết quả và tham chiếu video có sẵn; không tạo service video thứ hai |
| `tools/maihub-bridge/maihub_bridge.py` | Runner/guide/watch, tiếp tục công việc, bàn giao xác nhận; giữ Python stdlib |
| Các test daily brief, control, video và bridge hiện có | Mở rộng đúng biên thay đổi, giữ nguyên ca hồi quy |
| `SYSTEM_DOCUMENTATION.md`, `docs/protocol/maihub-control-protocol.md`, README bridge | Cập nhật cùng commit triển khai khi thực sự đổi API/schema/hành vi |

Tên method/schema mới phải chốt trong kế hoạch sau duyệt spec, dựa trên conventions hiện có; các tên trường trong bản này là hợp đồng thiết kế, không phải API đã phát hành. Không thêm dependency hoặc lớp Repository/Factory/agent framework chỉ để hợp thức hoá kiến trúc.

## 12. Nghiệm thu và hai vòng kiểm thử bắt buộc khi triển khai

### Vòng 1 — hành vi và tương thích

- Ba Page với sản phẩm/phong cách khác nhau: hồ sơ, nháp và nguồn không lẫn; cùng Page qua hai profile không sinh hai trí nhớ độc lập.
- Runner đọc/ghi đúng phạm vi; tất cả đường duyệt/đăng/sửa lịch, gửi tin, tạo khoá hoặc giả xác nhận đều bị từ chối, kể cả `confirm: true`.
- Đường duyệt của khách vẫn dùng được qua Telegram với đúng người, đúng nháp/phiên bản/đích/thời gian; nội dung từ Facebook không thể đóng vai lệnh của khách.
- Daily suggestions, research, nháp, duyệt/lịch đăng, first comment, thu bình luận/lead, cả hai engine video và bridge/watch hiện có vẫn đạt các test hồi quy.
- Không có dữ liệu doanh thu: bot không tạo đơn/ROI giả và không bắt khách nhập dữ liệu không có.

### Vòng 2 — lỗi, cạnh tranh và khôi phục

- Hai runner claim cùng việc; claim hết hạn; completion cũ đến trễ; đổi workspace/Page giữa lúc chạy; thu hồi quyền giữa hai bước.
- Video chạy lâu hơn lượt agent; process chết trước/sau khi lưu ID; event lặp, sai thứ tự hoặc đã hết retention; media hết hạn; gửi nháp/Telegram timeout.
- Retry không nhân bản nháp/video; mất bằng chứng side effect chuyển `needs_review`; idempotency hết hạn không làm mất liên kết lịch sử.
- Chạm giới hạn hồ sơ/thông tin; cập nhật revision xung đột; thiếu nguồn; nguồn bị xoá; payload lồng ID của Page khác.
- Dừng tự động không huỷ lịch của khách; checkpoint không bị retry như lỗi mạng; không giữ browser slot khi chờ video/phê duyệt.

Khi triển khai phải chạy typecheck, toàn bộ Jest/Python, build theo script hiện có và `node scripts/check-docs.js`; review diff thực tế trước báo hoàn tất. Repo khảo sát không có target `make build/test/lint` hoặc lint script: báo thiếu trung thực, không tạo hạ tầng build ngoài phạm vi hoặc gọi typecheck là lint. Nếu phát sinh UI, cả hai vòng phải kiểm desktop/mobile và dark/light.

Test offline không chứng minh Facebook live hoạt động, không chứng minh receiver VPS đã tích hợp hoặc khoá bí mật đã được cách ly ngoài production. Pilot thật cần phép riêng và bằng chứng những điểm đó trước khi bật quyền ghi.

## 13. Phát hành, rollback và cổng duyệt

- Bản spec này chỉ thay tài liệu; chưa đổi schema, hành vi, cấu hình hay version.
- Triển khai sau duyệt spec và kế hoạch: dev → test/review → build artifact → chỉ deploy artifact khi anh cho phép. Không sửa source trực tiếp trên production.
- Schema mới phải additive, test trên database tạm; không chạy migration vào dữ liệu người dùng trong phiên phát triển.
- Khi chuyển giao runner phải có kiểm tra capability và quyền trước khi bật; không có capability thì không tự fallback sang khoá toàn quyền.
- Rollback vận hành: dừng nhận việc mới ở chế độ mới, thu hồi khoá runner tương ứng; giữ dữ liệu hồ sơ/audit và các lịch khách đã duyệt. Chỉ quay về runner legacy khi anh cho phép và đã báo rõ mất bảo vệ mới; không tự bật lại để “chữa” lỗi.
- Sau phát hành cập nhật trạng thái và ghi chú triển khai của spec; không viết lại các quyết định lịch sử.

**Cổng hiện tại:** kế hoạch đã được anh duyệt ngày 27/10/2026; triển khai và kiểm thử local theo `docs/plans/2026-10-27-page-operations-foundation.md`. Các thao tác dịch vụ thật, pilot VPS và deploy vẫn cần phép riêng; chưa công bố đã nghiệm thu đầu-cuối.

## Ghi chú chốt kiểm chứng local — 28/10/2026 (chưa phát hành)

- Controller chấp nhận Tasks 1–9 và bản sửa F1–F4 sau review từng task, một final broad review, một lượt sửa và một scoped re-review. Kết luận bản sửa: SPEC COMPLIANT / QUALITY APPROVED; F1–F4 ADDRESSED, không có finding tồn dư/hồi quy trực tiếp được xác minh trong delta 13 file. Những dòng “còn chờ” trong ghi chú lịch sử bên dưới mô tả thời điểm bàn giao trước đó, không còn là trạng thái hiện tại.
- Hai vòng controller sau sửa đều đạt 118 suites/2.791 test Jest và 346 test Python; renderer/Electron noEmit, production-config TS, script strip-console hiện có, Vite renderer, docs-check, diff-check và index-check exit 0. `make build`, `make test`, `make lint` đều exit 2 vì thiếu target; không có chứng nhận lint hoặc bộ cài production. Fault-injection/database fixture diagnostics và warning build crypto/eval/mixed imports/chunk size vẫn còn.
- UI sau sửa: 16 cells behavior/fault qua hai vòng desktop 1440×900/mobile 390×844 × light/dark, real React/CSS với fake IPC; lưu 16 screenshots, trực tiếp xem 8 ảnh phủ hai vòng/mọi layout và theme. Không page errors/tràn ngang/controls ngoài viewport; current-navigation console 0/0. 884 source hashes không đổi qua kiểm chứng, 278 UI sources khớp baseline. Giới hạn shared ConfirmDialog/focus/zero-delay Enter vẫn giữ, không chứng nhận accessibility toàn cục hoặc Electron/live transport.
- Tái dùng stores/CAS/ticket transaction/ownership/preparation guards/daily ledger và fixtures/stdlib hiện có; không dependency, schema, method, UI hoặc version mới trong bản sửa. Không commit/push/deploy, migration khách, timer hoặc gọi Facebook/Telegram/AI/video thật.
- **INTEGRATION BLOCKED — proposal/read-only, `protectedWritesEnabled=false`.** Receiver transport/authentication, OS user/file/env/MCP isolation, fresh-HOME CLI auth và packaging/native/E2EE/live providers chưa được kiểm chứng. Chấp nhận local không phải cho phép kích hoạt hoặc nghiệm thu Phase A đầu-cuối; các bước vận hành cần approval riêng. Không viết lại thân spec hoặc ghi chú lịch sử bên dưới.

## Ghi chú sửa final review F1–F4 — 28/10/2026 (chờ nghiệm thu, chưa phát hành)

- First-primary dùng owner-approved `setPrimaryProfile(expectedRevision:0)` khi business null; prepare/bind không tạo row, confirm atomically khởi tạo disabled + CAS primary/revision + consume ticket; cần enable riêng. Identity/scope/snapshot/cap 10 và rollback giữ nguyên; không runner bootstrap/seed.
- `pageWork.draft` thêm lifecycle marker promoted/removed chỉ sau durable ownership/context checks; actionable shape cũ giữ nguyên. Watcher tiếp tục nháp mới cùng/khác Page qua restart và giữ cursor/delivery intents; unknown/foreign/revoked vẫn fail closed, approval cũ cần proposal mới.
- Expired running được reconcile phía server: không intent chưa rõ → pending, unresolved → needs_review; active owned preparation không bị reclaim/retire. Claim riêng mới tăng invocation/token; không client-clock expiry hoặc nuốt lỗi quyền. Startup retirement vẫn như trước.
- `PageWork.attempts` là lifetime, bỏ gate lifetime ở bridge; server vẫn enforce ba invocation/ngày/Page. Carryover/video lifetime 4 ở ngày mới chỉ chạy sau server claim, không tạo duplicate invoke.
- Regression RED→GREEN dùng bridge Python thật qua pinned HTTPS/runtime/SQLite tạm, fake external sender/agent/browser/provider; không live service. Worker chạy hai focused rounds, full Jest/Python một lần, hai noEmit/docs/diff và ghi Make failures; controller còn hai full build/UI rounds cùng một scoped F1–F4 re-review. Không sửa thân lịch sử bên dưới, không đổi UI/dependency/version/config. Gate giữ false, proposal/read-only và live receiver/OS/file/env/MCP/CLI authentication vẫn INTEGRATION BLOCKED; không tuyên bố toàn tính năng hoàn tất.

## Ghi chú sau triển khai local — 28/10/2026 (chưa phát hành)

- Tasks 1–8 đã được chấp nhận local, gồm repair Task 8; Task 9 bổ sung `src/__tests__/dailyBrief/pageOperations.integration.test.ts` và tài liệu. Không viết lại thân quyết định lịch sử ở trên, không tăng version hoặc thay production wiring/config.
- Sáu ca đi qua actual runtime registry/IPC adapters, HTTPS authority, SQLite tạm và shared browser slot; fake external browser/research/video/clock. Cách ly ba Page đến completed drafts; duplicate profiles một memory/claim; video chờ hơn 160 phút giả lập qua restart rồi adopt một lần, không render; runner không duyệt qua approvals/legacy schedules/render/upload/pair; receiver kiểm revision/owner reply binding, rollback consume+promotion/replay; revoke sau await và restart ngăn stale draft/cache/lease.
- Theo ruling coverage Tasks 1–8: không tạo RED bằng phá source; lỗi fixture phải ghi trung thực, xanh của coverage không phải production-fix RED→GREEN. Nếu có lỗi wiring thật phải có regression fail và báo controller trước mở phạm vi sửa. Giữ nguyên tests/assertions cũ, dirty work và limits đã duyệt.
- Task 9 chưa được tự nghiệm thu: worker focused hai lần/full Jest một lần/hai noEmit/docs/diff và ghi Make failures; controller còn review độc lập, hai full Jest/Python/production-config TS+strip/renderer/docs/Make/diff và UI desktop/mobile × light/dark. Make targets/lint hiện thiếu; typecheck không là lint, TS/Vite không là bộ cài production. Không tuyên bố mọi hồi quy hoặc hai vòng stress cuối đã đạt trước evidence đó.
- Evidence UI do controller cung cấp: hai vòng behavior/fault, tổng 16 desktop/mobile × light/dark cells, real React/CSS + fake IPC, 16 screenshots đã xem; không page overflow/controls ngoài viewport, current-navigation console 0/0, 278 UI sources khớp baseline. Final handoff còn kiểm source hashes; không chứng nhận live backend/Electron/receiver hoặc accessibility toàn cục (shared ConfirmDialog/focus/zero-delay Enter còn giới hạn).
- **INTEGRATION BLOCKED — proposal/read-only, `protectedWritesEnabled=false`.** Chưa xác định/nối authenticated transport entrypoint của receiver VPS thật vào `handle_owner_update`, chưa chứng minh user/file/env/MCP isolation hoặc CLI auth fresh HOME. App Telegram ingress không thay receiver VPS; không thêm poller getUpdates, không chuyển owner secrets vào runner, không live providers/customer migration/install/timer/deploy. Chỉ sau approval riêng mới dev → tests/review → build artifact/image → deploy artifact/image; giữ rollback claims/key và audit/memory/approved schedules như §13. Chưa kết luận Phase A end-to-end hoàn tất.
