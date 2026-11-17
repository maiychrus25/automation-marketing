import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startRelay, RelayHarness } from './relayHarness';

// Fake the two running-state sources before the relay loads (the real modules pull the whole Telegram stack in).
const mockOnline = { users: new Set<string>(), bots: new Set<string>(), throwing: false };
jest.mock('../../services/telegram/TelegramUserListener', () => ({ __esModule: true, isConnected: (id: string) => { if (mockOnline.throwing) throw new Error('boom'); return mockOnline.users.has(id); } }));
jest.mock('../../services/telegram/TelegramBotChannelService', () => ({ __esModule: true, isBotPolling: (id: string) => { if (mockOnline.throwing) throw new Error('boom'); return mockOnline.bots.has(id); } }));

const account = (id: string, channel: string, extra: Record<string, unknown> = {}): any =>
  ({ zalo_id: id, full_name: id, avatar_url: '', phone: '', is_business: 0, is_active: 1, channel, cookies: 'SECRET-SESSION-OR-TOKEN', username: `${id}_name`, ...extra });

describe('boss runs an employee Telegram inbox commands with the account checks and records the sender', () => {
  let relay: RelayHarness;
  let mediaRoot: string;
  const send = async (channel: string, params: any, who = 'emp-1') => {
    const res = await fetch(relay.url + '/api/proxy/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${relay.tokenFor(who)}` },
      body: JSON.stringify({ channel, params }),
    });
    return (await res.json()) as any;
  };
  const get = (url: string, who = 'emp-1') => fetch(relay.url + url, { headers: { Authorization: `Bearer ${relay.tokenFor(who)}` } });

  beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgproxy-'));
    fs.mkdirSync(path.join(mediaRoot, '_avatars', 'telegram'), { recursive: true });
    fs.mkdirSync(path.join(mediaRoot, '_avatars', 'other'), { recursive: true });
    fs.mkdirSync(path.join(mediaRoot, 'tg-user', 'stickers'), { recursive: true });
    fs.mkdirSync(path.join(mediaRoot, 'tg-other'), { recursive: true });
    fs.writeFileSync(path.join(mediaRoot, '_avatars', 'telegram', 'a.jpg'), 'AVATAR');
    fs.writeFileSync(path.join(mediaRoot, '_avatars', 'other', 'b.jpg'), 'OTHER');
    fs.writeFileSync(path.join(mediaRoot, 'tg-user', 'stickers', 's.webm'), 'WEBM');
    fs.writeFileSync(path.join(mediaRoot, 'tg-user', 'stickers', 's.tgs'), 'TGS');
    fs.writeFileSync(path.join(mediaRoot, 'tg-user', 'stickers', 's.oga'), 'OGA');
    fs.writeFileSync(path.join(mediaRoot, 'tg-user', 'stickers', 's.opus'), 'OPUS');
    fs.writeFileSync(path.join(mediaRoot, 'tg-user', 'stickers', 's.m4a'), 'M4A');
    fs.writeFileSync(path.join(mediaRoot, 'tg-other', 'secret.jpg'), 'SECRET');
  });
  beforeEach(async () => {
    mockOnline.users = new Set(['tg-user']);
    mockOnline.bots = new Set();
    mockOnline.throwing = false;
    relay = await startRelay({
      employees: [{ id: 'emp-1', assigned: ['tg-user', 'tg-bot'], modules: ['chat'] }],
      accounts: [account('tg-user', 'telegram_user'), account('tg-bot', 'telegram_bot'), account('tg-other', 'telegram_user')],
      mediaRoot,
    });
  });
  afterEach(() => relay.close());
  afterAll(() => fs.rmSync(mediaRoot, { recursive: true, force: true }));

  test('runsAssignedAccountCommandsAndRefusesAnUnassignedOrMissingAccountId', async () => {
    const handler = relay.registerIpcHandler('telegramUser:getGroupInfo');
    expect((await send('telegramUser:getGroupInfo', { accountId: 'tg-user' })).success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((await send('telegramUser:getGroupInfo', { accountId: 'tg-other' })).success).toBe(false);
    expect((await send('telegramUser:getGroupInfo', {})).success).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test.each(['telegramUser:startListener', 'telegramUser:signIn', 'telegram:startBot', 'telegram:validateBot'])('never reaches the handler of %s', async (channel) => {
    const handler = relay.registerIpcHandler(channel);
    expect((await send(channel, { accountId: 'tg-user' })).success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  test.each([
    ['telegram:sendPhoto', 'photoPath'], ['telegram:setChatPhoto', 'photoPath'], ['telegramUser:editChatPhoto', 'photoPath'],
    ['telegram:sendAudio', 'audioPath'], ['telegram:sendSticker', 'stickerPath'], ['telegram:sendAnimation', 'animPath'],
  ])('%s refuses a %s outside the upload folder', async (channel, field) => {
    const handler = relay.registerIpcHandler(channel);
    const out = await send(channel, { accountId: 'tg-user', chatId: 'c1', [field]: path.join(mediaRoot, 'tg-other', 'secret.jpg') });
    expect(out.success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  test('aSuccessfulSendTagsTheRowOfThatChatOnly', async () => {
    relay.registerIpcHandler('telegramUser:sendMessage').mockResolvedValue({ success: true, messageId: '77' });
    expect((await send('telegramUser:sendMessage', { accountId: 'tg-user', chatId: 'chat-A', text: 'x' })).success).toBe(true);
    expect(relay.db.setMessageHandledByEmployeeFlexible.mock.calls).toEqual([['tg-user', '77', 'emp-1', 'chat-A']]);
  });

  test('anExtraThreadIdNeverMovesTheTagToAnotherChat', async () => {
    relay.registerIpcHandler('telegramUser:sendMessage').mockResolvedValue({ success: true, messageId: '77' });
    await send('telegramUser:sendMessage', { accountId: 'tg-user', chatId: 'chat-A', threadId: 'chat-B', text: 'x' });
    expect(relay.db.setMessageHandledByEmployeeFlexible.mock.calls).toEqual([['tg-user', '77', 'emp-1', 'chat-A']]);
  });

  test('aTelegramSendWithoutAChatTagsNothing', async () => {
    relay.registerIpcHandler('telegramUser:sendMessage').mockResolvedValue({ success: true, messageId: '77' });
    await send('telegramUser:sendMessage', { accountId: 'tg-user', threadId: 'chat-B', text: 'x' });
    expect(relay.db.setMessageHandledByEmployeeFlexible).not.toHaveBeenCalled();
  });

  test('anAuthParamOnATelegramCommandIsDroppedNotReplacedByTheSession', async () => {
    const handler = relay.registerIpcHandler('telegramUser:getGroupInfo');
    await send('telegramUser:getGroupInfo', { accountId: 'tg-user', auth: { cookies: 'x' } });
    const seen = handler.mock.calls[0][1];
    expect(seen).not.toHaveProperty('auth');
    expect(JSON.stringify(seen)).not.toContain('SECRET-SESSION-OR-TOKEN');
  });

  test('aTopicSendTagsByItsChatNotItsTopicRoot', async () => {
    relay.registerIpcHandler('telegramUser:sendTopicMessage').mockResolvedValue({ success: true, messageId: '8' });
    await send('telegramUser:sendTopicMessage', { accountId: 'tg-user', chatId: 'chat-A', topicRootMessageId: '3', text: 'x' });
    expect(relay.db.setMessageHandledByEmployeeFlexible.mock.calls).toEqual([['tg-user', '8', 'emp-1', 'chat-A']]);
  });

  test('aSendWithoutAnIdOrAFailedSendTagsNothing', async () => {
    relay.registerIpcHandler('telegramUser:forwardMessages').mockResolvedValue({ success: true });
    relay.registerIpcHandler('telegramUser:sendMessage').mockResolvedValue({ success: false, error: 'boom' });
    await send('telegramUser:forwardMessages', { accountId: 'tg-user', toChatId: 'chat-B', fromChatId: 'c', messageIds: ['1'] });
    await send('telegramUser:sendMessage', { accountId: 'tg-user', chatId: 'chat-A', text: 'x' });
    expect(relay.db.setMessageHandledByEmployeeFlexible).not.toHaveBeenCalled();
  });

  test('theSnapshotCarriesUsernameAndOnlineStateButNeverTheSession', async () => {
    const res = await get('/api/sync/snapshot');
    const text = await res.text();
    expect(text).not.toContain('SECRET-SESSION-OR-TOKEN');
    const rows = JSON.parse(text).snapshot.accountsData;
    expect(rows.map((a: any) => a.zalo_id)).toEqual(['tg-user', 'tg-bot']);
    expect(rows[0]).toMatchObject({ channel: 'telegram_user', username: 'tg-user_name', listener_active: 1 });
    expect(rows[1]).toMatchObject({ channel: 'telegram_bot', listener_active: 0 });
    expect(JSON.parse(text).snapshot.onlineAccounts).toEqual(['tg-user']);
  });

  test('aThrowingOnlineLookupMeansOfflineNotAFailedSnapshot', async () => {
    mockOnline.throwing = true;
    const res = await get('/api/sync/snapshot');
    expect(res.status).toBe(200);
    const snapshot = (await res.json() as any).snapshot;
    expect(snapshot.accountsData.map((a: any) => [a.zalo_id, a.listener_active])).toEqual([['tg-user', 0], ['tg-bot', 0]]);
    expect(snapshot.onlineAccounts).toEqual([]);
  });

  test('aTelegramPathInsideTheUploadFolderIsAcceptedAndReachesTheHandler', async () => {
    const handler = relay.registerIpcHandler('telegram:sendPhoto');
    const inUploads = path.join(mediaRoot, '_uploads', 'p.jpg');
    fs.mkdirSync(path.dirname(inUploads), { recursive: true });
    fs.writeFileSync(inUploads, 'IMG');
    const ownFolder = path.join(mediaRoot, 'tg-bot', '2026-01-01', 'abcdef0123456789', 'q.jpg');
    fs.mkdirSync(path.dirname(ownFolder), { recursive: true });
    fs.writeFileSync(ownFolder, 'IMG');
    expect((await send('telegram:sendPhoto', { accountId: 'tg-bot', chatId: 'c1', photoPath: inUploads })).success).toBe(true);
    expect((await send('telegram:sendPhoto', { accountId: 'tg-bot', chatId: 'c1', photoPath: ownFolder })).success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  describe('media of Telegram', () => {
    test('anAuthenticatedEmployeeReadsATelegramAvatarOfAnyAccount', async () => {
      const res = await get('/api/media/_avatars/telegram/a.jpg');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('AVATAR');
    });
    test('aTelegramAvatarNeedsALogin', async () => {
      expect((await fetch(relay.url + '/api/media/_avatars/telegram/a.jpg')).status).toBe(401);
    });
    test('otherAvatarFoldersAndTraversalStayForbidden', async () => {
      expect((await get('/api/media/_avatars/other/b.jpg')).status).toBe(403);
      expect((await get('/api/media/_avatars/telegram/../other/b.jpg')).status).toBe(403);
      expect((await get('/api/media/_avatars/telegram/../../tg-other/secret.jpg')).status).toBe(403);
      expect((await get('/api/media/tg-other/secret.jpg')).status).toBe(403);
    });
    test.each([['webm', 'video/webm'], ['tgs', 'application/x-tgsticker'], ['oga', 'audio/ogg'], ['opus', 'audio/ogg'], ['m4a', 'audio/mp4']])('serves .%s as %s', async (ext, mime) => {
      const res = await get(`/api/media/tg-user/stickers/s.${ext}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(mime);
    });
  });
});

describe('REST rows of Telegram carry their own columns and Zalo rows do not', () => {
  let relay: RelayHarness;
  const call = async (p: string) => (await (await fetch(relay.url + p, { headers: { Authorization: `Bearer ${relay.tokenFor('emp-1')}` } })).json()) as any;
  const TG_CONTACT = {
    telegram_folder_id: 2, telegram_archived: 1, telegram_can_send: 0, telegram_send_reason: 'banned', telegram_peer_type: 'channel',
    telegram_members_count: 10, telegram_online_count: 3, telegram_state_updated_at: 99, telegram_membership_state: 'member', telegram_join_action: 'join',
    is_cov_bot: 0, menu_button: '{"a":1}', has_main_app: 1, is_forum: 1, is_in_others: 0, has_mention: 1, mute_until: 5, peer_delivered_ts: 1, peer_read_ts: 2,
    last_message_type: 'photo',
  };
  const TG_MESSAGE = { reply_to_id: '4', inline_buttons: '[[{"t":"x"}]]', is_edited: 1, edit_history: '[]', status: 'received', thread_type: 1, deleted_by: 'u', recalled_content: 'old' };

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    relay = await startRelay({
      employees: [{ id: 'emp-1', assigned: ['tg-user', 'acc-a'], modules: ['chat'] }],
      accounts: [account('tg-user', 'telegram_user'), account('acc-a', 'zalo')],
    });
    relay.db.query.mockImplementation((sql: string, params: any[]) => {
      if (sql.includes('COUNT(*)')) return [{ cnt: 1 }];
      if (sql.includes('FROM accounts')) return [{ zalo_id: params[0], channel: params[0] === 'tg-user' ? 'telegram_user' : 'zalo' }];
      if (sql.includes('FROM contacts')) {
        return params[0] === 'tg-user'
          ? [{ contact_id: 'c1', owner_zalo_id: 'tg-user', channel: 'telegram_user', ...TG_CONTACT }]
          : [{ contact_id: 'u1', owner_zalo_id: 'acc-a', channel: 'zalo', ...TG_CONTACT }];
      }
      return [];
    });
    const msgs = (owner: string) => [{ msg_id: 'm1', thread_id: 'c1', owner_zalo_id: owner, content: 'hi', msg_type: 'text', channel: owner === 'tg-user' ? 'telegram_user' : 'zalo', ...TG_MESSAGE }];
    relay.db.getMessages.mockImplementation((owner: string) => msgs(owner));
  });
  afterAll(() => relay.close());

  test('aTelegramConversationCarriesEveryColumnAsStored', async () => {
    const row = (await call('/api/query/conversations?zaloId=tg-user')).data.items[0];
    expect(row).toMatchObject({ channel: 'telegram_user', ...TG_CONTACT });
  });
  test('aTelegramMessageCarriesEveryColumnAsStored', async () => {
    const row = (await call('/api/query/messages?zaloId=tg-user&threadId=c1')).data.items[0];
    expect(row).toMatchObject({ channel: 'telegram_user', ...TG_MESSAGE });
  });
  test('aZaloConversationAndMessageKeepExactlyTheirKeys', async () => {
    const conv = (await call('/api/query/conversations?zaloId=acc-a')).data.items[0];
    const msg = (await call('/api/query/messages?zaloId=acc-a&threadId=u1')).data.items[0];
    for (const key of Object.keys(TG_CONTACT).filter((k) => !['last_message_type'].includes(k))) expect(conv).not.toHaveProperty(key);
    for (const key of Object.keys(TG_MESSAGE)) expect(msg).not.toHaveProperty(key);
  });
  test('theBootCarriesTheChannelOfEachAccountAndShapesConversationsThroughTheRowHelper', async () => {
    const boot = (await call('/api/boot')).data;
    expect(boot.conversations[0]).toMatchObject({ channel: 'telegram_user', ...TG_CONTACT });
    expect(boot.accounts.map((a: any) => a.channel)).toEqual(['telegram_user', 'zalo']);
    expect(JSON.stringify(boot)).not.toContain('SECRET');
  });
});
