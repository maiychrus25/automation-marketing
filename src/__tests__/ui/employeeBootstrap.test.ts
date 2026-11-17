// IPC và REST là bản giả; store và bộ nạp là mã thật.
jest.mock('@/lib/ipc', () => ({ __esModule: true, default: {} }));
jest.mock('@/lib/data/DataAccessor', () => ({ __esModule: true, default: { getConversations: jest.fn() } }));

import DataAccessor from '@/lib/data/DataAccessor';
import { useEmployeeStore } from '../../ui/store/employeeStore';
import { useAccountStore } from '../../ui/store/accountStore';
import { useChatStore } from '../../ui/store/chatStore';
import { startEmployeeBootstrap, cancelEmployeeBootstrap, currentEmployeeSession, onEmployeeSessionEnd, bootstrapAfterReconnect } from '../../ui/lib/employeeConversations';

const get = DataAccessor.getConversations as jest.Mock;
const acc = (...ids: string[]) => ids.map((zalo_id) => ({ zalo_id }));
const item = (id: string) => ({ items: [{ contact_id: id }] });
const flag = () => useEmployeeStore.getState().employeeInitialLoadDone;

beforeEach(() => {
  cancelEmployeeBootstrap();
  get.mockReset();
  useEmployeeStore.getState().reset();
  useEmployeeStore.getState().setMode('employee');
  useChatStore.setState({ contacts: {}, conversationsLoading: {} } as any);
});

