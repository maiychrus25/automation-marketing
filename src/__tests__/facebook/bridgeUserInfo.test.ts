import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-fb-userinfo-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock('../../services/facebook/FacebookSession', () => ({
  ...jest.requireActual('../../services/facebook/FacebookSession'),
  getUserInfoFacebookHtml: jest.fn(),
}));

import DatabaseService from '../../services/database/DatabaseService';
import FacebookService from '../../services/facebook/FacebookService';
import { FacebookE2EEBridge } from '../../services/facebook/FacebookE2EEBridge';
import { getUserInfoFacebookHtml } from '../../services/facebook/FacebookSession';

const ACC = 'acc-userinfo';
const OWNER = 'fb-owner-userinfo';
const PEER = '100000000000000031';
const fromHtml = getUserInfoFacebookHtml as jest.Mock;

describe('Facebook user info prefers the bridge over the profile page', () => {
  const db = DatabaseService.getInstance();
  const make = (bridgeResult: any, alive = true) => {
    const svc: any = new (FacebookService as any)(ACC, 'c_user=1');
    svc.dataFB = { FacebookID: OWNER, cookieFacebook: 'c_user=1' };
    const getUserInfo = typeof bridgeResult === 'function' ? jest.fn(bridgeResult) : jest.fn().mockResolvedValue(bridgeResult);
    svc.e2eeBridge = { isAlive: () => alive, getUserInfo };
    return { svc, getUserInfo };
  };
  const contact = (id: string) => db.queryOne<any>(
    `SELECT display_name, avatar_url FROM contacts WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook'`, [OWNER, id]);

  beforeAll(async () => {
    await db.initialize();
    db.saveFBAccount({ id: ACC, facebook_id: OWNER, name: 'Owner', avatar_url: '', cookie_encrypted: '', session_data: '', status: 'connected' });
  });
  beforeEach(() => fromHtml.mockReset());
  afterAll(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('bridgeNameAndAvatarAreUsedWithoutReadingTheProfilePage', async () => {
    const { svc, getUserInfo } = make({ name: ' Peer Name ', profilePictureUrl: 'https://cdn.example/a.jpg' });
    await expect(svc.getUserInfoFacebookHtml(PEER)).resolves.toEqual({ name: 'Peer Name', avatarUrl: 'https://cdn.example/a.jpg' });
    expect(getUserInfo).toHaveBeenCalledWith(PEER);
    expect(fromHtml).not.toHaveBeenCalled();
  });

  test('bridgeNameWithoutAvatarTakesTheAvatarFromTheProfilePage', async () => {
    fromHtml.mockResolvedValue({ name: '', avatarUrl: 'https://cdn.example/html.jpg' });
    const { svc } = make({ name: 'Peer Name' });
    await expect(svc.getUserInfoFacebookHtml(PEER)).resolves.toEqual({ name: 'Peer Name', avatarUrl: 'https://cdn.example/html.jpg' });
  });

  test.each([
    ['bridgeHasNoName', { name: '  ' }, true, null, PEER],
    ['bridgeFails', () => Promise.reject(new Error('user not found')), true, null, PEER],
    ['bridgeNotAlive', { name: 'Peer Name' }, false, null, PEER],
    ['pageAccount', { name: 'Peer Name' }, true, 'page-1', PEER],
    ['nonNumericId', { name: 'Peer Name' }, true, null, 'abc'],
  ] as const)('fallsBackToTheProfilePage_%s', async (_n, bridgeResult, alive, page, id) => {
    fromHtml.mockResolvedValue({ name: 'Html Name', avatarUrl: 'https://cdn.example/html.jpg' });
    const { svc } = make(bridgeResult, alive);
    svc._delegatePageId = page;
    await expect(svc.getUserInfoFacebookHtml(id)).resolves.toEqual({ name: 'Html Name', avatarUrl: 'https://cdn.example/html.jpg' });
    expect(fromHtml).toHaveBeenCalledWith('c_user=1', id);
  });

  // Lỗi thật 16/11/2026: trang cá nhân chỉ cho ảnh, tên rỗng, nên liên hệ mới không bao giờ có tên.
  test('incomingMessageFromANewSenderGetsItsNameFromTheBridge', async () => {
    fromHtml.mockResolvedValue({ name: '', avatarUrl: 'https://cdn.example/html.jpg' });
    const { svc } = make({ name: 'Peer Name' });
    await svc.checkAndFetchUserInfo(PEER);
    expect(contact(PEER)).toEqual({ display_name: 'Peer Name', avatar_url: 'https://cdn.example/html.jpg' });
  });
});

describe('FacebookE2EEBridge.getUserInfo', () => {
  test('sendsTheUserIdAsAStringWith15sTimeout', async () => {
    const bridge = FacebookE2EEBridge.create('/fake/bridge');
    const call = jest.spyOn(bridge, 'call').mockResolvedValue({ name: 'Peer Name' } as any);
    await expect(bridge.getUserInfo('100000000000000031')).resolves.toEqual({ name: 'Peer Name' });
    expect(call).toHaveBeenCalledWith('getUserInfo', { userId: '100000000000000031' }, 15_000);
  });
});
