import fs from 'fs';
import path from 'path';
import { prepareMusic } from './music';
import { NormalizedSpec } from './spec';
import { TemplateDef } from './templates';

export interface WorkdirJob { id: string; spec: NormalizedSpec }
export interface WorkdirOptions {
  templatesDir: string;
  musicDir: string;
  /** Thư mục `current/` do api ghi (phẳng: img1.jpg, audio1.mp3, index.html...). */
  inputDir: string;
  tmpDir: string;
  ffmpegPath?: string;
}
export interface Workdir { dir: string; width: number; height: number }

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const safeName = (name: string, label: string): string => {
  if (!SAFE_NAME.test(name) || name.includes('..')) throw new Error(`${label} "${name}" không hợp lệ`);
  return name;
};

function findMusic(opts: WorkdirOptions, spec: Extract<NormalizedSpec, { kind: 'template' }>): string | undefined {
  if (spec.musicFile) return path.join(opts.inputDir, safeName(spec.musicFile, 'Tệp nhạc'));
  if (!spec.musicId) return undefined;
  const id = safeName(spec.musicId, 'Mã nhạc');
  const found = fs.readdirSync(opts.musicDir).find((f) => path.parse(f).name === id && !f.endsWith('.json'));
  if (!found) throw new Error(`Không tìm thấy nhạc "${id}"`);
  return path.join(opts.musicDir, found);
}

/** Thời lượng cuối: mẫu có `secondsPerImage` thì theo số ảnh, ngược lại lấy biến `durationSec` hoặc mặc định; luôn kẹp trong khoảng của mẫu. */
function resolveDuration(def: TemplateDef, spec: Extract<NormalizedSpec, { kind: 'template' }>): number {
  const { min, max, default: dflt } = def.durationSec;
  const raw = def.secondsPerImage ? spec.images.length * def.secondsPerImage
    : typeof spec.variables.durationSec === 'number' ? spec.variables.durationSec : dflt;
  return Math.min(max, Math.max(min, raw));
}

/**
 * HyperFrames đọc khổ và thời lượng từ HTML tĩnh (không chạy script), nên điền sẵn các dấu `{{...}}`
 * trong index.html: `{{width}}`, `{{height}}`, `{{durationSec}}` và `{{audio}}` (thẻ nhạc hoặc rỗng nếu không có nhạc,
 * vì thẻ audio thiếu tệp làm hỏng cả lần render). Chỉ số liệu của hệ thống được điền, không có chữ do người dùng nhập.
 */
function fillHtmlTokens(file: string, tokens: Record<string, string>): void {
  let html = fs.readFileSync(file, 'utf8');
  for (const [key, value] of Object.entries(tokens)) html = html.split(`{{${key}}}`).join(value);
  fs.writeFileSync(file, html);
}

