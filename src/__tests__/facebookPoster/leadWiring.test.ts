import { buildLeadPrompt } from '../../services/facebookPoster/leadAi';
import { createLeadClassifier, openLoggedInSession, buildLeadSheetRows } from '../../services/facebookPoster/leadWiring';

const reply = '[{"i":0,"intent":"buy","score":80,"reason":"x"}]';

describe('createLeadClassifier', () => {
  test('gửi lời nhắc tới trợ lý mặc định và đọc kết quả', async () => {
    const chat = jest.fn().mockResolvedValue({ result: reply });
    const out = await createLeadClassifier({ getAssistantId: () => 'a1', complete: chat })([{ text: 'giá' }]);
    expect(chat).toHaveBeenCalledWith('a1', buildLeadPrompt([{ text: 'giá' }])); // đúng lời nhắc của chính nó, không thêm gì
    expect(out).toEqual([{ intent: 'buy', score: 80, reason: 'x' }]);
  });
  test('không có trợ lý mặc định -> null, không gọi AI', async () => {
    const chat = jest.fn();
    expect(await createLeadClassifier({ getAssistantId: () => null, complete: chat })([{ text: 'a' }])).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });
  test('AI ném lỗi hoặc trả JSON hỏng -> null', async () => {
    expect(await createLeadClassifier({ getAssistantId: () => 'a', complete: async () => { throw new Error('quota'); } })([{ text: 'a' }])).toBeNull();
    expect(await createLeadClassifier({ getAssistantId: () => 'a', complete: async () => ({ result: 'xin lỗi' }) })([{ text: 'a' }])).toBeNull();
  });
  test('quá hạn theo lô -> null', async () => {
    const never = () => new Promise<{ result: string }>(() => undefined);
    const out = await createLeadClassifier({ getAssistantId: () => 'a', complete: never, timeoutMs: 20 })([{ text: 'a' }]);
    expect(out).toBeNull();
  });
});

describe('openLoggedInSession', () => {
  const makeSession = () => {
    const page = { id: 'page' };
    const close = jest.fn().mockResolvedValue(undefined);
    return { close, session: { context: { pages: () => [page], newPage: async () => page } as any, close }, page };
  };
  test('đã đăng nhập: trả ctx, page và close', async () => {
    const { session, page, close } = makeSession();
    const opened = await openLoggedInSession(async () => session, async () => true);
    expect(opened.page).toBe(page);
    await opened.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
  test('chưa đăng nhập: đóng phiên và ném lỗi code logged_out', async () => {
    const { session, close } = makeSession();
    await expect(openLoggedInSession(async () => session, async () => false)).rejects.toMatchObject({ code: 'logged_out' });
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('buildLeadSheetRows', () => {
  test('cột tiếng Việt, trạng thái có nhãn', () => {
    const rows = buildLeadSheetRows([{
      id: 1, commentKey: 'k', postUrl: 'p', resultId: 1, groupUrl: 'g', campaignId: null, variant: '', profileId: 'x', authorId: 'a',
      authorName: 'An', authorUrl: 'u', text: 'giá?', commentedAtMs: null, matched: ['giá', 'phone'], aiIntent: null, aiScore: null,
      aiReason: null, status: 'won', note: 'n', detectedAt: 0, updatedAt: 0,
    }]);
    expect(rows[0]['Trạng thái']).toBe('Chốt đơn');
    expect(rows[0]['Từ khoá khớp']).toBe('giá, phone');
    expect(rows[0]['Bình luận lúc']).toBe('');
  });
});
