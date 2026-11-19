# Tải lịch sử tin nhắn Facebook cá nhân

**Ngày:** 14/11/2026
**Trạng thái:** Đã triển khai, gộp vào `main` và phát hành trong 26.36.0 (14/11/2026), sửa lỗi lần chạy thật đầu tiên trong 26.36.1; chưa thử với tài khoản Facebook thật. Anh duyệt 14/11/2026, gộp cả đồng bộ theo khoảng ngày vào cùng đợt. Plan: `docs/plans/2026-11-14-facebook-history-sync.md`.
**Nguồn tham chiếu:** `babyvibe/deplao-builder` (MIT) tại `2162f07`: `src/bridge-e2ee/bridge/history.go`, `FacebookService.fetchHistoryPage`, `src/shared/facebook/facebookHistorySync.ts`, `chat/window/channels/facebook/chatWindow.ts`, `FacebookHistorySyncService.ts`, `FacebookSyncButton.tsx`.

## 1. Mục tiêu

Anh mở một hội thoại Facebook cá nhân trong MaiHub và thấy tin cũ; kéo lên thì app tải tiếp từng trang cũ hơn, giống Messenger web. Tin tải về nằm đúng hội thoại, không sinh tin trùng, không báo chưa đọc, không thông báo, không chạy workflow.

Không phải mục tiêu: hội thoại mã hoá đầu cuối (Facebook không cho thiết bị mới đọc tin cũ, bản gốc cũng không làm được); Facebook Page (làm sau); tải lại ảnh/video đã hết hạn.

## 2. Hiện trạng (đã kiểm 14/11/2026)

- MaiHub chưa bao giờ tải tin cũ Facebook. Hội thoại chỉ có những tin đến trong lúc app đang chạy. Trong `ChatWindow.tsx` còn hàm `probeFbOlderMessages` bị tắt từ 26.6.0 với ghi chú "API lỗi 500".
- IPC `fb:fetchThreadMessages` (GraphQL, `doc_id 5587413956701165`) có sẵn và đã lưu tin dạng lịch sử, nhưng giao diện không gọi. Bản gốc ngày nay chỉ dùng đường này cho **trang mới nhất** (20 tin) của hội thoại chưa có tin nào trong máy.
- Bản gốc lấy các trang cũ hơn qua bridge Go bằng lệnh LightSpeed `FetchMessagesTask` (nhãn 228), neo vào mã và thời điểm của một tin có thật. Câu trả lời về sau trên luồng sự kiện, dưới dạng lô `LSUpsertMessage` kèm `LSInsertNewMessageRange`, hoặc `LSUpdateExistingMessageRange` khi đã hết tin.
- **Không phải đổi bản thư viện.** `mautrix/meta` ở bản mình đang ghim (`e012f9f`) đã có `socket.FetchMessagesTask`, `table.LSInsertNewMessageRange`, `table.LSUpdateExistingMessageRange`, `UpsertMessages.Range`, `Client.GetCursor` và `ExecuteTasks`. Em đã đối chiếu trên GitHub. (Lúc trước em nói có thể phải đổi bản ghim; điều đó sai.)
- Bridge Go của mình (`src/bridge-e2ee`, 4 735 dòng, không có test) đã nối socket LightSpeed thường trong `Connect()`, nhưng chưa có lệnh tải lịch sử. `handleTable` hiện phát **mọi** tin trong lô upsert như tin mới đến; nếu gọi `FetchMessagesTask` mà không chặn, tin cũ sẽ bị coi là tin mới (thông báo, chưa đọc, workflow).
- Máy này **không có Go**. Bridge chỉ được build trong CI khi đẩy tag `v*`.
- Bản gốc điều tốc bằng `FacebookHumanPacer`: giãn cách ngẫu nhiên, "nghỉ đọc", "nghỉ giải lao" để trông giống người dùng thật.

## 3. Quyết định

