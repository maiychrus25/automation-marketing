import { startRelay, RelayHarness } from './relayHarness';

const ACCOUNTS: any[] = ['acc-a', 'acc-b'].map((id) => ({
  zalo_id: id, full_name: id, avatar_url: '', phone: '', is_business: 0, is_active: 1, channel: 'zalo', cookies: 'SECRET', imei: 'IMEI', user_agent: 'UA',
}));
const ALL_MODULES = ['chat', 'crm', 'ai_assistant', 'integration', 'friends'];

describe('POST /api/proxy/action runs only listed channels, for allowed accounts and modules', () => {
  let relay: RelayHarness;
  const proxy = async (employeeId: string, channel: string, params: unknown) => {
    const res = await fetch(`${relay.url}/api/proxy/action`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${relay.tokenFor(employeeId)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, params }),
    });
    return (await res.json()) as any;
  };

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    relay = await startRelay({
      employees: [
        { id: 'emp-1', assigned: ['acc-a'], modules: ALL_MODULES },
        { id: 'emp-none', assigned: [], modules: ALL_MODULES },
        { id: 'emp-nocrm', assigned: ['acc-a'], modules: ['chat'] },
        { id: 'emp-nochat', assigned: ['acc-a'], modules: ['crm'] },
      ],
      accounts: ACCOUNTS,
    });
  });
  afterAll(() => relay.close());

  test('aChannelOutsideTheListIsRefusedAndNoHandlerRuns', async () => {
    const handler = relay.registerIpcHandler('db:setStoragePath');
    const body = await proxy('emp-1', 'db:setStoragePath', { path: '/tmp/x' });
    expect(body.success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  test.each([
    ['auth.zaloId', { auth: { zaloId: 'acc-b' } }],
    ['ownerZaloId', { ownerZaloId: 'acc-b' }],
    ['targetZaloId next to an allowed zaloId', { zaloId: 'acc-a', targetZaloId: 'acc-b' }],
    ['a comma list with a foreign id', { zaloId: 'acc-a,acc-b' }],
    ['an array with a foreign id', { zaloIds: ['acc-a', 'acc-b'] }],
    ['an object instead of an id', { zaloId: { x: 1 } }],
    ['auth.accountId of another account', { zaloId: 'acc-a', auth: { accountId: 'acc-b' } }],
  ])('aForeignOrMalformedAccountIsRefused: %s', async (_name, params) => {
    const handler = relay.registerIpcHandler('zalo:sendMessage');
    const body = await proxy('emp-1', 'zalo:sendMessage', params);
    expect(body.success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  test('anEmployeeWithNoUsableAccountIsRefusedWhenNoIdIsGiven', async () => {
    const handler = relay.registerIpcHandler('zalo:sendMessage');
    const body = await proxy('emp-none', 'zalo:sendMessage', { text: 'hi' });
    expect(body.success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  test('aLabelNamingAForeignAccountInPageIdsIsRefusedOnTheProxyPathToo', async () => {
    const handler = relay.registerIpcHandler('db:upsertLocalLabel');
    for (const pageIds of ['acc-b', 'acc-a,acc-b', ['acc-b']]) {
      const body = await proxy('emp-1', 'db:upsertLocalLabel', { label: { name: 'n', pageIds } });
      expect([pageIds, body.success]).toEqual([pageIds, false]);
    }
    expect(handler).not.toHaveBeenCalled();
    expect((await proxy('emp-1', 'db:upsertLocalLabel', { label: { name: 'n', pageIds: 'acc-a' } })).success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  describe('ai:saveAssistant keeps the boss key only for the stored host', () => {
    const assistant = (extra: object) => ({ assistant: { id: 'as-1', name: 'n', platform: 'openai', model: 'm', ...extra } });
    beforeEach(() => relay.setAssistant('as-1', { platform: 'openai', baseUrl: 'https://api.example.com/v1' }));
    test('aNewBaseUrlWithTheMaskedKeyIsRefusedAndTheHandlerDoesNotRun', async () => {
      const handler = relay.registerIpcHandler('ai:saveAssistant');
      const body = await proxy('emp-1', 'ai:saveAssistant', assistant({ apiKey: '***', baseUrl: 'https://evil.test' }));
      expect(body).toEqual({ success: false, error: 'Đổi địa chỉ máy chủ AI thì phải nhập lại khoá API', code: 'KEY_REQUIRED' });
      expect(handler).not.toHaveBeenCalled();
    });
    test('theSameBaseUrlWithTheMaskedKeyAndANewRealKeyWithAnyUrlRun', async () => {
      const handler = relay.registerIpcHandler('ai:saveAssistant');
      expect((await proxy('emp-1', 'ai:saveAssistant', assistant({ apiKey: '***', baseUrl: 'https://api.example.com/v1' }))).success).toBe(true);
      expect((await proxy('emp-1', 'ai:saveAssistant', assistant({ apiKey: 'sk-new', baseUrl: 'https://other.test' }))).success).toBe(true);
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  test('aMissingModuleIsRefused', async () => {
    const crm = relay.registerIpcHandler('crm:saveNote');
    const mark = relay.registerIpcHandler('db:markAsRead');
    expect((await proxy('emp-nocrm', 'crm:saveNote', { zaloId: 'acc-a' })).success).toBe(false);
    expect((await proxy('emp-nochat', 'db:markAsRead', { zaloId: 'acc-a' })).success).toBe(false);
    expect(crm).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
  });

  test('anAllowedChannelForAnAllowedAccountRunsTheHandlerOnce', async () => {
    const handler = relay.registerIpcHandler('zalo:sendMessage');
    const body = await proxy('emp-1', 'zalo:sendMessage', { zaloId: 'acc-a' });
    expect(body.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('aChannelWithoutAccountRuleRunsForAnEmployeeWithNoAccount', async () => {
    const handler = relay.registerIpcHandler('integration:toggle');
    const body = await proxy('emp-none', 'integration:toggle', { id: 'i1' });
    expect(body.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('employeeSuppliedCredentialsAreNeverForwardedWhenRealAuthCannotBeResolved', async () => {
    const handler = relay.registerIpcHandler('zalo:sendMessage');
    const body = await proxy('emp-1', 'zalo:sendMessage', { zaloId: 'acc-a', auth: { zaloId: 'acc-a', cookies: 'employee-supplied', imei: 'x' } });
    expect(body.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0] as any[])[1].auth).toEqual({ zaloId: 'acc-a' });
  });

  test('theBossAuthReplacesTheEmployeeAuthWhenItResolves', async () => {
    relay.db.query.mockReturnValueOnce([{ cookies: 'BOSS-COOKIES', imei: 'BOSS-IMEI', user_agent: 'BOSS-UA' }]);
    const handler = relay.registerIpcHandler('zalo:sendMessage');
    await proxy('emp-1', 'zalo:sendMessage', { zaloId: 'acc-a', auth: { zaloId: 'acc-a', cookies: 'employee-supplied', imei: 'x' } });
    expect((handler.mock.calls[0] as any[])[1].auth).toEqual({ cookies: 'BOSS-COOKIES', imei: 'BOSS-IMEI', userAgent: 'BOSS-UA' });
  });
});
