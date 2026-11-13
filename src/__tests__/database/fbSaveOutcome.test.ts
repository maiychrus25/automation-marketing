import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-fb-outcome-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));

jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
import DatabaseService from '../../services/database/DatabaseService';

const ACC = 'acc-outcome';
const OWNER = 'fb-owner-1';
let seq = 0;

describe('saveFBMessage outcome and unread counters', () => {
  const db = DatabaseService.getInstance();
  const newThread = (): string => {
    const id = `thread-${++seq}`;
    db.saveFBThread({ id, account_id: ACC, name: 'Khach', type: 'user', participant_count: 2, unread_count: 0, is_muted: 0 });
    return id;
  };
  const save = (threadId: string, over: Record<string, any> = {}) => db.saveFBMessage({
    id: `m-${++seq}`, account_id: ACC, thread_id: threadId, sender_id: 'u1', body: 'hello',
    timestamp: 1000, type: 'text', is_self: 0, is_unsent: 0, ...over,
  } as any);
  const thread = (id: string) => db.queryOne<any>('SELECT unread_count, last_message_preview, last_message_at FROM fb_threads WHERE id=? AND account_id=?', [id, ACC])!;
  const contact = (id: string) => db.queryOne<any>("SELECT unread_count, last_message, last_message_time FROM contacts WHERE owner_zalo_id=? AND contact_id=? AND channel='facebook'", [OWNER, id])!;

  beforeAll(async () => {
    await db.initialize();
    db.saveFBAccount({ id: ACC, facebook_id: OWNER, name: 'Owner', avatar_url: '', cookie_encrypted: '', session_data: '', status: 'connected' });
  });
  afterAll(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('newIncomingIncrementsOnce', () => {
    const t = newThread();
    expect(save(t)).toBe('new');
    expect(contact(t).unread_count).toBe(1);
    expect(thread(t).unread_count).toBe(1);
  });

  test('replayIsDuplicate', () => {
    const t = newThread();
    const id = `replay-${++seq}`;
    expect(save(t, { id, body: 'first', timestamp: 1000 })).toBe('new');
    expect(save(t, { id, body: 'first', timestamp: 2000 })).toBe('duplicate');
    expect(contact(t).unread_count).toBe(1);
    expect(thread(t).unread_count).toBe(1);
    expect(contact(t).last_message).toBe('first');
    expect(contact(t).last_message_time).toBe(1000);
    expect(thread(t).last_message_at).toBe(1000);
  });

  test('ownMessageNoUnread', () => {
    const t = newThread();
    expect(save(t, { is_self: 1, body: 'mine' })).toBe('new');
    expect(contact(t).unread_count).toBe(0);
    expect(thread(t).unread_count).toBe(0);
    expect(contact(t).last_message).toBe('mine');
    expect(thread(t).last_message_preview).toBe('mine');
  });

  test('historyRowIsSilent', () => {
    const t = newThread();
    save(t, { body: 'live', timestamp: 5000 });
    const id = `hist-${++seq}`;
    expect(save(t, { id, body: 'old', timestamp: 10, is_history: true })).toBe('new');
    expect(db.queryOne<any>('SELECT body FROM fb_messages WHERE id=? AND account_id=?', [id, ACC])!.body).toBe('old');
    expect(contact(t).unread_count).toBe(1);
    expect(contact(t).last_message).toBe('live');
    expect(thread(t).last_message_at).toBe(5000);
  });

  test('sharedIdSecondAccountCountsOnce', () => {
    const accB = 'acc-outcome-b';
    const ownerB = 'fb-owner-2';
    db.saveFBAccount({ id: accB, facebook_id: ownerB, name: 'OwnerB', avatar_url: '', cookie_encrypted: '', session_data: '', status: 'connected' });
    const t = newThread();
    const id = `shared-${++seq}`;
    const cB = () => db.queryOne<any>("SELECT unread_count FROM contacts WHERE owner_zalo_id=? AND contact_id=? AND channel='facebook'", [ownerB, t])!.unread_count;
    expect(save(t, { id })).toBe('new');
    expect(contact(t).unread_count).toBe(1);
    expect(save(t, { id, account_id: accB })).toBe('new');
    expect(cB()).toBe(1);
    expect(save(t, { id, account_id: accB })).toBe('duplicate');
    expect(cB()).toBe(1);
    expect(contact(t).unread_count).toBe(1);
  });

  test('historyThenLiveIsSilent', () => {
    const t = newThread();
    const id = `hl-${++seq}`;
    expect(save(t, { id, is_history: true })).toBe('new');
    expect(save(t, { id })).toBe('duplicate');
    expect(thread(t).unread_count).toBe(0);
    expect(db.queryOne<any>("SELECT unread_count FROM contacts WHERE owner_zalo_id=? AND contact_id=? AND channel='facebook'", [OWNER, t])?.unread_count ?? 0).toBe(0);
  });

  test('unsentRowDoesNotCount', () => {
    const t = newThread();
    save(t, { body: 'live', timestamp: 5000 });
    save(t, { is_unsent: 1, body: null, timestamp: 9000 });
    expect(contact(t).unread_count).toBe(1);
    expect(contact(t).last_message).toBe('live');
    expect(thread(t).last_message_preview).toBe('live');
  });

  test.each([
    ['gif', { type: 'gif' }, '🖼️ GIF'],
    ['image', { type: 'image' }, '🖼️ Hình ảnh'],
    ['video', { type: 'video' }, '🎬 Video'],
    ['audio', { type: 'audio' }, '🎵 Audio'],
    ['sticker', { type: 'sticker' }, '🎨 Sticker'],
    ['namedFile', { type: 'file', attachments: JSON.stringify([{ name: 'a.pdf' }]) }, '📎 a.pdf'],
    ['unnamedFile', { type: 'file', attachments: JSON.stringify([{ url: 'x' }]) }, '📎 Tệp đính kèm'],
  ])('gifPreviewKept_%s', (_n, over, expected) => {
    const t = newThread();
    save(t, { body: null, ...over });
    expect(contact(t).last_message).toBe(expected);
    expect(thread(t).last_message_preview).toBe(expected);
  });
});

describe('saveFBMessage repairs an empty stored row', () => {
  const db = DatabaseService.getInstance();
  const OWN = 'fb-owner-repair';
  const ACC2 = 'acc-repair';
  let n = 0;
  const save = (t: string, over: Record<string, any>) => db.saveFBMessage({
    id: 'r', account_id: ACC2, thread_id: t, sender_id: 'u1', body: null,
    timestamp: 1000, type: 'text', is_self: 0, is_unsent: 0, ...over,
  } as any);
  const unified = (id: string) => db.queryOne<any>("SELECT content, msg_type, attachments, is_recalled FROM messages WHERE msg_id=? AND channel='facebook'", [id])!;
  const fbRow = (id: string) => db.queryOne<any>('SELECT body, type, attachments FROM fb_messages WHERE id=?', [id])!;
  const contact = (t: string) => db.queryOne<any>("SELECT unread_count, last_message, last_message_time FROM contacts WHERE owner_zalo_id=? AND contact_id=? AND channel='facebook'", [OWN, t])!;
  const thr = (t: string) => db.queryOne<any>('SELECT unread_count, last_message_preview, last_message_at FROM fb_threads WHERE id=? AND account_id=?', [t, ACC2])!;
  const mk = () => {
    const t = `rt-${++n}`;
    db.saveFBThread({ id: t, account_id: ACC2, name: 'Khach', type: 'user', participant_count: 2, unread_count: 0, is_muted: 0 });
    return t;
  };

  beforeAll(async () => {
    await db.initialize();
    db.saveFBAccount({ id: ACC2, facebook_id: OWN, name: 'Owner', avatar_url: '', cookie_encrypted: '', session_data: '', status: 'connected' });
  });

  test('emptyRowGetsFilled', () => {
    const t = mk(); const id = `rep-${t}`;
    expect(save(t, { id })).toBe('new');
    expect(save(t, { id, body: 'Nội dung mẫu', timestamp: 2000 })).toBe('repaired');
    expect(unified(id).content).toBe('Nội dung mẫu');
    expect(fbRow(id).body).toBe('Nội dung mẫu');
    expect(contact(t).unread_count).toBe(1);
    expect(thr(t).unread_count).toBe(1);
    expect(contact(t).last_message).toBe('Nội dung mẫu');
    expect(thr(t).last_message_preview).toBe('Nội dung mẫu');
    expect(contact(t).last_message_time).toBe(1000);
    expect(thr(t).last_message_at).toBe(1000);
    // filled now → a third delivery is a plain duplicate
    expect(save(t, { id, body: 'Khác', timestamp: 3000 })).toBe('duplicate');
    expect(unified(id).content).toBe('Nội dung mẫu');
  });

  test('placeholderWithoutAttachmentsCountsAsEmpty', () => {
    const t = mk(); const id = `rep-${t}`;
    expect(save(t, { id, type: 'file', attachments: JSON.stringify([{ url: 'x' }]) })).toBe('new'); // '📎 Tệp đính kèm' but has attachment
    expect(unified(id).content).toBe('📎 Tệp đính kèm');
    expect(save(t, { id, body: 'Chữ', timestamp: 2000 })).toBe('duplicate'); // has attachments → not empty
    const t2 = mk(); const id2 = `rep-${t2}`;
    expect(save(t2, { id: id2, type: 'file' })).toBe('new'); // placeholder, no attachments
    expect(unified(id2).content).toBe('📎 Tệp đính kèm');
    expect(save(t2, { id: id2, body: 'Chữ' })).toBe('repaired');
    expect(unified(id2).content).toBe('Chữ');
    expect(unified(id2).msg_type).toBe('text');
    expect(contact(t2).last_message).toBe('Chữ');
  });

  test('emptyRowGetsRealAttachments', () => {
    const t = mk(); const id = `rep-${t}`;
    save(t, { id });
    const att = JSON.stringify([{ type: 'image', url: 'https://example.com/i.jpg', id: '1' }]);
    expect(save(t, { id, type: 'image', attachments: att })).toBe('repaired');
    expect(unified(id).msg_type).toBe('image');
    expect(unified(id).attachments).toBe(att);
    expect(fbRow(id).attachments).toBe(att);
    expect(contact(t).last_message).toBe('🖼️ Hình ảnh');
  });

  test('newerLastMessageNotReplaced', () => {
    const t = mk(); const id = `rep-${t}`;
    save(t, { id, timestamp: 1000 });
    save(t, { id: `${id}-later`, body: 'Tin sau', timestamp: 5000 });
    expect(save(t, { id, body: 'Chữ', timestamp: 1000 })).toBe('repaired');
    expect(contact(t).last_message).toBe('Tin sau');
    expect(thr(t).last_message_preview).toBe('Tin sau');
  });

  test('contentRowNeverOverwritten', () => {
    const t = mk(); const id = `rep-${t}`;
    save(t, { id, body: 'Gốc' });
    expect(save(t, { id, body: 'Mới' })).toBe('duplicate');
    expect(unified(id).content).toBe('Gốc');
    expect(fbRow(id).body).toBe('Gốc');
  });

  test('recalledRowNeverOverwritten', () => {
    const t = mk(); const id = `rep-${t}`;
    save(t, { id });
    db.updateFBMessageUnsent(id);
    expect(save(t, { id, body: 'Chữ' })).toBe('duplicate');
    expect(unified(id).content).toBe('');
  });

  test('emptyIncomingOnEmptyRowIsDuplicate', () => {
    const t = mk(); const id = `rep-${t}`;
    save(t, { id });
    expect(save(t, { id })).toBe('duplicate');
  });
});
