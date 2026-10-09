# Spec — Trợ Lý AI viết content + gen ảnh cho Facebook Poster

- Ngày: 2026-10-09
- Trạng thái: Draft (chờ anh review)
- Nhánh dự kiến: `feat/ai-fb-content-assistant`

## 1. Bối cảnh & mục tiêu

Người vận hành soạn bài đăng Facebook (fanpage AHV/MODNIX/AHV Holding) qua tính năng **Facebook Poster**
(`PostTab.tsx` → `text` + media → schedule/publish). Thêm **Trợ Lý AI** giúp:

1. **Viết content** đúng giọng brand (học từ bài mẫu của anh): (a) từ brief ngắn → nguyên bài; (b) trau chuốt nháp.
2. **Gen ảnh** cho bài: (a) **thiệp tuyển dụng** chất lượng cao bằng **sửa từ template brand** (image-edit);
   (b) ảnh minh hoạ/vibe bằng **gen tự do** (text-to-image, optional ảnh tham chiếu).

Tất cả gọi qua gateway **ahvchat** (OpenAI-compatible, `https://auto.ahvchat.com/v1/...`): text dùng assistant
ahvchat; ảnh dùng model **`cx/gpt-5.5-image`**.

**Chuẩn chất lượng ảnh:** đạt mức như ảnh mẫu anh gửi (poster tuyển dụng Modnix: logo chuẩn, ảnh team,
tiêu đề lớn, card thông tin vị trí/giờ/lương có icon, mục giới thiệu, footer liên hệ — chữ tiếng Việt chính xác).
Mức này chỉ đạt được bằng **image-edit từ template**, không phải gen từ trống.

**Con người luôn trong vòng lặp:** content và ảnh AI tạo ra đều **sửa/xoá được** trước khi đăng. Không auto-đăng.

## 2. Tái dùng (đã có sẵn) vs Làm mới

| Nhu cầu | Trạng thái | Tái dùng |
|---|---|---|
| LLM client (ahvchat/Claude/Gemini/OpenAI) | **Có** | `AIAssistantService.chat()` + IPC `ai:chat` |
| Học giọng brand từ bài mẫu | **Có** | assistant `systemPrompt` + `ai_assistant_files` (`addFile`/`getFiles`), ráp bởi `buildSystemPrompt()` |
| Lưu API key (mã hoá) | **Có** | `ai_assistants.api_key_encrypted` |
| Đổ text vào bài | **Có** | `PostTab` state `text` → `StartParams` |
| Đính kèm/lưu ảnh vào bài | **Có** | `MediaPicker` + `FileStorageService.saveBuffer` |
| Schedule/publish | **Có** | `FacebookPosterScheduler` + `postToTargets.ts` |
| **Gen ảnh (text-to-image + image-edit)** | **CHƯA** | mới: `AIAssistantService.generateImage()` + IPC `ai:generateImage` |
| **UI Trợ Lý trong PostTab** | **CHƯA** | mới: khối "AI" trong `PostTab.tsx` |
| **Quản lý template thiệp** | **CHƯA** | mới (nhỏ): lưu/chọn file template brand |

## 3. Kiến trúc

### 3.1 Viết content (tái dùng, cấu hình)
- 1 assistant brand (platform=`ahvchat`) với `systemPrompt` mã hoá: giọng AHV/MODNIX, cấu trúc (tiêu đề in hoa,
  emoji bullet, section, hashtag, contact, địa chỉ), và các bài mẫu upload làm `ai_assistant_files`.
- Hai chế độ qua user-message framing (không thêm hạ tầng):
  - **Viết từ brief**: message = brief + yêu cầu "viết nguyên bài theo giọng brand".
  - **Trau chuốt**: message = nháp hiện tại + "viết lại đúng giọng brand, giữ ý".
- Gọi `AIAssistantService.chat(assistantId, messages, ...)` qua IPC `ai:chat` (đã có). Không structured output
  bắt buộc; trả về text thuần.

### 3.2 Gen ảnh (MỚI)
`AIAssistantService.generateImage(input)` — gọi ahvchat `cx/gpt-5.5-image` bằng key của assistant:
```ts
interface GenerateImageInput {
  assistantId: string;
  prompt: string;
  baseImages?: string[];   // local paths — template và/hoặc ảnh tham chiếu. Có → EDIT mode; rỗng → GEN mode.
  size?: string;           // vd '1024x1536' (dọc như ảnh mẫu); mặc định 1024x1024
}
interface GenerateImageResult { localPath: string; }  // đã lưu qua FileStorageService.saveBuffer
```
- **Hợp đồng API ahvchat cho `cx/gpt-5.5-image` là ẩn số** (endpoint `/v1/images/generations` + `/v1/images/edits`
  kiểu OpenAI, HAY `/v1/chat/completions` multimodal trả ảnh base64). → **Task spike đầu tiên** của plan phải xác
  định bằng 1 lần gọi thật, rồi `generateImage` bám theo kết quả. Ảnh về (base64/url) → `FileStorageService.saveBuffer`
  (bucket theo poster/schedule id) → trả `localPath`.
