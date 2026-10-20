import { MIN_SCORE_POSTS, scoreGroups, type GroupScoreInput } from '../../services/facebookPoster/groupScores';

function input(over: Partial<GroupScoreInput> = {}): GroupScoreInput {
    return {
        groupUrl: 'https://www.facebook.com/groups/1/', label: 'G1', attempted: 4, posted: 4, failed: 0, held: 0, removed: 0, withLink: 4,
        measured: 0, engagementRate: null, avgEngagement: null, ...over,
    };
}
const one = (over: Partial<GroupScoreInput>) => scoreGroups([input(over)])[0];

test('MIN_SCORE_POSTS = 3', () => expect(MIN_SCORE_POSTS).toBe(3));

test('điểm tính tay: success .8, published .75, survival 1, engagement .5 → 72', () => {
    const rows = [
        input({ groupUrl: 'a', label: 'A', attempted: 3, posted: 3, failed: 0, withLink: 3, measured: 2, avgEngagement: 10 }),
        input({ groupUrl: 'b', label: 'B', attempted: 5, posted: 4, failed: 1, held: 1, withLink: 3, measured: 2, avgEngagement: 20 }),
        input({ groupUrl: 'c', label: 'C', attempted: 3, posted: 3, failed: 0, withLink: 3, measured: 2, avgEngagement: 30 }),
    ];
    const out = scoreGroups(rows);
    const b = out.find(r => r.groupUrl === 'b')!;
    expect(b.engagement).toBe(0.5);
    expect(b.score).toBe(72); // 16 + 18.75 + 20 + 17.5 = 72.25
    expect(b.grade).toBe('good');
    const a = out.find(r => r.groupUrl === 'a')!;
    expect(a.engagement).toBe(0.25);
    expect(a.score).toBe(Math.round(20 + 25 + 20 + 35 * 0.25)); // 74
    expect(out.find(r => r.groupUrl === 'c')!.engagement).toBe(0.75);
});

test('sắp score giảm dần, insufficient cuối theo attempted giảm dần', () => {
    const out = scoreGroups([
        input({ groupUrl: 'i1', attempted: 1, posted: 1 }),
        input({ groupUrl: 'lo', attempted: 3, posted: 0, failed: 3, withLink: 0 }),
        input({ groupUrl: 'i2', attempted: 2, posted: 2 }),
        input({ groupUrl: 'hi' }),
    ]);
    expect(out.map(r => r.groupUrl)).toEqual(['hi', 'lo', 'i2', 'i1']);
});

test('posted = 0 → published 0; withLink = 0 → survival 1', () => {
    const r = one({ attempted: 3, posted: 0, failed: 3, held: 0, withLink: 0 });
    expect(r.score).toBe(Math.round(0 + 0 + 20 + 35 * 0.5)); // 38
    expect(r.grade).toBe('poor');
    expect(r.reasons.some((x) => x.includes('bài phải chờ duyệt'))).toBe(false); // posted = 0: lý do "0/0" vô nghĩa, chỉ báo lần đăng lỗi
});

test('held > posted (lệch mép khoảng thời gian) được kẹp, không ra điểm âm', () => {
    const r = one({ attempted: 3, posted: 3, failed: 0, held: 5, withLink: 1, removed: 2 });
    expect(r.score).toBe(Math.round(20 + 0 + 0 + 35 * 0.5)); // 38
    expect(r.score!).toBeGreaterThanOrEqual(0);
});

test('không nhóm nào được đo → engagement 0.5 và lý do chưa đo', () => {
    const r = one({});
    expect(r.engagement).toBe(0.5);
    expect(r.score).toBe(Math.round(20 + 25 + 20 + 17.5)); // 83
    expect(r.reasons).toEqual(['Chưa có số đo tương tác']);
});

test('median = 0 → 0.5', () => {
    const r = one({ measured: 2, avgEngagement: 0 });
    expect(r.engagement).toBe(0.5);
});

test('trung vị của số chẵn nhóm là trung bình hai giữa', () => {
    const mk = (u: string, v: number) => input({ groupUrl: u, measured: 1, avgEngagement: v });
    const out = scoreGroups([mk('a', 10), mk('b', 20), mk('c', 40), mk('d', 50)]); // median 30
    expect(out.find(r => r.groupUrl === 'a')!.engagement).toBeCloseTo(10 / 30 / 2, 10);
    expect(out.find(r => r.groupUrl === 'd')!.engagement).toBe(Math.min(50 / 30 / 2, 1));
});

test('một nhóm thiếu engagementRate → cả lượt dùng avgEngagement', () => {
    const out = scoreGroups([
        input({ groupUrl: 'a', measured: 1, engagementRate: 0.5, avgEngagement: 10 }),
        input({ groupUrl: 'b', measured: 1, engagementRate: null, avgEngagement: 20 }),
        input({ groupUrl: 'c', measured: 1, engagementRate: 0.1, avgEngagement: 30 }),
    ]);
    expect(out.map(r => r.engagement)).toEqual(expect.arrayContaining([0.25, 0.5, 0.75]));
});

test('mọi nhóm có engagementRate → dùng engagementRate', () => {
    const out = scoreGroups([
        input({ groupUrl: 'a', measured: 1, engagementRate: 0.01, avgEngagement: 100 }),
        input({ groupUrl: 'b', measured: 1, engagementRate: 0.02, avgEngagement: 1 }),
        input({ groupUrl: 'c', measured: 1, engagementRate: 0.03, avgEngagement: 1 }),
    ]);
    expect(out.find(r => r.groupUrl === 'a')!.engagement).toBeCloseTo(0.25, 10);
});

