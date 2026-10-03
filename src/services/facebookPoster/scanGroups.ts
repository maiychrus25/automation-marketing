/// <reference lib="dom" />
// In-page functions below run in the browser; electron tsconfig has no DOM lib, so pull it in for this file.
import type { TaskDeps } from './types';
import { FB_HOME, isLoggedIn } from './loginState';

const FB = 'https://www.facebook.com';

export interface ScannedGroup { id: string; name: string; url: string; }

interface RawLink { href?: unknown; text?: unknown; }

// Ba link điều hướng này cũng khớp mẫu /groups/<gì đó>/ nên phải loại tên.
// Đo trên trang thật: /groups/feed/, /groups/discover/, /groups/joins/ đều
// nằm lẫn cùng link nhóm trong cùng một lần querySelectorAll.
const NOT_GROUP_IDS = new Set(['feed', 'discover', 'joins', 'create', 'search']);

/**
 * Lọc mảng {href, text} gom từ DOM thành danh sách nhóm sạch.
 * Facebook nhét rất nhiều tham số vào href (?__cft__[0]=..., ?notif_id=...),
 * và text của link thường có thêm dòng "Last active 4 hours ago".
 */
export function parseGroupLinks(raw: unknown): ScannedGroup[] {
    const byId = new Map<string, ScannedGroup>();

    for (const link of (raw as RawLink[] | null | undefined) || []) {
        const href = link && link.href;
        if (!href) continue;

        const match = String(href).match(/\/groups\/([^/?#]+)/);
        if (!match) continue;

        const id = match[1];
        if (NOT_GROUP_IDS.has(id)) continue;

        const name = String(link.text || '').split('\n')[0].trim();
        const entry: ScannedGroup = { id, name, url: `${FB}/groups/${id}/` };

        // Giữ TÊN ĐẦU TIÊN KHÔNG RỖNG theo thứ tự DOM. Đo trên trang thật: trong
        // [role="main"] Facebook dựng lần lượt link ảnh (không chữ) -> link tên ->
        // nút "View group". Lấy "tên dài nhất" sẽ chọn trúng "View group".
        const seen = byId.get(id);
        if (!seen) byId.set(id, entry);
        else if (!seen.name && entry.name) byId.set(id, entry);
    }

    return Array.from(byId.values());
}

const JOINS_URL = `${FB}/groups/joins/`;

/**
 * Cuộn xuống đáy để Facebook nạp thêm nhóm. Trang "Nhóm của bạn" dùng cuộn vô
 * hạn: chỉ dựng sẵn khoảng một màn hình rồi tải tiếp khi người dùng cuộn. Đọc
 * DOM một lần mà không cuộn thì chỉ thấy ~20 nhóm đầu.
 * Chạy ở ngữ cảnh trình duyệt, không thấy biến của Node.
 */
function scrollToBottomInPage(): number {
    window.scrollTo(0, document.body.scrollHeight);
    return document.body.scrollHeight;
}

/**
 * Gom link trong trang. Chạy ở ngữ cảnh trình duyệt, không thấy biến của Node.
 * CHỈ gom trong [role="main"]. Đo trên trang thật: cùng một nhóm có 7 link, và
 * 4 trong số đó nằm NGOÀI main — ba link thông báo ("UnreadHaha is almost
 * complete. Invite your friends…") và một link sidebar. Gom cả trang thì tên
 * nhóm bị lấy từ chữ trong thông báo.
 */
function collectGroupLinksInPage(): { href: string; text: string }[] {
    const root: ParentNode = document.querySelector('[role="main"]') || document;
    return Array.from(root.querySelectorAll('a[href*="/groups/"]')).map(a => ({
        href: a.getAttribute('href') || '',
        text: (a as HTMLElement).innerText || '',
    }));
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface ScanGroupsResult {
    groups: ScannedGroup[];
    hitScrollLimit: boolean;
    scrollRounds: number;
    scrollError: boolean;
}

/**
 * Mở profile, vào trang "Your groups", gom link rồi lọc.
 * Kiểm tra đăng nhập TRƯỚC: chưa đăng nhập thì Facebook chuyển hướng
 * /groups/joins/ về trang đăng nhập, hàm này trả mảng rỗng và người dùng
 * nhận thông báo sai là "Facebook đổi giao diện".
 */
export async function scanGroups(deps: TaskDeps & {
    settleMs?: number;
    scrollWaitMs?: number;
    // Trần này CHỈ là lưới an toàn chống lặp vô hạn, không phải hạn mức thời
    // gian. Thứ dừng vòng lặp trong thực tế là quy tắc "mấy vòng liên tiếp
    // không thêm nhóm nào" bên dưới — tài khoản ít nhóm dừng sau vài vòng dù
    // trần có cao đến đâu. Đặt thấp là cắt cụt danh sách của người nhiều nhóm
    // mà không được gì: 200 vòng ~ 1000 nhóm ở mức 5 nhóm/vòng.
    maxScrolls?: number;
    // Bao nhiêu vòng liên tiếp không thêm nhóm thì kết luận đã hết. Phải > 1:
    // Facebook có lúc khựng vài nhịp rồi mới trả lô sau, và kết luận sớm nghĩa
    // là cắt cụt danh sách rồi báo "xong" — không ai biết là thiếu. 4 vòng ở
    // mức chờ 2,5s chịu được khoảng 10 giây mạng ì. Mạng chậm hơn nữa thì tăng
    // `scrollWaitMs` chứ đừng giảm số này.
    patience?: number;
}): Promise<ScanGroupsResult> {
    const { settleMs = 8000, scrollWaitMs = 2500, maxScrolls = 200, patience = 4 } = deps;
    const { ctx, page } = await deps.launch();
    try {
        await page.goto(FB_HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
        if (!(await isLoggedIn(ctx))) {
            throw new Error('Chưa đăng nhập. Hãy bấm Đăng nhập trước khi quét.');
        }
        await page.goto(JOINS_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(settleMs);

        // CỘNG DỒN link qua từng vòng, không ghi đè. Facebook gỡ bớt node cũ khỏi
        // DOM khi cuộn xuống, nên đọc lại chỉ thấy phần đang hiển thị: ghi đè thì
        // vừa mất nhóm đã gom, vừa làm số đếm dao động lên xuống khiến bộ đếm
        // "không tăng" reset mãi và vòng lặp chạy tới trần rồi báo nhầm "danh
        // sách quá dài". parseGroupLinks đã gộp theo id nên cộng dồn là an toàn,
        // và nhờ vậy số nhóm chỉ có thể tăng — đúng như quy tắc dừng giả định.
        const collectedLinks = [...await page.evaluate(collectGroupLinksInPage)];
        let groups = parseGroupLinks(collectedLinks);
        let previousCount = -1;
        let noGrowthRounds = 0;
        let scrollRounds = 0;
        let scrollError = false;

        for (; scrollRounds < maxScrolls; scrollRounds++) {
            // Mấy vòng liên tiếp số nhóm không nhúc nhích thì kết luận Facebook hết
            // nhóm để nạp.
            if (groups.length === previousCount) {
                noGrowthRounds += 1;
                if (noGrowthRounds >= patience) break;
            } else {
                noGrowthRounds = 0;
            }
            previousCount = groups.length;

            try {
                await page.evaluate(scrollToBottomInPage);
                await sleep(scrollWaitMs);
                collectedLinks.push(...await page.evaluate(collectGroupLinksInPage));
            } catch {
                // Cuộn hoặc đọc hỏng giữa chừng: giữ phần đã gom còn hơn ném đi tất
                // cả, nhưng PHẢI báo ra ngoài — nếu không, danh sách cụt vì lỗi trông
                // y hệt danh sách đầy đủ, và người dùng tin là đã quét đủ.
                scrollError = true;
                break;
            }
            groups = parseGroupLinks(collectedLinks);
        }

        // Thoát vì hết vòng cho phép, không phải vì hết nhóm — người dùng phải
        // biết danh sách có thể còn thiếu. Im lặng cắt là báo láo.
        return { groups, hitScrollLimit: scrollRounds >= maxScrolls, scrollRounds, scrollError };
    } finally {
        await ctx.close().catch(() => {});
    }
}
