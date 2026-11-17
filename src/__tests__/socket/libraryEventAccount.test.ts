// The library update event must carry the owner account, or the relay cannot route it to the right employees.
const mockEmit = jest.fn();
const mockDb = { run: jest.fn(), queryOne: jest.fn() };
jest.mock('../../services/event/EventBroadcaster', () => ({ __esModule: true, default: { emit: (...a: unknown[]) => mockEmit(...a) } }));
jest.mock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => mockDb } }));
jest.mock('../../services/file/FileStorageService', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock('uuid', () => ({ v4: () => 'id' }));

import LibraryService from '../../services/library/LibraryService';

describe('library:itemUpdated', () => {
  beforeEach(() => { mockEmit.mockClear(); mockDb.queryOne.mockReset(); });
  it('carries the owner account of the item', () => {
    mockDb.queryOne.mockReturnValue({ uuid: 'u1', owner_zalo_id: 'acc-a' });
    expect(LibraryService.getInstance().updateItem('u1', { name: 'n' })).toBe(true);
    expect(mockEmit).toHaveBeenCalledWith('library:itemUpdated', expect.objectContaining({ uuid: 'u1', name: 'n', zaloId: 'acc-a' }));
  });
  it('stays without an account id when the item is unknown', () => {
    mockDb.queryOne.mockReturnValue(null);
    LibraryService.getInstance().updateItem('u1', { name: 'n' });
    expect(mockEmit.mock.calls[0][1]).not.toHaveProperty('zaloId');
  });
});