| # | Quyết định |
|---|---|
| D1 | (anh, 14/11) Làm theo cách của bản gốc: trang mới nhất qua GraphQL, các trang cũ hơn qua bridge Go. |
| D2 | (anh, 14/11) Làm cả hai phần trong một đợt: **tải khi mở hội thoại và khi kéo lên**, và **hộp thoại "Đồng bộ tin nhắn Facebook" theo khoảng ngày** cho mọi hội thoại. Phần sau xây trên cùng một hàm tải trang của phần trước. |
| D3 | (em) **Không port `FacebookHumanPacer`.** Thay bằng bộ giới hạn tốc độ thẳng thắn: khoảng cách tối thiểu cố định giữa hai yêu cầu, trần số trang mỗi giờ, và tự dừng 30 phút khi Facebook trả dấu hiệu hạn chế (checkpoint, yêu cầu đăng nhập lại). Mục đích là gọi ít và dừng sớm để bảo vệ tài khoản, không phải giả làm người dùng để qua mặt hệ thống phát hiện — phần đó nằm ngoài phạm vi em làm. |
| D4 | (em) Giữ `mautrix/meta` ở `e012f9f`. |
| D5 | (em) Port sát `history.go` của bản gốc (242 dòng) và chỉnh cho khớp `Client` của mình; ghi nguồn ở đầu file và trong `NOTICE.md`. Phần TypeScript viết theo kiến trúc MaiHub, dùng lại `saveFBMessage` (đã có `is_history`). |
| D6 | (em) Trong bridge: lô upsert của hội thoại **đang có yêu cầu lịch sử chờ** được giao cho yêu cầu đó và không phát thành sự kiện tin mới. Mọi trường hợp khác giữ nguyên hành vi hiện tại. |
| D7 | (em) Bridge đi kèm app nên luôn cùng phiên bản; không thêm bước bắt tay `hello`. Nếu bridge trả `unknown method: fetchMessages` (bản dev build cũ) thì báo mã `BRIDGE_OLD`. |
| D8 | (em) Thêm test Go đầu tiên cho bridge (bộ thu trang lịch sử) và một bước `go vet` + `go test` trong CI trước khi build bridge. Để chạy được trên máy này, em tải bộ Go 1.26 chính thức vào thư mục tạm của phiên làm việc; **không cài gì vào máy anh**. |
| D9 | (em) Chỉ chủ tài khoản; nhân viên (workspace remote) không gọi được. Bỏ qua tài khoản Page. |
| D10 | (em) Port phần đọc tin GraphQL đầy đủ hơn của bản gốc (sticker, video, ghi âm, tin hệ thống, thẻ chia sẻ) để trang mới nhất không ra bong bóng rỗng. |
| D11 | (em) Không lấy: tự vá "tin rỗng" khi mở hội thoại, gợi ý sau đăng nhập, đường proxy cho nhân viên, API ngoài (`chatExtra`), lệnh `syncHistory` của bridge (tải lại trang hộp thư), bước chờ socket LightSpeed 3 phút. |
| D12 | (em) Đồng bộ hàng loạt **chờ** khi chạm giới hạn tốc độ (hiện "đang chờ" trên hộp thoại) thay vì báo bận; thao tác kéo lên của anh thì báo bận ngay để không treo giao diện. Cả hai dùng chung một ngân sách cho mỗi tài khoản. |

## 4. Luồng khi mở hội thoại và khi kéo lên

**Mở hội thoại** (Facebook cá nhân, chưa đánh dấu mã hoá, đang ở máy chủ tài khoản):

1. App hiện tin trong máy như hiện nay.
2. Nếu trong máy chưa có tin nào của hội thoại, app gọi `fb:fetchOlderMessages` không kèm mốc. Tiến trình chính không tìm được tin `mid.$…` nào làm mốc nên lấy **trang mới nhất qua GraphQL** (20 tin), lưu dạng lịch sử, giao diện đọc lại từ DB.
3. Mỗi hội thoại chỉ thử bước 2 một lần cho mỗi lần chạy app.

**Kéo lên khi trong máy đã hết tin cũ** (`ChatWindow.handleLoadMore`, sau bước đọc DB, cạnh nhánh Telegram):

