import React from 'react';
import type { ProfileLoginState } from '../../../models/facebookPoster';

const pad = (n: number) => String(n).padStart(2, '0');
// HH:MM dd/MM theo giờ máy.
function formatChecked(at: number | null): string {
  if (!at) return 'chưa rõ';
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

export default function LoginStateBadge({ state }: { state?: ProfileLoginState }) {
  if (!state || state.state === 'unknown') return null;
  if (state.state === 'logged_out') {
    return <span className="shrink-0 whitespace-nowrap rounded border border-orange-400/40 px-1.5 text-xs text-orange-400" title={`Hết phiên đăng nhập · kiểm tra lúc ${formatChecked(state.checkedAt)}`}>Hết phiên</span>;
  }
  if (state.state === 'checkpoint') {
    return <span className="shrink-0 whitespace-nowrap rounded border border-red-400/40 px-1.5 text-xs text-red-400" title={`Facebook yêu cầu xác minh · kiểm tra lúc ${formatChecked(state.checkedAt)}`}>Checkpoint</span>;
  }
  const label = `Đăng nhập ổn · kiểm tra lúc ${formatChecked(state.checkedAt)}${state.lastError ? ` · Lần kiểm tra cuối lỗi: ${state.lastError}` : ''}`;
  return <span role="img" aria-label={label} title={label} className="shrink-0 inline-block w-2 h-2 rounded-full bg-green-400" />;
}
