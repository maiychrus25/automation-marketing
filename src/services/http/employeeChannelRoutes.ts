/**
 * Where each `fb:*` and Telegram (`telegramUser:*`, `telegram:*`) IPC channel runs when the employee app calls it (pure, no imports).
 *  - 'proxy':     the boss runs it for the employee (Page inbox: read, send, react, mark read).
 *  - 'local':     the employee's own machine answers it (scan tabs/logs kept locally); never sent to the boss.
 *  - 'boss_only': accounts, login, cookies, connection, Page on/off, E2EE, history sync, network scans,
 *                 edit/recall/forward/pin/poll/group/block/notes. The employee gets BOSS_ONLY_CHANNEL_ERROR.
 * A `fb:*` channel that is not listed here is not reachable (the relay's closed list is built from the
 * `proxy` entries only). A source-scan test fails when a handler is added without being classified.
 */

export type EmployeeChannelRoute = 'proxy' | 'boss_only' | 'local';

export interface EmployeeChannelSpec {
    route: EmployeeChannelRoute;
    /** The employee needs ONE of these modules (proxy only). */
    modules?: readonly string[];
    /** How long the employee app waits for the boss (proxy only). */
    timeoutMs?: number;
    /** The command sends a message, so the relay records which employee sent it. */
    send?: boolean;
}

export const PROXY_DEFAULT_TIMEOUT_MS = 30000;
export const PROXY_MEDIUM_TIMEOUT_MS = 60000;
export const PROXY_SLOW_TIMEOUT_MS = 90000;

export const BOSS_ONLY_CHANNEL_ERROR = 'Thao tác này chỉ thực hiện được trên máy Boss';
export const BOSS_ONLY_CHANNEL_CODE = 'BOSS_ONLY';

const CHAT = ['chat'] as const;
const FRIENDS_CHAT = ['friends', 'chat'] as const;
const proxy = (timeoutMs: number, send = false, modules: readonly string[] = CHAT): EmployeeChannelSpec => ({ route: 'proxy', modules, timeoutMs, ...(send ? { send: true } : {}) });
const LOCAL: EmployeeChannelSpec = { route: 'local' };
const BOSS_ONLY: EmployeeChannelSpec = { route: 'boss_only' };

const PROXY_ROUTES: Record<string, EmployeeChannelSpec> = {
    'fb:getThreads': proxy(PROXY_SLOW_TIMEOUT_MS),
    'fb:getMessages': proxy(PROXY_DEFAULT_TIMEOUT_MS),
    'fb:fetchThreadMessages': proxy(PROXY_MEDIUM_TIMEOUT_MS),
    'fb:fetchOlderMessages': proxy(PROXY_MEDIUM_TIMEOUT_MS),
    'fb:sendMessage': proxy(PROXY_MEDIUM_TIMEOUT_MS, true),
    'fb:sendAttachment': proxy(PROXY_SLOW_TIMEOUT_MS, true),
    'fb:sendAttachments': proxy(PROXY_SLOW_TIMEOUT_MS, true),
    'fb:sendPageSticker': proxy(PROXY_MEDIUM_TIMEOUT_MS, true),
    'fb:listPageStickers': proxy(PROXY_DEFAULT_TIMEOUT_MS),
    'fb:addReaction': proxy(PROXY_DEFAULT_TIMEOUT_MS),
    'fb:markAsRead': proxy(PROXY_DEFAULT_TIMEOUT_MS),
    'fb:sendSeen': proxy(PROXY_DEFAULT_TIMEOUT_MS),
    'fb:getUserInfoFacebookHtml': proxy(PROXY_DEFAULT_TIMEOUT_MS),
    'fb:refreshContactAvatar': proxy(PROXY_DEFAULT_TIMEOUT_MS),
};

const LOCAL_NAMES = [
    'saveScanLog', 'getScanLogs', 'scanResetCache', 'scanSaveTab', 'scanGetTabs', 'scanGetTab', 'scanUpdateTabStatus',
    'scanDeleteTab', 'scanTouchTab', 'scanSaveTabData', 'scanGetTabData', 'scanSaveRequestLog', 'scanGetRequestLogs', 'scanGetStats',
];

