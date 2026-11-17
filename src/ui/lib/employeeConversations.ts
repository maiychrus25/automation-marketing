import DataAccessor from '@/lib/data/DataAccessor';
import { useChatStore } from '@/store/chatStore';
import { useEmployeeStore } from '@/store/employeeStore';
import { useAccountStore } from '@/store/accountStore';
import { normalizeEmployeeAccount } from '@/lib/employeeAccounts';
import { EMPLOYEE_BOOTSTRAP_CONCURRENCY, bootstrapKey, decideBootstrapRequest, orderActiveFirst, runWithConcurrency } from '@/lib/backgroundLoad';

/** Máy nhân viên: nạp lại hội thoại của một tài khoản từ boss qua REST (db:getContacts cục bộ trống trên máy nhân viên). */
export async function reloadEmployeeConversations(accountId: string, limit = 200, shouldWrite: () => boolean = () => true, strict = false): Promise<void> {
  // strict: REST lỗi/timeout ném lỗi (để lượt nạp/tải lại đếm là thất bại); mặc định giữ hành vi cũ
  const res: any = await DataAccessor.getConversations(accountId, limit, 0, strict ? { throwOnError: true } : undefined);
  if (!shouldWrite()) return;
  if (!Array.isArray(res?.items) || res.items.length === 0) return;
  // Giữ hội thoại cục bộ chưa có trên boss, giống loadEmployeeConversationsForAccounts
  const seen = new Set(res.items.map((c: any) => c.contact_id));
  const current = useChatStore.getState().contacts[accountId] || [];
  useChatStore.getState().setContacts(accountId, [...res.items, ...current.filter((c: any) => !seen.has(c.contact_id))]);
}

// ─── Nạp hội thoại nền sau đăng nhập (một bộ nạp duy nhất cho mọi điểm vào) ─────────────────
interface BootstrapRun { key: string; ids: string[]; promise: Promise<void> }
let epoch = 0; // tăng mỗi khi huỷ/thay lượt; lượt cũ so với giá trị này trước mỗi lần ghi store
let currentRun: BootstrapRun | null = null;

function releaseLoadingFlags(ids: string[]) {
  for (const id of ids) useChatStore.getState().setConversationsLoading(id, false);
}

/** Huỷ lượt đang chạy: kết quả còn lại không được ghi, cờ "đang tải" và tiến độ được dọn. Không đụng employeeInitialLoadDone. */
export function cancelEmployeeBootstrap(): void {
  epoch++;
  useEmployeeStore.getState().setBootstrapProgress(0, 0, 0);
  if (!currentRun) return;
  releaseLoadingFlags(currentRun.ids);
  currentRun = null;
}

// ─── Phiên nhân viên: một lần đăng nhập vào một workspace, kết thúc khi đăng xuất / ngắt kết nối / đổi workspace ─────
let sessionId = 0;
/** Tài khoản đã nạp hội thoại xong thành công trong phiên này (kể cả 0 hội thoại): initialState không nạp lại chúng. */
const loadedAccounts = new Set<string>();
const sessionEndListeners = new Set<() => void>();

/** Chốt phiên hiện tại; hàm trả về cho biết phiên đó còn hiện hành không (kể cả khi không có lượt nạp nào đang chạy). */
export function currentEmployeeSession(): () => boolean {
  const mine = sessionId;
  return () => sessionId === mine;
}

export function onEmployeeSessionEnd(listener: () => void): () => void {
  sessionEndListeners.add(listener);
  return () => { sessionEndListeners.delete(listener); };
}

function endEmployeeSession(): void {
  sessionId++;
  loadedAccounts.clear();
  cancelEmployeeBootstrap();
  sessionEndListeners.forEach((l) => { try { l(); } catch { /* người nghe lỗi không được làm hỏng việc đóng phiên */ } });
}

// Đăng xuất / ngắt kết nối (token rỗng) / đổi workspace (đổi bossUrl) / rời chế độ nhân viên / reset store → kết thúc phiên
useEmployeeStore.subscribe((s, prev) => {
  if ((prev.mode === 'employee' && s.mode !== 'employee')
    || (prev.token && !s.token)
    || (prev.bossUrl && prev.bossUrl !== s.bossUrl)) endEmployeeSession();
});

