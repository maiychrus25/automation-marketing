// Lưu nhân viên gồm nhiều lệnh nối nhau (quyền, tài khoản, hồ sơ): lệnh đầu tiên lỗi quyết định thông báo và dừng các lệnh sau.
export interface SaveStep { run: () => Promise<{ success?: boolean; error?: string } | undefined | null | void>; fallback: string }

/** Chạy lần lượt; trả về văn bản lỗi của bước lỗi đầu tiên (success === false hoặc ném lỗi), hoặc null khi tất cả xong. */
export async function firstSaveFailure(steps: readonly SaveStep[], onResult?: (res: unknown) => void): Promise<string | null> {
  for (const step of steps) {
    try {
      const res = await step.run();
      onResult?.(res);
      if (res && res.success === false) return res.error || step.fallback;
    } catch (err) {
      return (err instanceof Error && err.message) || step.fallback;
    }
  }
  return null;
}

/** Số lịch đăng đã tạm dừng mà một kết quả IPC báo (0 khi không có). */
export function pausedOf(res: unknown): number {
  const n = (res as { pausedSchedules?: unknown } | null | undefined)?.pausedSchedules;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Thông báo sau khi lưu; null khi không có lịch nào bị tạm dừng. */
export function pausedNotice(total: number, employeeName: string): string | null {
  return total > 0 ? `Đã tạm dừng ${total} lịch đăng của ${employeeName}. Bật lại trong Lịch đăng nếu bạn muốn giữ.` : null;
}

/** Nối câu chính với thông báo tạm dừng thành một thông báo, không để ".." khi câu chính đã có dấu chấm. */
export function joinNotice(message: string, notice: string | null): string {
  return notice ? `${message.trimEnd().replace(/\.$/, '')}. ${notice}` : message;
}
