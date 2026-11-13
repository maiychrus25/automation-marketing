// Tích hợp đầu-cuối: MobileSyncService thật + giải nén thật + converter thật + DatabaseService thật trên DB tạm.
// Chỉ api Zalo, hàm tải file (chép file giả) và đồng hồ là giả.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-mobilesync-it-'));
const activePath = path.join(tmpDir, 'active.db');
const bossPath = path.join(tmpDir, 'boss.db');

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
      getActiveWorkspaceId: () => 'default',
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

import DatabaseService from '../../services/database/DatabaseService';
import MobileSyncService, { MOBILE_SYNC_EVENT } from '../../services/zalo/mobileSync/MobileSyncService';
import type { MobileSyncStatus } from '../../services/zalo/mobileSync/types';
import { buildZdbBackup } from './helpers/zdbFixture';
import { createChatContentDb, ChatContentFixtureRow } from './helpers/chatContentFixture';

const T = 1_700_000_000_000;
const ZID = '900000777';
const OWN_PLAIN = '100000001';
const OWN_NOISE = '8100000001';
const P1 = '200000002';
const P2 = '200000003';
const SENDER2 = '300000003';
const G1 = '400000004';
const UNK = '500000005';
const BAD = '600000006';
const noiseOf = (p: string) => '9' + p;
const groupNoiseOf = (p: string) => '7' + p;
const TYPE_UNDO = 36;
const TERMINAL = ['completed', 'failed', 'cancelled'];

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-mobilesync-it-fx-'));
const workRoot = path.join(scratch, 'work');
let fileSeq = 0;
const sqlite = (rows: ChatContentFixtureRow[]): Buffer => {
  const file = path.join(scratch, `b${++fileSeq}.db`);
  createChatContentDb(file, rows);
  return fs.readFileSync(file);
};
const hrow = (o: Partial<ChatContentFixtureRow> & Pick<ChatContentFixtureRow, 'CliMsgId' | 'GlbMsgId' | 'TimeStamp'>): ChatContentFixtureRow =>
  ({ SenderId: P1, MsgType: 0, MsgContent: `nd ${o.CliMsgId}`, ...o });

// Id thật/cliMsgId của các tin (chuỗi số, giống Zalo)
const R1 = '9100000001', C1 = '7100000001';
const R2 = '9100000002', C2 = '7100000002';
const C9 = '7100000009', R9 = '9100000009';

const files: Array<{ name: string; data: Buffer }> = [
  { name: `${P1}.db`, data: sqlite([
    hrow({ CliMsgId: C1, GlbMsgId: R1, TimeStamp: T + 1000 }), // trùng tin trực tiếp → bỏ qua
    hrow({ SenderId: OWN_PLAIN, CliMsgId: C2, GlbMsgId: 0, TimeStamp: T + 2000 }), // mb_C2, đã có dòng thật → bỏ qua
    hrow({ CliMsgId: '7100000011', GlbMsgId: '9100000011', TimeStamp: T - 3000 }),
    hrow({ SenderId: OWN_PLAIN, CliMsgId: '7100000012', GlbMsgId: '9100000012', TimeStamp: T - 2000 }),
    hrow({ CliMsgId: '7100000013', GlbMsgId: '9100000013', TimeStamp: T - 1000 }),
    hrow({ CliMsgId: '7100000014', GlbMsgId: '9100000014', TimeStamp: T - 500, MsgType: TYPE_UNDO }),
    hrow({ SenderId: OWN_PLAIN, CliMsgId: C9, GlbMsgId: 0, TimeStamp: T - 400 }), // chỉ có trong lịch sử → mb_C9
    hrow({ CliMsgId: '7100000015', GlbMsgId: '9100000015', TimeStamp: T - 100_000 }), // ngoài khoảng
  ]) },
  { name: `${P2}.db`, data: sqlite([hrow({ SenderId: P2, CliMsgId: '7200000001', GlbMsgId: '9200000001', TimeStamp: T - 800 })]) },
  { name: `group_${G1}.db`, data: sqlite([
    hrow({ SenderId: SENDER2, CliMsgId: '7300000001', GlbMsgId: '9300000001', TimeStamp: T - 700 }),
    hrow({ SenderId: OWN_PLAIN, CliMsgId: '7300000002', GlbMsgId: '9300000002', TimeStamp: T - 600 }),
  ]) },
  { name: `${UNK}.db`, data: sqlite([hrow({ SenderId: UNK, CliMsgId: '7400000001', GlbMsgId: '9400000001', TimeStamp: T - 300 })]) },
  { name: `${BAD}.db`, data: Buffer.from('this is not a sqlite file at all, just text'.repeat(20)) },
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
    getNoisedIds: jest.fn(async ({ uids, gids }: { uids: string[]; gids: string[] }) => ({
      uids: uids.map(p => (p === UNK ? '' : noiseOf(p))), gids: gids.map(groupNoiseOf),
    })),
    getUserInfo: jest.fn(async () => ({})),
    getGroupInfo: jest.fn(async () => ({})),
    send(type: string, data: any) {
      const key = api.pullMobile.mock.calls[api.pullMobile.mock.calls.length - 1][0].public_key;
      for (const h of Array.from(handlers)) h({ type, data: { public_key: key, ...data } });
    },
  };
  return api;
}

