import * as fs from 'fs';
import * as path from 'path';
import {
  FACEBOOK_CHANNEL_ROUTES, employeeChannelSpec, employeeSendInfo,
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