const BOSS_ONLY_NAMES = [
    'addAccount', 'addAccountWithCredentials', 'removeAccount', 'updateCookie', 'refreshProfile', 'getAccounts', 'listPages',
    'setPageEnabled', 'connect', 'disconnect', 'checkHealth', 'loginWithCredentials',
    'unsendMessage', 'editMessage', 'forwardMessage', 'pinMessage', 'unpinMessage', 'createPoll', 'votePoll', 'createNote',
    'changeThreadName', 'changeThreadEmoji', 'changeThreadTheme', 'changeNickname', 'blockUser', 'unblockUser',
    'addGroupAdmin', 'removeGroupAdmin', 'changeApprovalMode', 'approvePendingMember', 'getGroupLink', 'setGroupLink',
    'sendE2EEMessage', 'getE2EEStatus', 'toggleE2EE', 'sendTyping',
    'scanGroupMembers', 'scanGroupKeyword', 'scanFanpageKeyword', 'scanPostComments', 'scanPostKeyword', 'scanPostTimeline',
    'scanGroupMembersBatch', 'scanPostCommentsBatch',
];

export const FACEBOOK_CHANNEL_ROUTES: Readonly<Record<string, EmployeeChannelSpec>> = {
    ...PROXY_ROUTES,
    ...Object.fromEntries(LOCAL_NAMES.map((name) => [`fb:${name}`, LOCAL])),
    ...Object.fromEntries(BOSS_ONLY_NAMES.map((name) => [`fb:${name}`, BOSS_ONLY])),
    'fb:historySync:start': BOSS_ONLY,
    'fb:historySync:cancel': BOSS_ONLY,
    'fb:historySync:status': BOSS_ONLY,
};

// Telegram (user accounts and bots). Every handler not listed below as boss_only is proxied; the source-scan test fails when one is not classified.
const TG_FILE_SENDS = [
    'telegramUser:sendFile', 'telegramUser:sendTopicFile', 'telegramUser:editChatPhoto',
    ...['sendPhoto', 'sendVideo', 'sendDocument', 'sendAudio', 'sendVoice', 'sendSticker', 'sendAnimation', 'sendVideoNote', 'setChatPhoto'].map((n) => `telegram:${n}`),
];
const TG_SLOW_READS = [
    'telegramUser:getMessages', 'telegramUser:getForumTopicMessages', 'telegramUser:repairMessageMedia', 'telegramUser:repairEmptyMessages',
    'telegramUser:repairMessageQuotes', 'telegramUser:getGroupMembers',
];
const TG_TEXT_OPS = [
    ...['sendMessage', 'sendTopicMessage', 'sendSticker', 'sendGif', 'editMessage', 'deleteMessages', 'forwardMessages'].map((n) => `telegramUser:${n}`),
    ...['sendMessage', 'editMessage', 'editMessageCaption', 'deleteMessage', 'forwardMessage', 'sendPoll', 'sendContact', 'sendLocation'].map((n) => `telegram:${n}`),
];
const TG_SENDS = new Set([
    ...['sendMessage', 'sendFile', 'sendTopicMessage', 'sendTopicFile', 'sendSticker', 'sendGif', 'forwardMessages'].map((n) => `telegramUser:${n}`),
    ...['sendMessage', 'sendPhoto', 'sendVideo', 'sendDocument', 'sendAudio', 'sendVoice', 'sendSticker', 'sendAnimation', 'sendVideoNote', 'sendContact', 'sendLocation', 'sendPoll', 'forwardMessage'].map((n) => `telegram:${n}`),
]);
const TG_FRIENDS = new Set(['blockUser', 'unblockUser', 'searchContacts', 'resolveUsername', 'getPeers'].map((n) => `telegramUser:${n}`));
const TG_BOSS_ONLY = [
    ...['sendCode', 'signIn', 'signIn2FA', 'startListener', 'stopListener', 'isConnected', 'getActive', 'fetchSelfAvatar', 'checkForumForNewGroups', 'refreshMessages'].map((n) => `telegramUser:${n}`),
    ...['validateBot', 'startBot', 'stopBot', 'isBotPolling', 'getActiveBots'].map((n) => `telegram:${n}`),
];
const TG_PROXY_NAMES = [
    'getBotCommands', 'requestWebView', 'requestMainWebView', 'prolongWebView', 'refreshContactAvatar', 'sendMessage', 'editMessage', 'deleteMessages', 'forwardMessages',
    'pinMessage', 'syncPinnedMessages', 'ensureMessageAvailable', 'sendFile', 'sendTopicFile', 'sendTyping', 'sendReaction', 'getGroupInfo', 'getGroupMembers',
    'addChatUser', 'deleteChatUser', 'editChatTitle', 'editChatPhoto', 'editChatAdmin', 'leaveChat', 'blockUser', 'unblockUser', 'exportChatInvite', 'readChatHistory',
    'readForumTopic', 'getMessages', 'joinGroup', 'hydrateMessageSenders', 'setDialogMute', 'setDialogArchived', 'setDialogPin', 'getMessageReactions',
    'repairMessageMedia', 'repairEmptyMessages', 'repairMessageQuotes', 'getFullChat', 'getUserProfile', 'resolveUsername', 'searchContacts', 'getPeers', 'isForum',
    'getForumTopics', 'getForumTopicMessages', 'createForumTopic', 'editForumTopic', 'sendTopicMessage', 'getStickerSets', 'getStickerSetStickers',
    'getRecentStickers', 'getGifs', 'searchGifs', 'sendSticker', 'sendGif', 'downloadSticker',
].map((n) => `telegramUser:${n}`).concat([
    'sendMessage', 'sendPhoto', 'sendVideo', 'sendDocument', 'sendAudio', 'forwardMessage', 'deleteMessage', 'addReaction', 'pinMessage', 'sendPoll', 'editMessage',
    'getChat', 'getChatAdministrators', 'getChatMember', 'banChatMember', 'unbanChatMember', 'promoteChatMember', 'leaveChat', 'setChatPhoto', 'exportChatInviteLink',
    'deleteChatPhoto', 'setChatDescription', 'sendSticker', 'sendVoice', 'sendAnimation', 'sendVideoNote', 'sendContact', 'sendLocation', 'sendChatAction',
    'unpinChatMessage', 'getChatMemberCount', 'restrictChatMember', 'editMessageCaption',
].map((n) => `telegram:${n}`));

