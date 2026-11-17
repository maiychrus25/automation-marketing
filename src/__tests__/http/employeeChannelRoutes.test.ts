import * as fs from 'fs';
import * as path from 'path';
import {
  FACEBOOK_CHANNEL_ROUTES, TELEGRAM_CHANNEL_ROUTES, POSTER_CHANNEL_ROUTES, employeeChannelSpec, employeeSendInfo, handlerMayRunHere, POSTER_READ_CHANNELS, POSTER_WRITE_CHANNELS,
  PROXY_DEFAULT_TIMEOUT_MS, PROXY_MEDIUM_TIMEOUT_MS, PROXY_SLOW_TIMEOUT_MS,
} from '../../services/http/employeeChannelRoutes';

const ROOT = path.join(__dirname, '../../..');

// Every fb: handler name, however it is registered: ipcMain.handle('fb:x') or guardedSync('fb:x', ...). Comment lines are skipped.
function registeredFbChannels(): string[] {
  const names = new Set<string>();
  for (const file of ['electron/ipc/facebookIpc.ts', 'electron/ipc/fbHistoryIpc.ts']) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');
    for (const m of code.matchAll(/(?:ipcMain\.handle|guardedSync)\(\s*'(fb:[^']+)'/g)) names.add(m[1]);
  }
  return [...names];
}

describe('FACEBOOK_CHANNEL_ROUTES', () => {
  test('classifiesEveryRegisteredFbHandlerExactlyAndNothingElse', () => {
    const registered = registeredFbChannels();
    expect(registered.length).toBeGreaterThan(60);
    expect(registered.filter((c) => !(c in FACEBOOK_CHANNEL_ROUTES))).toEqual([]);
    expect(Object.keys(FACEBOOK_CHANNEL_ROUTES).filter((c) => !registered.includes(c))).toEqual([]);
  });

  const proxied: Array<[string, number, boolean]> = [
    ['fb:getThreads', PROXY_SLOW_TIMEOUT_MS, false], ['fb:getMessages', PROXY_DEFAULT_TIMEOUT_MS, false],
    ['fb:fetchThreadMessages', PROXY_MEDIUM_TIMEOUT_MS, false], ['fb:fetchOlderMessages', PROXY_MEDIUM_TIMEOUT_MS, false],
    ['fb:sendMessage', PROXY_MEDIUM_TIMEOUT_MS, true], ['fb:sendAttachment', PROXY_SLOW_TIMEOUT_MS, true],
    ['fb:sendAttachments', PROXY_SLOW_TIMEOUT_MS, true], ['fb:sendPageSticker', PROXY_MEDIUM_TIMEOUT_MS, true],
    ['fb:listPageStickers', PROXY_DEFAULT_TIMEOUT_MS, false], ['fb:addReaction', PROXY_DEFAULT_TIMEOUT_MS, false],
    ['fb:markAsRead', PROXY_DEFAULT_TIMEOUT_MS, false], ['fb:sendSeen', PROXY_DEFAULT_TIMEOUT_MS, false],
    ['fb:getUserInfoFacebookHtml', PROXY_DEFAULT_TIMEOUT_MS, false], ['fb:refreshContactAvatar', PROXY_DEFAULT_TIMEOUT_MS, false],
  ];
  test.each(proxied)('%s is proxied with the chat module, timeout %i, send=%s', (channel, timeoutMs, send) => {
    const spec = employeeChannelSpec(channel)!;
    expect(spec.route).toBe('proxy');
    expect(spec.modules).toEqual(['chat']);
    expect(spec.timeoutMs).toBe(timeoutMs);
    expect(!!spec.send).toBe(send);
  });
  test('onlyTheProxyCommandsAreFourteen', () => {
    expect(Object.values(FACEBOOK_CHANNEL_ROUTES).filter((s) => s.route === 'proxy')).toHaveLength(14);
  });

  test.each(['fb:saveScanLog', 'fb:getScanLogs', 'fb:scanResetCache', 'fb:scanSaveTab', 'fb:scanGetTabs', 'fb:scanGetTab', 'fb:scanUpdateTabStatus',
    'fb:scanDeleteTab', 'fb:scanTouchTab', 'fb:scanSaveTabData', 'fb:scanGetTabData', 'fb:scanSaveRequestLog', 'fb:scanGetRequestLogs', 'fb:scanGetStats'])
  ('%s stays on the employee machine', (channel) => {
    expect(employeeChannelSpec(channel)!.route).toBe('local');
  });

  test.each(['fb:updateCookie', 'fb:addAccount', 'fb:removeAccount', 'fb:connect', 'fb:setPageEnabled', 'fb:toggleE2EE',
    'fb:historySync:start', 'fb:unsendMessage', 'fb:editMessage', 'fb:scanGroupMembers'])
  ('%s is boss only', (channel) => {
    expect(employeeChannelSpec(channel)!.route).toBe('boss_only');
  });

  test('unknownAndInheritedNamesHaveNoSpec', () => {
    for (const c of ['fb:nope', 'zalo:sendMessage', '', 'constructor', 'toString']) expect(employeeChannelSpec(c)).toBeNull();
  });
});

