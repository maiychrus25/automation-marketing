/**
 * Which IPC channels an employee may run on the boss through the relay (`/api/proxy/action`),
 * and what each one needs: the module permission and whether it acts on an account.
 *
 * Closed list of exact names, fail-closed: a channel that is not listed is refused, so a new
 * boss-only feature (settings, storage path, browser profiles, relay/employee admin…) can never be
 * reached by an employee because nobody remembered to deny it. The boss-side handler's own
 * `isEmployeeMode()` guard does not help here: on the boss that check is false.
 *
 * The list mirrors what the employee app sends (every `proxyToBoss(...)`, `proxyToBossWithResult(...)`
 * and `proxyAction(...)` call site) plus every `zalo:*` handler of `electron/ipc/zaloIpc.ts`
 * (the employee renderer proxies those as `zalo:${method}`). Two source-scan tests in
 * `src/__tests__/http/relayChannelPolicy.test.ts` fail when the code and this list drift apart.
 * The employee app also sends bare-named writes (`saveStickers`, `upsertGroupMember`, …); the boss
 * has no handler under those names, so they never worked and are not listed.
 */

export interface EmployeeChannelRule {
    /** The employee needs ONE of these modules; empty = no module needed. */
    modules: readonly string[];
    /** 'default': act on the account in the params, else on the employee's first usable account. 'none': no account. */
    account: 'default' | 'none';
}

const CHAT = ['chat'] as const;
const FRIENDS_CHAT = ['friends', 'chat'] as const;

const ZALO_CHAT = [
    'sendMessage', 'sendSticker', 'sendImage', 'sendImages', 'sendFile', 'sendVoice', 'uploadVoiceFile',
    'sendVideo', 'uploadVideoThumb', 'uploadVideoFile', 'sendLink', 'sendCard', 'undoMessage', 'deleteMessage',
    'deleteChat', 'addReaction', 'forwardMessage', 'getMessageHistory', 'getGroupChatHistory', 'getUserInfo',
    'getContext', 'getRelatedFriendGroup', 'getGroups', 'getGroupInfo', 'createGroup', 'addUserToGroup',
    'removeUserFromGroup', 'leaveGroup', 'changeGroupName', 'changeGroupAvatar', 'changeGroupOwner',
    'disperseGroup', 'addGroupDeputy', 'removeGroupDeputy', 'getGroupMembersInfo', 'addGroupBlockedMember',
    'removeGroupBlockedMember', 'getGroupBlockedMember', 'inviteUserToGroups', 'updateGroupSettings',
    'getGroupLinkDetail', 'getGroupLinkInfo', 'joinGroupLink', 'enableGroupLink', 'disableGroupLink',
    'getPendingGroupMembers', 'reviewPendingMemberRequest', 'getPinConversations', 'setPinConversation',
    'setMute', 'getLabels', 'updateLabels', 'getStickers', 'getStickersDetail', 'getStickerCategoryDetail',
    'keepAlive', 'addUnreadMark', 'removeUnreadMark', 'createPoll', 'getPollDetail', 'lockPoll', 'doVotePoll',
    'addPollOption', 'getQuickMessageList', 'addQuickMessage', 'updateQuickMessage', 'removeQuickMessage',
    'createNote', 'editNote', 'createReminder', 'editReminder', 'removeReminder', 'getListReminder',
    'getReminder', 'sendSeenEvent', 'sendBankCard',
];
const ZALO_FRIENDS = [
    'acceptFriendRequest', 'rejectFriendRequest', 'sendFriendRequest', 'undoFriendRequest', 'removeFriend',
    'getFriends', 'getFriendRecommendations', 'getFriendRequestStatus', 'getSentFriendRequests', 'findUser',
    'blockUser', 'unblockUser', 'changeFriendAlias', 'getAliasList',
];
const CRM = [
    'saveNote', 'deleteNote', 'saveCampaign', 'deleteCampaign', 'cloneCampaign', 'updateCampaignStatus', 'addCampaignContacts',
];
const AI_NO_ACCOUNT = [
    'listAssistants', 'getAssistant', 'getDefault', 'saveAssistant', 'deleteAssistant', 'testAssistant',
    'getFiles', 'uploadFile', 'removeFile', 'getUsageLogs', 'getUsageStats',
];
const AI_ACCOUNT = ['getAccountAssistant', 'setAccountAssistant', 'getAccountAssistants'];
const INTEGRATION = ['save', 'delete', 'toggle'];
const DB_CHAT = [
    'assignLocalLabelToThread', 'bringPinnedToTop', 'bulkAssignLocalLabelToThread', 'bulkReplaceLocalQuickMessages',
    'cloneLocalLabels', 'cloneLocalQuickMessages', 'deleteConversation', 'deleteLocalLabel', 'deleteLocalQuickMessage',
    'deleteMessages', 'markAsRead', 'markMessageRecalled', 'pinMessage', 'removeLocalLabelFromThread',
    'saveGroupMembers', 'saveLink', 'setContactAlias', 'setContactFlags', 'setLocalLabelActive', 'setLocalLabelOrder',
    'setLocalPinnedConversation', 'setLocalQMActive', 'setLocalQMOrder', 'unpinMessage', 'updateAccountPhone',
    'updateContactProfile', 'updateReaction', 'upsertLocalLabel', 'upsertLocalQuickMessage',
];
const DB_FRIENDS = ['addFriend', 'removeFriend', 'removeFriendRequest', 'saveFriends', 'upsertFriendRequest'];

const RULES = new Map<string, EmployeeChannelRule>();
const add = (prefix: string, names: readonly string[], modules: readonly string[], account: 'default' | 'none') => {
    for (const name of names) RULES.set(`${prefix}:${name}`, { modules, account });
};
add('login', ['connect'], [], 'default');
add('zalo', ZALO_CHAT, CHAT, 'default');
add('zalo', ZALO_FRIENDS, FRIENDS_CHAT, 'default');
add('crm', CRM, ['crm'], 'default');
add('ai', AI_NO_ACCOUNT, ['ai_assistant'], 'none');
add('ai', AI_ACCOUNT, ['ai_assistant'], 'default');
add('integration', INTEGRATION, ['integration'], 'none');
add('db', DB_CHAT, CHAT, 'default');
add('db', DB_FRIENDS, FRIENDS_CHAT, 'default');

export const EMPLOYEE_PROXY_CHANNELS: readonly string[] = [...RULES.keys()];

export function employeeChannelRule(channel: unknown): EmployeeChannelRule | null {
    return typeof channel === 'string' ? RULES.get(channel) ?? null : null;
}

export function isEmployeeChannelAllowed(channel: unknown): boolean {
    return employeeChannelRule(channel) !== null;
}
