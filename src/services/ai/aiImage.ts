/**
 * aiImage.ts
 * Dựng request + parse response cho gen/edit ảnh qua ahvchat (OpenAI-compatible images API).
 * Contract mặc định OpenAI-images (xác nhận live ở Task 8); chỉnh ở đây nếu ahvchat dùng chat-multimodal.
 */
import fs from 'fs';

const AHV_BASE = 'https://auto.ahvchat.com/v1';

export interface ImageRequestOpts {
  apiKey: string;
  model: string;
  prompt: string;
  baseImages?: string[]; // local paths — có → EDIT mode; rỗng → GEN mode
  size?: string;
}

export function buildImageRequest(opts: ImageRequestOpts): { url: string; headers: Record<string, string>; body: any } {
  const headers = { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' };
  const size = opts.size || '1024x1024';
  const hasBase = !!(opts.baseImages && opts.baseImages.length);
  if (hasBase) {
    // EDIT mode: gửi ảnh base dạng data URL base64 (điều chỉnh theo contract live nếu khác)
    const image = opts.baseImages!.map((p) => `data:image/jpeg;base64,${fs.readFileSync(p).toString('base64')}`);
    return { url: `${AHV_BASE}/images/edits`, headers, body: { model: opts.model, prompt: opts.prompt, image, size } };
  }
  return { url: `${AHV_BASE}/images/generations`, headers, body: { model: opts.model, prompt: opts.prompt, size } };
}

export function parseImageResponse(data: any): Buffer {
  const b64 = data?.data?.[0]?.b64_json;
  if (b64) return Buffer.from(b64, 'base64');
  throw new Error('no image in response');
}
