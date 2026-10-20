# Kế hoạch: Sản xuất video bán hàng (26.25 + maihub-render 1.0.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dịch vụ `maihub-render` (Docker: Caddy + api + worker cắt mạng, HyperFrames 0.8.181) render video bán hàng từ 3 mẫu hoặc từ HTML tự viết. MaiHub có mục Video, thư viện video, dùng video trong Soạn bài và Control API `videos.*`.

**Architecture:**
- **Máy chủ** (`services/maihub-render/`, TypeScript, `package.json` riêng):
  - các module thuần: khoá, giới hạn, loại tệp, kiểm `spec`, mẫu;
  - `JobStore` + `Queue` + `Handoff` (giao việc cho `worker` qua thư mục dùng chung);
  - HTTP API;
  - `worker` (gọi CLI HyperFrames);
  - Docker Compose.
- **MaiHub:**
  - `RenderClient` (HTTP);
  - `VideoService` (gửi việc, theo dõi, tải kết quả, đưa vào hộp thư `/v1/media`), bảng `video_jobs`;
  - IPC, Control API, bridge, UI.

**Tech Stack:**
- Máy chủ: Node 22, TypeScript, `busboy` (multipart, phụ thuộc mới **chỉ** của `maihub-render`), Jest, Docker Compose, Caddy 2, HyperFrames 0.8.181, GSAP 3.14.2, FFmpeg.
- MaiHub: Electron 41, React 18, better-sqlite3.

**Spec:** `docs/specs/2026-10-20-video-studio.md` (đã duyệt). Spike: `docs/reports/2026-10-20-hyperframes-spike.md`.

## Global Constraints

- **Phiên bản ghim:** `hyperframes@0.8.181`, `gsap@3.14.2`; image `node:22-bookworm-slim`, `caddy:2`.
- **Biến môi trường worker:** `HYPERFRAMES_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`, `HYPERFRAMES_SKIP_SKILLS=1`, `HYPERFRAMES_BROWSER_PATH` (Chrome cài ở `/opt/hf`).
- **Worker** chạy `network_mode: none`, root filesystem chỉ đọc, tmpfs `/tmp`, user không root, giới hạn 4 CPU / 3 GB. Chỉ gắn `/shared/current` (đọc) và `/shared/out` (ghi). **Không** gắn `/data`, không có `.env`.
- **API không gắn Docker socket.**
- **Giới hạn** (spec §3):
  - video ≤ 120 giây; khổ ≤ 1080×1920 hoặc 1920×1080; fps 24 / 30;
  - ≤ 20 ảnh; ảnh hoặc video nguồn ≤ 20 MB; nhạc ≤ 15 MB; tổng ≤ 200 MB; HTML ≤ 512 KB;
  - render ≤ 15 phút;
  - hàng đợi ≤ 20 việc chung, ≤ 5 việc đang chờ mỗi khoá; tạo việc ≤ 30 lần mỗi giờ mỗi khoá;
  - giữ việc 7 ngày.
- **Loại tệp** theo chữ ký nội dung: JPEG / PNG / WebP / MP3 / M4A / WAV / MP4. `api` đặt lại tên tệp.
- **Khoá:**
  - `.env` có `RENDER_API_KEYS={"<tên>":"<sha256 hex>"}`;
  - khoá gốc 32 byte ngẫu nhiên (base64url), tạo bằng `npm run keygen -- <tên>`;
  - so sánh bằng `crypto.timingSafeEqual`;
  - mỗi khoá chỉ thấy việc của mình (không phải của mình thì trả 404, không lộ là có tồn tại).