function telegramTimeout(channel: string): number {
    if (TG_FILE_SENDS.includes(channel) || TG_SLOW_READS.includes(channel)) return PROXY_SLOW_TIMEOUT_MS;
    return TG_TEXT_OPS.includes(channel) ? PROXY_MEDIUM_TIMEOUT_MS : PROXY_DEFAULT_TIMEOUT_MS;
}

export const TELEGRAM_CHANNEL_ROUTES: Readonly<Record<string, EmployeeChannelSpec>> = {
    ...Object.fromEntries(TG_PROXY_NAMES.map((c) => [c, proxy(telegramTimeout(c), TG_SENDS.has(c), TG_FRIENDS.has(c) ? FRIENDS_CHAT : CHAT)])),
    ...Object.fromEntries(TG_BOSS_ONLY.map((c) => [c, BOSS_ONLY])),
};

// Facebook poster ("Đăng Facebook") and browser profiles. Every channel of facebookPosterIpc.ts and browserProfileIpc.ts is classified here;
// the proxied ones need the fb_poster module AND pass the profile rules of posterAccess.ts (the employee only reaches the profiles the boss assigned).
const FB_POSTER = ['fb_poster'] as const;
const POSTER_SLOW_NAMES = ['start', 'draftApprove', 'scheduleCreate', 'draftSave', 'checkLogins', 'trackPosts', 'commentCollect'];
const POSTER_PROXY_NAMES = [
    'start', 'cancel', 'active', 'scheduleCreate', 'scheduleList', 'scheduleUpdate', 'scheduleDelete', 'campaignList', 'campaignGet', 'campaignCreate',
    'campaignUpdate', 'campaignDelete', 'draftSave', 'draftGet', 'draftApprove', 'listGroups', 'listRuns', 'getRun', 'listComments', 'listPostedUrls',
    'checkLogins', 'getLoginStates', 'trackPosts', 'trackStatus', 'trackCancel', 'listTracking', 'postStats', 'groupScores', 'bestTimes', 'getTrackConfig',
    'setTrackConfig', 'pageMetrics', 'leadList', 'leadUpdate', 'leadConfigGet', 'leadConfigSet', 'commentCollect', 'commentCollectStatus',
    'commentCollectCancel', 'listLeadReplies',
];
/** Proxied poster commands that only read (lists, gets, statuses, stats, the profile list). */
const POSTER_READ_NAMES = [
    'active', 'scheduleList', 'campaignList', 'campaignGet', 'draftGet', 'listGroups', 'listRuns', 'getRun', 'listComments', 'listPostedUrls',
    'getLoginStates', 'trackStatus', 'listTracking', 'postStats', 'groupScores', 'bestTimes', 'getTrackConfig', 'pageMetrics', 'leadList',
    'leadConfigGet', 'commentCollectStatus', 'listLeadReplies',
];
/** Proxied poster commands that create, change, delete or start something. A new proxied channel must be listed in one of the two (a test pins it). */
const POSTER_WRITE_NAMES = [
    'start', 'cancel', 'scheduleCreate', 'scheduleUpdate', 'scheduleDelete', 'campaignCreate', 'campaignUpdate', 'campaignDelete', 'draftSave',
    'draftApprove', 'checkLogins', 'trackPosts', 'trackCancel', 'setTrackConfig', 'leadUpdate', 'leadConfigSet', 'commentCollect', 'commentCollectCancel',
];
export const POSTER_READ_CHANNELS: ReadonlySet<string> = new Set([...POSTER_READ_NAMES.map((n) => `facebookPoster:${n}`), 'browserProfile:list']);
/** Relayed poster commands that write: the boss log records which employee ran each one that succeeded. */
export const POSTER_WRITE_CHANNELS: ReadonlySet<string> = new Set(POSTER_WRITE_NAMES.map((n) => `facebookPoster:${n}`));
const POSTER_BOSS_ONLY = [
    'facebookPoster:takeMissed', 'facebookPoster:current', 'facebookPoster:exportRunCsv', 'facebookPoster:leadExport',
    'facebookPoster:getLoginCheckConfig', 'facebookPoster:setLoginCheckConfig', 'facebookPoster:getNotificationConfig', 'facebookPoster:setNotificationConfig',
    ...['list', 'approve', 'reject', 'cancel'].map((n) => `engagement:${n}`),
    ...['status', 'setConfig', 'stop', 'resume', 'resumeProfile', 'changes'].map((n) => `autonomy:${n}`),
    ...['create', 'update', 'delete', 'setProxy', 'open', 'close', 'saveGroup', 'deleteGroup', 'engineStatus', 'sandboxStatus', 'installEngine'].map((n) => `browserProfile:${n}`),
];

