/**
 * Where each `fb:*` IPC channel runs when the employee app calls it (pure, no imports).
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
const proxy = (timeoutMs: number, send = false): EmployeeChannelSpec => ({ route: 'proxy', modules: CHAT, timeoutMs, ...(send ? { send: true } : {}) });
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

export function employeeChannelSpec(channel: string): EmployeeChannelSpec | null {
    return Object.prototype.hasOwnProperty.call(FACEBOOK_CHANNEL_ROUTES, channel) ? FACEBOOK_CHANNEL_ROUTES[channel] : null;
}

/** What the relay needs to record who sent a message: only for a successful `send` command. `messageIds` are the rows the send saved (empty when it returned none): the relay tags those ids only, never a guess by thread. */
export function employeeSendInfo(channel: string, params: unknown, result: unknown): { accountId: string; threadId: string; messageIds: string[] } | null {
    if (!employeeChannelSpec(channel)?.send) return null;
    const res = result as { success?: unknown; messageId?: unknown; messageIds?: unknown } | null | undefined;
    if (res?.success !== true) return null;
    const p = (params ?? {}) as { accountId?: unknown; threadId?: unknown };
    return {
        accountId: typeof p.accountId === 'string' ? p.accountId : '',
        threadId: typeof p.threadId === 'string' ? p.threadId : '',
        messageIds: (Array.isArray(res.messageIds) ? res.messageIds : [res.messageId]).filter((id): id is string => typeof id === 'string' && id !== ''),
    };
}
