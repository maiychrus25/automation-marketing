import { GroupSyncSession, groupSyncSession, groupSyncSummary, type GroupSyncState } from '../../ui/lib/groupSyncSession';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const flush = () => new Promise<void>((r) => setImmediate(r));

describe('GroupSyncSession', () => {
  it('chạy idle → running → done và báo tiến độ', async () => {
    const s = new GroupSyncSession();
    expect(s.getState().status).toBe('idle');
    const d = deferred();
    expect(s.start(async (ctl) => { ctl.progress(2, 5, 'A'); await d.promise; })).toBe(true);
    expect(s.getState()).toMatchObject({ status: 'running', done: 2, total: 5, currentName: 'A', error: null, minimized: false });
    d.resolve();
    await flush();
    expect(s.getState().status).toBe('done');
  });

  it('start lần hai khi đang chạy trả false và không chạy run mới', async () => {
    const s = new GroupSyncSession();
    const d = deferred();
    s.start(() => d.promise);
    const second = jest.fn(async () => {});
    expect(s.start(second)).toBe(false);
    expect(second).not.toHaveBeenCalled();
    d.resolve();
    await flush();
  });

  it('stop giữa chừng: stopping rồi stopped, shouldStop() đúng', async () => {
    const s = new GroupSyncSession();
    const d = deferred();
    let ctlRef!: { shouldStop(): boolean };
    s.start(async (ctl) => { ctlRef = ctl; ctl.setStep(2); await d.promise; });
    expect(ctlRef.shouldStop()).toBe(false);
    s.stop();
    expect(s.getState().status).toBe('stopping');
    expect(ctlRef.shouldStop()).toBe(true);
    d.resolve();
    await flush();
    expect(s.getState().status).toBe('stopped');
  });

  it('run ném lỗi thành failed kèm thông điệp, không lộ đối tượng thô', async () => {
    const s = new GroupSyncSession();
    s.start(async () => { throw new Error('mất kết nối'); });
    await flush();
    expect(s.getState()).toMatchObject({ status: 'failed', error: 'mất kết nối' });
    s.dismiss();
    s.start(async () => { throw { raw: 1 }; });
    await flush();
    expect(typeof s.getState().error).toBe('string');
    expect(s.getState().error).not.toContain('[object');
  });

  it('start sau done được; dismiss chỉ khi đã kết thúc và về idle', async () => {
    const s = new GroupSyncSession();
    const d = deferred();
    s.start(() => d.promise);
    s.dismiss();
    expect(s.getState().status).toBe('running');
    d.resolve();
    await flush();
    s.dismiss();
    expect(s.getState().status).toBe('idle');
    expect(s.start(async () => {})).toBe(true);
  });

  it('start mở lại bảng đã thu nhỏ; setMinimized đổi cờ', async () => {
    const s = new GroupSyncSession();
    s.setMinimized(true);
    s.start(async () => {});
    expect(s.getState().minimized).toBe(false);
    s.setMinimized(true);
    expect(s.getState().minimized).toBe(true);
    await flush();
  });

  it('người nghe nhận mọi thay đổi và ngừng nhận sau khi huỷ đăng ký', async () => {
    const s = new GroupSyncSession();
    const seen: string[] = [];
    const off = s.subscribe((st) => seen.push(`${st.status}:${st.done}`));
    const d = deferred();
    s.start(async (ctl) => { ctl.progress(1, 3, 'x'); await d.promise; });
    d.resolve();
    await flush();
    expect(seen).toEqual(['running:0', 'running:1', 'done:1']);
    off();
    s.dismiss();
    expect(seen).toHaveLength(3);
  });

  it('groupSyncSession là một thể hiện dùng chung', () => {
    expect(groupSyncSession).toBeInstanceOf(GroupSyncSession);
  });
});

