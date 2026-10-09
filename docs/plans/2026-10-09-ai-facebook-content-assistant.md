# AI Facebook Content Assistant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trợ Lý AI viết/trau chuốt content bài Facebook theo giọng brand + gen ảnh (edit-từ-template cho thiệp tuyển dụng, gen tự do cho ảnh minh hoạ) ngay trong Facebook Poster.

**Architecture:** Tái dùng `AIAssistantService` (đa provider, ahvchat) cho text qua IPC `ai:chat` sẵn có. Thêm MỚI: `generateImage()` gọi ahvchat `cx/gpt-5.5-image`, lưu qua `FileStorageService.saveBuffer`→`toRelativePath`, append vào `media[]` của PostTab. Template thiệp lưu trong `app_settings` (JSON catalog) + thư mục file. Pipeline schedule/publish giữ nguyên.

**Tech Stack:** TypeScript, Electron IPC, React, axios, better-sqlite3, jest.

**Spec:** `docs/specs/2026-10-09-ai-facebook-content-assistant.md`

## Global Constraints

- Code identifiers English-only; copy/UI tiếng Việt OK.
- Provider DUY NHẤT: `ahvchat` (OpenAI-compatible, `https://auto.ahvchat.com/v1/...`). Model ảnh: `cx/gpt-5.5-image`. Key lấy từ assistant đã cấu hình (giải mã qua `getAssistant`).
- Con người trong vòng lặp: text + ảnh AI luôn sửa/xoá được trước khi đăng. KHÔNG auto-đăng.
- Ảnh lưu dạng **relative path** (`toRelativePath(absPath)`) để khớp `mediaPaths` của poster. `MediaItem = { path: string; size: number }`, `size` phải thật (validateMediaSelection chặn >20MB/ảnh, >100MB tổng).
- Không thêm bảng DB mới (template dùng `app_settings`). Không đụng pipeline schedule/publish.
- Build: `npx tsc -p tsconfig.electron.json --noEmit` exit 0, `npx tsc --noEmit -p tsconfig.json` exit 0. Không tự push/release.

## Review Focus

- **ahvchat trả shape lạ** (không phải OpenAI images): parse fail → `generateImage` throw rõ, UI báo lỗi, KHÔNG append rác vào media → test Task 3 (parse trả null/throw) + Task 4.
- **Ảnh gen quá lớn (>20MB)**: `MediaItem.size` làm `validateMediaSelection` reject → Task 7 cảnh báo thay vì thêm im lặng (test size trong Task 5/7).
- **Chưa có assistant ahvchat**: UI nhắc cấu hình, không crash → Task 7.
- **Brief/nháp rỗng**: nút Viết/Trau chuốt chặn + báo → Task 2 (builder throw/empty) + Task 7.
- **Employee mode**: gen ảnh chưa hỗ trợ (cần Boss) → trả error rõ, không treo → Task 6.

---

### Task 1: Spike — chốt hợp đồng ahvchat `cx/gpt-5.5-image`

**Files:** none (throwaway harness trong scratchpad). Kết quả ghi vào ledger.

**Mục tiêu:** xác định ĐÚNG cách gọi ảnh qua ahvchat, vì nó quyết định code Task 3/4.

- [ ] **Step 1: Lấy key ahvchat** từ assistant đã cấu hình. Chạy harness electron-as-node:
```js
// scratchpad/spikeImg.js
const { AIAssistantService } = require('/home/maiychrus/deplao-builder/dist-electron/src/services/ai/AIAssistantService');
// cần build:electron trước. getAssistant trả { platform, apiKey (đã giải mã), baseUrl, model }
const svc = AIAssistantService.getInstance();
const a = svc.listAssistants().find(x => x.platform === 'ahvchat');
console.log('assistant', a && { id: a.id, platform: a.platform, hasKey: !!a.apiKey, baseUrl: a.baseUrl });
```
  (Nếu DB cần init: gọi `DatabaseService.getInstance().initialize(userDataPath)` trước — xem cách main.ts init.)

