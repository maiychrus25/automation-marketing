import React, { useState, useCallback, useEffect } from 'react';
import { useAppStore } from '@/store/appStore';
import { useEmployeeStore } from '@/store/employeeStore';
import SidebarAccounts from './SidebarAccounts';
import useIsMobile from '@/hooks/useIsMobile';
import { useUpdateStore } from '@/store/updateStore';
import { hasUnseenSettingsTabs } from '@/utils/settingsSeenTabs';
import { useErpPermissions } from '@/hooks/erp/useErpContext';
import { BellIcon, BookIcon, BotIcon, BrainIcon, CampaignIcon, ChartIcon, ChatIcon, CheckIcon, CloudIcon, CreditCardIcon, DiamondIcon, DollarIcon, EditIcon, FileTextIcon, FolderIcon, GlobeIcon, HelpCircleIcon, LightningIcon, LinkIcon, LightbulbIcon, MailIcon, MessageCircleIcon, PackageIcon, RefreshIcon, SaveIcon, SearchIcon, SettingsIcon, ShoppingCartIcon, SmartphoneIcon, StoreIcon, SunIcon, TagIcon, TrendingUpIcon, TruckIcon, UserIcon, UsersIcon, WaveIcon } from '@/components/common/icons';


interface SidebarProps {
  onAddAccount: () => void;
}

const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '?';
/** Cửa sổ hẹp hơn mức này thì sidebar luôn ở dạng thanh icon (spec mục 7.2). */
const FORCE_RAIL_BELOW = 1000;

export default function Sidebar({ onAddAccount }: SidebarProps) {
  const previewEmployeeId = useEmployeeStore(s => s.previewEmployeeId);
  const empMode = useEmployeeStore(s => s.mode);
  // Subscribe so Sidebar re-renders when permissions / employees list changes
  const empPermissions = useEmployeeStore(s => s.permissions);
  const employees = useEmployeeStore(s => s.employees);
  const isSimulating = empMode !== 'employee' && !!previewEmployeeId;

  const hasPerm = useCallback((module: string) => {
    if (module === 'dashboard') return true;

    // Boss preview mode: use previewed employee's permissions
    if (empMode !== 'employee' && previewEmployeeId) {
      const emp = employees.find((e: any) => e.employee_id === previewEmployeeId);
      const perm = emp?.permissions?.find((p: any) => p.module === module);
      return perm ? !!perm.can_access : false;
    }

    // Boss/standalone has full access
    if (empMode !== 'employee') return true;

    // Real employee mode
    return !!empPermissions[module];
  }, [empMode, previewEmployeeId, employees, empPermissions]);
  // ERP-specific permission check (role-based, independent from Zalo ACL).
  const { can: canErp } = useErpPermissions();
  const canErpAccess = canErp('erp.access');
  const { view, setView, sidebarCollapsed, windowAppearance } = useAppStore();
  const crmRequestUnseenByAccount = useAppStore(s => s.crmRequestUnseenByAccount);
  const forceRail = useIsMobile(FORCE_RAIL_BELOW);
  const collapsed = sidebarCollapsed || forceRail;
  const isMac = windowAppearance.platform === 'darwin';

  const [showToolsGuide, setShowToolsGuide] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(view === 'workflow' || view === 'integration');
  const hasNewCRMRequests = Object.values(crmRequestUnseenByAccount || {}).some(Boolean);

  // Red dot cho CRM → Nhóm → Quét thành viên (chưa xem)
  const hasScanNewDot = (() => {
    try { return localStorage.getItem('scanTabSeen') !== 'true'; } catch { return false; }
  })();

  // Chấm đỏ trên nút Settings - tắt khi người dùng đã xem hết các tab quan trọng
  const [hasNewSettings, setHasNewSettings] = useState(() => hasUnseenSettingsTabs());
  useEffect(() => {
    const handler = () => setHasNewSettings(hasUnseenSettingsTabs());
    window.addEventListener('settings:tabSeen', handler);
    return () => window.removeEventListener('settings:tabSeen', handler);
  }, []);

  const toolItems = [
    ...(hasPerm('workflow') ? [{ icon: 'workflow', label: 'Workflow (n8n)', view: 'workflow' as const }] : []),
    ...(hasPerm('integration') ? [{ icon: 'integration', label: 'Tích hợp', view: 'integration' as const }] : []),
  ];

  return (
    <aside className={`app-sidebar ${collapsed ? 'is-collapsed' : ''}`} aria-label="Thanh bên">
      {/* Hàng đầu: vùng kéo cửa sổ; trên macOS chứa traffic light */}
      <div className="app-sidebar-head app-drag" />

      <SidebarBrand collapsed={collapsed} macRail={collapsed && isMac} />

      <SidebarAccounts collapsed={collapsed} onAddAccount={onAddAccount} />

      <div className="app-group-title">{!collapsed && <span>Điều hướng</span>}</div>
      <nav className="app-nav">
        <NavItem icon="dashboard" label="Tổng quan" collapsed={collapsed} active={view === 'dashboard'} onClick={() => setView('dashboard')} />
        {hasPerm('chat') && (
          <NavItem icon="chat" label="Chat" collapsed={collapsed} active={view === 'chat'} onClick={() => setView('chat')} />
        )}
        {hasPerm('crm') && (
          <NavItem icon="crm" label="CRM" collapsed={collapsed} active={view === 'crm'} onClick={() => setView('crm')} dot={hasNewCRMRequests || hasScanNewDot} />
        )}
        {toolItems.length > 0 && (
          <>
            <NavItem
              icon="tools"
              label="Công cụ"
              collapsed={collapsed}
              active={!toolsOpen && (view === 'workflow' || view === 'integration')}
              expanded={toolsOpen}
              onClick={() => setToolsOpen(v => !v)}
            />
            {toolsOpen && (
              <>
                {toolItems.map(item => (
                  <NavItem key={item.view} icon={item.icon} label={item.label} collapsed={collapsed} sub active={view === item.view} onClick={() => setView(item.view)} />
                ))}
                <NavItem icon="book" label="Hướng dẫn sử dụng" collapsed={collapsed} sub active={false} onClick={() => setShowToolsGuide(true)} />
              </>
            )}
          </>
        )}
        {hasPerm('analytics') && (
          <NavItem icon="analytics" label="Báo cáo" collapsed={collapsed} active={view === 'analytics'} onClick={() => setView('analytics')} />
        )}
        {/* ERP - gated by module permission AND ERP RBAC (`erp.access`).
            Inside ERP, fine-grained writes enforced via `useErpPermissions().can(...)` +
            IPC middleware `withErpAuth`. */}
        {hasPerm('erp') && canErpAccess && (
          <NavItem icon="erp" label="Quản lý công việc" collapsed={collapsed} active={view === 'erp'} onClick={() => setView('erp')} />
        )}
        {/* Browser profiles - Boss/Standalone only; hidden while previewing an employee */}
        {empMode !== 'employee' && !isSimulating && (
          <NavItem icon="browser" label="Trình duyệt" collapsed={collapsed} active={view === 'browser'} onClick={() => setView('browser')} />
        )}
      </nav>

      <div className="app-sidebar-bottom">
        <NavItem icon="settings" label="Cài đặt" collapsed={collapsed} active={view === 'settings'} onClick={() => setView('settings')} dot={hasNewSettings} />
      </div>

      {/* Tools Guide Modal */}
      {showToolsGuide && <ToolsGuideModal onClose={() => setShowToolsGuide(false)} />}
    </aside>
  );
}

