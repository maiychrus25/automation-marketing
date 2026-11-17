// Danh sách quyền module dùng chung cho hai màn hình sửa nhân viên (Cài đặt và HRM).
export const EMPLOYEE_MODULE_OPTIONS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'chat', label: 'Chat' },
  { key: 'friends', label: 'Bạn bè' },
  { key: 'crm', label: 'CRM' },
  { key: 'erp', label: 'ERP' },
  { key: 'workflow', label: 'Workflow' },
  { key: 'integration', label: 'Tích hợp' },
  { key: 'analytics', label: 'Thống kê' },
  { key: 'ai_assistant', label: 'AI' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'fb_poster', label: 'Đăng Facebook' },
  { key: 'settings_accounts', label: 'Quản lý tài khoản' },
  { key: 'settings_employees', label: 'Quản lý nhân viên' },
];

export function permissionPatch(edited: Record<string, boolean>): Array<{ module: string; can_access: boolean }> {
  return EMPLOYEE_MODULE_OPTIONS.filter((o) => o.key in edited).map((o) => ({ module: o.key, can_access: !!edited[o.key] }));
}
