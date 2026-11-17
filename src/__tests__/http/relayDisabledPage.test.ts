import { startRelay, RelayHarness } from './relayHarness';
import { canReceiveRelayEvent } from '../../services/socket/relayAudience';

const account = (id: string, isActive = 1): any => ({ zalo_id: id, full_name: id, avatar_url: '', phone: '', is_business: 0, is_active: isActive, channel: 'facebook' });

// DatabaseService.setFBPageEnabled(id, false) writes fb_accounts.enabled = 0 AND accounts.is_active = 0, and getAccounts()
// keeps only is_active = 1, so 'page-off' is already absent from it. 'page-resaved' is the gap: a later saveAccount()
// upsert writes is_active = 1 again while fb_accounts.enabled stays 0.
describe('a Page the boss switched off is unusable by an employee', () => {
  let relay: RelayHarness;
  const token = () => `Bearer ${relay.tokenFor('emp-1')}`;
  const rest = async (path: string) => (await fetch(relay.url + path, { headers: { Authorization: token() } })).status;
  const proxy = async (channel: string, params: any) => (await (await fetch(relay.url + '/api/proxy/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token() }, body: JSON.stringify({ channel, params }),
  })).json()) as any;

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    relay = await startRelay({
      employees: [{ id: 'emp-1', assigned: ['page-1', 'page-off', 'page-resaved'], modules: ['chat'] }],
      accounts: [account('page-1'), account('page-off', 0), account('page-resaved'), account('fb-personal')],
      fbAccounts: [
        { id: 'uuid-personal', facebook_id: 'fb-personal', parent_facebook_id: null },
        { id: 'uuid-page-1', facebook_id: 'page-1', parent_facebook_id: 'fb-personal', enabled: 1 } as any,
        { id: 'uuid-page-off', facebook_id: 'page-off', parent_facebook_id: 'fb-personal', enabled: 0 } as any,
        { id: 'uuid-page-resaved', facebook_id: 'page-resaved', parent_facebook_id: 'fb-personal', enabled: 0 } as any,
      ],
    });
  });
  afterAll(() => relay.close());

  test('theSnapshotListsOnlyTheEnabledPage', async () => {
    const res = await fetch(relay.url + '/api/sync/snapshot', { headers: { Authorization: token() } });
    const body = await res.json() as any;
    expect(body.snapshot.accountsData.map((a: any) => a.zalo_id)).toEqual(['page-1']);
    expect(body.snapshot.assignedAccounts).toEqual(['page-1']);
  });

  test.each(['page-off', 'page-resaved'])('restRefuses_%s', async (id) => {
    expect(await rest(`/api/query/conversations?zaloId=${id}`)).toBe(403);
    expect(await rest('/api/query/conversations?zaloId=page-1')).not.toBe(403);
  });

  test.each(['page-off', 'page-resaved'])('proxyRefuses_%s_andNeverReachesTheHandler', async (id) => {
    const handler = relay.registerIpcHandler('fb:sendSeen');
    expect((await proxy('fb:sendSeen', { accountId: id, threadId: 't1' })).success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  test.each(['page-off', 'page-resaved'])('noEventsOf_%s_reachTheEmployee', async (id) => {
    const relayService = (await import('../../services/http/HttpRelayService')).default.getInstance() as any;
    relayService.running = true;
    try {
      relayService.relayEventToEmployees('fb:onMessage', { fbAccountId: id, message: { body: 'x' } });
      const { audience } = relay.published[relay.published.length - 1];
      expect(canReceiveRelayEvent(audience, 'emp-1', relayService.allowedAccountsFor('emp-1'))).toBe(false);
    } finally { relayService.running = false; }
  });
});