/** Logo, tên app, phiên bản và nhãn cập nhật (chuyển từ TopBar). */
function SidebarBrand({ collapsed, macRail }: { collapsed: boolean; macRail: boolean }) {
  const { status: updateStatus, updateInfo, openUpdatePopup } = useUpdateStore();
  const hasUpdate = !!updateInfo && (updateStatus === 'available' || updateStatus === 'downloading' || updateStatus === 'downloaded');
  const updateTitle = !updateInfo ? '' : updateStatus === 'downloaded'
    ? `Đã tải xong v${updateInfo.version} — nhấn để cài đặt`
    : updateStatus === 'downloading'
      ? `Đang tải v${updateInfo.version}...`
      : `Có bản mới v${updateInfo.version} - nhấn để cập nhật`;
  // Giữ màu theo trạng thái như nhãn cũ ở TopBar.
  const pillClass = updateStatus === 'downloaded'
    ? 'bg-green-500/15 border border-green-500/30 text-green-500 hover:bg-green-500/25'
    : updateStatus === 'downloading'
      ? 'bg-blue-500/15 border border-blue-500/30 text-blue-400 hover:bg-blue-500/25'
      : 'bg-orange-500/15 border border-orange-500/30 text-orange-600 hover:bg-orange-500/25';
  const dotClass = updateStatus === 'downloaded' ? 'bg-green-500' : updateStatus === 'downloading' ? 'bg-blue-500' : 'bg-orange-500';

  // macOS thu gọn: hàng đầu đã có traffic light, chỉ hiện chấm cập nhật (nếu có).
  if (macRail) {
    return hasUpdate ? (
      <div className="flex justify-center pb-1 flex-shrink-0">
        <button type="button" onClick={openUpdatePopup} title={updateTitle} aria-label={updateTitle} className={`w-2.5 h-2.5 rounded-full ${dotClass}`} />
      </div>
    ) : null;
  }

  return (
    <div className="app-brand">
      <span className="relative flex-shrink-0">
        <AppMark />
        {collapsed && hasUpdate && (
          <button type="button" onClick={openUpdatePopup} title={updateTitle} aria-label={updateTitle}
            className={`absolute -top-1 -right-1 w-3 h-3 rounded-full border-2 border-gray-900 ${dotClass}`} />
        )}
      </span>
      {!collapsed && (
        <>
          <span className="app-brand-name">AHV Connect</span>
          {hasUpdate ? (
            <button type="button" onClick={openUpdatePopup} title={updateTitle}
              className={`ml-auto px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap transition-colors ${pillClass}`}>
              {updateStatus === 'downloaded' ? `Sẵn sàng v${updateInfo!.version}` : `New v${updateInfo!.version}`}
            </button>
          ) : (
            <span className="app-brand-version">v{APP_VERSION}</span>
          )}
        </>
      )}
    </div>
  );
}

