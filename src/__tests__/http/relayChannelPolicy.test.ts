import * as fs from 'fs';
import * as path from 'path';
import { isEmployeeChannelAllowed, employeeChannelRule, EMPLOYEE_PROXY_CHANNELS } from '../../services/http/relayChannelPolicy';

const ROOT = path.join(__dirname, '../../..');
function sourceFiles(dir: string, exts: RegExp, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') sourceFiles(full, exts, out); }
    else if (exts.test(entry.name)) out.push(full);
  }
  return out;
}

describe('isEmployeeChannelAllowed', () => {
  // Every channel the employee app sends to the boss today (proxyToBoss / proxyAction call sites).
  const usedByEmployees = [
    'login:connect',
    'zalo:sendMessage', 'zalo:getContext', 'zalo:getLabels', 'zalo:updateLabels',
    'crm:saveNote', 'crm:deleteNote', 'crm:saveCampaign', 'crm:addCampaignContacts', 'crm:updateCampaignStatus',
    'ai:saveAssistant', 'ai:deleteAssistant', 'ai:uploadFile', 'ai:removeFile', 'ai:setAccountAssistant',
    'integration:save', 'integration:delete', 'integration:toggle',
    'db:markAsRead', 'db:deleteMessages', 'db:saveFriends', 'db:pinMessage', 'db:upsertLocalLabel',
    // Page inbox commands (fb:*), run on the boss with a required accountId
    'fb:getThreads', 'fb:getMessages', 'fb:fetchThreadMessages', 'fb:fetchOlderMessages', 'fb:sendMessage', 'fb:sendAttachment',
    'fb:sendAttachments', 'fb:sendPageSticker', 'fb:listPageStickers', 'fb:addReaction', 'fb:markAsRead', 'fb:sendSeen',
    'fb:getUserInfoFacebookHtml', 'fb:refreshContactAvatar',
  ];
  test.each(usedByEmployees)('allows %s', (channel) => {
    expect(isEmployeeChannelAllowed(channel)).toBe(true);
  });

  // Boss-only features and admin surfaces must never run on the boss on an employee's behalf.
  const bossOnly = [
    'browserProfile:list', 'browserProfile:open', 'browserProfile:create', 'browserProfile:delete',
    'facebookPoster:start', 'facebookPoster:stop',
    'facebookPoster:checkLogins', 'facebookPoster:getLoginStates', 'facebookPoster:getLoginCheckConfig', 'facebookPoster:setLoginCheckConfig',
    'facebookPoster:trackPosts', 'facebookPoster:trackStatus', 'facebookPoster:trackCancel', 'facebookPoster:listTracking',
    'facebookPoster:postStats', 'facebookPoster:groupScores', 'facebookPoster:bestTimes', 'facebookPoster:getTrackConfig', 'facebookPoster:setTrackConfig',
    'facebookPoster:leadList', 'facebookPoster:leadUpdate', 'facebookPoster:leadConfigGet', 'facebookPoster:leadConfigSet', 'facebookPoster:leadExport',
    'facebookPoster:commentCollect', 'facebookPoster:commentCollectStatus', 'facebookPoster:commentCollectCancel', 'facebookPoster:listLeadReplies',
    'engagement:list', 'engagement:approve', 'engagement:reject', 'engagement:cancel',
    'facebookPoster:campaignList', 'facebookPoster:campaignGet', 'facebookPoster:campaignCreate',
    'facebookPoster:campaignUpdate', 'facebookPoster:campaignDelete',
    'research:getConfig', 'research:setConfig', 'research:search', 'research:scanGroupFeeds', 'research:list',
    'research:get', 'research:cancel', 'research:profileUsage', 'research:exportXlsx', 'research:status', 'research:openLink',
    'video:settingsGet', 'video:settingsSet', 'video:testConnection', 'video:templates', 'video:musicPreview', 'video:render',
    'video:status', 'video:list', 'video:cancel', 'video:delete', 'video:exportFile',
    'controlApi:createKey', 'controlApi:setConfig', 'controlApi:getConfig', 'controlApi:listKeys', 'controlApi:revokeKey',
    'controlApi:listAudit', 'controlApi:firewallCommand', 'controlApi:regenerateCertificate',
    'controlApi:createPairing', 'controlApi:cancelPairing',
    'relay:startServer', 'relay:kickEmployee', 'relay:startTunnel',
    'employee:create', 'employee:setPermissions', 'employee:assignAccounts',
    'workspace:switch', 'workspace:delete',
    'proxy:save', 'proxy:delete', 'proxy:list',
    'lockScreen:setPin', 'login:loginQR', 'login:removeAccount',
    'telegram:sendMessage',
    'fb:updateCookie', 'fb:addAccount', 'fb:removeAccount', 'fb:historySync:start', 'fb:toggleE2EE', 'fb:scanGetTabs', 'fb:notClassified',
    'shell:openExternal', 'util:fetchUrl',
    'db:setStoragePath', 'db:saveAccount', 'db:selectStorageFolder', 'db:getSetting', 'db:setSetting',
    'ai:chat', 'ai:generateImage', 'zalo:', 'db:',
    // names the employee app never sends and the old prefix rule let through
    'db:saveStickers', 'db:upsertGroupMember', 'db:saveFriendRequests', 'db:upsertBankCard', 'zalo:notARealHandler',
  ];
  test.each(bossOnly)('denies %s', (channel) => {
    expect(isEmployeeChannelAllowed(channel)).toBe(false);
  });

  test('denies the bare-named writes the boss has no handler for (only db:<name> exists)', () => {
    for (const c of ['saveStickers', 'addRecentSticker', 'upsertGroupMember', 'removeGroupMember', 'saveFriendRequests',
      'saveKeywordStickers', 'saveStickerPacks', 'markStickerUnsupported', 'upsertBankCard', 'deleteBankCard',
      'assignLocalLabelToThread', 'bulkAssignLocalLabelToThread', 'removeLocalLabelFromThread'])
      expect(isEmployeeChannelAllowed(c)).toBe(false);
  });

  test('denies empty, non-string and look-alike channels', () => {
    for (const c of ['', 'zalo', 'zalox:send', ' zalo:send', 'db', 'saveStickersX', 'login:connectX', undefined, null, 42])
      expect(isEmployeeChannelAllowed(c as any)).toBe(false);
  });

  test('every channel the employee app proxies is in the closed list (source scan)', () => {
    const files = [
      ...sourceFiles(path.join(ROOT, 'electron'), /\.ts$/),
      ...sourceFiles(path.join(ROOT, 'src/ui'), /\.(ts|tsx)$/),
    ];
    const call = /(?:proxyToBoss|proxyToBossWithResult|proxyAction)\(\s*(?:[\w.]+\s*,\s*)?(["'`])([^"'`]+)\1/g;
    const found = new Set<string>();
    for (const file of files) for (const m of fs.readFileSync(file, 'utf8').matchAll(call)) found.add(m[2]);
    // Bare names (no "prefix:") never worked on the boss; `zalo:${method}` is covered by the zalo handler test.
    const channels = [...found].filter((c) => /^[a-z]+:[A-Za-z]+$/.test(c));
    expect(channels.length).toBeGreaterThan(40); // the scan itself must keep finding call sites
    expect(channels.filter((c) => !EMPLOYEE_PROXY_CHANNELS.includes(c))).toEqual([]);
  });

  test('the zalo: channels equal the handlers registered in zaloIpc.ts (source scan)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'electron/ipc/zaloIpc.ts'), 'utf8');
    const handlers = new Set([...src.matchAll(/['"](zalo:\w+)['"]/g)].map((m) => m[1]));
    expect(handlers.size).toBeGreaterThan(80);
    const listed = new Set(EMPLOYEE_PROXY_CHANNELS.filter((c) => c.startsWith('zalo:')));
    expect([...handlers].filter((c) => !listed.has(c))).toEqual([]);
    expect([...listed].filter((c) => !handlers.has(c))).toEqual([]);
  });

  test('every channel carries its module and account rule', () => {
    expect(employeeChannelRule('login:connect')).toEqual({ modules: [], account: 'default' });
    expect(employeeChannelRule('zalo:sendMessage')).toEqual({ modules: ['chat'], account: 'default' });
    expect(employeeChannelRule('zalo:sendFriendRequest')).toEqual({ modules: ['friends', 'chat'], account: 'default' });
    expect(employeeChannelRule('crm:saveNote')).toEqual({ modules: ['crm'], account: 'default' });
    expect(employeeChannelRule('ai:saveAssistant')).toEqual({ modules: ['ai_assistant'], account: 'none' });
    expect(employeeChannelRule('ai:setAccountAssistant')).toEqual({ modules: ['ai_assistant'], account: 'default' });
    expect(employeeChannelRule('integration:toggle')).toEqual({ modules: ['integration'], account: 'none' });
    expect(employeeChannelRule('db:markAsRead')).toEqual({ modules: ['chat'], account: 'default' });
    expect(employeeChannelRule('db:saveFriends')).toEqual({ modules: ['friends', 'chat'], account: 'default' });
    expect(employeeChannelRule('fb:sendMessage')).toEqual({ modules: ['chat'], account: 'required' });
    expect(employeeChannelRule('fb:getThreads')).toEqual({ modules: ['chat'], account: 'required' });
    expect(employeeChannelRule('db:setStoragePath')).toBeNull();
    expect(employeeChannelRule(42)).toBeNull();
  });
});
