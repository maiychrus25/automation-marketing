import {
    DEFAULT_POST_TRACKING_CONFIG, POST_TRACKING_SETTING_KEY, computeNextCheckAt, dueStatsMilestone, markOverdueStatsDone, linkRetryExhausted,
    matchesOwnPost, normalizeHead, parsePostTrackingConfig, pickBestMatch, validatePostTrackingConfig,
} from '../../services/facebookPoster/postTracking';
import type { PostTrackingRow } from '../../models/facebookPoster';

const MIN = 60_000;
const HOUR = 60 * MIN;
const cfg = DEFAULT_POST_TRACKING_CONFIG;

function row(over: Partial<PostTrackingRow> = {}): PostTrackingRow {
    return {
        resultId: 1, runId: 'r', scheduleId: null, profileId: 'p1', groupUrl: 'https://www.facebook.com/groups/1/', groupId: '',
        postId: '', postUrl: null, postedAt: 1_000_000, textHead: normalizeHead('Bán  Hàng  Giá Rẻ hôm nay'),
        linkStatus: 'missing', removedSuspected: false, lastSeenAt: null, lastCheckedAt: null, checkCount: 0, nextCheckAt: null,
        statsDone: [], ...over,
    };
}
const item = (over: Record<string, unknown> = {}) => ({ fbId: 'f1', title: 'bán hàng giá rẻ hôm nay', authorId: 'u1', postedAt: 1_000_000 + MIN, ...over }) as any;

test('setting key', () => expect(POST_TRACKING_SETTING_KEY).toBe('fb_poster_post_tracking_config'));

test('normalizeHead: chữ thường, gộp khoảng trắng, cắt 200', () => {
    expect(normalizeHead('  Xin   CHÀO\n\tBạn ')).toBe('xin chào bạn');
    expect(normalizeHead('a'.repeat(300))).toHaveLength(200);
});

test('normalizeHead: NFD = NFC, bỏ ký tự độ rộng 0, khoảng trắng Unicode, giữ emoji', () => {
    const nfc = 'Bán hàng giá rẻ tiếng Việt'.normalize('NFC');
    expect(normalizeHead(nfc.normalize('NFD'))).toBe(normalizeHead(nfc));
    expect(normalizeHead('a\u200Bb\uFEFFc\u200D')).toBe('abc');
    expect(normalizeHead('a\u00A0\u3000b')).toBe('a b');
    expect(normalizeHead('Hot 🔥 deal')).toBe('hot 🔥 deal');
    expect(matchesOwnPost(row(), item({ title: 'Bán Hàng Giá Rẻ hôm nay'.normalize('NFD') }), 'u1')).toBe(true);
});

describe('matchesOwnPost', () => {
    test('khớp', () => expect(matchesOwnPost(row(), item(), 'u1')).toBe(true));
    test('khác tác giả', () => expect(matchesOwnPost(row(), item({ authorId: 'u2' }), 'u1')).toBe(false));
    test('lệch quá 2 giờ', () => {
        expect(matchesOwnPost(row(), item({ postedAt: 1_000_000 + 2 * HOUR + 1 }), 'u1')).toBe(false);
        expect(matchesOwnPost(row(), item({ postedAt: 1_000_000 + 2 * HOUR }), 'u1')).toBe(true);
        expect(matchesOwnPost(row(), item({ postedAt: 1_000_000 - 2 * HOUR }), 'u1')).toBe(true);
    });
    test('khác chữ', () => expect(matchesOwnPost(row(), item({ title: 'nội dung khác hẳn' }), 'u1')).toBe(false));
    test('chỉ so 60 ký tự đầu', () => {
        const head = 'x'.repeat(60);
        expect(matchesOwnPost(row({ textHead: head + 'aaa' }), item({ title: head + 'bbb' }), 'u1')).toBe(true);
    });
    test('text_head rỗng thì không bao giờ khớp theo chữ', () => {
        expect(matchesOwnPost(row({ textHead: '' }), item({ title: '' }), 'u1')).toBe(false);
    });
    test('thiếu userId hoặc thiếu postedAt thì không khớp', () => {
        expect(matchesOwnPost(row(), item({ authorId: '' }), '')).toBe(false);
        expect(matchesOwnPost(row(), item({ postedAt: null }), 'u1')).toBe(false);
    });
});

test('pickBestMatch lấy mục gần giờ nhất, bằng nhau lấy mục đầu', () => {
    const a = item({ fbId: 'a', postedAt: 1_000_000 + 30 * MIN });
    const b = item({ fbId: 'b', postedAt: 1_000_000 - 5 * MIN });
    const c = item({ fbId: 'c', postedAt: 1_000_000 + 5 * MIN });
    const other = item({ fbId: 'o', authorId: 'u9', postedAt: 1_000_000 });
    expect(pickBestMatch(row(), [a, other, b, c], 'u1')!.fbId).toBe('b');
    expect(pickBestMatch(row(), [other], 'u1')).toBeNull();
});