- **Khổ:** `9:16` = 1080×1920, `1:1` = 1080×1080, `16:9` = 1920×1080.
- **Control API (MaiHub):** chỉ thêm, 42 → 47; **không** thêm mã lỗi mới. Ánh xạ theo spec §6.5: chưa cấu hình → `INVALID_PARAMS`; HTTP 429 → `LIMIT_REACHED`; không kết nối được → `INTERNAL`.
- **Mã nguồn `services/` không đi vào app:** loại khỏi `tsconfig.json`, `tsconfig.electron*.json`, Jest gốc và cấu hình `build.files` của electron-builder.
- **Định danh** tiếng Anh; chữ hiển thị, log và docs tiếng Việt.
- **Lệnh chạy:**
  - MaiHub:
    - jest: `npx jest --runInBand <paths>`; không chạy `rebuild:native` / `prebuild-install`;
    - tsc: `node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit`, rồi `-p tsconfig.json`, **lần lượt**.
  - Máy chủ: `cd services/maihub-render && npm test` (jest riêng) và `npm run typecheck`.
  - `node scripts/check-docs.js` sạch.
- **Không được làm:** chạy Docker build/compose (controller làm ở bước kiểm tra tích hợp), triển khai lên VPS nào.
- **Tài liệu:**
  - `SYSTEM_DOCUMENTATION.md`, `docs/protocol/maihub-control-protocol.md` và README của bridge cập nhật cùng commit với thay đổi hành vi của MaiHub;
  - `services/maihub-render/README.md` (vận hành, triển khai).
- **Git:**
  - `git add` đúng đường dẫn;
  - commit kết thúc bằng dòng trống + `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`;
  - không xoá, di chuyển hay clone lại repo.

## Review Focus

1. **HTML "xấu" của bot thoát khu cách ly** (gọi mạng, đọc tệp việc khác, đọc khoá): `worker` chỉ thấy việc hiện tại, không mạng, không bí mật. → Task 2, 4, 6.
2. **Tệp giả mạo hoặc quá lớn** (đuôi `.jpg` nhưng là tệp thực thi, tên tệp có `../`, upload 2 GB): bị chặn **trong lúc** nhận, không ghi đầy đĩa. → Task 1, 3.
3. **`api` và `worker` lệch trạng thái** (worker chết giữa chừng, `api` khởi động lại khi đang render, huỷ đúng lúc render xong): không treo hàng đợi mãi; việc nhận trạng thái `failed` / `cancelled` rõ ràng. → Task 2, 4.
4. **MaiHub mất liên lạc máy chủ hoặc bị tắt giữa chừng:** mở lại vẫn theo dõi tiếp; quá 30 phút thì `failed`; không tải trùng; không làm treo giao diện. → Task 7.
5. **Mã nguồn máy chủ lọt vào bản build MaiHub, hoặc test máy chủ chạy trong Jest gốc** (làm hỏng CI): phải loại trừ. → Task 1.

---

### Task 1: Khung `maihub-render` và module thuần

**Files:**
- Create: `services/maihub-render/{package.json,tsconfig.json,jest.config.js,.gitignore}`, `services/maihub-render/src/{keys.ts,limits.ts,fileTypes.ts,spec.ts,templates.ts}`, `services/maihub-render/scripts/keygen.ts`, `services/maihub-render/test/*.test.ts`
- Modify (loại trừ): `tsconfig.json`, `tsconfig.electron.json`, `tsconfig.electron.prod.json` (nếu cần), `jest.config.js` (gốc), `package.json` gốc (`build.files` của electron-builder)

**Interfaces:**
- **`keys.ts`:**
  - `hashKey(raw): string` (sha256 hex);
  - `parseKeys(envJson): Map<name, hash>` (lỗi → ném);
  - `verifyKey(raw, keys): string | null` (trả tên MaiHub, `timingSafeEqual`);
  - `generateKey(): { raw, hash }`.
