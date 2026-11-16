import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const handlers = new Map<string, (...a: any[]) => Promise<any>>();
jest.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: any) => handlers.set(ch, fn) },
  app: { getPath: () => '/tmp', quit: jest.fn() }, safeStorage: { isEncryptionAvailable: () => false }, dialog: {},
}));
// uuid và otplib (qua FacebookLoginHelper) là gói ESM, Jest không nạp được; các kênh được kiểm ở đây không dùng tới chúng.
jest.mock('uuid', () => ({ v4: () => 'id' }));
jest.mock('../../services/facebook/FacebookLoginHelper', () => ({ loginWithCredentials: jest.fn() }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
const mockDb = { queryOne: jest.fn(), getFBAccount: jest.fn(), getFBAccountByFacebookId: jest.fn() };
jest.mock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => mockDb } }));
const mockService: any = {};
jest.mock('../../utils/FacebookConnectionManager', () => ({ __esModule: true, default: { get: () => mockService } }));
const mockPersistSent = jest.fn();
jest.mock('../../services/facebook/FacebookSendService', () => ({ FacebookSendService: { persistSentMessage: (...a: any[]) => mockPersistSent(...a) } }));
jest.mock('../../services/file/FileStorageService', () => ({
  __esModule: true,
  default: { saveBuffer: jest.fn(async () => '/media/saved.png'), toRelativePath: (p: string) => `rel:${p}`, downloadImage: jest.fn(async () => '/media/sticker.webp') },
}));

import { registerFacebookIpc } from '../../../electron/ipc/facebookIpc';

const ACC = 'acc-page-ipc';
const PAGE_FB = '100000000004280';
const PEER = '100000000005141';
const call = (ch: string, payload: any) => handlers.get(ch)!({}, payload);

// Cách các kênh IPC dùng đường gửi qua hộp thư Page của FacebookService (bản 26.43.0).
describe('Page sends through the Facebook IPC', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-page-ipc-'));
  const file = path.join(dir, 'a.png');
  beforeAll(() => { fs.writeFileSync(file, 'x'); registerFacebookIpc(); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => {
    mockPersistSent.mockReset();
    Object.assign(mockService, {
      isPage: jest.fn(() => true), isE2EEConnected: jest.fn(() => false), getRealFacebookId: jest.fn(() => PAGE_FB),
      sendPageReaction: jest.fn(), addReaction: jest.fn(), persistReactionToDB: jest.fn(),
      sendPageAttachment: jest.fn(), sendPageSticker: jest.fn(),
    });
  });

  describe('fb:addReaction', () => {
    test('aPageReactsThroughItsInboxAndTheReactionIsStoredUnderTheAccount', async () => {
      mockService.sendPageReaction.mockResolvedValue({ success: true });
      await expect(call('fb:addReaction', { accountId: ACC, messageId: 'mid.$a', emoji: '❤', action: 'add' })).resolves.toEqual({ success: true });
      expect(mockService.sendPageReaction).toHaveBeenCalledWith('mid.$a', '❤');
      expect(mockService.persistReactionToDB).toHaveBeenCalledWith('mid.$a', PAGE_FB, '❤');
      expect(mockService.addReaction).not.toHaveBeenCalled(); // đường GraphQL không tới được hội thoại của Page
    });

    test('removingSendsAnEmptyReaction', async () => {
      mockService.sendPageReaction.mockResolvedValue({ success: true });
      await call('fb:addReaction', { accountId: ACC, messageId: 'mid.$a', emoji: '👍', action: 'remove' });
      expect(mockService.sendPageReaction).toHaveBeenCalledWith('mid.$a', '');
    });

    // Cảm xúc chưa tới nơi thì không được ghi vào DB như thể đã thả.
    test('aPageReactionThatFailsIsReportedAndNotStored', async () => {
      mockService.sendPageReaction.mockResolvedValue({ success: false, error: 'Hộp thư Page chưa kết nối' });
      await expect(call('fb:addReaction', { accountId: ACC, messageId: 'mid.$a', emoji: '❤', action: 'add' })).resolves.toEqual({ success: false, error: 'Hộp thư Page chưa kết nối' });
      expect(mockService.persistReactionToDB).not.toHaveBeenCalled();
      expect(mockService.addReaction).not.toHaveBeenCalled();
    });

    test('aPersonalAccountKeepsItsOwnPath', async () => {
      mockService.isPage.mockReturnValue(false);
      mockService.addReaction.mockResolvedValue({ success: true });
      await expect(call('fb:addReaction', { accountId: ACC, messageId: 'mid.$a', emoji: '❤', action: 'add' })).resolves.toEqual({ success: true });
      expect(mockService.sendPageReaction).not.toHaveBeenCalled();
      expect(mockService.addReaction).toHaveBeenCalledWith('mid.$a', '❤', 'add');
      expect(mockService.persistReactionToDB).toHaveBeenCalledWith('mid.$a', PAGE_FB, '❤');
    });
  });

  describe('fb:sendAttachment', () => {
    test('aCaptionSentAsItsOwnMessageIsNotStoredOnTheFileMessage', async () => {
      mockService.sendPageAttachment.mockResolvedValue({ success: true, messageId: 'mid.$file1', timestamp: 5, captionSentSeparately: true });
      const res = await call('fb:sendAttachment', { accountId: ACC, threadId: PEER, filePath: file, body: 'chu thich' });
      expect(res).toMatchObject({ success: true, messageId: 'mid.$file1', fileName: 'a.png' });
      expect(mockService.sendPageAttachment).toHaveBeenCalledWith(PEER, file, 'chu thich');
      expect(mockPersistSent).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'mid.$file1', body: null, type: 'image' }));
    });

    test('aCaptionTypedTogetherWithTheFileStaysOnTheFileMessage', async () => {
      mockService.sendPageAttachment.mockResolvedValue({ success: true, messageId: 'page:1', timestamp: 5 });
      await call('fb:sendAttachment', { accountId: ACC, threadId: PEER, filePath: file, body: 'chu thich' });
      expect(mockPersistSent).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'page:1', body: 'chu thich' }));
    });

    test('severalFilesKeepTheCaptionRuleOnTheFirstOne', async () => {
      mockService.sendPageAttachment
        .mockResolvedValueOnce({ success: true, messageId: 'mid.$f1', captionSentSeparately: true })
        .mockResolvedValueOnce({ success: true, messageId: 'mid.$f2' });
      await expect(call('fb:sendAttachments', { accountId: ACC, threadId: PEER, filePaths: [file, file], body: 'chu' })).resolves.toMatchObject({ success: true, uploadedCount: 2 });
      expect(mockService.sendPageAttachment.mock.calls.map((c: any[]) => c[2])).toEqual(['chu', undefined]);
      expect(mockPersistSent.mock.calls.map(c => c[0].body)).toEqual([null, null]);
    });
  });

  test('fb:sendPageSticker_passesTheStickerIdToTheService', async () => {
    mockService.sendPageSticker.mockResolvedValue({ success: true, messageId: 'mid.$s1', timestamp: 5 });
    await expect(call('fb:sendPageSticker', { accountId: ACC, threadId: PEER, keyword: 'vui', index: 3, thumbUrl: 'https://x.test/s.png', stickerId: '369239263222822' }))
      .resolves.toEqual({ success: true, messageId: 'mid.$s1' });
    expect(mockService.sendPageSticker).toHaveBeenCalledWith(PEER, 'vui', 3, '369239263222822');
    expect(mockPersistSent).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'mid.$s1', type: 'image' }));
  });
});
