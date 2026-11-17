const handlers = new Map<string, (...a: any[]) => Promise<any>>();
jest.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: any) => handlers.set(ch, fn), on: jest.fn() },
  app: { getPath: () => '/tmp', quit: jest.fn() }, dialog: {}, safeStorage: { isEncryptionAvailable: () => false },
}));
jest.mock('uuid', () => ({ v4: () => 'id' }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock('../../services/workflow/WorkflowEngineService', () => ({ __esModule: true, default: { getInstance: () => ({}) } }));
jest.mock('../../services/cache/MediaCacheService', () => ({ __esModule: true, default: {} }));
jest.mock('../../services/file/FileStorageService', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/WorkspaceManager', () => ({ __esModule: true, default: { getInstance: () => ({}) } }));
jest.mock('../../../electron/ipc/proxyHelper', () => ({ proxyToBoss: jest.fn() }));
const mockEmit = jest.fn();
jest.mock('../../services/event/EventBroadcaster', () => ({ __esModule: true, default: { emit: (...a: any[]) => mockEmit(...a) } }));
// Nhãn lưu page_ids dạng chuỗi phân cách bằng dấu phẩy; nhãn 1 áp dụng cho acc-a và acc-b, nhãn 2 chỉ acc-c.
const mockDb = {
  getLocalLabels: jest.fn(() => [{ id: 1, page_ids: 'acc-a,acc-b' }, { id: 2, page_ids: 'acc-c' }, { id: 3, page_ids: '' }]),
  getAllLocalQuickMessages: jest.fn(() => [{ id: 10, owner_zalo_id: 'acc-a' }, { id: 11, owner_zalo_id: 'acc-c' }]),
  upsertLocalLabel: jest.fn(() => 7), deleteLocalLabel: jest.fn(), setLocalLabelActive: jest.fn(), setLocalLabelOrder: jest.fn(),
  cloneLocalLabels: jest.fn(() => 2), setLocalQMActive: jest.fn(), setLocalQMOrder: jest.fn(),
};
jest.mock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => mockDb } }));

import { registerDatabaseIpc } from '../../../electron/ipc/databaseIpc';
import { classifyRelayEvent } from '../../services/socket/relayAudience';

const call = async (ch: string, payload: any) => {
  mockEmit.mockClear();
  const res = await handlers.get(ch)!({}, payload);
  expect(res.success).toBe(true);
  expect(mockEmit).toHaveBeenCalledTimes(1);
  return mockEmit.mock.calls[0] as [string, any];
};

describe('boss label and quick-message events carry their accounts', () => {
  beforeAll(() => registerDatabaseIpc());

  it('label upsert: pageIds of the submitted label (string or array), old fields kept', async () => {
    const [channel, data] = await call('db:upsertLocalLabel', { label: { name: 'L', pageIds: 'acc-a, acc-b' } });
    expect(data).toMatchObject({ action: 'upsert', label: { name: 'L', pageIds: 'acc-a, acc-b', id: 7 }, ownerZaloIds: ['acc-a', 'acc-b'] });
    expect(classifyRelayEvent(channel, data)).toEqual({ kind: 'accounts', ids: ['acc-a', 'acc-b'] });
    const [, arr] = await call('db:upsertLocalLabel', { label: { name: 'L', pageIds: ['acc-c'] } });
    expect(arr.ownerZaloIds).toEqual(['acc-c']);
  });

  it.each([
    ['db:deleteLocalLabel', { id: 1 }, { action: 'delete', labelId: 1 }],
    ['db:setLocalLabelActive', { id: 1, isActive: 0 }, { action: 'active', labelId: 1, isActive: 0 }],
    ['db:setLocalLabelOrder', { id: 1, order: 4 }, { action: 'reorder', labelId: 1, order: 4 }],
  ])('%s: accounts read from the stored label, old fields kept', async (ch, payload, kept) => {
    const [channel, data] = await call(ch, payload);
    expect(data).toMatchObject({ ...kept, ownerZaloIds: ['acc-a', 'acc-b'] });
    expect(classifyRelayEvent(channel, data)).toEqual({ kind: 'accounts', ids: ['acc-a', 'acc-b'] });
  });

  it('label delete reads the row before the mutation', async () => {
    const order: string[] = [];
    mockDb.getLocalLabels.mockImplementationOnce((() => { order.push('read'); return [{ id: 1, page_ids: 'acc-a' }]; }) as any);
    mockDb.deleteLocalLabel.mockImplementationOnce((() => { order.push('delete'); }) as any);
    await call('db:deleteLocalLabel', { id: 1 });
    expect(order).toEqual(['read', 'delete']);
  });

  it('label clone: the target account', async () => {
    const [channel, data] = await call('db:cloneLocalLabels', { sourceZaloId: 'acc-a', targetZaloId: 'acc-d' });
    expect(data).toMatchObject({ action: 'clone', ownerZaloId: 'acc-d' });
    expect(classifyRelayEvent(channel, data)).toEqual({ kind: 'accounts', ids: ['acc-d'] });
  });

  it.each([
    ['db:setLocalQMActive', { id: 10, isActive: 1 }, { action: 'active', id: 10, isActive: 1 }],
    ['db:setLocalQMOrder', { id: 10, order: 2 }, { action: 'reorder', id: 10, order: 2 }],
  ])('%s: the owner of the stored quick message, old fields kept', async (ch, payload, kept) => {
    const [channel, data] = await call(ch, payload);
    expect(data).toMatchObject({ ...kept, ownerZaloId: 'acc-a' });
    expect(classifyRelayEvent(channel, data)).toEqual({ kind: 'accounts', ids: ['acc-a'] });
  });

  it('a global label (no page ids) is flagged allAccounts and reaches everyone; labels with page ids are not flagged', async () => {
    for (const [ch, payload] of [['db:setLocalLabelActive', { id: 3, isActive: 1 }], ['db:setLocalLabelOrder', { id: 3, order: 1 }], ['db:deleteLocalLabel', { id: 3 }]] as const) {
      const [channel, data] = await call(ch, payload);
      expect(data.allAccounts).toBe(true);
      expect(classifyRelayEvent(channel, data)).toEqual({ kind: 'everyone' });
    }
    const [channel, data] = await call('db:upsertLocalLabel', { label: { name: 'G', pageIds: '' } });
    expect(data.allAccounts).toBe(true);
    expect(classifyRelayEvent(channel, data)).toEqual({ kind: 'everyone' });
    const [, scoped] = await call('db:setLocalLabelActive', { id: 1, isActive: 1 });
    expect(scoped.allAccounts).toBeUndefined();
  });

  it('a label or quick message that does not exist reaches nobody', async () => {
    const [c1, d1] = await call('db:setLocalLabelActive', { id: 999, isActive: 1 });
    expect(d1.allAccounts).toBeUndefined();
    expect(classifyRelayEvent(c1, d1)).toEqual({ kind: 'nobody' });
    const [c2, d2] = await call('db:setLocalQMActive', { id: 999, isActive: 1 });
    expect(classifyRelayEvent(c2, d2)).toEqual({ kind: 'nobody' });
  });
});