- [ ] **Step 2: Thử endpoint images (OpenAI-compatible)** với key đó, model `cx/gpt-5.5-image`:
```js
const axios = require('/home/maiychrus/deplao-builder/node_modules/axios');
// A) generations (text→image)
await axios.post('https://auto.ahvchat.com/v1/images/generations',
  { model: 'cx/gpt-5.5-image', prompt: 'a simple blue circle on white', size: '1024x1024' },
  { headers: { Authorization: `Bearer ${KEY}` }, timeout: 120000 });
// ghi lại: status, Object.keys(res.data), data[0] có b64_json hay url?
```

- [ ] **Step 3: Thử edit (image→image)** — gửi 1 ảnh base (template td3_mau.jpg trong scratchpad/refimg) + prompt sửa. Thử 2 cách:
  (a) `POST /v1/images/edits` multipart (image + prompt + model);
  (b) `POST /v1/chat/completions` body `{ model:'cx/gpt-5.5-image', messages:[{role:'user', content:[{type:'text',text:'...'},{type:'image_url',image_url:{url:'data:image/jpeg;base64,...'}}]}] }` và xem response có trả ảnh (base64/url) không.
  Ghi lại cách nào chạy + shape response + CHẤT LƯỢNG (lưu ảnh ra xem, so với ảnh mẫu).

- [ ] **Step 4: Ghi ledger** contract đã chốt: endpoint(s) cho gen vs edit, field response chứa ảnh (b64_json/url/base64 trong chat), và kết luận chất lượng edit-từ-template (đạt/không). Nếu edit chất lượng quá tệ → ghi khuyến nghị fallback HTML→screenshot (Task phụ, chỉ làm nếu anh chốt).

- [ ] **Step 5: Commit** (chỉ ledger, không code sản phẩm). Không commit harness (scratchpad).

---

### Task 2: Pure prompt builders (viết / trau chuốt)

**Files:**
- Create: `src/services/ai/fbContentPrompt.ts`
- Test: `src/__tests__/ai/fbContentPrompt.test.ts`

**Interfaces:**
- Produces: `buildWriteMessages(brief: string): {role:string;content:string}[]`, `buildPolishMessages(draft: string): {role:string;content:string}[]`. Cả hai throw `Error('empty')` nếu input rỗng/trắng.

- [ ] **Step 1: Test failing**
```ts
import { buildWriteMessages, buildPolishMessages } from '../../services/ai/fbContentPrompt';
describe('fbContentPrompt', () => {
  it('write: gói brief thành user message, có yêu cầu giữ giọng brand', () => {
    const m = buildWriteMessages('tuyển Junior UA, 12-18M, HN');
    expect(m).toHaveLength(1);
    expect(m[0].role).toBe('user');
    expect(m[0].content).toContain('tuyển Junior UA, 12-18M, HN');
    expect(m[0].content.toLowerCase()).toContain('giọng');
  });
  it('polish: gói nháp + yêu cầu viết lại giữ ý', () => {
    const m = buildPolishMessages('cần tuyển ke toan');
    expect(m[0].content).toContain('cần tuyển ke toan');
    expect(m[0].content.toLowerCase()).toContain('viết lại');
  });
  it('rỗng → throw', () => {
    expect(() => buildWriteMessages('  ')).toThrow('empty');
    expect(() => buildPolishMessages('')).toThrow('empty');
  });
});
```

- [ ] **Step 2: Chạy → fail** `npx jest src/__tests__/ai/fbContentPrompt.test.ts` → FAIL (module chưa có).

- [ ] **Step 3: Implement**
```ts
// Giọng brand nằm ở assistant.systemPrompt (cấu hình riêng). Hàm này chỉ gói USER message.
export function buildWriteMessages(brief: string): { role: string; content: string }[] {
  const b = (brief || '').trim();
  if (!b) throw new Error('empty');
  return [{ role: 'user', content:
`Viết một bài đăng Facebook hoàn chỉnh theo ĐÚNG giọng và cấu trúc brand (tiêu đề in hoa, emoji, bullet, hashtag, thông tin liên hệ) dựa trên brief sau:

${b}

Chỉ trả về nội dung bài đăng, không giải thích.` }];
}

export function buildPolishMessages(draft: string): { role: string; content: string }[] {
  const d = (draft || '').trim();
  if (!d) throw new Error('empty');
  return [{ role: 'user', content:
`Viết lại bài đăng dưới đây theo ĐÚNG giọng và cấu trúc brand, giữ nguyên ý và thông tin, chuẩn hoá emoji/hashtag/liên hệ. Chỉ trả về nội dung đã viết lại:

