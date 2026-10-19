import type { ProfileLoginState } from '../../models/facebookPoster';

export interface RotationInput {
    profiles: { id: string; name: string }[];
    excluded: string[];
    busyIds: string[];
    loginStates: ProfileLoginState[];
    usedLast24h: Record<string, number>;
    lastUsedAt: Record<string, number>;
    cap: number;
    restrictTo?: string[];
    failedInScan: string[];
}

/** Số mục còn được quét hôm nay của một profile (không âm). */
export function remainingToday(profileId: string, usedLast24h: Record<string, number>, cap: number): number {
    return Math.max(0, cap - (usedLast24h[profileId] ?? 0));
}

/** Profile đủ điều kiện, sắp theo: ít mục 24h nhất, rồi lâu chưa dùng nhất, rồi thứ tự đầu vào (spec §5). */
export function eligibleProfiles(input: RotationInput): string[] {
    const blocked = new Set([...input.excluded, ...input.busyIds, ...input.failedInScan]);
    for (const row of input.loginStates) {
        if (row.state === 'logged_out' || row.state === 'checkpoint') blocked.add(row.profileId);
    }
    const allowed = input.restrictTo ? new Set(input.restrictTo) : null;
    return input.profiles
        .map((profile, index) => ({ id: profile.id, index }))
        .filter(({ id }) => !blocked.has(id)
            && (!allowed || allowed.has(id))
            && remainingToday(id, input.usedLast24h, input.cap) > 0)
        .sort((x, y) =>
            (input.usedLast24h[x.id] ?? 0) - (input.usedLast24h[y.id] ?? 0)
            || (input.lastUsedAt[x.id] ?? 0) - (input.lastUsedAt[y.id] ?? 0)
            || x.index - y.index)
        .map(({ id }) => id);
}

/** Dạng chuẩn để so sánh URL nhóm: host chữ thường, bỏ query/hash và dấu / cuối. */
function canonicalGroupUrl(raw: string): string {
    try {
        const url = new URL(raw);
        return `${url.protocol}//${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
        return raw.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
    }
}

/** Chọn profile cho một nhóm: ưu tiên profile đã tham gia (theo thứ tự `eligible`), không có thì profile đầu tiên. */
export function pickGroupProfile(
    groupUrl: string,
    membership: Record<string, string[]>,
    eligible: string[],
): string | null {
    const target = canonicalGroupUrl(groupUrl);
    const joined = eligible.find(id => (membership[id] ?? []).some(url => canonicalGroupUrl(url) === target));
    return joined ?? eligible[0] ?? null;
}
