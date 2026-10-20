import { hydrateTargets, targetsToSave, hydrateVariants, validateVariantTabs, buildVariantParams } from '../../ui/features/facebookPoster/draftForm';

describe('hydrateTargets', () => {
  it('unchecks scanned groups not in the draft and keeps unknown targets as manual links', () => {
    expect(hydrateTargets(['https://g/1', 'https://g/9', '123'], ['https://g/1', 'https://g/2']))
      .toEqual({ uncheckedUrls: ['https://g/2'], extraLinks: 'https://g/9\n123' });
  });
  it('a draft without targets unchecks every scanned group', () => {
    expect(hydrateTargets([], ['a', 'b'])).toEqual({ uncheckedUrls: ['a', 'b'], extraLinks: '' });
  });
});

describe('targetsToSave', () => {
  const pending = [{ profileId: 'p1', targets: ['https://g/1', 'https://g/9'] }];
  it('groups not loaded yet (draft targets not applied) keeps the draft targets instead of saving none', () => {
    expect(targetsToSave('p1', [], pending)).toEqual(['https://g/1', 'https://g/9']);
  });
  it('a profile added after opening the draft uses what the form shows', () => {
    expect(targetsToSave('p2', ['https://g/5'], pending)).toEqual(['https://g/5']);
  });
  it('once the draft targets are applied the form is the source of truth', () => {
    expect(targetsToSave('p1', ['https://g/1'], null)).toEqual(['https://g/1']);
  });
});

describe('variant tabs', () => {
  it('hydrateVariants reads strings and ignores old drafts without variants', () => {
    expect(hydrateVariants({ variants: ['b', 'c'] })).toEqual(['b', 'c']);
    expect(hydrateVariants({})).toEqual([]);
    expect(hydrateVariants(undefined)).toEqual([]);
    expect(hydrateVariants({ variants: 'x' })).toEqual([]);
  });
  it('buildVariantParams adds variants only when there is an extra tab', () => {
    expect(buildVariantParams([])).toEqual({});
    expect(buildVariantParams(['b'])).toEqual({ variants: ['b'] });
  });
  it('validateVariantTabs mirrors the server rules', () => {
    expect(validateVariantTabs('a', [])).toBeNull();
    expect(validateVariantTabs('a', ['b', 'c'])).toBeNull();
    expect(validateVariantTabs('a', ['  '])).toBe('Biến thể B không được để trống');
    expect(validateVariantTabs('a', ['b', 'a '])).toBe('Biến thể C trùng với nội dung khác');
    expect(validateVariantTabs('a', ['b', 'b'])).toBe('Biến thể C trùng với nội dung khác');
  });
});
