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
  const durationSec = typeof spec.variables.durationSec === 'number' ? spec.variables.durationSec : def.durationSec.default;
  const music = findMusic(opts, spec);
  if (music) await prepareMusic(music, durationSec, path.join(assets, 'music.m4a'), opts.ffmpegPath);
  const variables = { durationSec, ...spec.variables, images, width: spec.width, height: spec.height };
  fs.writeFileSync(path.join(dir, 'variables.json'), JSON.stringify(variables));
}

function buildFromHtml(dir: string, opts: WorkdirOptions): void {
  for (const entry of fs.readdirSync(opts.inputDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.') || entry.name === 'job.json' || entry.name === 'cancel') continue;
    fs.copyFileSync(path.join(opts.inputDir, entry.name), path.join(dir, entry.name));
  }
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
