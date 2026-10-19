// Phần thuần của thao tác Nghiên cứu chủ đề: kiểm tra tham số dùng chung cho IPC và Control API, và dựng dòng xuất Excel.
import type { ResearchItem, ResearchSort, ResearchSource } from '../../models/research';
import { MAX_PROFILE_IDS } from './ResearchService';

export const SCAN_NOT_FOUND_ERROR = 'Không tìm thấy lượt quét';
export const MAX_LIST_LIMIT = 200;
export const MAX_GET_LIMIT = 500;
const SOURCES: ResearchSource[] = ['posts', 'groups', 'pages', 'group_feed'];
const SORTS: ResearchSort[] = ['engagement', 'recent', 'members'];

/** Có profile không tồn tại (Control API đổi thành NOT_FOUND kèm details.missing). */
export class UnknownProfilesError extends Error {
    constructor(public readonly missing: string[]) {
        super(`Không tìm thấy profile: ${missing.join(', ')}`);
    }
}

/** undefined giữ nguyên; mảng rỗng, quá 50 mã, mã rỗng hoặc mã lạ thì ném lỗi. */
export function checkProfileIds(ids: unknown, knownIds: string[]): string[] | undefined {
    if (ids === undefined) return undefined;
    if (!Array.isArray(ids)) throw new Error('profileIds phải là danh sách mã profile');
    if (ids.length === 0) throw new Error('profileIds không được rỗng');
    if (ids.length > MAX_PROFILE_IDS) throw new Error(`profileIds tối đa ${MAX_PROFILE_IDS} mã`);
    if (ids.some((x) => typeof x !== 'string' || !x)) throw new Error('profileIds chứa mã không hợp lệ');
    const known = new Set(knownIds);
    const missing = [...new Set(ids as string[])].filter((id) => !known.has(id));
    if (missing.length) throw new UnknownProfilesError(missing);
    return ids as string[];
}

function intInRange(value: unknown, name: string, min: number, max: number, fallback: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${name} phải là số nguyên từ ${min} đến ${max}`);
    }
    return value;
}

export function parseListParams(p: any): { limit: number; offset: number; source?: ResearchSource } {
    if (p?.source !== undefined && !SOURCES.includes(p.source)) throw new Error('source không hợp lệ');
    return { limit: intInRange(p?.limit, 'limit', 1, MAX_LIST_LIMIT, 50), offset: intInRange(p?.offset, 'offset', 0, 1e9, 0), source: p?.source };
}

export function parseGetParams(p: any): { scanId: string; sort: ResearchSort; limit: number; offset: number } {
    if (typeof p?.scanId !== 'string' || !p.scanId) throw new Error('Thiếu scanId');
    if (p.sort !== undefined && !SORTS.includes(p.sort)) throw new Error('sort không hợp lệ');
    return {
        scanId: p.scanId, sort: p.sort ?? 'engagement',
        limit: intInRange(p.limit, 'limit', 1, MAX_GET_LIMIT, 100), offset: intInRange(p.offset, 'offset', 0, 1e9, 0),
    };
}

const pad = (n: number) => String(n).padStart(2, '0');

function formatTime(ms: number | null): string {
    if (ms === null || !Number.isFinite(ms)) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Tên tệp gợi ý: nghien-cuu-<nguon>-<yyyymmdd-hhmm>.xlsx (giờ máy). */
export function exportFileName(source: ResearchSource, at: number): string {
    const d = new Date(at);
    return `nghien-cuu-${source}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.xlsx`;
}

const privacyLabel = (p: string) => (p === 'public' ? 'Công khai' : p === 'private' ? 'Riêng tư' : '');
const cell = (v: number | null) => (v === null ? '' : v);

const CELL_MAX = 32000; // Excel giới hạn 32.767 ký tự mỗi ô
const clip = (v: string | number): string | number => (typeof v === 'string' && v.length > CELL_MAX ? v.slice(0, CELL_MAX) : v);

/** Dòng cho một trang tính; cột theo nguồn (spec mục 9). Giá trị không biết để ô trống. */
export function buildSheetRows(source: ResearchSource, items: ResearchItem[]): Record<string, string | number>[] {
    return buildRawRows(source, items).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, clip(v)])));
}

function buildRawRows(source: ResearchSource, items: ResearchItem[]): Record<string, string | number>[] {
    if (source === 'groups') {
        return items.map((i) => ({
            'Tên nhóm': i.title, 'Link': i.url, 'Quyền riêng tư': privacyLabel(i.privacy), 'Thành viên': cell(i.memberCount),
        }));
    }
    if (source === 'pages') {
        return items.map((i) => ({ 'Tên trang': i.title, 'Link': i.url, 'Người theo dõi': cell(i.followerCount) }));
    }
    return items.map((i) => ({
        'Nội dung': i.title,
        'Nơi đăng': i.placeName,
        'Người đăng': i.authorName,
        'Link người đăng': i.authorUrl,
        'Cảm xúc': cell(i.reactions),
        'Bình luận': cell(i.comments),
        'Chia sẻ': cell(i.shares),
        'Tổng tương tác': cell(i.engagement),
        'Tỉ lệ tương tác': cell(i.engagementRate),
        'Thời gian đăng': formatTime(i.postedAt),
        'Link bài': i.url,
    }));
}
