import { bossAuthHeaderFor } from '../../services/http/bossRequestAuth';

const WS = { bossUrl: 'http://192.168.1.5:9900', token: 't' };

describe('bossAuthHeaderFor', () => {
  test('sameOriginMediaGetsTheToken', () => {
    expect(bossAuthHeaderFor('http://192.168.1.5:9900/api/media/acc-a/x.png', WS)).toBe('Bearer t');
    expect(bossAuthHeaderFor('http://192.168.1.5:9900/api/library/thumb/abc', WS)).toBe('Bearer t');
  });
  test.each([
    ['another host', 'http://evil.example:9900/api/media/x'],
    ['another port', 'http://192.168.1.5:9901/api/media/x'],
    ['another scheme', 'https://192.168.1.5:9900/api/media/x'],
    ['a query route', 'http://192.168.1.5:9900/api/query/x'],
    ['a lookalike prefix', 'http://192.168.1.5:9900/api/media-x/x'],
    ['a broken url', 'not a url'],
  ])('noTokenFor: %s', (_n, url) => {
    expect(bossAuthHeaderFor(url, WS)).toBeNull();
  });
  test('noWorkspaceOrNoTokenGivesNothing', () => {
    expect(bossAuthHeaderFor('http://192.168.1.5:9900/api/media/x', null)).toBeNull();
    expect(bossAuthHeaderFor('http://192.168.1.5:9900/api/media/x', { bossUrl: WS.bossUrl })).toBeNull();
    expect(bossAuthHeaderFor('http://192.168.1.5:9900/api/media/x', { token: 't' })).toBeNull();
  });
});
