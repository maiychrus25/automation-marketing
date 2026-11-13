/**
 * Hàng đợi sự kiện bridge E2EE theo từng tài khoản: phát tuần tự, giới hạn kích thước, chống trùng, bỏ sự kiện của
 * thế hệ bridge cũ. Không có timer nền: dọn bảng chống trùng ngay trong drain.
 * Thứ tự là thứ tự phát (dispatch); phần xử lý bất đồng bộ của tin không được chờ nếu `process` không trả promise chờ nó.
 */
import Logger from '../../utils/Logger';

export enum EventPriority { LOW = 0, NORMAL = 1, HIGH = 2 }

interface PipelineEvent {
  id: string;
  generation: number;
  priority: EventPriority;
  process: () => Promise<void>;
}

const MAX_QUEUE_SIZE = 500;
/** Chỉ sự kiện quan trọng (NORMAL/HIGH) được dùng phần dư này khi hàng đợi đầy toàn sự kiện quan trọng. */
const MAX_CRITICAL_QUEUE_SIZE = 2000;
const DEDUP_WINDOW_MS = 5000;

/**
 * Khoá chống trùng: loại + id tin; cảm xúc thêm người thả, cảm xúc, thời điểm (thiếu thời điểm → luôn khác nhau); sửa tin thêm lần sửa + chữ mới —
 * để cảm xúc / sửa / thu hồi tới ngay sau chính tin đó không bị coi là bản trùng. Không có id → khoá luôn khác nhau.
 */
export function bridgeEventKey(evt: any): string {
  const type = String(evt?.type || '');
  const data = evt?.data || {};
  const id = data.messageId || data.id;
  if (!id) return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  if (type === 'reaction' || type === 'e2eeReaction') {
    const actor = data.userId ?? data.senderId ?? data.senderJid ?? data.actorId ?? '';
    const key = `${type}:${id}:${actor}:${data.emoji ?? data.reaction ?? ''}:${data.timestampMs ?? ''}`;
    // Bridge không có cờ thêm/gỡ (gỡ = cảm xúc rỗng, kèm timestampMs 0 hoặc không có): thêm-gỡ-thêm cùng emoji sẽ trùng khoá
    // nên khi thiếu dấu thời gian thì mỗi sự kiện là một sự kiện riêng. Ghi DB là idempotent; giao diện thì cộng dồn nếu bridge
    // phát lại đúng sự kiện đó (như trước khi có hàng đợi này).
    return data.timestampMs ? key : `${key}:${Math.random().toString(36).slice(2, 8)}`;
  }
  if (type === 'messageEdit') return `${type}:${id}:${data.editCount ?? ''}:${data.newText ?? ''}`;
  return `${type}:${id}`;
}

export class FacebookEventPipeline {
  private queue: PipelineEvent[] = [];
  private processing = false;
  private stopped = false;
  private currentGeneration = 0;
  /** id → thời điểm xử lý xong (chỉ khi thành công) */
  private seen = new Map<string, number>();
  /** id đang chờ hoặc đang chạy */
  private active = new Set<string>();

  constructor(private readonly accountId: string) {}

  setGeneration(gen: number): void {
    this.currentGeneration = gen;
    const kept = this.queue.filter(e => e.generation >= gen);
    if (kept.length === this.queue.length) return;
    for (const e of this.queue) if (e.generation < gen) this.active.delete(e.id);
    Logger.log(`[EventPipeline:${this.accountId}] Discarded ${this.queue.length - kept.length} stale events (gen < ${gen})`);
    this.queue = kept;
  }

  /** false = sự kiện bị bỏ (trùng, thế hệ cũ, đã dừng, hoặc hàng đợi đầy). */
  enqueue(id: string, priority: EventPriority, generation: number, process: () => Promise<void>): boolean {
    if (this.stopped || generation < this.currentGeneration) return false;
    if (this.isDuplicate(id)) return false;

    if (this.queue.length >= MAX_QUEUE_SIZE) {
      const lowIdx = this.queue.findIndex(e => e.priority === EventPriority.LOW);
      if (lowIdx >= 0) {
        this.active.delete(this.queue[lowIdx].id);
        this.queue.splice(lowIdx, 1);
        Logger.warn(`[EventPipeline:${this.accountId}] Queue full - dropped a LOW event`);
      } else if (priority === EventPriority.LOW) {
        return false;
      } else if (this.queue.length >= MAX_CRITICAL_QUEUE_SIZE) {
        Logger.error(`[EventPipeline:${this.accountId}] Critical queue overflow; recovery is required`);
        return false;
      }
    }

    this.active.add(id);
    this.queue.push({ id, generation, priority, process });
    void this.drain();
    return true;
  }

  /** Đang chờ / đang chạy, hoặc vừa xử lý xong dưới DEDUP_WINDOW_MS: để người gọi phân biệt "trùng" với "đầy". */
  isDuplicate(id: string): boolean {
    const at = this.seen.get(id);
    return this.active.has(id) || (at !== undefined && Date.now() - at < DEDUP_WINDOW_MS);
  }

  getDepth(): number { return this.queue.length; }

  /** cancel=true: bỏ hàng đợi. Sự kiện đang chạy dở vẫn chạy nốt. */
  async stop(cancel: boolean = false): Promise<void> {
    this.stopped = true;
    if (cancel) {
      this.queue = [];
      this.seen.clear();
    }
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift()!;
        if (event.generation < this.currentGeneration) { this.active.delete(event.id); continue; }
        try {
          await event.process();
          this.seen.set(event.id, Date.now());
        } catch (err: any) {
          Logger.error(`[EventPipeline:${this.accountId}] Event ${event.id.slice(0, 40)} failed: ${err?.message}`);
        } finally {
          this.active.delete(event.id);
        }
        this.pruneSeen();
      }
    } finally {
      this.processing = false;
    }
  }

  private pruneSeen(): void {
    const now = Date.now();
    for (const [id, at] of this.seen) if (now - at >= DEDUP_WINDOW_MS) this.seen.delete(id);
  }
}
