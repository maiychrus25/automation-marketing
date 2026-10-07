import type { StartParams } from './FacebookPosterService';
import { dedupePaths, validateMediaSelection } from './mediaRules';
import { normalizeTarget, parseFacebookUrl } from './targets';

export interface StartParamsEnv {
    profileExists: (id: string) => boolean;
    fileExists: (path: string) => boolean;
    fileSize: (path: string) => number;
}

const MAX_TEXT = 63206;
const MAX_COMMENT = 8000;
const MAX_TARGETS = 10000;
const MAX_DELAY_SEC = 86400;
const BARE_TARGET = /^[A-Za-z0-9._-]+$/;
const PAGE_TARGET = 'https://www.facebook.com/';

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const asObject = (v: unknown): Record<string, any> => (v && typeof v === 'object' ? (v as Record<string, any>) : {});
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const uniqueTrimmed = (v: unknown): string[] =>
    [...new Set(asArray(v).filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean))];

function requireProfile(id: unknown, env: StartParamsEnv): string {
    if (typeof id !== 'string' || !env.profileExists(id)) throw new Error('Không tìm thấy profile');
    return id;
}

function readDelays(p: Record<string, any>): { minDelaySec: number; maxDelaySec: number } {
    const minDelaySec = p.minDelaySec ?? 300;
    const maxDelaySec = p.maxDelaySec ?? 900;
    const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_DELAY_SEC;
    if (!ok(minDelaySec) || !ok(maxDelaySec) || maxDelaySec < minDelaySec) throw new Error('Thời gian nghỉ không hợp lệ');
    return { minDelaySec, maxDelaySec };
}

const MAX_STAGGER_SEC = 3600;

/** Gap between consecutive profile starts; 0-0 starts every runner at once. */
function readStagger(p: Record<string, any>): { staggerMinSec: number; staggerMaxSec: number } {
    const staggerMinSec = p.staggerMinSec ?? 30;
    const staggerMaxSec = p.staggerMaxSec ?? 90;
    const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_STAGGER_SEC;
    if (!ok(staggerMinSec) || !ok(staggerMaxSec) || staggerMaxSec < staggerMinSec) throw new Error('Giãn cách khởi động không hợp lệ');
    return { staggerMinSec, staggerMaxSec };
}

function readConcurrency(p: Record<string, any>): number {
    const concurrency = p.concurrency ?? 3;
    if (!isInt(concurrency, 1, 10)) throw new Error('Số profile song song phải từ 1 đến 10');
    return concurrency;
}

function normalizeGroupTarget(raw: unknown): string {
    const line = typeof raw === 'string' ? raw.trim() : '';
    try {
        const t = normalizeTarget(line);
        const isUrl = /^https?:\/\//i.test(line);
        if (!line || t.kind !== 'group' || (!isUrl && !BARE_TARGET.test(line))) throw new Error('bad');
        return t.url;
    } catch {
        throw new Error(`Đích không hợp lệ: ${String(raw)}`);
    }
}

function readMediaPaths(p: Record<string, any>, env: StartParamsEnv): string[] {
    const raw: unknown[] = Array.isArray(p.mediaPaths) ? p.mediaPaths : (typeof p.mediaPath === 'string' && p.mediaPath ? [p.mediaPath] : []);
    const paths = dedupePaths(raw.filter((v): v is string => typeof v === 'string' && v.length > 0));
    for (const path of paths) if (!env.fileExists(path)) throw new Error('Không tìm thấy tệp ảnh/video');
    const problem = validateMediaSelection(paths.map((path) => ({ path, size: env.fileSize(path) })));
    if (problem) throw new Error(problem);
    return paths;
}

function validatePost(p: Record<string, any>, env: StartParamsEnv): StartParams {
    if (p.mode !== 'group' && p.mode !== 'page') throw new Error('Chế độ đăng không hợp lệ');
    const text = typeof p.text === 'string' ? p.text : '';
    if (!text.trim()) throw new Error('Nội dung bài không được để trống');
    if (text.length > MAX_TEXT) throw new Error(`Nội dung bài tối đa ${MAX_TEXT} ký tự`);
    const rawComment = typeof p.comment === 'string' ? p.comment : '';
    if (rawComment.length > MAX_COMMENT) throw new Error(`Bình luận tối đa ${MAX_COMMENT} ký tự`);

    const entries = asArray(p.profiles).map(asObject);
    if (!entries.length) throw new Error('Chưa chọn profile');
    const byProfile = new Map<string, string[]>();
    for (const entry of entries) {
        const id = requireProfile(entry.profileId, env);
        const lines = asArray(entry.targets).filter((t) => String(t ?? '').trim() !== '');
        const urls = p.mode === 'page' ? [PAGE_TARGET] : lines.map(normalizeGroupTarget);
        byProfile.set(id, [...new Set([...(byProfile.get(id) ?? []), ...urls])]);
    }
    let total = 0;
    for (const [id, targets] of byProfile) {
        if (!targets.length) throw new Error(`Profile "${id}" chưa có nhóm nào`);
        total += targets.length;
    }
    if (total > MAX_TARGETS) throw new Error(`Tối đa ${MAX_TARGETS} đích cho một lần chạy`);

    return {
        kind: 'post', mode: p.mode, text,
        mediaPaths: readMediaPaths(p, env),
        comment: rawComment.trim() ? rawComment : null,
        profiles: [...byProfile].map(([profileId, targets]) => ({ profileId, targets })),
        ...readDelays(p), concurrency: readConcurrency(p), ...readStagger(p),
    };
}

/** Pure check of the renderer's start request; throws a Vietnamese message the UI can show as-is. */
export function validateStartParams(input: { kind?: unknown; params?: unknown }, env: StartParamsEnv): StartParams {
    const p = asObject(input.params);
    switch (input.kind) {
        case 'post':
            return validatePost(p, env);
        case 'scan_groups': {
            const ids = [...new Set(asArray(p.profileIds))];
            if (!ids.length) throw new Error('Chưa chọn profile');
            return { kind: 'scan_groups', profileIds: ids.map((id) => requireProfile(id, env)), concurrency: readConcurrency(p), ...readStagger(p) };
        }
        case 'join': {
            const profileId = requireProfile(p.profileId, env);
            const keywords = uniqueTrimmed(p.keywords);
            if (!keywords.length) throw new Error('Chưa nhập từ khóa');
            const limit = p.limit ?? 10;
            if (!isInt(limit, 1, 200)) throw new Error('Giới hạn nhóm phải từ 1 đến 200');
            return { kind: 'join', profileId, keywords, limit, ...readDelays(p) };
        }
        case 'collect_comments': {
            const profileId = requireProfile(p.profileId, env);
            const trimmed = uniqueTrimmed(p.postUrls);
            if (!trimmed.length) throw new Error('Chưa chọn bài');
            const postUrls = [...new Set(trimmed.map((u) => {
                const parsed = parseFacebookUrl(u);
                if (!parsed) throw new Error(`Link bài không hợp lệ: ${u}`);
                return parsed.href;
            }))];
            return { kind: 'collect_comments', profileId, postUrls };
        }
        default:
            throw new Error('Loại việc không hợp lệ');
    }
}