const emitted: MobileSyncStatus[] = [];
const backups = new Map<string, Buffer>();
const api = makeApi();
const svc = new MobileSyncService({
  getConnectedApi: () => api,
  workRoot: () => workRoot,
  download: jest.fn(async (url: string, dest: string) => {
    const buf = backups.get(url)!;
    fs.writeFileSync(dest, buf);
    return { bytes: buf.length };
  }) as any,
  emit: (channel: string, status: MobileSyncStatus) => {
    expect(channel).toBe(MOBILE_SYNC_EVENT);
    emitted.push({ ...status });
  },
});

const tick = () => new Promise<void>(r => setImmediate(r));
async function runSession(range: { fromTs: number | null; toTs: number | null }, run: number): Promise<MobileSyncStatus> {
  const before = emitted.length;
  expect((await svc.start(ZID, range)).success).toBe(true);
  api.send('user_confirm', { user_action: 1 });
  // điện thoại giả: mã hoá khoá AES bằng khoá công khai phiên đã gửi
  const publicKey = api.pullMobile.mock.calls[api.pullMobile.mock.calls.length - 1][0].public_key as string;
  const raw = crypto.randomBytes(16);
  const aesKey = Buffer.from(raw.toString('hex').toUpperCase(), 'ascii');
  const pub = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
  const url = `https://f.zdn.vn/run${run}?token=SECRETTOKEN`;
  backups.set(url, buildZdbBackup(files, aesKey));
  api.send('syncmsg_info', {
    uid: OWN_PLAIN, url, file_size: 1,
    encrypted_key: crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_PADDING }, raw).toString('base64'),
    db_info: JSON.stringify({ db_format: 1, backup_db: { msg_total: 14 } }),
  });
  for (let i = 0; i < 4000; i++) {
    const last = emitted[emitted.length - 1];
    if (emitted.length > before && last && TERMINAL.includes(last.stage)) return last;
    await jest.advanceTimersByTimeAsync(250);
    await tick();
  }
  throw new Error('session did not finish');
}

