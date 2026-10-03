/// <reference lib="dom" />
// In-page functions below run in the browser; electron tsconfig has no DOM lib, so pull it in for this file.
import type { TaskDeps } from './types';
import { FB_HOME, isLoggedIn } from './loginState';
import { parseGroupLinks, scanGroups, type ScannedGroup } from './scanGroups';
import { delayRandom } from './humanize';
import { pickDelaySeconds } from './targets';

const FB = 'https://www.facebook.com';

export type JoinOutcome = 'joined' | 'pending' | 'skipped' | 'failed' | 'unknown';

export interface JoinResult { id: string; name: string; url: string; outcome: JoinOutcome; }

/** Dựng URL trang tìm nhóm. Tách riêng để kiểm được việc encode từ khoá có dấu. */
export function buildSearchUrl(keyword: string): string {
    const kw = String(keyword ?? '').trim();
    if (!kw) throw new Error('Từ khoá rỗng');
    return `${FB}/search/groups/?q=${encodeURIComponent(kw)}`;
}

/**
 * Gom link trong trang kết quả tìm. Chạy ở ngữ cảnh trình duyệt.
 * CHỈ gom trong [role="main"] — cùng lý do như trang Your groups: ngoài main có
 * link điều hướng và thông báo. Quảng cáo trong kết quả trỏ về Trang chứ không
 * phải /groups/ nên parseGroupLinks loại tự nhiên.
 */
function collectSearchLinksInPage(): { href: string; text: string }[] {
    const root: ParentNode = document.querySelector('[role="main"]') || document;
    return Array.from(root.querySelectorAll('a[href*="/groups/"]')).map(a => ({
        href: a.getAttribute('href') || '',
        text: (a as HTMLElement).innerText || '',
    }));
}