describe('employeeSendInfo', () => {
  const p = { accountId: 'page-1', threadId: 't1' };
  test('returnsTheSingleMessageIdOfASuccessfulSend', () => {
    expect(employeeSendInfo('fb:sendMessage', p, { success: true, messageId: 'mid.1' })).toEqual({ accountId: 'page-1', threadId: 't1', messageIds: ['mid.1'] });
    expect(employeeSendInfo('fb:sendPageSticker', p, { success: true, messageId: 'mid.2' })?.messageIds).toEqual(['mid.2']);
  });
  test('sendAttachmentsReturnsAllSavedIdsInOrder', () => {
    expect(employeeSendInfo('fb:sendAttachments', p, { success: true, uploadedCount: 3, totalCount: 3, messageIds: ['m1', 'm2', 'm3'] })?.messageIds).toEqual(['m1', 'm2', 'm3']);
  });
  test('keepsOnlyNonEmptyStringIds', () => {
    expect(employeeSendInfo('fb:sendAttachments', p, { success: true, messageIds: ['m1', '', 5, null, 'm2'] })?.messageIds).toEqual(['m1', 'm2']);
    expect(employeeSendInfo('fb:sendMessage', p, { success: true, messageId: '' })?.messageIds).toEqual([]);
  });
  test('hasNoIdsWhenTheCommandReturnsNone', () => {
    expect(employeeSendInfo('fb:sendAttachments', p, { success: true, uploadedCount: 2, totalCount: 2 })).toEqual({ accountId: 'page-1', threadId: 't1', messageIds: [] });
  });
  test('isNullWhenTheSendFailed', () => {
    expect(employeeSendInfo('fb:sendMessage', p, { success: false, error: 'x' })).toBeNull();
    expect(employeeSendInfo('fb:sendMessage', p, undefined)).toBeNull();
  });
  test('isNullForACommandThatIsNotASend', () => {
    expect(employeeSendInfo('fb:addReaction', p, { success: true })).toBeNull();
    expect(employeeSendInfo('fb:updateCookie', { accountId: 'page-1' }, { success: true })).toBeNull();
  });
});