${d}` }];
}
```

- [ ] **Step 4: Chạy → pass**.
- [ ] **Step 5: Commit** `git add src/services/ai/fbContentPrompt.ts src/__tests__/ai/fbContentPrompt.test.ts && git commit -m "feat(ai): prompt builders for FB content write/polish"`

---

### Task 3: Image request/response helpers (theo contract Task 1)

**Files:**
- Create: `src/services/ai/aiImage.ts`
- Test: `src/__tests__/ai/aiImage.test.ts`

**Interfaces:**
- Consumes: contract từ Task 1 (ledger).
- Produces:
  - `buildImageRequest(opts: { apiKey: string; model: string; prompt: string; baseImages?: string[]; size?: string }): { url: string; headers: Record<string,string>; body: any }`
  - `parseImageResponse(data: any): Buffer` — trích ảnh (b64_json/url→không, chỉ b64 ở đây) thành Buffer; throw `Error('no image in response')` nếu không có.

> Code dưới viết theo shape OpenAI images (ahvchat OpenAI-compatible) — shape MẶC ĐỊNH. **Nếu Task 1 chốt là chat-multimodal**, chỉnh `buildImageRequest`/`parseImageResponse` theo ledger (ruling), giữ nguyên chữ ký hàm.

- [ ] **Step 1: Test failing**
```ts
import { buildImageRequest, parseImageResponse } from '../../services/ai/aiImage';
describe('aiImage', () => {
  it('gen mode (không base): endpoint generations', () => {
    const r = buildImageRequest({ apiKey: 'k', model: 'cx/gpt-5.5-image', prompt: 'p', size: '1024x1536' });
    expect(r.url).toContain('/v1/images/generations');
    expect(r.headers.Authorization).toBe('Bearer k');
    expect(r.body.model).toBe('cx/gpt-5.5-image');
    expect(r.body.prompt).toBe('p');
    expect(r.body.size).toBe('1024x1536');
  });
  it('parse: lấy b64_json → Buffer', () => {
    const b64 = Buffer.from('hello').toString('base64');
    const buf = parseImageResponse({ data: [{ b64_json: b64 }] });
    expect(buf.toString()).toBe('hello');
  });
  it('parse: không có ảnh → throw', () => {
    expect(() => parseImageResponse({ data: [] })).toThrow('no image');
  });
});
```

- [ ] **Step 2: Chạy → fail**.

- [ ] **Step 3: Implement** (shape OpenAI images; edit mode gắn ảnh base vào body theo ledger Task 1):
```ts
import fs from 'fs';
const AHV_BASE = 'https://auto.ahvchat.com/v1';

export function buildImageRequest(opts: { apiKey: string; model: string; prompt: string; baseImages?: string[]; size?: string }) {
  const headers = { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' };
  const size = opts.size || '1024x1024';
  const hasBase = !!(opts.baseImages && opts.baseImages.length);
  if (hasBase) {
    // EDIT mode: gửi ảnh base base64 (theo contract Task 1; điều chỉnh nếu ledger khác)
    const images = opts.baseImages!.map((p) => `data:image/jpeg;base64,${fs.readFileSync(p).toString('base64')}`);
    return { url: `${AHV_BASE}/images/edits`, headers, body: { model: opts.model, prompt: opts.prompt, image: images, size } };
  }
  return { url: `${AHV_BASE}/images/generations`, headers, body: { model: opts.model, prompt: opts.prompt, size } };
}

export function parseImageResponse(data: any): Buffer {
  const b64 = data?.data?.[0]?.b64_json;
  if (b64) return Buffer.from(b64, 'base64');
  // một số gateway trả trong chat-multimodal → điều chỉnh theo ledger Task 1 nếu cần
  throw new Error('no image in response');
}
```

- [ ] **Step 4: Chạy → pass**.
- [ ] **Step 5: Commit** `git add src/services/ai/aiImage.ts src/__tests__/ai/aiImage.test.ts && git commit -m "feat(ai): ahvchat image request/response helpers"`

---

### Task 4: `AIAssistantService.generateImage`

