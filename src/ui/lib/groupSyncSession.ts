/**
 * groupSyncSession.ts
 *
 * Phiên đồng bộ nhóm dùng chung cho cả app, sống ngoài vòng đời component:
 * người dùng đổi tab/màn hình thì vòng lặp vẫn chạy và bảng nổi vẫn hiện.
 * Thuần TypeScript, không import React.
 */

export interface GroupSyncState {
  status: 'idle' | 'running' | 'stopping' | 'done' | 'stopped' | 'failed';
  /** Bước 1: tải danh sách nhóm (không dừng được); bước 2: đồng bộ thành viên (dừng được). */
  step: 1 | 2;
  /** Tổng số nhóm đã tải ở bước 1, dùng cho dòng kết quả. */
  groupTotal: number;
  done: number;
  total: number;
  currentName: string;
  error: string | null;
  minimized: boolean;
}

export interface GroupSyncControl {
  shouldStop(): boolean;
  progress(done: number, total: number, currentName: string): void;
  /** Đổi bước (đặt lại tiến độ của thanh); groupTotal giữ nguyên nếu không truyền. */
  setStep(step: 1 | 2, groupTotal?: number): void;
}

const IDLE: GroupSyncState = { status: 'idle', step: 1, groupTotal: 0, done: 0, total: 0, currentName: '', error: null, minimized: false };

export class GroupSyncSession {
  private state: GroupSyncState = IDLE;
  private listeners = new Set<(s: GroupSyncState) => void>();
  private stopRequested = false;

  getState(): GroupSyncState { return this.state; }

  subscribe(fn: (s: GroupSyncState) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  start(run: (ctl: GroupSyncControl) => Promise<void>): boolean {
    if (this.isActive()) return false;
    this.stopRequested = false;
    this.set({ ...IDLE, status: 'running' });
    const ctl: GroupSyncControl = {
      shouldStop: () => this.stopRequested,
      progress: (done, total, currentName) => {
        if (this.isActive()) this.set({ ...this.state, done, total, currentName });
      },
      setStep: (step, groupTotal) => {
        if (this.isActive()) this.set({ ...this.state, step, done: 0, total: 0, currentName: '', groupTotal: groupTotal ?? this.state.groupTotal });
      },
    };
    let running: Promise<void>;
    try { running = run(ctl); } catch (e) { running = Promise.reject(e); }
    // Kết thúc thì mở lại bảng (minimized=false) để kết quả và nút đóng luôn thấy được.
    running.then(
      () => this.set({ ...this.state, status: this.stopRequested ? 'stopped' : 'done', currentName: '', minimized: false }),
      (e) => this.set({ ...this.state, status: 'failed', currentName: '', minimized: false, error: GroupSyncSession.shortError(e) }),
    );
    return true;
  }

  stop(): void {
    // Bước 1 của syncZaloGroups không đọc cờ dừng, nên chưa cho dừng để khỏi báo "Đang dừng" giả.
    if (this.state.status !== 'running' || this.state.step !== 2) return;
    this.stopRequested = true;
    this.set({ ...this.state, status: 'stopping' });
  }

  setMinimized(v: boolean): void {
    if (this.state.minimized !== v) this.set({ ...this.state, minimized: v });
  }

  dismiss(): void {
    const s = this.state.status;
    if (s === 'done' || s === 'stopped' || s === 'failed') this.set(IDLE);
  }

  private isActive(): boolean { return this.state.status === 'running' || this.state.status === 'stopping'; }

  /** Chỉ chuỗi ngắn: không để đối tượng thô hay stack trace lọt ra giao diện. */
  private static shortError(e: unknown): string {
    const msg = e instanceof Error && typeof e.message === 'string' ? e.message.trim() : '';
    return msg ? msg.slice(0, 120) : 'Lỗi không xác định';
  }

  private set(next: GroupSyncState): void {
    this.state = next;
    this.listeners.forEach((fn) => fn(next));
  }
}

export const groupSyncSession = new GroupSyncSession();

export function groupSyncSummary(s: GroupSyncState): string {
  switch (s.status) {
    case 'running': return s.step === 1
      ? `Bước 1/2 · Đang tải danh sách nhóm ${s.done}/${s.total}`
      : `Bước 2/2 · Đang đồng bộ thành viên ${s.done}/${s.total}`;
    case 'stopping': return 'Đang dừng…';
    case 'done': return `Đã đồng bộ ${s.groupTotal} nhóm`;
    case 'stopped': return `Đã dừng ở bước 2: ${s.done}/${s.total} nhóm`;
    case 'failed': return `Đồng bộ nhóm lỗi: ${s.error}`;
    default: return '';
  }
}