- **`limits.ts`:** hằng số theo Global Constraints, `ASPECTS = { '9:16': [1080,1920], '1:1': [1080,1080], '16:9': [1920,1080] }`.
- **`fileTypes.ts`:** `sniff(buf: Buffer): 'jpg' | 'png' | 'webp' | 'mp3' | 'm4a' | 'wav' | 'mp4' | null` (đọc ≤ 64 byte đầu), `KIND_OF` (`image` / `audio` / `video`).
- **`templates.ts`:** `loadTemplates(dir): TemplateDef[]`; kiểm `template.json` (id khớp tên thư mục, `aspects`, `imageSlots`, `variables` có `type` / `label` / `default`); `TemplateDef` theo spec §5.
- **`spec.ts`:** `validateJobSpec(raw, templates, files: { name, kind, size }[]): NormalizedSpec` (ném `SpecError` với câu tiếng Việt). Kiểm:
  - mẫu tồn tại, khổ hỗ trợ, số ảnh trong `imageSlots`, mọi `images[]` / `musicFile` có trong `files`;
  - biến đúng kiểu, `maxLength`, màu dạng `#rrggbb`;
  - `musicId` có trong danh sách nhạc;
  - HTML ≤ 512 KB, có `data-composition-id` và `data-duration` ≤ 120;
  - `width` / `height` / fps hợp lệ.

- [ ] **Step 1:** Viết test cho từng module (khoá đúng / sai / độ dài khác; chữ ký từng loại tệp và tệp giả; `template.json` hỏng; mọi nhánh của `validateJobSpec`). Chạy `cd services/maihub-render && npm test` → FAIL.
- [ ] **Step 2:** Viết code. `npm test` → PASS; `npm run typecheck` sạch.
- [ ] **Step 3:** Loại `services/` khỏi tsconfig / Jest / electron-builder của MaiHub. Chạy 2 lệnh tsc gốc và `npx jest --runInBand src/__tests__/control` (đảm bảo Jest gốc không quét `services/`).
- [ ] **Step 4:** Commit `feat(render): render service skeleton with keys, limits, file sniffing and spec validation`.

### Task 2: Kho việc, hàng đợi và giao việc cho worker

**Files:**
- Create: `services/maihub-render/src/{jobStore.ts,queue.ts,handoff.ts,retention.ts}`, test tương ứng

**Interfaces:**
- **`JobStore(dataDir)`:**
  - mỗi việc là `/data/jobs/<id>/job.json` (`{ id, owner, status, progress, position?, error?, spec, createdAt, startedAt?, finishedAt?, durationSec?, sizeBytes? }`) kèm `input/` và `output/{video.mp4,thumb.jpg}`;
  - ghi nguyên tử (tệp tạm + rename);
  - nạp lại khi khởi động: việc đang `rendering` → `failed: 'Máy chủ khởi động lại khi đang render'`.
- **`Queue`:**
  - FIFO, một việc chạy mỗi lúc;
  - `enqueue(job)` ném `LimitError` khi quá 20 việc chung / 5 việc mỗi khoá / 30 lần mỗi giờ;
  - `positionOf(id)`, `cancel(id)`, `next()`.
- **`Handoff(sharedDir, now)`:**
  - `start(job, inputDir, workdirFiles)`: xoá sạch `current/` và `out/`, chép tệp, ghi `job.json` **cuối cùng**;
  - `poll(): { state: 'idle' | 'running' | 'done', progress?, result? }` (đọc `out/progress.json`, `out/result.json`);
  - `cancel()`: ghi `current/cancel`;
  - `collect(destDir)`: chuyển `out/video.mp4`, `out/thumb.jpg`, rồi xoá sạch `current/` và `out/`;
  - worker không phản hồi (không có `progress.json` sau 60 giây, hoặc quá 15 phút) → coi là `failed` và dọn.
- **`Retention`:** xoá việc quá 7 ngày; trả số việc đã xoá.

- [ ] **Step 1:** Viết test (thư mục tạm, đồng hồ giả, worker giả ghi tệp):
  - thứ tự FIFO;
  - giới hạn;
  - huỷ khi chờ / khi chạy;
  - nạp lại sau khởi động;
  - worker im lặng → `failed`;
  - `collect` dọn sạch;
  - retention;
  - `start` không để lại tệp của việc trước.

  FAIL.
