/**
 * Nhãn dán cho hộp thư Page, lấy thẳng từ Business Suite (không cần trình duyệt): danh sách gói trong khay, nhãn dán của
 * từng gói, và tìm theo từ khoá, đều kèm mã nhãn dán để gửi qua kết nối hộp thư. Các truy vấn và mã của chúng chép từ một
 * phiên Business Suite ngày 16/11/2026; khi Facebook đổi mã truy vấn, các hàm ở đây báo lỗi và bên gọi dùng đường khác.
 * Log không chứa cookie, mã phiên hay nội dung trả về.
 */
import axios from 'axios';
import Logger from '../../utils/Logger';
import { FB_USER_AGENT } from './facebookIdentity';
import type { PageWebSession } from './pageInboxProtocol';

const GRAPHQL_URL = 'https://business.facebook.com/api/graphql/';
const PACK_LIST_QUERY = { name: 'StickersFlyoutPackSelectorQuery', docId: '9935900063142310' };
const PACK_QUERY = { name: 'StickersFlyoutPackQuery', docId: '37626186746972141' };
// Truy vấn tìm theo từ khoá của cùng bảng chọn; tên biến và đường tới kết quả đọc từ mã trang Business Suite cùng ngày.
const SEARCH_QUERY = { name: 'StickersFlyoutTagSelectorQuery', docId: '9445868985541190' };

export interface PageSticker { stickerId: string; label: string; thumbUrl: string }

async function query(session: PageWebSession, q: { name: string; docId: string }, variables: Record<string, unknown>): Promise<any> {
  const body = new URLSearchParams({
    av: session.userId, __user: session.userId, __a: '1', __aaid: '0', __comet_req: '11', fb_dtsg: session.fbDtsg, jazoest: session.jazoest,
    ...(session.lsd ? { lsd: session.lsd } : {}),
    fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: q.name, variables: JSON.stringify(variables), server_timestamps: 'true', doc_id: q.docId,
  });
  const res = await axios.post(GRAPHQL_URL, body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded', 'Accept': '*/*', 'Origin': 'https://business.facebook.com',
      'Referer': 'https://business.facebook.com/', 'User-Agent': FB_USER_AGENT, 'x-fb-friendly-name': q.name,
      ...(session.lsd ? { 'x-fb-lsd': session.lsd } : {}), 'Cookie': session.cookieHeader,
    },
    timeout: 30_000, responseType: 'text', transformResponse: [(data: unknown) => data], validateStatus: () => true,
    ...(session.agent ? { httpsAgent: session.agent } : {}),
  });
  // Trả lời có thể gồm nhiều dòng JSON (phần đến sau); dòng đầu chứa dữ liệu chính.
  try { return JSON.parse(String(res.data ?? '').split('\n')[0]); } catch { return null; }
}

/** Mọi nhãn dán trong khay của tài khoản (không trùng). Ném lỗi nếu không lấy được danh sách gói hoặc không gói nào dùng được. */
export async function fetchPageStickers(session: PageWebSession): Promise<PageSticker[]> {
  const list = await query(session, PACK_LIST_QUERY, { stickerInterface: 'messages' });
  const packIds: string[] = (list?.data?.viewer?.sticker_store?.tray_packs?.edges ?? []).map((e: any) => String(e?.node?.id ?? '')).filter((id: string) => /^\d+$/.test(id));
  if (!packIds.length) throw new Error('Không lấy được danh sách gói nhãn dán');

  const stickers = new Map<string, PageSticker>();
  for (const packID of packIds) { // lần lượt từng gói, như người dùng bấm qua các gói
    try {
      const data = await query(session, PACK_QUERY, {
        stickerWidth: 128, stickerHeight: 128, packID, feedbackID: '', fetchAnimatedStickers: false, includeAvatarStickers: true,
        hasNoFeedbackID: true, numMRUStickers: 40, staticSendWidth: 512, staticSendHeight: 512,
      });
      for (const edge of data?.data?.node?.stickers?.edges ?? []) {
        const stickerId = String(edge?.node?.id ?? '');
        const thumbUrl = String(edge?.node?.image?.uri ?? '');
        if (/^\d+$/.test(stickerId) && thumbUrl && !stickers.has(stickerId)) stickers.set(stickerId, { stickerId, label: String(edge.node.label ?? ''), thumbUrl });
      }
    } catch (err: any) {
      Logger.warn(`[PageStickers] bỏ qua một gói nhãn dán: ${err?.message}`);
    }
  }
  if (!stickers.size) throw new Error('Các gói trả về không có nhãn dán');
  return [...stickers.values()];
}

/**
 * Tìm nhãn dán theo từ khoá trong kho của Facebook (không chỉ khay của tài khoản). Không có kết quả thì trả mảng rỗng;
 * ném lỗi khi Facebook không trả đúng dạng (mã truy vấn hết hạn, phiên hỏng) để bên gọi dùng đường khác.
 */
export async function searchPageStickers(session: PageWebSession, keyword: string): Promise<PageSticker[]> {
  const wanted = keyword.trim();
  if (!wanted) return [];
  const data = await query(session, SEARCH_QUERY, { query: wanted, stickerWidth: 128, stickerHeight: 128, stickerInterface: 'messages' });
  // Lỗi = không có trường sticker_search (mã truy vấn hết hạn, phiên hỏng). Có trường đó mà phần kết quả trống / null thì
  // chỉ là không khớp nhãn dán nào.
  if (!data?.data || typeof data.data !== 'object' || !('sticker_search' in data.data)) throw new Error('Facebook không trả kết quả tìm nhãn dán');
  const edges = data.data.sticker_search?.sticker_results?.edges;
  const stickers = new Map<string, PageSticker>();
  for (const edge of Array.isArray(edges) ? edges : []) {
    const stickerId = String(edge?.node?.id ?? '');
    const thumbUrl = String(edge?.node?.image?.uri ?? '');
    if (/^\d+$/.test(stickerId) && thumbUrl && !stickers.has(stickerId)) stickers.set(stickerId, { stickerId, label: String(edge.node.label ?? ''), thumbUrl });
  }
  return [...stickers.values()];
}

const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();

/** Nhãn dán có mô tả chứa từ khoá (không phân biệt hoa thường và dấu tiếng Việt); từ khoá rỗng = tất cả. Tối đa `max`. */
export function findStickers(all: PageSticker[], keyword: string, max: number): PageSticker[] {
  const wanted = fold(keyword.trim());
  return (wanted ? all.filter(s => fold(s.label).includes(wanted)) : all).slice(0, max);
}