- IPC `ai:generateImage` (mirror `ai:chat`: `aiAssistantIpc.ts` + `preload.ts` + `src/ui/lib/ipc.ts`).

### 3.3 Template thiệp (MỚI, nhỏ)
- Anh upload 1-2 file template master (ảnh brand). Lưu đơn giản: thư mục `ai-templates/` qua FileStorageService,
  danh mục (tên + path) trong `app_settings` (JSON) — KHÔNG thêm bảng DB mới.
- UI chọn template khi gen "thiệp tuyển dụng" → path template đưa vào `baseImages`.

### 3.4 UI trong `PostTab.tsx` (MỚI)
Thêm khối "✨ Trợ Lý AI" phía trên ô `text`:
- Chọn assistant brand (mặc định = assistant ahvchat đầu tiên / default).
- Ô brief + **[Viết bài]** / **[Trau chuốt]** → đổ kết quả vào ô `text` (sửa được).
- **[Tạo ảnh AI]**: chọn chế độ (Thiệp tuyển dụng = chọn template → edit · Ảnh minh hoạ = prompt tự do) + prompt
  (gợi ý tự động từ nội dung bài) → `ai:generateImage` → `localPath` **append vào `media[]`** (dùng lại MediaPicker).
- Trạng thái loading/err rõ ràng; không chặn soạn tay.

### 3.5 Luồng dữ liệu
PostTab → `ipc.ai.chat` → text → textarea. PostTab → `ipc.ai.generateImage` → localPath → `media[]`
→ **schedule/publish giữ nguyên** (StartParams.mediaPaths → postToTargets).

## 4. Interfaces (hợp đồng)
```ts
// Service (mới)
AIAssistantService.generateImage(input: GenerateImageInput): Promise<GenerateImageResult>
// IPC (mới): 'ai:generateImage' { assistantId, prompt, baseImages?, size? } → { success, localPath?, error? }
// Preload: ipc.ai.generateImage(params)
```
Text dùng `ipc.ai.chat` sẵn có (không đổi hợp đồng).

## 5. Xử lý lỗi
- API lỗi/timeout/key sai → trả error rõ, UI hiện thông báo, KHÔNG chặn soạn tay / không mất nội dung đang có.
- Chưa có assistant ahvchat → UI nhắc cấu hình (link sang trang AI Assistant có sẵn).
- Ảnh gen hỏng/không parse được → error, không append rác vào media.

## 6. Testing / success criteria
- **Spike (Task 1):** xác định hợp đồng `cx/gpt-5.5-image` qua ahvchat + kiểm chất lượng image-edit từ template
  (đạt gần ảnh mẫu không). Nếu image-edit chữ quá tệ → ghi nhận, cân nhắc fallback HTML→screenshot (phase sau).
- Unit (jest, không cần mạng): ráp prompt chế độ viết/trau chuốt (hàm thuần build messages); đường lưu ảnh
  (mock API trả base64 → `saveBuffer` → trả localPath).
- Thủ công: (a) từ brief "tuyển Junior UA 12-18M HN" → bài đúng giọng brand; (b) trau chuốt 1 nháp; (c) gen 1 thiệp
  tuyển dụng từ template + 1 ảnh minh hoạ; (d) đẩy qua luồng đăng/schedule chạy bình thường.
- Build: `tsc -p tsconfig.electron.json` exit 0, renderer tsc 0, jest liên quan pass.
- UI: desktop + mobile width, dark/light, không tràn ngang, không chồng chữ.

## 7. Rủi ro & trần
- **Chất lượng ảnh edit** phụ thuộc `cx/gpt-5.5-image` — ẩn số, verify ở spike. Chữ tiếng Việt dày trên thiệp vẫn
  có thể sai → trần: anh review + regen; fallback HTML-template→screenshot để sau nếu cần.
- **Hợp đồng ahvchat image** chưa biết chắc → spike trước khi code `generateImage`.
- **Chi phí/token**: mỗi lần gen ảnh tốn phí ahvchat — chỉ gen khi anh bấm, không tự động.

## 8. Non-goals (YAGNI)
- Không auto-đăng không duyệt. Không gen hàng loạt. Không thêm provider mới (chỉ ahvchat).
- Không build HTML-template-card renderer trong v1 (chỉ fallback cân nhắc nếu spike thất bại).
- Không bảng DB mới cho template (dùng app_settings + thư mục file).
- Không sửa pipeline schedule/publish.

## 9. Rollout
dev (test) → build artifact → deploy theo workflow. Không tự push/release. Changelog + version khi anh duyệt.