- [ ] **Step 2:** Viết code → PASS, typecheck sạch.
- [ ] **Step 3:** Commit `feat(render): job store, queue and worker handoff`.

### Task 3: HTTP API

**Files:**
- Create: `services/maihub-render/src/{server.ts,routes.ts,multipart.ts,main-api.ts}`, test
- Modify: `services/maihub-render/package.json` (thêm `busboy`)

**Interfaces:** đúng spec §4.
- **`multipart.ts`:** nhận bằng `busboy`, giới hạn số tệp và dung lượng **khi đang nhận** (quá thì huỷ và xoá phần đã ghi), đoán loại bằng `sniff`, đặt lại tên tệp.
- **Định dạng lỗi:** `{ error: { code, message } }`, với `401 UNAUTHORIZED`, `400 INVALID_SPEC`, `413 TOO_LARGE`, `415 UNSUPPORTED_FILE`, `429 LIMIT_REACHED`, `404 NOT_FOUND`.
- **`main-api.ts`:**
  - đọc `.env` (`RENDER_API_KEYS`, `DATA_DIR`, `SHARED_DIR`, `PORT`);
  - vòng điều phối: hàng đợi → `Handoff` → cập nhật `JobStore`;
  - retention mỗi giờ.

- [ ] **Step 1:** Viết test (server cổng ngẫu nhiên, worker giả):
  - xác thực;
  - tạo việc mẫu / HTML;
  - tệp giả, tên `../`, quá cỡ khi đang nhận;
  - xem trạng thái / video / bìa;
  - người khác gọi → 404;
  - huỷ;
  - 429;
  - `/v1/templates`, `/v1/health`.

  FAIL.
- [ ] **Step 2:** Viết code → PASS.
- [ ] **Step 3:** Commit `feat(render): HTTP API with auth, multipart limits and job routes`.

### Task 4: Worker

**Files:**
- Create: `services/maihub-render/src/{worker.ts,buildWorkdir.ts,music.ts,renderRunner.ts,main-worker.ts}`, test

**Interfaces:**
- **`buildWorkdir(job, templatesDir, musicDir, tmp)`:**
  - **mẫu:** chép thư mục mẫu, đặt ảnh vào `assets/`, ghi `variables.json` (biến + `images` + kích thước);
  - **HTML:** ghi `index.html` và tài nguyên.
  - Trả `{ dir, width, height }`.
- **`music.ts`:** `prepareMusic(src, durationSec, out)` gọi FFmpeg: lặp hoặc cắt theo thời lượng, fade 1 giây đầu và cuối, ra M4A. Mẫu đọc `assets/music.m4a` nếu có.
- **`renderRunner.ts`:**
  - chạy `hyperframes render <dir> -o <out> --variables-file variables.json --fps <n> --quality <q> --workers 2` trong tiến trình con;
  - đọc tiến độ từ stdout (nếu CLI không in phần trăm thì ước theo số khung đã ghi, ghi rõ trong báo cáo);
  - giới hạn 15 phút; huỷ thì `SIGTERM` rồi `SIGKILL`;
  - xong thì tạo `thumb.jpg` bằng FFmpeg (khung giữa video) và đọc thời lượng bằng ffprobe.
- **`worker.ts`:** vòng lặp đọc `/shared/current/job.json`, gọi các bước trên, ghi `progress.json` / `result.json`, xử lý tệp `cancel`, dọn thư mục tạm.
- **Lệnh và đường dẫn** đều tiêm vào được để test chạy bằng lệnh giả (không cần HyperFrames thật).

- [ ] **Step 1:** Viết test với lệnh giả: workdir cho mẫu / HTML; biến; nhạc (FFmpeg thật nếu máy có, không thì bỏ qua có ghi chú); tiến độ; timeout; huỷ; lỗi render → `result.json` `ok: false`. FAIL.
- [ ] **Step 2:** Viết code → PASS.
- [ ] **Step 3:** Commit `feat(render): worker builds workdirs, mixes music and runs HyperFrames`.

