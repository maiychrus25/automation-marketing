import { resolveWindowAppearance, windowChromeOptions, titleBarOverlayFor, solidBackgroundFor, TOOLBAR_HEIGHT } from '../../../electron/windowAppearance';

describe('resolveWindowAppearance', () => {
  it('uses vibrancy and the real traffic lights on macOS', () => {
    expect(resolveWindowAppearance('darwin', '24.0.0')).toEqual({ material: 'vibrancy', nativeControls: false });
  });

  it('uses mica only from Windows 11 22H2 (build 22621)', () => {
    expect(resolveWindowAppearance('win32', '10.0.22621')).toEqual({ material: 'mica', nativeControls: true });
    expect(resolveWindowAppearance('win32', '10.0.26100')).toEqual({ material: 'mica', nativeControls: true });
    expect(resolveWindowAppearance('win32', '10.0.22000')).toEqual({ material: 'none', nativeControls: true });
    expect(resolveWindowAppearance('win32', '10.0.19045')).toEqual({ material: 'none', nativeControls: true });
  });

  it('treats an unparsable Windows release as Windows 10', () => {
    expect(resolveWindowAppearance('win32', 'garbage').material).toBe('none');
  });

  it('uses native controls and a solid background on Linux', () => {
    expect(resolveWindowAppearance('linux', '6.8.0')).toEqual({ material: 'none', nativeControls: true });
  });
});

describe('windowChromeOptions', () => {
  it('keeps the window transparent behind vibrancy on macOS', () => {
    const opts = windowChromeOptions('darwin', { material: 'vibrancy', nativeControls: false }, 'light');
    expect(opts).toMatchObject({ titleBarStyle: 'hiddenInset', vibrancy: 'sidebar', backgroundColor: '#00000000' });
    expect(opts.frame).toBeUndefined();
  });

  it('uses the native overlay and mica on Windows 11', () => {
    const opts = windowChromeOptions('win32', { material: 'mica', nativeControls: true }, 'dark');
    expect(opts).toMatchObject({ titleBarStyle: 'hidden', backgroundMaterial: 'mica', backgroundColor: '#00000000' });
    expect(opts.titleBarOverlay).toEqual(titleBarOverlayFor('dark'));
  });

  it('paints a solid themed background without a material', () => {
    const opts = windowChromeOptions('linux', { material: 'none', nativeControls: true }, 'dark');
    expect(opts.backgroundColor).toBe(solidBackgroundFor('dark'));
    expect(opts.backgroundMaterial).toBeUndefined();
  });

  it('falls back to a frameless window when native controls are off', () => {
    const opts = windowChromeOptions('win32', { material: 'none', nativeControls: false }, 'light');
    expect(opts).toEqual({ frame: false, backgroundColor: solidBackgroundFor('light') });
  });
});

describe('titleBarOverlayFor', () => {
  it('is transparent, toolbar-high and readable in both themes', () => {
    expect(titleBarOverlayFor('light')).toEqual({ color: '#00000000', symbolColor: '#1d1d1f', height: TOOLBAR_HEIGHT });
    expect(titleBarOverlayFor('dark')).toEqual({ color: '#00000000', symbolColor: '#f5f5f7', height: TOOLBAR_HEIGHT });
  });
});
