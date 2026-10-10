import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { saveDraft, getDraft, approveDraft, type DraftDeps } from '../../services/facebookPoster/drafts';
import { scheduleMediaDir } from '../../services/facebookPoster/scheduleMedia';
import { memoryDb } from './helpers';

const NOW = new Date(2026, 9, 10, 10, 0, 0).getTime();
const HOUR = 3_600_000;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function setup() {
  const store = new FacebookPosterStore(memoryDb());
  store.ensureSchema();
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbp-drafts-'));
  dirs.push(baseDir);
  let seq = 0;
  const deps: DraftDeps = {
    store, baseDir, maxSchedules: 200, now: () => NOW, newId: () => `d${++seq}`,
    env: { profileExists: (id) => id === 'p1', fileExists: (p) => fs.existsSync(p), fileSize: (p) => fs.statSync(p).size },
  };
  const file = (name: string, content = 'x') => { const p = path.join(baseDir, name); fs.writeFileSync(p, content); return p; };
  return { store, baseDir, deps, file };
}
const content = (over: Record<string, unknown> = {}) => ({ mode: 'group', text: 'Tuyển Sale', ...over });
const full = (over: Record<string, unknown> = {}) =>
  content({ profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/123456789'] }], ...over });

describe('drafts', () => {
  test('saveDraft chỉ cần nội dung; nháp tắt, không có giờ chạy, scheduler không thấy', () => {
    const { store, deps } = setup();
    const d = saveDraft(deps, { params: content() });
    assert.deepStrictEqual([d.draft, d.enabled, d.nextRunAt, d.kind, d.runAt, d.name], [true, false, null, 'once', null, 'Tuyển Sale']);
    assert.deepStrictEqual(store.listDueSchedules(NOW + 365 * 24 * HOUR), []);
  });

  test('saveDraft từ chối nội dung rỗng', () => {
    const { deps } = setup();
    assert.throws(() => saveDraft(deps, { params: content({ text: '  ' }) }), /Nội dung bài không được để trống/);
  });

  test('saveDraft ghi đè nội dung và thay ảnh: giữ ảnh cũ còn dùng, thêm ảnh mới, bỏ ảnh không dùng', () => {
    const { deps, file, baseDir } = setup();
    const d = saveDraft(deps, { params: content({ mediaPaths: [file('a.jpg', 'A'), file('b.jpg', 'B')] }) });
    const { media } = getDraft(deps, d.id);
    assert.strictEqual(media.length, 2);
    const again = saveDraft(deps, { id: d.id, params: content({ text: 'Mới', mediaPaths: [media[1].path, file('c.jpg', 'C')] }) });
    assert.strictEqual(again.params.text, 'Mới');
    assert.deepStrictEqual(again.params.mediaPaths, ['01-b.jpg', '02-c.jpg']);
    assert.deepStrictEqual([...fs.readdirSync(scheduleMediaDir(baseDir, d.id))].sort(), ['01-b.jpg', '02-c.jpg']);
  });

  test('giờ dự kiến phải ở tương lai khi đổi; nháp đã quá giờ dự kiến vẫn lưu lại được nếu không đổi giờ', () => {
    const { deps, store } = setup();
    assert.throws(() => saveDraft(deps, { params: content(), plannedAt: NOW - HOUR }), /ít nhất 1 phút/);
    const d = saveDraft(deps, { params: content(), plannedAt: NOW + HOUR });
    store.updateSchedule(d.id, { runAt: NOW - HOUR }, NOW); // giả lập: giờ dự kiến đã trôi qua
    const kept = saveDraft(deps, { id: d.id, params: content({ text: 'sửa' }), plannedAt: NOW - HOUR });
    assert.strictEqual(kept.runAt, NOW - HOUR);
    assert.strictEqual(kept.params.text, 'sửa');
  });

  test('saveDraft không sửa được lịch đã duyệt, không nhận id không tồn tại', () => {
    const { deps } = setup();
    const d = saveDraft(deps, { params: full() });
    approveDraft(deps, { id: d.id, when: 'schedule', kind: 'once', runAt: NOW + HOUR });
    assert.throws(() => saveDraft(deps, { id: d.id, params: content() }), /Chỉ sửa được bản nháp/);
    assert.throws(() => saveDraft(deps, { id: 'nope', params: content() }), /Không tìm thấy bản nháp/);
  });

  test('saveDraft tôn trọng giới hạn số lịch', () => {
    const { deps } = setup();
    const small = { ...deps, maxSchedules: 1 };
    saveDraft(small, { params: content() });
    assert.throws(() => saveDraft(small, { params: content() }), /Tối đa 1 lịch/);
  });

  test('approve schedule: thành lịch thật đã bật, có giờ chạy', () => {
    const { deps } = setup();
    const d = saveDraft(deps, { params: full() });
    const s = approveDraft(deps, { id: d.id, when: 'schedule', kind: 'once', runAt: NOW + HOUR });
    assert.deepStrictEqual([s.draft, s.enabled, s.kind, s.runAt, s.nextRunAt], [false, true, 'once', NOW + HOUR, NOW + HOUR]);
  });

  test('approve schedule lặp lại: đặt thứ/giờ và tính lần chạy tới', () => {
    const { deps } = setup();
    const d = saveDraft(deps, { params: full() });
    const s = approveDraft(deps, { id: d.id, when: 'schedule', kind: 'recurring', days: [1, 3, 5], time: '09:30' });
    assert.deepStrictEqual([s.draft, s.enabled, s.kind, [...s.days], s.time], [false, true, 'recurring', [1, 3, 5], '09:30']);
    assert.ok(s.nextRunAt !== null && s.nextRunAt > NOW);
  });

  test('approve now: nextRunAt = now để scheduler chạy qua hàng đợi', () => {
    const { deps, store } = setup();
    const d = saveDraft(deps, { params: full() });
    approveDraft(deps, { id: d.id, when: 'now' });
    assert.deepStrictEqual(store.listDueSchedules(NOW).map((x) => x.id), [d.id]);
  });

  test('approve thất bại (thiếu profile) thì nháp giữ nguyên là nháp', () => {
    const { deps, store } = setup();
    const d = saveDraft(deps, { params: content() });
    assert.throws(() => approveDraft(deps, { id: d.id, when: 'now' }), /Chưa chọn profile/);
    const after = store.getSchedule(d.id)!;
    assert.deepStrictEqual([after.draft, after.enabled, after.nextRunAt], [true, false, null]);
  });

  test('getDraft chỉ trả nháp, kèm đường dẫn tuyệt đối và kích thước ảnh', () => {
    const { deps, file } = setup();
    const d = saveDraft(deps, { params: content({ mediaPaths: [file('a.jpg', 'AAA')] }) });
    const { media } = getDraft(deps, d.id);
    assert.ok(path.isAbsolute(media[0].path));
    assert.strictEqual(media[0].size, 3);
    assert.throws(() => getDraft(deps, 'nope'), /Không tìm thấy bản nháp/);
  });
});
