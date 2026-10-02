import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/appStore';
import type { ThemePreference } from '@/lib/theme';

const OPTIONS: { value: ThemePreference; label: string; description: string }[] = [
  { value: 'light', label: 'Sáng', description: 'Luôn sáng' },
  { value: 'dark', label: 'Tối', description: 'Luôn tối' },
  { value: 'system', label: 'Theo hệ thống', description: 'Tự động' },
];

/** Nút ◐ trên toolbar: chọn Sáng / Tối / Theo hệ thống (spec mục 7.4). */
export default function AppearanceMenu() {
  const { themePreference, setThemePreference } = useAppStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="app-toolbar-btn"
        onClick={() => setOpen(v => !v)}
        title="Giao diện"
        aria-label="Giao diện"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="mac-popover absolute right-0 top-full mt-1.5 z-[9999]" role="menu" aria-label="Giao diện">
          <div className="mac-popover-title">Giao diện</div>
          {OPTIONS.map(option => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={themePreference === option.value}
              className="mac-menu-item"
              onClick={() => { setThemePreference(option.value); setOpen(false); }}
            >
              <span className="w-3.5 text-blue-500" aria-hidden="true">{themePreference === option.value ? '✓' : ''}</span>
              <span>{option.label}</span>
              <span className="ml-auto text-[11px] text-gray-500">{option.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
