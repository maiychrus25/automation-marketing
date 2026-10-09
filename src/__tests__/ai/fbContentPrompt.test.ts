import { buildWriteMessages, buildPolishMessages } from '../../services/ai/fbContentPrompt';

describe('fbContentPrompt', () => {
  it('write: gói brief thành user message, có yêu cầu giữ giọng brand', () => {
    const m = buildWriteMessages('tuyển Junior UA, 12-18M, HN');
    expect(m).toHaveLength(1);
    expect(m[0].role).toBe('user');
    expect(m[0].content).toContain('tuyển Junior UA, 12-18M, HN');
    expect(m[0].content.toLowerCase()).toContain('giọng');
  });
  it('polish: gói nháp + yêu cầu viết lại giữ ý', () => {
    const m = buildPolishMessages('cần tuyển ke toan');
    expect(m[0].content).toContain('cần tuyển ke toan');
    expect(m[0].content.toLowerCase()).toContain('viết lại');
  });
  it('rỗng → throw', () => {
    expect(() => buildWriteMessages('  ')).toThrow('empty');
    expect(() => buildPolishMessages('')).toThrow('empty');
  });
});