/** Tìm nhóm theo một từ khoá. Kiểm đăng nhập TRƯỚC khi vào trang tìm. */
export async function searchGroupsByKeyword(deps: Pick<TaskDeps, 'launch'> & {
    keyword: string;
    settleMs?: number;
}): Promise<ScannedGroup[]> {
    const { keyword, settleMs = 8000 } = deps;
    const url = buildSearchUrl(keyword);
    const { ctx, page } = await deps.launch();
    try {
        await page.goto(FB_HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
        if (!(await isLoggedIn(ctx))) {
            throw new Error('Chưa đăng nhập. Hãy bấm Đăng nhập trước khi tìm nhóm.');
        }
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await new Promise(resolve => setTimeout(resolve, settleMs));
        return parseGroupLinks(await page.evaluate(collectSearchLinksInPage));
    } finally {
        await ctx.close().catch(() => {});
    }
}

const JOIN_LABELS = ['Join group', 'Join Group', 'Join', 'Tham gia nhóm', 'Tham gia'];
const PENDING_LABELS = ['Pending', 'Cancel request', 'Đã gửi', 'Huỷ yêu cầu', 'Hủy yêu cầu'];
const JOINED_LABELS = ['Joined', 'Đã tham gia'];

/**
 * Tìm nút Tham gia và ĐÁNH DẤU nó (bên Node bấm bằng locator, click tin cậy).
 * CHẠY TRONG TRÌNH DUYỆT. Gỡ dấu cũ TRƯỚC khi tìm: locator `.first()` sẽ bấm
 * nhầm phần tử còn dấu nếu lần tìm này không thấy gì.
 * Quét MỌI phần tử khớp trong [role="main"], không lấy cái
 * đầu tiên — bài học đã trả giá hai lần trong dự án này: nút Đăng từng bắt
 * trúng "Share" ở header, và composer thật không phải dialog đầu tiên.
 * Tránh bấm nút Tham gia của nhóm được gợi ý nằm bên cạnh, và tránh bấm
 * nhầm nút Tham gia của một Sự kiện nằm trong bài đăng ở feed bên dưới.
 */
export function markJoinButtonInPage(arg: { labels: string[]; groupId: string }): boolean {
    document.querySelectorAll('[data-maihub-target]').forEach(e => e.removeAttribute('data-maihub-target'));
    const { labels, groupId } = arg || { labels: [], groupId: '' };
    const root: ParentNode & Element = (document.querySelector('[role="main"]') || document) as ParentNode & Element;
    const groupIdRe = groupId
        ? new RegExp(`/groups/${String(groupId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[/?]|$)`)
        : null;
    for (const el of Array.from(root.querySelectorAll('div[role="button"], a[role="button"]'))) {
        // Bỏ qua nút nằm trong bài viết/feed (vd. nút Tham gia của một Sự kiện
        // trong một bài đăng) — chỉ nút ở vùng đầu trang nhóm mới hợp lệ.
        let inFeed = false;
        for (let a = el.parentElement; a && a !== root; a = a.parentElement) {
            const role = a.getAttribute?.('role');
            if (role === 'article' || role === 'feed') { inFeed = true; break; }
        }
        if (inFeed) continue;

        // Bỏ qua nút nào có tổ tiên GẦN NHẤT xác nhận thuộc nhóm khác. Bằng
        // chứng gần nhất thắng: dừng leo ngay khi một tổ tiên xác nhận đúng
        // nhóm, để tổ tiên xa hơn (vd. cột chứa cả thẻ nhóm gợi ý) không ghi đè.
        let skip = false;
        if (groupIdRe) {
            let p = el.parentElement;
            while (p && p !== root) {
                const groupLink = p.querySelector?.('a[href*="/groups/"]');
                if (groupLink) {
                    const href = groupLink.getAttribute?.('href') || '';
                    if (groupIdRe.test(href)) break; // đúng nhóm — dừng, không skip
                    if (/\/groups\//.test(href)) { skip = true; break; }
                }
                p = p.parentElement;
            }
        }
        if (skip) continue;

        const label = (el.getAttribute('aria-label') || '').trim();
        const text = ((el as HTMLElement).innerText || '').trim().split('\n')[0];
        if (labels.includes(label) || labels.includes(text)) {
            el.setAttribute('data-maihub-target', 'join');
            return true;
        }
    }
    return false;
}

/**
 * Đọc kết quả sau khi bấm. Trả 'joined' | 'pending' | 'skipped' | 'unknown'.
 * Dùng lại đúng bộ lọc tổ tiên của markJoinButtonInPage (loại article/feed, và
 * groupId với "bằng chứng gần nhất thắng") — nếu không, một nhãn "Joined"
 * lạc trong mục "Nhóm liên quan" của trang nhóm sẽ bị đọc nhầm thành kết
 * quả của chính nhóm đang xử lý.
 */
export function readJoinOutcomeInPage(arg: {
    sets: { pending: string[]; joined: string[] };
    groupId: string;
}): JoinOutcome {
    const { sets, groupId } = arg || { sets: { pending: [], joined: [] }, groupId: '' };
    // Hộp thoại câu hỏi thành viên: có dialog VÀ trong đó có ô nhập.
    for (const d of Array.from(document.querySelectorAll('div[role="dialog"]'))) {
        const hasInput = d.querySelector('textarea, input[type="text"], div[contenteditable="true"]');
        if (hasInput) return 'skipped';
    }
    const root: ParentNode & Element = (document.querySelector('[role="main"]') || document) as ParentNode & Element;
    const groupIdRe = groupId
        ? new RegExp(`/groups/${String(groupId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[/?]|$)`)
        : null;

    const labels: string[] = [];
    for (const el of Array.from(root.querySelectorAll('div[role="button"], a[role="button"]'))) {
        let inFeed = false;
        for (let a = el.parentElement; a && a !== root; a = a.parentElement) {
            const role = a.getAttribute?.('role');
            if (role === 'article' || role === 'feed') { inFeed = true; break; }
        }
        if (inFeed) continue;

        let skip = false;
        if (groupIdRe) {
            let p = el.parentElement;
            while (p && p !== root) {
                const groupLink = p.querySelector?.('a[href*="/groups/"]');
                if (groupLink) {
                    const href = groupLink.getAttribute?.('href') || '';
                    if (groupIdRe.test(href)) break;
                    if (/\/groups\//.test(href)) { skip = true; break; }
                }
                p = p.parentElement;
            }
        }
        if (skip) continue;

        labels.push((el.getAttribute('aria-label') || '').trim() || ((el as HTMLElement).innerText || '').trim().split('\n')[0]);
    }

    if (labels.some(l => sets.pending.includes(l))) return 'pending';
    if (labels.some(l => sets.joined.includes(l))) return 'joined';
    return 'unknown';
}

/** Đóng hộp thoại câu hỏi thành viên. Không trả lời hộ người dùng. */
function closeDialogInPage(): boolean {
    for (const d of Array.from(document.querySelectorAll('div[role="dialog"]'))) {
        const close = Array.from(d.querySelectorAll('div[role="button"], a[role="button"]'))
            .find(b => /close|đóng/i.test(b.getAttribute('aria-label') || ''));
        if (close) { (close as HTMLElement).click(); return true; }
    }
    return false;
}

/**
 * Ngủ `ms` mili-giây theo lát `sliceMs`, kiểm getIsStopping() sau MỖI lát để
 * thoát sớm khi bị huỷ giữa chừng — thay vì giữ trình duyệt và slot job tới
 * hết cả khoảng nghỉ (có thể tới maxDelay giây). ms <= 0 thì không có lát
 * nào, không làm chậm test truyền delay 0.
 */
async function sleepStoppable(ms: number, sliceMs: number, getIsStopping: () => boolean): Promise<void> {
    let remaining = ms;
    while (remaining > 0) {
        const slice = Math.min(sliceMs, remaining);
        await delayRandom(slice, slice);
        remaining -= slice;
        if (getIsStopping()) return;
    }
}

export async function searchAndJoinGroups(
    input: { keywords: string[]; limit?: number; minDelay?: number; maxDelay?: number },
    deps: TaskDeps & {
        onResult?: (r: JoinResult) => void;
        settleMs?: number;
        // Chuyển tiếp xuống scan giống settleMs đã có từ trước: để nơi gọi và
        // test điều khiển được thời gian quét, không phải chờ mặc định thật của
        // scanGroups. KHÔNG đặt mặc định ở đây — undefined chảy xuống, scanGroups
        // tự áp mặc định của chính nó. Đặt hai bản dễ lệch nhau khi một bên đổi.
        scrollWaitMs?: number;
        maxScrolls?: number;
        patience?: number;
        groupSettleMs?: number;
        pollMs?: number;
        joinWaitMs?: number;
        restCheckMs?: number;
        scan?: typeof scanGroups;
        search?: typeof searchGroupsByKeyword;
    },
): Promise<{ joined: number; pending: number; skipped: number; failed: number; results: JoinResult[] }> {
    const {
        settleMs = 8000,
        scrollWaitMs,
        maxScrolls,
        patience,
        groupSettleMs = 3000,
        pollMs = 1000,
        joinWaitMs = 20000,
        restCheckMs = 1000,
        scan = scanGroups,
        search = searchGroupsByKeyword,
        getIsStopping,
        sendLog,
        updateProgress,
        onResult,
    } = deps;
    const { keywords, minDelay = 300, maxDelay = 900, limit = 10 } = input || ({} as Partial<typeof input>);
    if (!Array.isArray(keywords) || keywords.length === 0) {
        throw new Error('Danh sách từ khoá trống!');
    }

    sendLog('Đang lấy danh sách nhóm đã tham gia để khỏi gửi trùng...', 'info');
    const scanned = await scan({
        launch: deps.launch, getIsStopping, sendLog, updateProgress,
        settleMs, scrollWaitMs, maxScrolls, patience,
    });
    const already = new Set(scanned.groups.map(g => g.id));
    sendLog(`Tài khoản đang ở trong ${already.size} nhóm.`, 'info');
    if (scanned.hitScrollLimit || scanned.scrollError) {
        // Danh sách cụt mà im lặng thì công cụ sẽ gửi lại yêu cầu vào nhóm đã ở
        // trong, rồi đếm chính nó là thất bại.
        sendLog(
            `Danh sách nhóm đã tham gia CÓ THỂ THIẾU (${scanned.hitScrollLimit ? 'quá dài, chạm trần cuộn' : 'cuộn lỗi giữa chừng'}) — có thể gửi lại yêu cầu vào nhóm đã ở trong.`,
            'warning',
        );
    }

    // Tìm hết các từ khoá trước, rồi mới cắt theo limit — để limit là tổng số
    // nhóm gửi yêu cầu một lần chạy, không phải mỗi từ khoá.
    const seen = new Set<string>();
    const candidates: ScannedGroup[] = [];
    let foundAny = false;
    for (const keyword of keywords) {
        if (getIsStopping()) break;
        sendLog(`Đang tìm nhóm với từ khoá "${keyword}"...`, 'info');
        const found = await search({ keyword, launch: deps.launch, settleMs });
        if (found.length > 0) foundAny = true;
        const fresh = found.filter(g => !already.has(g.id) && !seen.has(g.id));
        fresh.forEach(g => seen.add(g.id));
        if (found.length === 0) {
            sendLog(`Từ khoá "${keyword}" không tìm thấy nhóm nào.`, 'warning');
        } else {
            sendLog(`Từ khoá "${keyword}": ${found.length} nhóm, ${fresh.length} nhóm mới.`, 'info');
        }
        candidates.push(...fresh);
    }

    const targets = candidates.slice(0, limit);
    if (targets.length === 0) {
        // Hai tình huống khác nhau, không được gộp thành một câu: từ khoá không
        // ra kết quả gì, khác hẳn tìm ra nhóm nhưng toàn nhóm đã ở trong/trùng.
        if (foundAny) {
            sendLog(
                'Tìm thấy nhóm nhưng tất cả đều đã tham gia hoặc trùng lặp — không có nhóm mới để gửi yêu cầu.',
                'warning',
            );
        } else {
            sendLog('Không tìm thấy nhóm nào khớp từ khoá đã nhập.', 'warning');
        }
        return { joined: 0, pending: 0, skipped: 0, failed: 0, results: [] };
    }
    sendLog(`Sẽ gửi yêu cầu tham gia ${targets.length} nhóm.`, 'info');

    const { ctx, page } = await deps.launch();
    const results: JoinResult[] = [];
    try {
        let current = 0;
        for (const g of targets) {
            if (getIsStopping()) break;
            current += 1;
            updateProgress(Math.round((current / targets.length) * 100), `Đang xử lý ${current}/${targets.length}`);

            let outcome: JoinOutcome = 'failed';
            try {
                await page.goto(g.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
                await delayRandom(groupSettleMs, Math.round(groupSettleMs * 1.6));

                if (!(await page.evaluate(markJoinButtonInPage, { labels: JOIN_LABELS, groupId: g.id }))) {
                    sendLog(`Không tìm thấy nút Tham gia ở ${g.url}`, 'error');
                } else {
                    // Click tin cậy qua locator. Lỗi click không được làm hỏng luồng
                    // ngay: không có bằng chứng nào ở đây cả, quyết định nằm ở phần
                    // đọc lại nút bên dưới (bằng chứng dương), không ở việc click.
                    try {
                        await page.locator('[data-maihub-target="join"]').first().click({ timeout: 10000 });
                    } catch (e) {
                        sendLog(`Bấm nút Tham gia không được: ${(e as Error).message}`, 'warning');
                    }
                    const sets = { pending: PENDING_LABELS, joined: JOINED_LABELS };
                    const deadline = Date.now() + joinWaitMs;
                    let read: JoinOutcome = 'unknown';
                    do {
                        await delayRandom(pollMs, pollMs);
                        read = await page.evaluate(readJoinOutcomeInPage, { sets, groupId: g.id });
                    } while (read === 'unknown' && Date.now() < deadline);

                    if (read === 'skipped') {
                        // Nhóm hỏi câu hỏi thành viên. Theo yêu cầu của người dùng: KHÔNG
                        // trả lời (trả lời hộ là đoán mò nội dung thay họ), chỉ đóng hộp
                        // thoại rồi đọc lại trạng thái nút một lần nữa.
                        await page.evaluate(closeDialogInPage);
                        await delayRandom(pollMs, pollMs);
                        const afterClose = await page.evaluate(readJoinOutcomeInPage, { sets, groupId: g.id });

                        if (afterClose === 'joined' || afterClose === 'pending') {
                            outcome = afterClose;
                            sendLog(`Nhóm "${g.name}" có câu hỏi thành viên; không trả lời nhưng nút đã đổi — ${afterClose === 'joined' ? 'đã tham gia' : 'đã gửi yêu cầu, chờ duyệt'}.`,
                                'success');
                        } else {
                            // Nút chưa đổi. Đóng hộp câu hỏi rất có thể đã huỷ luôn yêu cầu,
                            // nên đây KHÔNG phải bằng chứng đã gửi. Người dùng vẫn muốn xếp
                            // vào pending, nhưng nhật ký phải nói rõ là chưa xác nhận được —
                            // dự án này đã có một lần nhật ký báo thành công mà thực tế không.
                            outcome = 'pending';
                            sendLog(`Nhóm "${g.name}" có câu hỏi thành viên; đã bấm Tham gia và bỏ qua câu hỏi, nhưng CHƯA xác nhận được yêu cầu đã gửi. Xếp tạm vào chờ duyệt — hãy kiểm tra ở facebook.com/groups/joins/`,
                                'warning');
                        }
                    } else if (read === 'joined' || read === 'pending') {
                        outcome = read;
                        sendLog(`Nhóm "${g.name}": ${read === 'joined' ? 'đã tham gia' : 'đã gửi yêu cầu, chờ duyệt'}.`,
                            'success');
                    } else {
                        // 'unknown' (hết giờ chờ) hoặc bất kỳ giá trị lạ nào khác — chỉ
                        // 'joined'/'pending' mới được coi là dấu hiệu dương.
                        sendLog(`Nhóm "${g.name}": không rõ kết quả sau ${joinWaitMs / 1000}s.`, 'error');
                    }
                }
            } catch (err) {
                sendLog(`Lỗi khi tham gia ${g.url}: ${(err as Error).message}`, 'error');
            }

            const entry: JoinResult = { id: g.id, name: g.name, url: g.url, outcome };
            results.push(entry);
            // Báo ngay khi nhóm này xong để nơi gọi ghi lịch sử/hiển thị từng bước.
            try {
                onResult?.(entry);
            } catch (err) {
                // Lỗi ở nơi nhận kết quả không được làm dừng các nhóm còn lại.
                sendLog(`Lỗi khi báo kết quả ${g.url}: ${(err as Error).message}`, 'warning');
            }

            if (current < targets.length && !getIsStopping()) {
                const secs = pickDelaySeconds(minDelay, maxDelay);
                sendLog(`Nghỉ ${secs} giây trước nhóm tiếp theo...`, 'info');
                await sleepStoppable(secs * 1000, restCheckMs, getIsStopping);
            }
        }
        updateProgress(100, 'Hoàn tất');
    } finally {
        await ctx.close().catch(() => {});
    }

    const count = (o: JoinOutcome) => results.filter(r => r.outcome === o).length;
    return {
        joined: count('joined'), pending: count('pending'),
        skipped: count('skipped'), failed: count('failed'), results,
    };
}
