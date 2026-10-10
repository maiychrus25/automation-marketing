import { hydrateTargets } from '../../ui/features/facebookPoster/draftForm';

describe('hydrateTargets', () => {
  it('unchecks scanned groups not in the draft and keeps unknown targets as manual links', () => {
    expect(hydrateTargets(['https://g/1', 'https://g/9', '123'], ['https://g/1', 'https://g/2']))
      .toEqual({ uncheckedUrls: ['https://g/2'], extraLinks: 'https://g/9\n123' });
  });
  it('a draft without targets unchecks every scanned group', () => {
    expect(hydrateTargets([], ['a', 'b'])).toEqual({ uncheckedUrls: ['a', 'b'], extraLinks: '' });
  });
});