### Task 5: Ba mẫu và nhạc

**Files:**
- Create: `services/maihub-render/templates/{product-slideshow,flash-sale,product-spotlight}/{index.html,template.json}`, `services/maihub-render/vendor/gsap.min.js` (3.14.2), `services/maihub-render/music/{manifest.json,*.mp3}`, test `test/templates.test.ts`

**Interfaces:**
- **Mẫu theo spec §5:**
  - bố cục co giãn theo khổ;
  - chữ tự thu nhỏ khi dài;
  - đọc biến qua `window.__hyperframes.getVariables()`;
  - `data-duration` tính theo số ảnh (`product-slideshow`) hoặc biến thời lượng.
- **Nhạc:** 5 bản từ FreePD.com (CC0). `manifest.json`: `[{ id, name, file, durationSec, license: 'CC0', source: '<url bài trên FreePD>', author }]`. **Implementer chọn và tải 5 bản, ghi đúng URL nguồn**; tải không được thì ghi `BLOCKED` và báo controller.

- [ ] **Step 1:** Test: mỗi `template.json` hợp lệ với `loadTemplates`; biến trong `template.json` khớp `data-composition-variables` của `index.html`; mỗi khổ khai báo được hỗ trợ; manifest nhạc có đủ trường, tệp tồn tại, `license = CC0`. FAIL.
- [ ] **Step 2:** Viết mẫu; chạy thử bằng `npx hyperframes@0.8.181 render` trên máy (ngoài Docker) cho 3 mẫu × 3 khổ với dữ liệu mẫu, xem 1 khung mỗi video. Ghi thời gian vào báo cáo; **không** commit video ra.
- [ ] **Step 3:** Commit `feat(render): product slideshow, flash sale and spotlight templates with CC0 music`.

### Task 6: Docker Compose và vận hành

**Files:**
- Create: `services/maihub-render/{Dockerfile.api,Dockerfile.worker,docker-compose.yml,Caddyfile,.env.example,README.md}`, `services/maihub-render/scripts/smoke.sh`

**Interfaces:**
- Compose theo spec §2 / §3:
  - `worker` có `network_mode: none`, `read_only: true`, tmpfs `/tmp`, `cpus: 4`, `mem_limit: 3g`, `user: node`, chỉ gắn `shared/current:ro` và `shared/out`;
  - `api` gắn `data/` và `shared/`, không gắn Docker socket;
  - `caddy` với `{$RENDER_DOMAIN}` (mặc định `render-<ip-gạch>.sslip.io`).
- **README:**
  - yêu cầu VPS (≥ 4 CPU / 8 GB);
  - cài Docker, tạo `.env`, `npm run keygen`, `docker compose up -d`, cập nhật / ghim phiên bản, sao lưu, xem log, xoay khoá;
  - mục **An toàn** (cách ly, giới hạn).
- **`smoke.sh`:** gọi API thật (`curl`) tạo 1 video mẫu và 1 HTML "xấu", tải kết quả.

- [ ] **Step 1:** Viết các tệp. Không chạy Docker (controller chạy ở Task 10).
- [ ] **Step 2:** Commit `feat(render): docker compose with isolated worker, Caddy TLS and ops guide`.

### Task 7: MaiHub — `RenderClient`, `VideoService`, dữ liệu

**Files:**
- Create: `src/services/video/{RenderClient.ts,VideoService.ts,VideoStore.ts,videoSettings.ts}`, `src/models/video.ts`
- Modify: `src/services/control/InboxMediaStore.ts` (`adopt(filePath): SavedMedia`, chép tệp vào hộp thư, tôn trọng giới hạn), DB schema / migration nơi các bảng app được tạo (theo mẫu `fb_poster_*`)
- Test: `src/__tests__/video/*.test.ts`, thêm test `InboxMediaStore.adopt`

