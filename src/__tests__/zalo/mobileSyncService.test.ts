import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-mobilesync-'));
const activePath = path.join(tmpDir, 'active.db');
const bossPath = path.join(tmpDir, 'boss.db');
const ws = { activeId: 'default' };

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock('../../utils/WorkspaceManager', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getActiveDbPath: () => activePath,
      getActiveWorkspaceId: () => ws.activeId,
      getWorkspaceById: () => ({ dbPath: 'boss.db' }),
      resolveDbPath: (p: string) => path.join(tmpDir, p),
    }),
  },
}));
// Sự kiện từ điện thoại đi qua websocket thật; test đẩy thẳng vào `api.send`.
jest.mock('../../services/zalo/mobileSync/zcaMobileSync', () => ({
  ...jest.requireActual('../../services/zalo/mobileSync/zcaMobileSync'),
  attachSyncEventListener: jest.fn((api: any, cb: (e: any) => void) => {
    api.handlers.add(cb);
    return () => api.handlers.delete(cb);
  }),
}));

import Logger from '../../utils/Logger';
import DatabaseService from '../../services/database/DatabaseService';
import MobileSyncService, { MOBILE_SYNC_EVENT } from '../../services/zalo/mobileSync/MobileSyncService';
import type { MobileSyncStatus } from '../../services/zalo/mobileSync/types';
import { buildZdbBackup } from './helpers/zdbFixture';
import { createChatContentDb, ChatContentFixtureRow } from './helpers/chatContentFixture';

const T = 1_700_000_000_000;
const OWN_PLAIN = '100000001';
const OWN_NOISE = '8100000001';
const PEER = '200000002';
const G1 = '400000004';
const UNK = '500000005';
const TOKEN = 'SECRETTOKEN';
const noiseOf = (p: string) => '9' + p;
const groupNoiseOf = (p: string) => '7' + p;
const TERMINAL = ['completed', 'failed', 'cancelled'];
const NOOP_RANGE = { fromTs: null, toTs: null };

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-mobilesync-fx-'));
const workRoot = path.join(scratch, 'work');
let seq = 0;
let cli = 0;
const nextZalo = () => String(900000000 + ++seq);

const row = (o: Partial<ChatContentFixtureRow> = {}): ChatContentFixtureRow => {
  cli++;
  return { SenderId: PEER, CliMsgId: 7000 + cli, GlbMsgId: 9000 + cli, MsgType: 0, TimeStamp: T + cli, MsgContent: `noi dung ${cli}`, ...o };
};
const sqliteBuffer = (rows: ChatContentFixtureRow[]): Buffer => {
  const file = path.join(scratch, `b${++seq}.db`);
  createChatContentDb(file, rows);
  return fs.readFileSync(file);
};

interface BackupFile { name: string; rows: ChatContentFixtureRow[]; raw?: Buffer }
const defaultFiles = (): BackupFile[] => [
  { name: `${PEER}.db`, rows: [row(), row(), row(), row({ SenderId: OWN_PLAIN })] },
  { name: `group_${G1}.db`, rows: [row(), row({ SenderId: OWN_PLAIN })] },
  { name: `${UNK}.db`, rows: [row({ SenderId: UNK })] },
];

function makeApi() {
  const handlers = new Set<(e: any) => void>();
  const api: any = {
    handlers,
    custom: jest.fn(),
    getOwnId: () => OWN_NOISE,
    getContext: () => ({ userAgent: 'ua', cookie: { getCookieStringSync: () => 'zcookie=1' } }),
    pullMobile: jest.fn(async () => undefined),
    cancelPullMobile: jest.fn(async () => undefined),
    unresolvable: new Set<string>([UNK]),
    noiseFailures: 0,
    noiseOverride: {} as Record<string, string>,
    getNoisedIds: jest.fn(async ({ uids, gids }: { uids: string[]; gids: string[] }) => {
      if (uids.length && api.noiseFailures > 0) { api.noiseFailures--; throw new Error('boom'); }
      return { uids: uids.map(p => (api.unresolvable.has(p) ? '' : (api.noiseOverride[p] ?? noiseOf(p)))), gids: gids.map(groupNoiseOf) };
    }),
    getUserInfo: jest.fn(async () => ({})),
    getGroupInfo: jest.fn(async () => ({})),
    publicKey: () => api.pullMobile.mock.calls[api.pullMobile.mock.calls.length - 1][0].public_key as string,
    send(type: string, data: any) {
      for (const h of Array.from(handlers)) h({ type, data: { public_key: api.publicKey(), ...data } });
    },
  };
  return api;
}

/** Điện thoại giả: dựng bản sao lưu, mã hoá khoá AES bằng khoá công khai phiên đã gửi. */
function sendBackupInfo(env: Env, api: any, zaloId: string, files: BackupFile[], extra: Record<string, any> = {}, dbInfo?: any) {
  const raw = crypto.randomBytes(16);
  const aesKey = Buffer.from(raw.toString('hex').toUpperCase(), 'ascii');
  const pub = crypto.createPublicKey({ key: Buffer.from(api.publicKey(), 'base64'), format: 'der', type: 'spki' });
  const encrypted = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_PADDING }, raw).toString('base64');
  const fileKey = extra.wrongKey ? crypto.randomBytes(32) : aesKey;
  const url = `https://f.zdn.vn/${zaloId}?token=${TOKEN}`;
  env.backups.set(url, buildZdbBackup(files.map(f => ({ name: f.name, data: f.raw ?? sqliteBuffer(f.rows) })), fileKey));
  const total = files.reduce((n, f) => n + f.rows.length, 0);
  api.send('syncmsg_info', {
    uid: 'uid' in extra ? extra.uid : OWN_PLAIN, url, encrypted_key: encrypted, file_size: 1,
    db_info: JSON.stringify(dbInfo ?? { db_format: 1, backup_db: { msg_total: total } }),
    ...(extra.checksum ? { checksum_code: extra.checksum } : {}),
  });
}

interface Snapshot { stage: string; keyBlank: boolean; workDirs: string[] }
interface Env {
  svc: MobileSyncService;
  apis: Map<string, any>;
  emitted: MobileSyncStatus[];
  snaps: Snapshot[];
  backups: Map<string, Buffer>;
  download: jest.Mock;
  hooks: Array<(s: MobileSyncStatus) => void>;
}

function setup(over: Record<string, any> = {}): Env {
  const apis = new Map<string, any>();
  const emitted: MobileSyncStatus[] = [];
  const snaps: Snapshot[] = [];
  const backups = new Map<string, Buffer>();
  const hooks: Array<(s: MobileSyncStatus) => void> = [];
  const download = jest.fn(async (url: string, dest: string, opts: any) => {
    const buf = backups.get(url);
    if (!buf) throw new Error('no backup');
    opts.onProgress?.(buf.length, buf.length);
    fs.writeFileSync(dest, buf);
    return { bytes: buf.length };
  });
  const env: Env = { svc: undefined as any, apis, emitted, snaps, backups, download, hooks };
  env.svc = new MobileSyncService({
    getConnectedApi: (id: string) => apis.get(id),
    workRoot: () => workRoot,
    download,
    emit: (channel: string, status: MobileSyncStatus) => {
      expect(channel).toBe(MOBILE_SYNC_EVENT);
      emitted.push({ ...status });
      if (TERMINAL.includes(status.stage)) {
        const dir = path.join(workRoot, status.zaloId);
        snaps.push({
          stage: status.stage,
          keyBlank: (env.svc as any).sessions.get(status.zaloId).privateKey === '',
          workDirs: fs.existsSync(dir) ? fs.readdirSync(dir) : [],
        });
      }
      hooks.forEach(h => h(status));
    },
    ...over,
  });
  return env;
}

function connect(env: Env, zaloId: string, api = makeApi()) {
  env.apis.set(zaloId, api);
  env.svc.attachToApi(zaloId, api);
  return api;
}

const stagesOf = (env: Env, zaloId: string) => env.emitted
  .filter(s => s.zaloId === zaloId).map(s => s.stage).filter((s, i, a) => a[i - 1] !== s);
const lastOf = (env: Env, zaloId: string) => env.emitted.filter(s => s.zaloId === zaloId).pop();