1. Giao diện gọi `fb:fetchOlderMessages { accountId, threadId, beforeTimestampMs, beforeMessageId }` với tin cũ nhất đang hiển thị.
2. Tiến trình chính chọn mốc: mã của người gọi nếu có dạng `mid.$…`; nếu không (tin cũ nhất là tin mã hoá hoặc tin tạm) thì lấy tin `mid.$…` mới nhất trong máy không muộn hơn mốc thời gian; không có thì quay về trang GraphQL.
3. Có mốc: gọi bridge `fetchMessages { threadId, beforeTimestampMs, beforeMessageId, timeoutMs }`. Bridge gửi `FetchMessagesTask`, chờ tối đa 25 giây, trả một trang `{ messages, hasMoreBefore, minTimestampMs, minMessageId }`, mới nhất trước.
4. Tiến trình chính lưu từng tin bằng `saveFBMessage` với `is_history: true`, trả `{ success, stored, saved, count, hasMoreBefore, minTimestampMs, minMessageId, source }`.
5. Giao diện đọc lại DB và nối thêm vào đầu danh sách, giữ vị trí cuộn. `hasMoreBefore = false` hoặc trang rỗng thì thôi không hỏi nữa cho hội thoại đó.

**Mã lỗi** (trường `code`), giao diện xử lý:

| Mã | Khi nào | Giao diện |
|---|---|---|
| `E2EE` | hội thoại mã hoá đầu cuối | dừng; hiện một dòng ở đầu hội thoại: "Hội thoại mã hoá đầu cuối: Facebook không cho tải tin cũ" |
| `NOT_CONNECTED` | tài khoản chưa kết nối | dừng, không báo |
| `BRIDGE_DOWN` | bridge chưa chạy hoặc socket thường chưa nối | dừng, lần kéo sau thử lại |
| `BRIDGE_OLD` | bridge không biết lệnh | dừng, ghi log một lần |
| `BUSY` | đã chạm trần số trang mỗi giờ | dừng, lần sau thử lại |
| `COOLDOWN` | đang trong 30 phút tạm dừng | dừng |
| `RISK` | Facebook trả dấu hiệu hạn chế | dừng, thông báo một lần: "Facebook có dấu hiệu hạn chế — đã tạm dừng tải tin cũ 30 phút để bảo vệ tài khoản" |
| `FETCH` | lỗi mạng, hết giờ chờ | hiện "Lỗi - Thử lại" sẵn có, vẫn cho thử lại |

## 5. Thành phần

**Go — `src/bridge-e2ee`**

- `bridge/history.go` (mới): `HistoryPage`, bộ thu theo hội thoại, `deliverHistory(tbl, upsert)`, `FetchThreadHistory(ctx, threadID, beforeTs, beforeID, timeout)`. Mỗi hội thoại một yêu cầu tại một thời điểm; yêu cầu thứ hai bị từ chối. Bỏ qua câu trả lời `LSUpdateExistingMessageRange` có mốc thời gian khác mốc đã hỏi.
- `bridge/events.go`: `handleTable` gọi `deliverHistory` trước; hội thoại có bộ thu đang chờ thì lô upsert của nó không phát sự kiện (D6).
- `bridge/client.go`: hai trường `historyMu`, `historyCollectors`.
- `main.go`: `case "fetchMessages"`, chạy trong goroutine riêng để không chặn lệnh gửi tin, có `recover`.
- `bridge/history_test.go` (mới): bộ thu với bảng dựng tay — trang có range, trang hết tin, câu trả lời của mốc khác, tin trùng, hai yêu cầu cùng hội thoại, hết giờ.

**Tiến trình chính**

