import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadTemplates } from '../src/templates';

const valid = {
  id: 'demo',
  name: 'Demo',
  description: 'Mẫu thử',
  aspects: ['9:16', '1:1'],
  durationSec: { min: 10, max: 30, default: 15 },
  imageSlots: { min: 1, max: 4 },
  variables: {
    title: { type: 'string', label: 'Tiêu đề', maxLength: 40, default: 'Xin chào' },
    accent: { type: 'color', label: 'Màu', default: '#ff0000' },
  },
};

let root: string;
function put(id: string, json: unknown, html = true): void {
  const d = path.join(root, id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'template.json'), typeof json === 'string' ? json : JSON.stringify(json));
  if (html) fs.writeFileSync(path.join(d, 'index.html'), '<div></div>');
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('loadTemplates', () => {
  it('đọc mẫu hợp lệ, sắp theo id', () => {
    put('demo', valid);
    put('abc', { ...valid, id: 'abc' });
    const list = loadTemplates(root);
    expect(list.map((t) => t.id)).toEqual(['abc', 'demo']);
    expect(list[1].variables.title.maxLength).toBe(40);
  });
  it('bỏ qua tệp lẻ trong thư mục gốc', () => {
    put('demo', valid);
    fs.writeFileSync(path.join(root, 'README.md'), 'x');
    expect(loadTemplates(root)).toHaveLength(1);
  });
  it('thư mục không tồn tại → ném', () => {
    expect(() => loadTemplates(path.join(root, 'none'))).toThrow();
  });
  it.each([
    ['JSON hỏng', '{oops'],
    ['id không khớp tên thư mục', { ...valid, id: 'other' }],
    ['thiếu aspects', { ...valid, aspects: [] }],
    ['aspect lạ', { ...valid, aspects: ['4:3'] }],
    ['imageSlots sai', { ...valid, imageSlots: { min: 5, max: 2 } }],
    ['imageSlots vượt 20', { ...valid, imageSlots: { min: 1, max: 21 } }],
    ['biến thiếu label', { ...valid, variables: { a: { type: 'string', default: 'x' } } }],
    ['biến kiểu lạ', { ...valid, variables: { a: { type: 'bool', label: 'a', default: 'x' } } }],
    ['required sai kiểu', { ...valid, variables: { a: { type: 'string', label: 'a', default: 'x', required: 'no' } } }],
    ['required=false cho màu', { ...valid, variables: { a: { type: 'color', label: 'a', default: '#112233', required: false } } }],
    ['bắt buộc nhưng default rỗng', { ...valid, variables: { a: { type: 'string', label: 'a', default: '' } } }],
    ['biến thiếu default', { ...valid, variables: { a: { type: 'string', label: 'a' } } }],
    ['default sai kiểu', { ...valid, variables: { a: { type: 'number', label: 'a', default: 'x' } } }],
    ['màu mặc định sai', { ...valid, variables: { a: { type: 'color', label: 'a', default: 'red' } } }],
    ['durationSec sai', { ...valid, durationSec: { min: 10, max: 200, default: 15 } }],
    ['default ngoài khoảng', { ...valid, durationSec: { min: 10, max: 30, default: 40 } }],
  ])('template.json lỗi: %s', (_n, json) => {
    put('demo', json);
    expect(() => loadTemplates(root)).toThrow(/demo/);
  });
  it('thiếu index.html → ném', () => {
    put('demo', valid, false);
    expect(() => loadTemplates(root)).toThrow(/index\.html/);
  });
});

