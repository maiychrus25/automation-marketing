jest.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '/tmp' } }));
jest.mock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => ({}) } }));
jest.mock('../../services/file/FileStorageService', () => ({ __esModule: true, default: {} }));

import EventBroadcaster from '../../services/event/EventBroadcaster';

const undoMessage = { threadId: 't1', type: 1, data: { content: { globalMsgId: 'g1', deleteMsg: 1 } } };

describe('undo control payload on the message stream', () => {
  let fakeDb: { markMessageRecalled: jest.Mock; updateLastMessageIfRecalled: jest.Mock };
  let sendAware: jest.SpyInstance;

  beforeEach(() => {
    fakeDb = { markMessageRecalled: jest.fn(), updateLastMessageIfRecalled: jest.fn() };
    jest.spyOn(EventBroadcaster, 'runOnBossDb').mockImplementation((fn: any) => fn(fakeDb));
    sendAware = jest.spyOn(EventBroadcaster as any, 'sendAware').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  test('history (silent) only marks the message recalled, no event/hooks', async () => {
    await EventBroadcaster.broadcastMessage('z1', undoMessage, { silent: true });
    expect(fakeDb.markMessageRecalled).toHaveBeenCalledWith('z1', 'g1');
    expect(fakeDb.updateLastMessageIfRecalled).toHaveBeenCalledWith('z1', 't1', 'g1');
    expect(sendAware).not.toHaveBeenCalled();
  });

  test('realtime still broadcasts event:undo', async () => {
    await EventBroadcaster.broadcastMessage('z1', undoMessage);
    expect(fakeDb.markMessageRecalled).toHaveBeenCalledWith('z1', 'g1');
    expect(sendAware).toHaveBeenCalledWith('event:undo', { zaloId: 'z1', msgId: 'g1', threadId: 't1' });
  });
});
