const BASE_MS = 10_000;
const MAX_MS = 300_000;

/** Độ trễ nối lại bridge E2EE: 10 s nhân đôi mỗi lần, trần 5 phút; attempt không hợp lệ → 10 s. */
export function e2eeReconnectDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 0) return BASE_MS;
  return Math.min(BASE_MS * 2 ** attempt, MAX_MS);
}
