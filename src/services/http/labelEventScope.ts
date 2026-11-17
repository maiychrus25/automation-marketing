/**
 * Phạm vi tài khoản của sự kiện nhãn / tin nhắn nhanh, dùng chung cho đường Boss (databaseIpc) và relay.
 * Không import Electron. Các hàm đọc dòng đã lưu: gọi TRƯỚC khi sửa/xoá.
 */
interface LabelAndQuickMessageSource {
  getLocalLabels(): any[];
  getAllLocalQuickMessages(): any[];
}

/** page_ids của nhãn (chuỗi phân cách bằng dấu phẩy hoặc mảng) → danh sách tài khoản. */
export function splitPageIds(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return parts.map((p) => String(p).trim()).filter(Boolean);
}

/** Nhãn toàn cục (page_ids rỗng) → allAccounts; không có nhãn → danh sách rỗng, không cờ (không ai nhận). */
export function storedLabelScope(db: LabelAndQuickMessageSource, id: number): { ownerZaloIds: string[]; allAccounts?: true } {
  const row = db.getLocalLabels().find((l: any) => l.id === id);
  const ownerZaloIds = splitPageIds(row?.page_ids);
  return row && ownerZaloIds.length === 0 ? { ownerZaloIds, allAccounts: true } : { ownerZaloIds };
}

export function storedQuickMessageOwner(db: LabelAndQuickMessageSource, id: number): string | undefined {
  return db.getAllLocalQuickMessages().find((q: any) => q.id === id)?.owner_zalo_id || undefined;
}
