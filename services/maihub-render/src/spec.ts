import { FileKind } from './fileTypes';
import { ASPECTS, Aspect, LIMITS } from './limits';
import { COLOR_RE, TemplateDef } from './templates';

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecError';
  }
}

export interface UploadedFile { name: string; kind: FileKind; size: number }

interface CommonSpec { width: number; height: number; fps: number; quality: 'standard' | 'high' }
export interface TemplateSpec extends CommonSpec {
  kind: 'template';
  templateId: string;
  aspect: Aspect;
  variables: Record<string, string | number>;
  images: string[];
  musicId: string | null;
  musicFile: string | null;
}
export interface HtmlSpec extends CommonSpec {
  kind: 'html';
  html: string;
  durationSec: number;
}
export type NormalizedSpec = TemplateSpec | HtmlSpec;

const MB = 1024 * 1024;
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (msg: string): never => { throw new SpecError(msg); };

function checkFiles(files: UploadedFile[]): void {
  let total = 0;
  let images = 0;
  for (const f of files) {
    total += f.size;
    if (f.kind === 'image') images++;
    const cap = f.kind === 'audio' ? LIMITS.maxAudioBytes : LIMITS.maxMediaBytes;
    if (f.size > cap) fail(`Tệp "${f.name}" quá lớn (tối đa ${cap / MB} MB).`);
  }
  if (images > LIMITS.maxImages) fail(`Tối đa ${LIMITS.maxImages} ảnh mỗi việc.`);
  if (total > LIMITS.maxTotalBytes) fail(`Tổng dung lượng vượt ${LIMITS.maxTotalBytes / MB} MB.`);
}

function parseCommon(raw: Record<string, any>): Pick<CommonSpec, 'fps' | 'quality'> {
  const fps = raw.fps ?? LIMITS.defaultFps;
  if (!LIMITS.fpsOptions.includes(fps)) fail(`fps phải là ${LIMITS.fpsOptions.join(' hoặc ')}.`);
  const quality = raw.quality ?? 'standard';
  if (quality !== 'standard' && quality !== 'high') fail('Chất lượng phải là "standard" hoặc "high".');
  return { fps, quality };
}

function findFile(files: UploadedFile[], name: unknown, kind: FileKind, label: string): string {
  const f = typeof name === 'string' ? files.find((x) => x.name === name) : undefined;
  if (!f) return fail(`${label} "${String(name)}" không có trong các tệp gửi kèm.`);
  if (f.kind !== kind) fail(`${label} "${f.name}" không đúng loại (cần ${kind === 'image' ? 'ảnh' : 'âm thanh'}).`);
  return f.name;
}