- `src/services/facebook/facebookHistory.ts` (mới, hàm thuần): `activityMs`, `isLightSpeedMessageId`, `nextHistoryAnchor`, kiểu `FbHistoryPageResult`. Port từ bản gốc.
- `src/services/facebook/FacebookHistoryLimiter.ts` (mới, D3): `check()` → cho đi / `BUSY` / `COOLDOWN`; `recordRequest()`; `recordResult(ok, error)` → `'ok' | 'risk'`. Giá trị: tối thiểu **2 giây** giữa hai yêu cầu của một tài khoản, tối đa **120 trang mỗi giờ**, dừng **30 phút** khi lỗi khớp mẫu hạn chế (`checkpoint`, `login_required`, `not logged in`, mã `1357001`, `1357004`, `1390008`). Đồng hồ tiêm được để test.
- `FacebookE2EEBridge.fetchMessages(params)`: gọi `call('fetchMessages', params, 30 000)`.
- `FacebookService.fetchHistoryPage(threadId, anchor, range?, { mode, shouldStop, onWait })`: thứ tự kiểm tra như bảng mã lỗi; chọn mốc; GraphQL hoặc bridge; lưu; trả kết quả. Dùng chung cho đồng bộ hàng loạt (`syncThreadHistory`).
- `FacebookThreadManager.fetchThreadMessages`: phần đọc tin đầy đủ hơn (D10).
- `electron/ipc/facebookIpc.ts`: `fb:fetchOlderMessages`; từ chối khi workspace đang mở là `remote`; kiểm tra tham số. `fb:fetchThreadMessages` giữ nguyên.
- `FacebookThreadManager.getThreadListPage`, `FacebookService.getThreadListPage`, `FacebookService.syncThreadHistory`, `src/services/facebook/FacebookHistorySyncService.ts` (mới) — xem mục 9.
- `electron/preload.ts`, `src/ui/lib/ipc.ts`: `ipc.fb.fetchOlderMessages`, `ipc.fbHistorySync`, cho phép sự kiện `event:fbHistorySync`.

**Giao diện**

- `src/ui/lib/chat/fbOlderMessages.ts` (mới, hàm thuần): quyết định có hỏi máy chủ không (kênh, Page, nhân viên, đã thử, mã hoá), và ánh xạ kết quả/mã lỗi thành `{ stored, hasMore, notice?, retryable }`.
- `ConversationList.tsx`: nhánh "DB trống" cho Facebook, cạnh nhánh Telegram.
- `src/ui/lib/chat/fbHistorySyncView.ts` (hàm thuần) và `src/ui/components/layout/FacebookSyncButton.tsx` (mới), một dòng trong `TopBar.tsx` — xem mục 9.
- `ChatWindow.tsx`: nhánh Facebook ở bước 2 của `handleLoadMore`; xoá `probeFbOlderMessages`, `fbCursorRef`, `fbHasMoreRef` không còn dùng; dòng ghi chú cho hội thoại mã hoá.

**Tài liệu:** `SYSTEM_DOCUMENTATION.md`, `NOTICE.md`, `src/bridge-e2ee/README.md`, `.github/workflows/build.yml` (bước `go vet` và `go test`).

## 6. Dữ liệu

Không đổi schema. Tin lịch sử ghi qua `saveFBMessage({ …, is_history: true })`: không tăng chưa đọc, không phát sự kiện tin mới. Chống trùng theo mã tin (`INSERT OR IGNORE`); tin đã có được giữ nguyên, hàng rỗng được vá như hiện nay. Tin từ bridge và từ GraphQL dùng chung dạng mã `mid.$…` nên không sinh bản sao giữa hai đường.

## 7. An toàn và riêng tư

- Không gửi cookie, token hay nội dung tin tới bên thứ ba; mọi yêu cầu đi thẳng tới Facebook qua bridge và phiên sẵn có.
- Log chỉ ghi mã hội thoại, số tin, cờ `hasMoreBefore`, mã lỗi. Không ghi nội dung tin, cookie, URL đính kèm.
- Bộ giới hạn áp cho từng tài khoản và dùng chung cho cả thao tác kéo lên lẫn đồng bộ hàng loạt.
- Hết giờ chờ ở bridge không để lại bộ thu treo; ngắt kết nối giải phóng mọi yêu cầu đang chờ.

## 8. Kiểm chứng