/** Dấu hiệu MaiHub (bản rút gọn của resources/icons/icon.svg, giữ nguyên hình). */
function AppMark() {
  return (
    <svg viewBox="0 0 100 100" className="app-brand-mark" aria-hidden="true">
      <defs>
        <linearGradient id="maihubMarkBg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1E40AF" />
          <stop offset="1" stopColor="#3B82F6" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="22" ry="22" fill="url(#maihubMarkBg)" />
      <g fill="#FFFFFF">
        <circle cx="50.00" cy="27.00" r="18.5" />
        <circle cx="71.87" cy="42.89" r="18.5" />
        <circle cx="63.52" cy="68.61" r="18.5" />
        <circle cx="36.48" cy="68.61" r="18.5" />
        <circle cx="28.13" cy="42.89" r="18.5" />
      </g>
      <circle cx="50" cy="50" r="8" fill="#1E40AF" />
    </svg>
  );
}

function NavItem({ icon, label, active, onClick, dot, collapsed, expanded, sub }: {
  icon: string;
  label: string;
  active: boolean;
  onClick: () => void;
  dot?: boolean;
  collapsed: boolean;
  /** Có giá trị khi mục mở/đóng được một nhóm con. */
  expanded?: boolean;
  sub?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      aria-expanded={expanded}
      className={`app-nav-item ${active ? 'is-active' : ''} ${sub && !collapsed ? 'is-sub' : ''}`}
    >
      {icon === 'book' ? <BookIcon className="w-4 h-4" /> : <NavIcon name={icon} />}
      {!collapsed && <span className="app-nav-label">{label}</span>}
      {!collapsed && expanded !== undefined && (
        <svg className="app-nav-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M9 6l6 6-6 6" /></svg>
      )}
      {dot && <span className="app-nav-dot" aria-hidden="true" />}
    </button>
  );
}

// ─── Shared icon component ────────────────────────────────────────────────────

function NavIcon({ name }: { name: string }) {
  switch (name) {
    case 'dashboard':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      );
    case 'chat':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case 'friends':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case 'crm':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="3"/>
        <path d="M7 14v3"/>
        <path d="M12 10v7"/>
        <path d="M17 7v10"/>
      </svg>
      );
    case 'workflow':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round">
        <circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/>
        <circle cx="12" cy="18" r="2"/>
        <path d="M7 6h10M5 8v4a7 7 0 0 0 7 7M19 8v4a7 7 0 0 1-7 7"/>
      </svg>
      );
    case 'integration':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
      </svg>
      );
    case 'analytics':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 21H4.6c-.56 0-.84 0-1.054-.109a1 1 0 0 1-.437-.437C3 20.24 3 19.96 3 19.4V3"/>
          <path d="M7 14l4-4 4 4 6-6"/>
        </svg>
      );
    case 'facebook':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>
        </svg>
      );
    case 'tools':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
          <line x1="12" y1="12" x2="12" y2="12.01"/>
        </svg>
      );
    case 'erp':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
        </svg>
      );
    case 'browser':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
      );
    case 'settings':
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
      );
    default:
      return null;
  }
}


// ─── Tools Guide Modal ────────────────────────────────────────────────────────

