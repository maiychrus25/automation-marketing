import * as fs from 'fs';
import * as path from 'path';
import { startRelay, RelayHarness } from './relayHarness';

const SOURCE = fs.readFileSync(path.join(__dirname, '../../services/http/HttpRelayService.ts'), 'utf8');
const FAMILY = '(?:query|search|command|library)';

// Mọi đường REST mà bộ điều phối so khớp: chuỗi trong `pathname === '…'` / `startsWith('…')`
// và regex `/^\/api\/…$/` (điền mẫu vào chỗ ký tự đại diện). Không viết tay.
function extractRoutes(): string[] {
  const routes = new Set<string>();
  for (const m of SOURCE.matchAll(new RegExp(`pathname === '(/api/${FAMILY}/[^']+)'`, 'g'))) routes.add(m[1]);
  for (const m of SOURCE.matchAll(new RegExp(`startsWith\\('(/api/${FAMILY}/[^']*[^/'])'\\)`, 'g'))) routes.add(m[1]);
  for (const m of SOURCE.matchAll(new RegExp(`/\\^(\\\\/api\\\\/${FAMILY}\\\\/.*?)\\$/(?=[.),])`, 'g'))) {
    const concrete = m[1]
      .replace(/\\\//g, '/')
      .replace(/\(\[\^\/\]\+\)|\[\^\/\]\+/g, 'x1')
      .replace(/\\d\+/g, '1')
      .replace(/\[a-f0-9-\]\+/g, 'a1b2');
    if (!/[\\[\](){}^$*+?|]/.test(concrete)) routes.add(concrete);
  }
  return [...routes].sort();
}

// Phục vụ không cần đăng nhập (đứng trước bước xác thực), không mang tham số tài khoản.
const UNAUTHENTICATED = [/^\/api\/library\/file\//, /^\/api\/library\/thumb\//];
// Luôn bị từ chối theo thiết kế, kể cả với tài khoản được phép.
const ALWAYS_REFUSED = [/^\/api\/query\/proxies/, /^\/api\/(query|command)\/settings\/x1$/];

const ALL_ROUTES = extractRoutes().filter((r) => !UNAUTHENTICATED.some((re) => re.test(r)));
const READ_ROUTES = ALL_ROUTES.filter((r) => !r.startsWith('/api/command/'));
const COMMAND_ROUTES = ALL_ROUTES.filter((r) => r.startsWith('/api/command/'));
const refusedByDesign = (route: string) => ALWAYS_REFUSED.some((re) => re.test(route));

const ALL_MODULES = ['chat', 'analytics', 'crm', 'erp', 'ai_assistant', 'workflow', 'integration', 'friends'];
const ACCOUNTS: any[] = [
  { zalo_id: 'acc-a', full_name: 'A', avatar_url: '', phone: '', is_business: 0, is_active: 1, channel: 'zalo', cookies: 'SECRET', imei: 'IMEI', user_agent: 'UA' },
  { zalo_id: 'acc-b', full_name: 'B', avatar_url: '', phone: '', is_business: 0, is_active: 1, channel: 'zalo', cookies: 'SECRET', imei: 'IMEI', user_agent: 'UA' },
  { zalo_id: 'fb-personal', full_name: 'F', avatar_url: '', phone: '', is_business: 0, is_active: 1, channel: 'facebook', cookies: 'SECRET', imei: 'IMEI', user_agent: 'UA' },
];

describe('REST routes of the boss relay check accounts and modules', () => {
  let relay: RelayHarness;
  const call = async (employeeId: string, method: string, pathAndQuery: string, body?: unknown) => {
    const res = await fetch(relay.url + pathAndQuery, {
      method,
      headers: { Authorization: `Bearer ${relay.tokenFor(employeeId)}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  };

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined); // HttpRelayService ghi một dòng cho mỗi yêu cầu
    relay = await startRelay({
      employees: [
        { id: 'emp-1', assigned: ['acc-a'], modules: ALL_MODULES },
        { id: 'emp-2', assigned: ['fb-personal'], modules: ALL_MODULES },
        { id: 'emp-3', assigned: ['acc-a'], modules: ['chat'] },
      ],
      accounts: ACCOUNTS,
      fbAccounts: [{ id: 'uuid-fb-personal', facebook_id: 'fb-personal', parent_facebook_id: null }],
    });
  });
  afterAll(() => relay.close());

  test('anAccessCheckThatThrowsAnswers500WithoutDetails', async () => {
    relay.db.getWorkflowById.mockImplementation(() => { throw new Error('secret: cannot open /boss/db'); });
    try {
      const res = await fetch(`${relay.restApiUrl}/api/command/workflows?id=w1`, { headers: { Authorization: `Bearer ${relay.tokenFor('emp-1')}` } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('secret');
      expect(res.body.success).toBe(false);
    } finally {
      relay.db.getWorkflowById.mockImplementation(() => undefined);
    }
  });

  test('theRouteTableIsReadFromTheSourceAndIsLargeEnough', () => {
    // Lần quét đầu tìm được 168 đường (89 đọc, 79 lệnh); dưới 60 nghĩa là bộ quét hỏng âm thầm.
    expect(ALL_ROUTES.length).toBeGreaterThanOrEqual(60);
    expect(READ_ROUTES.length).toBeGreaterThan(0);
    expect(COMMAND_ROUTES.length).toBeGreaterThan(0);
    expect(ALL_ROUTES).toEqual(expect.arrayContaining(['/api/query/conversations', '/api/command/ai/chat', '/api/library/items']));
  });

  test('aReadRouteWithAnotherAccountIsRefusedBeforeAnyHandlerRuns', async () => {
    const failures: string[] = [];
    for (const route of READ_ROUTES) {
      const before = relay.handlerCalls.length;
      const { status, body } = await call('emp-1', 'GET', `${route}?zaloId=acc-b`);
      if (status !== 403 || body.code !== 'ACCOUNT_FORBIDDEN' || relay.handlerCalls.length !== before) failures.push(`GET ${route} -> ${status} ${body.code}`);
    }
    expect(failures).toEqual([]);
  });

  test('aCommandRouteWithAnotherAccountInTheBodyIsRefusedOnEveryMethod', async () => {
    const failures: string[] = [];
    for (const route of COMMAND_ROUTES) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const before = relay.handlerCalls.length;
        const { status, body } = await call('emp-1', method, route, { zaloId: 'acc-b' });
        if (status !== 403 || relay.handlerCalls.length !== before) failures.push(`${method} ${route} -> ${status} ${body.code}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('aCommandRouteWithAnotherAccountInTheQueryStringIsRefused', async () => {
    const { status, body } = await call('emp-1', 'POST', '/api/command/conversations/x1/alias?zaloId=acc-b', { alias: 'n' });
    expect(status).toBe(403);
    expect(body.code).toBe('ACCOUNT_FORBIDDEN');
  });

  test('theSameRoutesWithTheAssignedAccountAreNotRefused', async () => {
    const failures: string[] = [];
    for (const route of READ_ROUTES.filter((r) => !refusedByDesign(r))) {
      const { status } = await call('emp-1', 'GET', `${route}?zaloId=acc-a`);
      if (status === 403) failures.push(`GET ${route}`);
    }
    for (const route of COMMAND_ROUTES.filter((r) => !refusedByDesign(r))) {
      const { status } = await call('emp-1', 'POST', route, { zaloId: 'acc-a' });
      if (status === 403) failures.push(`POST ${route}`);
    }
    expect(failures).toEqual([]);
  });

  test('anEmployeeWithOnlyAPersonalFacebookAccountHasNoUsableAccount', async () => {
    const denied = await call('emp-2', 'GET', '/api/query/conversations?zaloId=fb-personal');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('ACCOUNT_FORBIDDEN');

    const before = relay.handlerCalls.length;
    const open = await call('emp-2', 'GET', '/api/query/conversations');
    expect(open.status).toBe(200);
    expect(relay.handlerCalls.length).toBe(before + 1);
    expect(relay.lastEmployeeArg().assigned_accounts).toEqual([]);
  });

  test('aModuleTheEmployeeLacksIsRefused', async () => {
    const analytics = await call('emp-3', 'GET', '/api/query/analytics/dashboard?zaloId=acc-a');
    expect(analytics.status).toBe(403);
    expect(analytics.body.code).toBe('MODULE_FORBIDDEN');
    const ai = await call('emp-3', 'POST', '/api/command/ai/chat', { messages: [] });
    expect(ai.status).toBe(403);
    expect(ai.body.code).toBe('MODULE_FORBIDDEN');
    const allowed = await call('emp-1', 'GET', '/api/query/analytics/dashboard?zaloId=acc-a');
    expect(allowed.status).toBe(200);
  });

  describe('settings', () => {
    test('theSettingsTableIsNotListedToEmployees', async () => {
      relay.db.query.mockReturnValueOnce([{ key: 'employee_jwt_secret', value: 'SECRET' }]);
      const res = await call('emp-1', 'GET', '/api/query/settings');
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
    });

    test('aSecretKeyCannotBeReadOrWritten', async () => {
      const read = await call('emp-1', 'GET', '/api/query/settings/employee_jwt_secret');
      expect(read.status).toBe(403);
      relay.db.setSetting.mockClear();
      const write = await call('emp-1', 'PUT', '/api/command/settings/employee_jwt_secret', { value: 'x' });
      expect(write.status).toBe(403);
      expect(relay.db.setSetting).not.toHaveBeenCalled();
    });

    test('notificationSettingsFollowTheAccountCheck', async () => {
      expect((await call('emp-1', 'GET', '/api/query/settings/notif?zaloId=acc-a')).status).toBe(200);
      const other = await call('emp-1', 'GET', '/api/query/settings/notif?zaloId=acc-b');
      expect(other.status).toBe(403);
      expect(other.body.code).toBe('ACCOUNT_FORBIDDEN');
    });
  });

  test('integrationRowsNeverCarryEncryptedCredentials', async () => {
    relay.db.query.mockReturnValueOnce([{ id: 'i1', type: 'x', name: 'N', enabled: 1, credentials_encrypted: 'ENC', settings: '{}' }]);
    const res = await call('emp-1', 'GET', '/api/query/integrations');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain('credentials_encrypted');
    expect(JSON.stringify(res.body)).not.toContain('ENC');
  });

  test('theSnapshotOnlyNamesOtherEmployeesAndOnlyListsUsableAccounts', async () => {
    const { status, body } = await call('emp-1', 'GET', '/api/sync/snapshot');
    expect(status).toBe(200);
    const { employeesData, accountsData } = body.snapshot;
    expect(employeesData.map((e: any) => e.employee_id).sort()).toEqual(['emp-1', 'emp-2', 'emp-3']);
    for (const other of employeesData.filter((e: any) => e.employee_id !== 'emp-1')) {
      expect(Object.keys(other).sort()).toEqual(['avatar_url', 'display_name', 'employee_id']);
    }
    const mine = employeesData.find((e: any) => e.employee_id === 'emp-1');
    expect(mine.permissions.length).toBe(ALL_MODULES.length);
    expect(accountsData.map((a: any) => a.zalo_id)).toEqual(['acc-a']);
    expect(accountsData[0]).toMatchObject({ channel: 'zalo', parent_zalo_id: null });
    expect(body.snapshot.assignedAccounts).toEqual(['acc-a']);
    const text = JSON.stringify(body);
    for (const leak of ['cookies', 'imei', 'user_agent', 'SECRET', 'password_hash', 'user-emp-2']) expect(text).not.toContain(leak);
  });

  describe('account ids carried in bodies the top-level check cannot see', () => {
    const upload = (employeeId: string, fields: Record<string, string>) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      form.append('file', new Blob(['x']), 'a.txt');
      return fetch(`${relay.url}/api/library/upload`, { method: 'POST', headers: { Authorization: `Bearer ${relay.tokenFor(employeeId)}` }, body: form })
        .then(async (res) => ({ status: res.status, body: await res.json() as any }));
    };

    test('aMultipartUploadForAnotherAccountIsRefusedBeforeAnythingIsSaved', async () => {
      relay.libraryUpload.mockClear();
      const denied = await upload('emp-1', { zaloId: 'acc-b' });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('ACCOUNT_FORBIDDEN');
      expect(relay.libraryUpload).not.toHaveBeenCalled();
      expect((await upload('emp-1', { zaloId: 'acc-a' })).status).toBe(200);
      expect((await upload('emp-1', {})).status).toBe(200);
      expect(relay.libraryUpload.mock.calls.map((c: any[]) => c[0].zaloId)).toEqual(['acc-a', 'acc-a']);
    });

    test('aJsonUploadForAnotherAccountIsRefusedBeforeAnythingIsSaved', async () => {
      relay.libraryUpload.mockClear();
      const denied = await call('emp-1', 'POST', '/api/library/upload/json', { zaloId: 'acc-b', base64: 'eA==', fileName: 'a.txt' });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('ACCOUNT_FORBIDDEN');
      expect(relay.libraryUpload).not.toHaveBeenCalled();
      expect((await call('emp-1', 'POST', '/api/library/upload/json', { zaloId: 'acc-a', base64: 'eA==' })).status).toBe(200);
      expect((await call('emp-1', 'POST', '/api/library/upload/json', { base64: 'eA==' })).status).toBe(200);
      expect(relay.libraryUpload.mock.calls.map((c: any[]) => c[0].zaloId)).toEqual(['acc-a', 'acc-a']);
    });

    test('anUploadIntoAFolderOfAnotherAccountOrAMissingOneIsRefusedAndNothingIsStored', async () => {
      const owners: Record<number, string> = { 1: 'acc-a', 2: 'acc-b' };
      relay.db.queryOneStrict.mockImplementation((sql: string, params: any[]) => /FROM media_library_folders WHERE id = \?/.test(sql) && owners[params[0]] ? { owner: owners[params[0]] } : undefined);
      try {
        relay.libraryUpload.mockClear();
        for (const folderId of [2, 99, 'abc']) {
          const json = await call('emp-1', 'POST', '/api/library/upload/json', { zaloId: 'acc-a', base64: 'eA==', folderId });
          expect(json.status).toBe(403);
          expect(json.body.code).toBe('ACCOUNT_FORBIDDEN');
          const multi = await (async () => {
            const form = new FormData();
            form.append('zaloId', 'acc-a'); form.append('folderId', String(folderId)); form.append('file', new Blob(['x']), 'a.txt');
            const res = await fetch(`${relay.url}/api/library/upload`, { method: 'POST', headers: { Authorization: `Bearer ${relay.tokenFor('emp-1')}` }, body: form });
            return { status: res.status, body: await res.json() as any };
          })();
          expect(multi.status).toBe(403);
        }
        expect(relay.libraryUpload).not.toHaveBeenCalled();
        expect((await call('emp-1', 'POST', '/api/library/upload/json', { zaloId: 'acc-a', base64: 'eA==', folderId: 1 })).status).toBe(200);
        expect(relay.libraryUpload.mock.calls.map((c: any[]) => c[0].folderId)).toEqual([1]);
      } finally {
        relay.db.queryOneStrict.mockImplementation(() => undefined);
      }
    });

    test('aFolderBodyNamingAnotherAccountIsRefusedBeforeTheHandlerRuns', async () => {
      const before = relay.handlerCalls.length;
      const folder = await call('emp-1', 'POST', '/api/library/folders', { zaloId: 'acc-b', name: 'f' });
      expect(folder.status).toBe(403);
      expect(relay.handlerCalls.length).toBe(before);
      expect((await call('emp-1', 'POST', '/api/library/folders', { zaloId: 'acc-a', name: 'f' })).status).toBe(200);
    });

    test('aLabelTargetingAnotherAccountIsRefusedWhateverTheShapeOfPageIds', async () => {
      relay.db.upsertLocalLabel.mockClear();
      for (const pageIds of ['acc-b', 'acc-a,acc-b', ['acc-a', 'acc-b'], ['acc-b']]) {
        const res = await call('emp-1', 'POST', '/api/command/labels', { label: { name: 'n', pageIds } });
        expect([pageIds, res.status, res.body.code]).toEqual([pageIds, 403, 'ACCOUNT_FORBIDDEN']);
      }
      expect(relay.db.upsertLocalLabel).not.toHaveBeenCalled();
      expect((await call('emp-1', 'POST', '/api/command/labels', { label: { name: 'n', pageIds: 'acc-a' } })).status).toBe(200);
      expect(relay.db.upsertLocalLabel).toHaveBeenCalledTimes(1);
    });
  });

  describe('quick messages of every account', () => {
    const rows = [{ id: 1, owner_zalo_id: 'acc-a' }, { id: 2, owner_zalo_id: 'acc-b' }, { id: 3, owner_zalo_id: '' }];
    test('anEmployeeSeesOnlyTheRowsOfTheirOwnAccounts', async () => {
      relay.db.getAllLocalQuickMessages.mockReturnValue(rows);
      const res = await call('emp-1', 'GET', '/api/query/quick-messages/all');
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((r: any) => r.id)).toEqual([1]);
    });
    test('anEmployeeWithNoUsableAccountSeesNone', async () => {
      relay.db.getAllLocalQuickMessages.mockReturnValue(rows);
      const res = await call('emp-2', 'GET', '/api/query/quick-messages/all');
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
    });
  });

  describe('saving an AI assistant over REST', () => {
    const save = (extra: object) => call('emp-1', 'POST', '/api/command/ai/assistants', { assistant: { id: 'as-1', name: 'n', platform: 'openai', model: 'm', ...extra } });
    beforeEach(() => { relay.savedAssistants.length = 0; relay.setAssistant('as-1', { platform: 'openai', baseUrl: 'https://api.example.com/v1' }); });
    test('aNewBaseUrlWithTheMaskedKeyIs403AndNothingIsSaved', async () => {
      const res = await save({ apiKey: '***', baseUrl: 'https://evil.test' });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, error: 'Đổi địa chỉ máy chủ AI thì phải nhập lại khoá API', code: 'KEY_REQUIRED' });
      expect(relay.savedAssistants).toEqual([]);
    });
    test('theSameHostOrANewRealKeyIsSaved', async () => {
      expect((await save({ apiKey: '***', baseUrl: 'https://api.example.com/v1' })).status).toBe(200);
      expect((await save({ apiKey: 'sk-new', baseUrl: 'https://other.test' })).status).toBe(200);
      expect(relay.savedAssistants).toHaveLength(2);
    });
  });

  describe('labels without an account to read for', () => {
    test('anEmployeeWithNoUsableAccountGetsNoLabelsInsteadOfEveryLabel', async () => {
      relay.db.getLocalLabels.mockClear();
      relay.db.getLocalLabels.mockReturnValue([{ id: 1, page_ids: 'acc-b' }]);
      const res = await call('emp-2', 'GET', '/api/query/labels');
      expect(res.body.data?.items ?? []).toEqual([]);
      expect(relay.db.getLocalLabels).not.toHaveBeenCalledWith(undefined);
    });
  });

  describe('notification settings write', () => {
    test('theAssignedAccountStoresWhatTheGetRouteReadsBack', async () => {
      relay.db.setSetting.mockClear();
      const res = await call('emp-1', 'POST', '/api/command/settings/notif', { zaloId: 'acc-a', settings: { soundEnabled: false, volume: 0.3 } });
      expect(res.status).toBe(200);
      expect(relay.db.setSetting).toHaveBeenCalledWith('notifSettings_acc-a', JSON.stringify({ soundEnabled: false, volume: 0.3 }));
      relay.db.getSetting.mockReturnValueOnce(JSON.stringify({ soundEnabled: false, volume: 0.3 }));
      const read = await call('emp-1', 'GET', '/api/query/settings/notif?zaloId=acc-a');
      expect(read.body.data).toEqual({ soundEnabled: false, volume: 0.3 });
      expect(relay.db.getSetting).toHaveBeenLastCalledWith('notifSettings_acc-a');
    });

    test('anotherAccountAndOtherSettingKeysStayRefused', async () => {
      relay.db.setSetting.mockClear();
      const other = await call('emp-1', 'POST', '/api/command/settings/notif', { zaloId: 'acc-b', settings: {} });
      expect(other.status).toBe(403);
      const secret = await call('emp-1', 'PUT', '/api/command/settings/employee_jwt_secret', { value: 'x' });
      expect(secret.status).toBe(403);
      expect(relay.db.setSetting).not.toHaveBeenCalled();
    });
  });
});
