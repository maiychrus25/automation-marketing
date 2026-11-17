// Hàm thuần cho máy nhân viên: chuẩn hoá tài khoản từ ảnh chụp của boss và quyết định phản ứng với sự kiện kết nối Facebook.
import type { FbSessionProblem } from '../../services/facebook/facebookSessionDiagnosis';

/** Một dòng tài khoản của ảnh chụp boss → tài khoản của store. Page giữ channel + parent_zalo_id; dòng cũ là Zalo. */
export function normalizeEmployeeAccount(raw: any) {
  const listenerState = raw.listener_active ?? raw.listenerActive ?? (raw.isConnected ? 1 : 0);
  const fullName = raw.full_name || raw.display_name || raw.zalo_id;
  const channel: string = raw.channel || 'zalo';
  return {
    zalo_id: raw.zalo_id as string,
    display_name: fullName,
    full_name: fullName,
    avatar_url: raw.avatar_url || '',
    phone: raw.phone || '',
    is_business: raw.is_business || 0,
    imei: '',
    user_agent: '',
    cookies: '',
    is_active: raw.is_active ?? 1,
    created_at: '',
    listenerActive: !!listenerState,
    isConnected: !!listenerState,
    isOnline: !!listenerState,
    channel,
    parent_zalo_id: (raw.parent_zalo_id ?? null) as string | null,
    // Giống login:getAccounts của boss: tài khoản Facebook có facebook_id = zalo_id.
    ...(channel === 'facebook' ? { facebook_id: raw.zalo_id as string } : {}),
  };
}

/** Khi fb:onConnectionStatus báo 'connected': nhân viên nạp lại hội thoại từ boss qua REST, boss đọc DB cục bộ. */
export function fbConnectedReloadSource(isEmployee: boolean): 'rest' | 'local' {
  return isEmployee ? 'rest' : 'local';
}

/** Máy nhân viên không chạy bước khởi tạo tài khoản Facebook (AccountInitPanel): Boss đã nối và đồng bộ Page. */
export function shouldCheckFbInit(isEmployee: boolean): boolean {
  return !isEmployee;
}

/** Nội dung thông báo khi Facebook báo 'cookie_expired'. */
export function fbCookieExpiredMessage(isEmployee: boolean, name: string, problem?: FbSessionProblem): string {
  if (isEmployee) return 'Page này đang mất kết nối trên máy Boss. Hãy báo cho Boss kiểm tra.';
  if (problem === 'logged_out') return `Facebook đã đăng xuất tài khoản "${name}". Hãy cập nhật cookie mới để kết nối lại.`;
  if (problem === 'checkpoint') return `Facebook đang yêu cầu xác minh tài khoản "${name}". Hãy mở Facebook trên trình duyệt để xác minh, rồi cập nhật cookie mới.`;
  if (problem === 'unrecognised_page') return `MaiHub không đọc được trang Facebook của tài khoản "${name}" (có thể Facebook vừa đổi trang). Hãy thử kết nối lại; nếu vẫn lỗi thì cập nhật cookie mới.`;
  return `⚠️ Tài khoản Facebook "${name}" bị ngắt kết nối (FB phát hiện bot hoặc cookie hết hạn). Vui lòng đăng nhập lại FB để lấy cookie mới.`;
}

const BOSS_ONLY_FB_CAPS = ['supportsDeleteForMe', 'supportsUnsend', 'supportsForward', 'supportsEdit', 'supportsPoll', 'supportsBlock', 'supportsGroupRename'] as const;

/** Nhân viên + kênh Facebook: tắt các tính năng chạy qua lệnh fb:* chỉ boss làm được (xem employeeChannelRoutes.ts) để không hiện nút chỉ có thể lỗi. */
export function withoutBossOnlyFbCaps<T extends object>(cap: T, isEmployee: boolean, channel?: string): T {
  if (!isEmployee || channel !== 'facebook') return cap;
  return { ...cap, ...Object.fromEntries(BOSS_ONLY_FB_CAPS.map((key) => [key, false])) } as T;
}
