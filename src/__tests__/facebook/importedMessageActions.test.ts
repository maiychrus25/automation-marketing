import { isLightSpeedMessageId } from '../../services/facebook/facebookHistory';
import { IMPORTED_ACTION_ERROR, importedSenderId, importedSenderName, isImportedMessageId, touchesImportedMessage } from '../../services/facebook/e2eeExport/importedMessage';

const handlers = new Map<string, (...a: any[]) => Promise<any>>();
jest.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: any) => handlers.set(ch, fn) },
  app: { getPath: () => '/tmp', quit: jest.fn() }, safeStorage: { isEncryptionAvailable: () => false }, dialog: {},
}));
jest.mock('uuid', () => ({ v4: () => 'id' }));
jest.mock('../../services/facebook/FacebookLoginHelper', () => ({ loginWithCredentials: jest.fn() }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
const mockDb = { queryOne: jest.fn(), getFBAccount: jest.fn(), getFBAccountByFacebookId: jest.fn(), updateFBMessageUnsent: jest.fn() };
jest.mock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => mockDb } }));
// Any call on the connected service (bridge, GraphQL, Page inbox) is a request to Facebook.
const network = jest.fn();
const mockService: any = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : (...a: any[]) => { network(String(prop), ...a); return Promise.resolve({ success: true }); }) });
jest.mock('../../utils/FacebookConnectionManager', () => ({ __esModule: true, default: { get: () => mockService } }));
const sendText = jest.fn();
jest.mock('../../services/facebook/FacebookSendService', () => ({ FacebookSendService: { sendTextMessage: (...a: any[]) => sendText(...a), persistSentMessage: jest.fn() } }));
import { registerFacebookIpc } from '../../../electron/ipc/facebookIpc';

const call = (ch: string, payload: any) => handlers.get(ch)!({}, payload);
const IMPORTED = 'e2ee-export.0123456789abcdef0123456789abcdef';
const refused = { success: false, error: IMPORTED_ACTION_ERROR };

describe('actions that take a message id refuse imported rows before any network or bridge call', () => {
  beforeAll(() => registerFacebookIpc());
  beforeEach(() => { network.mockClear(); sendText.mockClear(); });

  const cases: Array<[string, any]> = [
    ['fb:unsendMessage', { accountId: 'a', messageId: IMPORTED }],
    ['fb:addReaction', { accountId: 'a', messageId: IMPORTED, emoji: '❤', action: 'add' }],
    ['fb:editMessage', { accountId: 'a', messageId: IMPORTED, text: 'x' }],
    ['fb:forwardMessage', { accountId: 'a', messageId: IMPORTED, targetThreadId: '1' }],
    ['fb:pinMessage', { accountId: 'a', messageId: IMPORTED, threadId: '1' }],
    ['fb:unpinMessage', { accountId: 'a', messageId: IMPORTED, threadId: '1' }],
    ['fb:sendMessage', { accountId: 'a', threadId: '1', body: 'hi', options: { replyToMessageId: IMPORTED } }],
    ['fb:sendAttachment', { accountId: 'a', threadId: '1', filePath: '/x.png', replyToMessageId: IMPORTED }],
    ['fb:sendAttachments', { accountId: 'a', threadId: '1', filePaths: ['/x.png'], replyToMessageId: IMPORTED }],
    ['fb:sendE2EEMessage', { accountId: 'a', chatJid: '1@msgr', text: 'hi', replyToId: IMPORTED }],
  ];
  test.each(cases)('%s', async (channel, params) => {
    await expect(call(channel, params)).resolves.toEqual(refused);
    expect(network).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(mockDb.updateFBMessageUnsent).not.toHaveBeenCalled();
    expect(mockDb.queryOne).not.toHaveBeenCalled();
  });

  test('a normal message id still goes through', async () => {
    await expect(call('fb:pinMessage', { accountId: 'a', messageId: 'mid.$abc', threadId: '1' })).resolves.not.toEqual(refused);
  });
});

describe('importedMessage helpers', () => {
  test('ids and sender ids', () => {
    expect(isImportedMessageId(IMPORTED)).toBe(true);
    expect(isImportedMessageId('mid.$x')).toBe(false);
    expect(isImportedMessageId(undefined)).toBe(false);
    expect(isLightSpeedMessageId(IMPORTED)).toBe(false); // never used as a history anchor (fb:fetchOlderMessages)
    expect(importedSenderName(importedSenderId('  Cara   Example '))).toBe('Cara Example');
    expect(importedSenderId('x'.repeat(200))).toHaveLength('e2ee-name:'.length + 80);
    expect(importedSenderName('12345')).toBe('');
    expect(importedSenderName(undefined)).toBe('');
  });
  test('channels without message ids are untouched', () => {
    expect(touchesImportedMessage('fb:markAsRead', { threadId: IMPORTED })).toBe(false);
    expect(touchesImportedMessage('fb:sendMessage', { body: 'x' })).toBe(false);
  });
});
