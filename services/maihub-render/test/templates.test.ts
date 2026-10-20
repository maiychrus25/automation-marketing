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