**Files:**
- Modify: `src/services/ai/AIAssistantService.ts`
- Test: `src/__tests__/ai/generateImage.test.ts`

**Interfaces:**
- Consumes: `buildImageRequest`/`parseImageResponse` (Task 3); `getAssistant` (trả `{apiKey,baseUrl,platform,model}` đã giải mã); `FileStorageService.saveBuffer(bucket,buffer,filename)`→abs path, `toRelativePath(abs)`→rel.
- Produces: `generateImage(input: { assistantId: string; prompt: string; baseImages?: string[]; size?: string }): Promise<{ localPath: string; size: number }>`

- [ ] **Step 1: Test failing** (mock axios + FileStorageService):
```ts
jest.mock('axios');
jest.mock('../../services/file/FileStorageService', () => ({
  FileStorageService: {
    saveBuffer: jest.fn(async () => '/abs/media/x/gen_1.png'),
    toRelativePath: jest.fn((p: string) => p.replace('/abs/media/', 'media/')),
  },
}));
import axios from 'axios';
import { AIAssistantService } from '../../services/ai/AIAssistantService';
describe('generateImage', () => {
  it('gọi ahvchat, lưu buffer, trả rel path + size', async () => {
    const svc = AIAssistantService.getInstance();
    jest.spyOn(svc, 'getAssistant').mockReturnValue({ id: 'a1', platform: 'ahvchat', apiKey: 'k', baseUrl: null, model: 'cx/gpt-5.5-image' } as any);
    const b64 = Buffer.from('imgbytes').toString('base64');
    (axios.post as any).mockResolvedValue({ data: { data: [{ b64_json: b64 }] } });
    const r = await svc.generateImage({ assistantId: 'a1', prompt: 'p' });
    expect(r.localPath).toBe('media/x/gen_1.png');
    expect(r.size).toBe(Buffer.from('imgbytes').length);
    expect((axios.post as any).mock.calls[0][0]).toContain('/v1/images/generations');
  });
  it('assistant không tồn tại → throw', async () => {
    const svc = AIAssistantService.getInstance();
    jest.spyOn(svc, 'getAssistant').mockReturnValue(null as any);
    await expect(svc.generateImage({ assistantId: 'x', prompt: 'p' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Chạy → fail**.

- [ ] **Step 3: Implement** — thêm method (gần `callLLM`/`chat`), import helpers + FileStorageService:
```ts
public async generateImage(input: { assistantId: string; prompt: string; baseImages?: string[]; size?: string }): Promise<{ localPath: string; size: number }> {
  const assistant = this.getAssistant(input.assistantId);
  if (!assistant) throw new Error('Không tìm thấy trợ lý AI');
  if (!assistant.apiKey) throw new Error('Trợ lý chưa có API key');
  const { buildImageRequest, parseImageResponse } = require('./aiImage');
  const { FileStorageService } = require('../file/FileStorageService');
  const model = assistant.model || 'cx/gpt-5.5-image';
  const req = buildImageRequest({ apiKey: assistant.apiKey, model, prompt: input.prompt, baseImages: input.baseImages, size: input.size });
  Logger.info(`[AIAssistant] generateImage → ${req.url} model=${model} base=${input.baseImages?.length || 0}`);
  const res = await axios.post(req.url, req.body, { headers: req.headers, timeout: 120000 });
  const buffer: Buffer = parseImageResponse(res.data);
  const filename = `gen_${Date.now()}.png`;
  const abs = await FileStorageService.saveBuffer(`fb-poster-ai/${input.assistantId}`, buffer, filename);
  return { localPath: FileStorageService.toRelativePath(abs), size: buffer.length };
}
```

- [ ] **Step 4: Chạy → pass**; `npx tsc -p tsconfig.electron.json --noEmit` exit 0.
- [ ] **Step 5: Commit** `git add src/services/ai/AIAssistantService.ts src/__tests__/ai/generateImage.test.ts && git commit -m "feat(ai): AIAssistantService.generateImage via ahvchat"`

---

### Task 5: Template catalog (app_settings + file)

**Files:**
- Create: `src/services/facebookPoster/posterTemplates.ts`
- Test: `src/__tests__/facebookPoster/posterTemplates.test.ts`

**Interfaces:**
- Consumes: `DatabaseService.getSetting/setSetting`, `FileStorageService.saveBuffer/toRelativePath`.
- Produces: `listTemplates(db): {id:string;name:string;path:string}[]`, `addTemplate(db, fs, name, srcPath): entry`, `removeTemplate(db, id): void`. (DI: nhận db + fileStore để test không cần Electron.)

- [ ] **Step 1: Test failing**
```ts
import { listTemplates, addTemplate, removeTemplate } from '../../services/facebookPoster/posterTemplates';
const KEY = 'fb_poster_templates';
function fakeDb() { const store: any = {}; return { getSetting:(k:string)=>store[k]??null, setSetting:(k:string,v:string)=>{store[k]=v;} }; }
const fakeFs = { saveBufferSync:(name:string,src:string)=>`/abs/media/tpl/${name}`, toRelativePath:(p:string)=>p.replace('/abs/media/','media/') } as any;
describe('posterTemplates', () => {
  it('rỗng ban đầu', () => { expect(listTemplates(fakeDb())).toEqual([]); });
  it('add → list có 1, remove → rỗng', () => {
    const db = fakeDb();
    const e = addTemplate(db, fakeFs, 'Tuyển dụng', '/src/a.jpg');
    expect(e.name).toBe('Tuyển dụng'); expect(e.path).toContain('media/');
    expect(listTemplates(db)).toHaveLength(1);
    removeTemplate(db, e.id);
    expect(listTemplates(db)).toEqual([]);
  });
});
```

- [ ] **Step 2: Chạy → fail**.

- [ ] **Step 3: Implement**
```ts
import fs from 'fs';
const KEY = 'fb_poster_templates';
export interface PosterTemplate { id: string; name: string; path: string; }
type Db = { getSetting(k: string): string | null; setSetting(k: string, v: string): void };
type FileStore = { saveBufferSync(name: string, srcPath: string): string; toRelativePath(p: string): string };

