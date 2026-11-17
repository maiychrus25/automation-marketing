import { classifyRelayEvent, canReceiveRelayEvent, moduleForRelayChannel, RelayAudience } from '../../services/socket/relayAudience';

describe('classifyRelayEvent', () => {
  it.each(['zaloId', 'zalo_id', 'ownerZaloId', 'owner_zalo_id', 'accountId', 'account_id', 'fbAccountId'])(
    'reads the account from %s', (key) => {
      expect(classifyRelayEvent('db:unreadChanged', { [key]: 'acc-a' })).toEqual({ kind: 'accounts', ids: ['acc-a'] });
    });
  it('reads message.zaloId', () => {
    expect(classifyRelayEvent('event:message', { message: { zaloId: 'acc-a' } })).toEqual({ kind: 'accounts', ids: ['acc-a'] });
  });
  it.each([['event:message'], ['crm:campaignChanged'], ['workflow:executed'], ['integration:payment']])(
    '%s without an account id reaches nobody', (channel) => {
      expect(classifyRelayEvent(channel, {})).toEqual({ kind: 'nobody' });
      expect(classifyRelayEvent(channel, null)).toEqual({ kind: 'nobody' });
      expect(classifyRelayEvent(channel, { zaloId: '' })).toEqual({ kind: 'nobody' });
    });
  it.each(['library:itemAdded', 'library:itemUpdated', 'library:itemDeleted'])('%s goes to the account that owns the item', (channel) => {
    expect(classifyRelayEvent(channel, { zaloId: 'acc-a', uuid: 'u1', item: { name: 'n' } })).toEqual({ kind: 'accounts', ids: ['acc-a'] });
  });
  it.each(['library:itemAdded', 'library:itemUpdated', 'library:itemDeleted'])('%s without any account id stays shared', (channel) => {
    expect(classifyRelayEvent(channel, {})).toEqual({ kind: 'everyone' });
    expect(classifyRelayEvent(channel, { uuid: 'u1', zaloId: '' })).toEqual({ kind: 'everyone' });
  });
});

describe('canReceiveRelayEvent', () => {
  it('accounts audience needs an allowed account', () => {
    const a: RelayAudience = { kind: 'accounts', ids: ['a'] };
    expect(canReceiveRelayEvent(a, 'e1', [])).toBe(false);
    expect(canReceiveRelayEvent(a, 'e1', ['b'])).toBe(false);
    expect(canReceiveRelayEvent(a, 'e1', ['a'])).toBe(true);
  });
  it('nobody, everyone, employees', () => {
    expect(canReceiveRelayEvent({ kind: 'nobody' }, 'e1', ['a'])).toBe(false);
    expect(canReceiveRelayEvent({ kind: 'everyone' }, 'e1', [])).toBe(true);
    expect(canReceiveRelayEvent({ kind: 'employees', ids: ['e1'] }, 'e1', [])).toBe(true);
    expect(canReceiveRelayEvent({ kind: 'employees', ids: ['e1'] }, 'e2', ['a'])).toBe(false);
  });
});

describe('account lists and modules', () => {
  it.each(['zaloIds', 'ownerZaloIds'])('%s accepts an array or a comma list', (key) => {
    expect(classifyRelayEvent('db:localLabelChanged', { [key]: ['acc-a', 'acc-b'] })).toEqual({ kind: 'accounts', ids: ['acc-a', 'acc-b'] });
    expect(classifyRelayEvent('db:localLabelChanged', { [key]: 'acc-a, acc-b,' })).toEqual({ kind: 'accounts', ids: ['acc-a', 'acc-b'] });
    expect(classifyRelayEvent('db:localLabelChanged', { [key]: [] })).toEqual({ kind: 'nobody' });
  });
  it('an accounts audience reaches an employee who may use at least one id', () => {
    const a: RelayAudience = { kind: 'accounts', ids: ['acc-a', 'acc-b'] };
    expect(canReceiveRelayEvent(a, 'e1', ['acc-b'])).toBe(true);
    expect(canReceiveRelayEvent(a, 'e1', ['acc-c'])).toBe(false);
  });
  it('moduleForRelayChannel maps the module channels only', () => {
    expect(moduleForRelayChannel('workflow:executed')).toBe('workflow');
    expect(moduleForRelayChannel('integration:payment')).toBe('integration');
    expect(moduleForRelayChannel('integration:webhook')).toBe('integration');
    expect(moduleForRelayChannel('event:message')).toBeUndefined();
    expect(classifyRelayEvent('workflow:executed', { workflowId: 'w' })).toEqual({ kind: 'nobody' });
  });
});

describe('allAccounts flag', () => {
  it('widens only db:localLabelChanged', () => {
    expect(classifyRelayEvent('db:localLabelChanged', { allAccounts: true })).toEqual({ kind: 'everyone' });
    expect(classifyRelayEvent('event:message', { allAccounts: true })).toEqual({ kind: 'nobody' });
    expect(classifyRelayEvent('crm:campaignChanged', { allAccounts: true })).toEqual({ kind: 'nobody' });
    expect(classifyRelayEvent('db:localLabelChanged', { allAccounts: 'true' })).toEqual({ kind: 'nobody' });
  });
});

describe('module audience and key union', () => {
  const m: RelayAudience = { kind: 'module', module: 'integration' };
  it('is decided by hasModule, closed when absent', () => {
    expect(canReceiveRelayEvent(m, 'e1', ['acc-a'], (mod) => mod === 'integration')).toBe(true);
    expect(canReceiveRelayEvent(m, 'e1', ['acc-a'], () => false)).toBe(false);
    expect(canReceiveRelayEvent(m, 'e1', ['acc-a'])).toBe(false);
  });
  it('unions ids found under several recognised keys', () => {
    expect(classifyRelayEvent('db:localLabelChanged', { ownerZaloId: 'acc-a', ownerZaloIds: ['acc-b', 'acc-c'], zaloId: 'acc-a' }))
      .toEqual({ kind: 'accounts', ids: ['acc-a', 'acc-b', 'acc-c'] });
    expect(classifyRelayEvent('event:message', { zaloId: 'acc-a', message: { zaloId: 'acc-b' } }))
      .toEqual({ kind: 'accounts', ids: ['acc-a', 'acc-b'] });
  });
});

describe('profiles audience', () => {
  const a: RelayAudience = { kind: 'profiles', ids: ['p1', 'p2'] };
  it('needs every profile to be allowed', () => {
    expect(canReceiveRelayEvent(a, 'e1', [], undefined, ['p1', 'p2', 'p3'])).toBe(true);
    expect(canReceiveRelayEvent(a, 'e1', [], undefined, ['p1'])).toBe(false);
    expect(canReceiveRelayEvent(a, 'e1', [], undefined, [])).toBe(false);
  });
  it('an empty id list, and no resolver, reach nobody', () => {
    expect(canReceiveRelayEvent({ kind: 'profiles', ids: [] }, 'e1', ['x'], () => true, ['p1'])).toBe(false);
    expect(canReceiveRelayEvent(a, 'e1', ['p1', 'p2'], () => true)).toBe(false);
  });
  it('accounts and modules do not stand in for profiles', () => {
    expect(canReceiveRelayEvent({ kind: 'profiles', ids: ['p1'] }, 'e1', ['p1'], () => true)).toBe(false);
  });
});
