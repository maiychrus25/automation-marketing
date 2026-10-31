import React, { useId } from 'react';
import type { PageIdentity } from '../../../models/dailyBrief';
import type { ScopedKeyPolicy } from '../../../services/control/controlAuthorization';

interface Props {
  value: ScopedKeyPolicy | null;
  onChange: (value: ScopedKeyPolicy | null) => void;
  identities: PageIdentity[];
  workspaceId: string;
}

/** Form feedback only; trusted IPC independently validates the complete policy and current identities. */
export function scopeValidationError(value: ScopedKeyPolicy | null, identities: PageIdentity[], workspaceId: string): string {
  if (!value) return '';
  if (!workspaceId || value.workspaceId !== workspaceId) return 'Workspace đã đổi, hãy tải lại phạm vi khoá.';
  if (!value.assignments.length) return 'Chọn ít nhất một Page/profile đã học.';
  if (value.assignments.some(a => !a.profileIds.length || a.profileIds.some(id => !identities.some(i => i.kind === 'page' && i.pageId === a.pageId && i.profileId === id)))) {
    return 'Page/profile không còn khớp dữ liệu đã học. Hãy tải lại phạm vi khoá.';
  }
  if (value.kind === 'page_receiver' && (!/^-?[1-9]\d*$/.test(value.ownerChatId) || !/^[1-9]\d*$/.test(value.ownerSenderId))) {
    return 'Nhập Chat ID khác 0 và Sender ID dương, chỉ dùng chuỗi số nguyên đã xác nhận.';
  }
  return '';
}

export default function ControlKeyScope({ value, onChange, identities, workspaceId }: Props) {
  const id = useId();
  const pages = identities.filter(i => i.kind === 'page' && i.pageId);
  const error = scopeValidationError(value, identities, workspaceId);
  const changeKind = (kind: string) => {
    if (kind === 'legacy') { onChange(null); return; }
    const base = { workspaceId, assignments: value?.assignments ?? [] };
    onChange(kind === 'page_receiver'
      ? { ...base, kind, ownerChatId: '', ownerSenderId: '' }
      : { ...base, kind: 'page_runner' });
  };
  const toggle = (identity: PageIdentity, checked: boolean) => {
    if (!value) return;
    const assignments = value.assignments.map(a => ({ ...a, profileIds: a.profileIds.filter(p => p !== identity.profileId) })).filter(a => a.profileIds.length);
    if (checked) {
      const existing = assignments.find(a => a.pageId === identity.pageId);
      if (existing) existing.profileIds.push(identity.profileId);
      else assignments.push({ pageId: identity.pageId, profileIds: [identity.profileId] });
    }
    onChange({ ...value, assignments });
  };
  return (
    <div className="space-y-3 min-w-0">
      <div>
        <label htmlFor={`${id}-purpose`} className="text-xs text-gray-400 block mb-1">Mục đích khoá</label>
        <select id={`${id}-purpose`} className="input-field w-full min-w-0" value={value?.kind ?? 'legacy'} onChange={e => changeKind(e.target.value)}>
          <option value="page_runner">Runner chuẩn bị nháp</option>
          <option value="page_receiver">Receiver xác nhận</option>
          <option value="legacy">Legacy toàn quyền</option>
        </select>
      </div>
      {!value ? <p className="text-xs text-amber-500 break-words">Legacy toàn quyền: giữ quyền API cũ, không giới hạn theo Page. Chỉ cấp cho bot tin cậy.</p> : <>
        <p className="text-xs text-gray-400 break-all">Workspace: {workspaceId || 'Chưa tải được'}</p>
        <fieldset className="space-y-2 min-w-0">
          <legend className="text-xs text-gray-400 mb-1">Page/profile đã học</legend>
          {pages.length === 0 && <p className="text-xs text-gray-500" role="status">Chưa có Page đã học. Hãy học danh tính Page trong luồng hiện có rồi tải lại phạm vi.</p>}
          {pages.map(i => <label key={i.profileId} className="flex items-start gap-2 text-xs text-gray-200 cursor-pointer min-w-0">
            <input type="checkbox" className="w-4 h-4 shrink-0 accent-blue-600" checked={value.assignments.some(a => a.pageId === i.pageId && a.profileIds.includes(i.profileId))} onChange={e => toggle(i, e.target.checked)} />
            <span className="min-w-0 break-all">{i.pageName || 'Page'} · Page {i.pageId} · profile {i.profileId}</span>
          </label>)}
        </fieldset>
        {value.kind === 'page_receiver' && <>
          <p className="text-xs text-amber-500 leading-relaxed">Receiver phải được cách ly khỏi runner: không chung cấu hình, .env, MCP hay tài khoản hệ điều hành. Hai khoá riêng chưa chứng minh cách ly.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <label htmlFor={`${id}-chat`} className="text-xs text-gray-400 block mb-1">Owner Chat ID đã xác nhận</label>
              <input id={`${id}-chat`} className="input-field font-mono" type="text" value={value.ownerChatId} onChange={e => onChange({ ...value, ownerChatId: e.target.value })} />
            </div>
            <div className="min-w-0">
              <label htmlFor={`${id}-sender`} className="text-xs text-gray-400 block mb-1">Owner Sender ID đã xác nhận</label>
              <input id={`${id}-sender`} className="input-field font-mono" type="text" inputMode="numeric" value={value.ownerSenderId} onChange={e => onChange({ ...value, ownerSenderId: e.target.value })} />
            </div>
          </div>
        </>}
        <p className="text-xs text-gray-400 leading-relaxed">Khoá scoped hiện chỉ cấp/staging; runtime và kiểm chứng cài đặt cách ly chưa sẵn sàng. Giữ ghi được bảo vệ tắt cho đến khi kiểm tra hoàn tất.</p>
        {error && <p className="text-xs text-red-400 break-words" role="alert">{error}</p>}
      </>}
    </div>
  );
}
