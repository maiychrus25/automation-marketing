/**
 * Dựng `parent_zalo_id` cho dòng `accounts` từ bảng `fb_accounts` (bảng `accounts` không có cột này)
 * và quyết định một tài khoản có đang kết nối hay không. Thuần: không import Electron/DB.
 */

export interface FbAccountRef {
    facebook_id?: string | null;
    parent_facebook_id?: string | null;
    /** 0 = the boss switched the Page off (setFBPageEnabled); column is NOT NULL DEFAULT 1. */
    enabled?: number | null;
}

// Page = dòng Facebook có `parent_facebook_id`. Thiếu dòng fb_accounts => null (đóng: coi là cá nhân).
export function withFacebookParents<T extends { zalo_id: string; channel?: string | null }>(
    accounts: readonly T[],
    fbAccounts: readonly FbAccountRef[],
): Array<T & { parent_zalo_id: string | null; enabled?: number }> {
    const parentOf = new Map<string, string | null>();
    const switchedOff = new Set<string>();
    for (const fb of fbAccounts) {
        if (!fb.facebook_id) continue;
        parentOf.set(fb.facebook_id, fb.parent_facebook_id || null);
        if (fb.enabled === 0) switchedOff.add(fb.facebook_id);
    }
    return accounts.map((acc) => ({
        ...acc,
        parent_zalo_id: acc.channel === 'facebook' ? (parentOf.get(acc.zalo_id) ?? null) : null,
        ...(acc.channel === 'facebook' && switchedOff.has(acc.zalo_id) ? { enabled: 0 } : {}),
    }));
}

export function isAccountOnline(
    row: { zalo_id: string; channel?: string | null },
    deps: {
        zaloConnected: (id: string) => boolean;
        facebookConnected: (facebookId: string) => boolean;
        telegramUserConnected: (id: string) => boolean;
        telegramBotPolling: (id: string) => boolean;
    },
): boolean {
    if (row.channel === 'telegram_user') return deps.telegramUserConnected(row.zalo_id);
    if (row.channel === 'telegram_bot') return deps.telegramBotPolling(row.zalo_id);
    return row.channel === 'facebook' ? deps.facebookConnected(row.zalo_id) : deps.zaloConnected(row.zalo_id);
}
