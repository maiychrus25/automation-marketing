import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-e2ee-imp-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));
jest.mock('../../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
import DatabaseService from '../../../services/database/DatabaseService';
import FileStorageService from '../../../services/file/FileStorageService';
import { FacebookE2eeExportImporter } from '../../../services/facebook/e2eeExport/FacebookE2eeExportImporter';
import { FacebookHistoryFetcher } from '../../../services/facebook/FacebookHistoryFetcher';
import { FacebookHistoryLimiter } from '../../../services/facebook/FacebookHistoryLimiter';
import { planE2eeProbe } from '../../../services/facebook/facebookHistory';
import { buildZip, chatJson, cleanupTempFiles, writeTempFile } from './zipFixture';

const ACC = 'acc-e2ee-imp';
const OWNER = '100900';
const ONE = '300001';
const GROUP = '400001';
const T = 1_700_000_000_000;

describe('FacebookE2eeExportImporter (real database, synthetic zip)', () => {
  const db = DatabaseService.getInstance();
  const owner = 'Owner Example', alice = 'Alice Example';

  const seed = (id: string, thread: string, senderId: string, senderName: string, text: string, ts: number, isSelf = 0) =>
    db.saveFBMessage({ id, account_id: ACC, thread_id: thread, sender_id: senderId, sender_name: senderName, body: text, timestamp: ts, type: 'text', is_self: isSelf, is_unsent: 0, is_history: true });

  const zipPath = () => {
    const c1 = chatJson({ participants: [owner, alice], messages: [
      { sender: alice, text: 'old-1', ts: T - 100_000 },
      { sender: owner, text: 'old-2', ts: T - 90_000, reactions: [{ actor: alice, reaction: '❤' }, { actor: 'Ghost Example', reaction: '👍' }] },
      { sender: alice, ts: T - 80_000, media: ['media/photo1.jpg'] },
      { sender: alice, ts: T - 70_000, media: ['media/missing.jpg'] },
      { sender: alice, ts: T - 60_000, isUnsent: true },
      { sender: alice, text: 'hello-1', ts: T + 300 },
      { sender: owner, text: 'hello-2', ts: T + 5_800 },
    ] });
    const c2 = chatJson({ participants: [owner, alice, 'Bob Example', 'Cara Example'], threadName: 'Group Example', messages: [
      { sender: alice, text: 'group-old-1', ts: T + 190_000 }, { sender: 'Cara Example', text: 'group-old-2', ts: T + 191_000 },
      { sender: owner, text: 'group-old-3', ts: T + 192_000 },
      { sender: alice, text: 'group-hello-1', ts: T + 200_100 }, { sender: 'Bob Example', text: 'group-hello-2', ts: T + 201_000 },
    ] });
    const c3 = JSON.stringify({ participants: ['X Example', 'Y Example'], messages: [{ senderName: 'X Example', text: 'zzz-unmatched', timestamp: T + 50_000 }, { bogus: true }] });
    return writeTempFile(buildZip([
      { name: 'Alice Example_1.json', data: c1 }, { name: 'Group Example_1.json', data: c2 }, { name: 'Other Example_1.json', data: c3 },
      { name: 'media/' }, { name: 'media/photo1.jpg', data: Buffer.from('synthetic-jpeg') },
    ]));
  };

  const rows = (thread: string) => db.query<any>('SELECT * FROM fb_messages WHERE account_id=? AND thread_id=? ORDER BY timestamp', [ACC, thread]);
  const snapshot = () => ({
    threads: db.query<any>('SELECT id, unread_count, last_message_preview, last_message_at FROM fb_threads WHERE account_id=? ORDER BY id', [ACC]),
    contacts: db.query<any>("SELECT contact_id, unread_count, last_message, last_message_time FROM contacts WHERE owner_zalo_id=? AND channel='facebook' ORDER BY contact_id", [OWNER]),
  });

  beforeAll(async () => {
    jest.spyOn(FileStorageService, 'getBaseDir').mockReturnValue(path.join(tmpDir, 'media'));
    await db.initialize();
    db.saveFBAccount({ id: ACC, facebook_id: OWNER, name: owner, avatar_url: '', cookie_encrypted: '', session_data: '', status: 'connected' });
    db.saveFBThread({ id: ONE, account_id: ACC, name: alice, type: 'user', participant_count: 2, unread_count: 3, is_muted: 0, is_e2ee: 0 } as any);
    db.saveFBThread({ id: GROUP, account_id: ACC, name: 'Group Example', type: 'group', participant_count: 4, unread_count: 3, is_muted: 0, is_e2ee: 0 } as any);
    for (const id of [ONE, GROUP]) db.run(`INSERT OR IGNORE INTO contacts (owner_zalo_id, contact_id, display_name, channel, unread_count, last_message, last_message_time) VALUES (?, ?, 'x', 'facebook', 3, 'keep', 5)`, [OWNER, id]);
    // Numeric ids like the bridge's encrypted messages: nothing starts with mid.$
    seed('7001', ONE, ONE, alice, 'hello-1', T);
    seed('7002', ONE, OWNER, owner, 'hello-2', T + 5000, 1);
    seed('7101', GROUP, 'u-alice', alice, 'group-hello-1', T + 200_000);
    seed('7102', GROUP, 'u-bob', 'Bob Example', 'group-hello-2', T + 201_000);
  });
  afterAll(() => { jest.restoreAllMocks(); cleanupTempFiles(); db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });
  // Tests that add their own thread rows must not leak them into the snapshot comparisons (the suite also runs with --randomize).
  afterEach(() => { db.run('DELETE FROM fb_threads WHERE account_id=? AND id NOT IN (?, ?)', [ACC, ONE, GROUP]); });

  const importer = () => new FacebookE2eeExportImporter({ db, accountId: ACC });
  let before: ReturnType<typeof snapshot>;
  let summary: Awaited<ReturnType<FacebookE2eeExportImporter['importFile']>>;
  // One import up front so the tests do not depend on their order (the suite also runs with --randomize).
  beforeAll(async () => {
    before = snapshot();
    summary = await importer().importFile(zipPath());
  });

  test('importsNewMessagesAndSkipsExistingOnes', () => {
    expect(summary).toEqual({
      chatsInFile: 3, chatsMatched: 2, chatsUnmatched: 1, messagesInFile: 13, imported: 8, alreadyPresent: 4,
      withoutSenderId: 1, mediaImported: 1, mediaSkipped: 1, malformedSkipped: 1,
    });

    const one = rows(ONE);
    expect(one).toHaveLength(7);
    const added = one.filter(r => r.id.startsWith('e2ee-export.'));
    expect(added).toHaveLength(5);
    expect(added.every(r => !r.id.startsWith('mid.'))).toBe(true);
    const old2 = added.find(r => r.body === 'old-2')!;
    expect(old2).toMatchObject({ is_self: 1, sender_id: OWNER, sender_name: owner });
    // Shape the renderer reads (ReactionComponents.parseReactionsFull "old format"): an object { userId: emoji }, never an array.
    expect(JSON.parse(old2.reactions)).toEqual({ [ONE]: '❤' });
    expect(JSON.parse(db.queryOne<any>('SELECT reactions FROM messages WHERE msg_id=? AND owner_zalo_id=?', [old2.id, OWNER])!.reactions)).toEqual({ [ONE]: '❤' });
    expect(added.find(r => r.body === 'old-1')).toMatchObject({ is_self: 0, sender_id: ONE, type: 'text' });
    expect(added.filter(r => r.is_unsent === 1)).toHaveLength(1);

    const photo = added.find(r => r.type === 'image')!;
    const att = JSON.parse(photo.attachments);
    expect(att).toEqual([{ type: 'image', name: expect.stringMatching(/\.jpg$/), localPath: expect.stringMatching(/^media\//) }]);
    expect(fs.readFileSync(FileStorageService.resolveAbsolutePath(att[0].localPath), 'utf8')).toBe('synthetic-jpeg');
    const unified = db.queryOne<any>("SELECT local_paths, msg_type FROM messages WHERE msg_id=? AND owner_zalo_id=?", [photo.id, OWNER])!;
    expect(JSON.parse(unified.local_paths)).toEqual({ main: att[0].localPath });
    const missing = added.find(r => r.type === 'text' && !r.body && r.is_unsent === 0)!;
    expect(JSON.parse(missing.attachments)).toEqual([]);

    const grp = rows(GROUP).filter(r => r.id.startsWith('e2ee-export.'));
    expect(grp).toHaveLength(3);
    expect(grp.find(r => r.body === 'group-old-1')).toMatchObject({ sender_id: 'u-alice', is_self: 0 });
    expect(grp.find(r => r.body === 'group-old-2')).toMatchObject({ sender_id: 'e2ee-name:Cara Example', sender_name: 'Cara Example', is_self: 0 });
    expect(grp.find(r => r.body === 'group-old-3')).toMatchObject({ sender_id: OWNER, is_self: 1 });
    expect(rows('999')).toHaveLength(0);
  });

  test('historySavesLeaveUnreadLastMessageAndContactsUntouched', () => {
    expect(snapshot()).toEqual(before);
  });

  test('theThreadStillLooksEncryptedAndTheProbePlanIsUnchanged', () => {
    const limiter = new FacebookHistoryLimiter(() => Date.now());
    const fetcher = new FacebookHistoryFetcher({
      accountId: ACC, facebookId: () => OWNER, bridge: () => null, fetchGraphQLPage: async () => ({ success: true, messages: [] }), limiter,
      runOnBossDb: (fn: (d: DatabaseService) => void) => fn(db),
    } as any);
    expect(fetcher.isE2EEThread(ONE)).toBe(true);
    const oldest = db.queryOne<any>('SELECT MIN(timestamp) AS t FROM fb_messages WHERE account_id=? AND thread_id=?', [ACC, ONE])!.t;
    expect(planE2eeProbe({ probe: true, mode: 'interactive', isGroup: false, probedEmpty: false, resolved: null, callerTimestampMs: 0, oldestLocalMs: oldest }))
      .toEqual({ anchor: { timestampMs: oldest, messageId: '' }, kind: 'timestamp' });
  });

  test('importingTheSameFileAgainAddsNothing', async () => {
    const again = await importer().importFile(zipPath());
    expect(again).toMatchObject({ chatsMatched: 2, imported: 0, alreadyPresent: 12, mediaImported: 0 });
    expect(rows(ONE)).toHaveLength(7);
    expect(rows(GROUP)).toHaveLength(5);
    expect(snapshot()).toEqual(before);
  });
  test('importedRowsAreStoredForEveryAccountThatSharesAThreadId', async () => {
    const ACC2 = 'acc-e2ee-imp-2', OWNER2 = '100901';
    db.saveFBAccount({ id: ACC2, facebook_id: OWNER2, name: owner, avatar_url: '', cookie_encrypted: '', session_data: '', status: 'connected' });
    db.saveFBMessage({ id: '9001', account_id: ACC2, thread_id: ONE, sender_id: ONE, sender_name: alice, body: 'hello-1', timestamp: T, type: 'text', is_self: 0, is_unsent: 0, is_history: true });
    db.saveFBMessage({ id: '9002', account_id: ACC2, thread_id: ONE, sender_id: OWNER2, sender_name: owner, body: 'hello-2', timestamp: T + 5000, type: 'text', is_self: 1, is_unsent: 0, is_history: true });
    const second = await new FacebookE2eeExportImporter({ db, accountId: ACC2 }).importFile(zipPath());
    expect(second.imported).toBe(5);
    const ids = (acc: string) => db.query<any>("SELECT id FROM fb_messages WHERE account_id=? AND id LIKE 'e2ee-export.%'", [acc]).map(r => r.id);
    expect(ids(ACC2)).toHaveLength(5);
    expect(ids(ACC2).filter(id => ids(ACC).includes(id))).toEqual([]);
  });

  test('unsafeExtensionsAreStoredAsBinAndMediaIsWrittenOnce', async () => {
    const MED = '500001', base = T + 1_000_000;
    db.saveFBMessage({ id: '8001', account_id: ACC, thread_id: MED, sender_id: MED, sender_name: alice, body: 'med-hello-1', timestamp: base, type: 'text', is_self: 0, is_unsent: 0, is_history: true });
    db.saveFBMessage({ id: '8002', account_id: ACC, thread_id: MED, sender_id: MED, sender_name: alice, body: 'med-hello-2', timestamp: base + 1000, type: 'text', is_self: 0, is_unsent: 0, is_history: true });
    const c = chatJson({ participants: [owner, alice], messages: [
      { sender: alice, text: 'med-hello-1', ts: base }, { sender: alice, text: 'med-hello-2', ts: base + 1000 },
      ...[1, 2, 3].map(i => ({ sender: alice, ts: base - i * 10_000, media: ['media/shared.jpg'] })),
      { sender: alice, ts: base - 50_000, media: ['media/evil.exe'] }, { sender: alice, ts: base - 60_000, media: ['media/page.html'] },
      { sender: alice, ts: base - 70_000, media: ['media/run.app'] },
    ] });
    const save = jest.spyOn(FileStorageService, 'saveBuffer');
    const summary = await importer().importFile(writeTempFile(buildZip([
      { name: 'Med_1.json', data: c }, { name: 'media/shared.jpg', data: 'a' }, { name: 'media/evil.exe', data: 'b' }, { name: 'media/page.html', data: 'c' }, { name: 'media/run.app', data: 'd' },
    ])));
    expect(summary).toMatchObject({ imported: 6, mediaImported: 6, mediaSkipped: 0 });
    expect(save).toHaveBeenCalledTimes(4); // shared.jpg once, three unsafe ones once each
    save.mockRestore();
    const atts = rows(MED).filter(r => r.id.startsWith('e2ee-export.')).map(r => JSON.parse(r.attachments)[0]);
    expect(atts.filter(a => a.type === 'image' && /\.jpg$/.test(a.name))).toHaveLength(3);
    expect(new Set(atts.filter(a => a.type === 'image').map(a => a.localPath)).size).toBe(1);
    const files = atts.filter(a => a.type === 'file');
    expect(files).toHaveLength(3);
    expect(files.every(a => /\.bin$/.test(a.name))).toBe(true);
  });

  test('largeImportsAreWrittenInBatchesOf500', async () => {
    const BIG = '600001', base = T + 2_000_000;
    db.saveFBMessage({ id: '6001', account_id: ACC, thread_id: BIG, sender_id: BIG, sender_name: alice, body: 'batch-hello-1', timestamp: base, type: 'text', is_self: 0, is_unsent: 0, is_history: true });
    db.saveFBMessage({ id: '6002', account_id: ACC, thread_id: BIG, sender_id: BIG, sender_name: alice, body: 'batch-hello-2', timestamp: base + 1000, type: 'text', is_self: 0, is_unsent: 0, is_history: true });
    const c = chatJson({ participants: [owner, alice], messages: [
      { sender: alice, text: 'batch-hello-1', ts: base }, { sender: alice, text: 'batch-hello-2', ts: base + 1000 },
      ...Array.from({ length: 1200 }, (_, i) => ({ sender: alice, text: `batch-new-${i}`, ts: base - 600_000 + i * 10 })),
    ] });
    const tx = jest.spyOn(db, 'transaction');
    const summary = await importer().importFile(writeTempFile(buildZip([{ name: 'Big_1.json', data: c }])));
    expect(summary).toMatchObject({ imported: 1200, alreadyPresent: 2 });
    expect(tx).toHaveBeenCalledTimes(3);
    tx.mockRestore();
    expect(rows(BIG)).toHaveLength(1202);
  });
  test('anUnmappedGroupSenderIsNeverLearnedAsARealIdOnLaterImports', async () => {
    const G2 = '700001', base = T + 3_000_000, dan = 'Dan Example', cara = 'Cara Example';
    db.saveFBThread({ id: G2, account_id: ACC, name: 'Group 2', type: 'group', participant_count: 4, unread_count: 0, is_muted: 0, is_e2ee: 0 } as any);
    db.saveFBMessage({ id: '7201', account_id: ACC, thread_id: G2, sender_id: 'u-alice', sender_name: alice, body: 'g2-hello-1', timestamp: base, type: 'text', is_self: 0, is_unsent: 0, is_history: true });
    db.saveFBMessage({ id: '7202', account_id: ACC, thread_id: G2, sender_id: 'u-bob', sender_name: 'Bob Example', body: 'g2-hello-2', timestamp: base + 1000, type: 'text', is_self: 0, is_unsent: 0, is_history: true });
    const file = writeTempFile(buildZip([{ name: 'G2_1.json', data: chatJson({ participants: [owner, alice, 'Bob Example', cara, dan], messages: [
      { sender: cara, text: 'g2-old-1', ts: base - 50_000, reactions: [{ actor: dan, reaction: '👍' }] },
      { sender: alice, text: 'g2-hello-1', ts: base }, { sender: 'Bob Example', text: 'g2-hello-2', ts: base + 1000 },
    ] }) }]));
    const first = await importer().importFile(file);
    expect(first).toMatchObject({ imported: 1, withoutSenderId: 1 });
    const second = await importer().importFile(file);
    expect(second).toMatchObject({ imported: 0, alreadyPresent: 3 });
    const old = db.queryOne<any>("SELECT reactions, sender_id FROM fb_messages WHERE account_id=? AND thread_id=? AND body='g2-old-1'", [ACC, G2])!;
    expect(old.sender_id).toBe('e2ee-name:Cara Example');
    expect(JSON.parse(old.reactions)).toEqual({});
    // A message by the previously imported sender in a later file must not map to the e2ee-name id as a reaction key either.
    const third = writeTempFile(buildZip([{ name: 'G2_1.json', data: chatJson({ participants: [owner, alice, 'Bob Example', cara, dan], messages: [
      { sender: alice, text: 'g2-hello-1', ts: base }, { sender: 'Bob Example', text: 'g2-hello-2', ts: base + 1000 },
      { sender: alice, text: 'g2-new', ts: base - 20_000, reactions: [{ actor: cara, reaction: '❤' }] },
    ] }) }]));
    expect(await importer().importFile(third)).toMatchObject({ imported: 1 });
    expect(JSON.parse(db.queryOne<any>("SELECT reactions FROM fb_messages WHERE account_id=? AND body='g2-new'", [ACC])!.reactions)).toEqual({});
  });
  test('aBatchThatThrowsIsRolledBackAndAReimportStoresEveryMessageOnce', async () => {
    const TH = '800001', base = T + 4_000_000;
    db.saveFBMessage({ id: '8101', account_id: ACC, thread_id: TH, sender_id: TH, sender_name: alice, body: 'rb-hello-1', timestamp: base, type: 'text', is_self: 0, is_unsent: 0, is_history: true });
    db.saveFBMessage({ id: '8102', account_id: ACC, thread_id: TH, sender_id: TH, sender_name: alice, body: 'rb-hello-2', timestamp: base + 1000, type: 'text', is_self: 0, is_unsent: 0, is_history: true });
    const file = writeTempFile(buildZip([{ name: 'Rb_1.json', data: chatJson({ participants: [owner, alice], messages: [
      { sender: alice, text: 'rb-hello-1', ts: base }, { sender: alice, text: 'rb-hello-2', ts: base + 1000 },
      ...Array.from({ length: 600 }, (_, i) => ({ sender: alice, text: `rb-new-${i}`, ts: base - 700_000 + i * 10 })),
    ] }) }]));
    const original = db.saveFBMessage.bind(db);
    let calls = 0;
    const spy = jest.spyOn(db, 'saveFBMessage').mockImplementation((m: any) => { if (++calls === 520) throw new Error('disk full'); return original(m); });
    await expect(importer().importFile(file)).rejects.toThrow('disk full');
    spy.mockRestore();
    const stored = () => db.query<any>("SELECT body FROM fb_messages WHERE account_id=? AND thread_id=?", [ACC, TH]);
    const unified = () => db.query<any>("SELECT msg_id FROM messages WHERE owner_zalo_id=? AND thread_id=?", [OWNER, TH]);
    expect(stored()).toHaveLength(2 + 500); // the first batch committed, the failed second batch left nothing
    expect(unified()).toHaveLength(2 + 500);
    const again = await importer().importFile(file);
    expect(again.imported).toBe(100);
    expect(stored()).toHaveLength(602);
    expect(new Set(stored().map(r => r.body)).size).toBe(602);
    expect(unified()).toHaveLength(602);
  });
});
