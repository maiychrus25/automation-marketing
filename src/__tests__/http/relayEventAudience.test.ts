import { startRelay, RelayHarness } from './relayHarness';
import { canReceiveRelayEvent, classifyRelayEvent, EPHEMERAL_RELAY_CHANNELS } from '../../services/socket/relayAudience';

const account = (id: string): any => ({ zalo_id: id, full_name: id, avatar_url: '', phone: '', is_business: 0, is_active: 1, channel: 'zalo', cookies: '', imei: '', user_agent: '' });

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

  it.each([
    'event:telegramReaction', 'event:messageEdited', 'event:messagesDeleted', 'event:forumTopicsChanged',
    'event:telegramEntityHydrated', 'event:groupMemberAvatar', 'event:telegramSync', 'event:userPresence',
  ])('%s of a Telegram account reaches only the employees assigned to it; without zaloId, nobody', (channel) => {
    relay.relayEventToEmployees(channel, { zaloId: 'acc-a', channel: 'telegram_user' });
    expect(h.published).toHaveLength(1);
    const { audience } = h.published[0];
    expect(audience).toEqual({ kind: 'accounts', ids: ['acc-a'] });
    expect(canReceiveRelayEvent(audience, 'emp-a', ['acc-a'])).toBe(true);
    expect(canReceiveRelayEvent(audience, 'emp-c', ['acc-c'])).toBe(false);

    h.published.length = 0;
    relay.relayEventToEmployees(channel, { channel: 'telegram_user' });
    const none = h.published[0]?.audience;
    for (const [id, ids] of [['emp-a', ['acc-a']], ['emp-c', ['acc-c']]] as const) {
      expect(none ? canReceiveRelayEvent(none, id, [...ids]) : false).toBe(false);
    }
  });

  it('typing, presence, the two bursty Telegram enrichment events and the poster log, progress and background-job progress are ephemeral (their Finished events stay buffered) (not buffered)', () => {
    // loginCheckProgress stays buffered: its final `null` is the only signal that a login check ended.
    expect(['facebookPoster:trackFinished', 'facebookPoster:commentCollectFinished', 'facebookPoster:runFinished', 'facebookPoster:loginCheckProgress'].some((c) => EPHEMERAL_RELAY_CHANNELS.has(c))).toBe(false);
    expect([...EPHEMERAL_RELAY_CHANNELS].sort()).toEqual(['event:groupMemberAvatar', 'event:telegramEntityHydrated', 'event:typing', 'event:userPresence', 'facebookPoster:commentCollectProgress', 'facebookPoster:log', 'facebookPoster:progress', 'facebookPoster:trackProgress', 'fb:onPresence', 'fb:onTyping']);
  });
});