- **Tự động, không gọi Facebook:** test Go cho bộ thu; test Jest cho hàm thuần, bộ giới hạn (đồng hồ giả), `fetchHistoryPage` với bridge giả và GraphQL giả (chọn mốc, từng mã lỗi, lưu dạng lịch sử, không tăng chưa đọc, không trùng), dịch vụ đồng bộ hàng loạt với dịch vụ giả và đồng hồ giả (liệt kê, lọc theo khoảng, bỏ qua mã hoá, thử lại, dừng cả lượt, huỷ, hai lượt cùng tài khoản), IPC (từ chối nhân viên, tham số xấu), hàm thuần của giao diện, bộ đọc GraphQL với dữ liệu dựng tay.
- **Bộ lệnh chuẩn:** Jest ba múi giờ, test Python, `tsc` hai cấu hình, `check-docs`; thêm `go vet ./...`, `go test ./...` và build bridge bằng Go trong thư mục tạm.
- **Không tự kiểm được:** mọi thứ cần tài khoản Facebook thật — Facebook có trả trang GraphQL không (ghi chú "lỗi 500" cũ), `FetchMessagesTask` có trả lời không, mốc `mid.$…` có khớp không. Giao diện chưa được xem trong app đang chạy.
- **Anh thử sau khi phát hành:** mở một nhóm hoặc một hội thoại chưa mã hoá chưa từng có tin trong máy; kéo lên ba bốn trang; chạy đồng bộ "1 tuần gần nhất"; mở một hội thoại mã hoá và xem dòng ghi chú; kiểm tra tin cũ không làm tăng số chưa đọc; xem file log dòng `History page` của bridge.

## 9. Đồng bộ theo khoảng ngày

**Giao diện.** Nút mới trên thanh công cụ, cạnh nút đồng bộ Zalo; chỉ hiện khi tài khoản đang chọn là Facebook cá nhân (không phải Page) và không ở chế độ nhân viên. Hộp thoại cùng kiểu với hộp thoại Zalo:

- Chọn khoảng: **1 tuần gần nhất** (mặc định), **Chọn ngày** (từ–đến), **Toàn bộ**. Dưới lựa chọn "Toàn bộ" có cảnh báo: "Tải toàn bộ lịch sử gửi nhiều yêu cầu nhất tới Facebook và có thể chạy nhiều giờ. Chỉ chọn khi thật sự cần."
- Đang chạy: dòng trạng thái ("Đang lấy danh sách hội thoại… (N)", "Đang tải tin nhắn N hội thoại…"), tên hội thoại đang tải, thanh tiến độ theo số hội thoại xong / tổng, số tin mới đã lưu; khi đang chờ giới hạn tốc độ hiện "Đang chờ để không gửi quá nhiều yêu cầu tới Facebook…". Nút "Ẩn" và "Dừng đồng bộ". Đóng hộp thoại không dừng việc đồng bộ.
- Kết thúc: "Đã đồng bộ N hội thoại, M tin mới"; ghi chú "K hội thoại mã hoá đầu cuối được bỏ qua" và "J hội thoại không tải được" khi khác 0. Bị dừng: "Đã dừng — đã lưu M tin mới". Lỗi: lý do.
- Xong hoặc dừng: tải lại danh sách hội thoại và gộp thêm tin vào hội thoại đang mở (dùng lại `refreshPlan`, `mergeThreadMessages` của phần Zalo).

**Tiến trình chính — `FacebookHistorySyncService`** (một lần chạy cho mỗi tài khoản):

1. `listing`: lấy danh sách hội thoại theo trang (`getThreadListPage(before)`, 50 hội thoại mỗi trang, tối đa 400 trang, dừng khi hội thoại cũ nhất của trang đã trước đầu khoảng), lưu vào `fb_threads`, rồi gộp với hội thoại đã có trong máy (`fb_threads`, `contacts` kênh Facebook). Giữ những hội thoại có hoạt động trong khoảng (không rõ thời điểm thì vẫn giữ), mới nhất trước.
2. `syncing`: với từng hội thoại — bỏ qua nếu mã hoá đầu cuối; nếu không thì lùi từng trang bằng `fetchHistoryPage` từ cuối khoảng tới khi Facebook báo hết, trang rỗng, tin cũ nhất đã trước đầu khoảng, hoặc mốc không lùi được nữa. Chỉ lưu tin nằm trong khoảng. Lỗi `FETCH` thử lại một lần rồi tính hội thoại đó là lỗi và đi tiếp.
3. Dừng cả lượt (`failed`, kèm lý do) khi: bridge không chạy (`BRIDGE_DOWN`, `BRIDGE_OLD`), Facebook có dấu hiệu hạn chế (`RISK`, `COOLDOWN`), phiên hết hạn (`cookie_expired`) hoặc tài khoản mất kết nối.
4. Huỷ: dừng sau trang đang tải; những gì đã lưu được giữ lại.

