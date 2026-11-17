/**
 * Pure rules for which accounts and modules an employee may use through the boss relay.
 * Fail-closed: an id outside the employee's allowed list is refused, including when the list is empty.
 * No imports on purpose (no Electron, no DB, no fs) so the rules stay trivially testable.
 */

// Every request key that can carry an account id (accounts of all channels share the `zalo_id` column).
export const ACCOUNT_PARAM_KEYS: readonly string[] = [
    'zaloId', 'zalo_id', 'zaloIds', 'zalo_ids', 'ownerZaloId', 'owner_zalo_id',
    'accountId', 'account_id', 'fbAccountId', 'sourceZaloId', 'targetZaloId',
];

export interface AccountRow {
    zalo_id: string;
    channel?: string | null;
    parent_zalo_id?: string | null;
    /** 0 = a Facebook Page the boss switched off. */
    enabled?: number | null;
}

export interface AccessDenied {
    status: 403;
    code: 'ACCOUNT_FORBIDDEN' | 'MODULE_FORBIDDEN';
    error: string;
}

// Personal Facebook accounts stay boss-only; a Facebook Page (has a parent) is usable unless the boss switched it off.
export function isEmployeeUsableAccount(row: AccountRow): boolean {
    return !(row.channel === 'facebook' && (!row.parent_zalo_id || row.enabled === 0));
}

export function allowedAccounts(assigned: readonly string[], accounts: readonly AccountRow[]): string[] {
    const usable = new Set(accounts.filter(isEmployeeUsableAccount).map((row) => row.zalo_id));
    return assigned.filter((id) => usable.has(id));
}

// Walks every recognised account slot. Strings/numbers/bigints are ids; anything else that is
// not null/undefined/array is malformed (fail closed: a handler might coerce it to an id).
function scanAccountParams(params: unknown): { ids: Set<string>; malformed: boolean } {
    const result = { ids: new Set<string>(), malformed: false };
    const visit = (value: unknown): void => {
        if (value === null || value === undefined) return;
        if (typeof value === 'string') {
            for (const part of value.split(',')) {
                const id = part.trim();
                if (id) result.ids.add(id);
            }
        } else if (typeof value === 'number' || typeof value === 'bigint') {
            result.ids.add(String(value));
        } else if (Array.isArray(value)) {
            value.forEach(visit);
        } else {
            result.malformed = true;
        }
    };
    if (params && typeof params === 'object') {
        const record = params as Record<string, unknown>;
        for (const key of ACCOUNT_PARAM_KEYS) visit(record[key]);
        const auth = record.auth;
        if (auth && typeof auth === 'object') {
            for (const key of ACCOUNT_PARAM_KEYS) visit((auth as Record<string, unknown>)[key]);
        }
    }
    return result;
}

export function requestedAccountIds(params: unknown): string[] {
    return [...scanAccountParams(params).ids];
}

export function hasMalformedAccountParam(params: unknown): boolean {
    return scanAccountParams(params).malformed;
}

// Targets (REST path or proxy channel) whose body keeps account ids in a nested slot the top-level scan does not see.
const LABEL_WRITE_TARGETS: ReadonlySet<string> = new Set(['/api/command/labels', 'db:upsertLocalLabel']);

/** Params to scan for account ids of `target`: the same params, plus `label.pageIds` of a label write (REST and proxy share this). */
export function paramsWithExtraAccountIds(target: string, params: any): any {
    if (!LABEL_WRITE_TARGETS.has(target) || !params?.label) return params;
    return { ...params, zaloIds: [params.zaloIds, params.label.pageIds] };
}

// First path segment after /api/<verb>/ -> module permission.
const MODULE_BY_SEGMENT: Record<string, string> = {
    analytics: 'analytics',
    crm: 'crm',
    erp: 'erp',
    ai: 'ai_assistant',
    workflows: 'workflow',
    integrations: 'integration',
    friends: 'friends',
    'friend-requests': 'friends',
    messages: 'chat',
    conversations: 'chat',
};

export function requiredModuleFor(pathname: string): string | undefined {
    if (pathname.startsWith('/api/search/')) return 'chat';
    const match = /^\/api\/(?:query|command)\/([^/?#]+)/.exec(pathname);
    return match ? MODULE_BY_SEGMENT[match[1]] : undefined;
}

const CHECKED_PREFIXES = ['/api/query/', '/api/search/', '/api/command/', '/api/library/'];

export function checkEmployeeAccess(input: {
    allowed: readonly string[];
    pathname: string;
    params: unknown;
    hasPermission: (module: string) => boolean;
}): AccessDenied | null {
    if (!CHECKED_PREFIXES.some((prefix) => input.pathname.startsWith(prefix))) return null;
    const allowed = new Set(input.allowed);
    if (hasMalformedAccountParam(input.params) || requestedAccountIds(input.params).some((id) => !allowed.has(id))) {
        return { status: 403, code: 'ACCOUNT_FORBIDDEN', error: 'Không có quyền truy cập tài khoản này' };
    }
    const module = requiredModuleFor(input.pathname);
    if (module && !input.hasPermission(module)) {
        return { status: 403, code: 'MODULE_FORBIDDEN', error: `Không có quyền truy cập module: ${module}` };
    }
    return null;
}

// Closed by default: no employee screen reads or writes settings over REST today.
const EMPLOYEE_READABLE_SETTING_KEYS: ReadonlySet<string> = new Set<string>();
const EMPLOYEE_WRITABLE_SETTING_KEYS: ReadonlySet<string> = new Set<string>();

export function isEmployeeSettingReadable(key: string): boolean {
    return EMPLOYEE_READABLE_SETTING_KEYS.has(key);
}

export function isEmployeeSettingWritable(key: string): boolean {
    return EMPLOYEE_WRITABLE_SETTING_KEYS.has(key);
}
