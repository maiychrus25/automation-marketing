/**
 * Thử kết nối lại tài khoản Facebook sau lỗi lúc khởi động: 15 s, 60 s, 180 s rồi dừng.
 * Mỗi lần lỗi hẹn lần kế; `shouldRetry` được đọc lại lúc timer nổ (tắt/xoá/ngắt tay/đã kết nối → bỏ).
 */
const DEFAULT_DELAYS_MS = [15_000, 60_000, 180_000];

export function createStartupRetry(opts: {
  delaysMs?: number[];
  connect: (accountId: string) => Promise<void>;
  shouldRetry: (accountId: string) => boolean;
  log?: (m: string) => void;
}): { schedule(accountId: string): void; clear(accountId: string): void; clearAll(): void } {
  const delays = opts.delaysMs ?? DEFAULT_DELAYS_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Thế hệ theo account: clear() tăng lên để huỷ cả lần connect đang bay.
  const generation = new Map<string, number>();
  let epoch = 0; // clearAll() tăng epoch
  const gen = (id: string): number => (generation.get(id) ?? 0) + epoch * 1e6;

  const clear = (accountId: string): void => {
    const t = timers.get(accountId);
    if (t) clearTimeout(t);
    timers.delete(accountId);
    generation.set(accountId, (generation.get(accountId) ?? 0) + 1);
  };

  const arm = (accountId: string, failed: number): void => {
    if (failed >= delays.length || timers.has(accountId)) return;
    const timer = setTimeout(() => {
      timers.delete(accountId);
      let proceed = false;
      try { proceed = opts.shouldRetry(accountId); } catch { /* coi như không thử nữa */ }
      if (!proceed) return;
      const myGen = gen(accountId);
      opts.connect(accountId).catch((err: any) => {
        if (gen(accountId) !== myGen) return; // đã clear giữa chừng
        opts.log?.(`startup retry ${accountId}: ${err?.message || err}`);
        if (failed + 1 >= delays.length) opts.log?.(`startup ${accountId}: retries exhausted`);
        else arm(accountId, failed + 1);
      });
    }, delays[failed]);
    timer.unref?.();
    timers.set(accountId, timer);
    opts.log?.(`startup ${accountId}: retry in ${Math.round(delays[failed] / 1000)}s (${failed + 1}/${delays.length})`);
  };

  return {
    schedule: (accountId) => arm(accountId, 0),
    clear,
    clearAll: () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      epoch++;
    },
  };
}