describe('mobile sync end to end', () => {
  const db = DatabaseService.getInstance();
  const q = <T>(sql: string, params: any[] = []) => db.query<T>(sql, params);
  const rowsOf = (thread: string) => q<any>('SELECT * FROM messages WHERE owner_zalo_id=? AND thread_id=? ORDER BY timestamp, id', [ZID, thread]);
  const unreadOf = () => q<any>('SELECT contact_id, unread_count, last_message_time FROM contacts WHERE owner_zalo_id=? ORDER BY contact_id', [ZID]);
  const dump = () => q<any>('SELECT * FROM messages WHERE owner_zalo_id=? ORDER BY id', [ZID]);
  const realtime = (threadId: string, over: any) => db.saveMessage(ZID, {
    type: 0, isSelf: false, threadId, ...over, data: { msgType: 'webchat', ...over.data },
  });

  beforeAll(async () => {
    await db.initialize();
    db.forceFlush();
    fs.copyFileSync(activePath, bossPath);
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    svc.attachToApi(ZID, api);
  });
  afterAll(() => {
    jest.useRealTimers();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test('importsOnceAndStaysIdempotent', async () => {
    // 1. tin trực tiếp có sẵn
    const p1 = noiseOf(P1), p2 = noiseOf(P2);
    await realtime(p1, { data: { msgId: R1, cliMsgId: C1, uidFrom: p1, ts: String(T + 1000), content: 'peer' } });
    await realtime(p1, { isSelf: true, data: { msgId: R2, cliMsgId: C2, uidFrom: OWN_NOISE, idTo: p1, ts: String(T + 2000), content: 'own' } });
    await realtime(p2, { data: { msgId: 'U1', cliMsgId: 'u1', uidFrom: p2, ts: String(T + 3000), content: 'chua doc 1' } });
    await realtime(p2, { data: { msgId: 'U2', cliMsgId: 'u2', uidFrom: p2, ts: String(T + 4000), content: 'chua doc 2' } });
    const unreadBefore = unreadOf();
    expect(unreadBefore.find(c => c.contact_id === p2)!.unread_count).toBe(2);
    expect(rowsOf(p1)).toHaveLength(2);

    // 2-3. phiên đầu
    const range = { fromTs: T - 10_000, toTs: null };
    const final = await runSession(range, 1);
    expect(final.stage).toBe('completed');
    expect(final.progress).toBe(100);
    expect(final.stats).toEqual(expect.objectContaining({
      conversations: 5, conversationsResolved: 4, conversationsUnresolved: 1, conversationsFailed: 1,
      messagesRead: 10, messagesImported: 8, messagesSkipped: 2, messagesOutOfRange: 1,
    }));

    const p1Rows = rowsOf(p1);
    expect(p1Rows).toHaveLength(7); // 2 trực tiếp + 5 mới (3 cũ, 1 thu hồi, mb_C9)
    expect(rowsOf(p2)).toHaveLength(3);
    expect(rowsOf(groupNoiseOf(G1))).toHaveLength(2);
    expect(rowsOf(noiseOf(UNK))).toHaveLength(0);
    expect(rowsOf(noiseOf(BAD))).toHaveLength(0);
    expect(rowsOf(UNK)).toHaveLength(0);
    expect(rowsOf(BAD)).toHaveLength(0);
    expect(q('SELECT * FROM messages WHERE owner_zalo_id=? AND timestamp < ?', [ZID, T - 10_000])).toHaveLength(0);

    // không trùng
    expect(q<any>('SELECT msg_id, COUNT(*) AS n FROM messages WHERE owner_zalo_id=? GROUP BY msg_id HAVING n > 1', [ZID])).toEqual([]);
    expect(q<any>(`SELECT 1 FROM messages WHERE owner_zalo_id=? AND cli_msg_id IS NOT NULL
      GROUP BY thread_id, sender_id, cli_msg_id HAVING COUNT(*) > 1`, [ZID])).toEqual([]);

    // ba tin cũ đúng hội thoại, người gửi, is_sent
    const byMsg = (id: string) => p1Rows.find(r => r.msg_id === id);
    expect(byMsg('9100000011')).toMatchObject({ sender_id: p1, is_sent: 0, timestamp: T - 3000, is_recalled: 0 });
    expect(byMsg('9100000012')).toMatchObject({ sender_id: OWN_NOISE, is_sent: 1, timestamp: T - 2000 });
    expect(byMsg('9100000013')).toMatchObject({ sender_id: p1, is_sent: 0, timestamp: T - 1000 });
    expect(byMsg('9100000014')).toMatchObject({ is_recalled: 1 });
    expect(byMsg(`mb_${C9}`)).toMatchObject({ sender_id: OWN_NOISE, is_sent: 1, cli_msg_id: C9 });
    expect(byMsg(`mb_${C2}`)).toBeUndefined();
    expect(byMsg(R1)!.content).toBe('peer');
    expect(byMsg(R2)!.content).toBe('own');

    // nhóm: dòng contacts loại nhóm, hai người gửi (kể cả chính mình)
    expect(q<any>('SELECT contact_type FROM contacts WHERE owner_zalo_id=? AND contact_id=?', [ZID, groupNoiseOf(G1)])).toEqual([{ contact_type: 'group' }]);
    const groupRows = rowsOf(groupNoiseOf(G1));
    expect(groupRows.map(r => r.sender_id).sort()).toEqual([noiseOf(SENDER2), OWN_NOISE].sort());
    expect(groupRows.find(r => r.sender_id === OWN_NOISE)!.is_sent).toBe(1);

    // chưa đọc không đổi, xem trước không lùi
    const unreadAfter = unreadOf();
    for (const b of unreadBefore) {
      const a = unreadAfter.find(c => c.contact_id === b.contact_id)!;
      expect(a.unread_count).toBe(b.unread_count);
      expect(a.last_message_time).toBeGreaterThanOrEqual(b.last_message_time);
    }

    // thư mục làm việc đã dọn, đúng một trạng thái cuối
    expect(fs.existsSync(path.join(workRoot, ZID)) ? fs.readdirSync(path.join(workRoot, ZID)) : []).toEqual([]);
    expect(emitted.filter(s => TERMINAL.includes(s.stage))).toHaveLength(1);

    // 4. phiên hai cùng bản sao lưu
    const snapshot = dump();
    const second = await runSession(range, 2);
    expect(second.stage).toBe('completed');
    expect(second.stats!.messagesImported).toBe(0);
    expect(dump()).toEqual(snapshot);
    expect(emitted.filter(s => TERMINAL.includes(s.stage))).toHaveLength(2);

    // 5. tin trực tiếp thật đến cho dòng mb_C9 → vẫn một dòng, nâng lên id thật
    const unreadMid = unreadOf();
    await realtime(p1, { isSelf: true, data: { msgId: R9, cliMsgId: C9, uidFrom: OWN_NOISE, idTo: p1, ts: String(T - 400 + 50), content: 'own late' } });
    const withC9 = rowsOf(p1).filter(r => r.cli_msg_id === C9);
    expect(withC9).toHaveLength(1);
    expect(withC9[0].msg_id).toBe(R9);
    expect(rowsOf(p1)).toHaveLength(7);
    expect(unreadOf()).toEqual(unreadMid);
  });
});