describe('poster events', () => {
  let h: RelayHarness;
  let relay: any;
  // Rows of fb_poster_runs by id: params_json holds the profiles; `pageManaged` adds a Page-link row for the run's campaign.
  const runs = new Map<string, { profiles: string[]; campaign?: string }>();
  let runLookups = 0;
  let lookupFails = false;

  beforeEach(async () => {
    h = await startRelay({
      employees: [
        { id: 'emp-p1', assigned: [], modules: ['fb_poster'], profiles: ['p1'] },
        { id: 'emp-p12', assigned: [], modules: ['fb_poster'], profiles: ['p1', 'p2'] },
        { id: 'emp-nomod', assigned: [], modules: ['chat'], profiles: ['p1'] },
      ],
      browserProfiles: ['p1', 'p2', 'p3'],
      accounts: [],
    });
    runs.clear();
    runLookups = 0;
    lookupFails = false;
    h.db.queryOneStrict.mockImplementation((sql: string, params: any[]) => {
      if (!/FROM fb_poster_runs WHERE id = \?/.test(sql)) return undefined;
      if (lookupFails) throw new Error('db down');
      runLookups++;
      const run = runs.get(params[0]);
      return run ? { params_json: JSON.stringify({ kind: 'post', profiles: run.profiles }), schedule_id: null, campaign_id: run.campaign ?? null } : undefined;
    });
    h.db.queryStrict.mockImplementation((sql: string) => {
      if (/sqlite_master/.test(sql)) return [{ name: 'page_campaign_links' }];
      if (/SELECT campaign_id FROM page_campaign_links/.test(sql)) return [{ campaign_id: 'page-camp' }];
      return [];
    });
    relay = (await import('../../services/http/HttpRelayService')).default.getInstance();
    relay.running = true;
    relay.posterRunVisible.clear();
    relay.posterRunMisses.clear();
    relay.profileAudienceCache.clear();
  });
  afterEach(async () => { relay.running = false; await h.close(); });

  // The employee's allowed profiles are what SocketIOService asks the relay for (allowedProfilesFor: assigned, existing, and fb_poster held).
  const reaches = (audience: any, id: string) => canReceiveRelayEvent(audience, id, [], undefined, relay.allowedProfilesFor(id));

  it('a log of profile p1 reaches the employees assigned p1 who hold fb_poster, and nobody else', () => {
    runs.set('r1', { profiles: ['p1'] });
    relay.relayEventToEmployees('facebookPoster:log', { runId: 'r1', profileId: 'p1', level: 'info', message: 'm', at: 1 });
    expect(h.published).toHaveLength(1);
    const { audience } = h.published[0];
    expect(audience).toEqual({ kind: 'profiles', ids: ['p1'] });
    expect(reaches(audience, 'emp-p1')).toBe(true);
    expect(reaches(audience, 'emp-p12')).toBe(true);
    expect(reaches(audience, 'emp-nomod')).toBe(false); // assigned, but no fb_poster permission
  });

  it('progress over p1 and p2 reaches only the employee who has both', () => {
    runs.set('r1', { profiles: ['p1', 'p2'] });
    relay.relayEventToEmployees('facebookPoster:progress', { runId: 'r1', done: 0, total: 2, profiles: [{ profileId: 'p1', done: 0, total: 1 }, { profileId: 'p2', done: 0, total: 1 }] });
    const { audience } = h.published[0];
    expect(reaches(audience, 'emp-p12')).toBe(true);
    expect(reaches(audience, 'emp-p1')).toBe(false);
  });

  it('a profile unassigned or deleted since is no longer allowed', () => {
    runs.set('r1', { profiles: ['p3'] });
    relay.relayEventToEmployees('facebookPoster:log', { runId: 'r1', profileId: 'p3', level: 'info', message: 'm', at: 1 });
    expect(reaches(h.published[0].audience, 'emp-p12')).toBe(false);
  });

  it('a run of Page-managed work is not relayed (log and progress); an unknown run or a failed lookup is not either', () => {
    runs.set('page-run', { profiles: ['p1'], campaign: 'page-camp' });
    relay.relayEventToEmployees('facebookPoster:log', { runId: 'page-run', profileId: 'p1', level: 'info', message: 'm', at: 1 });
    relay.relayEventToEmployees('facebookPoster:progress', { runId: 'page-run', done: 0, total: 1, profiles: [{ profileId: 'p1', done: 0, total: 1 }] });
    relay.relayEventToEmployees('facebookPoster:log', { runId: 'ghost', profileId: 'p1', level: 'info', message: 'm', at: 1 });
    runs.set('r1', { profiles: ['p1'] });
    lookupFails = true;
    relay.relayEventToEmployees('facebookPoster:log', { runId: 'r1', profileId: 'p1', level: 'info', message: 'm', at: 1 });
    relay.relayEventToEmployees('facebookPoster:log', { profileId: 'p1', level: 'info', message: 'no run id' });
    expect(h.published).toEqual([]);
  });

  it('the decision is cached per run, dropped at runFinished, and bounded to 200 entries', () => {
    runs.set('r1', { profiles: ['p1'] });
    for (let i = 0; i < 5; i++) relay.relayEventToEmployees('facebookPoster:log', { runId: 'r1', profileId: 'p1', level: 'info', message: String(i), at: i });
    expect(h.published).toHaveLength(5);
    expect(runLookups).toBe(1);
    relay.relayEventToEmployees('facebookPoster:runFinished', { runId: 'r1', status: 'done' });
    expect(relay.posterRunVisible.has('r1')).toBe(false);
    relay.relayEventToEmployees('facebookPoster:log', { runId: 'r1', profileId: 'p1', level: 'info', message: 'again', at: 9 });
    expect(runLookups).toBe(2);
    for (let i = 0; i < 250; i++) { runs.set(`x${i}`, { profiles: ['p1'] }); relay.relayEventToEmployees('facebookPoster:log', { runId: `x${i}`, profileId: 'p1', level: 'info', message: 'm', at: i }); }
    expect(relay.posterRunVisible.size).toBe(200);
    expect(relay.posterRunVisible.has('x0')).toBe(false);
    expect(relay.posterRunVisible.has('x249')).toBe(true);
  });

  it('runFinished of a Page-managed, unknown or unreadable run is not relayed; an ordinary run is, and its cache entry is dropped', () => {
    runs.set('page-run', { profiles: ['p1'], campaign: 'page-camp' });
    runs.set('r1', { profiles: ['p1'] });
    relay.relayEventToEmployees('facebookPoster:runFinished', { runId: 'page-run', status: 'done' });
    relay.relayEventToEmployees('facebookPoster:runFinished', { runId: 'ghost', status: 'done' });
    expect(h.published).toEqual([]);
    relay.relayEventToEmployees('facebookPoster:runFinished', { runId: 'r1', status: 'done' });
    expect(h.published.map((e) => e.data)).toEqual([{ runId: 'r1', status: 'done' }]);
    expect(relay.posterRunVisible.has('r1')).toBe(false);
    expect(relay.posterRunVisible.has('page-run')).toBe(false);
  });

  it('an unknown or unreadable run is looked up once per 5 seconds, not per log line', () => {
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      const log = () => relay.relayEventToEmployees('facebookPoster:log', { runId: 'ghost', profileId: 'p1', level: 'info', message: 'm', at: 1 });
      for (let i = 0; i < 5; i++) log();
      expect(h.published).toEqual([]);
      const lookups = () => h.db.queryOneStrict.mock.calls.filter((c: any[]) => /FROM fb_poster_runs WHERE id = \?/.test(c[0])).length;
      expect(lookups()).toBe(1);
      now.mockReturnValue(1_000_000 + 4_999);
      log();
      expect(lookups()).toBe(1);
      now.mockReturnValue(1_000_000 + 5_000);
      log();
      expect(lookups()).toBe(2);
      // the run appears: the next ask after the window is decisive and cached
      runs.set('ghost', { profiles: ['p1'] });
      now.mockReturnValue(1_000_000 + 10_000);
      log();
      expect(h.published).toHaveLength(1);
      log();
      expect(lookups()).toBe(3);
      // bounded
      for (let i = 0; i < 250; i++) relay.relayEventToEmployees('facebookPoster:log', { runId: `u${i}`, profileId: 'p1', level: 'info', message: 'm', at: i });
      expect(relay.posterRunMisses.size).toBeLessThanOrEqual(200);
    } finally {
      now.mockRestore();
    }
  });

  it('the socket audience resolver is cached for 2 seconds and cleared with the account cache; the request check is not cached', () => {
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(5_000_000);
      expect(relay.allowedProfilesForAudience('emp-p1')).toEqual(['p1']);
      h.setProfiles('emp-p1', ['p2']); // unassigned p1, assigned p2 in the store
      expect(relay.allowedProfilesFor('emp-p1')).toEqual(['p2']); // request path: immediate
      expect(relay.allowedProfilesForAudience('emp-p1')).toEqual(['p1']); // socket path: cached
      now.mockReturnValue(5_000_000 + 2_000);
      expect(relay.allowedProfilesForAudience('emp-p1')).toEqual(['p2']);
      h.setProfiles('emp-p1', ['p1']);
      expect(relay.allowedProfilesForAudience('emp-p1')).toEqual(['p2']);
      relay.invalidateAllowedAccounts('emp-p1');
      expect(relay.allowedProfilesForAudience('emp-p1')).toEqual(['p1']);
      h.setProfiles('emp-p1', ['p2']);
      relay.invalidateAllowedAccounts();
      expect(relay.allowedProfilesForAudience('emp-p1')).toEqual(['p2']);
    } finally {
      h.setProfiles('emp-p1', ['p1']);
      now.mockRestore();
    }
  });

  it('the changed notifications go to the fb_poster module with a reduced payload', () => {
    runs.set('r1', { profiles: ['p1'] });
    relay.relayEventToEmployees('facebookPoster:runFinished', { runId: 'r1', status: 'done', extra: 'x' });
    relay.relayEventToEmployees('facebookPoster:schedulesChanged', undefined);
    relay.relayEventToEmployees('facebookPoster:leadsFound', { count: 2, samples: [{ text: 'bí mật' }], auto: false, leadIds: [1], campaignIds: [] });
    expect(h.published.map((e) => [e.channel, e.audience])).toEqual([
      ['facebookPoster:runFinished', { kind: 'module', module: 'fb_poster' }],
      ['facebookPoster:schedulesChanged', { kind: 'module', module: 'fb_poster' }],
      ['facebookPoster:leadsFound', { kind: 'module', module: 'fb_poster' }],
    ]);
    expect(h.published[0].data).toEqual({ runId: 'r1', status: 'done' });
    expect(JSON.stringify(h.published[2].data)).not.toContain('bí mật');
  });

  it('scheduleMissed and unknown poster channels reach nobody', () => {
    relay.relayEventToEmployees('facebookPoster:scheduleMissed', { id: 's1' });
    relay.relayEventToEmployees('facebookPoster:somethingNew', { profileId: 'p1' });
    expect(h.published).toEqual([]);
  });
});