export function listTemplates(db: Db): PosterTemplate[] {
  try { return JSON.parse(db.getSetting(KEY) ?? '[]'); } catch { return []; }
}
export function addTemplate(db: Db, store: FileStore, name: string, srcPath: string): PosterTemplate {
  const id = `tpl_${Date.now()}`;
  const abs = store.saveBufferSync(`${id}_${(name||'tpl').replace(/[^\w.-]+/g,'_')}.img`, srcPath);
  const entry: PosterTemplate = { id, name: name || 'Template', path: store.toRelativePath(abs) };
  db.setSetting(KEY, JSON.stringify([...listTemplates(db), entry]));
  return entry;
}
export function removeTemplate(db: Db, id: string): void {
  db.setSetting(KEY, JSON.stringify(listTemplates(db).filter((t) => t.id !== id)));
}
```
  (Nếu `FileStorageService` chưa có `saveBufferSync`, thêm 1 wrapper nhỏ đọc file nguồn rồi `saveBuffer`; hoặc dùng `saveBuffer(bucket, fs.readFileSync(src), name)` trong IPC Task 6 và truyền abs path vào. Giữ chữ ký test bằng adapter.)

- [ ] **Step 4: Chạy → pass**.
- [ ] **Step 5: Commit** `git add src/services/facebookPoster/posterTemplates.ts src/__tests__/facebookPoster/posterTemplates.test.ts && git commit -m "feat(fb-poster): sticker-card template catalog in app_settings"`

---

### Task 6: IPC + preload + ipc.ts

**Files:**
- Modify: `electron/ipc/aiAssistantIpc.ts` (add `ai:generateImage` + template handlers)
- Modify: `electron/preload.ts` (block `ai`)
- Modify: `src/ui/lib/ipc.ts` (type block `ai` + re-export)

**Interfaces:**
- Consumes: `AIAssistantService.generateImage` (Task 4); `posterTemplates` (Task 5); `DatabaseService.getInstance()`, `FileStorageService`.
- Produces: `ipc.ai.generateImage({assistantId,prompt,baseImages?,size?})`, `ipc.ai.listPosterTemplates()`, `ipc.ai.addPosterTemplate({name,filePath})`, `ipc.ai.removePosterTemplate({id})`.

- [ ] **Step 1: Handlers** trong `aiAssistantIpc.ts` (cạnh `ai:chat`, dùng `isEmployeeMode` sẵn có):
```ts
  ipcMain.handle('ai:generateImage', async (_e, { assistantId, prompt, baseImages, size }: { assistantId: string; prompt: string; baseImages?: string[]; size?: string }) => {
    try {
      if (isEmployeeMode()) return { success: false, error: 'Gen ảnh AI chưa hỗ trợ ở chế độ nhân viên' };
      const r = await AIAssistantService.getInstance().generateImage({ assistantId, prompt, baseImages, size });
      return { success: true, ...r };
    } catch (e: any) {
      Logger.error(`[AIAssistantIpc] generateImage: ${e.message}`);
      return { success: false, error: e.response?.data?.error?.message || e.message };
    }
  });

  ipcMain.handle('ai:listPosterTemplates', async () => {
    try { const { listTemplates } = require('../../src/services/facebookPoster/posterTemplates');
      return { success: true, templates: listTemplates(DatabaseService.getInstance()) }; }
    catch (e: any) { return { success: false, error: e.message, templates: [] }; }
  });
  ipcMain.handle('ai:addPosterTemplate', async (_e, { name, filePath }: { name: string; filePath: string }) => {
    try {
      if (!fs.existsSync(filePath)) return { success: false, error: 'File không tồn tại' };
      const buffer = fs.readFileSync(filePath);
      const abs = await FileStorageService.saveBuffer('fb-poster-templates', buffer, `${Date.now()}_${path.basename(filePath)}`);
      const store = { saveBufferSync: () => abs, toRelativePath: (p: string) => FileStorageService.toRelativePath(p) };
      const { addTemplate } = require('../../src/services/facebookPoster/posterTemplates');
      const entry = addTemplate(DatabaseService.getInstance(), store, name, filePath);
      return { success: true, template: entry };
    } catch (e: any) { return { success: false, error: e.message }; }
  });
  ipcMain.handle('ai:removePosterTemplate', async (_e, { id }: { id: string }) => {
    try { const { removeTemplate } = require('../../src/services/facebookPoster/posterTemplates');
      removeTemplate(DatabaseService.getInstance(), id); return { success: true }; }
    catch (e: any) { return { success: false, error: e.message }; }
  });
