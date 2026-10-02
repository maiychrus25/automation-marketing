import { parseThemePreference, resolveTheme } from '../../ui/lib/theme';

describe('parseThemePreference', () => {
  it('keeps a stored light or dark choice', () => {
    expect(parseThemePreference('light')).toBe('light');
    expect(parseThemePreference('dark')).toBe('dark');
  });

  it('keeps a stored system choice', () => {
    expect(parseThemePreference('system')).toBe('system');
  });

  it('defaults new users and garbage values to system', () => {
    expect(parseThemePreference(null)).toBe('system');
    expect(parseThemePreference('')).toBe('system');
    expect(parseThemePreference('blue')).toBe('system');
  });
});

describe('resolveTheme', () => {
  it('follows the OS only when the preference is system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('ignores the OS for an explicit choice', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});
