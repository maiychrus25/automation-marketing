import {
  ACCOUNT_PARAM_KEYS,
  allowedAccounts,
  checkEmployeeAccess,
  hasMalformedAccountParam,
  isEmployeeSettingReadable,
  isEmployeeSettingWritable,
  isEmployeeUsableAccount,
  paramsWithExtraAccountIds,
  requestedAccountIds,
  requiredModuleFor,
} from '../../services/http/employeeAccess';

describe('isEmployeeUsableAccount', () => {
  test('personal Facebook is not usable', () => {
    expect(isEmployeeUsableAccount({ zalo_id: 'x', channel: 'facebook' })).toBe(false);
    expect(isEmployeeUsableAccount({ zalo_id: 'x', channel: 'facebook', parent_zalo_id: '' })).toBe(false);
  });
  test('Facebook Page and other channels are usable', () => {
    expect(isEmployeeUsableAccount({ zalo_id: 'x', channel: 'facebook', parent_zalo_id: 'p' })).toBe(true);
    expect(isEmployeeUsableAccount({ zalo_id: 'x', channel: 'zalo' })).toBe(true);
    expect(isEmployeeUsableAccount({ zalo_id: 'x', channel: 'telegram_user' })).toBe(true);
    expect(isEmployeeUsableAccount({ zalo_id: 'x' })).toBe(true);
  });
});

describe('allowedAccounts', () => {
  test('keeps assigned order, drops unknown and personal Facebook', () => {
    const rows = [
      { zalo_id: 'a', channel: 'zalo' },
      { zalo_id: 'b', channel: 'zalo' },
      { zalo_id: 'fbp', channel: 'facebook' },
    ];
    expect(allowedAccounts(['b', 'x', 'a', 'fbp'], rows)).toEqual(['b', 'a']);
  });
});

