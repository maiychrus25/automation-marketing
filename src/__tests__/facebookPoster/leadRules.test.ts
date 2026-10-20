import {
    DEFAULT_LEAD_CONFIG, DEFAULT_LEAD_KEYWORDS, LEAD_CONFIG_SETTING_KEY,
    computeNextCommentAt, matchLead, overdueCommentLabels, parseLeadConfig, validateLeadConfig,
} from '../../services/facebookPoster/leadRules';

const MIN = 60_000;
const kw = (keywords: string[], detectPhone = true) => ({ keywords, detectPhone });

describe('matchLead', () => {
    it('khớp không dấu, không phân biệt hoa thường', () => {
        expect(matchLead('Gia bao nhieu vay shop', kw(['giá', 'bao nhiêu']))).toEqual(['giá', 'bao nhiêu']);
        expect(matchLead('GIÁ?', kw(['giá']))).toEqual(['giá']);
    });
    it('theo ranh giới từ', () => {
        expect(matchLead('ib em nhé', kw(['ib']))).toEqual(['ib']);
        expect(matchLead('ib, em nhé', kw(['ib']))).toEqual(['ib']);
        expect(matchLead('lib', kw(['ib']))).toBeNull();
        expect(matchLead('ibm', kw(['ib']))).toBeNull();
        expect(matchLead('còn hàng không ạ', kw(['còn hàng']))).toEqual(['còn hàng']);
    });
    it('đ khớp d', () => {
        expect(matchLead('dat 2 cai', kw(['đặt']))).toEqual(['đặt']);
    });
    it('số điện thoại các dạng', () => {
        for (const t of ['0912345678', 'sdt 0912 345 678', '091.234.5678', '091-234-5678', '+84 912 345 678', '+84912345678', 'goi 0912345678.']) {
            expect(matchLead(t, kw([]))).toEqual(['phone']);
        }
    });
    it('từ khoá và số điện thoại cùng lúc', () => {
        expect(matchLead('ib 0912345678', kw(['ib']))).toEqual(['ib', 'phone']);
    });
    it('không nhận số 8 chữ số, giá tiền, năm', () => {
        for (const t of ['12345678', '09123456', '250.000', '1.250.000đ', 'năm 2025', '0912345678901234']) {
            expect(matchLead(t, kw([]))).toBeNull();
        }
    });
    it('detectPhone tắt thì bỏ qua số', () => {
        expect(matchLead('0912345678', kw([], false))).toBeNull();
    });
    it('text rỗng hoặc không khớp trả null', () => {
        expect(matchLead('', kw(['ib']))).toBeNull();
        expect(matchLead('   ', kw(['ib']))).toBeNull();
        expect(matchLead('đẹp quá', kw(['ib']))).toBeNull();
    });
});

