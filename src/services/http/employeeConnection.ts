/**
 * employeeConnection - Quy tắc thuần để máy nhân viên nhận biết gián đoạn (không I/O).
 */
import type { CatchUpAck } from '../socket/catchUpProtocol';

export type ResyncReason =
  | 'boss-restart'
  | 'gap'
  | 'fresh'
  | 'catchup-unverified'
  | 'heartbeat-recovered'
  | 'system-resume';

/** Quá hạn này mà boss chưa trả lời catch-up (boss bản cũ không gọi ack) thì coi như chưa kiểm chứng được. */
export const CATCH_UP_ACK_TIMEOUT_MS = 10000;

/** null = hết giờ / boss bản cũ → không kiểm chứng được; replayed → không cần tải lại. */
export function resyncReasonForAck(ack: CatchUpAck | null): ResyncReason | null {
  if (!ack) return 'catchup-unverified';
  if (ack.status === 'reset') return ack.reason ?? 'gap';
  return null;
}

export function shouldResyncAfterHeartbeat(wasFailing: boolean, nowOk: boolean): boolean {
  return wasFailing && nowOk;
}

/** Sau khi máy thức dậy: chỉ khi heartbeat thành công, và không báo lần hai nếu chính nó đã báo heartbeat-recovered. */
export function shouldResyncAfterResume(heartbeatOk: boolean, alreadyReportedRecovery: boolean): boolean {
  return heartbeatOk && !alreadyReportedRecovery;
}

/** Vị trí trong luồng sự kiện của boss. */
export class StreamPosition {
  bootId: string | null = null;
  lastSeqId = 0;

  /** Envelope không có seqId (sự kiện tức thời) không được làm dịch vị trí. */
  track(envelope: { bootId?: string; seqId?: number }): void {
    if (typeof envelope.seqId !== 'number') return;
    if (envelope.bootId && envelope.bootId !== this.bootId) {
      this.bootId = envelope.bootId;
      this.lastSeqId = envelope.seqId;
    } else if (envelope.seqId > this.lastSeqId) {
      this.lastSeqId = envelope.seqId;
    }
  }

  /** Nhận vị trí boss báo trong ack (sau reset, tránh lần nối sau lại bị coi là boss-restart). */
  adopt(bootId: string, lastSeqId: number | null): void {
    // Ack rỗng cùng luồng: giữ số hiện có; luồng khác: bắt đầu lại từ 0
    if (lastSeqId === null && bootId === this.bootId) return;
    this.bootId = bootId;
    this.lastSeqId = lastSeqId ?? 0;
  }

  request(): { proto: 2; bootId: string | null; lastSeqId: number } {
    return { proto: 2, bootId: this.bootId, lastSeqId: this.lastSeqId };
  }
}
