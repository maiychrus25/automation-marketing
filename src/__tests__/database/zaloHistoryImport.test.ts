import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-zalo-hist-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));

jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
import DatabaseService from '../../services/database/DatabaseService';

const T = 1_700_000_000_000;

describe('realtime saveMessage output (characterization)', () => {
  const service = DatabaseService.getInstance();
  beforeAll(async () => { await service.initialize(); });
  afterAll(() => { service.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('realtimeSaveUnchanged', async () => {
    const O = 'ownerR';
    const mk = (over: any) => ({ type: 0, isSelf: false, threadId: 'u1', ...over, data: { uidFrom: 'u1', msgType: 'webchat', ...over.data } });
    await service.saveMessage(O, mk({ data: { msgId: 'm1', cliMsgId: 'c1', ts: String(T), content: 'xin chao' } }));
    await service.saveMessage(O, mk({ data: { msgId: 'm2', cliMsgId: 'c2', ts: String(T + 1000), msgType: 'chat.photo', content: { href: 'http://x/y.jpg', title: 'cap' } } }));
    await service.saveMessage(O, mk({ data: {
      msgId: 'm3', cliMsgId: 'c3', ts: String(T + 2000), content: 'tra loi',
      quote: { globalMsgId: 'm1', cliMsgId: 'c1', msg: 'xin chao', fromD: 'A', ownerId: 'u1', cliMsgType: 1, attach: '' },
    } }));
    await service.saveMessage(O, { type: 1, isSelf: false, threadId: 'g1', data: { msgId: 'm4', cliMsgId: 'c4', uidFrom: 'u2', msgType: 'webchat', ts: String(T + 3000), content: 'nhom' } });
    await service.saveMessage(O, { type: 0, isSelf: true, threadId: 'u1', data: { msgId: 'm5', cliMsgId: 'c5', uidFrom: '0', idTo: 'u1', msgType: 'webchat', ts: String(T + 4000), content: 'minh gui' } });
    await service.saveMessage(O, mk({ data: { msgId: 'm6', ts: String(T + 5000), message: 'fallback' } }));

    const msgs = service.query<any>('SELECT * FROM messages WHERE owner_zalo_id=? ORDER BY id', [O]).map(({ id, ...r }) => r);
    const base = {
      owner_zalo_id: O, thread_type: 0, sender_id: 'u1', msg_type: 'webchat', is_sent: 0, attachments: '[]', local_paths: '{}',
      status: 'received', is_recalled: 0, quote_data: null, reactions: '{}', recalled_content: null, deleted_by: null,
      reply_to_id: null, edit_history: null, is_edited: 0, channel: 'zalo', topic_id: null, handled_by_employee: null,
    };
    expect(msgs).toEqual([
      { ...base, msg_id: 'm1', cli_msg_id: 'c1', thread_id: 'u1', content: 'xin chao', timestamp: T },
      { ...base, msg_id: 'm2', cli_msg_id: 'c2', thread_id: 'u1', content: '{"href":"http://x/y.jpg","title":"cap"}', msg_type: 'chat.photo', timestamp: T + 1000 },
      { ...base, msg_id: 'm3', cli_msg_id: 'c3', thread_id: 'u1', content: 'tra loi', timestamp: T + 2000,
        quote_data: '{"msg":"xin chao","fromD":"A","attach":"","msgType":"webchat","msgId":"m1","cliMsgId":"c1","ownerId":"u1","imageUrl":""}' },
      { ...base, msg_id: 'm4', cli_msg_id: 'c4', thread_id: 'g1', thread_type: 1, sender_id: 'u2', content: 'nhom', timestamp: T + 3000 },
      { ...base, msg_id: 'm5', cli_msg_id: 'c5', thread_id: 'u1', sender_id: '0', is_sent: 1, content: 'minh gui', timestamp: T + 4000 },
      { ...base, msg_id: 'm6', cli_msg_id: null, thread_id: 'u1', content: 'fallback', timestamp: T + 5000 },
    ]);

    const contacts = service.query<any>(
      'SELECT contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel FROM contacts WHERE owner_zalo_id=? ORDER BY contact_id', [O]);
    const cbase = { display_name: '', avatar_url: '', is_friend: 0, channel: 'zalo' };
    expect(contacts).toEqual([
      { ...cbase, contact_id: 'g1', display_name: 'g1', contact_type: 'group', unread_count: 1, last_message: 'nhom', last_message_time: T + 3000 },
      { ...cbase, contact_id: 'u1', display_name: 'u1', contact_type: 'user', unread_count: 4, last_message: 'fallback', last_message_time: T + 5000 },
    ]);
  });
});

const OWNER = 'ownerH';
type HistOver = { msgId?: string; cli?: string | null; thread?: string; from?: string; ts?: number; content?: any; type?: 0 | 1; self?: boolean; recalled?: boolean; msgType?: string };
const hist = (o: HistOver = {}) => ({
  type: o.type ?? 0,
  threadId: o.thread ?? 'th1',
  isSelf: o.self ?? false,
  ...(o.recalled ? { isRecalled: true } : {}),
  data: {
    msgId: o.msgId ?? 'h1',
    cliMsgId: o.cli === undefined ? 'cl1' : o.cli,
    uidFrom: o.from ?? 'peer1',
    idTo: 'x',
    msgType: o.msgType ?? 'webchat',
    ts: String(o.ts ?? T),
    content: o.content ?? 'hello',
  },
});

describe('Zalo phone history import', () => {
  const service = DatabaseService.getInstance();
  const rows = (thread: string, owner = OWNER) =>
    service.query<any>('SELECT * FROM messages WHERE owner_zalo_id=? AND thread_id=? ORDER BY id', [owner, thread]);
  const contact = (thread: string, owner = OWNER) =>
    service.queryOne<any>('SELECT * FROM contacts WHERE owner_zalo_id=? AND contact_id=?', [owner, thread]);
  let n = 0;
  const fresh = () => `t${++n}`; // each test gets its own thread so tests stay independent

  beforeAll(async () => { await service.initialize(); });
  afterAll(() => { service.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('isSyntheticZaloMsgId', () => {
    expect(DatabaseService.isSyntheticZaloMsgId('mb_1')).toBe(true);
    expect(DatabaseService.isSyntheticZaloMsgId('cli_1')).toBe(true);
    expect(DatabaseService.isSyntheticZaloMsgId('123')).toBe(false);
    expect(DatabaseService.isSyntheticZaloMsgId(undefined)).toBe(false);
    expect(DatabaseService.isSyntheticZaloMsgId('')).toBe(false);
  });

  test('bulkInsertsAndCounts', () => {
    const th = fresh();
    const r = service.saveHistoryMessagesBulk(OWNER, [1, 2, 3].map(i => hist({ thread: th, msgId: `bi${th}${i}`, cli: `bc${th}${i}`, ts: T + i })));
    expect(r).toEqual({ inserted: 3, upgraded: 0, skipped: 0, threads: [th] });
    expect(rows(th)).toHaveLength(3);
  });

  test('bulkIsIdempotent', () => {
    const th = fresh();
    const batch = () => [1, 2, 3].map(i => hist({ thread: th, msgId: `id${th}${i}`, cli: `ic${th}${i}`, ts: T + i }));
    service.saveHistoryMessagesBulk(OWNER, batch());
    const before = rows(th);
    const r = service.saveHistoryMessagesBulk(OWNER, batch());
    expect(r).toMatchObject({ inserted: 0, upgraded: 0, skipped: 3 });
    expect(rows(th)).toEqual(before);
  });

  test('bulkSkipsSameCliUnderOtherRealId', async () => {
    const th = fresh();
    await service.saveMessage(OWNER, hist({ thread: th, msgId: 'realA', cli: `sk${th}` }));
    const r = service.saveHistoryMessagesBulk(OWNER, [hist({ thread: th, msgId: 'realB', cli: `sk${th}` })]);
    expect(r).toMatchObject({ inserted: 0, upgraded: 0, skipped: 1 });
    expect(rows(th).map(x => x.msg_id)).toEqual(['realA']);
  });

  test('bulkUpgradesSyntheticRow', () => {
    const th = fresh(); const cli = `up${th}`;
    service.saveHistoryMessagesBulk(OWNER, [hist({ thread: th, msgId: `mb_${cli}`, cli, ts: T })]);
    service.run('UPDATE messages SET local_paths=?, status=?, reactions=? WHERE owner_zalo_id=? AND thread_id=?', ['{"a":"/x"}', 'read', '{"total":1}', OWNER, th]);
    const r = service.saveHistoryMessagesBulk(OWNER, [hist({ thread: th, msgId: 'realUp', cli, ts: T + 777 })]);
    expect(r).toMatchObject({ inserted: 0, upgraded: 1, skipped: 0, threads: [th] });
    const got = rows(th);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ msg_id: 'realUp', timestamp: T + 777, local_paths: '{"a":"/x"}', status: 'read', reactions: '{"total":1}' });
  });

  test('realtimeAfterHistoryUpgrades', async () => {
    const th = fresh(); const cli = `ra${th}`;
    service.saveHistoryMessagesBulk(OWNER, [hist({ thread: th, msgId: `mb_${cli}`, cli, ts: T })]);
    service.run('UPDATE messages SET local_paths=? WHERE owner_zalo_id=? AND thread_id=?', ['{"k":"/p"}', OWNER, th]);
    await service.saveMessage(OWNER, hist({ thread: th, msgId: 'realRA', cli, ts: T + 5 }));
    const got = rows(th);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ msg_id: 'realRA', timestamp: T + 5, local_paths: '{"k":"/p"}' });
  });

  test('realtimeUpgradeDoesNotCountUnreadAgain', async () => {
    const th = fresh(); const cli = `ru${th}`;
    service.saveHistoryMessagesBulk(OWNER, [hist({ thread: th, msgId: `mb_${cli}`, cli })]);
    await service.saveMessage(OWNER, hist({ thread: th, msgId: 'realRU', cli }));
    expect(contact(th).unread_count).toBe(0);
  });

  test('realtimeUpgradeFallsBackWhenRealIdExists', async () => {
    const th = fresh(); const cli = `rf${th}`;
    service.saveHistoryMessagesBulk(OWNER, [hist({ thread: th, msgId: `mb_${cli}`, cli })]);
    service.run('INSERT INTO messages (msg_id, cli_msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, timestamp) VALUES (?,?,?,?,0,?,?,?)', ['realRF', `other${th}`, OWNER, th, 'peer1', 'z', T]);
    await expect(service.saveMessage(OWNER, hist({ thread: th, msgId: 'realRF', cli }))).resolves.toBeUndefined();
    expect(rows(th).map(x => x.msg_id).sort()).toEqual([`mb_${cli}`, 'realRF']);
  });

  test('bulkNeverIncrementsUnread', () => {
    const th = fresh();
    service.saveHistoryMessagesBulk(OWNER, [hist({ thread: th, msgId: `nu${th}1`, cli: `nu${th}1`, from: 'peer1' })]);
    service.run('UPDATE contacts SET unread_count=3 WHERE owner_zalo_id=? AND contact_id=?', [OWNER, th]);
    service.saveHistoryMessagesBulk(OWNER, [hist({ thread: th, msgId: `nu${th}2`, cli: `nu${th}2`, from: 'peer1', ts: T + 9 })]);
    expect(contact(th).unread_count).toBe(3);
  });

  test('previewOnlyMovesForward', () => {
    const th = fresh();
    service.saveHistoryMessagesBulk(OWNER, [hist({ thread: th, msgId: `pf${th}1`, cli: `pf${th}1`, ts: T + 100, content: 'newer' })]);
    service.saveHistoryMessagesBulk(OWNER, [hist({ thread: th, msgId: `pf${th}2`, cli: `pf${th}2`, ts: T + 10, content: 'older' })]);
    expect(contact(th)).toMatchObject({ last_message: 'newer', last_message_time: T + 100 });
    service.saveHistoryMessagesBulk(OWNER, [
      hist({ thread: th, msgId: `pf${th}3`, cli: `pf${th}3`, ts: T + 200, content: 'newest' }),
      hist({ thread: th, msgId: `pf${th}4`, cli: `pf${th}4`, ts: T + 300, content: 'gone', recalled: true }),
    ]);
    expect(contact(th)).toMatchObject({ last_message: 'newest', last_message_time: T + 200 });
  });

  test('recalledImported', () => {
    const th = fresh();
    service.saveHistoryMessagesBulk(OWNER, [hist({ thread: th, msgId: `rc${th}`, cli: `rc${th}`, content: 'secret', recalled: true })]);
    expect(rows(th)[0]).toMatchObject({
      is_recalled: 1, msg_type: 'recalled',
      content: JSON.stringify({ msg: 'Tin nhắn đã bị thu hồi' }), recalled_content: 'secret',
    });
  });

  test('createsContactForUnknownThread', () => {
    const user = fresh(); const group = fresh();
    service.saveHistoryMessagesBulk(OWNER, [hist({ thread: user, msgId: `cu${user}`, cli: `cu${user}` })]);
    service.saveHistoryMessagesBulk(OWNER, [hist({ thread: group, type: 1, msgId: `cg${group}`, cli: `cg${group}` })]);
    expect(contact(user)).toMatchObject({ contact_type: 'user', unread_count: 0, display_name: user });
    expect(contact(group)).toMatchObject({ contact_type: 'group', unread_count: 0, display_name: group });
  });

  test('otherChannelNotTouched', () => {
    const th = fresh(); const cli = `oc${th}`;
    service.run('INSERT INTO messages (msg_id, cli_msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, timestamp, channel) VALUES (?,?,?,?,0,?,?,?,?)', [`mb_${cli}`, cli, OWNER, th, 'peer1', 'fb', T, 'facebook']);
    const r = service.saveHistoryMessagesBulk(OWNER, [hist({ thread: th, msgId: 'realOC', cli })]);
    expect(r).toMatchObject({ inserted: 1, upgraded: 0 });
    expect(rows(th).map(x => [x.msg_id, x.channel])).toEqual([[`mb_${cli}`, 'facebook'], ['realOC', 'zalo']]);
  });

  test('plainIdMapRoundTrip', () => {
    service.savePlainIdMap(OWNER, 'user', [['p1', 'n1'], ['p2', 'n2']]);
    service.savePlainIdMap(OWNER, 'group', [['p1', 'g1']]);
    service.savePlainIdMap('otherOwner', 'user', [['p1', 'zz']]);
    expect([...service.getPlainIdMap(OWNER, 'user')]).toEqual([['p1', 'n1'], ['p2', 'n2']]);
    expect([...service.getPlainIdMap(OWNER, 'group')]).toEqual([['p1', 'g1']]);
    service.savePlainIdMap(OWNER, 'user', [['p1', 'n1b']]);
    expect(service.getPlainIdMap(OWNER, 'user').get('p1')).toBe('n1b');
    expect(service.getPlainIdMap('otherOwner', 'user').get('p1')).toBe('zz');
  });

  test('plainIdMapWorksOnUnmigratedSecondaryDb', () => {
    const Sqlite = require('better-sqlite3');
    const other = path.join(tmpDir, 'secondary.db');
    new Sqlite(other).close(); // empty file: no migrations ever ran on it
    service.withDbPath(other, () => {
      expect(service.getPlainIdMap(OWNER, 'user').size).toBe(0);
      service.savePlainIdMap(OWNER, 'user', [['s1', 'sn1']]);
      expect(service.getPlainIdMap(OWNER, 'user').get('s1')).toBe('sn1');
    });
    expect(service.getPlainIdMap(OWNER, 'user').has('s1')).toBe(false);
  });

  test('contactsWithoutProfile', () => {
    const O = 'ownerCP';
    const add = (id: string, name: string, type: string, channel = 'zalo') =>
      service.run('INSERT INTO contacts (owner_zalo_id, contact_id, display_name, contact_type, channel) VALUES (?,?,?,?,?)', [O, id, name, type, channel]);
    add('uA', '', 'user'); add('uB', 'uB', 'user'); add('uC', 'Real Name', 'user'); add('uD', '', 'user'); add('uF', '', 'user', 'facebook');
    add('gA', '', 'group'); add('gB', 'gB', 'group'); add('gC', 'Group Name', 'group');
    const all = service.getContactIdsWithoutProfile(O, 10);
    expect(all.users.sort()).toEqual(['uA', 'uB', 'uD']);
    expect(all.groups.sort()).toEqual(['gA', 'gB']);
    const limited = service.getContactIdsWithoutProfile(O, 1);
    expect(limited.users).toHaveLength(1);
    expect(limited.groups).toHaveLength(1);
  });

  test('contactsWithoutProfileRestrictedToGivenIds', () => {
    const O = 'ownerCPIds';
    const add = (id: string, type: string, time: number) =>
      service.run('INSERT INTO contacts (owner_zalo_id, contact_id, display_name, contact_type, channel, last_message_time) VALUES (?,?,?,?,?,?)', [O, id, '', type, 'zalo', time]);
    for (let i = 0; i < 30; i++) add(String(100000 + i), 'user', 5000 + i); // newer, outside the list
    add('200001', 'user', 1); add('200002', 'user', 2); add('200003', 'group', 3);
    add('200004', 'user', 4); // nameless but not requested
    const only = service.getContactIdsWithoutProfile(O, 5, ['200001', '200002', '200003', "1'; DROP TABLE contacts; --", '999999']);
    expect(only.users.sort()).toEqual(['200001', '200002']);
    expect(only.groups).toEqual(['200003']);
    // more ids than one SQL chunk
    const many = Array.from({ length: 2500 }, (_, i) => String(300000 + i)).concat(['200001']);
    expect(service.getContactIdsWithoutProfile(O, 10, many).users).toEqual(['200001']);
    expect(service.getContactIdsWithoutProfile(O, 10, []).users).toEqual([]);
  });
});
