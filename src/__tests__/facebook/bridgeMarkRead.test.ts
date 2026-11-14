import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-fb-markread-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import DatabaseService from '../../services/database/DatabaseService';
import FacebookService from '../../services/facebook/FacebookService';
import { FacebookE2EEBridge } from '../../services/facebook/FacebookE2EEBridge';

const ACC = 'acc-markread';
const OWNER = 'fb-owner-markread';
const THREAD = '100000000000000001';
const T = 1_700_000_000_000;

describe('FacebookService.markReadOnServer', () => {
  const db = DatabaseService.getInstance();
  const addMsg = (id: string, thread: string, ts: number) => db.run(
    `INSERT INTO messages (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, channel)
     VALUES (?, ?, ?, 0, 'peer', 'x', 'text', ?, 0, 'facebook')`, [id, OWNER, thread, ts]);
  const make = (alive: boolean | null = true) => {
    const svc: any = new (FacebookService as any)(ACC, 'c_user=1');
    const markRead = jest.fn().mockResolvedValue(undefined);
    svc.e2eeBridge = alive === null ? null : { isAlive: () => alive, markRead };
    return { svc, markRead };
  };

  beforeAll(async () => {
    await db.initialize();
    db.saveFBAccount({ id: ACC, facebook_id: OWNER, name: 'Owner', avatar_url: '', cookie_encrypted: '', session_data: '', status: 'connected' });
    addMsg('m1', THREAD, T - 5);
    addMsg('m2', THREAD, T);
    addMsg('m3', '100000000000000002', T);
  });
  afterEach(() => jest.useRealTimers());
  afterAll(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('sendsLatestMessageTimestampAsWatermark', async () => {
    const { svc, markRead } = make();
    await svc.markReadOnServer(THREAD);
    expect(markRead).toHaveBeenCalledWith({ threadId: THREAD, watermarkTs: T });
  });

  test('stripsJidSuffix', async () => {
    const { svc, markRead } = make();
    await svc.markReadOnServer(`${THREAD}@msgr`);
    expect(markRead).toHaveBeenCalledWith({ threadId: THREAD, watermarkTs: T });
  });

  test('usesNowWhenThreadHasNoMessages', async () => {
    jest.useFakeTimers().setSystemTime(1_800_000_000_000);
    const { svc, markRead } = make();
    await svc.markReadOnServer('100000000000000009');
    expect(markRead).toHaveBeenCalledWith({ threadId: '100000000000000009', watermarkTs: 1_800_000_000_000 });
  });

  test('skipsUnchangedWatermarkAndResendsOnNewer', async () => {
    const own = '100000000000000003'; // hội thoại riêng: tin thêm ở đây không đổi mốc của test khác khi thứ tự bị xáo
    addMsg('own1', own, T);
    const { svc, markRead } = make();
    await svc.markReadOnServer(own);
    await svc.markReadOnServer(own);
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenLastCalledWith({ threadId: own, watermarkTs: T });
    addMsg('own2', own, T + 1000);
    await svc.markReadOnServer(own);
    expect(markRead).toHaveBeenCalledTimes(2);
    expect(markRead).toHaveBeenLastCalledWith({ threadId: own, watermarkTs: T + 1000 });
  });

  test.each([
    ['bridgeNotAlive', false, null, THREAD],
    ['noBridge', null, null, THREAD],
    ['pageAccount', true, 'page-1', THREAD],
    ['nonNumericId', true, null, 'abc123'],
    ['emptyId', true, null, ''],
  ] as const)('doesNotCallBridge_%s', async (_n, alive, page, thread) => {
    const { svc, markRead } = make(alive as any);
    svc._delegatePageId = page;
    await svc.markReadOnServer(thread);
    expect(markRead).not.toHaveBeenCalled();
  });

  test('bridgeErrorDoesNotThrowAndIsRetried', async () => {
    const { svc, markRead } = make();
    markRead.mockRejectedValueOnce(new Error('boom'));
    await expect(svc.markReadOnServer('100000000000000002')).resolves.toBeUndefined();
    await svc.markReadOnServer('100000000000000002');
    expect(markRead).toHaveBeenCalledTimes(2);
  });
});

describe('FacebookE2EEBridge.markRead', () => {
  test('sendsStringThreadIdWith15sTimeout', async () => {
    const bridge = FacebookE2EEBridge.create('/fake/bridge');
    const call = jest.spyOn(bridge, 'call').mockResolvedValue(undefined as any);
    await bridge.markRead({ threadId: '24512345678901234', watermarkTs: T });
    expect(call).toHaveBeenCalledWith('markRead', { threadId: '24512345678901234', watermarkTs: T }, 15_000);
  });
});