**IPC:** `fb:historySync:start { accountId, fromTs, toTs }`, `fb:historySync:cancel { accountId }`, `fb:historySync:status { accountId }`; sự kiện `event:fbHistorySync` mang `{ accountId, stage, range, message, error?, threadsTotal, threadsDone, currentThreadName?, messagesSaved, messagesReceived, skippedE2EE, failedThreads, startedAt, finishedAt?, pausedUntil? }`, tối đa một lần mỗi 400 ms trừ khi đổi bước. Từ chối ở chế độ nhân viên và với tài khoản Page.

**Thời gian chạy.** Trần 120 trang mỗi giờ, mỗi trang khoảng 20 tin: "1 tuần gần nhất" trên vài chục hội thoại thường xong trong dưới một giờ; "Toàn bộ" trên tài khoản nhiều hội thoại chạy nhiều giờ. Đây là đánh đổi có chủ ý. Lượt đồng bộ không chạy tiếp sau khi tắt app; chạy lại thì tin đã có không bị trùng, nhưng vẫn phải duyệt lại các trang.

## 10. Rủi ro

- **Tài khoản bị hạn chế.** Tải lịch sử là hành vi Facebook có thể soi, nhất là đồng bộ hàng loạt. Giảm bằng trần tốc độ, mặc định "1 tuần gần nhất", cảnh báo ở "Toàn bộ", và tự dừng 30 phút khi có dấu hiệu. Nên thử lần đầu bằng thao tác kéo lên trong một hội thoại rồi mới chạy hàng loạt.
- **Giao thức đổi.** Nếu Facebook đã đổi câu trả lời của `FetchMessagesTask` so với bản thư viện đang ghim, trang sẽ hết giờ chờ (`FETCH`); khi đó mới cân nhắc nâng `mautrix/meta`, là việc lớn hơn nhiều.
- **Lùi lại:** mọi thay đổi nằm sau một lệnh bridge mới và một IPC mới; gỡ nhánh gọi trong giao diện là tắt được tính năng mà không ảnh hưởng nhận/gửi tin.

## Ghi chú sau triển khai

Chỗ mã khác với thân spec ở trên (thân spec giữ nguyên):

