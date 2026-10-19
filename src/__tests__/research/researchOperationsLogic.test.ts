import {
    UnknownProfilesError, buildSheetRows, checkProfileIds, exportFileName, parseGetParams, parseListParams,
} from '../../services/research/researchOperationsLogic';
import type { ResearchItem } from '../../models/research';

const item = (extra: Partial<ResearchItem> = {}): ResearchItem => ({
    id: 1, scanId: 's', capturedAt: 1, profileId: 'p', kind: 'post', fbId: '1', url: 'https://fb.test/1', title: 'Nội dung',
    placeKind: 'group', placeId: 'g', placeName: 'Nhóm A', authorKind: 'person', authorId: 'u', authorName: 'An', authorUrl: 'https://fb.test/an',
    privacy: '', memberCount: null, followerCount: null, reactions: 3, comments: null, shares: 1, postedAt: null,
    engagement: 4, engagementRate: 0.02, ...extra,
});

describe('checkProfileIds', () => {
    it('keeps undefined, rejects empty, too many, blank and unknown ids', () => {
        expect(checkProfileIds(undefined, ['a'])).toBeUndefined();
        expect(checkProfileIds(['a'], ['a', 'b'])).toEqual(['a']);
        expect(() => checkProfileIds([], ['a'])).toThrow('profileIds không được rỗng');
        expect(() => checkProfileIds(Array(51).fill('a'), ['a'])).toThrow('tối đa 50');
        expect(() => checkProfileIds([''], ['a'])).toThrow('không hợp lệ');
        expect(() => checkProfileIds('a', ['a'])).toThrow('danh sách');
        try { checkProfileIds(['a', 'x', 'y'], ['a']); } catch (e) {
            expect(e).toBeInstanceOf(UnknownProfilesError);
            expect((e as UnknownProfilesError).missing).toEqual(['x', 'y']);
            expect((e as Error).message).toContain('x, y');
        }
    });
});

describe('list/get params', () => {
    it('applies defaults and bounds', () => {
        expect(parseListParams({})).toEqual({ limit: 50, offset: 0, source: undefined });
        expect(() => parseListParams({ limit: 201 })).toThrow();
        expect(() => parseListParams({ source: 'x' })).toThrow();
        expect(parseGetParams({ scanId: 's' })).toEqual({ scanId: 's', sort: 'engagement', limit: 100, offset: 0 });
        expect(() => parseGetParams({ scanId: 's', limit: 501 })).toThrow();
        expect(() => parseGetParams({ scanId: 's', sort: 'x' })).toThrow();
        expect(() => parseGetParams({})).toThrow('scanId');
    });
});

describe('export rows', () => {
    it('maps post rows with blanks for unknown numbers', () => {
        const [row] = buildSheetRows('posts', [item()]);
        expect(row).toMatchObject({ 'Người đăng': 'An', 'Link người đăng': 'https://fb.test/an', 'Cảm xúc': 3, 'Bình luận': '', 'Tổng tương tác': 4, 'Tỉ lệ tương tác': 0.02 });
    });
    it('maps group and page rows', () => {
        expect(buildSheetRows('groups', [item({ kind: 'group', privacy: 'private', memberCount: 10 })])[0]).toMatchObject({ 'Quyền riêng tư': 'Riêng tư', 'Thành viên': 10 });
        expect(buildSheetRows('pages', [item({ kind: 'page', followerCount: 7 })])[0]).toMatchObject({ 'Người theo dõi': 7 });
    });
    it('names the file by source and local time', () => {
        expect(exportFileName('posts', new Date(2026, 9, 19, 8, 5).getTime())).toBe('nghien-cuu-posts-20261019-0805.xlsx');
    });
});
