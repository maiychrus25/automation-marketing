import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SCHEDULE_MEDIA_DIR, scheduleMediaDir, copyScheduleMedia, resolveScheduleMedia, removeScheduleMedia, replaceScheduleMedia,
} from '../../services/facebookPoster/scheduleMedia';

describe('scheduleMedia', () => {
  let base: string;
  beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'fbp-media-')); });
  afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

  const makeSource = (name: string, content: string): string => {
    const p = path.join(base, 'src-' + name);
    fs.writeFileSync(p, content);
    return p;
  };

  it('scheduleMediaDir joins base, constant and id', () => {
    assert.strictEqual(SCHEDULE_MEDIA_DIR, 'facebook-poster-media');
    assert.strictEqual(scheduleMediaDir('/b', 'abc-1'), path.join('/b', 'facebook-poster-media', 'abc-1'));
  });

  it('copies in order with NN-sanitized names', () => {
    const a = path.join(base, 'a.jpg'); fs.writeFileSync(a, 'A');
    const b = path.join(base, 'b c.png'); fs.writeFileSync(b, 'B');
    const names = copyScheduleMedia(base, 's1', [a, b]);
    assert.deepStrictEqual(names, ['01-a.jpg', '02-b_c.png']);
    assert.strictEqual(fs.readFileSync(path.join(scheduleMediaDir(base, 's1'), names[1]), 'utf8'), 'B');
  });

  it('copies survive source deletion', () => {
    const a = makeSource('a.jpg', 'AAA');
    const [name] = copyScheduleMedia(base, 's1', [a]);
    fs.rmSync(a);
    assert.strictEqual(fs.readFileSync(path.join(scheduleMediaDir(base, 's1'), name), 'utf8'), 'AAA');
  });

  it('missing source throws and removes the directory', () => {
    const a = makeSource('a.jpg', 'A');
    assert.throws(() => copyScheduleMedia(base, 's1', [a, path.join(base, 'nope.jpg')]));
    assert.strictEqual(fs.existsSync(scheduleMediaDir(base, 's1')), false);
  });

  it('rejects an invalid scheduleId in copy and resolve', () => {
    assert.throws(() => copyScheduleMedia(base, '../x', []), /Mã lịch không hợp lệ/);
    assert.throws(() => resolveScheduleMedia(base, '../x', ['01-a.jpg']), /Mã lịch không hợp lệ/);
  });

  it('resolve joins names under the schedule directory', () => {
    assert.deepStrictEqual(
      resolveScheduleMedia(base, 's1', ['01-a.jpg']),
      [path.join(scheduleMediaDir(base, 's1'), '01-a.jpg')],
    );
  });

  it('resolve keeps a tampered name inside the directory', () => {
    const dir = scheduleMediaDir(base, 's1');
    assert.deepStrictEqual(resolveScheduleMedia(base, 's1', ['../evil.jpg']), [path.join(dir, 'evil.jpg')]);
  });

  it('remove deletes the directory and tolerates a missing one', () => {
    const a = makeSource('a.jpg', 'A');
    copyScheduleMedia(base, 's1', [a]);
    removeScheduleMedia(base, 's1');
    assert.strictEqual(fs.existsSync(scheduleMediaDir(base, 's1')), false);
    assert.doesNotThrow(() => removeScheduleMedia(base, 's1'));
  });

  it('remove with an invalid id does nothing and does not throw', () => {
    const keep = path.join(base, 'keep.txt'); fs.writeFileSync(keep, 'k');
    fs.mkdirSync(path.join(base, SCHEDULE_MEDIA_DIR));
    assert.doesNotThrow(() => removeScheduleMedia(base, '..'));
    assert.doesNotThrow(() => removeScheduleMedia(base, ''));
    assert.ok(fs.existsSync(keep));
    assert.ok(fs.existsSync(path.join(base, SCHEDULE_MEDIA_DIR)));
  });

  it('replaceScheduleMedia: giữ ảnh đang dùng (kể cả tệp nằm trong thư mục lịch), thêm ảnh mới, bỏ ảnh không dùng', () => {
    const first = copyScheduleMedia(base, 's1', [makeSource('a.jpg', 'A'), makeSource('b.jpg', 'B')]);
    assert.deepStrictEqual(first, ['01-src-a.jpg', '02-src-b.jpg']);
    const keep = resolveScheduleMedia(base, 's1', [first[1]]);
    const names = replaceScheduleMedia(base, 's1', [...keep, makeSource('c.jpg', 'C')]);
    assert.deepStrictEqual(names, ['01-src-b.jpg', '02-src-c.jpg']);
    const dir = scheduleMediaDir(base, 's1');
    assert.deepStrictEqual([...fs.readdirSync(dir)].sort(), ['01-src-b.jpg', '02-src-c.jpg']); // spread: mảng realm Node khác realm jest
    assert.strictEqual(fs.readFileSync(path.join(dir, '01-src-b.jpg'), 'utf8'), 'B');
    assert.strictEqual(fs.existsSync(scheduleMediaDir(base, 's1-staging')), false);
  });
});
