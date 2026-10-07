export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Nhãn theo getDay(): 0 = CN, 1 = T2 ... 6 = T7.
const LABELS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

/** Next run strictly after `after` (ms), local time zone; null when none. */
export function computeNextRun(
  s: { kind: 'once' | 'recurring'; runAt: number | null; days: number[]; time: string },
  after: number,
): number | null {
  if (s.kind === 'once') return s.runAt !== null && s.runAt > after ? s.runAt : null;
  if (!TIME_RE.test(s.time)) return null;
  const set = new Set(s.days);
  const [hh, mm] = s.time.split(':').map(Number);
  const base = new Date(after);
  for (let d = 0; d <= 7; d++) {
    const c = new Date(base.getFullYear(), base.getMonth(), base.getDate() + d, hh, mm, 0, 0);
    if (c.getTime() > after && set.has(c.getDay())) return c.getTime();
  }
  return null;
}

/** "T2, T4, T6 lúc 08:00"; Sunday is "CN"; days sorted Monday-first. */
export function describeRecurrence(days: number[], time: string): string {
  const set = new Set(days);
  const picked = MONDAY_FIRST.filter((d) => set.has(d));
  if (picked.length === 7) return `Hằng ngày lúc ${time}`;
  return `${picked.map((d) => LABELS[d]).join(', ')} lúc ${time}`;
}
