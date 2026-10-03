/// <reference lib="dom" />
// In-page functions below run in the browser; electron tsconfig has no DOM lib, so pull it in for this file.
import type { TaskDeps } from './types';
import { pickDelaySeconds } from './targets';

export interface CollectedComment {
    authorId: string;
    authorName: string;
    authorUrl: string;
    text: string;
    commentedAt: string;
    postUrl: string;
}

/**
 * Khoá chống trùng: cùng người + cùng bài + cùng nội dung là một bình luận.
 * Cố tình BỎ thời gian: nhãn "2 giờ" đổi theo lúc quét, đưa vào khoá thì quét
 * lại bài cũ sẽ nhân đôi mọi dòng.
 * \u0000 làm dấu ngăn vì không ký tự nào trong tên hay nội dung dùng nó.
 */
export function keyOf(c: Pick<CollectedComment, 'authorId' | 'postUrl' | 'text'>): string {
    return `${c.authorId}\u0000${c.postUrl}\u0000${c.text}`;
}

// Nhãn Facebook hiển thị. Mỗi phần tử là một mẫu regex dạng chuỗi, khớp
// không phân biệt hoa thường. Có cả tiếng Việt lẫn tiếng Anh vì giao diện
// Facebook đổi ngôn ngữ theo tài khoản, không theo máy.
// `( \d+)?` cho phép khớp cả "Xem thêm bình luận" lẫn "Xem thêm 5 bình luận" —
// Facebook hiện cả hai dạng tuỳ số bình luận còn lại.
export const MORE_COMMENTS = [
    'Xem thêm( \\d+)? bình luận', 'Xem \\d+ bình luận', 'Xem các bình luận trước',
    'View( \\d+)? more comments', 'View previous comments',
];

export const MORE_REPLIES = [
    '\\d+ phản hồi', 'Xem tất cả \\d+ phản hồi', 'Xem \\d+ phản hồi',
    '\\d+ repl(y|ies)', 'View \\d+ repl(y|ies)', 'View all \\d+ replies',
];

export const SORT_TRIGGER = ['Phù hợp nhất', 'Most relevant', 'Mới nhất', 'Newest'];
export const SORT_ALL = ['Tất cả bình luận', 'All comments'];

// aria-label của khối bình luận và khối phản hồi. Bài đăng cũng là
// role="article" nhưng aria-label bắt đầu bằng "Bài viết"/"Post", nên bị loại.
export const COMMENT_BLOCK_LABEL = /^(Bình luận|Phản hồi|Comment|Reply)/i;

/**
 * Bốn hàm dưới đây được truyền vào page.evaluate nên chạy TRONG trình duyệt:
 * chúng không nhìn thấy biến ngoài phạm vi của chính mình. Mọi hằng và hàm phụ
 * phải lặp lại bên trong. Đây là lý do COMMENT_BLOCK_LABEL xuất hiện lại ở mỗi hàm.
 */

