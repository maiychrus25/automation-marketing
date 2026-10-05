import { isEmployeeChannelAllowed } from '../../services/http/relayChannelPolicy';

describe('isEmployeeChannelAllowed', () => {
  // Every channel the employee app sends to the boss today (proxyToBoss / proxyAction call sites).
  const usedByEmployees = [
    'login:connect',
    'zalo:sendMessage', 'zalo:getContext', 'zalo:getLabels', 'zalo:updateLabels',
    'crm:saveNote', 'crm:deleteNote', 'crm:saveCampaign', 'crm:addCampaignContacts', 'crm:updateCampaignStatus',
    'ai:saveAssistant', 'ai:deleteAssistant', 'ai:uploadFile', 'ai:removeFile', 'ai:setAccountAssistant',
    'integration:save', 'integration:delete', 'integration:toggle',
    'db:markAsRead', 'db:deleteMessages', 'db:saveFriends', 'db:pinMessage', 'db:upsertLocalLabel',
    // the boss handlers for the bare-named mirror writes are db:-prefixed
    'db:saveStickers', 'db:upsertGroupMember', 'db:saveFriendRequests', 'db:upsertBankCard',
  ];
  test.each(usedByEmployees)('allows %s', (channel) => {
    expect(isEmployeeChannelAllowed(channel)).toBe(true);
  });

  // Boss-only features and admin surfaces must never run on the boss on an employee's behalf.
  const bossOnly = [
    'browserProfile:list', 'browserProfile:open', 'browserProfile:create', 'browserProfile:delete',
    'facebookPoster:start', 'facebookPoster:stop',
    'relay:startServer', 'relay:kickEmployee', 'relay:startTunnel',
    'employee:create', 'employee:setPermissions', 'employee:assignAccounts',
    'workspace:switch', 'workspace:delete',
    'proxy:save', 'proxy:delete', 'proxy:list',
    'lockScreen:setPin', 'login:loginQR', 'login:removeAccount',
    'telegram:sendMessage', 'fb:sendMessage',
    'shell:openExternal', 'util:fetchUrl',
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
});