describe('validateLeadConfig', () => {
    const base = () => ({ ...DEFAULT_LEAD_CONFIG, collectAtMinutes: [...DEFAULT_LEAD_CONFIG.collectAtMinutes], keywords: [...DEFAULT_LEAD_CONFIG.keywords] });
    it('mặc định hợp lệ', () => {
        expect(validateLeadConfig(base())).toEqual(DEFAULT_LEAD_CONFIG);
        expect(LEAD_CONFIG_SETTING_KEY).toBe('fb_poster_lead_config');
        expect(DEFAULT_LEAD_KEYWORDS).toHaveLength(19);
    });
    it('từ khoá chứa dấu phẩy bị từ chối', () => {
        expect(() => validateLeadConfig({ ...base(), keywords: ['giá, ship'] })).toThrow('dấu phẩy');
    });
    it('mốc: 1-10 phần tử, tăng dần, 30-20160', () => {
        expect(() => validateLeadConfig({ ...base(), collectAtMinutes: [] })).toThrow();
        expect(() => validateLeadConfig({ ...base(), collectAtMinutes: Array.from({ length: 11 }, (_, i) => 30 + i) })).toThrow();
        expect(() => validateLeadConfig({ ...base(), collectAtMinutes: [29] })).toThrow();
        expect(() => validateLeadConfig({ ...base(), collectAtMinutes: [20161] })).toThrow();
        expect(() => validateLeadConfig({ ...base(), collectAtMinutes: [60, 60] })).toThrow();
        expect(() => validateLeadConfig({ ...base(), collectAtMinutes: [120, 60] })).toThrow();
        expect(() => validateLeadConfig({ ...base(), collectAtMinutes: [30.5] })).toThrow();
        expect(validateLeadConfig({ ...base(), collectAtMinutes: [30, 20160] }).collectAtMinutes).toEqual([30, 20160]);
    });
    it('từ khoá: 1-100 mục, 1-40 ký tự sau trim', () => {
        expect(() => validateLeadConfig({ ...base(), keywords: [] })).toThrow();
        expect(() => validateLeadConfig({ ...base(), keywords: Array.from({ length: 101 }, (_, i) => `k${i}`) })).toThrow();
        expect(() => validateLeadConfig({ ...base(), keywords: ['  '] })).toThrow();
        expect(() => validateLeadConfig({ ...base(), keywords: ['a'.repeat(41)] })).toThrow();
        expect(() => validateLeadConfig({ ...base(), keywords: [5] })).toThrow();
        expect(validateLeadConfig({ ...base(), keywords: [' ib ', 'a'.repeat(40)] }).keywords).toEqual(['ib', 'a'.repeat(40)]);
        expect(validateLeadConfig({ ...base(), keywords: Array.from({ length: 100 }, (_, i) => `k${i}`) }).keywords).toHaveLength(100);
    });
    it('aiMinScore 0-100 nguyên, cờ phải là boolean', () => {
        expect(() => validateLeadConfig({ ...base(), aiMinScore: -1 })).toThrow();
        expect(() => validateLeadConfig({ ...base(), aiMinScore: 101 })).toThrow();
        expect(() => validateLeadConfig({ ...base(), aiMinScore: 50.5 })).toThrow();
        expect(validateLeadConfig({ ...base(), aiMinScore: 0 }).aiMinScore).toBe(0);
        expect(validateLeadConfig({ ...base(), aiMinScore: 100 }).aiMinScore).toBe(100);
        expect(() => validateLeadConfig({ ...base(), autoCollect: 'yes' })).toThrow();
        expect(() => validateLeadConfig({ ...base(), detectPhone: 1 })).toThrow();
        expect(() => validateLeadConfig({ ...base(), aiEnabled: null })).toThrow();
        expect(() => validateLeadConfig(null)).toThrow(/không hợp lệ/);
    });
});

describe('parseLeadConfig', () => {
    it('sai hoặc thiếu thì dùng mặc định (bản sao)', () => {
        for (const raw of [null, undefined, '', 'not json', '{"autoCollect":1}', 42]) {
            const c = parseLeadConfig(raw);
            expect(c).toEqual(DEFAULT_LEAD_CONFIG);
            expect(c.keywords).not.toBe(DEFAULT_LEAD_CONFIG.keywords);
        }
    });
    it('đọc chuỗi JSON hoặc object hợp lệ', () => {
        const custom = { ...DEFAULT_LEAD_CONFIG, collectAtMinutes: [60], aiEnabled: true };
        expect(parseLeadConfig(JSON.stringify(custom))).toEqual(custom);
        expect(parseLeadConfig(custom)).toEqual(custom);
    });
});

describe('computeNextCommentAt / overdueCommentLabels', () => {
    const cfg = { collectAtMinutes: [120, 1440, 4320] };
    const posted = 1_000_000_000_000;
    it('bỏ mốc đã làm và mốc đã qua', () => {
        expect(computeNextCommentAt(posted, [], cfg, posted)).toBe(posted + 120 * MIN);
        expect(computeNextCommentAt(posted, ['120m'], cfg, posted + 130 * MIN)).toBe(posted + 1440 * MIN);
        expect(computeNextCommentAt(posted, [], cfg, posted + 130 * MIN)).toBe(posted + 1440 * MIN);
        expect(computeNextCommentAt(posted, ['120m', '1440m'], cfg, posted)).toBe(posted + 4320 * MIN);
    });
    it('hết mốc thì null', () => {
        expect(computeNextCommentAt(posted, ['120m', '1440m', '4320m'], cfg, posted)).toBeNull();
        expect(computeNextCommentAt(posted, [], cfg, posted + 5000 * MIN)).toBeNull();
        expect(computeNextCommentAt(posted, [], cfg, posted + 4320 * MIN)).toBeNull();
    });
    it('overdueCommentLabels: mốc đã đến hạn mà chưa làm', () => {
        expect(overdueCommentLabels(posted, [], cfg, posted + 119 * MIN)).toEqual([]);
        expect(overdueCommentLabels(posted, [], cfg, posted + 120 * MIN)).toEqual(['120m']);
        expect(overdueCommentLabels(posted, ['120m'], cfg, posted + 1500 * MIN)).toEqual(['1440m']);
        expect(overdueCommentLabels(posted, [], cfg, posted + 5000 * MIN)).toEqual(['120m', '1440m', '4320m']);
    });
});
