import fs from 'fs';
import path from 'path';
import { ASPECTS, Aspect, LIMITS } from './limits';

export interface VariableDef {
  type: 'string' | 'color' | 'number';
  label: string;
  maxLength?: number;
  default: string | number;
}

export interface TemplateDef {
  id: string;
  name: string;
  description: string;
  aspects: Aspect[];
  durationSec: { min: number; max: number; default: number };
  imageSlots: { min: number; max: number };
  /** Có thì thời lượng = số ảnh × giá trị này (kẹp trong `durationSec`). */
  secondsPerImage?: number;
  variables: Record<string, VariableDef>;
}

export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function parseTemplate(id: string, data: unknown): TemplateDef {
  const fail = (msg: string): never => { throw new Error(`Mẫu "${id}": ${msg}`); };
  if (!isObj(data)) return fail('template.json phải là đối tượng');
  if (data.id !== id) fail('id không khớp tên thư mục');
  if (typeof data.name !== 'string' || !data.name) fail('thiếu name');
  if (!Array.isArray(data.aspects) || data.aspects.length === 0 || !data.aspects.every((a: unknown) => typeof a === 'string' && a in ASPECTS)) {
    fail('aspects phải là danh sách khổ hợp lệ (9:16, 1:1, 16:9)');
  }
  const d = data.durationSec;
  if (!isObj(d) || ![d.min, d.max, d.default].every((n) => typeof n === 'number' && n > 0)
    || d.min > d.max || d.max > LIMITS.maxDurationSec || d.default < d.min || d.default > d.max) {
    fail(`durationSec không hợp lệ (min ≤ default ≤ max ≤ ${LIMITS.maxDurationSec})`);
  }
  const s = data.imageSlots;
  if (!isObj(s) || !isInt(s.min) || !isInt(s.max) || s.min < 0 || s.min > s.max || s.max > LIMITS.maxImages) {
    fail(`imageSlots không hợp lệ (0 ≤ min ≤ max ≤ ${LIMITS.maxImages})`);
  }
  if (data.secondsPerImage !== undefined && !(typeof data.secondsPerImage === 'number' && data.secondsPerImage > 0)) fail('secondsPerImage phải là số dương');
  if (!isObj(data.variables)) fail('variables phải là đối tượng');
  for (const [key, v] of Object.entries<any>(data.variables)) {
    if (!isObj(v) || typeof v.label !== 'string' || !v.label) fail(`biến "${key}" thiếu label`);
    if (v.type === 'string') {
      if (typeof v.default !== 'string') fail(`biến "${key}" cần default dạng chuỗi`);
      if (v.maxLength !== undefined && (!isInt(v.maxLength) || v.maxLength < 1)) fail(`biến "${key}" có maxLength sai`);
    } else if (v.type === 'color') {
      if (typeof v.default !== 'string' || !COLOR_RE.test(v.default)) fail(`biến "${key}" cần default dạng #rrggbb`);
    } else if (v.type === 'number') {
      if (typeof v.default !== 'number' || !Number.isFinite(v.default)) fail(`biến "${key}" cần default dạng số`);
    } else {
      fail(`biến "${key}" có type không hợp lệ`);
    }
  }
  return data as unknown as TemplateDef;
}

/** Đọc mọi mẫu trong `dir` (mỗi mẫu một thư mục có `template.json` và `index.html`); lỗi thì ném. */
export function loadTemplates(dir: string): TemplateDef[] {
  const out: TemplateDef[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const base = path.join(dir, entry.name);
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(path.join(base, 'template.json'), 'utf8'));
    } catch (e) {
      throw new Error(`Mẫu "${entry.name}": không đọc được template.json (${(e as Error).message})`);
    }
    const def = parseTemplate(entry.name, data);
    if (!fs.existsSync(path.join(base, 'index.html'))) {
      throw new Error(`Mẫu "${entry.name}": thiếu index.html`);
    }
    out.push(def);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
