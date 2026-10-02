import type { BrowserWindowConstructorOptions, TitleBarOverlay } from 'electron';
// Nếu `TitleBarOverlay` không import được theo tên, dùng `Electron.TitleBarOverlay`.

export type WindowMaterial = 'vibrancy' | 'mica' | 'none';
export type WindowTheme = 'light' | 'dark';

export interface WindowAppearance {
  material: WindowMaterial;
  /** true: nút cửa sổ gốc qua titleBarOverlay (Windows); false: macOS dùng traffic light thật, Linux tự vẽ traffic light bên phải toolbar. */
  nativeControls: boolean;
}

/** Cao bằng toolbar trong renderer (`--toolbar-height` trong src/ui/index.css). */
export const TOOLBAR_HEIGHT = 52;

/** Windows 11 22H2: bản đầu tiên `backgroundMaterial` của Electron có tác dụng. */
const WINDOWS_MICA_MIN_BUILD = 22621;

/**
 * Quyết định vật liệu và kiểu nút cửa sổ theo hệ điều hành.
 * Phương án dự phòng (docs/plans/2026-10-02-macos-ui.md Task 3): nếu overlay hoặc mica
 * hỏng trên máy thật, đổi giá trị trả về ở đây; không cần sửa chỗ khác.
 * Linux: overlay gốc vẽ nút kiểu Windows, không theo theme KDE của máy → cửa sổ không khung,
 * TopBar tự vẽ traffic light (chủ sản phẩm chọn, 02/10/2026).
 */
export function resolveWindowAppearance(platform: NodeJS.Platform, osRelease: string): WindowAppearance {
  if (platform === 'darwin') return { material: 'vibrancy', nativeControls: false };
  if (platform === 'win32') {
    const build = Number(osRelease.split('.')[2]) || 0;
    return { material: build >= WINDOWS_MICA_MIN_BUILD ? 'mica' : 'none', nativeControls: true };
  }
  return { material: 'none', nativeControls: false };
}

export function solidBackgroundFor(theme: WindowTheme): string {
  return theme === 'dark' ? '#151516' : '#f2f2f7';
}

export function titleBarOverlayFor(theme: WindowTheme): TitleBarOverlay {
  return { color: '#00000000', symbolColor: theme === 'dark' ? '#f5f5f7' : '#1d1d1f', height: TOOLBAR_HEIGHT };
}

export function windowChromeOptions(
  platform: NodeJS.Platform,
  appearance: WindowAppearance,
  theme: WindowTheme,
): BrowserWindowConstructorOptions {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      // Căn giữa hàng đầu sidebar (52 px): đèn cao 12 px → y = 20.
      trafficLightPosition: { x: 20, y: 20 },
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
      backgroundColor: '#00000000',
    };
  }
  if (!appearance.nativeControls) {
    return { frame: false, backgroundColor: solidBackgroundFor(theme) };
  }
  const options: BrowserWindowConstructorOptions = {
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlayFor(theme),
    backgroundColor: appearance.material === 'mica' ? '#00000000' : solidBackgroundFor(theme),
  };
  if (appearance.material === 'mica') options.backgroundMaterial = 'mica';
  return options;
}
