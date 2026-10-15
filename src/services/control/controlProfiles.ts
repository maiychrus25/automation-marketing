import type { BrowserProfile, BrowserProfileGroup } from '../../models/browserProfile';
import type { FbPosterGroup, LoginState, ProfileLoginState } from '../../models/facebookPoster';

export interface SafeProfile {
    id: string;
    name: string;
    groupId: number | null;
    groupName: string | null;
    running: boolean;
    lastOpenedAt: number | null;
    createdAt: number;
    /** Lần quét nhóm Facebook gần nhất của profile (mili giây epoch), null nếu chưa quét. */
    lastScannedAt: number | null;
    /** Trạng thái đăng nhập Facebook đã lưu; 'unknown' khi chưa từng kiểm tra. */
    loginState: LoginState | 'unknown';
    loginCheckedAt: number | null;
    loginError: string | null;
}

/** Chỉ các trường an toàn: không fingerprint, không proxy (id hay thông tin đăng nhập), không ghi chú, không cookie. */
export function toSafeProfiles(profiles: BrowserProfile[], groups: BrowserProfileGroup[], runningIds: string[],
    scannedGroups: Record<string, Pick<FbPosterGroup, 'scannedAt'>[]> = {}, loginStates: ProfileLoginState[] = []): SafeProfile[] {
    const logins = new Map(loginStates.map((l) => [l.profileId, l]));
    const groupNames = new Map(groups.map((g) => [g.id, g.name]));
    const running = new Set(runningIds);
    return profiles.map((p) => {
        const login = logins.get(p.id);
        return {
            id: p.id,
            name: p.name,
            groupId: p.group_id,
            groupName: p.group_id === null ? null : groupNames.get(p.group_id) ?? null,
            running: running.has(p.id),
            lastOpenedAt: p.last_opened_at,
            createdAt: p.created_at,
            lastScannedAt: (scannedGroups[p.id] ?? []).reduce<number | null>((max, g) => (max === null || g.scannedAt > max ? g.scannedAt : max), null),
            loginState: login?.state ?? 'unknown',
            loginCheckedAt: login?.checkedAt ?? null,
            loginError: login?.lastError ?? null,
        };
    });
}
