import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { saveDraft, prepareDraft, getDraft, approveDraft, type DraftDeps } from '../../services/facebookPoster/drafts';
import { scheduleMediaDir } from '../../services/facebookPoster/scheduleMedia';
import { memoryDb } from './helpers';
import { FB_POSTER_SCHEMA_SQL, FB_POSTER_MIGRATIONS } from '../../services/facebookPoster/schema';

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
  test('approvalExpectedRevisionRejectsWithoutMutationAndLegacyStillWorks', () => {
    const { deps, store } = setup();
    const draft = saveDraft(deps, { params: full() });
    store.updateSchedule(draft.id, { name: 'Changed' }, NOW);
    const before = store.getSchedule(draft.id);
    expect(() => approveDraft(deps, { id: draft.id, when: 'now', expectedRevision: draft.revision })).toThrow();
    expect(store.getSchedule(draft.id)).toEqual(before);
    expect(approveDraft(deps, { id: draft.id, when: 'now' })).toMatchObject({ draft: false, enabled: true });
  });
  test.each([false, true])('productionMigrationPreservesRowsAndSupportsLegacyAndCasUpdates(existing=%s)', (existing) => {
    const database = memoryDb();
    const initialize = (migrations: string[]) => {
      database.exec(FB_POSTER_SCHEMA_SQL);
      for (const sql of migrations) { try { database.exec(sql); } catch { /* existing column, like production */ } }
    };
    if (existing) {
      initialize(FB_POSTER_MIGRATIONS.filter((sql) => !/ADD COLUMN revision\b/.test(sql)));
      expect(database.query<{ name: string }>('PRAGMA table_info(fb_poster_schedules)').some((column) => column.name === 'revision')).toBe(false);
      database.run(`INSERT INTO fb_poster_schedules
        (id, name, kind, params_json, run_at, days, time, enabled, draft, next_run_at, created_at, updated_at)
        VALUES ('preserved', 'Original', 'once', '{}', NULL, '', '', 0, 1, NULL, 10, 20)`);
    }
    initialize(FB_POSTER_MIGRATIONS);
    // Do not call store.ensureSchema: DatabaseService initializes using exported SQL/migrations.
    const store = new FacebookPosterStore(database);
    if (!existing) store.createSchedule({ id: 'preserved', name: 'Original', kind: 'once', params: {},
      runAt: null, days: [], time: '', enabled: false, draft: true, nextRunAt: null, createdAt: 10 });
    expect(store.getSchedule('preserved')).toMatchObject({ id: 'preserved', name: 'Original', revision: 1,
      params: {}, draft: true, enabled: false, createdAt: 10, updatedAt: existing ? 20 : 10 });
    store.updateSchedule('preserved', { name: 'Legacy update' }, 30);
    expect(store.getSchedule('preserved')).toMatchObject({ revision: 2, name: 'Legacy update' });
    store.updateSchedule('preserved', { name: 'CAS update' }, 40, 2);
    expect(() => store.updateSchedule('preserved', { name: 'Stale update' }, 50, 2)).toThrow();
    initialize(FB_POSTER_MIGRATIONS);
    expect(store.getSchedule('preserved')).toMatchObject({ revision: 3, name: 'CAS update', createdAt: 10, updatedAt: 40 });
    expect(store.countSchedules()).toBe(1);
  });

  test('preparedRevisionPreservesOldBytesOnCasFailureAndOnlyCleansOwnFiles', () => {
    const { deps, file, store } = setup();
    const original = saveDraft(deps, { params: content({ mediaPaths: [file('old.jpg', 'OLD')] }) });
    expect(original.revision).toBe(1);
    const oldPath = getDraft(deps, original.id).media[0].path;
    const first = prepareDraft(deps, { id: original.id, expectedRevision: 1, params: content({ mediaPaths: [file('new.jpg', 'NEW')] }) });
    const second = prepareDraft(deps, { id: original.id, expectedRevision: 1, params: content({ mediaPaths: [file('other.jpg', 'OTHER')] }) });
    expect(fs.readFileSync(oldPath, 'utf8')).toBe('OLD');
    expect(store.getSchedule(original.id)!.revision).toBe(1);
    const saved = first.commit();
    expect(saved.revision).toBe(2);
    const newPath = getDraft(deps, original.id).media[0].path;
    expect(() => second.commit()).toThrow();
    second.cleanup();
    expect(fs.readFileSync(oldPath, 'utf8')).toBe('OLD');
    expect(fs.readFileSync(newPath, 'utf8')).toBe('NEW');
    expect(store.getSchedule(original.id)!.revision).toBe(2);
  });

  test('lostCommitResponseAndUnreadableRowNeverDeleteReferencedMedia', () => {
    const { deps, file, store } = setup();
    const prepared = prepareDraft(deps, { params: content({ mediaPaths: [file('old.jpg', 'SAVED')] }) });
    const saved = prepared.commit();
    const savedPath = getDraft(deps, saved.id).media[0].path;
    const read = jest.spyOn(store, 'getSchedule').mockReturnValue(null);
    prepared.cleanup();
    read.mockRestore();
    expect(fs.readFileSync(savedPath, 'utf8')).toBe('SAVED');
  });

  test('lateCleanupOfCommittedAttemptKeepsHistoricalRevisionBytes', () => {
    const { deps, file } = setup();
    const first = prepareDraft(deps, { params: content({ mediaPaths: [file('first.jpg', 'FIRST')] }) });
    const saved = first.commit();
    const firstPath = getDraft(deps, saved.id).media[0].path;
    prepareDraft(deps, { id: saved.id, expectedRevision: 1, params: content({ mediaPaths: [file('second.jpg', 'SECOND')] }) }).commit();
    first.cleanup();
    expect(fs.readFileSync(firstPath, 'utf8')).toBe('FIRST');
    expect(fs.readFileSync(getDraft(deps, saved.id).media[0].path, 'utf8')).toBe('SECOND');
  });

  test('expectedRevisionRejectsStaleEditBeforeMediaMutation', () => {
    const { deps, file, store } = setup();
    const original = saveDraft(deps, { params: content({ mediaPaths: [file('old.jpg', 'OLD')] }) });
    const oldPath = getDraft(deps, original.id).media[0].path;
    expect(() => saveDraft(deps, { id: original.id, expectedRevision: 9, params: content({ mediaPaths: [file('new.jpg', 'NEW')] }) })).toThrow();
    expect(fs.readFileSync(oldPath, 'utf8')).toBe('OLD');
    expect(store.getSchedule(original.id)!.revision).toBe(1);
  });

  test('preparedDraftDbFailureKeepsOldRevisionAndBytes', () => {
    const { deps, file, store } = setup();
    const original = saveDraft(deps, { params: content({ mediaPaths: [file('old.jpg', 'OLD')] }) });
    const oldPath = getDraft(deps, original.id).media[0].path;
    const prepared = prepareDraft(deps, { id: original.id, expectedRevision: 1, params: content({ mediaPaths: [file('new.jpg', 'NEW')] }) });
    const update = jest.spyOn(store, 'updateSchedule').mockImplementation(() => { throw new Error('DB failure'); });
    expect(() => prepared.commit()).toThrow('DB failure');
    prepared.cleanup();
    update.mockRestore();
    expect(store.getSchedule(original.id)!.revision).toBe(1);
    expect(fs.readFileSync(oldPath, 'utf8')).toBe('OLD');
  });

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

  describe('chiến dịch', () => {
    const camp = (store: FacebookPosterStore, id: string, status: 'active' | 'paused' | 'archived' = 'active') =>
      store.createCampaign({ id, name: id, goal: '', status, startAt: null, endAt: null, createdAt: NOW, updatedAt: NOW });

    test('saveDraft lưu campaignId vào cột, null để bỏ gắn, vắng thì giữ', () => {
      const { deps, store } = setup();
      camp(store, 'c1');
      const d = saveDraft(deps, { params: content(), campaignId: 'c1' });
      assert.strictEqual(store.getSchedule(d.id)!.campaignId, 'c1');
      saveDraft(deps, { id: d.id, params: content({ text: 'Mới' }) });
      assert.strictEqual(store.getSchedule(d.id)!.campaignId, 'c1');
      saveDraft(deps, { id: d.id, params: content(), campaignId: null });
      assert.strictEqual(store.getSchedule(d.id)!.campaignId, null);
    });

    test('saveDraft từ chối chiến dịch lạ hoặc đã lưu trữ', () => {
      const { deps, store } = setup();
      camp(store, 'old', 'archived');
      assert.throws(() => saveDraft(deps, { params: content(), campaignId: 'nope' }), /^Error: Không tìm thấy chiến dịch$/);
      assert.throws(() => saveDraft(deps, { params: content(), campaignId: 'old' }), /^Error: Chiến dịch đã lưu trữ$/);
      assert.strictEqual(store.countSchedules(), 0);
    });

    test('nháp đã gắn chiến dịch sau đó bị lưu trữ vẫn lưu lại được khi không đổi chiến dịch', () => {
      const { deps, store } = setup();
      camp(store, 'c1');
      const d = saveDraft(deps, { params: content(), campaignId: 'c1' });
      store.updateCampaign('c1', { status: 'archived' }, NOW);
      saveDraft(deps, { id: d.id, params: content({ text: 'Sửa' }), campaignId: 'c1' });
      assert.strictEqual(store.getSchedule(d.id)!.params.text, 'Sửa');
    });

    test('approveDraft đổi chiến dịch, kiểm chiến dịch lưu trữ trước khi ghi gì', () => {
      const { deps, store } = setup();
      camp(store, 'c1'); camp(store, 'old', 'archived');
      const d = saveDraft(deps, { params: full(), campaignId: 'c1' });
      assert.throws(() => approveDraft(deps, { id: d.id, when: 'now', campaignId: 'old' }), /Chiến dịch đã lưu trữ/);
      assert.strictEqual(store.getSchedule(d.id)!.draft, true);
      assert.strictEqual(approveDraft(deps, { id: d.id, when: 'now' }).campaignId, 'c1');
      camp(store, 'c2');
      const d2 = saveDraft(deps, { params: full(), campaignId: 'c1' });
      assert.strictEqual(approveDraft(deps, { id: d2.id, when: 'schedule', kind: 'recurring', days: [1], time: '09:30', campaignId: 'c2' }).campaignId, 'c2');
    });

    test('approveDraft "now" với chiến dịch đã gắn nhưng sau đó lưu trữ: từ chối trước khi ghi; hẹn giờ thì vẫn duyệt được', () => {
      const { deps, store } = setup();
      camp(store, 'c1');
      const d = saveDraft(deps, { params: full(), campaignId: 'c1' });
      store.updateCampaign('c1', { status: 'archived' }, NOW);
      assert.throws(() => approveDraft(deps, { id: d.id, when: 'now' }), /^Error: Chiến dịch đã lưu trữ$/);
      assert.strictEqual(store.getSchedule(d.id)!.draft, true);
      assert.strictEqual(approveDraft(deps, { id: d.id, when: 'schedule', kind: 'once', runAt: NOW + HOUR }).campaignId, 'c1');
    });
  });

  test('variants: [] bỏ biến thể đã lưu; vắng khoá thì bản nháp mới không có; sai thì ném', () => {
    const { deps } = setup();
    const d = saveDraft(deps, { params: content({ variants: ['Bản B'] }) });
    assert.deepStrictEqual(d.params.variants, ['Bản B']);
    const cleared = saveDraft(deps, { id: d.id, params: content({ variants: [] }) });
    assert.ok(!('variants' in cleared.params));
    assert.throws(() => saveDraft(deps, { params: content({ variants: ['Tuyển Sale'] }) }));
  });
});
