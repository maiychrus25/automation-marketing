import { SpecError, validateJobSpec } from '../src/spec';
import type { TemplateDef } from '../src/templates';

const tpl: TemplateDef = {
  id: 'demo',
  name: 'Demo',
  description: '',
  aspects: ['9:16', '16:9'],
  durationSec: { min: 10, max: 30, default: 15 },
  imageSlots: { min: 1, max: 3 },
  variables: {
    title: { type: 'string', label: 'Tiêu đề', maxLength: 10, default: 'Mặc định' },
    accent: { type: 'color', label: 'Màu', default: '#112233' },
    count: { type: 'number', label: 'Số', default: 1 },
  },
};
const files = [
  { name: 'a.jpg', kind: 'image' as const, size: 1000 },
  { name: 'b.png', kind: 'image' as const, size: 1000 },
  { name: 'song.mp3', kind: 'audio' as const, size: 1000 },
  { name: 'clip.mp4', kind: 'video' as const, size: 1000 },
];
const music = ['calm', 'upbeat'];
const base = () => ({ template: { id: 'demo', aspect: '9:16', variables: { title: 'Hi' }, images: ['a.jpg'] } });
const run = (raw: unknown, f = files) => validateJobSpec(raw, [tpl], f, music);
const bad = (raw: unknown, re: RegExp, f = files) => {
  let err: unknown;
  try { run(raw, f); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(SpecError);
  expect((err as Error).message).toMatch(re);
};
const tweak = (fn: (s: any) => void) => { const s: any = base(); fn(s); return s; };

describe('validateJobSpec - mẫu', () => {
  it('chuẩn hoá spec hợp lệ, điền mặc định', () => {
    const n: any = run(base());
    expect(n).toMatchObject({
      kind: 'template', templateId: 'demo', aspect: '9:16', width: 1080, height: 1920,
      fps: 30, quality: 'standard', images: ['a.jpg'], musicId: null, musicFile: null,
    });
    expect(n.variables).toEqual({ title: 'Hi', accent: '#112233', count: 1 });
  });
  it('khổ 16:9 → 1920x1080, fps 24, quality high', () => {
    const n: any = run({ ...tweak((s) => { s.template.aspect = '16:9'; }), fps: 24, quality: 'high' });
    expect(n).toMatchObject({ width: 1920, height: 1080, fps: 24, quality: 'high' });
  });
  it('nhận musicId và musicFile', () => {
    expect((run(tweak((s) => { s.template.musicId = 'calm'; })) as any).musicId).toBe('calm');
    expect((run(tweak((s) => { s.template.musicFile = 'song.mp3'; })) as any).musicFile).toBe('song.mp3');
    expect((run(tweak((s) => { s.template.musicId = null; })) as any).musicId).toBeNull();
  });
  it('spec không phải đối tượng', () => { bad(null, /spec/); bad('x', /spec/); bad([], /spec/); });
  it('vừa template vừa html', () => bad({ ...base(), html: '<div></div>' }, /template.*html|html.*template/i));
  it('không có template cũng không html', () => bad({}, /template|html/i));
  it('mẫu không tồn tại', () => bad(tweak((s) => { s.template.id = 'nope'; }), /nope/));
  it('khổ không hỗ trợ bởi mẫu', () => bad(tweak((s) => { s.template.aspect = '1:1'; }), /khổ/i));
  it('khổ lạ', () => bad(tweak((s) => { s.template.aspect = '4:3'; }), /khổ/i));
  it('ít ảnh hơn mức tối thiểu', () => bad(tweak((s) => { s.template.images = []; }), /ảnh/));
  it('nhiều ảnh hơn mức tối đa', () => {
    const many = [...files, { name: 'c.jpg', kind: 'image' as const, size: 1 }, { name: 'd.jpg', kind: 'image' as const, size: 1 }];
    bad(tweak((s) => { s.template.images = ['a.jpg', 'b.png', 'c.jpg', 'd.jpg']; }), /ảnh/, many);
  });
  it('ảnh không có trong files', () => bad(tweak((s) => { s.template.images = ['x.jpg']; }), /x\.jpg/));
  it('ảnh trỏ tới tệp không phải ảnh', () => bad(tweak((s) => { s.template.images = ['song.mp3']; }), /song\.mp3/));
  it('images không phải mảng chuỗi', () => bad(tweak((s) => { s.template.images = [1]; }), /ảnh/));
  it('tên ảnh trùng lặp', () => bad(tweak((s) => { s.template.images = ['a.jpg', 'a.jpg']; }), /trùng/));
  it('musicFile không có / không phải âm thanh', () => {
    bad(tweak((s) => { s.template.musicFile = 'zzz.mp3'; }), /zzz\.mp3/);
    bad(tweak((s) => { s.template.musicFile = 'a.jpg'; }), /a\.jpg/);
  });
  it('musicId không có trong danh sách', () => bad(tweak((s) => { s.template.musicId = 'rock'; }), /rock/));
  it('musicId và musicFile cùng lúc', () => {
    bad(tweak((s) => { s.template.musicId = 'calm'; s.template.musicFile = 'song.mp3'; }), /nhạc/);
  });
  it('biến lạ', () => bad(tweak((s) => { s.template.variables.zzz = 'x'; }), /zzz/));
  it('biến sai kiểu', () => {
    bad(tweak((s) => { s.template.variables.title = 5; }), /title/);
    bad(tweak((s) => { s.template.variables.count = '3'; }), /count/);
    bad(tweak((s) => { s.template.variables.count = Infinity; }), /count/);
  });
  it('chuỗi vượt maxLength', () => bad(tweak((s) => { s.template.variables.title = 'x'.repeat(11); }), /title/));
  it('màu sai định dạng', () => {
    for (const c of ['red', '#fff', '#12345g', '#1234567']) bad(tweak((s) => { s.template.variables.accent = c; }), /accent/);
  });
  it('màu đúng #rrggbb', () => {
    expect((run(tweak((s) => { s.template.variables.accent = '#AbCdEf'; })) as any).variables.accent).toBe('#AbCdEf');
  });
  it('fps / quality không hợp lệ', () => {
    bad({ ...base(), fps: 60 }, /fps/);
    bad({ ...base(), quality: 'ultra' }, /chất lượng|quality/i);
  });
  it('tệp quá giới hạn', () => {
    bad(base(), /20 MB/, [{ name: 'a.jpg', kind: 'image', size: 21 * 1024 * 1024 }]);
    bad(tweak((s) => { s.template.musicFile = 'song.mp3'; }), /15 MB/, [
      { name: 'a.jpg', kind: 'image', size: 1 }, { name: 'song.mp3', kind: 'audio', size: 16 * 1024 * 1024 },
    ]);
    const big = Array.from({ length: 11 }, (_, i) => ({ name: `i${i}.jpg`, kind: 'image' as const, size: 19 * 1024 * 1024 }));
    bad(tweak((s) => { s.template.images = ['i0.jpg']; }), /200 MB/, big);
  });
  it('quá 20 tệp ảnh', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `i${i}.jpg`, kind: 'image' as const, size: 1 }));
    bad(tweak((s) => { s.template.images = ['i0.jpg']; }), /20/, many);
  });
});

