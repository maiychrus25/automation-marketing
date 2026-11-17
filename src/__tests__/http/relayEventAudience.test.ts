import { startRelay, RelayHarness } from './relayHarness';
import { canReceiveRelayEvent, classifyRelayEvent } from '../../services/socket/relayAudience';

const account = (id: string): any => ({ zalo_id: id, full_name: id, avatar_url: '', phone: '', is_business: 0, is_active: 1, channel: 'zalo', parent_zalo_id: null, cookies: '', imei: '', user_agent: '' });

describe('relayEventToEmployees audience', () => {
  let h: RelayHarness;
  let relay: any;
  const emitMock = () => (jest.requireMock('../../services/event/EventBroadcaster') as any).default.emit as jest.Mock;

  beforeEach(async () => {
    h = await startRelay({
      employees: [
        { id: 'emp-ab', assigned: ['acc-a', 'acc-b'], modules: ['chat', 'workflow', 'integration', 'crm'] },
        { id: 'emp-a', assigned: ['acc-a'], modules: ['chat', 'crm'] },
        { id: 'emp-c', assigned: ['acc-c'], modules: ['chat', 'crm'] },
      ],
      accounts: [account('acc-a'), account('acc-b'), account('acc-c')],
    });
    relay = (await import('../../services/http/HttpRelayService')).default.getInstance();
    for (const id of ['emp-ab', 'emp-a', 'emp-c']) relay.employees.set(id, { employee_id: id, assigned_accounts: [] });
    relay.running = true;
    emitMock().mockClear();
  });
  afterEach(async () => { relay.running = false; relay.employees.clear(); await h.close(); });

  it('workflow:executed is published with a module audience (decided at delivery)', () => {
    relay.relayEventToEmployees('workflow:executed', { workflowId: 'w1', runId: 'r1', status: 'ok' });
    expect(h.published).toEqual([expect.objectContaining({ channel: 'workflow:executed', audience: { kind: 'module', module: 'workflow' } })]);
  });

  it('integration:payment is published with a module audience', () => {
    relay.relayEventToEmployees('integration:payment', { integrationId: 'i1' });
    expect(h.published[0].audience).toEqual({ kind: 'module', module: 'integration' });
  });

  it('a label on acc-a and acc-b reaches the employee of acc-a and not the one of acc-c', async () => {
    const res = await fetch(`${h.url}/api/command/labels`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${h.tokenFor('emp-ab')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: { name: 'L', color: '#fff', emoji: '', pageIds: 'acc-a,acc-b' } }),
    });
    expect(res.status).toBe(200);
    const [channel, data] = emitMock().mock.calls.find((c) => c[0] === 'db:localLabelChanged')!;
    relay.relayEventToEmployees(channel, data);
    const { audience } = h.published[0];
    expect(audience).toEqual({ kind: 'accounts', ids: ['acc-a', 'acc-b'] });
    expect(canReceiveRelayEvent(audience, 'emp-a', ['acc-a'])).toBe(true);
    expect(canReceiveRelayEvent(audience, 'emp-c', ['acc-c'])).toBe(false);
  });

  const asEmp = (id: string, path: string, body: any = {}, method = 'POST') => fetch(`${h.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${h.tokenFor(id)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ zaloId: 'acc-a', ...body }),
  });
  const lastOf = (re: RegExp) => emitMock().mock.calls.filter((c) => re.test(c[0])).pop()!;

  it('label delete/active/reorder route by the stored page ids, not the requesting account', async () => {
    h.db.getLocalLabels.mockReturnValue([{ id: 5, page_ids: 'acc-a,acc-b' }]);
    for (const [path, method] of [['/api/command/labels/5', 'DELETE'], ['/api/command/labels/5/active', 'POST'], ['/api/command/labels/5/order', 'POST']] as const) {
      expect((await asEmp('emp-a', path, {}, method)).status).toBe(200);
      const [channel, data] = lastOf(/^db:localLabelChanged$/);
      expect(data.ownerZaloId).toBeUndefined();
      expect(data.ownerZaloIds).toEqual(['acc-a', 'acc-b']);
      const audience = classifyRelayEvent(channel, data);
      expect(audience).toEqual({ kind: 'accounts', ids: ['acc-a', 'acc-b'] });
      expect(canReceiveRelayEvent(audience, 'emp-b', ['acc-b'])).toBe(true);
      expect(canReceiveRelayEvent(audience, 'emp-c', ['acc-c'])).toBe(false);
    }
  });

  it('a label stored only for other accounts is not attributed to the requester', async () => {
    h.db.getLocalLabels.mockReturnValue([{ id: 5, page_ids: 'acc-b,acc-c' }]);
    const res = await asEmp('emp-a', '/api/command/labels/5', {}, 'DELETE');
    if (res.status === 200) {
      const [channel, data] = lastOf(/^db:localLabelChanged$/);
      expect(data.ownerZaloId).toBeUndefined();
      expect(classifyRelayEvent(channel, data)).toEqual({ kind: 'accounts', ids: ['acc-b', 'acc-c'] });
    } else {
      expect(res.status).toBe(403);
    }
  });

  it('quick-message active/reorder emit the stored owner, not the requesting account', async () => {
    h.db.getAllLocalQuickMessages.mockReturnValue([{ id: 5, owner_zalo_id: 'acc-a' }]);
    for (const p of ['/api/command/quick-messages/5/active', '/api/command/quick-messages/5/order']) {
      expect((await asEmp('emp-a', p)).status).toBe(200);
      expect(lastOf(/^db:localQuickMessageChanged$/)[1].ownerZaloId).toBe('acc-a');
    }
    h.db.getAllLocalQuickMessages.mockReturnValue([{ id: 5, owner_zalo_id: 'acc-b' }]);
    expect((await asEmp('emp-a', '/api/command/quick-messages/5/active')).status).toBe(200);
    expect(lastOf(/^db:localQuickMessageChanged$/)[1].ownerZaloId).toBe('acc-b');
    h.db.getAllLocalQuickMessages.mockReturnValue([]);
    expect((await asEmp('emp-a', '/api/command/quick-messages/5/active')).status).toBe(200);
    expect(lastOf(/^db:localQuickMessageChanged$/)[1].ownerZaloId).toBeUndefined();
  });

  it('label events: a global label is flagged allAccounts, a scoped one is not', async () => {
    h.db.getLocalLabels.mockReturnValue([{ id: 3, page_ids: '' }, { id: 1, page_ids: 'acc-a' }]);
    const call = (path: string, body: any, method = 'POST') => fetch(`${h.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${h.tokenFor('emp-a')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ zaloId: 'acc-a', ...body }),
    });
    const last = () => emitMock().mock.calls.filter((c) => c[0] === 'db:localLabelChanged').pop()![1];
    expect((await call('/api/command/labels', { label: { name: 'G', pageIds: '' } })).status).toBe(200);
    expect(last().allAccounts).toBe(true);
    expect((await call('/api/command/labels/3', {}, 'DELETE')).status).toBe(200);
    expect(last().allAccounts).toBe(true);
    expect((await call('/api/command/labels/3/active', {})).status).toBe(200);
    expect(last().allAccounts).toBe(true);
    expect((await call('/api/command/labels/1', {}, 'DELETE')).status).toBe(200);
    expect(last().allAccounts).toBeUndefined();
    expect((await call('/api/command/labels', { label: { name: 'S', pageIds: 'acc-a' } })).status).toBe(200);
    expect(last().allAccounts).toBeUndefined();
  });
});
