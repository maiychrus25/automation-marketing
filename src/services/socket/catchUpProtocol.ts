/**
 * catchUpProtocol - Quyết định cách trả lời yêu cầu nhận bù (thuần, không I/O).
 * Hoặc phát lại đầy đủ từ vị trí của client, hoặc báo `reset` và không phát gì.
 */
export const CATCH_UP_PROTO = 2;
export const CATCH_UP_MAX_REPLAY = 500;
/** Socket chỉ vào phòng nhận trực tiếp sau catch-up đầu tiên; quá hạn này mà không có thì vào luôn (client cũ). */
export const CATCH_UP_JOIN_FALLBACK_MS = 2000;

export type CatchUpResetReason = 'boss-restart' | 'gap' | 'fresh';

export type CatchUpRequest = { proto?: number; bootId?: string | null; lastSeqId?: number | null };

export type CatchUpPlan =
  | { mode: 'replay'; sinceSeqId: number }
  | { mode: 'reset'; reason: CatchUpResetReason }
  | { mode: 'legacy'; sinceSeqId: number };

export type CatchUpAck = {
  proto: 2;
  bootId: string;
  status: 'replayed' | 'reset';
  reason?: CatchUpResetReason;
  lastSeqId: number | null;
};

export interface CatchUpStream {
  bootId: string;
  oldestSeqId: number | null;
  newestSeqId: number | null;
  /** Số event sau seqId mà chính client này được nhận (cùng ảnh chụp quyền với vòng phát lại). */
  countAfter: (seqId: number) => number;
  /** Luồng hiện tại đã loại bỏ event vì đầy: vị trí 0 không còn đủ để biết gì bị lỡ. */
  evicted?: boolean;
}

export function planCatchUp(req: CatchUpRequest, stream: CatchUpStream): CatchUpPlan {
  if (typeof req.proto !== 'number' || req.proto < 2) {
    return { mode: 'legacy', sinceSeqId: req.lastSeqId || 0 };
  }
  const last = req.lastSeqId;
  if (!req.bootId || typeof last !== 'number' || !Number.isFinite(last) || last < 0) {
    return { mode: 'reset', reason: 'fresh' };
  }
  if (req.bootId !== stream.bootId) return { mode: 'reset', reason: 'boss-restart' };
  if (stream.oldestSeqId === null || stream.newestSeqId === null) return { mode: 'replay', sinceSeqId: last };
  // Vị trí 0 cùng luồng: chưa nhận gì; chỉ đủ khi bộ đệm còn giữ mọi thứ đã cấp.
  if (last === 0 ? stream.evicted : last < stream.oldestSeqId - 1 || last > stream.newestSeqId) {
    return { mode: 'reset', reason: 'gap' };
  }
  if (stream.countAfter(last) > CATCH_UP_MAX_REPLAY) return { mode: 'reset', reason: 'gap' };
  return { mode: 'replay', sinceSeqId: last };
}
