import type { BrowserProfile, BrowserProfileGroup } from '../../models/browserProfile';

export interface SafeProfile {
    id: string;
    name: string;
    groupId: number | null;
    groupName: string | null;
    running: boolean;
    lastOpenedAt: number | null;
    createdAt: number;
}

/** Chỉ các trường an toàn: không fingerprint, không proxy (id hay thông tin đăng nhập), không ghi chú, không cookie. */
export function toSafeProfiles(profiles: BrowserProfile[], groups: BrowserProfileGroup[], runningIds: string[]): SafeProfile[] {
    const groupNames = new Map(groups.map((g) => [g.id, g.name]));
    const running = new Set(runningIds);
    return profiles.map((p) => ({
        id: p.id,
        name: p.name,
        groupId: p.group_id,
        groupName: p.group_id === null ? null : groupNames.get(p.group_id) ?? null,
        running: running.has(p.id),
        lastOpenedAt: p.last_opened_at,
        createdAt: p.created_at,
    }));
}