describe('computeNextCheckAt', () => {
    const at = (m: number) => 1_000_000 + m * MIN;
    test('chờ duyệt tại từng mốc', () => {
        const r = row({ linkStatus: 'pending_approval' });
        expect(computeNextCheckAt(r, cfg, 1_000_000)).toBe(at(30));
        expect(computeNextCheckAt(r, cfg, at(30))).toBe(at(120));
        expect(computeNextCheckAt(r, cfg, at(31))).toBe(at(120));
        expect(computeNextCheckAt(r, cfg, at(1440))).toBe(at(2880));
        expect(computeNextCheckAt(r, cfg, at(4320))).toBe(at(10080));
    });
    test('qua mốc cuối thì null và linkRetryExhausted', () => {
        const r = row({ linkStatus: 'missing' });
        expect(computeNextCheckAt(r, cfg, at(10080))).toBeNull();
        expect(linkRetryExhausted(r, cfg, at(10079))).toBe(false);
        expect(linkRetryExhausted(r, cfg, at(10080))).toBe(true);
        expect(linkRetryExhausted(row({ linkStatus: 'known' }), cfg, at(99999))).toBe(false);
    });
    test('đã có link: các mốc 1h/24h/72h', () => {
        const r = row({ linkStatus: 'known', postId: 'p' });
        expect(computeNextCheckAt(r, cfg, at(10))).toBe(at(60));
        expect(computeNextCheckAt({ ...r, statsDone: ['60m'] }, cfg, at(70))).toBe(at(1440));
        expect(computeNextCheckAt({ ...r, statsDone: ['60m', '1440m'] }, cfg, at(1500))).toBe(at(4320));
        expect(computeNextCheckAt({ ...r, statsDone: ['60m', '1440m', '4320m'] }, cfg, at(1500))).toBeNull();
    });
    test('mốc đo đã qua mà chưa làm bị bỏ qua: chỉ trả mốc trong tương lai', () => {
        const r = row({ linkStatus: 'known', postId: 'p' });
        expect(computeNextCheckAt(r, cfg, at(100))).toBe(at(1440));
        expect(computeNextCheckAt(r, cfg, at(1440))).toBe(at(4320));
        expect(computeNextCheckAt(r, cfg, at(4320))).toBeNull();
    });
    test('markOverdueStatsDone đánh dấu mọi mốc đã qua', () => {
        const r = row({ linkStatus: 'known', postId: 'p', statsDone: ['60m'] });
        expect(markOverdueStatsDone(r, cfg, at(1500))).toEqual(['60m', '1440m']);
        expect(markOverdueStatsDone(r, cfg, at(10))).toEqual(['60m']);
    });
    test('mốc đo cuối trễ hơn 24 giờ thì bỏ', () => {
        const r = row({ linkStatus: 'known', postId: 'p' });
        const done = row({ linkStatus: 'known', postId: 'p', statsDone: ['60m', '1440m'] });
        // Mốc cuối 4320 đã qua nên không còn mốc tương lai; trước đó mốc 4320 còn ở tương lai.
        expect(computeNextCheckAt(done, cfg, at(4320) - 1)).toBe(at(4320));
        expect(computeNextCheckAt(done, cfg, at(4320) + 24 * HOUR)).toBeNull();
        expect(computeNextCheckAt(done, cfg, at(4320) + 24 * HOUR + 1)).toBeNull();
    });
    test('removed_suspected và not_found thì null', () => {
        expect(computeNextCheckAt(row({ linkStatus: 'known', removedSuspected: true }), cfg, at(1))).toBeNull();
        expect(computeNextCheckAt(row({ linkStatus: 'not_found' }), cfg, at(1))).toBeNull();
    });
});

test('dueStatsMilestone', () => {
    const at = (m: number) => 1_000_000 + m * MIN;
    const r = row({ linkStatus: 'known', postId: 'p' });
    expect(dueStatsMilestone(r, cfg, at(59))).toBeNull();
    expect(dueStatsMilestone(r, cfg, at(60))).toBe('60m');
    expect(dueStatsMilestone({ ...r, statsDone: ['60m'] }, cfg, at(100))).toBeNull();
    expect(dueStatsMilestone({ ...r, statsDone: ['60m'] }, cfg, at(1440))).toBe('1440m');
    expect(dueStatsMilestone(row({ linkStatus: 'missing' }), cfg, at(100))).toBeNull();
    expect(dueStatsMilestone({ ...r, removedSuspected: true }, cfg, at(100))).toBeNull();
});

describe('config', () => {
    test('parse: thiếu/hỏng thì mặc định', () => {
        expect(parsePostTrackingConfig(null)).toEqual(cfg);
        expect(parsePostTrackingConfig('{oops')).toEqual(cfg);
        expect(parsePostTrackingConfig('{"autoEnabled":true,"linkRetryMinutes":[],"statsAtMinutes":[60]}')).toEqual(cfg);
    });
    test('parse: hợp lệ', () => {
        const c = { autoEnabled: false, linkRetryMinutes: [10, 20], statsAtMinutes: [30] };
        expect(parsePostTrackingConfig(JSON.stringify(c))).toEqual(c);
    });
    test('validate: từ chối đầu vào sai', () => {
        const ok = { autoEnabled: true, linkRetryMinutes: [5, 20160], statsAtMinutes: [60] };
        expect(validatePostTrackingConfig(ok)).toEqual(ok);
        expect(() => validatePostTrackingConfig({ ...ok, autoEnabled: 'yes' })).toThrow();
        expect(() => validatePostTrackingConfig({ ...ok, linkRetryMinutes: [] })).toThrow();
        expect(() => validatePostTrackingConfig({ ...ok, linkRetryMinutes: Array.from({ length: 11 }, (_, i) => 10 + i) })).toThrow();
        expect(() => validatePostTrackingConfig({ ...ok, statsAtMinutes: [4] })).toThrow();
        expect(() => validatePostTrackingConfig({ ...ok, statsAtMinutes: [20161] })).toThrow();
        expect(() => validatePostTrackingConfig({ ...ok, statsAtMinutes: [60, 60] })).toThrow();
        expect(() => validatePostTrackingConfig({ ...ok, statsAtMinutes: [60, 30] })).toThrow();
        expect(() => validatePostTrackingConfig({ ...ok, statsAtMinutes: [60.5] })).toThrow();
        expect(() => validatePostTrackingConfig(null)).toThrow();
    });
});