async function buildFromTemplate(job: WorkdirJob, spec: Extract<NormalizedSpec, { kind: 'template' }>, dir: string, opts: WorkdirOptions): Promise<void> {
  const tplDir = path.join(opts.templatesDir, safeName(spec.templateId, 'Mã mẫu'));
  if (!fs.existsSync(path.join(tplDir, 'index.html'))) throw new Error(`Không có mẫu "${spec.templateId}"`);
  const def: TemplateDef = JSON.parse(fs.readFileSync(path.join(tplDir, 'template.json'), 'utf8'));
  fs.cpSync(tplDir, dir, { recursive: true, filter: (src) => path.basename(src) !== 'template.json' });

  const assets = path.join(dir, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  const images = spec.images.map((name) => {
    safeName(name, 'Tên ảnh');
    fs.copyFileSync(path.join(opts.inputDir, name), path.join(assets, name));
    return `assets/${name}`;
  });
  const durationSec = resolveDuration(def, spec);
  const music = findMusic(opts, spec);
  if (music) await prepareMusic(music, durationSec, path.join(assets, 'music.m4a'), opts.ffmpegPath);
  fillHtmlTokens(path.join(dir, 'index.html'), {
    width: String(spec.width),
    height: String(spec.height),
    durationSec: String(durationSec),
    audio: music ? `<audio id="bgm" src="assets/music.m4a" data-start="0" data-duration="${durationSec}" data-track-index="9"></audio>` : '',
  });
  const variables = { ...spec.variables, durationSec, images, width: spec.width, height: spec.height };
  fs.writeFileSync(path.join(dir, 'variables.json'), JSON.stringify(variables));
}

function buildFromHtml(dir: string, opts: WorkdirOptions): void {
  for (const entry of fs.readdirSync(opts.inputDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.') || entry.name === 'job.json' || entry.name === 'cancel') continue;
    fs.copyFileSync(path.join(opts.inputDir, entry.name), path.join(dir, entry.name));
  }
  // Worker không có mạng: cấp sẵn đúng bản GSAP đã ghim của các mẫu để HTML gọi `<script src="gsap.min.js">`.
  const gsap = findPinnedGsap(opts.templatesDir);
  if (gsap && !fs.existsSync(path.join(dir, GSAP_FILE))) fs.copyFileSync(gsap, path.join(dir, GSAP_FILE));
  const index = path.join(dir, 'index.html');
  if (fs.existsSync(index)) fs.writeFileSync(index, localizeRemoteScripts(fs.readFileSync(index, 'utf8')));
}

const GSAP_FILE = 'gsap.min.js';
const SCRIPT_SRC_RE = /(<script\b[^>]*?\bsrc\s*=\s*)(["'])([^"']*)\2/gi;
const REMOTE_RE = /^(?:https?:)?\/\//i;
/** Tệp GSAP lõi trên CDN (không phải plugin): .../gsap.min.js hoặc .../gsap.js. */
const GSAP_CORE_RE = /\/gsap(?:\.min)?\.js(?:[?#].*)?$/i;

/**
 * Script gọi từ mạng không bao giờ tải được trong worker. GSAP lõi từ CDN đổi sang bản có sẵn để trang của bot
 * vẫn chạy; script mạng khác thì ném lỗi rõ ràng trước khi render (thay vì render xong rồi bị chặn vì timeline lỗi).
 */
export function localizeRemoteScripts(html: string): string {
  const remote: string[] = [];
  const out = html.replace(SCRIPT_SRC_RE, (whole, head: string, quote: string, src: string) => {
    if (!REMOTE_RE.test(src.trim())) return whole;
    if (GSAP_CORE_RE.test(src.trim())) return `${head}${quote}${GSAP_FILE}${quote}`;
    remote.push(src.trim());
    return whole;
  });
  if (remote.length) {
    throw new Error(`HTML gọi script từ mạng nhưng máy render không có mạng: ${remote.slice(0, 3).join(', ')}. Tải tệp lên bằng assetIds hoặc bỏ đi; GSAP có sẵn: <script src="gsap.min.js">.`);
  }
  return out;
}

/** `gsap.min.js` của mẫu đầu tiên (theo tên) có tệp này; không có thì null. */
function findPinnedGsap(templatesDir: string): string | null {
  let names: string[];
  try { names = fs.readdirSync(templatesDir).sort(); } catch { return null; }
  for (const name of names) {
    const file = path.join(templatesDir, name, GSAP_FILE);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** Dựng thư mục render riêng cho việc (mẫu hoặc HTML tự viết) dưới `tmpDir`. */
export async function buildWorkdir(job: WorkdirJob, opts: WorkdirOptions): Promise<Workdir> {
  const dir = path.join(opts.tmpDir, `work-${safeName(job.id, 'Mã việc')}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const { spec } = job;
  if (spec.kind === 'template') await buildFromTemplate(job, spec, dir, opts);
  else buildFromHtml(dir, opts);
  return { dir, width: spec.width, height: spec.height };
}
