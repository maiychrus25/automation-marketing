import { startRelay, RelayHarness } from './relayHarness';

const ACCOUNTS: any[] = ['acc-a', 'acc-b', 'acc-c'].map((id) => ({
  zalo_id: id, full_name: id, avatar_url: '', phone: '', is_business: 0, is_active: 1, channel: 'zalo', cookies: 'SECRET', imei: 'IMEI', user_agent: 'UA',
}));
const ALL_MODULES = ['chat', 'crm', 'ai_assistant', 'integration', 'friends'];
const OWN_UUID = 'aaaa-1111';
const FOREIGN_UUID = 'bbbb-2222';

// Records the employee (acc-a only) may and may not address by id.
const OWNED: Array<[table: string, id: string | number, own: string, foreign: string]> = [
  ['local_labels', 7, 'acc-a', 'acc-b,acc-c'],
  ['local_quick_messages', 4, 'acc-a', 'acc-b'],
  ['crm_campaigns', 3, 'acc-a', 'acc-b'],
  ['crm_tags', 5, 'acc-a', 'acc-b'],
  ['media_library_items', OWN_UUID, 'acc-a', 'acc-b'],
  ['media_library_folders', 8, 'acc-a', 'acc-b'],
];

// [method, path, body, id key (own/foreign variant), db method that must not run | relay handler that must not run]
type RestRow = [method: string, path: (id: string | number) => string, body: (id: string | number) => unknown, table: string, probe: { db?: string; handler?: string }];
const REST_ROWS: RestRow[] = [
  ['DELETE', (id) => `/api/command/labels/${id}`, () => ({}), 'local_labels', { db: 'deleteLocalLabel' }],
  ['POST', (id) => `/api/command/labels/${id}/active`, () => ({ isActive: 0 }), 'local_labels', { db: 'setLocalLabelActive' }],
  ['POST', (id) => `/api/command/labels/${id}/order`, () => ({ order: 2 }), 'local_labels', { db: 'setLocalLabelOrder' }],
  ['POST', () => '/api/command/labels', (id) => ({ label: { id, name: 'x', color: '#fff', emoji: '', pageIds: 'acc-a' } }), 'local_labels', { db: 'upsertLocalLabel' }],
  ['POST', (id) => `/api/command/quick-messages/${id}/active`, () => ({ isActive: 0 }), 'local_quick_messages', { db: 'setLocalQMActive' }],
  ['POST', (id) => `/api/command/quick-messages/${id}/order`, () => ({ order: 2 }), 'local_quick_messages', { db: 'setLocalQMOrder' }],
  ['DELETE', (id) => `/api/command/crm/campaigns/${id}`, () => ({}), 'crm_campaigns', { db: 'deleteCRMCampaign' }],
  ['POST', () => '/api/command/crm/campaigns/clone', (id) => ({ campaignId: id, zaloId: 'acc-a' }), 'crm_campaigns', { db: 'cloneCRMCampaign' }],
  ['POST', () => '/api/command/crm/campaigns/status', (id) => ({ campaignId: id, status: 'active' }), 'crm_campaigns', { db: 'updateCRMCampaignStatus' }],
  ['POST', () => '/api/command/crm/campaigns/contacts', (id) => ({ campaignId: id, zaloId: 'acc-a', contacts: [] }), 'crm_campaigns', { db: 'addCampaignContacts' }],
  // The DELETE branch of this path is shadowed by the POST branch above it in executeRestCommand, so the handler that runs is addCampaignContacts.
  ['DELETE', () => '/api/command/crm/campaigns/contacts', (id) => ({ campaignId: id, contactIds: ['c1'] }), 'crm_campaigns', { db: 'addCampaignContacts' }],
  ['POST', () => '/api/command/crm/campaigns/contacts/all', (id) => ({ campaignId: id }), 'crm_campaigns', { db: 'deleteAllCampaignContacts' }],
  ['POST', () => '/api/command/crm/campaigns/contacts/delete', (id) => ({ campaignId: id, contactIds: ['c1'] }), 'crm_campaigns', { db: 'deleteCampaignContacts' }],
  ['GET', (id) => `/api/query/crm/campaigns/contacts?campaignId=${id}`, () => undefined, 'crm_campaigns', { handler: 'getCampaignContactsHandler' }],
  ['DELETE', (id) => `/api/command/crm/tags/${id}`, () => ({}), 'crm_tags', { db: 'run' }],
  ['GET', (id) => `/api/library/item/${id}`, () => undefined, 'media_library_items', { handler: 'getItem' }],
  ['DELETE', (id) => `/api/library/item/${id}`, () => undefined, 'media_library_items', { handler: 'deleteItem' }],
  ['PATCH', () => `/api/library/item/${OWN_UUID}`, (id) => ({ uuid: id, name: 'renamed' }), 'media_library_items', { handler: 'updateItem' }],
  ['GET', (id) => `/api/library/file/${id}`, () => undefined, 'media_library_items', { handler: 'serveFile' }],
  ['GET', (id) => `/api/library/thumb/${id}`, () => undefined, 'media_library_items', { handler: 'serveThumb' }],
  ['POST', () => '/api/command/crm/tags/assign', (id) => ({ tagId: id, contactId: 'c1', zaloId: 'acc-a' }), 'crm_tags', { db: 'run' }],
  ['POST', () => '/api/command/label-threads', (id) => ({ labelId: id, threadId: 't', zaloId: 'acc-a' }), 'local_labels', { db: 'assignLocalLabelToThread' }],
  ['DELETE', () => '/api/command/label-threads', (id) => ({ labelId: id, threadId: 't', zaloId: 'acc-a' }), 'local_labels', { db: 'removeLocalLabelFromThread' }],
  ['PATCH', () => `/api/library/item/${OWN_UUID}`, (id) => ({ folderId: id, name: 'moved' }), 'media_library_folders', { handler: 'updateItem' }],
  ['POST', () => '/api/library/folders', (id) => ({ name: 'sub', parentId: id, zaloId: 'acc-a' }), 'media_library_folders', { handler: 'createFolder' }],
  ['DELETE', (id) => `/api/library/folders/${id}`, () => undefined, 'media_library_folders', { handler: 'deleteFolder' }],
];