describe('mẫu và nhạc đi kèm', () => {
  const base = path.join(__dirname, '..');
  const templatesDir = path.join(base, 'templates');
  const templates = loadTemplates(templatesDir);
  const SYSTEM_VARS = ['durationSec', 'height', 'width']; // worker luôn thêm vào variables.json
  const declared = (id: string): Record<string, { type: string; default: unknown }> => {
    const html = fs.readFileSync(path.join(templatesDir, id, 'index.html'), 'utf8');
    const m = html.match(/data-composition-variables='([^']*)'/);
    if (!m) throw new Error(`${id}: thiếu data-composition-variables`);
    return JSON.parse(m[1]);
  };

  it('có đủ ba mẫu theo spec', () => {
    expect(templates.map((t) => t.id)).toEqual(['flash-sale', 'product-slideshow', 'product-spotlight']);
  });

  it.each(['flash-sale', 'product-slideshow', 'product-spotlight'])('%s: biến khớp data-composition-variables', (id) => {
    const def = templates.find((t) => t.id === id)!;
    const decl = declared(id);
    for (const [key, v] of Object.entries(def.variables)) {
      expect(decl[key]).toEqual({ type: v.type, default: v.default });
    }
    const extra = Object.keys(decl).filter((k) => !(k in def.variables)).sort();
    expect(extra.every((k) => SYSTEM_VARS.includes(k))).toBe(true);
  });

  it.each(['flash-sale', 'product-slideshow', 'product-spotlight'])('%s: hỗ trợ đủ ba khổ và dùng dấu khổ/thời lượng của worker', (id) => {
    const def = templates.find((t) => t.id === id)!;
    expect([...def.aspects].sort()).toEqual(['16:9', '1:1', '9:16']);
    const html = fs.readFileSync(path.join(templatesDir, id, 'index.html'), 'utf8');
    for (const token of ['{{width}}', '{{height}}', '{{durationSec}}', '{{audio}}']) expect(html).toContain(token);
    expect(html).not.toMatch(/https?:\/\//); // không gọi mạng
    expect(html).toContain('window.__hyperframes.getVariables');
    expect(html).toContain('window.__timelines');
  });

  it.each(['flash-sale', 'product-slideshow', 'product-spotlight'])('%s: có bản GSAP cục bộ giống vendor/', (id) => {
    const vendor = fs.readFileSync(path.join(base, 'vendor', 'gsap.min.js'));
    expect(fs.readFileSync(path.join(templatesDir, id, 'gsap.min.js')).equals(vendor)).toBe(true);
    expect(vendor.toString('utf8', 0, 200)).toContain('3.14.2');
  });

  it('chỉ giá gốc của product-slideshow là tuỳ chọn', () => {
    const by = Object.fromEntries(templates.map((t) => [t.id, t]));
    expect(by['product-slideshow'].variables.oldPrice.required).toBe(false);
    const optional = templates.flatMap((t) => Object.entries(t.variables).filter(([, v]) => v.required === false).map(([k]) => `${t.id}.${k}`));
    expect(optional).toEqual(['product-slideshow.oldPrice']);
  });

  it('thời lượng và số ảnh theo spec', () => {
    const by = Object.fromEntries(templates.map((t) => [t.id, t]));
    expect(by['product-slideshow']).toMatchObject({ secondsPerImage: 6, imageSlots: { min: 3, max: 8 }, durationSec: { min: 15, max: 48 } });
    expect(by['flash-sale']).toMatchObject({ imageSlots: { min: 1, max: 4 }, durationSec: { min: 15, max: 30 } });
    expect(by['product-spotlight']).toMatchObject({ imageSlots: { min: 1, max: 3 }, durationSec: { min: 15, max: 30 } });
    expect(Object.keys(by['product-slideshow'].variables).sort()).toEqual(['accent', 'cta', 'oldPrice', 'price', 'title']);
    expect(Object.keys(by['flash-sale'].variables).sort()).toEqual(['accent', 'cta', 'discountLabel', 'durationSec', 'endsText', 'oldPrice', 'price', 'title']);
    expect(Object.keys(by['product-spotlight'].variables).sort()).toEqual(['accent', 'benefit1', 'benefit2', 'benefit3', 'cta', 'durationSec', 'price', 'title']);
  });

  it('Dockerfile.api đóng cả các tệp MP3 (nghe thử qua api)', () => {
    const docker = fs.readFileSync(path.join(base, 'Dockerfile.api'), 'utf8');
    expect(docker).toMatch(/^COPY music \.\/music$/m);
    expect(docker).not.toMatch(/music\/manifest\.json/);
    expect(fs.readdirSync(path.join(base, 'music')).filter((f) => f.endsWith('.mp3')).length).toBe(5);
  });

  it('manifest nhạc đủ trường, tệp tồn tại, CC0, ≤ 5 MB', () => {
    const musicDir = path.join(base, 'music');
    const manifest = JSON.parse(fs.readFileSync(path.join(musicDir, 'manifest.json'), 'utf8'));
    expect(manifest).toHaveLength(5);
    const ids = new Set<string>();
    for (const m of manifest) {
      expect(typeof m.id).toBe('string');
      expect(path.parse(m.file).name).toBe(m.id); // buildWorkdir tìm tệp theo id
      ids.add(m.id);
      expect(typeof m.name).toBe('string');
      expect(typeof m.author).toBe('string');
      expect(m.durationSec).toBeGreaterThan(0);
      expect(m.license).toBe('CC0');
      expect(m.source).toMatch(/^https:\/\/.*freepd\.com\//);
      const size = fs.statSync(path.join(musicDir, m.file)).size;
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThanOrEqual(5 * 1024 * 1024);
    }
    expect(ids.size).toBe(5);
  });
});
