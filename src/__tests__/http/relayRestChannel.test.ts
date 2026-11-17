import { startRelay, RelayHarness } from './relayHarness';

const acct = (id: string, channel: string): any => ({ zalo_id: id, full_name: id, avatar_url: '', phone: '', is_business: 0, is_active: 1, channel });

describe('REST conversations and messages carry the channel of the stored row', () => {
  let relay: RelayHarness;
  const call = async (path: string) => {
    const res = await fetch(relay.url + path, { headers: { Authorization: `Bearer ${relay.tokenFor('emp-1')}` } });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  };

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    relay = await startRelay({
      employees: [{ id: 'emp-1', assigned: ['page-1', 'acc-a'], modules: ['chat'] }],
      accounts: [acct('page-1', 'facebook'), acct('acc-a', 'zalo')],
      fbAccounts: [{ id: 'uuid-personal', facebook_id: 'fb-personal', parent_facebook_id: null }, { id: 'uuid-page-1', facebook_id: 'page-1', parent_facebook_id: 'fb-personal' }],
      connectedFacebook: ['page-1'],
    });
    relay.db.query.mockImplementation((sql: string, params: any[]) => {
      if (sql.includes('COUNT(*)')) return [{ cnt: 1 }];
      if (sql.includes('FROM contacts')) {
        return params[0] === 'page-1'
          ? [{ contact_id: 't1', owner_zalo_id: 'page-1', channel: 'facebook' }]
          : [{ contact_id: 'u1', owner_zalo_id: 'acc-a', channel: 'zalo' }, { contact_id: 'u2', owner_zalo_id: 'acc-a' }];
      }
      return [];
    });
    const msgs = (owner: string) => owner === 'page-1'
      ? [{ msg_id: 'm1', thread_id: 't1', owner_zalo_id: 'page-1', content: 'hi', msg_type: 'text', channel: 'facebook' }]
      : [{ msg_id: 'm2', thread_id: 'u1', owner_zalo_id: 'acc-a', content: 'hi', msg_type: 'text', channel: 'zalo' }, { msg_id: 'm3', thread_id: 'u1', owner_zalo_id: 'acc-a', content: 'hi', msg_type: 'text' }];
    for (const name of ['getMessages', 'getMessagesAround', 'getFileMessages', 'getMediaMessages', 'searchMessages']) {
      relay.db[name].mockImplementation((owner: string) => msgs(owner));
    }
    relay.db.getMessagesByType.mockImplementation((owner: string) => msgs(owner));
    relay.db.getMessageById.mockImplementation((owner: string) => msgs(owner)[0]);
  });
  afterAll(() => relay.close());

  // One entry per REST endpoint that returns conversation rows or message rows (flags, counts and pinned ids are not row-shaped).
  const ENDPOINTS = [
    { name: 'conversations', path: (a: string, t: string) => `/api/query/conversations?zaloId=${a}`, thread: 't1' },
    { name: 'conversations/updates', path: (a: string) => `/api/query/conversations/updates?zaloId=${a}`, thread: 't1' },
    { name: 'conversations/:id', path: (a: string, t: string) => `/api/query/conversations/${t}?zaloId=${a}`, thread: 't1' },
    { name: 'messages', path: (a: string, t: string) => `/api/query/messages?zaloId=${a}&threadId=${t}`, thread: 't1' },
    { name: 'messages/around', path: (a: string, t: string) => `/api/query/messages/around?zaloId=${a}&threadId=${t}&msgId=5`, thread: 't1' },
    { name: 'messages/file', path: (a: string, t: string) => `/api/query/messages/file?zaloId=${a}&threadId=${t}`, thread: 't1' },
    { name: 'messages/media', path: (a: string, t: string) => `/api/query/messages/media?zaloId=${a}&threadId=${t}`, thread: 't1' },
    { name: 'messages/:id', path: (a: string, t: string) => `/api/query/messages/m1?zaloId=${a}&threadId=${t}`, thread: 't1' },
    { name: 'messages/by-type', path: (a: string, t: string) => `/api/query/messages/by-type?zaloId=${a}&threadId=${t}&msgType=text`, thread: 't1' },
    { name: 'search/messages', path: (a: string) => `/api/search/messages?zaloId=${a}&q=hi`, thread: 't1' },
  ];
  const rowsOf = (body: any): any[] => Array.isArray(body.data?.items) ? body.data.items : [body.data];

  test('theEndpointListCoversUpdatesAndIsNotEmpty', () => {
    expect(ENDPOINTS.length).toBeGreaterThan(0);
    expect(ENDPOINTS.map((e) => e.name)).toContain('conversations/updates');
  });

  test.each(ENDPOINTS.map((e) => [e.name, e] as const))('%s rows of a Page are facebook and rows of a Zalo account are zalo', async (_name, e) => {
    const page = await call(e.path('page-1', 't1'));
    expect(page.status).toBe(200);
    expect(rowsOf(page.body).length).toBeGreaterThan(0);
    expect(rowsOf(page.body).map((r: any) => r.channel)).toEqual(rowsOf(page.body).map(() => 'facebook'));
    const zalo = await call(e.path('acc-a', 'u1'));
    expect(zalo.status).toBe(200);
    expect(rowsOf(zalo.body).length).toBeGreaterThan(0);
    expect(rowsOf(zalo.body).map((r: any) => r.channel)).toEqual(rowsOf(zalo.body).map(() => 'zalo'));
  });

  test('searchResultsOfATelegramAccountKeepTheirEarlierShapePlusChannel', async () => {
    relay.db.searchMessages.mockImplementationOnce(() => [{
      msg_id: 'm9', thread_id: 'c1', owner_zalo_id: 'acc-a', content: 'hi', timestamp: 5, channel: 'telegram_user',
      edit_history: '["old"]', inline_buttons: '[]', is_edited: 1, reply_to_id: '1',
    }]);
    const res = await call('/api/search/messages?zaloId=acc-a&q=hi');
    expect(Object.keys(res.body.data.items[0]).sort()).toEqual(['channel', 'msg_id', 'snippet', 'thread_id', 'thread_name', 'timestamp']);
    expect(res.body.data.items[0].channel).toBe('telegram_user');
  });
});
