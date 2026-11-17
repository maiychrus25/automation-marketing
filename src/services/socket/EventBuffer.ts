/**
 * EventBuffer - Ring buffer lưu event gần nhất để catch-up khi employee reconnect.
 *
 * Đảm bảo KHÔNG MISS event dù employee bị mất kết nối tạm thời:
 * - Boss push mọi event vào buffer với seqId tăng dần
 * - Employee track lastSeqId đã nhận
 * - Reconnect → gửi lastSeqId → Boss replay buffer từ seqId đó
 * - Buffer giới hạn 5000 event gần nhất (MAX_SIZE; cấu hình được bằng setMaxSize)
 */
import { randomUUID } from 'crypto';
import type { RelayAudience } from './relayAudience';

export interface BufferedEvent {
  seqId: number;
  channel: string;
  data: any;
  audience: RelayAudience;
  ts: number;
}

class EventBuffer {
  private buffer: BufferedEvent[] = [];
  private nextSeqId: number;
  private static MAX_SIZE = 5000;
  private prunedCount = 0; // số event đã bị loại trong luồng này
  private readonly now: () => number;
  /** Mã luồng hiện tại; đổi mỗi lần reset để client biết số thứ tự cũ không còn giá trị. */
  public bootId: string;

  constructor(opts: { now?: () => number; bootId?: string } = {}) {
    this.now = opts.now ?? Date.now;
    this.bootId = opts.bootId ?? randomUUID();
    this.nextSeqId = this.now() * 1000 + 1; // luồng sau luôn lớn hơn luồng trước
  }

  /** Có thể cấu hình MAX_SIZE từ ngoài (cho test hoặc tuning) */
  public static setMaxSize(size: number): void {
    // Chỉ cho phép set trước khi có dữ liệu
    EventBuffer.MAX_SIZE = Math.max(100, Math.min(size, 50000));
  }

  /**
   * Thêm event vào buffer, trả về seqId
   */
  push(channel: string, data: any, audience: RelayAudience): number {
    const seqId = this.nextSeqId++;
    const event: BufferedEvent = { seqId, channel, data, audience, ts: Date.now() };
    this.buffer.push(event);

    // Giới hạn kích thước - shift cũ nhất
    if (this.buffer.length > EventBuffer.MAX_SIZE) {
      this.buffer.shift();
      this.prunedCount++;
    }

    return seqId;
  }

  /**
   * Lấy tất cả event có seqId > lastSeqId (dùng cho catch-up)
   * Nếu lastSeqId <= 0 → trả về toàn bộ buffer (initial sync)
   */
  getSince(lastSeqId: number): BufferedEvent[] {
    if (lastSeqId <= 0) return [...this.buffer];
    // Tối ưu: binary search nếu buffer lớn
    // Hiện tại dùng filter tuyến tính (buffer <= 2000, negligible)
    return this.buffer.filter(e => e.seqId > lastSeqId);
  }

  oldestSeqId(): number | null {
    return this.buffer.length ? this.buffer[0].seqId : null;
  }

  newestSeqId(): number | null {
    return this.buffer.length ? this.buffer[this.buffer.length - 1].seqId : null;
  }

  /** Đếm event có seqId > `seqId`; có `accept` thì chỉ đếm event được chấp nhận. */
  countAfter(seqId: number, accept?: (e: BufferedEvent) => boolean): number {
    let n = 0;
    for (let i = this.buffer.length - 1; i >= 0 && this.buffer[i].seqId > seqId; i--) {
      if (!accept || accept(this.buffer[i])) n++;
    }
    return n;
  }

  /**
   * Số event hiện tại trong buffer
   */
  get size(): number {
    return this.buffer.length;
  }

  /** Luồng này đã loại bỏ event do buffer đầy (không còn giữ mọi thứ đã cấp). */
  get evicted(): boolean {
    return this.prunedCount > 0;
  }

  /**
   * Bắt đầu luồng mới: xoá bộ đệm, bootId mới, số thứ tự mới lớn hơn mọi số đã cấp.
   */
  reset(): void {
    this.buffer = [];
    this.bootId = randomUUID();
    this.nextSeqId = Math.max(this.now() * 1000 + 1, this.nextSeqId);
    this.prunedCount = 0;
  }
}

export default EventBuffer;
