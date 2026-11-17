import { EMPLOYEE_MODULE_OPTIONS, permissionPatch } from '../../ui/lib/employeeModules';

const SETTINGS_KEYS = ['chat', 'friends', 'crm', 'erp', 'workflow', 'integration', 'analytics', 'ai_assistant', 'facebook', 'settings_accounts', 'settings_employees'];
const HRM_KEYS = ['chat', 'crm', 'workflow', 'integration', 'analytics', 'ai_assistant', 'settings_accounts', 'settings_employees'];

describe('employeeModules', () => {
  const keys = EMPLOYEE_MODULE_OPTIONS.map((o) => o.key);

  it('covers every key of both old screens plus fb_poster', () => {
    for (const key of [...SETTINGS_KEYS, ...HRM_KEYS, 'fb_poster']) expect(keys).toContain(key);
  });

  it('lists each key once, with fb_poster right after facebook', () => {
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.indexOf('fb_poster')).toBe(keys.indexOf('facebook') + 1);
    expect(EMPLOYEE_MODULE_OPTIONS.find((o) => o.key === 'fb_poster')?.label).toBe('Đăng Facebook');
  });

  it('keeps the labels the settings screen shows', () => {
    const label = (key: string) => EMPLOYEE_MODULE_OPTIONS.find((o) => o.key === key)?.label;
    expect(label('settings_accounts')).toBe('Quản lý tài khoản');
    expect(label('settings_employees')).toBe('Quản lý nhân viên');
    expect(label('ai_assistant')).toBe('AI');
  });

  it('permissionPatch turns the edited map into rows', () => {
    expect(permissionPatch({ chat: true, fb_poster: false })).toEqual([
      { module: 'chat', can_access: true }, { module: 'fb_poster', can_access: false },
    ]);
  });
});
