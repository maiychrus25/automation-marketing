import { startRelay, RelayHarness } from './relayHarness';

const row = (id: string, channel: string): any => ({ zalo_id: id, full_name: id, avatar_url: '', phone: '', is_business: 0, is_active: 1, channel, cookies: 'SECRET' });

describe('boss relay recognises a Facebook Page as an account an employee may use', () => {
  let relay: RelayHarness;
  const call = async (path: string) => {
    const res = await fetch(relay.url + path, { headers: { Authorization: `Bearer ${relay.tokenFor('emp-1')}` } });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  };

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    relay = await startRelay({
      employees: [{ id: 'emp-1', assigned: ['page-1', 'fb-personal', 'page-orphan'], modules: ['chat'] }],
      accounts: [row('page-1', 'facebook'), row('fb-personal', 'facebook'), row('page-orphan', 'facebook')],
      // page-orphan has no fb_accounts row: it must be treated as personal.
      fbAccounts: [
        { id: 'uuid-personal', facebook_id: 'fb-personal', parent_facebook_id: null },
        { id: 'uuid-page-1', facebook_id: 'page-1', parent_facebook_id: 'fb-personal' },
      ],
      connectedFacebook: ['page-1'],
    });
  });
  afterAll(() => relay.close());

  test('theSnapshotListsOnlyThePageWithItsParentAndConnectionState', async () => {
    const { status, body } = await call('/api/sync/snapshot');
    expect(status).toBe(200);
    expect(body.snapshot.accountsData.map((a: any) => a.zalo_id)).toEqual(['page-1']);
    expect(body.snapshot.accountsData[0]).toMatchObject({ channel: 'facebook', parent_zalo_id: 'fb-personal', listener_active: 1 });
    expect(body.snapshot.assignedAccounts).toEqual(['page-1']);
    expect(body.snapshot.onlineAccounts).toEqual(['page-1']);
  });

  test('conversationsOfThePageAreAllowedAndOfThePersonalAccountRefused', async () => {
    expect((await call('/api/query/conversations?zaloId=page-1')).status).not.toBe(403);
    expect((await call('/api/query/conversations?zaloId=fb-personal')).status).toBe(403);
    expect((await call('/api/query/conversations?zaloId=page-orphan')).status).toBe(403);
  });
});
