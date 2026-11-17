// Lưu nhân viên gồm nhiều lệnh nối nhau (quyền, tài khoản, hồ sơ): lệnh đầu tiên lỗi quyết định thông báo và dừng các lệnh sau.
export interface SaveStep { run: () => Promise<{ success?: boolean; error?: string } | undefined | null | void>; fallback: string }

/** Chạy lần lượt; trả về văn bản lỗi của bước lỗi đầu tiên (success === false hoặc ném lỗi), hoặc null khi tất cả xong. */
export async function firstSaveFailure(steps: readonly SaveStep[]): Promise<string | null> {
  for (const step of steps) {
    try {
      const res = await step.run();
      if (res && res.success === false) return res.error || step.fallback;
    } catch (err) {
      return (err instanceof Error && err.message) || step.fallback;
    }
  }
  return null;
}
