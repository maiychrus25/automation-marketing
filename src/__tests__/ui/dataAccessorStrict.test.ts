const mockGet = jest.fn();
jest.mock('@/lib/ipc', () => ({ __esModule: true, default: {} }));
jest.mock('../../services/http/RestQueryService', () => ({ __esModule: true, default: { getInstance: () => ({ get: mockGet }) } }));

import DataAccessor from '../../ui/lib/data/DataAccessor';
import { useEmployeeStore } from '../../ui/store/employeeStore';

beforeEach(() => { mockGet.mockReset(); useEmployeeStore.getState().setMode('employee'); });

describe('DataAccessor strict option (employee mode)', () => {
  it('default keeps the empty success shape when REST fails', async () => {
    mockGet.mockResolvedValue({ success: false, error: 'timeout' });
    expect(await DataAccessor.getConversations('a', 200, 0)).toEqual({ success: true, items: [], total: 0, hasMore: false });
    expect((await DataAccessor.getMessages({ zaloId: 'a', threadId: 't' })).items).toEqual([]);
  });
  it('throwOnError surfaces the REST failure', async () => {
    mockGet.mockResolvedValue({ success: false });
    await expect(DataAccessor.getConversations('a', 200, 0, { throwOnError: true })).rejects.toThrow();
    await expect(DataAccessor.getMessages({ zaloId: 'a', threadId: 't' }, { throwOnError: true })).rejects.toThrow();
  });
  it('an empty but successful response is not a failure', async () => {
    mockGet.mockResolvedValue({ success: true, data: [] });
    expect((await DataAccessor.getConversations('a', 200, 0, { throwOnError: true })).items).toEqual([]);
    mockGet.mockResolvedValue({ success: true, data: { items: [] } });
    expect((await DataAccessor.getMessages({ zaloId: 'a', threadId: 't' }, { throwOnError: true })).items).toEqual([]);
  });
});
