import { isAccountOnline, withFacebookParents } from '../../services/http/accountRows';

describe('withFacebookParents', () => {
  const fb = [
    { facebook_id: 'page-1', parent_facebook_id: 'fb-personal' },
    { facebook_id: 'fb-personal', parent_facebook_id: null },
  ];
  test('aPageGetsItsParentFromFbAccounts', () => {
    expect(withFacebookParents([{ zalo_id: 'page-1', channel: 'facebook' }], fb)[0].parent_zalo_id).toBe('fb-personal');
  });
  test('aPersonalFacebookAccountHasNoParent', () => {
    expect(withFacebookParents([{ zalo_id: 'fb-personal', channel: 'facebook' }], fb)[0].parent_zalo_id).toBeNull();
  });
  test('otherChannelsHaveNoParentEvenIfTheIdMatches', () => {
    expect(withFacebookParents([{ zalo_id: 'page-1', channel: 'zalo' }, { zalo_id: 'acc-a' }], fb).map((r) => r.parent_zalo_id)).toEqual([null, null]);
  });
  test('aPageWithoutAnFbAccountsRowIsTreatedAsPersonal', () => {
    expect(withFacebookParents([{ zalo_id: 'page-9', channel: 'facebook' }], fb)[0].parent_zalo_id).toBeNull();
  });
});

describe('isAccountOnline', () => {
  const deps = { zaloConnected: (id: string) => id === 'acc-a', facebookConnected: (id: string) => id === 'page-1' };
  test('usesTheZaloCheckForZaloAndTheFacebookCheckForFacebook', () => {
    expect(isAccountOnline({ zalo_id: 'acc-a', channel: 'zalo' }, deps)).toBe(true);
    expect(isAccountOnline({ zalo_id: 'acc-a', channel: 'facebook' }, deps)).toBe(false);
    expect(isAccountOnline({ zalo_id: 'page-1', channel: 'facebook' }, deps)).toBe(true);
    expect(isAccountOnline({ zalo_id: 'page-1' }, deps)).toBe(false);
  });
});

describe('a Page the boss switched off', () => {
  test('carriesEnabledZeroOntoItsRowOnly', () => {
    const fb = [
      { facebook_id: 'page-off', parent_facebook_id: 'fb-personal', enabled: 0 },
      { facebook_id: 'page-1', parent_facebook_id: 'fb-personal', enabled: 1 },
    ];
    const rows = withFacebookParents([{ zalo_id: 'page-off', channel: 'facebook' }, { zalo_id: 'page-1', channel: 'facebook' }], fb);
    expect(rows[0]).toMatchObject({ parent_zalo_id: 'fb-personal', enabled: 0 });
    expect(rows[1]).not.toHaveProperty('enabled');
  });
});