describe('GroupSyncSession - bước và dừng', () => {
  it('start đặt step 1, groupTotal 0; setStep đổi bước, đặt lại tiến độ và giữ groupTotal', async () => {
    const s = new GroupSyncSession();
    const d = deferred();
    s.start(async (ctl) => { ctl.setStep(1, 300); ctl.progress(300, 300, ''); ctl.setStep(2); await d.promise; });
    expect(s.getState()).toMatchObject({ step: 2, groupTotal: 300, done: 0 });
    d.resolve();
    await flush();
    s.dismiss();
    s.start(async () => {});
    expect(s.getState()).toMatchObject({ step: 1, groupTotal: 0 });
    await flush();
  });

  it('stop ở bước 1, khi idle hoặc khi đang stopping là no-op', async () => {
    const s = new GroupSyncSession();
    s.stop();
    expect(s.getState().status).toBe('idle');
    const d = deferred();
    let ctlRef!: { shouldStop(): boolean };
    s.start(async (ctl) => { ctlRef = ctl; await d.promise; });
    s.stop();
    expect(s.getState().status).toBe('running');
    expect(ctlRef.shouldStop()).toBe(false);
    const seen: string[] = [];
    const d2 = deferred();
    s.dismiss();
    d.resolve();
    await flush();
    s.dismiss();
    s.start(async (ctl) => { ctl.setStep(2); await d2.promise; });
    s.stop();
    s.subscribe((st) => seen.push(st.status));
    s.stop();
    expect(seen).toEqual([]);
    d2.resolve();
    await flush();
  });

  it('progress sau khi run kết thúc bị bỏ qua', async () => {
    const s = new GroupSyncSession();
    let ctlRef!: { progress(a: number, b: number, c: string): void };
    s.start(async (ctl) => { ctlRef = ctl; ctl.progress(1, 2, 'a'); });
    await flush();
    ctlRef.progress(9, 9, 'late');
    expect(s.getState()).toMatchObject({ status: 'done', done: 1, total: 2 });
  });

  it('run không kiểm tra shouldStop vẫn kết thúc stopped sau stop() ở bước 2', async () => {
    const s = new GroupSyncSession();
    const d = deferred();
    s.start(async (ctl) => { ctl.setStep(2); await d.promise; });
    s.stop();
    d.resolve();
    await flush();
    expect(s.getState().status).toBe('stopped');
  });

  it('khi run kết thúc, bảng đã thu nhỏ được mở lại', async () => {
    for (const how of ['ok', 'stop', 'fail'] as const) {
      const s = new GroupSyncSession();
      const d = deferred();
      s.start(async (ctl) => { ctl.setStep(2); await d.promise; });
      s.setMinimized(true);
      if (how === 'stop') s.stop();
      if (how === 'fail') d.reject(new Error('x')); else d.resolve();
      await flush();
      expect(s.getState().minimized).toBe(false);
    }
  });

  it('run ném đồng bộ thì thành failed, không kẹt ở running', async () => {
    const s = new GroupSyncSession();
    expect(s.start((() => { throw new Error('sync boom'); }) as any)).toBe(true);
    await flush();
    expect(s.getState()).toMatchObject({ status: 'failed', error: 'sync boom' });
  });
});

describe('groupSyncSummary', () => {
  const st = (p: Partial<GroupSyncState>): GroupSyncState =>
    ({ status: 'idle', step: 1, groupTotal: 0, done: 0, total: 0, currentName: '', error: null, minimized: false, ...p });
  it('các chuỗi tóm tắt', () => {
    expect(groupSyncSummary(st({ status: 'running', step: 1, done: 3, total: 10 }))).toBe('Bước 1/2 · Đang tải danh sách nhóm 3/10');
    expect(groupSyncSummary(st({ status: 'running', step: 2, done: 3, total: 10 }))).toBe('Bước 2/2 · Đang đồng bộ thành viên 3/10');
    expect(groupSyncSummary(st({ status: 'stopping' }))).toBe('Đang dừng…');
    expect(groupSyncSummary(st({ status: 'done', total: 20, groupTotal: 300 }))).toBe('Đã đồng bộ 300 nhóm');
    expect(groupSyncSummary(st({ status: 'stopped', step: 2, done: 4, total: 10 }))).toBe('Đã dừng ở bước 2: 4/10 nhóm');
    expect(groupSyncSummary(st({ status: 'failed', error: 'x' }))).toBe('Đồng bộ nhóm lỗi: x');
  });
});
