import React from 'react';
import { CopyIcon } from '../common/icons';

export function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-800 rounded-xl p-4 space-y-3 min-w-0">
      {title && <h3 className="text-sm font-semibold text-white">{title}</h3>}
      {children}
    </div>
  );
}

/** Ô mã nguồn: cuộn ngang bên trong ô, kèm nút sao chép. */
export function CodeBox({ text, onCopy, label }: { text: string; onCopy: (t: string) => void; label: string }) {
  return (
    <div className="flex flex-wrap items-start gap-2 min-w-0">
      <pre className="flex-1 min-w-0 basis-[12rem] overflow-x-auto bg-gray-900/60 rounded-lg px-3 py-2 text-xs font-mono text-gray-200 select-all whitespace-pre">{text}</pre>
      <button type="button" className="btn-secondary flex-shrink-0 flex items-center gap-1" onClick={() => onCopy(text)} aria-label={label}>
        <CopyIcon className="w-4 h-4" /> Sao chép
      </button>
    </div>
  );
}