- `FacebookHistoryFetcher` (`src/services/facebook/FacebookHistoryFetcher.ts`) là một lớp riêng với phụ thuộc được tiêm (bridge, trang GraphQL, bộ giới hạn, `sleep`), không phải các hàm nằm trong `FacebookService` (mục 5: `fetchHistoryPage`, `syncThreadHistory`); `FacebookService` chỉ uỷ quyền cho nó.
- Bridge giữ câu trả lời muộn của một hội thoại thêm 60 giây sau khi yêu cầu kết thúc (hết giờ hoặc xong), để tin cũ về trễ không bị phát thành tin mới. Mục 5 chỉ nói bộ thu bị gỡ khi hết giờ.
- Thẻ chia sẻ trong tin GraphQL được lưu thành chữ của tin (không thành tệp đính kèm).
- `syncThread` có thêm hai chốt chống vòng lặp ngoài `nextHistoryAnchor`: tập mốc đã dùng (mốc lặp lại thì dừng) và dừng khi một trang sau trang đầu trả mốc mới hơn mốc hiện tại.
- Lần chờ giới hạn tốc độ từ 4 giây trở lên mới được báo là tạm dừng (`pausedUntil`) cho giao diện; chờ ngắn hơn không hiện.
- `DatabaseService.saveFBMessage` không ghi log từng tin khi `is_history`, để đồng bộ hàng loạt không làm đầy file log.
- Tài khoản Page được ẩn nút đồng bộ ở giao diện dựa trên bản ghi tài khoản (có `parent_zalo_id`); phía tiến trình chính vẫn từ chối Page như spec.
- Sau review toàn nhánh (14/11/2026):
  - Mọi lần đọc/ghi DB của phần lịch sử đi qua `EventBroadcaster.runOnBossDb`, nên tin luôn vào DB của workspace mặc định kể cả khi anh đổi workspace giữa lúc đồng bộ. Mục 6 không nói tới việc này.
  - Tin mới hơn 5 phút (`HISTORY_LIVE_WINDOW_MS`) không lưu qua đường lịch sử; đường nhận tin trực tiếp xử lý chúng để giữ đúng số chưa đọc, thông báo và workflow.
  - Kéo lên trùng lúc đồng bộ hàng loạt trên cùng một hội thoại: đồng bộ chờ 5 giây rồi thử lại (tối đa 6 lần) thay vì tính hội thoại đó là lỗi.
  - Mất kết nối giữa lúc đồng bộ: chờ tối đa 120 giây cho tài khoản nối lại rồi mới dừng; gỡ hoặc ngắt tài khoản thì huỷ lượt đồng bộ ngay.
  - Bảng mã lỗi ở mục 4: `NOT_CONNECTED`, `BRIDGE_DOWN`, `BUSY`, `COOLDOWN` không tắt nút tải thêm (lần kéo sau thử lại); chỉ `E2EE`, `RISK`, `BRIDGE_OLD` mới thôi không hỏi nữa. Với Facebook, trong máy hết tin cũ không còn được coi là hội thoại hết tin.
  - Mã hội thoại gửi sang bridge dưới dạng chuỗi (bản đầu gửi dạng số và bị bridge từ chối; lỗi do review toàn nhánh bắt được).
  - Chưa làm, ghi nhận là giới hạn: tin trả lời tải về khi kéo lên có thể thiếu phần trích dẫn cho tới khi mở lại hội thoại; tạo lại kết nối tài khoản thì ngân sách tốc độ được tính lại từ đầu.
- Lần chạy thật đầu tiên (14/11/2026, bản 26.36.0): tài khoản chỉ có một hội thoại 1:1 mã hoá, không có hàng `fb_threads` nên không có cờ `is_e2ee`; code hỏi GraphQL và Facebook trả HTTP 500, lượt đồng bộ báo "1 hội thoại không tải được". Đã sửa trong 26.36.1: `FacebookHistoryFetcher.isE2EEThread` nhận ra chat mã hoá từ tin đã có trong máy (có tin mà không tin nào mang mã `mid.$…`), giống bản gốc. Hội thoại thường (GraphQL trang đầu, `FetchMessagesTask`) vẫn chưa được kiểm với Facebook thật. Icon nút đồng bộ bị vẽ 56 px, đã đổi sang `w-3.5 h-3.5`.

## Ghi chú sau phát hành (26.49.0)

Từ 26.49.0, chat Messenger 1-1 mã hoá có nút "Thử tải tin từ trước khi mã hoá" cạnh dòng ghi chú mã hoá (chỉ máy chủ tài khoản cá nhân): bấm nút mới gửi một yêu cầu lịch sử thường qua bridge (cờ `probeE2ee`) để xem Facebook còn trả tin từ trước khi chat được mã hoá không; tải tự động (kéo lên, tự tải khi mở) và đồng bộ hàng loạt không bao giờ thử. Mỗi hội thoại chỉ được gửi một yêu cầu cho tới khi instance dịch vụ Facebook bị tạo lại, trừ khi trang trả về có tin được lưu (khi đó bấm tiếp để tải trang cũ hơn), gặp lỗi rủi ro (`RISK`) hoặc bridge rớt giữa chừng. Nhóm chỉ được nhận ra khi hàng `fb_threads` của nó có `type = 'group'`. Đây là thử nghiệm chưa kiểm chứng với Facebook thật; tải toàn bộ lịch sử mã hoá (kho lưu trữ an toàn của Messenger, mã PIN) vẫn chưa làm.

Từ 26.50.0, tin cũ của hội thoại mã hoá đầu cuối còn có thể lấy bằng cách nhập tệp sao lưu đoạn chat do Facebook xuất, không gửi yêu cầu nào tới Facebook: xem `docs/specs/2026-11-19-messenger-e2ee-export-import.md`.
