export type AppTheme = 'light' | 'dark';
export type ThemePreference = AppTheme | 'system';

export const THEME_STORAGE_KEY = 'app_theme';

/** Người dùng chưa chọn (hoặc giá trị hỏng) thì theo hệ điều hành. */
export function parseThemePreference(stored: string | null): ThemePreference {
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

export function resolveTheme(pref: ThemePreference, systemPrefersDark: boolean): AppTheme {
  if (pref === 'system') return systemPrefersDark ? 'dark' : 'light';
  return pref;
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}
