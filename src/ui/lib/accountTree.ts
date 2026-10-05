/** Tài khoản tối thiểu để sắp cây: id + id tài khoản cha (Page Facebook). */
export interface TreeAccount {
  zalo_id: string;
  parent_zalo_id?: string | null;
}

/**
 * Thứ tự hiển thị: mỗi Page con đứng ngay sau tài khoản cha, theo thứ tự xuất hiện.
 * Page có cha không nằm trong danh sách giữ vị trí của nó. Không bao giờ làm mất dòng.
 */
export function orderAccountsWithChildren<T extends TreeAccount>(accounts: T[]): T[] {
  const ids = new Set(accounts.map((acc) => acc.zalo_id));
  const hasParent = (acc: T) => !!acc.parent_zalo_id && ids.has(acc.parent_zalo_id);
  const childrenOf = new Map<string, T[]>();
  for (const acc of accounts) {
    if (!hasParent(acc)) continue;
    const list = childrenOf.get(acc.parent_zalo_id!) || [];
    list.push(acc);
    childrenOf.set(acc.parent_zalo_id!, list);
  }

  const out: T[] = [];
  const placed = new Set<T>();
  const place = (acc: T) => {
    if (placed.has(acc)) return;
    placed.add(acc);
    out.push(acc);
    (childrenOf.get(acc.zalo_id) || []).forEach(place);
  };
  accounts.filter((acc) => !hasParent(acc)).forEach(place);
  accounts.forEach(place); // dòng còn sót (quan hệ vòng) đi theo thứ tự gốc
  return out;
}