/**
 * Nạp hội thoại cho các tài khoản ở nền, tối đa 3 tài khoản cùng lúc, tài khoản đang mở trước.
 * - Cùng tập tài khoản đang nạp → nhập vào lượt đó (không chạy lại); tập khác → thay lượt cũ.
 * - Bật employeeInitialLoadDone đúng lúc xong tất cả (kể cả lỗi hoặc không có tài khoản); không bật nếu lượt đã bị huỷ.
 */
export function startEmployeeBootstrap(
  accounts: Array<{ zalo_id: string }>,
  limit = 200,
  /** true: chỉ nạp tài khoản chưa nạp xong trong phiên này (tài khoản rỗng thật không nạp lại); không còn gì để nạp thì không đụng cờ/tiến độ/lượt đang chạy. */
  onlyMissing = false,
): Promise<void> {
  let ids = Array.from(new Set(accounts.map((a) => a.zalo_id)));
  if (onlyMissing && ids.length > 0) {
    ids = ids.filter((id) => !loadedAccounts.has(id));
    // Phần còn thiếu đã nằm trong lượt đang chạy thì nhập vào, không thay lượt
    if (ids.length === 0 || (currentRun && ids.every((id) => currentRun!.ids.includes(id)))) {
      return currentRun ? currentRun.promise : Promise.resolve();
    }
  }
  const key = bootstrapKey(ids);
  if (currentRun && decideBootstrapRequest(currentRun.key, key) === 'join') return currentRun.promise;
  cancelEmployeeBootstrap();
  const myEpoch = epoch;
  const isCurrent = () => epoch === myEpoch;
  const empStore = useEmployeeStore.getState();

  if (ids.length === 0) {
    empStore.setBootstrapProgress(0, 0, 0);
    empStore.setEmployeeInitialLoadDone(true);
    return Promise.resolve();
  }

  empStore.setEmployeeInitialLoadDone(false);
  empStore.setBootstrapProgress(0, ids.length, 0);
  for (const id of ids) useChatStore.getState().setConversationsLoading(id, true);
  const ordered = orderActiveFirst(ids, useAccountStore.getState().activeAccountId);
  const run: BootstrapRun = { key, ids, promise: Promise.resolve() };
  currentRun = run;
  run.promise = (async () => {
    await runWithConcurrency(ordered, EMPLOYEE_BOOTSTRAP_CONCURRENCY, async (id) => {
      try {
        if ((useChatStore.getState().contacts[id]?.length || 0) >= limit) { loadedAccounts.add(id); return; }
        await reloadEmployeeConversations(id, limit, isCurrent, true);
        if (isCurrent()) loadedAccounts.add(id);
      } finally {
        if (isCurrent()) useChatStore.getState().setConversationsLoading(id, false);
      }
    }, (done, total, failed) => {
      if (isCurrent()) useEmployeeStore.getState().setBootstrapProgress(done, total, failed);
    });
    if (!isCurrent()) return;
    currentRun = null;
    useEmployeeStore.getState().setEmployeeInitialLoadDone(true);
  })();
  return run.promise;
}

/** Đặt danh sách tài khoản từ snapshot đăng nhập rồi giao việc nạp hội thoại cho bộ nạp nền (không chờ). */
export function bootstrapAccountsFromSnapshot(snapshot: any): Promise<void> {
  const accounts = (snapshot?.accountsData || []).map(normalizeEmployeeAccount);
  if (accounts.length > 0) {
    useAccountStore.getState().setAccounts(accounts as any);
    const activeAccountId = useAccountStore.getState().activeAccountId;
    if (!activeAccountId || !accounts.some((account: any) => account.zalo_id === activeAccountId)) {
      useAccountStore.getState().setActiveAccount(accounts[0].zalo_id);
    }
  }
  return startEmployeeBootstrap(accounts);
}

/**
 * Đăng nhập lại qua popup kết nối lại. Cùng nhân viên: giữ dữ liệu, nạp các tài khoản đang có.
 * Nhân viên khác: xoá dữ liệu chat và tài khoản của người trước (như khi đổi workspace) rồi lấy tài khoản từ snapshot.
 */
export function bootstrapAfterReconnect(snapshot: any, previousEmployeeId: string | undefined, nextEmployeeId: string): Promise<void> {
  if (!previousEmployeeId || previousEmployeeId === nextEmployeeId) {
    return startEmployeeBootstrap(useAccountStore.getState().accounts);
  }
  useChatStore.getState().resetForWorkspaceSwitch();
  useAccountStore.getState().setActiveAccount(null);
  useAccountStore.getState().setAccounts([]);
  return bootstrapAccountsFromSnapshot(snapshot);
}
