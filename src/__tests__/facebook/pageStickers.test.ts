jest.mock('axios');
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import axios from 'axios';
import Logger from '../../utils/Logger';
import { fetchPageStickers, findStickers, searchPageStickers } from '../../services/facebook/pageStickers';

// Mọi id, mã phiên và cookie ở đây đều giả.
const SESSION = { pageId: '1000000000003955', userId: '100000000008724', cookieHeader: 'c_user=100000000008724; xs=SECRETXS', agent: 'AGENT', fbDtsg: 'DTSG:SECRET', lsd: 'LSD-SECRET', jazoest: '25999' };
const post = axios.post as jest.Mock;
const packs = (...ids: string[]) => ({ data: { viewer: { sticker_store: { tray_packs: { edges: ids.map(id => ({ node: { id, name: `Pack ${id}` } })) } } } } });
const pack = (...stickers: Array<[string, string]>) =>
  ({ data: { node: { stickers: { edges: stickers.map(([id, label]) => ({ node: { id, label, image: { uri: `https://x.test/${id}.png` } } })) } } } });
const form = (call: any[]) => Object.fromEntries(new URLSearchParams(call[1] as string));

describe('pageStickers', () => {
  beforeEach(() => { post.mockReset(); (Logger.warn as jest.Mock).mockClear(); });

  // Hai truy vấn của bảng nhãn dán Business Suite (bản ghi 16/11/2026): danh sách gói, rồi nhãn dán của từng gói.
  test('listsTheStickersOfEveryTrayPackWithTheirIds', async () => {
    post
      .mockResolvedValueOnce({ status: 200, data: JSON.stringify(packs('111', '222')) })
      .mockResolvedValueOnce({ status: 200, data: `${JSON.stringify(pack(['369239263222822', 'Mèo vui vẻ'], ['369239263222823', 'Mèo buồn']))}\n{"label":"deferred"}` })
      .mockResolvedValueOnce({ status: 200, data: JSON.stringify(pack(['369239263222824', 'Gấu yêu'])) });
    await expect(fetchPageStickers(SESSION)).resolves.toEqual([
      { stickerId: '369239263222822', label: 'Mèo vui vẻ', thumbUrl: 'https://x.test/369239263222822.png' },
      { stickerId: '369239263222823', label: 'Mèo buồn', thumbUrl: 'https://x.test/369239263222823.png' },
      { stickerId: '369239263222824', label: 'Gấu yêu', thumbUrl: 'https://x.test/369239263222824.png' },
    ]);

    expect(post.mock.calls.map(c => c[0])).toEqual(Array(3).fill('https://business.facebook.com/api/graphql/'));
    expect(form(post.mock.calls[0])).toMatchObject({
      av: SESSION.userId, __user: SESSION.userId, __a: '1', fb_dtsg: SESSION.fbDtsg, jazoest: '25999', lsd: SESSION.lsd,
      fb_api_req_friendly_name: 'StickersFlyoutPackSelectorQuery', variables: '{"stickerInterface":"messages"}',
    });
    expect(form(post.mock.calls[0]).doc_id).toMatch(/^\d+$/);
    expect(form(post.mock.calls[1]).fb_api_req_friendly_name).toBe('StickersFlyoutPackQuery');
    expect(JSON.parse(form(post.mock.calls[1]).variables)).toMatchObject({ packID: '111', stickerWidth: 128, hasNoFeedbackID: true });
    expect(JSON.parse(form(post.mock.calls[2]).variables).packID).toBe('222');
    expect(post.mock.calls[0][2].headers).toMatchObject({ Cookie: SESSION.cookieHeader, Origin: 'https://business.facebook.com' });
    expect(post.mock.calls[0][2].httpsAgent).toBe('AGENT');
  });

  test('aPackThatFailsIsSkippedAndDuplicatesAreDropped', async () => {
    post
      .mockResolvedValueOnce({ status: 200, data: JSON.stringify(packs('111', '222', '333')) })
      .mockResolvedValueOnce({ status: 200, data: JSON.stringify(pack(['1', 'A'])) })
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ status: 200, data: JSON.stringify(pack(['1', 'A'], ['2', 'B'], ['x', 'no id'], ['3', ''])) });
    expect((await fetchPageStickers(SESSION)).map(s => s.stickerId)).toEqual(['1', '2', '3']);
  });

  // Mã truy vấn hết hạn hoặc phiên hỏng: báo lỗi để bên gọi dùng đường khác, không trả danh sách rỗng như thể không có nhãn dán.
  test('anUnusablePackListIsAnError', async () => {
    post.mockResolvedValue({ status: 200, data: 'for (;;);{"error":1357004,"errorSummary":"SECRET"}' });
    await expect(fetchPageStickers(SESSION)).rejects.toThrow('danh sách gói nhãn dán');
    post.mockReset();
    post.mockResolvedValueOnce({ status: 200, data: JSON.stringify(packs('111')) }).mockResolvedValueOnce({ status: 500, data: '' });
    await expect(fetchPageStickers(SESSION)).rejects.toThrow('không có nhãn dán');
    expect(((Logger.warn as jest.Mock).mock.calls.map(c => String(c[0])).join('\n'))).not.toMatch(/SECRET/);
  });

  // Truy vấn tìm nhãn dán của bảng chọn Business Suite (đọc từ mã trang trong bản ghi 16/11/2026): biến `query`,
  // kết quả ở sticker_search.sticker_results.
  test('searchAsksFacebookForTheKeywordAndReturnsStickersWithIds', async () => {
    post.mockResolvedValue({ status: 200, data: JSON.stringify({ data: { sticker_search: { sticker_results: { edges: [
      { node: { id: '369239263222830', label: 'Haha', image: { uri: 'https://x.test/h.png' } } },
      { node: { id: '369239263222830', label: 'Haha', image: { uri: 'https://x.test/h.png' } } },
      { node: { id: 'bad', label: 'x', image: { uri: 'https://x.test/b.png' } } },
      { node: { id: '369239263222831', label: 'Cười', image: null } },
    ] } } } }) });
    await expect(searchPageStickers(SESSION, ' haha ')).resolves.toEqual([{ stickerId: '369239263222830', label: 'Haha', thumbUrl: 'https://x.test/h.png' }]);
    expect(post.mock.calls[0][0]).toBe('https://business.facebook.com/api/graphql/');
    expect(form(post.mock.calls[0])).toMatchObject({ fb_api_req_friendly_name: 'StickersFlyoutTagSelectorQuery', av: SESSION.userId, fb_dtsg: SESSION.fbDtsg });
    expect(JSON.parse(form(post.mock.calls[0]).variables)).toEqual({ query: 'haha', stickerWidth: 128, stickerHeight: 128, stickerInterface: 'messages' });
  });

  // Không có kết quả là câu trả lời hợp lệ; câu trả lời không đúng dạng (mã truy vấn hết hạn, phiên hỏng) là lỗi.
  test('noResultsIsAnEmptyListButAnUnusableAnswerIsAnError', async () => {
    post.mockResolvedValue({ status: 200, data: JSON.stringify({ data: { sticker_search: { sticker_results: { edges: [] } } } }) });
    await expect(searchPageStickers(SESSION, 'zzz')).resolves.toEqual([]);
    // Facebook có thể trả phần kết quả là null khi không khớp gì: vẫn là "không có kết quả", không phải lỗi.
    for (const empty of [{ sticker_search: null }, { sticker_search: { sticker_results: null } }, { sticker_search: {} }]) {
      post.mockResolvedValue({ status: 200, data: JSON.stringify({ data: empty }) });
      await expect(searchPageStickers(SESSION, 'zzz')).resolves.toEqual([]);
    }
    post.mockResolvedValue({ status: 200, data: 'for (;;);{"error":1357004}' });
    await expect(searchPageStickers(SESSION, 'zzz')).rejects.toThrow('tìm nhãn dán');
    post.mockResolvedValue({ status: 200, data: JSON.stringify({ data: { viewer: {} }, errors: [{ message: 'x' }] }) });
    await expect(searchPageStickers(SESSION, 'zzz')).rejects.toThrow('tìm nhãn dán');
    post.mockReset();
    await expect(searchPageStickers(SESSION, '   ')).resolves.toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });

  test('findingIgnoresCaseAndVietnameseAccentsAndAnEmptyKeywordListsEverything', () => {
    const all = [
      { stickerId: '1', label: 'Mèo vui vẻ', thumbUrl: 'a' }, { stickerId: '2', label: 'Gấu Buồn', thumbUrl: 'b' }, { stickerId: '3', label: 'Đi ngủ', thumbUrl: 'c' },
    ];
    expect(findStickers(all, 'VUI', 10).map(s => s.stickerId)).toEqual(['1']);
    expect(findStickers(all, 'buon', 10).map(s => s.stickerId)).toEqual(['2']);
    expect(findStickers(all, 'di ngu', 10).map(s => s.stickerId)).toEqual(['3']);
    expect(findStickers(all, '  ', 2).map(s => s.stickerId)).toEqual(['1', '2']);
    expect(findStickers(all, 'khong co', 10)).toEqual([]);
  });
});
