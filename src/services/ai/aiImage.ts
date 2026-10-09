/**
 * aiImage.ts
 * Dựng request + xử lý response cho gen/edit ảnh qua ahvchat.
 * Contract (xác nhận từ doc ahvchat): POST /v1/images/generations với
 *   { model, prompt, n, size, quality, background, image_detail, output_format, image? }
 * Field `image` (URL hoặc data URL) = ảnh base/template → EDIT mode; không có → GEN mode.
 */
import fs from 'fs';

const AHV_BASE = 'https://auto.ahvchat.com/v1';

export interface ImageRequestOpts {
  apiKey: string;
  model: string;
  prompt: string;
  baseImages?: string[]; // local path / URL / data URL — có → edit mode
  size?: string;
  quality?: string;      // 'low' | 'medium' | 'high'
}

function toImageRef(p: string): string {
  if (p.startsWith('http') || p.startsWith('data:')) return p;
  const ext = (p.toLowerCase().split('.').pop() || '');
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
}

export function buildImageRequest(opts: ImageRequestOpts): { url: string; headers: Record<string, string>; body: any } {
  const headers = { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' };
  const hasBase = !!(opts.baseImages && opts.baseImages.length);
  const body: any = {
    model: opts.model,
    prompt: opts.prompt,
    n: 1,
    size: opts.size || '1024x1024',
    quality: opts.quality || 'high',
    background: 'auto',
    image_detail: hasBase ? 'high' : 'low',
    output_format: 'jpeg',
  };
  if (hasBase) body.image = toImageRef(opts.baseImages![0]);
  return { url: `${AHV_BASE}/images/generations`, headers, body };
}

/** Lấy ảnh từ response: b64_json → Buffer ngay; chỉ có url → trả url để tải. */
/** Lấy thời gian chờ retry từ lỗi: backend ahvchat báo "reset after Ns" → đợi đúng N giây (cap 35s). */
export function retryDelayMs(err: any): number {
  const msg = err?.response?.data?.error?.message || err?.response?.data?.error || err?.message || '';
  const m = /reset after (\d+)\s*s/i.exec(String(msg));
  if (m) return Math.min(parseInt(m[1], 10) * 1000 + 2000, 35000);
  return 6000;
}

export function parseImageResponse(data: any): { buffer?: Buffer; url?: string } {
  const d0 = data?.data?.[0];
  if (d0?.b64_json) return { buffer: Buffer.from(d0.b64_json, 'base64') };
  if (d0?.url) return { url: d0.url };
  // một số gateway trả ảnh trong chat-style content — chưa gặp; bổ sung nếu doc đổi
  throw new Error('no image in response');
}

/** Deps injected để test không cần electron/sqlite (AIAssistantService.generateImage là wrapper mỏng). */
export interface ImageGenDeps {
  getApiKey: () => string;
  model: string;
  post: (url: string, body: any, config: any) => Promise<{ data: any }>;
  download: (url: string) => Promise<Buffer>;
  saveBuffer: (bucket: string, buf: Buffer, name: string) => Promise<string>;
  bucket: string;
  sleep?: (ms: number) => Promise<void>; // injectable để test
  retries?: number;                      // số lần thử LẠI (mặc định 2 → tối đa 3 lần)
}

export async function runImageGeneration(
  deps: ImageGenDeps,
  input: { prompt: string; baseImages?: string[]; size?: string; quality?: string },
): Promise<{ localPath: string; size: number }> {
  const req = buildImageRequest({ apiKey: deps.getApiKey(), model: deps.model, prompt: input.prompt, baseImages: input.baseImages, size: input.size, quality: input.quality });
  const attempts = (deps.retries ?? 2) + 1;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: any;
  // Backend ảnh ahvchat (codex) chập chờn: lúc ra ảnh, lúc lỗi transient ("reset after Ns",
  // oauth/entitlement). Thử lại vài lần để vượt qua lần hỏng.
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await deps.post(req.url, req.body, { headers: req.headers, timeout: 180000 });
      const parsed = parseImageResponse(res.data);
      const buffer = parsed.buffer ?? (await deps.download(parsed.url!));
      // ABSOLUTE path (saveBuffer trả tuyệt đối) để khớp mediaPaths của poster (MediaPicker tuyệt đối,
      // validateStartParams fs.existsSync không resolve).
      const abs = await deps.saveBuffer(deps.bucket, buffer, `gen_${Date.now()}.jpg`);
      return { localPath: abs, size: buffer.length };
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(retryDelayMs(e));
    }
  }
  throw lastErr;
}