const TOOLS_GUIDE = [
  {
    id: 'crm' as const,
    icon: <ChartIcon className="w-4 h-4" />, title: 'CRM - Quản lý khách hàng',
    color: 'border-blue-500/40 bg-blue-900/30',
    badgeColor: 'bg-gray-800 text-gray-300',
    purpose: 'Quản lý toàn bộ danh sách liên hệ Zalo, phân loại khách hàng bằng nhãn, ghi chú nội bộ, và chạy chiến dịch nhắn tin hàng loạt - biến Zalo thành CRM chuyên nghiệp.',
    sections: [
      {
        icon: <UsersIcon className="w-4 h-4 inline" />,
        title: 'Quản lý liên hệ',
        items: [
          'Xem tất cả liên hệ theo tài khoản Zalo: bạn bè, nhóm, stranger (người lạ)',
          'Bộ lọc nâng cao: theo nhãn, trạng thái (đã nhắn / chưa nhắn), loại liên hệ, thời gian',
          'Xem thông tin chi tiết: avatar, tên, SĐT, nhãn, ghi chú, lịch sử tương tác',
          'Dashboard tổng quan: thống kê số lượng liên hệ, tương tác, nhãn phân bố',
        ],
      },
      {
        icon: <TagIcon className="w-4 h-4 inline" />,
        title: 'Hệ thống nhãn kép',
        items: [
          'Nhãn Zalo (Zalo Label): đồng bộ 2 chiều với app Zalo trên điện thoại - gán từ AHV Connect, thấy trên Zalo và ngược lại',
          'Nhãn Local: nhãn riêng của AHV Connect, tùy biến màu sắc + emoji, không giới hạn số lượng',
          'Dùng nhãn làm điều kiện lọc trong chiến dịch (chỉ gửi cho khách có nhãn "VIP")',
          'Dùng nhãn làm Trigger trong Workflow: khi gắn nhãn → tự động chạy luồng xử lý',
        ],
      },
      {
        icon: <FileTextIcon className="w-4 h-4 inline" />,
        title: 'Ghi chú nội bộ (Notes)',
        items: [
          'Thêm ghi chú riêng cho từng liên hệ - khách hàng không thấy được',
          'Chỉnh sửa / xóa ghi chú bất kỳ lúc nào',
          'Xem lại toàn bộ ghi chú theo dòng thời gian trong panel chi tiết',
        ],
      },
      {
        icon: <CampaignIcon className="w-4 h-4 inline" />,
        title: 'Chiến dịch nhắn tin hàng loạt',
        items: [
          'Tạo chiến dịch: chọn đối tượng theo nhãn / bộ lọc → soạn mẫu tin → gửi',
          'Hỗ trợ biến động: chèn tên khách, SĐT, nhãn... vào nội dung tin nhắn tự động',
          'Giới hạn tốc độ gửi tự động: tối đa 60 tin/giờ, delay giữa mỗi tin (tránh spam)',
          'Theo dõi realtime: đã gửi / thất bại / phản hồi - dừng/tiếp tục chiến dịch mọi lúc',
          'Lịch sử gửi chi tiết: xem từng tin đã gửi, trạng thái, thời gian',
        ],
      },
    ],
  },
  {
    id: 'workflow' as const,
    icon: <LightningIcon className="w-4 h-4" />, title: 'Workflow - Tự động hoá',
    color: 'border-purple-500/40 bg-purple-900/30',
    badgeColor: 'bg-gray-800 text-gray-300',
    purpose: 'Tạo các luồng xử lý tự động bằng giao diện kéo-thả trực quan: nhận sự kiện → xử lý logic → thực hiện hành động. Không cần viết code, có sẵn 20+ mẫu workflow.',
    sections: [
      {
        icon: <LightningIcon className="w-4 h-4 inline" />,
        title: 'Trigger - 8 loại sự kiện kích hoạt',
        items: [
          'Khi nhận tin nhắn: lọc theo từ khóa, loại hội thoại (cá nhân/nhóm), regex',
          'Khi có lời mời kết bạn → tự động chấp nhận + gửi lời chào',
          'Khi có sự kiện nhóm: thành viên vào/rời, đổi admin, đổi avatar nhóm',
          'Khi có người react tin nhắn (like, heart, haha...)',
          'Khi gắn/gỡ nhãn: liên kết CRM → Workflow liền mạch',
          'Chạy theo lịch hẹn (cron): hàng ngày, hàng giờ, ngày cụ thể',
          'Khi nhận thanh toán (webhook từ Casso/SePay)',
          'Chạy thủ công: nút bấm test từ giao diện',
        ],
      },
      {
        icon: <MessageCircleIcon className="w-4 h-4 inline" />,
        title: 'Action - 15+ thao tác trên Zalo',
        items: [
          'Gửi tin nhắn văn bản (hỗ trợ biến động {{ tên }}, {{ sdt }}...)',
          'Hiệu ứng "đang gõ..." + delay → tạo cảm giác tự nhiên như người thật',
          'Gửi ảnh (từ file hoặc URL), gửi file đính kèm (PDF, Excel...)',
          'Tìm user bằng SĐT, lấy thông tin người dùng (avatar, tên, giới tính)',
          'Chấp nhận / Từ chối / Gửi lời mời kết bạn tự động',
          'Quản lý nhóm: thêm/xóa thành viên, tạo bình chọn (poll)',
          'Gắn/gỡ nhãn, thu hồi tin nhắn, chuyển tiếp tin nhắn, thả cảm xúc',
        ],
      },
      {
        icon: <BrainIcon className="w-4 h-4 inline" />,
        title: 'Logic & Dữ liệu',
        items: [
          'Rẽ nhánh IF/ELSE: kiểm tra điều kiện → chạy nhánh tương ứng',
          'Switch: phân nhiều nhánh theo giá trị (VD: phân loại câu hỏi)',
          'Lặp forEach: lặp qua danh sách rồi xử lý từng item',
          'Lưu biến, dừng workflow nếu điều kiện đúng, chờ N giây',
          'Ghép nội dung văn bản, chọn ngẫu nhiên, định dạng ngày giờ, đọc JSON',
        ],
      },
      {
        icon: <BotIcon className="w-4 h-4 inline" />,
        title: 'AI & Tích hợp ngoài',
        items: [
          'AI tạo nội dung: ChatGPT, Gemini, Deepseek, Grok - chatbot thông minh',
          'AI phân loại tin nhắn: tự nhận diện hỏi giá / khiếu nại / hỗ trợ kỹ thuật...',
          'Google Sheets: ghi dữ liệu, đọc dữ liệu, cập nhật ô - biến Sheets thành database',
          'Gửi thông báo Telegram, Discord, Email, ghi vào Notion Database',
          'Gọi API/Webhook HTTP bên ngoài: kết nối bất kỳ hệ thống nào',
        ],
      },
      {
        icon: <StoreIcon className="w-4 h-4 inline" />,
        title: 'POS & Vận chuyển trong Workflow',
        items: [
          'KiotViet / Haravan / Sapo / Nhanh: tra cứu KH, đơn hàng, sản phẩm, tạo đơn',
          'GHN / GHTK: tạo đơn vận chuyển, tra cứu vận đơn - ngay trong luồng tự động',
          'Casso / SePay (VietQR): lấy lịch sử giao dịch, đối soát thanh toán',
        ],
      },
    ],
  },
  {
    id: 'integration' as const,
    icon: <LinkIcon className="w-4 h-4" />, title: 'Tích hợp - Kết nối bên thứ 3',
    color: 'border-green-500/40 bg-green-900/30',
    badgeColor: 'bg-gray-800 text-gray-300',
    purpose: 'Kết nối AHV Connect với hệ sinh thái bán hàng, thanh toán, vận chuyển Việt Nam. Tra cứu dữ liệu ngay trong khung chat, nhận webhook tự động, kết hợp Workflow để xử lý end-to-end.',
    sections: [
      {
        icon: <ShoppingCartIcon className="w-4 h-4 inline" />,
        title: 'POS / Bán hàng (4 nền tảng)',
        items: [
          'KiotViet: tra cứu khách hàng, đơn hàng, sản phẩm, tạo đơn - phổ biến nhất VN',
          'Haravan: nền tảng TMĐT, tra cứu đơn hàng online, khách hàng',
          'Sapo: quản lý bán hàng đa kênh, tra cứu đơn/khách theo SĐT',
          'Nhanh.vn: tra cứu đơn, sản phẩm, khách hàng, tạo đơn',
          '→ Tất cả đều tra cứu trực tiếp từ khung chat bằng nút tắt hoặc shortcut',
        ],
      },
      {
        icon: <CreditCardIcon className="w-4 h-4 inline" />,
        title: 'Thanh toán (2 nền tảng)',
        items: [
          'Casso: kết nối ngân hàng, nhận webhook khi có chuyển khoản mới - realtime',
          'SePay (VietQR): tương tự Casso, hỗ trợ nhiều ngân hàng VN',
          'Webhook tự nhận về app tại http://127.0.0.1:9888/webhook/{type}',
          'Kết hợp Workflow trigger.payment → gửi tin cảm ơn + xác nhận đơn tự động',
        ],
      },
      {
        icon: <TruckIcon className="w-4 h-4 inline" />,
        title: 'Vận chuyển (2 nền tảng)',
        items: [
          'GHN Express: tạo đơn giao hàng, tra cứu mã vận đơn + trạng thái',
          'GHTK: tạo đơn + tra cứu tracking - đối soát COD',
        ],
      },
      {
        icon: <GlobeIcon className="w-4 h-4 inline" />,
        title: 'Tunnel - Mở kết nối ra internet',
        items: [
          'Bật thủ công khi cần: tạo URL công khai (https://xxx.loca.lt) trỏ về app',
          'Cho phép bên ngoài (Casso, SePay, n8n cloud...) gửi webhook về AHV Connect',
          'Không bật = webhook chỉ hoạt động trên localhost (cùng máy)',
          'Tắt bất cứ lúc nào - không ảnh hưởng các tính năng khác',
        ],
      },
      {
        icon: <LightningIcon className="w-4 h-4 inline" />,
        title: 'Shortcut tra cứu nhanh',
        items: [
          'Ghim các nút tra cứu POS/vận chuyển ngay trên thanh công cụ chat',
          'Bấm 1 lần → tra cứu đơn hàng / khách hàng theo SĐT người đang chat',
          'Kết quả hiển thị ngay trong popup - không cần rời khung chat',
        ],
      },
    ],
  },
];

