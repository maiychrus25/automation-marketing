/** Logic thuần của lần nạp hội thoại nền sau khi nhân viên đăng nhập (không đụng store, IPC hay timer). */

export const EMPLOYEE_BOOTSTRAP_CONCURRENCY = 3;

/** Chạy worker cho từng mục, tối đa `limit` cùng lúc; không ném, một mục lỗi không dừng mục khác. done tính cả mục lỗi. */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  onProgress: (done: number, total: number, failed: number) => void,
): Promise<{ done: number; failed: number }> {
  let next = 0;
  let done = 0;
  let failed = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await worker(item); } catch { failed++; }
      done++;
      try { onProgress(done, items.length, failed); } catch { /* người nghe lỗi không được làm hỏng lượt nạp */ }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return { done, failed };
}

export function bootstrapProgressText(done: number, total: number, failed: number): string | null {
  if (total <= 0) return null;
  if (done < total) return `Đang tải hội thoại ${done}/${total}`;
  return failed > 0 ? `Chưa tải được hội thoại của ${failed} tài khoản` : null;
}

export const shouldRunZaloInit = (isEmployee: boolean): boolean => !isEmployee;

/** Khoá của một tập tài khoản (không phụ thuộc thứ tự, trùng lặp). */
export const bootstrapKey = (ids: readonly string[]): string => Array.from(new Set(ids)).sort().join('|');

/** Có lượt nạp đang chạy cho đúng tập này thì nhập vào lượt đó; tập khác hoặc đang rảnh thì bắt đầu lượt mới. */
export function decideBootstrapRequest(runningKey: string | null, requestedKey: string): 'start' | 'join' {
  return runningKey !== null && runningKey === requestedKey ? 'join' : 'start';
}

export function orderActiveFirst(ids: readonly string[], activeId: string | null): string[] {
  return activeId && ids.includes(activeId) ? [activeId, ...ids.filter((id) => id !== activeId)] : [...ids];
}
