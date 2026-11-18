/** Decisions behind pausing an employee's poster schedules when the boss takes access away (pure). */

export const FB_POSTER_MODULE = 'fb_poster';

/** Profiles assigned before the write and not after it. */
export function removedProfileIds(previous: readonly string[], next: readonly string[]): string[] {
  const keep = new Set(next);
  return previous.filter((id) => !keep.has(id));
}

/** True when the employee held `fb_poster` before the write and does not after it (a write that does not mention it changes nothing). */
export function revokedFbPoster(before: Record<string, boolean>, after: Record<string, boolean>): boolean {
  return before[FB_POSTER_MODULE] === true && after[FB_POSTER_MODULE] !== true;
}

/** True when an active account becomes inactive (`is_active` 1 -> 0). */
export function becameInactive(wasActive: unknown, isActiveAfter: unknown): boolean {
  return !!wasActive && isActiveAfter !== undefined && !isActiveAfter;
}