// ─── Combination scenarios ────────────────────────────────────────────────────

const COMBO_SCENARIOS = [
  {
    icon: <DollarIcon className="w-4 h-4" />,
    title: 'Xác nhận thanh toán tự động',
    tags: ['Tích hợp', 'Workflow'],
    color: 'border-emerald-500/30',
    flow: [
      { icon: <LinkIcon className="w-3 h-3" />, text: 'SePay/Casso nhận CK' },
      { icon: <SettingsIcon className="w-3 h-3" />, text: 'Trigger payment' },
      { icon: <EditIcon className="w-3 h-3" />, text: 'Ghép tin "Cảm ơn {tên}, đơn #{mã} đã nhận {số tiền}"' },
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Gửi tin Zalo' },
      { icon: <TagIcon className="w-3 h-3" />, text: 'Gắn nhãn "Đã TT"' },
    ],
    desc: 'Khách chuyển khoản → AHV Connect nhận webhook từ ngân hàng → Workflow tự động gửi tin xác nhận + gắn nhãn CRM.',
  },
  {
    icon: <BotIcon className="w-4 h-4" />,
    title: 'Chatbot AI tư vấn bán hàng',
    tags: ['Workflow', 'AI'],
    color: 'border-violet-500/30',
    flow: [
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Khách nhắn hỏi' },
      { icon: <BrainIcon className="w-3 h-3" />, text: 'AI phân loại (hỏi giá / CSKH / khiếu nại)' },
      { icon: <BotIcon className="w-3 h-3" />, text: 'ChatGPT trả lời theo ngữ cảnh' },
      { icon: <EditIcon className="w-3 h-3" />, text: 'Typing + delay' },
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Gửi phản hồi' },
    ],
    desc: 'Khách nhắn tin → AI tự phân loại câu hỏi → ChatGPT sinh nội dung trả lời phù hợp → gửi tự động với hiệu ứng đang gõ.',
  },
  {
    icon: <WaveIcon className="w-4 h-4" />,
    title: 'Chào mừng + phân loại khách mới',
    tags: ['Workflow', 'CRM'],
    color: 'border-blue-500/30',
    flow: [
      { icon: <UserIcon className="w-3 h-3" />, text: 'Nhận lời mời KB' },
      { icon: <CheckIcon className="w-3 h-3" />, text: 'Auto chấp nhận' },
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Gửi tin chào' },
      { icon: <TagIcon className="w-3 h-3" />, text: 'Gắn nhãn "Khách mới"' },
      { icon: <TrendingUpIcon className="w-3 h-3" />, text: 'Ghi Google Sheets' },
    ],
    desc: 'Khi có người gửi kết bạn → auto accept → gửi lời chào + menu dịch vụ → gắn nhãn CRM → ghi thông tin vào Sheets.',
  },
  {
    icon: <ShoppingCartIcon className="w-4 h-4" />,
    title: 'Tra cứu đơn hàng ngay trong chat',
    tags: ['Tích hợp', 'Workflow'],
    color: 'border-orange-500/30',
    flow: [
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Khách nhắn "đơn hàng"' },
      { icon: <SearchIcon className="w-3 h-3" />, text: 'KiotViet tra SĐT' },
      { icon: <EditIcon className="w-3 h-3" />, text: 'Ghép kết quả' },
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Gửi thông tin đơn' },
    ],
    desc: 'Khách hỏi về đơn hàng → Workflow tự tra cứu KiotViet/Haravan theo SĐT → gửi lại thông tin đơn chi tiết.',
  },
  {
    icon: <CampaignIcon className="w-4 h-4" />,
    title: 'Chiến dịch remarketing theo nhãn',
    tags: ['CRM', 'Workflow'],
    color: 'border-pink-500/30',
    flow: [
      { icon: <ChartIcon className="w-3 h-3" />, text: 'Lọc KH nhãn "Chưa mua"' },
      { icon: <CampaignIcon className="w-3 h-3" />, text: 'Tạo chiến dịch' },
      { icon: <EditIcon className="w-3 h-3" />, text: 'Soạn tin ưu đãi' },
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Gửi hàng loạt (60 tin/h)' },
      { icon: <TrendingUpIcon className="w-3 h-3" />, text: 'Theo dõi phản hồi' },
    ],
    desc: 'Lọc danh sách khách có nhãn cụ thể → tạo chiến dịch với nội dung cá nhân hóa → gửi tự động + theo dõi kết quả.',
  },
  {
    icon: <PackageIcon className="w-4 h-4" />,
    title: 'Đặt hàng + giao hàng tự động',
    tags: ['Tích hợp', 'Workflow'],
    color: 'border-cyan-500/30',
    flow: [
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Khách nhắn "MUA"' },
      { icon: <ShoppingCartIcon className="w-3 h-3" />, text: 'Tạo đơn KiotViet' },
      { icon: <TruckIcon className="w-3 h-3" />, text: 'Tạo vận đơn GHN' },
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Gửi mã tracking' },
      { icon: <TrendingUpIcon className="w-3 h-3" />, text: 'Ghi Sheets' },
    ],
    desc: 'Khách nhắn từ khóa → Workflow tạo đơn trên POS → tạo vận đơn GHN/GHTK → gửi mã tracking cho khách.',
  },
  {
    icon: <BellIcon className="w-4 h-4" />,
    title: 'Thông báo đa kênh khi có đơn mới',
    tags: ['Workflow', 'Tích hợp'],
    color: 'border-amber-500/30',
    flow: [
      { icon: <DollarIcon className="w-3 h-3" />, text: 'Nhận thanh toán' },
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Gửi tin Zalo cho KH' },
      { icon: <BellIcon className="w-3 h-3" />, text: 'Thông báo Telegram cho admin' },
      { icon: <MailIcon className="w-3 h-3" />, text: 'Email cho kế toán' },
      { icon: <EditIcon className="w-3 h-3" />, text: 'Ghi Notion' },
    ],
    desc: 'Một sự kiện → nhiều hành động: xác nhận cho khách trên Zalo + thông báo admin qua Telegram + ghi log vào Notion/Email.',
  },
  {
    icon: <TagIcon className="w-4 h-4" />,
    title: 'Tự động gắn nhãn theo nội dung chat',
    tags: ['Workflow', 'AI', 'CRM'],
    color: 'border-rose-500/30',
    flow: [
      { icon: <MessageCircleIcon className="w-3 h-3" />, text: 'Khách nhắn tin' },
      { icon: <BrainIcon className="w-3 h-3" />, text: 'AI phân loại nội dung' },
      { icon: <TagIcon className="w-3 h-3" />, text: 'Gắn nhãn tương ứng' },
      { icon: <ChartIcon className="w-3 h-3" />, text: 'CRM cập nhật' },
    ],
    desc: 'AI đọc tin nhắn → phân loại (hỏi giá / khiếu nại / khen / hỏi giao hàng) → tự động gắn nhãn CRM phù hợp.',
  },
];