```
  (Đảm bảo `DatabaseService`, `FileStorageService`, `fs`, `path` đã import đầu file aiAssistantIpc.ts; thêm nếu thiếu.)

- [ ] **Step 2: preload** `electron/preload.ts` trong block `ai: {` (cạnh `chat:`):
```ts
    generateImage:       (params: { assistantId: string; prompt: string; baseImages?: string[]; size?: string }) => ipcRenderer.invoke('ai:generateImage', params),
    listPosterTemplates: () => ipcRenderer.invoke('ai:listPosterTemplates'),
    addPosterTemplate:   (name: string, filePath: string) => ipcRenderer.invoke('ai:addPosterTemplate', { name, filePath }),
    removePosterTemplate:(id: string) => ipcRenderer.invoke('ai:removePosterTemplate', { id }),
```

- [ ] **Step 3: ipc.ts** `src/ui/lib/ipc.ts` block `ai` (cạnh `chat:` ~415), thêm type:
```ts
        generateImage: (params: { assistantId: string; prompt: string; baseImages?: string[]; size?: string }) => Promise<{ success: boolean; localPath?: string; size?: number; error?: string }>;
        listPosterTemplates: () => Promise<{ success: boolean; templates?: Array<{ id: string; name: string; path: string }>; error?: string }>;
        addPosterTemplate: (name: string, filePath: string) => Promise<{ success: boolean; template?: { id: string; name: string; path: string }; error?: string }>;
        removePosterTemplate: (id: string) => Promise<{ success: boolean; error?: string }>;
```

- [ ] **Step 4: tsc** `npx tsc -p tsconfig.electron.json --noEmit` exit 0 && `npx tsc --noEmit -p tsconfig.json` exit 0.
- [ ] **Step 5: Commit** `git add electron/ipc/aiAssistantIpc.ts electron/preload.ts src/ui/lib/ipc.ts && git commit -m "feat(ai): IPC for generateImage + poster templates"`

---

### Task 7: UI — AIAssistPanel trong PostTab

**Files:**
- Create: `src/ui/features/facebookPoster/AIAssistPanel.tsx`
- Modify: `src/ui/features/facebookPoster/PostTab.tsx` (render panel; nhận setText/media/setMedia)

**Interfaces:**
- Consumes: `ipc.ai` (chat, generateImage, listAssistants, listPosterTemplates); `MediaItem` (`{path,size}`); `buildWriteMessages`/`buildPolishMessages` (Task 2) — gọi trong renderer (pure, import được).
- Produces: component `AIAssistPanel`.

- [ ] **Step 1: Component** `AIAssistPanel.tsx`:
```tsx
import React, { useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { buildWriteMessages, buildPolishMessages } from '@/services/ai/fbContentPrompt';
import type { MediaItem } from '@/services/facebookPoster/mediaRules';

export function AIAssistPanel({ text, setText, media, setMedia, disabled }: {
  text: string; setText: (v: string) => void;
  media: MediaItem[]; setMedia: (fn: (prev: MediaItem[]) => MediaItem[]) => void;
  disabled?: boolean;
}) {
  const [assistants, setAssistants] = useState<any[]>([]);
  const [assistantId, setAssistantId] = useState('');
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; path: string }>>([]);
  const [brief, setBrief] = useState('');
  const [imgPrompt, setImgPrompt] = useState('');
  const [tplId, setTplId] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => { ipc.ai?.listAssistants().then((r: any) => {
    const list = (r?.assistants || r || []).filter((a: any) => a.platform === 'ahvchat' || true);
    setAssistants(list); if (list[0]) setAssistantId(list[0].id);
  }); ipc.ai?.listPosterTemplates().then((r: any) => setTemplates(r?.templates || [])); }, []);

  const run = async (mode: 'write' | 'polish') => {
    setErr('');
    try {
      const messages = mode === 'write' ? buildWriteMessages(brief) : buildPolishMessages(text);
      setBusy(mode);
      const r = await ipc.ai?.chat(assistantId, messages);
      if (r?.success && r.result) setText(r.result); else setErr(r?.error || 'AI lỗi');
    } catch (e: any) { setErr(e.message); } finally { setBusy(''); }
  };

  const genImage = async () => {
    setErr(''); setBusy('img');
    try {
      const base = tplId ? templates.find(t => t.id === tplId) : null;
      const r = await ipc.ai?.generateImage({ assistantId, prompt: imgPrompt || text.slice(0, 500),
        baseImages: base ? [base.path] : undefined, size: base ? '1024x1536' : '1024x1024' });
      if (r?.success && r.localPath) setMedia(prev => [...prev, { path: r.localPath!, size: r.size || 0 }]);
      else setErr(r?.error || 'Gen ảnh lỗi');
    } catch (e: any) { setErr(e.message); } finally { setBusy(''); }
  };

  const d = disabled || !assistantId || !!busy;
  return (
    <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200">✨ Trợ Lý AI
        <select value={assistantId} onChange={e => setAssistantId(e.target.value)} className="ml-auto rounded border px-2 py-1 text-xs dark:bg-gray-700">
          {assistants.length === 0 && <option value="">(chưa có trợ lý — cấu hình ở mục AI)</option>}
          {assistants.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <textarea value={brief} onChange={e => setBrief(e.target.value)} placeholder="Brief ngắn (vd: tuyển Junior UA, 12-18M, HN)..."
        className="mb-2 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700" rows={2} />
      <div className="mb-2 flex flex-wrap gap-2">
        <button disabled={d || !brief.trim()} onClick={() => run('write')} className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50">{busy==='write'?'Đang viết…':'Viết bài'}</button>
        <button disabled={d || !text.trim()} onClick={() => run('polish')} className="rounded bg-indigo-600 px-3 py-1 text-xs text-white disabled:opacity-50">{busy==='polish'?'Đang sửa…':'Trau chuốt'}</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select value={tplId} onChange={e => setTplId(e.target.value)} className="rounded border px-2 py-1 text-xs dark:bg-gray-700">
          <option value="">Ảnh minh hoạ (gen tự do)</option>
          {templates.map(t => <option key={t.id} value={t.id}>Thiệp: {t.name}</option>)}
        </select>
        <input value={imgPrompt} onChange={e => setImgPrompt(e.target.value)} placeholder="Mô tả ảnh (bỏ trống = theo nội dung bài)"
          className="min-w-[160px] flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-700" />
        <button disabled={d} onClick={genImage} className="rounded bg-emerald-600 px-3 py-1 text-xs text-white disabled:opacity-50">{busy==='img'?'Đang tạo ảnh…':'Tạo ảnh AI'}</button>
      </div>
      {err && <div className="mt-2 text-xs text-red-500">{err}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Gắn vào PostTab.tsx** — import + render trên ô text (dùng `text/setText/media/setMedia` sẵn có; `busy` của PostTab làm disabled):
```tsx
import { AIAssistPanel } from './AIAssistPanel';
// ... trước <textarea> nhập text:
<AIAssistPanel text={text} setText={setText} media={media} setMedia={setMedia} disabled={busy} />
```

- [ ] **Step 3: tsc renderer** `npx tsc --noEmit -p tsconfig.json` exit 0.
- [ ] **Step 4: Commit** `git add src/ui/features/facebookPoster/AIAssistPanel.tsx src/ui/features/facebookPoster/PostTab.tsx && git commit -m "feat(fb-poster): AI assist panel (write/polish/generate image)"`

---

### Task 8: Brand assistant setup + build + stress test

**Files:** (không sửa code trừ khi lộ lỗi)

- [ ] **Step 1: Cấu hình assistant brand** (qua UI AI Assistant sẵn có hoặc tài liệu cho anh): platform=ahvchat, key, model text + `systemPrompt` mã hoá giọng AHV/MODNIX; upload vài bài mẫu (`ai:uploadFile`). Ghi hướng dẫn ngắn vào `docs/` nếu cần. *(Dữ liệu cấu hình, không phải code.)*
- [ ] **Step 2: Build gate** `npx tsc -p tsconfig.electron.json --noEmit && npx tsc --noEmit -p tsconfig.json && npx jest src/__tests__/ai/ src/__tests__/facebookPoster/`. Expected: tsc 0, jest pass.
- [ ] **Step 3: Verify thủ công (dev app)**: (a) brief → bài đúng giọng; (b) trau chuốt 1 nháp; (c) gen 1 thiệp tuyển dụng từ template (so ảnh mẫu) + 1 ảnh minh hoạ tự do; (d) ảnh append vào media, đẩy qua đăng/schedule chạy bình thường.
- [ ] **Step 4: Stress-test 2 vòng** (desktop + mobile width, dark/light): panel không tràn ngang, không chồng chữ, loading/err rõ, không mất nội dung đang soạn khi AI lỗi.
- [ ] **Step 5: Review diff + báo cáo**. Không tự release.

## Self-Review

**Spec coverage:** viết/trau chuốt (Task 2+7) ✓; gen ảnh edit-template + tự do (Task 1 spike + 3+4+7) ✓; template catalog (Task 5+6+7) ✓; lưu relative path + size (Task 4) ✓; không auto-đăng/human-in-loop (Task 7 UI, luôn sửa được) ✓; chỉ ahvchat (Global Constraints) ✓; không đụng publish pipeline (chỉ append media[]) ✓.

**Placeholder scan:** Task 1 (spike) + Task 3 "điều chỉnh theo ledger nếu chat-multimodal" là ruling-driven, không phải placeholder — code mặc định (OpenAI images) là real, spike chọn đường đúng. Task 5 adapter note là hướng dẫn cụ thể. Mọi code khác đầy đủ.

**Type consistency:** `generateImage` signature + `{localPath,size}` nhất quán Task 4→6→7; `MediaItem{path,size}` xuyên Task 4/5/7; `ipc.ai.generateImage/listPosterTemplates/...` nhất quán Task 6→7; `buildWriteMessages/buildPolishMessages` Task 2→7.

**Review Focus:** shape lạ (Task 3 parse throw + Task 4) ✓; ảnh >20MB (Task 7 — validateMediaSelection sẽ chặn khi lưu post; size truyền thật từ Task 4) ✓; chưa có assistant (Task 7 option nhắc) ✓; brief rỗng (Task 2 throw + Task 7 disable) ✓; employee mode (Task 6 error rõ) ✓.