export function readCommentsInPage({ selfId }: { selfId: string | null }): Omit<CollectedComment, 'postUrl'>[] {
    const BLOCK_LABEL = /^(Bình luận|Phản hồi|Comment|Reply)/i;
    const FB = 'https://www.facebook.com/';

    function normalizeAuthorLink(href: string | null): { id: string; url: string } | null {
        const raw = String(href || '');
        if (!raw) return null;
        // Link bọc phạm vi nhóm và link profile.php đều mang id số — ưu tiên.
        let m = raw.match(/\/groups\/\d+\/user\/(\d+)/);
        // id= có thể không đứng ngay sau "?" (vd "profile.php?ref=x&id=123") —
        // cho phép các tham số khác đứng trước, miễn "id=" vẫn thuộc query của
        // chính profile.php. Không gỡ neo "profile.php" hẳn ra: làm vậy sẽ khớp
        // luôn "id=" trong query của permalink.php (id nhóm/trang, không phải id
        // người), biến link bài thành link tác giả.
        if (!m) m = raw.match(/profile\.php\?(?:[^#]*&)?id=(\d+)/);
        if (m) return { id: m[1], url: FB + m[1] };
        // Còn lại: tên tuỳ chỉnh nằm ở đoạn đường dẫn đầu tiên. Cắt sạch query
        // và neo — Facebook nhét chuỗi theo dõi rất dài vào đó.
        const path = raw.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0];
        // Link bài, ảnh, video KHÔNG phải link người. Thiếu chốt này thì
        // "/cuahangabc/posts/222/" bị đọc thành tác giả tên "cuahangabc".
        if (/\/(posts|photo|photos|video|videos|watch|reel|permalink\.php|groups|events|story\.php)(\/|$)/i.test(path)) return null;
        const segment = path.split('/').filter(Boolean)[0];
        if (!segment || segment === 'profile.php') return null;
        return { id: segment, url: FB + segment };
    }

    const out: Omit<CollectedComment, 'postUrl'>[] = [];
    for (const el of Array.from(document.querySelectorAll('div[role="article"]'))) {
        if (!BLOCK_LABEL.test(el.getAttribute('aria-label') || '')) continue;

        let author: { id: string; url: string } | null = null;
        let name = '';
        for (const a of Array.from(el.querySelectorAll('a'))) {
            // Phản hồi lồng bên trong khối bình luận cha, nên querySelectorAll('a')
            // của cha cũng trả về thẻ <a> tác giả của mọi phản hồi con. Thiếu chốt
            // này thì khi tác giả của chính khối này không phân giải được (href
            // rỗng, tài khoản bị vô hiệu hoá...), vòng lặp rơi xuống link của con
            // và gán nhầm danh tính con cho bản ghi cha.
            if (a.closest('div[role="article"]') !== el) continue;
            const href = a.getAttribute('href') || '';
            // Link có comment_id là link thời gian, không phải link người.
            if (/comment_id=/.test(href)) continue;
            const info = normalizeAuthorLink(href);
            if (info) {
                author = info;
                name = (a.textContent || '').trim();
                break;
            }
        }
        if (!author) continue;
        if (selfId && author.id === String(selfId)) continue;

        const parts: string[] = [];
        for (const d of Array.from(el.querySelectorAll('div[dir="auto"]'))) {
            // Đoạn của khối lồng bên trong (phản hồi) thuộc về khối đó, không phải
            // khối này — nếu không lọc, bình luận cha nuốt hết nội dung con.
            if (d.closest('div[role="article"]') !== el) continue;
            if (d.closest('a')) continue;              // tên tác giả
            if (d.closest('[role="button"]')) continue; // Thích · Trả lời
            const t = (d.textContent || '').trim();
            if (t && t !== name) parts.push(t);
        }

        // Cùng lý do với chốt closest ở trên: querySelector tìm khắp cây con nên
        // có thể nhặt nhầm link thời gian của phản hồi con. Duyệt hết rồi lọc
        // đúng link thuộc khối này.
        const timeLink = Array.from(el.querySelectorAll('a[href*="comment_id"]'))
            .find(a => a.closest('div[role="article"]') === el) || null;

        out.push({
            authorId: author.id,
            authorName: name,
            authorUrl: author.url,
            text: parts.join('\n').trim(),
            commentedAt: timeLink ? (timeLink.textContent || '').trim() : '',
        });
    }
    return out;
}

/**
 * Có nhìn thấy vùng bình luận không. Đây là điều kiện để phân biệt "bài không
 * ai bình luận" với "không mở được bài" — hai thứ nhìn từ mã đều là 0 bình
 * luận, nhưng báo nhầm cái thứ hai thành cái thứ nhất là báo láo.
 */
export function hasCommentAreaInPage(): boolean {
    const BLOCK_LABEL = /^(Bình luận|Phản hồi|Comment|Reply)/i;
    for (const el of Array.from(document.querySelectorAll('div[role="article"]'))) {
        if (BLOCK_LABEL.test(el.getAttribute('aria-label') || '')) return true;
    }
    const bodyText = document.body ? (document.body.textContent || '') : '';
    return ['Viết bình luận', 'Write a comment', 'Bình luận với tư cách',
        'Comment as', 'Phù hợp nhất', 'Most relevant', 'Tất cả bình luận',
        'All comments'].some(label => bodyText.includes(label));
}

export function countCommentsInPage(): number {
    const BLOCK_LABEL = /^(Bình luận|Phản hồi|Comment|Reply)/i;
    let count = 0;
    for (const el of Array.from(document.querySelectorAll('div[role="article"]'))) {
        if (BLOCK_LABEL.test(el.getAttribute('aria-label') || '')) count += 1;
    }
    return count;
}

/** Bấm phần tử đầu tiên có chữ khớp một trong các nhãn. Trả true nếu đã bấm. */
export function clickLabelInPage(labels: string[]): boolean {
    for (const el of Array.from(document.querySelectorAll('div[role="button"], span, a'))) {
        const t = (el.textContent || '').trim();
        // Chuỗi dài là nội dung bài chứ không phải nhãn nút. 60 ký tự đủ rộng cho
        // "Xem tất cả 12 phản hồi" mà vẫn loại được đoạn văn.
        if (!t || t.length > 60) continue;
        if (!labels.some(l => new RegExp(l, 'i').test(t))) continue;
        const target = el as HTMLElement;
        if (typeof target.click !== 'function') continue;
        target.click();
        return true;
    }
    return false;
}

/** Nghỉ nhưng cắt nhỏ để huỷ giữa chừng không phải chờ hết cả khoảng. */
async function sleepStoppable(ms: number, sliceMs: number, getIsStopping: () => boolean): Promise<void> {
    let remaining = ms;
    while (remaining > 0) {
        if (getIsStopping()) return;
        const slice = Math.min(sliceMs, remaining);
        await new Promise<void>(resolve => setTimeout(resolve, slice));
        remaining -= slice;
    }
}

/** Id tài khoản đang đăng nhập, lấy từ cookie — khỏi phải điều hướng thêm. */
async function readOwnUserId(ctx: { cookies: (url: string) => Promise<{ name: string; value: string }[]> }): Promise<string | null> {
    try {
        const cookies = await ctx.cookies('https://www.facebook.com');
        const c = (cookies || []).find(x => x.name === 'c_user');
        return c ? String(c.value) : null;
    } catch {
        return null;
    }
}

type PageLike = {
    goto: (url: string, opts: { waitUntil: 'domcontentloaded'; timeout: number }) => Promise<unknown>;
    url: () => string;
    evaluate: (fn: (arg?: any) => any, arg?: any) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

type CollectedFromPost =
    | { outcome: 'done'; comments: Omit<CollectedComment, 'postUrl'>[]; error: null }
    | { outcome: 'failed'; comments: []; error: string };

async function collectFromPost(page: PageLike, postUrl: string, {
    maxPerPost, selfId, sleep, settleMs, getIsStopping, sendLog,
}: {
    maxPerPost: number;
    selfId: string | null;
    sleep: (ms: number) => Promise<void>;
    settleMs: number;
    getIsStopping: () => boolean;
    sendLog: TaskDeps['sendLog'];
}): Promise<CollectedFromPost> {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Link hỏng (bài đã xoá, hoặc id bị cắt cụt do ghép link sai — xem
    // findOwnPostUrl/buildPostUrl ở postToTargets) khiến Facebook chuyển hướng về
    // bảng tin. Bảng tin luôn có chữ "Viết bình luận" nên hasCommentAreaInPage
    // sẽ báo nhầm là có vùng bình luận — chốt URL này chặn TRƯỚC khi quét nhầm
    // bình luận của bảng tin (của người lạ) rồi ghi vào dữ liệu của khách.
    const currentUrl = page.url();
    if (!/\/posts\/|story_fbid=|\/permalink/.test(currentUrl)) {
        return { outcome: 'failed', comments: [], error: 'Bị chuyển hướng khỏi bài — bài có thể đã bị xoá hoặc link hỏng' };
    }

    // Mọi khoảng chờ trong hàm này suy ra từ settleMs, để test đặt settleMs = 0
    // là toàn bộ sập về 0. Chờ cứng 3000ms sẽ làm bộ test chạy hàng chục giây.
    await sleep(settleMs);

    if (!(await page.evaluate(hasCommentAreaInPage))) {
        // 0 bình luận mà không thấy vùng bình luận KHÔNG phải "không ai bình
        // luận" — nhiều khả năng bài đã bị xoá, hết quyền xem, hoặc chưa tải xong.
        return { outcome: 'failed', comments: [], error: 'Không mở được bài hoặc bài đã bị xoá' };
    }

    // Facebook mặc định "Phù hợp nhất" và giấu bớt. Không đổi được thì quét
    // phần đang hiện, không coi là lỗi.
    if (await page.evaluate(clickLabelInPage, SORT_TRIGGER)) {
        await sleep(Math.round(settleMs / 2));
        if (await page.evaluate(clickLabelInPage, SORT_ALL)) {
            await sleep(Math.round(settleMs * 0.8));
            sendLog('Đã đổi sắp xếp sang "Tất cả bình luận".', 'info');
        }
    }

    let previous = -1;
    let noGrowth = 0;
    let stoppedMidway = false;
    for (let i = 0; i < 30; i++) {
        if (getIsStopping()) { stoppedMidway = true; break; }
        const count = await page.evaluate(countCommentsInPage);
        if (count >= maxPerPost) break;
        // Bấm mà số bình luận không nhúc nhích hai lần liên tiếp nghĩa là nút
        // không còn tác dụng — chốt chặn vòng lặp vô hạn.
        if (count === previous) {
            noGrowth += 1;
            if (noGrowth >= 2) break;
        } else {
            noGrowth = 0;
        }
        previous = count;

        const clicked = (await page.evaluate(clickLabelInPage, MORE_COMMENTS))
            || (await page.evaluate(clickLabelInPage, MORE_REPLIES));
        if (!clicked) break;
        await sleep(Math.round(settleMs * 0.7));
    }
    // Bị huỷ đang lúc còn có thể tải thêm: những gì đọc được dưới đây chỉ là
    // phần đang hiện, không phải toàn bộ bình luận của bài — báo rõ để không bị
    // hiểu nhầm là đã quét xong.
    if (stoppedMidway) {
        sendLog(`Bài ${postUrl}: bị dừng khi đang tải thêm bình luận — kết quả có thể chưa đầy đủ.`, 'warning');
    }

    const blocks: Omit<CollectedComment, 'postUrl'>[] = await page.evaluate(readCommentsInPage, { selfId });
    // >= chứ không phải >: vòng lặp tải thêm bên trên đã thoát ngay khi
    // count >= maxPerPost, nên ca chạm trần thường gặp nhất là blocks.length đúng
    // bằng maxPerPost — dùng ">" bỏ sót đúng ca đó, chỉ bắn cảnh báo khi DOM
    // tình cờ nạp dư ra so với trần.
    if (blocks.length >= maxPerPost) {
        sendLog(
            `Bài ${postUrl}: đọc được ${blocks.length} bình luận nhưng đã chạm trần ${maxPerPost} — tăng ô "tối đa mỗi bài" rồi quét lại để lấy hết.`,
            'warning',
        );
    }
    return { outcome: 'done', comments: blocks.slice(0, maxPerPost), error: null };
}

export interface CollectCommentsInput {
    posts: { postUrl: string }[];
    minDelay?: number;
    maxDelay?: number;
    maxPerPost?: number;
    settleMs?: number;
}

export interface CollectCommentsResult {
    scanned: number;
    failed: number;
    added: number;
    results: { url: string; outcome: 'done' | 'failed'; error: string | null; added: number }[];
}

export async function collectComments(
    input: CollectCommentsInput,
    deps: TaskDeps & {
        loadKeys: () => Promise<Set<string>>;
        /** Returns how many rows were actually written (0 when the write failed). */
        saveComments: (rows: CollectedComment[]) => Promise<number>;
    },
): Promise<CollectCommentsResult> {
    const { getIsStopping, sendLog, updateProgress } = deps;
    const {
        posts, minDelay = 10, maxDelay = 20, maxPerPost = 100, settleMs = 3000,
    } = input || ({} as CollectCommentsInput);
    if (!Array.isArray(posts) || posts.length === 0) {
        throw new Error('Danh sách bài để quét trống!');
    }

    const knownKeys = await deps.loadKeys();
    const sleep = (ms: number) => sleepStoppable(ms, 500, getIsStopping);

    const { ctx, page } = await deps.launch();
    const results: CollectCommentsResult['results'] = [];
    let added = 0;

    try {
        const selfId = await readOwnUserId(ctx);
        if (!selfId) {
            sendLog('Không đọc được id tài khoản — bình luận của chính anh có thể lọt vào kết quả.', 'warning');
        }

        let current = 0;
        for (const p of posts) {
            if (getIsStopping()) break;
            current += 1;
            updateProgress(
                Math.round((current / posts.length) * 100),
                `Đang quét ${current}/${posts.length}`,
            );
            sendLog(`[${current}/${posts.length}] Đang mở bài: ${p.postUrl}`, 'info');

            let collected: CollectedFromPost;
            try {
                collected = await collectFromPost(page as unknown as PageLike, p.postUrl, {
                    maxPerPost, selfId, sleep, settleMs, getIsStopping, sendLog,
                });
            } catch (err) {
                collected = { outcome: 'failed', comments: [], error: err instanceof Error ? err.message : String(err) };
            }

            let written = 0;
            if (collected.outcome === 'failed') {
                sendLog(`Không quét được bài ${p.postUrl}: ${collected.error}`, 'error');
            } else {
                const fresh: CollectedComment[] = [];
                for (const c of collected.comments) {
                    const row: CollectedComment = { ...c, postUrl: p.postUrl };
                    const k = keyOf(row);
                    if (knownKeys.has(k)) continue;
                    knownKeys.add(k);
                    fresh.push(row);
                }
                // Ghi ngay sau mỗi bài, không dồn đến cuối: huỷ giữa chừng vẫn giữ
                // được phần đã thu.
                try {
                    written = fresh.length > 0 ? await deps.saveComments(fresh) : 0;
                } catch (err) {
                    // Kho cũ (appendComments) nuốt lỗi ghi và trả 0 — giữ nguyên: một lần
                    // ghi hỏng không được làm sập cả đợt thu, chỉ báo cho người vận hành.
                    sendLog(`Bài ${p.postUrl}: lỗi khi ghi bình luận: ${err instanceof Error ? err.message : String(err)}`, 'error');
                    written = 0;
                }
                added += written;
                // saveComments không được báo thành công với con số bịa khi kho
                // không nhận hết (đĩa đầy, mất quyền...).
                if (written !== fresh.length) {
                    sendLog(
                        `Bài ${p.postUrl}: đọc được ${collected.comments.length} bình luận nhưng chỉ ghi được ${written}/${fresh.length} — kiểm tra dung lượng đĩa hoặc quyền ghi.`,
                        'error',
                    );
                } else {
                    sendLog(
                        `Bài ${p.postUrl}: đọc được ${collected.comments.length} bình luận, mới ${fresh.length}.`,
                        'success',
                    );
                }
            }

            results.push({
                url: p.postUrl,
                outcome: collected.outcome,
                error: collected.error || null,
                added: written,
            });

            if (current < posts.length && !getIsStopping()) {
                const seconds = pickDelaySeconds(minDelay, maxDelay);
                if (seconds > 0) sendLog(`Nghỉ ${seconds} giây trước bài tiếp theo...`, 'info');
                await sleep(seconds * 1000);
            }
        }
        // Huỷ giữa chừng thì không được nhảy lên 100% "Hoàn tất" — job dừng ở
        // bài dở dang, không phải xong việc.
        if (!getIsStopping()) updateProgress(100, 'Hoàn tất');
    } finally {
        await ctx.close().catch(() => {});
    }

    const scanned = results.filter(r => r.outcome === 'done').length;
    return { scanned, failed: results.length - scanned, added, results };
}