// Telegram: every handler of the two IPC files, with the name of its second parameter (none when the handler takes nothing).
function telegramHandlers(file: string): Array<{ channel: string; param: string }> {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');
  return [...code.matchAll(/ipcMain\.handle\(\s*'((?:telegramUser|telegram):[^']+)'\s*,\s*(?:async\s*)?\(\s*(?:\w+\s*(?:,\s*(\w+))?)?/g)]
    .map((m) => ({ channel: m[1], param: m[2] ?? '' }));
}
const USER_HANDLERS = telegramHandlers('electron/ipc/telegramUserIpc.ts');
const BOT_HANDLERS = telegramHandlers('electron/ipc/telegramIpc.ts');

describe('TELEGRAM_CHANNEL_ROUTES', () => {
  test('theTwoFilesRegisterSixtyEightAndThirtyEightHandlers', () => {
    expect(USER_HANDLERS).toHaveLength(68);
    expect(BOT_HANDLERS).toHaveLength(38);
  });
  test('classifiesEveryRegisteredTelegramHandlerExactlyAndNothingElse', () => {
    const registered = [...USER_HANDLERS, ...BOT_HANDLERS].map((h) => h.channel);
    expect(registered.filter((c) => !(c in TELEGRAM_CHANNEL_ROUTES))).toEqual([]);
    expect(Object.keys(TELEGRAM_CHANNEL_ROUTES).filter((c) => !registered.includes(c))).toEqual([]);
  });
  test('aHandlerWhoseSecondParameterIsNotParamsIsBossOnly', () => {
    const odd = [...USER_HANDLERS, ...BOT_HANDLERS].filter((h) => h.param !== 'params');
    expect(odd.length).toBeGreaterThanOrEqual(11);
    expect(odd.filter((h) => TELEGRAM_CHANNEL_ROUTES[h.channel]?.route !== 'boss_only').map((h) => h.channel)).toEqual([]);
  });
  test('everyProxiedTelegramHandlerNamesItsSecondParameterParams', () => {
    const proxied = [...USER_HANDLERS, ...BOT_HANDLERS].filter((h) => TELEGRAM_CHANNEL_ROUTES[h.channel]?.route === 'proxy');
    expect(proxied.length).toBe(106 - 15);
    expect(proxied.filter((h) => h.param !== 'params').map((h) => h.channel)).toEqual([]);
  });
  test('bossOnlyIsExactlyTheListedCommands', () => {
    const expected = [
      ...['sendCode', 'signIn', 'signIn2FA', 'startListener', 'stopListener', 'isConnected', 'getActive', 'fetchSelfAvatar', 'checkForumForNewGroups', 'refreshMessages'].map((n) => `telegramUser:${n}`),
      ...['validateBot', 'startBot', 'stopBot', 'isBotPolling', 'getActiveBots'].map((n) => `telegram:${n}`),
    ];
    const actual = Object.entries(TELEGRAM_CHANNEL_ROUTES).filter(([, s]) => s.route === 'boss_only').map(([c]) => c);
    expect(actual.sort()).toEqual(expected.sort());
    expect(Object.values(TELEGRAM_CHANNEL_ROUTES).filter((s) => s.route === 'proxy')).toHaveLength(106 - 15);
  });
  test('modulesAndSendFlagsAndTimeouts', () => {
    for (const c of ['blockUser', 'unblockUser', 'searchContacts', 'resolveUsername', 'getPeers']) expect(employeeChannelSpec(`telegramUser:${c}`)!.modules).toEqual(['friends', 'chat']);
    expect(employeeChannelSpec('telegramUser:getMessages')!.modules).toEqual(['chat']);
    const sends = [
      ...['sendMessage', 'sendFile', 'sendTopicMessage', 'sendTopicFile', 'sendSticker', 'sendGif', 'forwardMessages'].map((n) => `telegramUser:${n}`),
      ...['sendMessage', 'sendPhoto', 'sendVideo', 'sendDocument', 'sendAudio', 'sendVoice', 'sendSticker', 'sendAnimation', 'sendVideoNote', 'sendContact', 'sendLocation', 'sendPoll', 'forwardMessage'].map((n) => `telegram:${n}`),
    ];
    const flagged = Object.entries(TELEGRAM_CHANNEL_ROUTES).filter(([, s]) => s.send).map(([c]) => c);
    expect(flagged.sort()).toEqual(sends.sort());
    for (const c of ['telegramUser:sendFile', 'telegram:sendPhoto', 'telegramUser:getMessages', 'telegramUser:repairMessageMedia', 'telegramUser:getGroupMembers']) expect(employeeChannelSpec(c)!.timeoutMs).toBe(PROXY_SLOW_TIMEOUT_MS);
    for (const c of ['telegramUser:sendMessage', 'telegramUser:editMessage', 'telegramUser:deleteMessages', 'telegram:forwardMessage', 'telegram:sendPoll']) expect(employeeChannelSpec(c)!.timeoutMs).toBe(PROXY_MEDIUM_TIMEOUT_MS);
    expect(employeeChannelSpec('telegramUser:sendReaction')!.timeoutMs).toBe(PROXY_DEFAULT_TIMEOUT_MS);
  });
  test('facebookRoutesAreUnchangedByTheMerge', () => {
    expect(employeeChannelSpec('fb:sendMessage')).toBe(FACEBOOK_CHANNEL_ROUTES['fb:sendMessage']);
  });
});

describe('employeeSendInfo for Telegram', () => {
  test('takesTheConversationFromChatId', () => {
    expect(employeeSendInfo('telegramUser:sendMessage', { accountId: 't1', chatId: 'c9' }, { success: true, messageId: '55' })).toEqual({ accountId: 't1', threadId: 'c9', messageIds: ['55'] });
  });
  test('aForwardUsesToChatIdAndMayReturnNoIds', () => {
    expect(employeeSendInfo('telegramUser:forwardMessages', { accountId: 't1', fromChatId: 'a', toChatId: 'c7', messageIds: ['1'] }, { success: true })).toEqual({ accountId: 't1', threadId: 'c7', messageIds: [] });
  });
  test('chatIdComesBeforeToChatId', () => {
    expect(employeeSendInfo('telegramUser:forwardMessages', { accountId: 't1', chatId: 'first', toChatId: 'second', messageIds: ['1'] }, { success: true })?.threadId).toBe('first');
  });
  test('aTelegramThreadIdIsNeverRead', () => {
    expect(employeeSendInfo('telegramUser:sendMessage', { accountId: 't1', chatId: 'X', threadId: 'Y' }, { success: true, messageId: '5' })?.threadId).toBe('X');
    expect(employeeSendInfo('telegramUser:forwardMessages', { accountId: 't1', threadId: 'Y', toChatId: 'Z', messageIds: ['1'] }, { success: true })?.threadId).toBe('Z');
    expect(employeeSendInfo('telegramUser:sendMessage', { accountId: 't1', threadId: 'Y' }, { success: true, messageId: '5' })?.threadId).toBe('');
    expect(employeeSendInfo('telegramUser:sendMessage', { accountId: 't1', chatId: 'c1', toChatId: 'c2' }, { success: true, messageId: '5' })?.threadId).toBe('c1');
  });
  test('threadIdStillWinsForFacebook', () => {
    expect(employeeSendInfo('fb:sendMessage', { accountId: 'p', threadId: 't', chatId: 'x' }, { success: true, messageId: 'm' })?.threadId).toBe('t');
  });
});

// Poster: every channel registered in the two IPC files, whatever the helper is called, matched as `handle('x:y'`.
function posterRegistered(): string[] {
  const names = new Set<string>();
  for (const file of ['electron/ipc/facebookPosterIpc.ts', 'electron/ipc/browserProfileIpc.ts']) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');
    for (const m of code.matchAll(/handle\(\s*'([a-zA-Z]+:[A-Za-z]+)'/g)) names.add(m[1]);
    // Any other registration shape must be added to this scan: the count of ipcMain.handle calls is only the helper's own.
    expect((code.match(/ipcMain\.handle\(/g) ?? []).length).toBe(1);
  }
  return [...names];
}

describe('POSTER_CHANNEL_ROUTES', () => {
  const PROXY_NAMES = ['start', 'cancel', 'active', 'scheduleCreate', 'scheduleList', 'scheduleUpdate', 'scheduleDelete', 'campaignList', 'campaignGet',
    'campaignCreate', 'campaignUpdate', 'campaignDelete', 'draftSave', 'draftGet', 'draftApprove', 'listGroups', 'listRuns', 'getRun', 'listComments',
    'listPostedUrls', 'checkLogins', 'getLoginStates', 'trackPosts', 'trackStatus', 'trackCancel', 'listTracking', 'postStats', 'groupScores', 'bestTimes',
    'getTrackConfig', 'setTrackConfig', 'pageMetrics', 'leadList', 'leadUpdate', 'leadConfigGet', 'leadConfigSet', 'commentCollect', 'commentCollectStatus',
    'commentCollectCancel', 'listLeadReplies'].map((n) => `facebookPoster:${n}`);
  const SLOW = ['start', 'draftApprove', 'scheduleCreate', 'draftSave', 'checkLogins', 'trackPosts', 'commentCollect'].map((n) => `facebookPoster:${n}`);

  test('classifiesEveryRegisteredPosterHandlerExactlyAndNothingElse', () => {
    const registered = posterRegistered();
    expect(registered.length).toBeGreaterThanOrEqual(70);
    expect(registered.filter((c) => !(c in POSTER_CHANNEL_ROUTES))).toEqual([]);
    expect(Object.keys(POSTER_CHANNEL_ROUTES).filter((c) => !registered.includes(c))).toEqual([]);
  });
  test('proxyIsExactlyTheListedCommandsPlusBrowserProfileList', () => {
    const actual = Object.entries(POSTER_CHANNEL_ROUTES).filter(([, s]) => s.route === 'proxy').map(([c]) => c).sort();
    expect(actual).toEqual([...PROXY_NAMES, 'browserProfile:list'].sort());
  });
  test.each([...PROXY_NAMES, 'browserProfile:list'])('%s needs the fb_poster module and has the right timeout', (channel) => {
    const spec = POSTER_CHANNEL_ROUTES[channel];
    expect(spec.modules).toEqual(['fb_poster']);
    expect(spec.timeoutMs).toBe(SLOW.includes(channel) ? PROXY_SLOW_TIMEOUT_MS : PROXY_DEFAULT_TIMEOUT_MS);
    expect(spec.send).toBeUndefined();
  });
  test('pickMediaIsLocal', () => expect(POSTER_CHANNEL_ROUTES['facebookPoster:pickMedia'].route).toBe('local'));
  test.each(['engagement:approve', 'engagement:list', 'autonomy:stop', 'autonomy:status', 'facebookPoster:leadExport', 'facebookPoster:takeMissed',
    'facebookPoster:current', 'facebookPoster:exportRunCsv', 'facebookPoster:getLoginCheckConfig', 'facebookPoster:setLoginCheckConfig',
    'facebookPoster:getNotificationConfig', 'facebookPoster:setNotificationConfig', 'browserProfile:open', 'browserProfile:create', 'browserProfile:delete',
    'browserProfile:setProxy', 'browserProfile:installEngine'])('%s is boss only', (channel) => {
    expect(POSTER_CHANNEL_ROUTES[channel].route).toBe('boss_only');
  });
  test('everyOtherRegisteredChannelIsBossOnly', () => {
    const rest = Object.entries(POSTER_CHANNEL_ROUTES).filter(([c]) => !PROXY_NAMES.includes(c) && c !== 'browserProfile:list' && c !== 'facebookPoster:pickMedia');
    expect(rest.length).toBe(29);
    expect(rest.filter(([, s]) => s.route !== 'boss_only')).toEqual([]);
  });
  test('areMergedIntoTheEmployeeTableAndResolvable', () => {
    expect(employeeChannelSpec('facebookPoster:start')?.route).toBe('proxy');
    expect(employeeChannelSpec('engagement:approve')?.route).toBe('boss_only');
    expect(employeeChannelSpec('facebookPoster:nope')).toBeNull();
  });
});

describe('handlerMayRunHere (a spoofed _fromRelay does not run a poster handler on an employee machine)', () => {
  const proxyChannel = 'facebookPoster:start';
  it.each([
    ['proxy', proxyChannel], ['browserProfile proxy', 'browserProfile:list'], ['boss_only', 'facebookPoster:takeMissed'], ['boss_only profile', 'browserProfile:open'],
    ['unclassified', 'facebookPoster:somethingNew'], ['unclassified profile', 'browserProfile:somethingNew'],
  ])('employee mode blocks a %s channel', (_label, channel) => {
    expect(handlerMayRunHere(true, channel)).toBe(false);
  });
  it('employee mode allows the local channel (pickMedia)', () => {
    expect(handlerMayRunHere(true, 'facebookPoster:pickMedia')).toBe(true);
  });
  it('boss and standalone allow every channel', () => {
    for (const channel of [proxyChannel, 'facebookPoster:takeMissed', 'facebookPoster:pickMedia', 'facebookPoster:somethingNew', 'browserProfile:open']) expect(handlerMayRunHere(false, channel)).toBe(true);
  });
});

describe('poster channels are classified as read or write (traceability of writes)', () => {
  const proxied = Object.keys(POSTER_CHANNEL_ROUTES).filter((c) => POSTER_CHANNEL_ROUTES[c].route === 'proxy').sort();
  it('every proxied poster channel is exactly one of read or write', () => {
    expect(proxied).toHaveLength(41);
    expect([...POSTER_READ_CHANNELS, ...POSTER_WRITE_CHANNELS].sort()).toEqual(proxied);
    expect([...POSTER_READ_CHANNELS].filter((c) => POSTER_WRITE_CHANNELS.has(c))).toEqual([]);
  });
  it('commands that create, change, delete or start something are writes', () => {
    for (const n of ['start', 'cancel', 'scheduleCreate', 'scheduleUpdate', 'scheduleDelete', 'draftSave', 'draftApprove', 'campaignCreate', 'checkLogins', 'commentCollect', 'leadUpdate', 'setTrackConfig']) {
      expect(POSTER_WRITE_CHANNELS.has(`facebookPoster:${n}`)).toBe(true);
    }
    for (const n of ['scheduleList', 'getRun', 'draftGet', 'campaignList', 'leadList']) expect(POSTER_WRITE_CHANNELS.has(`facebookPoster:${n}`)).toBe(false);
    expect(POSTER_WRITE_CHANNELS.has('browserProfile:list')).toBe(false);
  });
});