test('nhóm insufficient không tham gia trung vị', () => {
    const out = scoreGroups([
        input({ groupUrl: 'a', measured: 1, avgEngagement: 10 }),
        input({ groupUrl: 'x', attempted: 1, posted: 1, measured: 1, avgEngagement: 1000 }),
    ]);
    expect(out.find(r => r.groupUrl === 'a')!.engagement).toBe(0.5);
});

test('ngưỡng nhãn 70/69 và 40/39', () => {
    // success s, published p, survival 1, engagement 0.5 (17.5 + 20 survival = 37.5 cố định)
    // posted/attempted = 1 (20), held tuỳ ý: published = 1 - held/posted
    const mk = (held: number, posted: number) => one({ attempted: posted, posted, held, withLink: posted });
    // posted 100: held 10 → 0.9*25 = 22.5 → 20+22.5+20+17.5 = 80 ; dùng failed để hạ điểm
    expect(mk(0, 4).score).toBe(83);
    const r70 = one({ attempted: 10, posted: 7, failed: 3, held: 0, withLink: 7 }); // 14+25+20+17.5 = 76.5 → 77
    expect(r70.grade).toBe('good');
    const r69 = one({ attempted: 10, posted: 6, failed: 4, held: 0, withLink: 6 }); // 12+25+20+17.5 = 74.5 → 75
    expect(r69.grade).toBe('good');
    // đúng biên: attempted 10 posted 4 held 2 withLink 4: 8 + 12.5 + 20 + 17.5 = 58 -> fair
    expect(one({ attempted: 10, posted: 4, failed: 6, held: 2, withLink: 4 }).grade).toBe('fair');
    // 69: attempted 4 posted 4 held 1 -> 20+18.75+20+17.5 = 76 ; chọn removed để hạ: removed 1 withLink 4 -> survival .75 (15)
    // attempted 4 posted 4 held 2 removed 1 withLink 4: 20 + 12.5 + 15 + 17.5 = 65 fair
    const s65 = one({ held: 2, removed: 1 });
    expect(s65.score).toBe(65);
    expect(s65.grade).toBe('fair');
});

test('biên chính xác 70 → good, 69 → fair, 40 → fair, 39 → poor', () => {
    // posted = attempted = 4, withLink 4, engagement 0.5 (17.5), success 1 (20)
    // score = 20 + 25*(1-held/4) + 20*(1-removed/4) + 17.5
    // held 2, removed 0: 20+12.5+20+17.5 = 70
    const s70 = one({ held: 2 });
    expect(s70.score).toBe(70);
    expect(s70.grade).toBe('good');
    // held 2, removed 0, withLink 4 → hạ survival: removed 1 → 20+12.5+15+17.5 = 65 (đã có). 69: held 3 removed 0 → 20+6.25+20+17.5 = 63.75
    // 69: attempted 20 posted 20 withLink 20 held 9 -> published .55 (13.75) removed 0: 20+13.75+20+17.5 = 71.25 ; held 10: 12.5 → 70 ; held 11: 11.25 → 68.75 → 69
    const s69 = one({ attempted: 20, posted: 20, withLink: 20, held: 11 });
    expect(s69.score).toBe(69);
    expect(s69.grade).toBe('fair');
    // 40: success 0 (attempted 5 posted 0), published 0, survival 1 (20), eng 17.5 → 37.5 → 38 poor
    expect(one({ attempted: 5, posted: 0, failed: 5, withLink: 0 }).score).toBe(38);
    // 40: attempted 10 posted 1 failed 9 held 0 withLink 1: 2 + 25 + 20 + 17.5 = 64.5. dùng held: posted 1 held 1 → published 0: 2+0+20+17.5 = 39.5 → 40 (làm tròn)
    const s40 = one({ attempted: 10, posted: 1, failed: 9, held: 1, withLink: 1 });
    expect(s40.score).toBe(40);
    expect(s40.grade).toBe('fair');
    // 39: posted 0 attempted 3... 37.5→38 poor ; attempted 20 posted 1 held 1 → 1+0+20+17.5 = 38.5 → 39
    const s39 = one({ attempted: 20, posted: 1, failed: 19, held: 1, withLink: 1 });
    expect(s39.score).toBe(39);
    expect(s39.grade).toBe('poor');
});

test('lý do đúng câu chữ và thứ tự', () => {
    const r = one({ attempted: 10, posted: 5, failed: 5, held: 3, removed: 1, withLink: 5 });
    expect(r.reasons).toEqual([
        '3/5 bài phải chờ duyệt hoặc không tìm thấy',
        '1 bài nghi bị xoá',
        '5/10 lần đăng lỗi',
        'Chưa có số đo tương tác',
    ]);
});

test('lý do tương tác thấp / cao', () => {
    const out = scoreGroups([
        input({ groupUrl: 'a', measured: 1, avgEngagement: 2 }),
        input({ groupUrl: 'b', measured: 1, avgEngagement: 10 }),
        input({ groupUrl: 'c', measured: 1, avgEngagement: 23 }),
    ]); // median 10: a = 0.1, c = min(1.15, 1) = 1
    expect(out.find(r => r.groupUrl === 'a')!.reasons).toEqual(['Tương tác thấp hơn mức giữa của các nhóm']);
    expect(out.find(r => r.groupUrl === 'b')!.reasons).toEqual([]);
    expect(out.find(r => r.groupUrl === 'c')!.reasons).toEqual(['Tương tác cao (gấp ~2,3 lần mức giữa)']);
});

test('attempted = 2 → insufficient kèm lý do', () => {
    const r = one({ attempted: 2, posted: 2 });
    expect(r.score).toBeNull();
    expect(r.grade).toBe('insufficient');
    expect(r.engagement).toBeNull();
    expect(r.reasons).toEqual(['Mới có 2 lượt đăng (cần ≥ 3)']);
});