**Interfaces:**
- **`RenderClient(baseUrl, apiKey, fetchImpl?)`:**
  - `health()`, `templates()`;
  - `createJob(spec, files: { path, name }[])` (multipart, stream từ đĩa);
  - `job(id)`, `download(id, kind: 'video' | 'thumb', dest)`, `cancel(id)`;
  - lỗi được phân loại `{ code: 'unconfigured' | 'unreachable' | 'limit' | 'invalid' | 'not_found' | 'server', message }`.
- **`videoSettings.ts`:** đọc / ghi `{ url, apiKey }` với khoá mã hoá theo mẫu `enc:` + `safeStorage` có sẵn (`AIAssistantService`); `maskKey` (4 ký tự cuối).
- **`VideoStore`:** bảng `video_jobs` theo spec §6.2 (CRUD, `listActive`).
- **`VideoService(deps: { store, client(), mediaInbox, emit, now, setTimer, clearTimer, videosDir })`:**
  - `render(input: { name, source, template? | html?, files })`;
  - `startPolling()` (3 giây, chỉ khi có việc dở), `stop()`;
  - `cancel(id)`, `delete(id)` (xoá tệp);
  - `list`, `get`;
  - mất liên lạc > 30 phút → `failed`;
  - xong → tải video và bìa (một lần), với `source = 'bot'` thì `adopt` vào hộp thư và gửi `mediaId` trong sự kiện;
  - `emit('videos:changed')` và `emit('videos.finished', ...)`.

- [ ] **Step 1:** Viết test với máy chủ HTTP giả (Node `http`, cổng ngẫu nhiên):
  - tải lên;
  - các trạng thái;
  - xong → tải về một lần;
  - mở lại (khởi tạo service mới từ store) → theo dõi tiếp;
  - mất liên lạc → `failed` sau 30 phút (đồng hồ giả);
  - huỷ; xoá tệp;
  - `adopt`;
  - lỗi được phân loại;
  - khoá không bao giờ xuất hiện trong log hay lỗi.

  FAIL.
- [ ] **Step 2:** Viết code → PASS; 2 lệnh tsc.
- [ ] **Step 3:** Commit `feat(video): render client, video jobs and media adoption`.

### Task 8: MaiHub — IPC, Control API, bridge và tài liệu

**Files:**
- Create: `electron/ipc/videoIpc.ts` (đăng ký trong `electron/main.ts` theo mẫu các ipc khác)
- Modify: `electron/preload.ts`, `src/ui/lib/ipc.ts`, `src/__tests__/http/relayChannelPolicy.test.ts`, `src/services/control/{ControlMethods.ts,controlEvents.ts}`, `electron/ipc/controlApiIpc.ts`, `tools/maihub-bridge/maihub_bridge.py` (+ test)
- Docs: `SYSTEM_DOCUMENTATION.md` (47 thao tác, video), `docs/protocol/maihub-control-protocol.md`, `tools/maihub-bridge/README.md`

**Interfaces:**
- **`videoOperations`** (dùng chung cho IPC và Control API, kiểm tham số tại đây):
  - `settingsGet`, `settingsSet`, `testConnection`, `templates`;
  - `render` (app: đường dẫn tệp; bot: `imageIds` / `musicMediaId` / `assetIds` → `InboxMediaStore.resolve`);
  - `status`, `list`, `cancel`, `delete`, `exportFile` (hộp lưu tệp).
- **IPC** `video:*` chỉ dành cho Boss. Sự kiện renderer `video:changed`.
- **Control API:**
  - `videos.templates`, `videos.render`, `videos.status`, `videos.list`, `videos.cancel` (spec §6.5);
  - sự kiện `videos.finished`;
  - ánh xạ lỗi theo Global Constraints.