const tick = () => new Promise<void>(r => setImmediate(r));
async function finished(env: Env, zaloId: string): Promise<MobileSyncStatus> {
  for (let i = 0; i < 4000; i++) {
    const last = lastOf(env, zaloId);
    if (last && TERMINAL.includes(last.stage)) return last;
    await jest.advanceTimersByTimeAsync(250);
    await tick();
  }
  throw new Error(`session did not finish, last=${lastOf(env, zaloId)?.stage}`);
}
async function waitForStage(env: Env, zaloId: string, stage: string) {
  for (let i = 0; i < 4000 && lastOf(env, zaloId)?.stage !== stage; i++) await tick();
  expect(lastOf(env, zaloId)?.stage).toBe(stage);
}

/** start → xác nhận → gửi bản sao lưu → chờ kết cục. */
async function runFull(env: Env, zaloId: string, api: any, files = defaultFiles(), range: any = NOOP_RANGE, extra: Record<string, any> = {}) {
  const res = await env.svc.start(zaloId, range);
  expect(res.success).toBe(true);
  api.send('user_confirm', { user_action: 1 });
  sendBackupInfo(env, api, zaloId, files, extra);
  return finished(env, zaloId);
}

describe('MobileSyncService', () => {
  const db = DatabaseService.getInstance();
  const count = (sql: string, params: any[]) => db.queryOne<any>(sql, params)!.n as number;
  const msgCount = (zaloId: string, thread?: string) => thread
    ? count('SELECT COUNT(*) AS n FROM messages WHERE owner_zalo_id=? AND thread_id=?', [zaloId, thread])
    : count('SELECT COUNT(*) AS n FROM messages WHERE owner_zalo_id=?', [zaloId]);

  beforeAll(async () => {
    await db.initialize();
    db.forceFlush();
    fs.copyFileSync(activePath, bossPath);
  });
  beforeEach(() => {
    ws.activeId = 'default';
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    jest.clearAllMocks();
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  afterAll(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  describe('happy path', () => {
    test('happyPath', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      const final = await runFull(env, zid, api);

      expect(stagesOf(env, zid)).toEqual([
        'requesting', 'waiting_confirm', 'waiting_backup', 'downloading', 'decrypting', 'resolving_ids', 'importing', 'completed',
      ]);
      expect(final.message).toBe('Đã đồng bộ 6 tin nhắn mới từ 2 hội thoại');
      expect(final.progress).toBe(100);
      expect(final.stats).toEqual(expect.objectContaining({
        conversations: 3, conversationsResolved: 2, conversationsUnresolved: 1, conversationsFailed: 0,
        messagesRead: 6, messagesImported: 6, messagesSkipped: 0, messagesOutOfRange: 0,
      }));
      expect(api.pullMobile).toHaveBeenCalledWith(expect.objectContaining({ pc_name: 'Web', from_seq_id: 0 }));

      // tin nằm đúng hội thoại (id đã đổi), chưa đọc không tăng
      expect(msgCount(zid, noiseOf(PEER))).toBe(4);
      expect(msgCount(zid, groupNoiseOf(G1))).toBe(2);
      expect(msgCount(zid, noiseOf(UNK))).toBe(0);
      expect(msgCount(zid, PEER)).toBe(0);
      expect(count('SELECT COALESCE(SUM(unread_count),0) AS n FROM contacts WHERE owner_zalo_id=?', [zid])).toBe(0);
      // người gửi của chính mình được đổi sang id của tài khoản
      expect(count('SELECT COUNT(*) AS n FROM messages WHERE owner_zalo_id=? AND thread_id=? AND sender_id=?', [zid, noiseOf(PEER), OWN_NOISE])).toBe(1);
      // bảng ánh xạ lưu id đổi được, không lưu id không đổi được và không hỏi id của chính mình
      expect(db.getPlainIdMap(zid, 'user').get(PEER)).toBe(noiseOf(PEER));
      expect(db.getPlainIdMap(zid, 'user').has(UNK)).toBe(false);
      expect(db.getPlainIdMap(zid, 'group').get(G1)).toBe(groupNoiseOf(G1));
      const asked = api.getNoisedIds.mock.calls.flatMap((c: any[]) => c[0].uids);
      expect(asked).not.toContain(OWN_PLAIN);

      // tải: cookie / user agent / đích nằm trong thư mục làm việc
      const [, dest, opts] = env.download.mock.calls[0];
      expect(dest.startsWith(workRoot)).toBe(true);
      expect(opts.userAgent).toBe('ua');
      expect(opts.cookieFor('https://x.zdn.vn/a')).toBe('zcookie=1');

      // log không chứa link tải, khoá công khai hay nội dung tin
      const logged = JSON.stringify([
        ...(Logger.log as jest.Mock).mock.calls, ...(Logger.warn as jest.Mock).mock.calls, ...(Logger.error as jest.Mock).mock.calls,
      ]);
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain(api.publicKey());
      expect(logged).not.toContain('noi dung');
      expect(env.svc.getStatus(zid)).toEqual(expect.objectContaining({ stage: 'completed' }));
    });

    test('checksumMismatchOnlyWarns', async () => {
      const env = setup();
      const zid = nextZalo();
      const final = await runFull(env, zid, connect(env, zid), defaultFiles(), NOOP_RANGE, { checksum: 'a'.repeat(64) });
      expect(final.stage).toBe('completed');
      expect(Logger.warn).toHaveBeenCalled();
      expect(final.stats!.messagesImported).toBe(6);
    });

    test('rangeFiltersMessagesAndCountsOutOfRange', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      const rows = [row({ TimeStamp: T - 1000 }), row({ TimeStamp: T }), row({ TimeStamp: T + 1000 }), row({ TimeStamp: T + 5000 })];
      const final = await runFull(env, zid, api, [{ name: `${PEER}.db`, rows }], { fromTs: T, toTs: T + 1000 });
      expect(api.pullMobile).toHaveBeenCalledWith(expect.objectContaining({ from_seq_id: T }));
      expect(final.stats).toEqual(expect.objectContaining({ messagesRead: 2, messagesImported: 2, messagesOutOfRange: 2 }));
      expect(final.message).toBe('Đã đồng bộ 2 tin nhắn mới từ 1 hội thoại trong khoảng thời gian đã chọn');
      expect(msgCount(zid, noiseOf(PEER))).toBe(2);
    });
  });

  describe('events and messages', () => {
    test('rejectsInvalidRangeOfflineAndSecondStart', async () => {
      const env = setup();
      const zid = nextZalo();
      expect(await env.svc.start(zid, { fromTs: 20, toTs: 10 })).toEqual({ success: false, error: 'Ngày bắt đầu phải trước ngày kết thúc' });
      expect(await env.svc.start(zid, NOOP_RANGE)).toEqual({ success: false, error: 'Tài khoản không online' });
      connect(env, zid);
      const first = await env.svc.start(zid, NOOP_RANGE);
      expect(first.success).toBe(true);
      const second = await env.svc.start(zid, NOOP_RANGE);
      expect(second).toEqual(expect.objectContaining({ success: false, error: 'Đang có một phiên đồng bộ chạy cho tài khoản này' }));
      expect(env.svc.getStatus(zid)!.stage).toBe('waiting_confirm'); // phiên đầu không bị ảnh hưởng
      expect(env.apis.get(zid).pullMobile).toHaveBeenCalledTimes(1);
      await env.svc.cancel(zid);
    });

    test('secondStartWhileRunningDoesNotDisturbTheFirst', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      await env.svc.start(zid, NOOP_RANGE);
      api.send('user_confirm', { user_action: 1 });
      expect((await env.svc.start(zid, NOOP_RANGE)).success).toBe(false);
      sendBackupInfo(env, api, zid, defaultFiles());
      expect((await finished(env, zid)).stage).toBe('completed');
      expect(api.pullMobile).toHaveBeenCalledTimes(1);
    });

    test.each([
      ['userRejects', 'user_confirm', { user_action: 0 }, 'cancelled', 'Bạn đã từ chối đồng bộ trên điện thoại'],
      ['mobileRestoring', 'user_confirm', { user_action: 2 }, 'failed', 'Điện thoại đang khôi phục dữ liệu, vui lòng thử lại sau'],
      ['transferErrorCode', 'transfer_error', { error_code: 7, error_msg: 'boom' }, 'failed', 'Điện thoại không tạo được bản sao lưu (mã 7: boom)'],
    ])('%s', async (_name, type, data, stage, message) => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      await env.svc.start(zid, NOOP_RANGE);
      api.send(type, data);
      expect(env.svc.getStatus(zid)).toEqual(expect.objectContaining({ stage, message }));
      if (stage === 'failed') expect(env.svc.getStatus(zid)!.error).toBe(message);
    });

    test('mobileIdleThenBackupStillWorks', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      await env.svc.start(zid, NOOP_RANGE);
      api.send('user_confirm', { user_action: 3 });
      api.send('transfer_error', { status: 2 });
      expect(env.svc.getStatus(zid)).toEqual(expect.objectContaining({
        stage: 'mobile_idle', message: 'Điện thoại đang tạm dừng — mở Zalo trên điện thoại để tiếp tục đồng bộ',
      }));
      sendBackupInfo(env, api, zid, defaultFiles());
      expect((await finished(env, zid)).stage).toBe('completed');
    });

    test('unsupportedDbFormatFails', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      await env.svc.start(zid, NOOP_RANGE);
      api.send('user_confirm', { user_action: 1 });
      sendBackupInfo(env, api, zid, defaultFiles(), {}, { db_format: 2, backup_db: { msg_total: 3 } });
      const final = await finished(env, zid);
      expect(final).toEqual(expect.objectContaining({
        stage: 'failed',
        error: 'Định dạng sao lưu chưa được hỗ trợ (db_format=2). Hãy cập nhật Zalo trên điện thoại rồi thử lại.',
      }));
      expect(env.download).not.toHaveBeenCalled();
    });

    test.each([
      ['noRange', NOOP_RANGE, 'Điện thoại không có tin nhắn nào để đồng bộ'],
      ['withFromOnly', { fromTs: T, toTs: null }, 'Điện thoại không có tin nhắn nào trong khoảng thời gian đã chọn'],
      ['withToOnly', { fromTs: null, toTs: T }, 'Điện thoại không có tin nhắn nào trong khoảng thời gian đã chọn'],
    ])('zeroMessagesCompletesWithoutDownload_%s', async (_n, range, message) => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      await env.svc.start(zid, range);
      api.send('user_confirm', { user_action: 1 });
      sendBackupInfo(env, api, zid, defaultFiles(), {}, { db_format: 1, origin_db: { msg_total: 0 } });
      const final = await finished(env, zid);
      expect(final).toEqual(expect.objectContaining({ stage: 'completed', message, progress: 100 }));
      expect(env.download).not.toHaveBeenCalled();
      expect(env.snaps.pop()).toEqual({ stage: 'completed', keyBlank: true, workDirs: [] });
    });

    test('pullMobileFailureFails', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      api.pullMobile.mockRejectedValueOnce(new Error('offline'));
      const res = await env.svc.start(zid, NOOP_RANGE);
      expect(res.success).toBe(false);
      expect(env.svc.getStatus(zid)).toEqual(expect.objectContaining({ stage: 'failed', error: 'Không gửi được yêu cầu đồng bộ: offline' }));
      expect(env.snaps[0].keyBlank).toBe(true);
    });

    test('ignoresForeignPublicKeyAndEventsAfterTheEnd', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      await env.svc.start(zid, NOOP_RANGE);
      api.send('user_confirm', { user_action: 1, public_key: 'someone-else' });
      expect(env.svc.getStatus(zid)!.stage).toBe('waiting_confirm');
      api.send('user_confirm', { user_action: 0 });
      expect(env.svc.getStatus(zid)!.stage).toBe('cancelled');
      const before = env.emitted.length;
      api.send('user_confirm', { user_action: 1 });
      api.send('syncmsg_info', { uid: OWN_PLAIN, url: 'https://f.zdn.vn/x', encrypted_key: 'x' });
      expect(env.emitted.length).toBe(before);
      expect(env.download).not.toHaveBeenCalled();
    });

    test('eventsWhileImportingAreIgnored', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      await env.svc.start(zid, NOOP_RANGE);
      api.send('user_confirm', { user_action: 1 });
      sendBackupInfo(env, api, zid, defaultFiles());
      api.send('user_confirm', { user_action: 0 }); // đến giữa lúc đang nhập
      api.send('syncmsg_info', { uid: OWN_PLAIN, url: 'https://f.zdn.vn/other', encrypted_key: 'x' });
      expect((await finished(env, zid)).stage).toBe('completed');
      expect(env.download).toHaveBeenCalledTimes(1);
    });
  });

  describe('deadlines', () => {
    test('confirmTimeout', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      await env.svc.start(zid, NOOP_RANGE);
      await jest.advanceTimersByTimeAsync(179_999);
      expect(env.svc.getStatus(zid)!.stage).toBe('waiting_confirm');
      await jest.advanceTimersByTimeAsync(1);
      expect(api.cancelPullMobile).toHaveBeenCalledWith({ public_key: api.publicKey(), pc_name: 'Web' });
      expect(env.svc.getStatus(zid)).toEqual(expect.objectContaining({ stage: 'failed', error: 'Hết thời gian chờ xác nhận trên điện thoại' }));
      expect(env.snaps[0]).toEqual({ stage: 'failed', keyBlank: true, workDirs: [] });
    });

    test('backupTimeoutAndTransferErrorResetsIt', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      await env.svc.start(zid, NOOP_RANGE);
      api.send('user_confirm', { user_action: 1 });
      await jest.advanceTimersByTimeAsync(1_700_000);
      api.send('transfer_error', { status: 1 }); // điện thoại báo vẫn đang chuẩn bị → đặt lại hạn
      await jest.advanceTimersByTimeAsync(1_700_000);
      expect(env.svc.getStatus(zid)!.stage).toBe('waiting_backup');
      expect(api.cancelPullMobile).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(100_000);
      expect(api.cancelPullMobile).toHaveBeenCalledTimes(1);
      expect(env.svc.getStatus(zid)).toEqual(expect.objectContaining({ stage: 'failed', error: 'Hết thời gian chờ điện thoại gửi dữ liệu' }));
    });
  });

  describe('cancel', () => {
    test.each([['waiting_confirm', false], ['waiting_backup', true]])('cancelWhile_%s', async (stage, confirmed) => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      await env.svc.start(zid, NOOP_RANGE);
      if (confirmed) api.send('user_confirm', { user_action: 1 });
      expect(env.svc.getStatus(zid)!.stage).toBe(stage);
      const res = await env.svc.cancel(zid);
      expect(res.success).toBe(true);
      expect(api.cancelPullMobile).toHaveBeenCalledTimes(1);
      expect(env.svc.getStatus(zid)).toEqual(expect.objectContaining({ stage: 'cancelled', message: 'Đã huỷ đồng bộ' }));
      expect(env.snaps[0]).toEqual({ stage: 'cancelled', keyBlank: true, workDirs: [] });
      expect((await env.svc.cancel(zid)).success).toBe(true); // lần hai không làm gì
      expect(api.cancelPullMobile).toHaveBeenCalledTimes(1);
    });

    test.each(['downloading', 'decrypting', 'resolving_ids', 'importing'])('cancelWhile_%s', async (stage) => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      let cancelled: Promise<any> | null = null;
      env.hooks.push(s => { if (s.stage === stage && !cancelled) cancelled = env.svc.cancel(zid); });
      const final = await runFull(env, zid, api);
      await cancelled;
      expect(final).toEqual(expect.objectContaining({ stage: 'cancelled', message: 'Đã huỷ đồng bộ' }));
      expect(api.cancelPullMobile).not.toHaveBeenCalled(); // chỉ hai bước chờ mới gọi
      expect(msgCount(zid)).toBe(0);
      expect(env.snaps.pop()).toEqual({ stage: 'cancelled', keyBlank: true, workDirs: [] });
    });
  });

  describe('cleanup on every outcome (Review Focus 3)', () => {
    const outcomes: Array<[string, (env: Env, zid: string, api: any) => Promise<MobileSyncStatus>, string]> = [
      ['completed', (env, zid, api) => runFull(env, zid, api), 'completed'],
      ['downloadError', async (env, zid, api) => {
        env.download.mockImplementationOnce(async (_u: string, dest: string) => { fs.writeFileSync(dest, 'partial'); throw new Error('mất mạng'); });
        return runFull(env, zid, api);
      }, 'failed'],
      ['decryptError', (env, zid, api) => runFull(env, zid, api, defaultFiles(), NOOP_RANGE, { wrongKey: true }), 'failed'],
      ['idResolutionError', async (env, zid, api) => { api.noiseFailures = 99; return runFull(env, zid, api); }, 'failed'],
    ];
    test.each(outcomes)('%s', async (_name, run, stage) => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      const final = await run(env, zid, api);
      expect(final.stage).toBe(stage);
      // trạng thái cuối chỉ phát SAU khi khoá đã xoá và thư mục làm việc đã dọn
      expect(env.snaps).toEqual([{ stage, keyBlank: true, workDirs: [] }]);
      expect(fs.readdirSync(path.join(workRoot, zid))).toEqual([]);
      expect((env.svc as any).sessions.get(zid).privateKey).toBe('');
    });

    test('idResolutionErrorMessage', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      api.noiseFailures = 99;
      const final = await runFull(env, zid, api);
      expect(final.error).toBe('Không đổi được ID hội thoại từ điện thoại: boom');
    });

    test('sweepLeftoversRemovesLeftoverDirsAndToleratesMissingRoot', () => {
      const root = path.join(scratch, 'sweep');
      const env = setup({ workRoot: () => root });
      expect(() => env.svc.sweepLeftovers()).not.toThrow(); // chưa có thư mục
      fs.mkdirSync(path.join(root, 'acct', '123'), { recursive: true });
      fs.writeFileSync(path.join(root, 'acct', '123', 'backup.db.crypt'), 'x');
      env.svc.sweepLeftovers();
      expect(fs.existsSync(root)).toBe(false);
    });
  });

  describe('noise id resolution', () => {
    test('batchesOf500AndRetries', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      api.noiseFailures = 2; // lô đầu lỗi hai lần rồi được (chờ 1 s + 2 s)
      const rows = Array.from({ length: 1200 }, (_, i) => row({ SenderId: String(600000000 + i) }));
      const final = await runFull(env, zid, api, [{ name: `group_${G1}.db`, rows }]);
      expect(final.stage).toBe('completed');
      expect(final.stats!.messagesImported).toBe(1200);
      const userCalls = api.getNoisedIds.mock.calls.filter((c: any[]) => c[0].uids.length > 0);
      expect(userCalls.slice(-3).map((c: any[]) => c[0].uids.length)).toEqual([500, 500, 200]);
      expect(userCalls).toHaveLength(5); // 2 lần lỗi + 3 lô
    });

    test('knownIdsAreNotAskedAgain', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      db.savePlainIdMap(zid, 'user', [[PEER, noiseOf(PEER)]]);
      const final = await runFull(env, zid, api, [{ name: `${PEER}.db`, rows: [row(), row()] }]);
      expect(final.stats!.messagesImported).toBe(2);
      expect(api.getNoisedIds.mock.calls.flatMap((c: any[]) => c[0].uids)).not.toContain(PEER);
    });

    test('unresolvedConversationsAreCountedNotImported', async () => {
      const env = setup();
      const zid = nextZalo();
      const final = await runFull(env, zid, connect(env, zid), [{ name: `${UNK}.db`, rows: [row({ SenderId: UNK })] }]);
      expect(final.stats).toEqual(expect.objectContaining({ conversations: 1, conversationsResolved: 0, conversationsUnresolved: 1, messagesImported: 0 }));
      expect(msgCount(zid)).toBe(0);
    });
  });

  describe('Review Focus 5', () => {
    test('writesToTheBossDbWhileAnotherWorkspaceIsOpen', async () => {
      ws.activeId = 'employee';
      const env = setup();
      const zid = nextZalo();
      const final = await runFull(env, zid, connect(env, zid));
      expect(final.stage).toBe('completed');
      expect(msgCount(zid)).toBe(0); // DB đang mở không có gì
      expect(db.withDbPath(bossPath, () => msgCount(zid, noiseOf(PEER)))).toBe(4);
      expect(db.withDbPath(bossPath, () => db.getPlainIdMap(zid, 'user').get(PEER))).toBe(noiseOf(PEER));
    });

    test('reattachedApiMidWaitStillDeliversEvents', async () => {
      const env = setup();
      const zid = nextZalo();
      const api1 = connect(env, zid);
      await env.svc.start(zid, NOOP_RANGE);
      const api2 = makeApi();
      api2.publicKey = api1.publicKey; // điện thoại vẫn trả lời theo khoá công khai của phiên
      env.apis.set(zid, api2); // zca-js nối lại: api/ws mới
      env.svc.attachToApi(zid, api2);
      expect(api1.handlers.size).toBe(0);
      expect(api2.handlers.size).toBe(1);
      api2.send('user_confirm', { user_action: 1 });
      sendBackupInfo(env, api2, zid, defaultFiles());
      expect((await finished(env, zid)).stage).toBe('completed');
      expect(api2.getNoisedIds).toHaveBeenCalled();
      expect(api1.getNoisedIds).not.toHaveBeenCalled();
    });

    test('startReattachesWhenTheConnectedApiChanged', async () => {
      const env = setup();
      const zid = nextZalo();
      const api1 = connect(env, zid);
      const api2 = makeApi();
      env.apis.set(zid, api2); // đăng nhập lại nhưng chưa ai gọi attachToApi
      await env.svc.start(zid, NOOP_RANGE);
      expect(api1.handlers.size).toBe(0);
      expect(api2.handlers.size).toBe(1);
      expect(api2.pullMobile).toHaveBeenCalledTimes(1);
      api2.send('user_confirm', { user_action: 0 });
      expect(env.svc.getStatus(zid)!.stage).toBe('cancelled');
    });

    test('twoAccountsRunInParallelWithoutMixingEvents', async () => {
      const env = setup();
      const z1 = nextZalo();
      const z2 = nextZalo();
      const a1 = connect(env, z1);
      const a2 = connect(env, z2);
      await env.svc.start(z1, NOOP_RANGE);
      await env.svc.start(z2, NOOP_RANGE);
      expect(a1.publicKey()).not.toBe(a2.publicKey());
      a1.send('user_confirm', { user_action: 0 }); // chỉ z1 bị từ chối
      expect(env.svc.getStatus(z1)!.stage).toBe('cancelled');
      expect(env.svc.getStatus(z2)!.stage).toBe('waiting_confirm');
      a2.send('user_confirm', { user_action: 1 });
      sendBackupInfo(env, a2, z2, [{ name: `${PEER}.db`, rows: [row(), row()] }]);
      expect((await finished(env, z2)).stats!.messagesImported).toBe(2);
      expect(env.svc.getStatus(z1)!.stage).toBe('cancelled');
      expect(msgCount(z1)).toBe(0);
      expect(msgCount(z2, noiseOf(PEER))).toBe(2);
    });
  });

  describe('progress', () => {
    test('throttlesProgressButAlwaysEmitsStageChanges', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      env.download.mockImplementationOnce(async (url: string, dest: string, opts: any) => {
        for (let i = 1; i <= 50; i++) opts.onProgress(i, 100); // cùng một mốc thời gian
        jest.advanceTimersByTime(300);
        opts.onProgress(60, 100);
        opts.onProgress(70, 100);
        fs.writeFileSync(dest, env.backups.get(url)!);
        return { bytes: 1 };
      });
      const final = await runFull(env, zid, api);
      expect(final.stage).toBe('completed');
      const downloading = env.emitted.filter(s => s.zaloId === zid && s.stage === 'downloading');
      expect(downloading).toHaveLength(2); // đổi bước + một lần sau 300 ms
      expect(downloading[1].progress).toBeGreaterThan(downloading[0].progress);
      expect(stagesOf(env, zid)).toEqual(expect.arrayContaining(['decrypting', 'resolving_ids', 'importing']));
    });

    test('progressNeverDecreasesAndEndsAt100', async () => {
      const env = setup();
      const zid = nextZalo();
      await runFull(env, zid, connect(env, zid));
      const values = env.emitted.filter(s => s.zaloId === zid).map(s => s.progress);
      for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
      expect(values[values.length - 1]).toBe(100);
    });
  });

  describe('profile refresh', () => {
    test('queriesInBatchesOf50AndIgnoresFailures', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      const peers = Array.from({ length: 120 }, (_, i) => String(300000000 + i));
      const files: BackupFile[] = [
        ...peers.map(p => ({ name: `${p}.db`, rows: [row({ SenderId: p })] })),
        { name: `group_${G1}.db`, rows: [row()] },
      ];
      api.getUserInfo
        .mockImplementationOnce(async (ids: string[]) => ({ changed_profiles: { [ids[0]]: { displayName: 'An', avatar: 'a.png' } } }))
        .mockImplementationOnce(async () => { throw new Error('rate limited'); });
      api.getGroupInfo.mockImplementation(async (ids: string[]) => ({ gridInfoMap: { [ids[0]]: { name: 'Nhóm X', avt: 'g.png' } } }));
      const final = await runFull(env, zid, api, files);
      expect(final.stage).toBe('completed'); // lỗi ở bước bổ sung hồ sơ không làm hỏng kết quả
      expect(final.stats!.messagesImported).toBe(121);
      expect(api.getUserInfo.mock.calls.map((c: any[]) => c[0].length)).toEqual([50, 50, 20]);
      expect(api.getGroupInfo.mock.calls.map((c: any[]) => c[0].length)).toEqual([1]);
      const firstUser = api.getUserInfo.mock.calls[0][0][0];
      expect(db.queryOne<any>('SELECT display_name FROM contacts WHERE owner_zalo_id=? AND contact_id=?', [zid, firstUser])!.display_name).toBe('An');
      expect(db.queryOne<any>('SELECT display_name FROM contacts WHERE owner_zalo_id=? AND contact_id=?', [zid, groupNoiseOf(G1)])!.display_name).toBe('Nhóm X');
    });
  });

  describe('fix round 1', () => {
    const deferred = () => {
      let resolve!: (v?: any) => void; let reject!: (e: any) => void;
      const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };
    const never = () => new Promise<never>(() => undefined);
    const junkInfo = { uid: OWN_PLAIN, url: 'https://f.zdn.vn/junk', encrypted_key: 'x' };

    // 1. máy chủ treo không giữ phiên mãi
    test.each([
      ['userCancel', false],
      ['confirmDeadline', true],
    ])('hungCancelPullMobileEndsWithin10s_%s', async (_n, viaDeadline) => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      api.cancelPullMobile.mockImplementation(never);
      await env.svc.start(zid, NOOP_RANGE);
      if (viaDeadline) await jest.advanceTimersByTimeAsync(180_000);
      else void env.svc.cancel(zid);
      await jest.advanceTimersByTimeAsync(9_999);
      expect(TERMINAL).not.toContain(env.svc.getStatus(zid)!.stage);
      await jest.advanceTimersByTimeAsync(1);
      expect(env.svc.getStatus(zid)!.stage).toBe(viaDeadline ? 'failed' : 'cancelled');
      expect(env.snaps).toHaveLength(1);
      api.cancelPullMobile.mockImplementation(async () => undefined);
      expect((await env.svc.start(zid, NOOP_RANGE)).success).toBe(true); // tài khoản được giải phóng
      await env.svc.cancel(zid);
    });

    test('rejectingCancelPullMobileStillEnds', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      api.cancelPullMobile.mockRejectedValue(new Error('net'));
      await env.svc.start(zid, NOOP_RANGE);
      await jest.advanceTimersByTimeAsync(180_000);
      expect(env.svc.getStatus(zid)).toEqual(expect.objectContaining({ stage: 'failed', error: 'Hết thời gian chờ xác nhận trên điện thoại' }));
      expect((await env.svc.start(zid, NOOP_RANGE)).success).toBe(true);
      await env.svc.cancel(zid);
      expect(env.svc.getStatus(zid)!.stage).toBe('cancelled');
    });

    test('hungPullMobileFailsAfter30s', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      api.pullMobile.mockImplementation(never);
      const started = env.svc.start(zid, NOOP_RANGE);
      await jest.advanceTimersByTimeAsync(29_999);
      expect(env.svc.getStatus(zid)!.stage).toBe('requesting');
      await jest.advanceTimersByTimeAsync(1);
      const res = await started;
      expect(res.success).toBe(false);
      expect(env.svc.getStatus(zid)).toEqual(expect.objectContaining({
        stage: 'failed', error: 'Không gửi được yêu cầu đồng bộ: hết thời gian chờ máy chủ Zalo',
      }));
      expect(env.snaps[0].keyBlank).toBe(true);
    });

    // 2. sự kiện đến trong lúc chờ cancelPullMobile không làm phiên sống lại
    test.each([
      ['confirmDeadline', true],
      ['userCancel', false],
    ])('syncmsgInfoDuringPendingCancelDoesNotStartAnImport_%s', async (_n, viaDeadline) => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      const pending = deferred();
      api.cancelPullMobile.mockImplementationOnce(() => pending.promise);
      await env.svc.start(zid, NOOP_RANGE);
      let cancelled: Promise<any> | undefined;
      if (viaDeadline) await jest.advanceTimersByTimeAsync(180_000);
      else cancelled = env.svc.cancel(zid);
      api.send('user_confirm', { user_action: 1 });
      api.send('syncmsg_info', junkInfo);
      await tick();
      expect(env.download).not.toHaveBeenCalled();
      expect((env.svc as any).sessions.get(zid).importing).toBe(false);
      expect(TERMINAL).not.toContain(env.svc.getStatus(zid)!.stage);
      pending.resolve();
      await cancelled;
      await jest.advanceTimersByTimeAsync(0);
      expect(env.snaps).toEqual([{ stage: viaDeadline ? 'failed' : 'cancelled', keyBlank: true, workDirs: [] }]);
      expect(env.download).not.toHaveBeenCalled();
    });

    // 3. một file hỏng không làm hỏng cả lượt
    test('corruptConversationFileIsCountedAndTheRestImported', async () => {
      const env = setup();
      const zid = nextZalo();
      const files: BackupFile[] = [
        { name: '300000003.db', rows: [], raw: Buffer.from('this is not a sqlite database '.repeat(200)) },
        ...defaultFiles(),
      ];
      const final = await runFull(env, zid, connect(env, zid), files);
      expect(final.stage).toBe('completed');
      expect(final.stats).toEqual(expect.objectContaining({ conversationsFailed: 1, messagesImported: 6 }));
      expect(final.message).toBe('Đã đồng bộ 6 tin nhắn mới từ 2 hội thoại');
      expect(msgCount(zid, noiseOf(PEER))).toBe(4);
      const warned = JSON.stringify((Logger.warn as jest.Mock).mock.calls);
      expect(warned).not.toContain('300000003');
    });

    test('bulkSaveFailureIsFatalAndCleanedUp', async () => {
      const env = setup();
      const zid = nextZalo();
      const spy = jest.spyOn(db, 'saveHistoryMessagesBulk').mockImplementation(() => { throw new Error('disk full'); });
      try {
        const final = await runFull(env, zid, connect(env, zid));
        expect(final).toEqual(expect.objectContaining({ stage: 'failed', error: 'Không ghi được tin nhắn vào cơ sở dữ liệu (disk full)' }));
        expect(env.snaps).toEqual([{ stage: 'failed', keyBlank: true, workDirs: [] }]);
      } finally {
        spy.mockRestore();
      }
    });

    // 4. websocket rớt khi syncmsg_info đến: vẫn dùng api đã gắn
    test('importUsesTheLastAttachedApiWhenNotConnected', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      await env.svc.start(zid, NOOP_RANGE);
      api.send('user_confirm', { user_action: 1 });
      env.apis.delete(zid); // không còn kết nối
      sendBackupInfo(env, api, zid, defaultFiles());
      const final = await finished(env, zid);
      expect(final.stage).toBe('completed');
      expect(api.getNoisedIds).toHaveBeenCalled();
    });

    // 6. còn thiếu
    test('cancelWhileRequestingResolvesStartAndNothingRevivesIt', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      const pull = deferred();
      api.pullMobile.mockImplementationOnce(() => pull.promise);
      const started = env.svc.start(zid, NOOP_RANGE);
      await tick();
      await env.svc.cancel(zid);
      expect(api.cancelPullMobile).toHaveBeenCalledTimes(1);
      const res = await started;
      expect(res.success).toBe(false);
      expect(env.svc.getStatus(zid)!.stage).toBe('cancelled');
      pull.resolve();
      await jest.advanceTimersByTimeAsync(0);
      expect(env.svc.getStatus(zid)!.stage).toBe('cancelled');
      expect(stagesOf(env, zid)).toEqual(['requesting', 'cancelled']);
    });

    test('cancelInMobileIdle', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      await env.svc.start(zid, NOOP_RANGE);
      api.send('transfer_error', { status: 2 });
      expect(env.svc.getStatus(zid)!.stage).toBe('mobile_idle');
      await env.svc.cancel(zid);
      expect(api.cancelPullMobile).toHaveBeenCalledTimes(1);
      expect(env.snaps).toEqual([{ stage: 'cancelled', keyBlank: true, workDirs: [] }]);
    });

    test('downloadHonouringIsCancelledIsStoppedByTheServiceFlag', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      env.download.mockImplementationOnce(async (_u: string, _d: string, opts: any) => {
        for (let i = 0; i < 100000; i++) {
          if (opts.isCancelled()) throw Object.assign(new Error('Đã huỷ tải bản sao lưu'), { name: 'AbortError' });
          await tick();
        }
        throw new Error('flag never seen');
      });
      await env.svc.start(zid, NOOP_RANGE);
      api.send('user_confirm', { user_action: 1 });
      sendBackupInfo(env, api, zid, defaultFiles());
      await waitForStage(env, zid, 'downloading');
      await env.svc.cancel(zid);
      const final = await finished(env, zid);
      expect(final).toEqual(expect.objectContaining({ stage: 'cancelled', message: 'Đã huỷ đồng bộ' }));
      expect(env.snaps).toEqual([{ stage: 'cancelled', keyBlank: true, workDirs: [] }]);
    });

    test.each([
      ['uidMissing_ownResolvable', undefined, true],
      ['uidInvalid_ownUnresolvable', 'abc', false],
    ])('missingUidDoesNotMisattribute_%s', async (_n, uid, ownResolvable) => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      if (ownResolvable) api.noiseOverride[OWN_PLAIN] = OWN_NOISE; else api.unresolvable.add(OWN_PLAIN);
      const rows = [row(), row({ SenderId: OWN_PLAIN }), row({ SenderId: OWN_PLAIN }), row()];
      const final = await runFull(env, zid, api, [{ name: `${PEER}.db`, rows }], NOOP_RANGE, { uid });
      expect(final.stage).toBe('completed');
      const stored = db.query<any>('SELECT sender_id, is_sent FROM messages WHERE owner_zalo_id=? ORDER BY timestamp', [zid]);
      const peerRows = stored.filter(r => r.sender_id === noiseOf(PEER));
      expect(peerRows).toHaveLength(2);
      expect(peerRows.every(r => Number(r.is_sent) === 0)).toBe(true);
      const ownRows = stored.filter(r => r.sender_id === OWN_NOISE);
      if (ownResolvable) {
        expect(ownRows).toHaveLength(2);
        expect(ownRows.every(r => Number(r.is_sent) === 1)).toBe(true);
        expect(stored).toHaveLength(4);
      } else {
        expect(stored).toHaveLength(2); // tin của mình bị bỏ, không lưu dưới người gửi khác
        expect(final.stats!.messagesSkipped).toBe(2);
      }
    });

    // 7. mục nhỏ
    test('noSleepAfterTheLastFailedAttempt', async () => {
      const sleep = jest.fn(async () => undefined);
      const env = setup({ sleep });
      const zid = nextZalo();
      const api = connect(env, zid);
      api.noiseFailures = 99;
      const final = await runFull(env, zid, api);
      expect(final.error).toBe('Không đổi được ID hội thoại từ điện thoại: boom');
      expect(sleep.mock.calls.map(c => (c as any[])[0])).toEqual([1000, 2000]);
    });

    test('retrySleepEndsEarlyOnCancel', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      api.noiseFailures = 99;
      await env.svc.start(zid, NOOP_RANGE);
      api.send('user_confirm', { user_action: 1 });
      sendBackupInfo(env, api, zid, defaultFiles());
      for (let i = 0; i < 4000 && api.getNoisedIds.mock.calls.length < 1; i++) await tick();
      await env.svc.cancel(zid);
      const final = await finished(env, zid);
      expect(final.stage).toBe('cancelled');
      expect(api.getNoisedIds).toHaveBeenCalledTimes(1);
    });

    test('completedCountsOnlyConversationsThatReceivedNewMessages', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      const files = defaultFiles();
      expect((await runFull(env, zid, api, files)).message).toBe('Đã đồng bộ 6 tin nhắn mới từ 2 hội thoại');
      const again = await runFull(env, zid, api, files);
      expect(again.message).toBe('Đã đồng bộ 0 tin nhắn mới từ 0 hội thoại');
      expect(again.stats!.conversationsResolved).toBe(2);
    });

    test('invalidAccountIdIsRejected', async () => {
      const env = setup();
      env.apis.set('../evil', makeApi());
      expect(await env.svc.start('../evil', NOOP_RANGE)).toEqual({ success: false, error: 'Tài khoản không online' });
      expect(env.svc.getStatus('../evil')).toBeNull();
      expect((await env.svc.cancel('../evil')).success).toBe(false);
      expect(env.emitted).toHaveLength(0);
    });

    test('startReturnsFailureWhenInstallingApisThrows', async () => {
      const env = setup();
      const zid = nextZalo();
      const api: any = makeApi();
      delete api.custom; // installMobileSyncApis ném
      env.apis.set(zid, api);
      const res = await env.svc.start(zid, NOOP_RANGE);
      expect(res.success).toBe(false);
      expect(res.error).toBeTruthy();
    });

    test('workDirRemovalFailureIsLoggedWithoutUserData', async () => {
      const env = setup();
      const zid = nextZalo();
      const realRm = fs.promises.rm.bind(fs.promises);
      const rm = jest.spyOn(fs.promises, 'rm').mockImplementation(((p: any, o: any) => (o?.recursive ? Promise.reject(new Error('EBUSY')) : realRm(p, o))) as any);
      try {
        const final = await runFull(env, zid, connect(env, zid));
        expect(final.stage).toBe('completed');
        const warned = (Logger.warn as jest.Mock).mock.calls.map(c => String(c[0])).filter(m => m.includes('thư mục làm việc'));
        expect(warned).toHaveLength(1);
        expect(warned[0]).not.toContain(scratch);
      } finally {
        rm.mockRestore();
        fs.rmSync(path.join(workRoot, zid), { recursive: true, force: true });
      }
    });
  });

  describe('follow-up round', () => {
    const deferred = () => {
      let resolve!: (v?: any) => void;
      const promise = new Promise<any>(res => { resolve = res; });
      return { promise, resolve };
    };

    test('userCancelDuringDeadlineCloseWinsAndSendsOneServerCancel', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      const pending = deferred();
      api.cancelPullMobile.mockImplementationOnce(() => pending.promise);
      await env.svc.start(zid, NOOP_RANGE);
      await jest.advanceTimersByTimeAsync(180_000); // hạn chót → đang đóng
      const cancelled = env.svc.cancel(zid);
      await jest.advanceTimersByTimeAsync(0);
      pending.resolve();
      await cancelled;
      await jest.advanceTimersByTimeAsync(0);
      expect(api.cancelPullMobile).toHaveBeenCalledTimes(1);
      expect(env.snaps).toEqual([{ stage: 'cancelled', keyBlank: true, workDirs: [] }]);
      expect(env.svc.getStatus(zid)).toEqual(expect.objectContaining({ stage: 'cancelled', message: 'Đã huỷ đồng bộ' }));
    });

    test('latePullMobileSuccessAfterUserCancelSendsABestEffortCancel', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      const pull = deferred();
      api.pullMobile.mockImplementationOnce(() => pull.promise);
      const started = env.svc.start(zid, NOOP_RANGE);
      await tick();
      await env.svc.cancel(zid);
      await started;
      expect(api.cancelPullMobile).toHaveBeenCalledTimes(1); // gửi sớm khi huỷ
      pull.resolve();
      await jest.advanceTimersByTimeAsync(0);
      expect(api.cancelPullMobile).toHaveBeenCalledTimes(2); // và một lần nữa khi yêu cầu đã tới máy chủ
      const keys = api.cancelPullMobile.mock.calls.map((c: any[]) => c[0].public_key);
      expect(keys[1]).toBe(keys[0]);
      expect(env.svc.getStatus(zid)!.stage).toBe('cancelled');
    });

    test('latePullMobileSuccessAfter30sTimeoutSendsOneCancelAndSparesANewSession', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      const pull = deferred();
      api.pullMobile.mockImplementationOnce(() => pull.promise);
      const first = env.svc.start(zid, NOOP_RANGE);
      await jest.advanceTimersByTimeAsync(30_000);
      expect((await first).success).toBe(false);
      const firstKey = (env.svc as any).sessions.get(zid).publicKey as string;
      expect(api.cancelPullMobile).not.toHaveBeenCalled();
      expect((await env.svc.start(zid, NOOP_RANGE)).success).toBe(true); // phiên mới cùng tài khoản
      const secondKey = (env.svc as any).sessions.get(zid).publicKey as string;
      expect(secondKey).not.toBe(firstKey);
      pull.resolve();
      await jest.advanceTimersByTimeAsync(0);
      expect(api.cancelPullMobile).toHaveBeenCalledTimes(1);
      expect(api.cancelPullMobile).toHaveBeenCalledWith({ public_key: firstKey, pc_name: 'Web' });
      expect(env.svc.getStatus(zid)!.stage).toBe('waiting_confirm'); // phiên mới không bị ảnh hưởng
      await env.svc.cancel(zid);
    });

    test('plainIdMapWriteFailureIsFatalNotASkippedFile', async () => {
      const env = setup();
      const zid = nextZalo();
      const orig = db.savePlainIdMap.bind(db);
      const spy = jest.spyOn(db, 'savePlainIdMap').mockImplementation(((o: string, kind: any, entries: any) => {
        if (kind === 'user') throw new Error('map write failed');
        return orig(o, kind, entries);
      }) as any);
      try {
        // nhóm đã đổi được id ở bước ghép; người gửi trong nhóm được đổi trong lúc nhập (bên trong try của từng file)
        const final = await runFull(env, zid, connect(env, zid), [{ name: `group_${G1}.db`, rows: [row({ SenderId: '600000001' })] }]);
        expect(final).toEqual(expect.objectContaining({ stage: 'failed', error: 'Không ghi được tin nhắn vào cơ sở dữ liệu (map write failed)' }));
        expect(final.stats!.conversationsFailed).toBe(0);
        expect(env.snaps).toEqual([{ stage: 'failed', keyBlank: true, workDirs: [] }]);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('final review fixes', () => {
    const deferred = () => {
      let resolve!: (v?: any) => void; let reject!: (e: any) => void;
      const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };
    const terminalCount = (env: Env, zid: string) => env.emitted.filter(s => s.zaloId === zid && TERMINAL.includes(s.stage)).length;
    /** start() với pullMobile do test điều khiển; sự kiện điện thoại tới trước phản hồi. */
    async function startPending(env: Env, zid: string) {
      const api = connect(env, zid);
      const pull = deferred();
      api.pullMobile.mockImplementationOnce(() => pull.promise);
      const started = env.svc.start(zid, NOOP_RANGE);
      await tick();
      return { api, pull, started };
    }

    // Fix 1: sự kiện tới trước phản hồi pull_mobile_msg
    test('confirmBeforePullResponseKeepsWaitingBackupAndThe30MinuteDeadline', async () => {
      const env = setup();
      const zid = nextZalo();
      const { api, pull, started } = await startPending(env, zid);
      api.send('user_confirm', { user_action: 1 });
      expect(env.svc.getStatus(zid)!.stage).toBe('waiting_backup');
      pull.resolve();
      expect((await started).success).toBe(true);
      expect(env.svc.getStatus(zid)!.stage).toBe('waiting_backup');
      expect(stagesOf(env, zid)).toEqual(['requesting', 'waiting_backup']);
      await jest.advanceTimersByTimeAsync(180_001);
      expect(env.svc.getStatus(zid)!.stage).toBe('waiting_backup'); // không dính hạn 3 phút
      await jest.advanceTimersByTimeAsync(1_800_000 - 180_001 - 1);
      expect(env.svc.getStatus(zid)!.stage).toBe('waiting_backup');
      await jest.advanceTimersByTimeAsync(1);
      expect(env.svc.getStatus(zid)).toEqual(expect.objectContaining({ stage: 'failed', error: 'Hết thời gian chờ điện thoại gửi dữ liệu' }));
    });

    test('rejectBeforePullResponseStaysCancelledWithOneTerminalEmit', async () => {
      const env = setup();
      const zid = nextZalo();
      const { api, pull, started } = await startPending(env, zid);
      api.send('user_confirm', { user_action: 0 });
      pull.resolve();
      const res = await started;
      expect(res.success).toBe(false);
      expect(res.status!.stage).toBe('cancelled');
      await jest.advanceTimersByTimeAsync(200_000);
      expect(env.svc.getStatus(zid)!.stage).toBe('cancelled');
      expect(terminalCount(env, zid)).toBe(1);
      expect(stagesOf(env, zid)).toEqual(['requesting', 'cancelled']);
    });

    test('pullMobileRejectionAfterImportStartedIsIgnored', async () => {
      const env = setup();
      const zid = nextZalo();
      const { api, pull, started } = await startPending(env, zid);
      sendBackupInfo(env, api, zid, defaultFiles()); // syncmsg_info tới trước phản hồi
      pull.reject(new Error('socket hang up'));
      const res = await started;
      expect(res.success).toBe(true);
      const final = await finished(env, zid);
      expect(final.stage).toBe('completed');
      expect(final.stats!.messagesImported).toBe(6);
      expect(env.emitted.some(s => s.stage === 'failed')).toBe(false);
      expect(terminalCount(env, zid)).toBe(1);
      expect(env.snaps).toEqual([{ stage: 'completed', keyBlank: true, workDirs: [] }]);
    });

    test('pullMobileResponseAfterImportStartedNeverGoesBackToWaitingConfirm', async () => {
      const env = setup();
      const zid = nextZalo();
      const { api, pull, started } = await startPending(env, zid);
      sendBackupInfo(env, api, zid, defaultFiles());
      pull.resolve();
      expect((await started).success).toBe(true);
      expect((await finished(env, zid)).stage).toBe('completed');
      expect(stagesOf(env, zid)).not.toContain('waiting_confirm');
      expect(stagesOf(env, zid)).toEqual(['requesting', 'downloading', 'decrypting', 'resolving_ids', 'importing', 'completed']);
    });

    // Fix 3: làm mới hồ sơ nhắm đúng các hội thoại vừa nhập
    test('importedNamelessConversationsGetNamesEvenWithMoreRecentNamelessContacts', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      for (let i = 0; i < 5; i++) {
        db.run('INSERT INTO contacts (owner_zalo_id, contact_id, display_name, contact_type, channel, last_message_time) VALUES (?,?,?,?,?,?)',
          [zid, String(810000000 + i), '', 'user', 'zalo', 9_000_000_000_000 + i]);
      }
      api.getUserInfo.mockImplementation(async (ids: string[]) => ({
        changed_profiles: Object.fromEntries(ids.map(id => [id, { displayName: `Ten ${id}` }])),
      }));
      const final = await runFull(env, zid, api, [{ name: `${PEER}.db`, rows: [row(), row()] }]);
      expect(final.stage).toBe('completed');
      expect(api.getUserInfo.mock.calls.flatMap((c: any[]) => c[0])).toEqual([noiseOf(PEER)]);
      expect(db.queryOne<any>('SELECT display_name FROM contacts WHERE owner_zalo_id=? AND contact_id=?', [zid, noiseOf(PEER)])!.display_name).toBe(`Ten ${noiseOf(PEER)}`);
    });

    // Fix 4: thông báo lỗi tiếng Việt
    test('diskFullDuringDownloadHasAVietnameseMessage', async () => {
      const env = setup();
      const zid = nextZalo();
      env.download.mockImplementationOnce(async () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); });
      const final = await runFull(env, zid, connect(env, zid));
      expect(final).toEqual(expect.objectContaining({ stage: 'failed', error: 'Không đủ dung lượng đĩa để tải hoặc giải nén bản sao lưu' }));
      expect(env.snaps).toEqual([{ stage: 'failed', keyBlank: true, workDirs: [] }]);
    });

    test('fatalDbErrorHasAVietnameseMessageWithTheTechnicalReason', async () => {
      const env = setup();
      const zid = nextZalo();
      const spy = jest.spyOn(db, 'saveHistoryMessagesBulk').mockImplementation(() => { throw new Error('SQLITE_FULL: database or disk is full'); });
      try {
        const final = await runFull(env, zid, connect(env, zid));
        expect(final.error).toBe('Không ghi được tin nhắn vào cơ sở dữ liệu (SQLITE_FULL: database or disk is full)');
        expect(final.error).not.toContain('noi dung');
      } finally {
        spy.mockRestore();
      }
    });

    // Fix 5: file sao lưu độc hại
    test('chatContentThatIsAViewIsRejectedAsUnreadable', async () => {
      const env = setup();
      const zid = nextZalo();
      const viewFile = path.join(scratch, `view${++seq}.db`);
      const Sqlite = require('better-sqlite3');
      const tmp = new Sqlite(viewFile);
      tmp.exec(`CREATE TABLE real_rows (SenderId INTEGER, CliMsgId INTEGER, GlbMsgId INTEGER, MsgType INTEGER, TimeStamp INTEGER, TTL INTEGER, MsgContent TEXT, BinNet BLOB, MsgStatus INTEGER);
        INSERT INTO real_rows VALUES (${PEER}, 1, 2, 0, ${T}, 0, 'x', NULL, 1);
        CREATE VIEW ChatContent AS SELECT * FROM real_rows;`);
      tmp.close();
      const files: BackupFile[] = [
        { name: `${PEER}.db`, rows: [], raw: fs.readFileSync(viewFile) },
        { name: `group_${G1}.db`, rows: [row(), row()] },
      ];
      const final = await runFull(env, zid, connect(env, zid), files);
      expect(final.stage).toBe('completed');
      expect(final.stats).toEqual(expect.objectContaining({ conversationsFailed: 1, messagesImported: 2 }));
      expect(msgCount(zid, noiseOf(PEER))).toBe(0);
      expect(msgCount(zid, groupNoiseOf(G1))).toBe(2);
    });

    test('longRunOfSkippedRowsYieldsAndHonoursCancel', async () => {
      const env = setup();
      const zid = nextZalo();
      const api = connect(env, zid);
      const orig = (env.svc as any).yieldToEventLoop.bind(env.svc);
      const yieldSpy = jest.spyOn(env.svc as any, 'yieldToEventLoop').mockImplementation((async (session: any) => {
        if (yieldSpy.mock.calls.length === 2) void env.svc.cancel(zid);
        return orig(session);
      }) as any);
      const rows = Array.from({ length: 2500 }, () => row({ MsgType: 1 })); // loại không có trong bảng → bị bỏ qua, không bao giờ đầy một lô
      const final = await runFull(env, zid, api, [{ name: `${PEER}.db`, rows }]);
      expect(yieldSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(final).toEqual(expect.objectContaining({ stage: 'cancelled' }));
      expect(final.stats!.messagesRead).toBe(2000);
      expect(msgCount(zid)).toBe(0);
    });

    test('skippedRowsAloneYieldTwiceForTwoAndAHalfThousandRows', async () => {
      const env = setup();
      const zid = nextZalo();
      const yieldSpy = jest.spyOn(env.svc as any, 'yieldToEventLoop');
      const rows = Array.from({ length: 2500 }, () => row({ MsgType: 1 }));
      const final = await runFull(env, zid, connect(env, zid), [{ name: `${PEER}.db`, rows }]);
      expect(final.stage).toBe('completed');
      expect(final.stats).toEqual(expect.objectContaining({ messagesRead: 2500, messagesSkipped: 2500, messagesImported: 0 }));
      expect(yieldSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    // Fix 6: khoá AES được xoá
    test('aesKeyBufferIsZeroedAfterTheRun', async () => {
      const env = setup();
      const zid = nextZalo();
      const zdb = require('../../services/zalo/mobileSync/zdbBackup');
      const captured: Buffer[] = [];
      const real = zdb.decryptBackupKey;
      const spy = jest.spyOn(zdb, 'decryptBackupKey').mockImplementation(((...a: any[]) => {
        const key: Buffer = real(...a);
        captured.push(key);
        return key;
      }) as any);
      try {
        const final = await runFull(env, zid, connect(env, zid));
        expect(final.stage).toBe('completed');
        expect(captured).toHaveLength(1);
        expect(captured[0].length).toBeGreaterThan(0);
        expect(captured[0].every(b => b === 0)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    // Follow-up 1: huỷ muộn chỉ khi điện thoại CHƯA từng trả lời phiên này
    test('lateCancelIsSkippedWhenThePhoneAlreadyAnsweredWithSyncmsgInfo', async () => {
      const env = setup();
      const zid = nextZalo();
      const { api, pull, started } = await startPending(env, zid);
      sendBackupInfo(env, api, zid, defaultFiles());
      expect((await finished(env, zid)).stage).toBe('completed');
      pull.resolve();
      await started;
      await jest.advanceTimersByTimeAsync(0);
      expect(api.cancelPullMobile).not.toHaveBeenCalled();
    });

    test('lateCancelIsSkippedWhenThePhoneAlreadyRejected', async () => {
      const env = setup();
      const zid = nextZalo();
      const { api, pull } = await startPending(env, zid);
      api.send('user_confirm', { user_action: 0 });
      pull.resolve();
      await jest.advanceTimersByTimeAsync(0);
      expect(env.svc.getStatus(zid)!.stage).toBe('cancelled');
      expect(api.cancelPullMobile).not.toHaveBeenCalled();
    });

    test('foreignPublicKeyDoesNotCountAsAnAnswer', async () => {
      const env = setup();
      const zid = nextZalo();
      const { api, pull, started } = await startPending(env, zid);
      api.send('user_confirm', { user_action: 1, public_key: 'someone-else' });
      await env.svc.cancel(zid);
      await started;
      expect(api.cancelPullMobile).toHaveBeenCalledTimes(1);
      pull.resolve();
      await jest.advanceTimersByTimeAsync(0);
      expect(api.cancelPullMobile).toHaveBeenCalledTimes(2);
    });

    // Follow-up 3: tên bảng không phân biệt hoa thường
    test.each(['chatcontent', 'CHATCONTENT'])('viewNamed_%s_isRejectedAsUnreadable', async (viewName) => {
      const env = setup();
      const zid = nextZalo();
      const viewFile = path.join(scratch, `view${++seq}.db`);
      const Sqlite = require('better-sqlite3');
      const tmp = new Sqlite(viewFile);
      tmp.exec(`CREATE TABLE real_rows (SenderId INTEGER, CliMsgId INTEGER, GlbMsgId INTEGER, MsgType INTEGER, TimeStamp INTEGER, TTL INTEGER, MsgContent TEXT, BinNet BLOB, MsgStatus INTEGER);
        INSERT INTO real_rows VALUES (${PEER}, 1, 2, 0, ${T}, 0, 'x', NULL, 1);
        CREATE VIEW ${viewName} AS SELECT * FROM real_rows;`);
      tmp.close();
      const files: BackupFile[] = [
        { name: `${PEER}.db`, rows: [], raw: fs.readFileSync(viewFile) },
        { name: `group_${G1}.db`, rows: [row(), row()] },
      ];
      const final = await runFull(env, zid, connect(env, zid), files);
      expect(final.stage).toBe('completed');
      expect(final.stats).toEqual(expect.objectContaining({ conversationsFailed: 1, messagesImported: 2 }));
      expect(msgCount(zid, noiseOf(PEER))).toBe(0);
    });
  });
});
