import { buildLeadPrompt, parseLeadVerdicts } from '../../services/facebookPoster/leadAi';

describe('buildLeadPrompt', () => {
  test('system + user, đánh số bình luận từ 0 và yêu cầu JSON', () => {
    const msgs = buildLeadPrompt([{ text: 'giá bao nhiêu' }, { text: 'sdt "0901"' }]);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
    expect(msgs[0].content).toContain('JSON');
    expect(msgs[1].content).toContain('0. "giá bao nhiêu"');
    expect(msgs[1].content).toContain('1. "sdt \\"0901\\""');
  });
});

describe('parseLeadVerdicts', () => {
  test('đọc mảng thuần, ánh xạ theo i', () => {
    const out = parseLeadVerdicts('[{"i":1,"intent":"buy","score":80,"reason":"a"},{"i":0,"intent":"other","score":10,"reason":"b"}]', 2);
    expect(out).toEqual([{ intent: 'other', score: 10, reason: 'b' }, { intent: 'buy', score: 80, reason: 'a' }]);
  });
  test('chấp nhận khối code và chữ thừa', () => {
    const out = parseLeadVerdicts('Đây là kết quả:\n```json\n[{"i":0,"intent":"question","score":55,"reason":"hỏi [giá]"}]\n```\nHết.', 1);
    expect(out).toEqual([{ intent: 'question', score: 55, reason: 'hỏi [giá]' }]);
  });
  test('bỏ mục sai, kẹp score 0-100, thiếu thì null', () => {
    const out = parseLeadVerdicts('[{"i":0,"intent":"buy","score":150,"reason":"x"},{"i":1,"intent":"???","score":5},{"i":9,"intent":"buy","score":5},{"i":2,"intent":"buy","score":-5}]', 4);
    expect(out).toEqual([{ intent: 'buy', score: 100, reason: 'x' }, null, { intent: 'buy', score: 0, reason: '' }, null]);
  });
  test('không có mảng hợp lệ thì null', () => {
    expect(parseLeadVerdicts('xin lỗi, tôi không làm được', 2)).toBeNull();
    expect(parseLeadVerdicts('[{"i":0,"intent":"x"}]', 1)).toBeNull();
    expect(parseLeadVerdicts('[1,2', 2)).toBeNull();
  });
});
