import { useCallback, useEffect, useRef } from 'react';
import { useEmployeeStore } from '@/store/employeeStore';
import { EMPLOYEE_POSTER_RELOAD_DEBOUNCE_MS, profileIdsKey, showsNoProfileNotice } from '../../lib/employeePoster';

/**
 * Máy nhân viên thật (không phải boss đang xem thử). `noProfiles`: boss chưa gán hồ sơ nào.
 * `assignedKey`: khoá theo NỘI DUNG danh sách được gán ('' trên boss), đổi khi boss gán/bỏ hồ sơ giữa phiên.
 */
export function useEmployeePoster(): { isEmployee: boolean; noProfiles: boolean; assignedKey: string; assigned: string[] } {
  const isEmployee = useEmployeeStore((s) => s.mode === 'employee');
  const assignedKey = useEmployeeStore((s) => (s.mode === 'employee' ? profileIdsKey(s.assignedProfiles) : ''));
  const assigned = useEmployeeStore((s) => s.assignedProfiles);
  return { isEmployee, noProfiles: showsNoProfileNotice(isEmployee, assigned.length), assignedKey, assigned };
}

/** Boss: gọi `reload` ngay như cũ. Nhân viên: gộp các sự kiện dồn dập thành một lần sau 250 ms; huỷ hẹn khi gỡ component. */
export function useEmployeeReload(reload: () => void, isEmployee: boolean): () => void {
  const latest = useRef(reload);
  latest.current = reload;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return useCallback(() => {
    if (!isEmployee) { latest.current(); return; }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; latest.current(); }, EMPLOYEE_POSTER_RELOAD_DEBOUNCE_MS);
  }, [isEmployee]);
}