export const POSTER_CHANNEL_ROUTES: Readonly<Record<string, EmployeeChannelSpec>> = {
    ...Object.fromEntries(POSTER_PROXY_NAMES.map((n) => [`facebookPoster:${n}`, proxy(POSTER_SLOW_NAMES.includes(n) ? PROXY_SLOW_TIMEOUT_MS : PROXY_DEFAULT_TIMEOUT_MS, false, FB_POSTER)])),
    'browserProfile:list': proxy(PROXY_DEFAULT_TIMEOUT_MS, false, FB_POSTER),
    'facebookPoster:pickMedia': LOCAL,
    ...Object.fromEntries(POSTER_BOSS_ONLY.map((c) => [c, BOSS_ONLY])),
};

export const EMPLOYEE_CHANNEL_ROUTES: Readonly<Record<string, EmployeeChannelSpec>> = { ...FACEBOOK_CHANNEL_ROUTES, ...TELEGRAM_CHANNEL_ROUTES, ...POSTER_CHANNEL_ROUTES };

export function employeeChannelSpec(channel: string): EmployeeChannelSpec | null {
    return Object.prototype.hasOwnProperty.call(EMPLOYEE_CHANNEL_ROUTES, channel) ? EMPLOYEE_CHANNEL_ROUTES[channel] : null;
}

/** What the relay needs to record who sent a message: only for a successful `send` command. `messageIds` are the rows the send saved (empty when it returned none): the relay tags those ids only, never a guess by thread. */
export function employeeSendInfo(channel: string, params: unknown, result: unknown): { accountId: string; threadId: string; messageIds: string[] } | null {
    if (!employeeChannelSpec(channel)?.send) return null;
    const res = result as { success?: unknown; messageId?: unknown; messageIds?: unknown } | null | undefined;
    if (res?.success !== true) return null;
    const p = (params ?? {}) as { accountId?: unknown; threadId?: unknown; chatId?: unknown; toChatId?: unknown };
    // Page uses threadId; Telegram uses chatId (a forward goes to toChatId) and never reads threadId: it is not where the message goes.
    const candidates = channel.startsWith('telegram') ? [p.chatId, p.toChatId] : [p.threadId, p.chatId, p.toChatId];
    const thread = candidates.find((v) => typeof v === 'string' && v !== '');
    return {
        accountId: typeof p.accountId === 'string' ? p.accountId : '',
        threadId: typeof thread === 'string' ? thread : '',
        messageIds: (Array.isArray(res.messageIds) ? res.messageIds : [res.messageId]).filter((id): id is string => typeof id === 'string' && id !== ''),
    };
}

/**
 * May a handler body run on this machine for this channel? Only an employee machine restricts it, and then only a `local` channel
 * (pickMedia) may: `proxy` and `boss_only` are sent to / refused for the boss before the body (a spoofed `_fromRelay` skips that routing, not this),
 * and an unclassified channel stays blocked.
 */
export function handlerMayRunHere(employeeMode: boolean, channel: string): boolean {
    return !employeeMode || employeeChannelSpec(channel)?.route === 'local';
}