- **Bridge:**
  - `"🎬 Video xong: <tên> (<giây>s)"`;
  - `"⚠️ Video lỗi: <tên> — <lỗi cắt 120 ký tự>"`.
- **Khởi động / tắt:** `VideoService.startPolling` khi app sẵn sàng; dừng khi thoát.

- [ ] **Step 1:** Viết test:
  - wiring;
  - describe thêm 5 thao tác (đổi đúng danh sách kỳ vọng, ghi trong báo cáo);
  - kiểm tham số;
  - ánh xạ lỗi;
  - payload sự kiện;
  - bridge.

  FAIL.
- [ ] **Step 2:** Viết code + docs. Chạy: 2 lệnh tsc, jest `src/__tests__/video src/__tests__/control src/__tests__/http`, unittest bridge, `check-docs`.
- [ ] **Step 3:** Commit `feat(video): IPC, control methods and Telegram video alerts`.

### Task 9: MaiHub — giao diện

**Files:**
- Create: `src/ui/features/facebookPoster/VideoTab.tsx`, `VideoTemplateForm.tsx`, `VideoLibrary.tsx`, `videoFormat.ts` (+ test), mục cài đặt máy chủ render (đặt cạnh cài đặt AI có sẵn trong `src/ui/components/settings/`)
- Modify: `FacebookPosterView.tsx` (mục "Video"; `PostTab` nhận `initialMediaPaths` để "Dùng trong Soạn bài"), `Sidebar.tsx`, `appStore.ts`

**Interfaces:**
- Theo spec §6.4:
  - form sinh từ `template.json`;
  - ảnh chọn nhiều + kéo đổi thứ tự (dùng lại `MediaPicker` nếu được);
  - nhạc: không / có sẵn (nghe thử) / tải lên;
  - thư viện có tiến độ;
  - trình phát dùng `local-media://` có sẵn;
  - Dùng trong Soạn bài, Tải về, Huỷ, Xoá (xác nhận).
- Chưa cấu hình → hướng dẫn kèm nút mở cài đặt.
- **Yêu cầu chung:** async an toàn; sáng / tối; 390 px không tràn; a11y; chữ tiếng Việt.

- [ ] **Step 1:** Test `videoFormat` (trạng thái, thời lượng, dung lượng, kiểm form theo `template.json`) → FAIL → viết → PASS.
- [ ] **Step 2:** Viết component; 2 lệnh tsc; jest liên quan. Không chạy app.
- [ ] **Step 3:** Commit `feat(video): video tab, template form, library and render server settings`.

### Task 10 (controller): Kiểm chứng và phát hành

- [ ] **Step 1:** Review toàn nhánh bằng Opus (không chạy cùng app hay Docker). Một lượt sửa, một re-review.
- [ ] **Step 2:** Kiểm tra tích hợp trên máy dev:
  - `docker compose up` (build dùng `--network host` nếu DNS của máy dev lỗi);
  - khoá thử;
  - `smoke.sh`: 3 mẫu × khổ 9:16 + HTML "xấu" (như spike);
  - đo thời gian.
- [ ] **Step 3:** Hai vòng stress:
  - toàn bộ jest gốc, 2 lệnh tsc, `npm test` của máy chủ, unittest bridge, `check-docs`;
  - app dev nối vào máy chủ chạy local: tạo video từ mẫu, thư viện, Dùng trong Soạn bài (**không** đăng thật), 1280 / 390, sáng / tối;
  - hồi quy các mục Đăng Facebook.
- [ ] **Step 4:**
  - MaiHub 26.25.0: version, changelog, dòng phiên bản tài liệu;
  - spec ghi "Đã phát hành" + ghi chú sau phát hành;
  - plan thêm "Điều chỉnh khi triển khai";
  - merge `main`, tag `v26.25.0`; anh push; kiểm tra CI.
- [ ] **Step 5:** Triển khai `maihub-render` lên VPS: **chỉ khi anh duyệt và cấp SSH**, theo README.