function parseTemplateSpec(
  t: unknown, raw: Record<string, any>, templates: TemplateDef[], files: UploadedFile[], musicIds: string[],
): TemplateSpec {
  if (!isObj(t)) return fail('Trường template phải là đối tượng.');
  const def = templates.find((x) => x.id === t.id);
  if (!def) return fail(`Không có mẫu "${String(t.id)}".`);
  const aspect = t.aspect as Aspect;
  if (!(aspect in ASPECTS) || !def.aspects.includes(aspect)) {
    return fail(`Mẫu "${def.id}" không hỗ trợ khổ "${String(t.aspect)}" (hỗ trợ: ${def.aspects.join(', ')}).`);
  }
  const imagesIn = t.images ?? [];
  if (!Array.isArray(imagesIn) || !imagesIn.every((n) => typeof n === 'string')) fail('Danh sách ảnh phải là mảng tên tệp.');
  if (imagesIn.length < def.imageSlots.min || imagesIn.length > def.imageSlots.max) {
    fail(`Mẫu "${def.id}" cần từ ${def.imageSlots.min} đến ${def.imageSlots.max} ảnh (đang có ${imagesIn.length}).`);
  }
  if (new Set(imagesIn).size !== imagesIn.length) fail('Danh sách ảnh có tên tệp trùng nhau.');
  const images = imagesIn.map((n: string) => findFile(files, n, 'image', 'Ảnh'));

  const varsIn = t.variables ?? {};
  if (!isObj(varsIn)) return fail('Trường variables phải là đối tượng.');
  for (const key of Object.keys(varsIn)) {
    if (!(key in def.variables)) fail(`Biến "${key}" không có trong mẫu "${def.id}".`);
  }
  const variables: Record<string, string | number> = {};
  for (const [key, vd] of Object.entries(def.variables)) {
    const v: unknown = key in varsIn ? varsIn[key] : vd.default;
    if (vd.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(`Biến "${key}" phải là số.`);
    } else if (typeof v !== 'string') {
      fail(`Biến "${key}" phải là chuỗi.`);
    } else if (vd.type === 'color') {
      if (!COLOR_RE.test(v)) fail(`Biến "${key}" phải là màu dạng #rrggbb.`);
    } else if (vd.required !== false && v.trim() === '') {
      fail(`Biến "${key}" không được để trống.`);
    } else if (vd.maxLength !== undefined && v.length > vd.maxLength) {
      fail(`Biến "${key}" dài quá ${vd.maxLength} ký tự.`);
    }
    variables[key] = v as string | number;
  }

  const musicId = t.musicId ?? null;
  const musicFileIn = t.musicFile ?? null;
  if (musicId !== null && musicFileIn !== null) fail('Chỉ chọn một trong nhạc có sẵn hoặc tệp nhạc gửi kèm.');
  if (musicId !== null && !musicIds.includes(musicId)) fail(`Nhạc "${String(musicId)}" không có trong danh sách nhạc có sẵn.`);
  const musicFile = musicFileIn === null ? null : findFile(files, musicFileIn, 'audio', 'Tệp nhạc');

  const [width, height] = ASPECTS[aspect];
  return { kind: 'template', templateId: def.id, aspect, width, height, ...parseCommon(raw), variables, images, musicId, musicFile };
}

function parseHtmlSpec(raw: Record<string, any>): HtmlSpec {
  const html = raw.html;
  if (typeof html !== 'string' || html.length === 0) return fail('Trường html phải là chuỗi không rỗng.');
  if (Buffer.byteLength(html, 'utf8') > LIMITS.maxHtmlBytes) fail(`HTML vượt ${LIMITS.maxHtmlBytes / 1024} KB.`);
  const { width, height } = raw;
  const fits = (w: number, h: number) => w <= 1080 && h <= 1920 || w <= 1920 && h <= 1080;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || !fits(width, height)) {
    fail('Kích thước không hợp lệ (tối đa 1080x1920 hoặc 1920x1080).');
  }
  if (!/data-composition-id\s*=/.test(html)) fail('HTML thiếu thuộc tính data-composition-id ở phần tử gốc.');
  const m = /data-duration\s*=\s*["']([^"']*)["']/.exec(html);
  if (!m) return fail('HTML thiếu thuộc tính data-duration.');
  const durationSec = Number(m[1]);
  if (!Number.isFinite(durationSec) || durationSec <= 0) fail('data-duration phải là số giây lớn hơn 0.');
  if (durationSec > LIMITS.maxDurationSec) fail(`data-duration vượt ${LIMITS.maxDurationSec} giây.`);
  return { kind: 'html', html, width, height, ...parseCommon(raw), durationSec };
}

/** Kiểm và chuẩn hoá spec của việc; sai thì ném `SpecError` (thông báo tiếng Việt). */
export function validateJobSpec(
  raw: unknown, templates: TemplateDef[], files: UploadedFile[], musicIds: string[] = [],
): NormalizedSpec {
  if (!isObj(raw)) return fail('spec phải là đối tượng JSON.');
  checkFiles(files);
  const hasTemplate = raw.template !== undefined;
  const hasHtml = raw.html !== undefined;
  if (hasTemplate && hasHtml) fail('spec chỉ được có một trong hai: template hoặc html.');
  if (!hasTemplate && !hasHtml) fail('spec cần có template hoặc html.');
  return hasTemplate ? parseTemplateSpec(raw.template, raw, templates, files, musicIds) : parseHtmlSpec(raw);
}
