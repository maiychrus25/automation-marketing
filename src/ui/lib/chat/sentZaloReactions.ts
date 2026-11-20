// Cảm xúc Zalo do chính cửa sổ này vừa gửi, để nhận ra lần Zalo gửi lại đúng cảm xúc đó (xem zaloReactionEchoPlan).
export const SENT_REACTION_TTL_MS = 60000;

const sent = new Map<string, number[]>();
const keyOf = (zaloId: string, msgId: string, emoji: string) => `${zaloId}\u0000${msgId}\u0000${emoji}`;

export function rememberSentZaloReaction(zaloId: string, msgId: string, emoji: string, now = Date.now()): void {
  // Dọn các lần gửi đã quá hạn (Zalo không gửi lại) để sổ không lớn dần trong phiên.
  for (const [k, times] of sent) { const live = times.filter(t => now - t <= SENT_REACTION_TTL_MS); if (live.length) sent.set(k, live); else sent.delete(k); }
  const key = keyOf(zaloId, msgId, emoji);
  sent.set(key, [...(sent.get(key) || []).filter(t => now - t <= SENT_REACTION_TTL_MS), now]);
}

/** true (và xoá một lần gửi) nếu cảm xúc này vừa được gửi từ đây trong SENT_REACTION_TTL_MS. */
export function takeSentZaloReaction(zaloId: string, msgId: string, emoji: string, now = Date.now()): boolean {
  const key = keyOf(zaloId, msgId, emoji);
  const live = (sent.get(key) || []).filter(t => now - t <= SENT_REACTION_TTL_MS);
  const hit = live.length > 0;
  if (hit) live.shift();
  if (live.length) sent.set(key, live); else sent.delete(key);
  return hit;
}

/** Cửa sổ đang hiện cảm xúc `emoji` của `userId` trên tin có `reactions` này không (dạng lưu trong store hoặc chuỗi JSON từ DB). */
export function windowShowsReaction(reactions: unknown, userId: string, emoji: string): boolean {
  let r: any = reactions;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { return false; } }
  return !!(r && typeof r === 'object' && r.emoji?.[emoji]?.users?.[userId] > 0);
}

/** Bản sao cảm xúc của một tin trước khi hiện tạm, để khôi phục đúng như cũ khi Zalo từ chối (không xoá cảm xúc cũ). */
export function reactionsSnapshot(reactions: unknown): { total: number; lastReact: string; emoji: Record<string, { total: number; users: Record<string, number> }> } {
  let r: any = reactions;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { r = null; } }
  if (!r || typeof r !== 'object' || !r.emoji || typeof r.emoji !== 'object') return { total: 0, lastReact: '', emoji: {} };
  return JSON.parse(JSON.stringify(r));
}