describe('startEmployeeBootstrap', () => {
  it('turns the flag on only after every account finished, failures included', async () => {
    get.mockImplementation(async (id: string) => { if (id === 'b') throw new Error('x'); return item('c-' + id); });
    const p = startEmployeeBootstrap(acc('a', 'b', 'c'));
    expect(flag()).toBe(false);
    expect(useChatStore.getState().conversationsLoading.a).toBe(true);
    await p;
    expect(flag()).toBe(true);
    expect(useEmployeeStore.getState().bootstrapFailed).toBe(1);
    expect(useChatStore.getState().conversationsLoading.b).toBe(false);
    expect(useChatStore.getState().contacts.a).toHaveLength(1);
  });

  it('turns the flag on at once with zero accounts', async () => {
    await startEmployeeBootstrap([]);
    expect(flag()).toBe(true);
  });

  it('a second call for the same set joins the running load', async () => {
    get.mockImplementation(async (id: string) => item(id));
    const p1 = startEmployeeBootstrap(acc('a', 'b'));
    const p2 = startEmployeeBootstrap(acc('b', 'a'));
    expect(p2).toBe(p1);
    await p1;
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('a cancelled run neither writes contacts nor turns the flag on', async () => {
    let release!: () => void;
    get.mockImplementation(() => new Promise((r) => { release = () => r(item('late')); }));
    const p = startEmployeeBootstrap(acc('a'));
    useEmployeeStore.getState().reset(); // logout / workspace switch
    expect(flag()).toBe(false);
    release();
    await p;
    expect(flag()).toBe(false);
    expect(useChatStore.getState().contacts.a).toBeUndefined();
    expect(useEmployeeStore.getState().bootstrapTotal).toBe(0);
  });

  it('a start with accounts flips a true flag to false until the run ends', async () => {
    useEmployeeStore.getState().setEmployeeInitialLoadDone(true);
    let release!: () => void;
    get.mockImplementation(() => new Promise((r) => { release = () => r(item('x')); }));
    const p = startEmployeeBootstrap(acc('a'));
    expect(flag()).toBe(false);
    release();
    await p;
    expect(flag()).toBe(true);
  });

  it('a different account set supersedes the running one', async () => {
    const releases: Record<string, () => void> = {};
    get.mockImplementation((id: string) => new Promise((r) => { releases[id] = () => r(item('c-' + id)); }));
    const p1 = startEmployeeBootstrap(acc('a'));
    const p2 = startEmployeeBootstrap(acc('b'));
    expect(p2).not.toBe(p1);
    releases.a();
    await p1;
    expect(useChatStore.getState().contacts.a).toBeUndefined();
    expect(flag()).toBe(false);
    releases.b();
    await p2;
    expect(useChatStore.getState().contacts.b).toHaveLength(1);
    expect(flag()).toBe(true);
  });

  it('loads the active account first and skips accounts that already have enough conversations', async () => {
    useAccountStore.setState({ activeAccountId: 'c' } as any);
    useChatStore.setState({ contacts: { b: Array.from({ length: 200 }, (_, i) => ({ contact_id: 'x' + i })) } } as any);
    const order: string[] = [];
    get.mockImplementation(async (id: string) => { order.push(id); return item(id); });
    await startEmployeeBootstrap(acc('a', 'b', 'c'));
    expect(order[0]).toBe('c');
    expect(order).not.toContain('b');
    expect(flag()).toBe(true);
  });

  it('a REST failure (strict fetch rejects) counts as failed and the others still load', async () => {
    get.mockImplementation(async (id: string, _l: number, _o: number, opts?: any) => {
      if (id === 'b') { if (opts?.throwOnError) throw new Error('down'); return { items: [] }; }
      return item(id);
    });
    await startEmployeeBootstrap(acc('a', 'b'));
    expect(useEmployeeStore.getState().bootstrapFailed).toBe(1);
    expect(useChatStore.getState().contacts.a).toHaveLength(1);
    expect(flag()).toBe(true);
  });

  it('an account with zero conversations is a success', async () => {
    get.mockResolvedValue({ items: [] });
    await startEmployeeBootstrap(acc('a'));
    expect(useEmployeeStore.getState().bootstrapFailed).toBe(0);
  });

  it('reconnect while the same set is loading joins; after a cancel it loads again', async () => {
    let release!: () => void;
    get.mockImplementation(() => new Promise((r) => { release = () => r(item('x')); }));
    const p1 = startEmployeeBootstrap(acc('a'));
    expect(startEmployeeBootstrap(acc('a'))).toBe(p1);
    release(); await p1;
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('initialState with onlyMissing does not flip the flag or touch progress when nothing is missing', async () => {
    get.mockImplementation(async (id: string) => item(id));
    await startEmployeeBootstrap(acc('a'));
    get.mockClear();
    useEmployeeStore.getState().setBootstrapProgress(2, 2, 1);
    await startEmployeeBootstrap(acc('a'), 200, true);
    expect(get).not.toHaveBeenCalled();
    expect(flag()).toBe(true);
    expect(useEmployeeStore.getState().bootstrapFailed).toBe(1);
  });

  it('initialState with onlyMissing loads only accounts whose load has not completed', async () => {
    get.mockImplementation(async (id: string) => item(id));
    await startEmployeeBootstrap(acc('a'));
    get.mockClear();
    await startEmployeeBootstrap(acc('a', 'b'), 200, true);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe('b');
  });

  it('an account that really has no conversations is not reloaded by a second onlyMissing start', async () => {
    get.mockResolvedValue({ items: [] });
    await startEmployeeBootstrap(acc('a'));
    get.mockClear();
    await startEmployeeBootstrap(acc('a'), 200, true);
    expect(get).not.toHaveBeenCalled();
  });

  it('a failed account is reloaded by the next onlyMissing start', async () => {
    get.mockRejectedValueOnce(new Error('down')).mockResolvedValue(item('x'));
    await startEmployeeBootstrap(acc('a'));
    get.mockClear();
    await startEmployeeBootstrap(acc('a'), 200, true);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('after a session change every account is missing again', async () => {
    get.mockImplementation(async (id: string) => item(id));
    await startEmployeeBootstrap(acc('a'));
    useEmployeeStore.getState().reset(); // logout
    useEmployeeStore.getState().setMode('employee');
    get.mockClear();
    await startEmployeeBootstrap(acc('a'), 200, true);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('an onlyMissing start with nothing to load does not supersede a running load', async () => {
    get.mockImplementation(async (id: string) => item(id));
    await startEmployeeBootstrap(acc('a'));
    let release!: () => void;
    get.mockImplementation(() => new Promise((r) => { release = () => r(item('b')); }));
    const running = startEmployeeBootstrap(acc('b'));
    const again = startEmployeeBootstrap(acc('a'), 200, true);
    expect(again).toBe(running);
    expect(useChatStore.getState().conversationsLoading.b).toBe(true);
    release();
    await running;
    expect(useChatStore.getState().contacts.b).toHaveLength(1);
    expect(flag()).toBe(true);
  });

  it('an onlyMissing start for ids the running load already covers joins it', async () => {
    const releases: Array<() => void> = [];
    get.mockImplementation(() => new Promise((r) => { releases.push(() => r(item('x'))); }));
    const running = startEmployeeBootstrap(acc('a', 'b'));
    expect(startEmployeeBootstrap(acc('a'), 200, true)).toBe(running);
    releases.forEach((r) => r());
    await running;
  });

  it('onlyMissing with no accounts still turns a false flag on', async () => {
    await startEmployeeBootstrap([], 200, true);
    expect(flag()).toBe(true);
  });
});

describe('employee session', () => {
  it('the captured session stays current until the employee session ends, even with no bootstrap running', () => {
    const ok = currentEmployeeSession();
    expect(ok()).toBe(true);
    useEmployeeStore.getState().reset();
    expect(ok()).toBe(false);
    useEmployeeStore.getState().setMode('employee');
    expect(currentEmployeeSession()()).toBe(true);
  });
  it.each([
    ['token cleared', () => { useEmployeeStore.setState({ token: 't' } as any); useEmployeeStore.setState({ token: '' } as any); }],
    ['boss url changed', () => { useEmployeeStore.setState({ bossUrl: 'http://a' } as any); useEmployeeStore.setState({ bossUrl: 'http://b' } as any); }],
  ])('%s ends the session', (_n, act) => {
    const ok = currentEmployeeSession();
    act();
    expect(ok()).toBe(false);
  });
  it('a superseding bootstrap start does not end the session', async () => {
    const ok = currentEmployeeSession();
    get.mockImplementation(async (id: string) => item(id));
    await startEmployeeBootstrap(acc('a'));
    await startEmployeeBootstrap(acc('b'));
    expect(ok()).toBe(true);
  });
  it('listeners hear about the end of the session', () => {
    const cb = jest.fn();
    const off = onEmployeeSessionEnd(cb);
    useEmployeeStore.getState().reset();
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    useEmployeeStore.getState().setMode('employee');
    useEmployeeStore.getState().reset();
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it('cancel with no run active still clears the progress numbers', () => {
    useEmployeeStore.getState().setBootstrapProgress(2, 3, 1);
    cancelEmployeeBootstrap();
    expect(useEmployeeStore.getState().bootstrapTotal).toBe(0);
    expect(useEmployeeStore.getState().bootstrapFailed).toBe(0);
  });
});

describe('bootstrapAfterReconnect', () => {
  const snapshot = { accountsData: [{ zalo_id: 'n1' }] };
  beforeEach(() => {
    get.mockImplementation(async (id: string) => item(id));
    useAccountStore.setState({ accounts: [{ zalo_id: 'old' }], activeAccountId: 'old' } as any);
    useChatStore.setState({ contacts: { old: [{ contact_id: 'x' }] } } as any);
  });
  it('the same employee keeps the loaded data and loads the current accounts', async () => {
    await bootstrapAfterReconnect(snapshot, 'e1', 'e1');
    expect(useChatStore.getState().contacts.old.map((c: any) => c.contact_id)).toContain('x');
    expect(useAccountStore.getState().accounts.map((a: any) => a.zalo_id)).toEqual(['old']);
    expect(get.mock.calls.map((c) => c[0])).toEqual(['old']);
  });
  it('a different employee resets the chat data and takes the accounts of the snapshot', async () => {
    await bootstrapAfterReconnect(snapshot, 'e1', 'e2');
    expect(useChatStore.getState().contacts.old).toBeUndefined();
    expect(useAccountStore.getState().accounts.map((a: any) => a.zalo_id)).toEqual(['n1']);
    expect(useAccountStore.getState().activeAccountId).toBe('n1');
    expect(get.mock.calls.map((c) => c[0])).toEqual(['n1']);
  });
  it('a different employee with an empty snapshot leaves no account behind', async () => {
    await bootstrapAfterReconnect({ accountsData: [] }, 'e1', 'e2');
    expect(useAccountStore.getState().accounts).toEqual([]);
    expect(flag()).toBe(true);
  });
  it('no previous employee counts as the same (nothing to reset)', async () => {
    await bootstrapAfterReconnect(snapshot, undefined, 'e2');
    expect(useChatStore.getState().contacts.old.map((c: any) => c.contact_id)).toContain('x');
  });
});