describe('a record addressed by its own id must belong to an account the employee may use', () => {
  let relay: RelayHarness;
  const idsOf = (table: string) => {
    const [, id, own, foreign] = OWNED.find((row) => row[0] === table)!;
    // The foreign record has another id than the own one so both can be stored at once.
    const foreignId = typeof id === 'number' ? id + 100 : FOREIGN_UUID;
    return { ownId: id, foreignId, own, foreign };
  };
  // DELETE and PATCH under /api/library are not forwarded by the public dispatcher (404 today); the guard is still tested through handleRestApi.
  const call = async (employeeId: string, method: string, pathAndQuery: string, body?: unknown) => {
    const base = method !== 'GET' && pathAndQuery.startsWith('/api/library/') ? relay.restApiUrl : relay.url;
    const res = await fetch(base + pathAndQuery, {
      method,
      headers: { Authorization: `Bearer ${relay.tokenFor(employeeId)}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  };
  const ran = (probe: RestRow[4]) => (probe.db ? relay.db[probe.db].mock.calls.length > 0 : relay.handlerCalls.includes(probe.handler!));
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
      ],
      accounts: ACCOUNTS,
    });
  });
  beforeEach(() => {
    relay.handlerCalls.length = 0;
    Object.values(relay.db).forEach((fn: any) => fn?.mockClear?.());
    for (const [table] of OWNED) {
      const { ownId, foreignId, own, foreign } = idsOf(table);
      relay.setOwner(table, ownId, own);
      relay.setOwner(table, foreignId, foreign);
    }
  });
  afterAll(() => relay.close());

  test.each(REST_ROWS.map((row) => [`${row[0]} ${row[1]('<id>')}`, row] as const))('REST %s: a record of another account is refused and nothing runs', async (_name, [method, path, body, table, probe]) => {
    const { foreignId } = idsOf(table);
    const { status, body: answer } = await call('emp-1', method, path(foreignId), body(foreignId));
    expect({ status, code: answer.code }).toEqual({ status: 403, code: 'ACCOUNT_FORBIDDEN' });
    expect(ran(probe)).toBe(false);
  });

  test.each(REST_ROWS.map((row) => [`${row[0]} ${row[1]('<id>')}`, row] as const))('REST %s: a record of the employee own account goes through', async (_name, [method, path, body, table, probe]) => {
    const { ownId } = idsOf(table);
    const { status } = await call('emp-1', method, path(ownId), body(ownId));
    expect(status).not.toBe(403);
    expect(ran(probe)).toBe(true);
  });

  test('theConfirmedExampleAnEmployeeOfAccountACannotDeleteALabelOfBAndC', async () => {
    relay.setOwner('local_labels', 21, 'acc-b,acc-c');
    const { status, body } = await call('emp-1', 'DELETE', '/api/command/labels/21');
    expect({ status, code: body.code }).toEqual({ status: 403, code: 'ACCOUNT_FORBIDDEN' });
    expect(relay.db.deleteLocalLabel).not.toHaveBeenCalled();
  });

  test('aLabelOfSeveralAccountsIsRefusedWhenOneOfThemIsNotUsable', async () => {
    relay.setOwner('local_labels', 22, 'acc-a,acc-b');
    expect((await call('emp-1', 'DELETE', '/api/command/labels/22')).status).toBe(403);
    expect(relay.db.deleteLocalLabel).not.toHaveBeenCalled();
  });

  test('aGlobalLabelStaysReadyForEveryEmployeeToChangeAsToday', async () => {
    relay.setOwner('local_labels', 23, '');
    expect((await call('emp-1', 'POST', '/api/command/labels/23/active', { isActive: 0 })).status).toBe(200);
    expect(relay.db.setLocalLabelActive).toHaveBeenCalled();
  });

  test('aGlobalLabelCanStillBeAssignedToAThread', async () => {
    relay.setOwner('local_labels', 24, '');
    expect((await call('emp-1', 'POST', '/api/command/label-threads', { labelId: 24, threadId: 't', zaloId: 'acc-a' })).status).toBe(200);
    expect(relay.db.assignLocalLabelToThread).toHaveBeenCalled();
  });

  test('aMissingRecordIsLeftToTheHandler', async () => {
    expect((await call('emp-1', 'DELETE', '/api/command/labels/999')).status).toBe(200);
    expect(relay.db.deleteLocalLabel).toHaveBeenCalled();
  });

  test('anEmployeeWithNoAccountIsRefusedOnAnyOwnedRecord', async () => {
    expect((await call('emp-none', 'DELETE', '/api/command/crm/campaigns/3')).status).toBe(403);
    expect(relay.db.deleteCRMCampaign).not.toHaveBeenCalled();
  });

  test('aCampaignIdThatTheHandlerParsesLeniently', async () => {
    relay.setOwner('crm_campaigns', 31, 'acc-b');
    const { status } = await call('emp-1', 'POST', '/api/command/crm/campaigns/status', { campaignId: '31abc', status: 'active' });
    expect(status).toBe(403);
    expect(relay.db.updateCRMCampaignStatus).not.toHaveBeenCalled();
  });

  test('aPatchWithTheForeignUuidOnlyInTheBodyIsRefused', async () => {
    const { status } = await call('emp-1', 'PATCH', `/api/library/item/${OWN_UUID}`, { uuid: FOREIGN_UUID, name: 'x' });
    expect(status).toBe(403);
    expect(relay.handlerCalls).not.toContain('updateItem');
  });

  // ── Proxied boss handlers ──
  const PROXY_ROWS: Array<[channel: string, table: string, params: (id: string | number) => unknown]> = [
    ['db:deleteLocalLabel', 'local_labels', (id) => ({ id })],
    ['db:setLocalLabelActive', 'local_labels', (id) => ({ id, isActive: 0 })],
    ['db:setLocalLabelOrder', 'local_labels', (id) => ({ id, order: 1 })],
    ['db:upsertLocalLabel', 'local_labels', (id) => ({ label: { id, name: 'x', pageIds: 'acc-a' } })],
    ['db:assignLocalLabelToThread', 'local_labels', (id) => ({ zaloId: 'acc-a', labelId: id, threadId: 't' })],
    ['db:removeLocalLabelFromThread', 'local_labels', (id) => ({ zaloId: 'acc-a', labelId: id, threadId: 't' })],
    ['db:bulkAssignLocalLabelToThread', 'local_labels', (id) => ({ zaloId: 'acc-a', labelIds: [id], threadIds: ['t'] })],
    ['db:setLocalQMActive', 'local_quick_messages', (id) => ({ id, isActive: 0 })],
    ['db:setLocalQMOrder', 'local_quick_messages', (id) => ({ id, order: 1 })],
    ['crm:deleteCampaign', 'crm_campaigns', (id) => ({ zaloId: 'acc-a', campaignId: id })],
    ['crm:updateCampaignStatus', 'crm_campaigns', (id) => ({ campaignId: id, status: 'paused' })],
    ['zalo:sendImages', 'media_library_items', (id) => ({ zaloId: 'acc-a', _libraryUuid: id })],
    ['zalo:sendImages', 'media_library_items', (id) => ({ zaloId: 'acc-a', _libraryUuids: [id] })],
  ];

  test.each(PROXY_ROWS.map((row) => [`${row[0]} ${JSON.stringify(row[2]('<id>'))}`, row] as const))('proxy %s: a record of another account is refused and the handler does not run', async (_name, [channel, table, params]) => {
    const handler = relay.registerIpcHandler(channel);
    const { foreignId } = idsOf(table);
    const answer = await proxy('emp-1', channel, params(foreignId));
    expect(answer.success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  test.each(PROXY_ROWS.map((row) => [`${row[0]} ${JSON.stringify(row[2]('<id>'))}`, row] as const))('proxy %s: a record of the employee own account runs the handler', async (_name, [channel, table, params]) => {
    const handler = relay.registerIpcHandler(channel);
    const { ownId } = idsOf(table);
    await proxy('emp-1', channel, params(ownId));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // The sendVideo branch resolves the uuid itself and never reaches the registered handler with the library fake.
  test('sendVideoFromAForeignLibraryItemIsRefusedAndAnOwnOneIsNot', async () => {
    const refusal = 'Không có quyền truy cập bản ghi này';
    expect((await proxy('emp-1', 'zalo:sendVideo', { zaloId: 'acc-a', _libraryUuid: FOREIGN_UUID })).error).toBe(refusal);
    expect((await proxy('emp-1', 'zalo:sendVideo', { zaloId: 'acc-a', _libraryUuid: OWN_UUID })).error).not.toBe(refusal);
  });

  test('oneForeignUuidInAnOwnListRefusesTheWholeRequest', async () => {
    const handler = relay.registerIpcHandler('zalo:sendImages');
    const answer = await proxy('emp-1', 'zalo:sendImages', { zaloId: 'acc-a', _libraryUuids: [OWN_UUID, FOREIGN_UUID] });
    expect(answer.success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  test('anIdGivenAsAStringIsLookedUpTheSameWay', async () => {
    const handler = relay.registerIpcHandler('db:deleteLocalLabel');
    relay.setOwner('local_labels', 41, 'acc-b');
    expect((await proxy('emp-1', 'db:deleteLocalLabel', { id: '41' })).success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