describe('validateJobSpec - HTML tự viết', () => {
  const html = '<div data-composition-id="main" data-duration="30"></div>';
  const h = (over: any = {}) => ({ html, width: 1080, height: 1920, ...over });

  it('hợp lệ', () => {
    expect(run(h())).toMatchObject({ kind: 'html', width: 1080, height: 1920, fps: 30, quality: 'standard', durationSec: 30 });
  });
  it('chấp nhận 1920x1080 và thời lượng thập phân', () => {
    const n: any = run(h({ width: 1920, height: 1080, html: '<div data-duration="12.5" data-composition-id="x">' }));
    expect(n.durationSec).toBe(12.5);
  });
  it('html không phải chuỗi / rỗng', () => { bad(h({ html: 5 }), /html/i); bad(h({ html: '' }), /html/i); });
  it('html quá 512 KB', () => bad(h({ html: html + 'x'.repeat(512 * 1024) }), /512 KB/));
  it('thiếu data-composition-id', () => bad(h({ html: '<div data-duration="30"></div>' }), /data-composition-id/));
  it('thiếu data-duration', () => bad(h({ html: '<div data-composition-id="m"></div>' }), /data-duration/));
  it('data-duration quá 120 hoặc không dương', () => {
    bad(h({ html: '<div data-composition-id="m" data-duration="121"></div>' }), /120/);
    bad(h({ html: '<div data-composition-id="m" data-duration="0"></div>' }), /data-duration/);
    bad(h({ html: '<div data-composition-id="m" data-duration="abc"></div>' }), /data-duration/);
  });
  it('kích thước không hợp lệ', () => {
    bad(h({ width: 1081, height: 1920 }), /kích thước|khổ/i);
    bad(h({ width: 1920, height: 1920 }), /kích thước|khổ/i);
    bad(h({ width: 0, height: 100 }), /kích thước|khổ/i);
    bad(h({ width: 100.5, height: 100 }), /kích thước|khổ/i);
    bad(h({ width: '1080', height: 1920 }), /kích thước|khổ/i);
    bad(h({ height: undefined }), /kích thước|khổ/i);
  });
  it('fps hợp lệ 24', () => expect((run(h({ fps: 24 })) as any).fps).toBe(24));
  it('fps sai', () => bad(h({ fps: 25 }), /fps/));
  it('tệp quá giới hạn vẫn bị kiểm', () => bad(h(), /20 MB/, [{ name: 'a.jpg', kind: 'image', size: 21 * 1024 * 1024 }]));
});