function ToolsGuideModal({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<'overview' | 'crm' | 'workflow' | 'integration' | 'combo'>('overview');

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9999]" onClick={onClose}>
      <div
        className="bg-gray-800 rounded-2xl border border-gray-600 shadow-2xl w-full max-w-3xl mx-4 max-h-[88vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-700/60 flex-shrink-0">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <span><BookIcon className="w-4 h-4" /></span> Hướng dẫn - Công cụ nâng cao
            </h2>
            <p className="text-[11px] text-gray-400 mt-0.5">Mô tả chi tiết tính năng và cách phối hợp các công cụ</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-gray-700 flex items-center justify-center text-gray-400 hover:text-white transition-colors">
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-700/60 px-2 flex-shrink-0 overflow-x-auto gap-0.5">
          {([
            { id: 'overview', icon: <LightbulbIcon className="w-3.5 h-3.5" />, label: 'Tổng quan' },
            { id: 'crm', icon: <ChartIcon className="w-3.5 h-3.5" />, label: 'CRM' },
            { id: 'workflow', icon: <SettingsIcon className="w-3.5 h-3.5" />, label: 'Workflow' },
            { id: 'integration', icon: <LinkIcon className="w-3.5 h-3.5" />, label: 'Tích hợp' },
            { id: 'combo', icon: <RefreshIcon className="w-3.5 h-3.5" />, label: 'Kết hợp' },
          ] as const).map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-2.5 text-[11px] flex font-medium whitespace-nowrap border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-400 hover:text-gray-200'
              }`}
            >
              {tab.icon} <span className="ml-1">{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">

          {/* ── Overview Tab ── */}
          {activeTab === 'overview' && (
            <>
              <div className="bg-gray-700/30 rounded-xl p-4 flex items-start gap-3">
                <span className="text-2xl leading-none"><SunIcon className="w-4 h-4" /></span>
                <div className="space-y-2">
                  <p className="text-gray-300 text-xs leading-relaxed">
                    Ba công cụ <strong className="text-white">CRM</strong>, <strong className="text-white">Workflow</strong> và <strong className="text-white">Tích hợp</strong> phối
                    hợp với nhau tạo thành hệ thống tự động hoá hoàn chỉnh:
                  </p>
                  <div className="flex items-center gap-2 text-[11px] flex-wrap">
                    <span className="bg-green-900/30 text-white px-2.5 py-1 rounded-lg border border-green-700/40"><LinkIcon className="w-4 h-4 inline" /> Tích hợp nhận dữ liệu</span>
                    <span className="text-gray-400">→</span>
                    <span className="bg-purple-900/30 text-white px-2.5 py-1 rounded-lg border border-purple-700/40"><SettingsIcon className="w-3.5 h-3.5 inline" /> Workflow xử lý logic</span>
                    <span className="text-gray-400">→</span>
                    <span className="bg-blue-900/30 text-blue-300 px-2.5 py-1 rounded-lg border border-blue-700/40"><ChartIcon className="w-4 h-4 inline" /> CRM quản lý KH</span>
                  </div>
                </div>
              </div>

              {/* Summary cards */}
              {TOOLS_GUIDE.map((tool, i) => (
                <button
                  key={i}
                  onClick={() => setActiveTab(tool.id)}
                  className={`w-full border rounded-xl p-4 text-left transition-colors hover:bg-gray-700/30 ${tool.color}`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-lg">{tool.icon}</span>
                    <h3 className="text-sm font-bold text-white">{tool.title}</h3>
                    <span className="text-gray-400 ml-auto text-[10px]">Bấm để xem chi tiết →</span>
                  </div>
                  <p className="text-sm text-gray-400 leading-relaxed">{tool.purpose}</p>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {tool.sections.map((s, j) => (
                      <span key={j} className={`text-[12px] px-2 py-0.5 rounded-full ${tool.badgeColor}`}>
                        {s.title}
                      </span>
                    ))}
                  </div>
                </button>
              ))}

              {/* Combo preview */}
              <button
                onClick={() => setActiveTab('combo')}
                className="w-full border border-amber-500/30 bg-amber-900/10 rounded-xl p-4 text-left hover:bg-amber-900/20 transition-colors"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-lg"><RefreshIcon className="w-4 h-4" /></span>
                  <h3 className="text-sm font-bold text-white">{COMBO_SCENARIOS.length} kịch bản kết hợp thực tế</h3>
                  <span className="text-gray-400 ml-auto text-[10px]">Bấm để xem →</span>
                </div>
                <p className="text-xs text-gray-400">Xem các ví dụ phối hợp CRM + Workflow + Tích hợp trong thực tế kinh doanh.</p>
              </button>
            </>
          )}

          {/* ── Tool Detail Tabs (CRM / Workflow / Integration) ── */}
          {(activeTab === 'crm' || activeTab === 'workflow' || activeTab === 'integration') && (() => {
            const tool = TOOLS_GUIDE.find(t => t.id === activeTab)!;
            return (
              <>
                <div className={`border rounded-xl p-4 ${tool.color}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-lg">{tool.icon}</span>
                    <h3 className="text-sm font-bold text-white">{tool.title}</h3>
                  </div>
                  <p className="text-xs text-gray-300 leading-relaxed">{tool.purpose}</p>
                </div>

                {tool.sections.map((section, i) => (
                  <div key={i} className="space-y-2">
                    <h4 className="text-xs font-bold text-gray-300 flex items-center gap-1.5">{section.icon} {section.title}</h4>
                    <ul className="space-y-1 pl-1">
                      {section.items.map((item, j) => (
                        <li key={j} className="flex items-start gap-2 text-xs text-gray-400">
                          <span className="text-blue-400 mt-0.5 flex-shrink-0">•</span>
                          <span className="leading-relaxed">{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}

                {/* Related combos */}
                <div className="border-t border-gray-700/60 pt-4 mt-2">
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2"><RefreshIcon className="w-4 h-4 inline" /> Kịch bản kết hợp liên quan</p>
                  <div className="space-y-2">
                    {COMBO_SCENARIOS.filter(c =>
                      (activeTab === 'crm' && c.tags.includes('CRM')) ||
                      (activeTab === 'workflow' && c.tags.includes('Workflow')) ||
                      (activeTab === 'integration' && c.tags.includes('Tích hợp'))
                    ).slice(0, 3).map((combo, i) => (
                      <div key={i} className={`border rounded-lg p-3 bg-gray-700/20 ${combo.color}`}>
                        <div className="flex items-center gap-2 mb-1">
                          <span>{combo.icon}</span>
                          <span className="text-xs font-semibold text-white">{combo.title}</span>
                          <div className="flex gap-1 ml-auto">
                            {combo.tags.map(t => (
                              <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-gray-600/50 text-gray-400">{t}</span>
                            ))}
                          </div>
                        </div>
                        <p className="text-[11px] text-gray-400 leading-relaxed">{combo.desc}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            );
          })()}

          {/* ── Combo Tab ── */}
          {activeTab === 'combo' && (
            <>
              <div className="bg-gray-700/30 rounded-xl p-4">
                <p className="text-xs text-gray-300 leading-relaxed">
                  Sức mạnh thực sự nằm ở việc <strong className="text-white">kết hợp</strong> các công cụ. Dưới đây là {COMBO_SCENARIOS.length} kịch bản thực tế
                  giúp bạn hình dung cách ứng dụng vào kinh doanh.
                </p>
              </div>

              {COMBO_SCENARIOS.map((combo, i) => (
                <div key={i} className={`border rounded-xl p-4 space-y-2.5 bg-gray-700/10 ${combo.color}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{combo.icon}</span>
                    <h3 className="text-xs font-bold text-white">{combo.title}</h3>
                    <div className="flex gap-1 ml-auto">
                      {combo.tags.map(t => (
                        <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-gray-600/50 text-gray-400">{t}</span>
                      ))}
                    </div>
                  </div>
                  <p className="text-[11px] text-gray-400 leading-relaxed">{combo.desc}</p>
                  {/* Flow diagram */}
                  <div className="flex items-center gap-1.5 text-[10px] flex-wrap pt-1">
                    {combo.flow.map((step, j) => (
                      <React.Fragment key={j}>
                        {j > 0 && <span className="text-gray-400">→</span>}
                        <span className="bg-gray-800 text-gray-300 px-2 py-0.5 rounded-md border border-gray-700/60 whitespace-nowrap inline-flex items-center gap-1">{step.icon} {step.text}</span>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}

        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-700/60 flex-shrink-0 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
          >
            Đã hiểu
          </button>
        </div>
      </div>
    </div>
  );
}