describe('requestedAccountIds', () => {
  test('collects every shape', () => {
    expect(requestedAccountIds({ zaloId: 'a' })).toEqual(['a']);
    expect(requestedAccountIds({ zaloIds: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(requestedAccountIds({ zalo_ids: 'a,b' })).toEqual(['a', 'b']);
    expect(requestedAccountIds({ auth: { zaloId: 'a' } })).toEqual(['a']);
    expect(requestedAccountIds({ auth: { accountId: 'a' } })).toEqual(['a']);
    expect(requestedAccountIds({ auth: { zaloIds: ['a', 'b'] } })).toEqual(['a', 'b']);
    expect(hasMalformedAccountParam({ auth: { accountId: { x: 1 } } })).toBe(true);
    expect(requestedAccountIds({ ownerZaloId: 'a', accountId: 'b' })).toEqual(['a', 'b']);
  });
  test('dedupes', () => {
    expect(requestedAccountIds({ zaloId: 'a', zalo_id: 'a', zaloIds: ['a', 'b'] })).toEqual(['a', 'b']);
  });
  test('empty inputs give none', () => {
    expect(requestedAccountIds(null)).toEqual([]);
    expect(requestedAccountIds(undefined)).toEqual([]);
    expect(requestedAccountIds('a')).toEqual([]);
    expect(requestedAccountIds({ zaloId: '' })).toEqual([]);
    expect(requestedAccountIds({ zaloIds: ['', ' '] })).toEqual([]);
  });
  test('covers every documented key', () => {
    for (const key of ACCOUNT_PARAM_KEYS) {
      expect(requestedAccountIds({ [key]: 'acc-a' })).toEqual(['acc-a']);
    }
  });
});

describe('requiredModuleFor', () => {
  test.each([
    ['/api/query/analytics/overview', 'analytics'],
    ['/api/query/crm/contacts', 'crm'],
    ['/api/command/crm/saveNote', 'crm'],
    ['/api/query/erp/tasks', 'erp'],
    ['/api/command/erp/tasks', 'erp'],
    ['/api/query/ai/assistants', 'ai_assistant'],
    ['/api/command/ai/save', 'ai_assistant'],
    ['/api/query/workflows', 'workflow'],
    ['/api/command/workflows/run', 'workflow'],
    ['/api/query/integrations', 'integration'],
    ['/api/command/integrations/save', 'integration'],
    ['/api/query/friends', 'friends'],
    ['/api/query/friend-requests', 'friends'],
    ['/api/command/friends/add', 'friends'],
    ['/api/command/friend-requests/accept', 'friends'],
    ['/api/query/messages', 'chat'],
    ['/api/query/conversations', 'chat'],
    ['/api/search/messages', 'chat'],
  ])('%s -> %s', (path, module) => {
    expect(requiredModuleFor(path)).toBe(module);
  });
  test('others have no module', () => {
    expect(requiredModuleFor('/api/query/accounts')).toBeUndefined();
    expect(requiredModuleFor('/api/library/files')).toBeUndefined();
  });
});

describe('checkEmployeeAccess', () => {
  const yes = () => true;
  const base = { allowed: ['acc-a'], pathname: '/api/query/messages', hasPermission: yes };

  test('allowed account passes', () => {
    expect(checkEmployeeAccess({ ...base, params: { zaloId: 'acc-a' } })).toBeNull();
  });
  test('foreign account in any key is forbidden', () => {
    const denied = { status: 403, code: 'ACCOUNT_FORBIDDEN', error: 'Không có quyền truy cập tài khoản này' };
    expect(checkEmployeeAccess({ ...base, params: { zaloId: 'acc-b' } })).toEqual(denied);
    expect(checkEmployeeAccess({ ...base, params: { zaloIds: ['acc-a', 'acc-b'] } })).toEqual(denied);
    expect(checkEmployeeAccess({ ...base, params: { auth: { zaloId: 'acc-b' } } })).toEqual(denied);
    expect(checkEmployeeAccess({ ...base, params: { auth: { accountId: 'acc-b' } } })).toEqual(denied);
    expect(checkEmployeeAccess({ ...base, params: { zaloId: 'acc-a', ownerZaloId: 'acc-b' } })).toEqual(denied);
  });
  test('empty allowed list denies every id', () => {
    expect(checkEmployeeAccess({ ...base, allowed: [], params: { zaloId: 'acc-a' } })?.code).toBe('ACCOUNT_FORBIDDEN');
  });
  test('no account in params is not an account denial', () => {
    expect(checkEmployeeAccess({ ...base, allowed: [], params: {} })).toBeNull();
    expect(checkEmployeeAccess({ ...base, allowed: [], params: null })).toBeNull();
  });
  test('missing module permission is forbidden', () => {
    expect(
      checkEmployeeAccess({ ...base, pathname: '/api/query/erp/tasks', params: {}, hasPermission: (m) => m !== 'erp' }),
    ).toEqual({ status: 403, code: 'MODULE_FORBIDDEN', error: 'Không có quyền truy cập module: erp' });
  });
  test('checks all four prefixes', () => {
    for (const p of ['/api/query/x', '/api/search/x', '/api/command/x', '/api/library/x']) {
      expect(checkEmployeeAccess({ allowed: [], pathname: p, params: { zaloId: 'acc-a' }, hasPermission: yes })?.code)
        .toBe('ACCOUNT_FORBIDDEN');
    }
  });
  test('other paths are not checked', () => {
    expect(checkEmployeeAccess({ allowed: [], pathname: '/api/proxy/action', params: { zaloId: 'acc-a' }, hasPermission: () => false }))
      .toBeNull();
  });
});

describe('employee settings', () => {
  test.each(['employee_jwt_secret', 'relay_ngrok_authtoken', 'sidebar_width'])('%s is closed', (key) => {
    expect(isEmployeeSettingReadable(key)).toBe(false);
    expect(isEmployeeSettingWritable(key)).toBe(false);
  });
});

describe('malformed account ids', () => {
  const yes = () => true;
  const run = (allowed: string[], params: unknown) =>
    checkEmployeeAccess({ allowed, pathname: '/api/query/messages', params, hasPermission: yes });

  test('numbers and bigints are coerced to ids', () => {
    expect(requestedAccountIds({ zaloId: 123 })).toEqual(['123']);
    expect(requestedAccountIds({ zaloIds: [1, BigInt(2)] })).toEqual(['1', '2']);
    expect(run(['123'], { zaloId: 123 })).toBeNull();
    expect(run(['a'], { zaloId: 123 })?.code).toBe('ACCOUNT_FORBIDDEN');
  });
  test.each([
    { accountId: { id: 'acc-b' } },
    { zaloIds: ['a', { x: 1 }] },
    { zaloId: true },
    { auth: { zaloId: { a: 1 } } },
  ])('malformed %j is forbidden even when allowed has a', (params) => {
    expect(hasMalformedAccountParam(params)).toBe(true);
    expect(run(['a'], params)?.code).toBe('ACCOUNT_FORBIDDEN');
  });
  test('valid or empty values are not malformed', () => {
    for (const params of [null, 'x', {}, { zaloId: '' }, { zaloId: null }, { zaloId: undefined }, { zaloIds: ['a', 2] }, { auth: { zaloId: 'a' } }, { other: { x: 1 } }]) {
      expect(hasMalformedAccountParam(params)).toBe(false);
    }
  });
});

describe('paramsWithExtraAccountIds', () => {
  const label = { label: { pageIds: 'acc-b' }, zaloIds: ['acc-a'] };
  test('aLabelWriteCarriesItsPageIdsOnTheRestPathAndTheProxyChannel', () => {
    for (const target of ['/api/command/labels', 'db:upsertLocalLabel']) {
      expect(requestedAccountIds(paramsWithExtraAccountIds(target, label)).sort()).toEqual(['acc-a', 'acc-b']);
    }
  });
  test('otherTargetsAreReturnedUnchanged', () => {
    expect(paramsWithExtraAccountIds('/api/command/quick-messages', label)).toBe(label);
    expect(paramsWithExtraAccountIds('db:setLocalLabelActive', label)).toBe(label);
  });
});

describe('isEmployeeUsableAccount and a switched-off Page', () => {
  test('aPageSwitchedOffIsNotUsableButAnEnabledOneIs', () => {
    expect(isEmployeeUsableAccount({ zalo_id: 'page-1', channel: 'facebook', parent_zalo_id: 'fb-personal', enabled: 0 })).toBe(false);
    expect(isEmployeeUsableAccount({ zalo_id: 'page-1', channel: 'facebook', parent_zalo_id: 'fb-personal', enabled: 1 })).toBe(true);
    expect(isEmployeeUsableAccount({ zalo_id: 'page-1', channel: 'facebook', parent_zalo_id: 'fb-personal' })).toBe(true);
  });
});
