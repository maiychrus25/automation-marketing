import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import {
  commentIdKey, findReplyTarget, findNewReplyBox, replyBoundary, threadMatchCount, confirmReply, postCommentReply,
  markReplyButtonInPage, markReplyBoxInPage, readReplySnapshotInPage, type ReplySnapshotItem, type ReplyTarget,
} from '../../services/facebookPoster/commentReply';
import { runWithFakeTimers } from './helpers';

// Fixture tổng hợp (tên/id/chữ giả) theo cấu trúc trang bài thật có ô trả lời đang mở — xem chú thích đầu file.
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'comment-reply.html'), 'utf8');
type State = 'closed' | 'open' | 'posted';

/** Dựng snapshot như readReplySnapshotInPage trả về, bằng regex trên fixture phẳng (không có DOM trong jest). */
function snapshotOf(state: State): ReplySnapshotItem[] {
  let html = FIXTURE.replace(/<!--[\s\S]*?-->/g, (m) => (/^<!-- \/(posted-reply|composer) -->$/.test(m) ? m : ''));
  if (state !== 'posted') html = html.replace(/<div data-fixture="posted-reply">[\s\S]*?<!-- \/posted-reply -->/, '');
  if (state === 'closed') html = html.replace(/<div data-fixture="composer">[\s\S]*?<!-- \/composer -->/, '');
  const tags = [...html.matchAll(/<div\b([^>]*\brole="(article|textbox)"[^>]*)>/g)];
  return tags.map((m, i) => {
    const attrs = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    if (m[2] === 'textbox') return { kind: 'box', label: attrs['aria-label'] ?? '', text: '', commentIds: [], isReply: false, inArticle: false, seen: false };
    const region = html.slice(m.index! + m[0].length, i + 1 < tags.length ? tags[i + 1].index : html.length);
    const ids = [...region.matchAll(/href="([^"]*comment_id=[^"]*)"/g)].map((h) => {
      const q = new URLSearchParams(h[1].replace(/&amp;/g, '&').split('?')[1]);
      return q.get('reply_comment_id') || q.get('comment_id') || '';
    });
    return { kind: 'article', label: attrs['aria-label'] ?? '', text: region.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), commentIds: [...new Set(ids)], isReply: /reply_comment_id=/.test(region), inArticle: false, seen: false };
  });
}

const REPLY = 'Dạ còn size 42 ạ, anh ghé shop nhé';
const BY_ID: ReplyTarget = { commentId: '9102' };
const BY_AUTHOR: ReplyTarget = { author: 'Khách Thử Hai', excerpt: 'Còn size 42 không shop?' };
/** Ô mới hiện SAU bình luận kế tiếp (ô bình luận cấp bài nạp muộn, hoặc ô của bình luận khác). */
function boxAfterNextComment(): ReplySnapshotItem[] {
  const items = snapshotOf('open');
  const [box] = items.splice(3, 1);
  items.splice(4, 0, box); // sau 9103
  return items;
}

describe('fixture snapshot', () => {
  test('cấu trúc ba trạng thái đúng như mẫu thật: ô trả lời ngoài khối, sau bình luận được trả lời', () => {
    expect(snapshotOf('closed').map((i) => i.kind)).toEqual(['article', 'article', 'article', 'article', 'article']);
    expect(snapshotOf('open').map((i) => i.kind)).toEqual(['article', 'article', 'article', 'box', 'article', 'article']);
    expect(snapshotOf('posted').map((i) => i.kind)).toEqual(['article', 'article', 'article', 'article', 'box', 'article', 'article']);
    expect(snapshotOf('posted')[3]).toMatchObject({ commentIds: ['Y29tbWVudDo5MDAwMF85MjAx', '9201'], isReply: true });
    expect(snapshotOf('posted').filter((i) => i.isReply)).toHaveLength(1);
  });
});

describe('commentIdKey', () => {
  test.each([
    ['9102', '9102'], ['Y29tbWVudDo5MDAwMF85MTAy', '9102'], ['comment:90000_9102', '9102'], ['90000_9102', '9102'], [' 9102 ', '9102'],
    ['', null], ['xyz!', null], ['abcd', null],
  ])('%s -> %s', (raw, key) => { expect(commentIdKey(raw)).toBe(key); });
});

describe('findReplyTarget', () => {
  const closed = snapshotOf('closed');
  test.each([
    ['numeric id', BY_ID, 2], ['base64 id', { commentId: 'Y29tbWVudDo5MDAwMF85MTAy' }, 2], ['author + excerpt', BY_AUTHOR, 2],
    ['author spacing/case', { author: '  khách  thử hai ', excerpt: 'còn SIZE 42' }, 2], ['same author, unique excerpt', { author: 'Khách Thử Ba', excerpt: 'Mình lấy size 40' }, 4],
  ] as [string, ReplyTarget, number][])('unique: %s', (_l, target, index) => { expect(findReplyTarget(closed, target)).toEqual({ index }); });

  test.each([
    ['same author, shared excerpt', { author: 'Khách Thử Ba', excerpt: 'Còn hàng không shop' }, 'many'],
    ['unknown id', { commentId: '9999' }, 'none'],
    ['unreadable id', { commentId: 'xyz!', author: 'Khách Thử Hai', excerpt: 'Còn size 42' }, 'none'],
    ['unknown author', { author: 'Khách Thử Bốn', excerpt: 'Còn size 42' }, 'none'],
    ['author without excerpt', { author: 'Khách Thử Hai' }, 'none'],
    ['name only part of the label word', { author: 'Khách Thử H', excerpt: 'Còn size 42' }, 'none'],
  ] as [string, ReplyTarget, string][])('not unique: %s', (_l, target, error) => { expect(findReplyTarget(closed, target)).toEqual({ error }); });

  test('id của câu trả lời (reply_comment_id) không bị nhận là bình luận cha', () => {
    expect(findReplyTarget(snapshotOf('posted'), BY_ID)).toEqual({ index: 2 });
  });
});

describe('findNewReplyBox / replyBoundary', () => {
  test('ô mới duy nhất nằm sau bình luận được trả lời', () => {
    expect(findNewReplyBox(snapshotOf('open'), 2)).toEqual({ index: 3 });
  });
  test('ô đã có từ trước khi bấm thì không tính', () => {
    const items = snapshotOf('open').map((i) => (i.kind === 'box' ? { ...i, seen: true } : i));
    expect(findNewReplyBox(items, 2)).toEqual({ error: 'none' });
  });
  test('ô nằm trước bình luận được trả lời thì không tính', () => {
    expect(findNewReplyBox(snapshotOf('open'), 4)).toEqual({ error: 'none' });
  });
  test('boxAfterNextComment: ô mới nằm sau bình luận kế tiếp thì không nhận', () => {
    expect(findNewReplyBox(boxAfterNextComment(), 2)).toEqual({ error: 'none' });
  });
  test('câu trả lời đã có trong chuỗi không phải là mốc; ô sau nó vẫn nhận', () => {
    const items = snapshotOf('posted'); // reply (isReply) nằm giữa bình luận và ô
    expect(findNewReplyBox(items, 2)).toEqual({ index: 4 });
  });
  test('bình luận cuối: không có ranh giới nên không nhận ô nào (kể cả ô cấp bài nạp muộn)', () => {
    const last = [...snapshotOf('closed'), { kind: 'box', label: 'x', text: '', commentIds: [], isReply: false, inArticle: false, seen: false } as ReplySnapshotItem];
    expect(findNewReplyBox(last, 4)).toEqual({ error: 'none' });
    expect(replyBoundary(last, 4)).toBeNull();
  });
  test('hai ô mới thì không đoán', () => {
    const items = snapshotOf('open');
    items.splice(4, 0, { ...items[3] }); // cả hai trong chuỗi của bình luận 9102
    expect(findNewReplyBox(items, 2)).toEqual({ error: 'many' });
  });
  test('mốc là bình luận (không phải câu trả lời) kế tiếp sau bình luận được trả lời; không có thì tới cuối', () => {
    expect(replyBoundary(snapshotOf('open'), 2)).toEqual(['9103']);
    expect(replyBoundary(snapshotOf('posted'), 2)).toEqual(['9103']);
    expect(replyBoundary(snapshotOf('open').slice(0, 4), 2)).toBeNull();
  });
});

describe('confirmReply (đọc lại)', () => {
  const boundary = ['9103'];
  test('câu trả lời mới nằm giữa bình luận được trả lời và bình luận kế tiếp', () => {
    expect(threadMatchCount(snapshotOf('open'), BY_ID, boundary, REPLY)).toBe(0);
    expect(confirmReply(snapshotOf('posted'), BY_ID, boundary, REPLY, 0)).toMatchObject({ ok: true });
    expect(confirmReply(snapshotOf('posted'), BY_AUTHOR, boundary, REPLY, 0)).toMatchObject({ ok: true });
  });
  test('ô nhập biến mất sau khi gửi vẫn xác nhận được', () => {
    const items = snapshotOf('posted').filter((i) => i.kind !== 'box');
    expect(confirmReply(items, BY_ID, boundary, REPLY, 0)).toMatchObject({ ok: true });
  });
  test('chưa thấy câu trả lời thì không xác nhận', () => {
    expect(confirmReply(snapshotOf('open'), BY_ID, boundary, REPLY, 0)).toMatchObject({ ok: false });
  });
  test('câu trả lời nằm dưới bình luận khác thì không xác nhận', () => {
    const items = snapshotOf('posted');
    const [reply] = items.splice(3, 1);
    items.push(reply); // sau bình luận kế tiếp
    expect(confirmReply(items, BY_ID, boundary, REPLY, 0)).toMatchObject({ ok: false });
  });
  test('mất bình luận làm mốc thì không xác nhận (không mở rộng tới cuối trang)', () => {
    const items = snapshotOf('posted').filter((i) => !i.commentIds.includes('9103'));
    expect(confirmReply(items, BY_ID, boundary, REPLY, 0)).toMatchObject({ ok: false });
  });
  test('số khớp không tăng so với trước khi gửi thì không xác nhận', () => {
    expect(confirmReply(snapshotOf('posted'), BY_ID, boundary, REPLY, 1)).toMatchObject({ ok: false });
  });
});

function fakeArticle(label: string, ids: string[], marks: Record<string, string>, tag: string) {
  const article: any = { getAttribute: (k: string) => (k === 'aria-label' ? label : k === 'role' ? 'article' : null) };
  const mkButton = (name: string, text: string, owner: unknown) => ({
    innerText: text, getAttribute: () => null, closest: () => owner, getBoundingClientRect: () => ({ width: 10, height: 10 }),
    setAttribute: (k: string, v: string) => { marks[`${tag}:${name}`] = `${k}=${v}`; },
  });
  const links = ids.map((id) => ({ getAttribute: () => `/x?comment_id=${id}`, closest: () => article }));
  const buttons = [mkButton('like', 'Thích', article), mkButton('child', 'Trả lời', {}), mkButton('own', 'Trả lời', article)];
  article.querySelectorAll = (sel: string) => (sel.includes('comment_id') ? links : buttons);
  return article;
}

function withArticles<T>(articles: unknown[], fn: () => T): T {
  const g = global as unknown as { document: unknown };
  const old = g.document;
  g.document = { querySelectorAll: (sel: string) => (sel === '[data-maihub-target]' ? [] : articles) };
  try { return fn(); } finally { g.document = old; }
}

test('markReplyButtonInPage: chỉ đánh dấu nút "Trả lời" của chính khối, và khối phải đúng nhãn', () => {
  const marks: Record<string, string> = {};
  const a = fakeArticle('Bình luận dưới tên A', ['9101'], marks, 'a');
  withArticles([a], () => {
    expect(markReplyButtonInPage({ index: 0, label: 'Bình luận dưới tên B', commentIds: ['9101'], labels: ['Trả lời'] })).toBe(false);
    expect(marks).toEqual({});
    expect(markReplyButtonInPage({ index: 0, label: 'Bình luận dưới tên A', commentIds: ['9101'], labels: ['Trả lời'] })).toBe('ids');
  });
  expect(marks).toEqual({ 'a:own': 'data-maihub-target=reply-open' });
});

test('twinMarkUsesCommentId: khối cùng nhãn nhưng khác id (chỉ số lệch một) thì không đánh dấu', () => {
  const marks: Record<string, string> = {};
  const label = 'Bình luận dưới tên Khách Thử Ba 1 ngày trước';
  const twins = [fakeArticle(label, ['Y29tbWVudDo5MDAwMF85MTAz', '9103'], marks, 'c3'), fakeArticle(label, ['Y29tbWVudDo5MDAwMF85MTA0', '9104'], marks, 'c4')];
  withArticles(twins, () => {
    // Snapshot chọn bình luận 9104 nhưng chỉ số trỏ lệch sang khối song sinh 9103 (cùng nhãn).
    expect(markReplyButtonInPage({ index: 0, label, commentIds: ['Y29tbWVudDo5MDAwMF85MTA0', '9104'], labels: ['Trả lời'] })).toBe(false);
    expect(marks).toEqual({});
    expect(markReplyButtonInPage({ index: 1, label, commentIds: ['Y29tbWVudDo5MDAwMF85MTA0', '9104'], labels: ['Trả lời'] })).toBe('ids');
  });
  expect(marks).toEqual({ 'c4:own': 'data-maihub-target=reply-open' });
});

test('markReplyButtonInPage: khối không có id thì chỉ kiểm nhãn và báo rõ là chưa kiểm id', () => {
  const marks: Record<string, string> = {};
  withArticles([fakeArticle('Bình luận dưới tên A', [], marks, 'a')], () => {
    expect(markReplyButtonInPage({ index: 0, label: 'Bình luận dưới tên A', commentIds: [], labels: ['Trả lời'] })).toBe('label');
  });
  const twin: Record<string, string> = {};
  withArticles([fakeArticle('Bình luận dưới tên A', ['9101'], twin, 'a')], () => {
    expect(markReplyButtonInPage({ index: 0, label: 'Bình luận dưới tên A', commentIds: ['9102'], labels: ['Trả lời'] })).toBe(false);
  });
  expect(twin).toEqual({});
});

/** Danh sách phần tử giả theo thứ tự trang cho các hàm đánh dấu ô nhập. */
function fakeList(spec: ({ article: string[] } | { box: 'fresh' | 'seen' | 'nested' })[]) {
  const attrs: Record<number, Record<string, string>> = {};
  const nodes = spec.map((x, i) => {
    attrs[i] = {};
    if ('article' in x) {
      const el: any = { getAttribute: (k: string) => (k === 'role' ? 'article' : k === 'aria-label' ? 'Bình luận dưới tên X' : null) };
      const links = x.article.map((id) => ({ getAttribute: () => `/x?comment_id=${id}`, closest: () => el }));
      el.querySelectorAll = (sel: string) => (sel.includes('comment_id') ? links : []);
      return el;
    }
    return {
      getAttribute: (k: string) => (k === 'role' ? 'textbox' : null),
      hasAttribute: (k: string) => k === 'data-seen' && x.box === 'seen',
      parentElement: { closest: () => (x.box === 'nested' ? {} : null) },
      setAttribute: (k: string, v: string) => { attrs[i][k] = v; },
      scrollIntoView: () => {},
    };
  });
  return { nodes, attrs };
}

describe('markReplyBoxInPage: chỉ đánh dấu ô nằm giữa bình luận được trả lời và bình luận kế tiếp', () => {
  // [post?] 0: 9102 (đích) · 1: ô trong chuỗi · 2: 9103 (mốc) · 3: ô ngoài chuỗi · 4: 9104
  const spec = [{ article: ['9102'] }, { box: 'fresh' }, { article: ['9103'] }, { box: 'fresh' }, { article: ['9104'] }] as const;
  const call = (index: number, list = fakeList(spec as any)) => {
    const g = global as unknown as { document: unknown };
    const old = g.document;
    g.document = { querySelectorAll: () => list.nodes };
    try { return { ok: markReplyBoxInPage({ index, mark: 'data-mark', seenMark: 'data-seen', targetIds: ['9102'], headIds: ['9103'] }), attrs: list.attrs }; } finally { g.document = old; }
  };
  test('chỉ số đúng thì đánh dấu', () => {
    const r = call(1);
    expect(r.ok).toBe(true);
    expect(r.attrs[1]).toEqual({ 'data-mark': '1' });
  });
  test('chỉ số lệch sang ô ngoài chuỗi thì không đánh dấu', () => {
    const r = call(3);
    expect(r.ok).toBe(false);
    expect(r.attrs[3]).toEqual({});
  });
  test('ô nằm trong một khối bình luận thì không đánh dấu', () => {
    const r = call(1, fakeList([{ article: ['9102'] }, { box: 'nested' }, { article: ['9103'] }]));
    expect(r.ok).toBe(false);
  });
});

test('boxInsideArticleIsRejected', () => {
  const items = snapshotOf('open').map((i) => (i.kind === 'box' ? { ...i, inArticle: true } : i));
  expect(findNewReplyBox(items, 2)).toEqual({ error: 'none' });
});

test('typedTextInsideArticleDoesNotCountAsPosted', () => {
  // Một khối trong chuỗi có ô nhập con đang chứa câu đã gõ mà chưa gửi: chữ của ô không được tính vào chữ của khối.
  const editable = { innerText: REPLY };
  const article: any = {
    innerText: `Khách Thử Hai\n${REPLY}\nThích`,
    getAttribute: (k: string) => (k === 'role' ? 'article' : k === 'aria-label' ? 'Bình luận dưới tên Trang Mẫu Vừa xong' : null),
    querySelectorAll: (sel: string) => (sel.includes('contenteditable') ? [editable] : []),
  };
  const g = global as unknown as { document: unknown };
  const old = g.document;
  g.document = { querySelectorAll: () => [article] };
  let snap: ReplySnapshotItem[];
  try { snap = readReplySnapshotInPage('data-seen'); } finally { g.document = old; }
  expect(snap[0].text).not.toContain(REPLY);
  const open = snapshotOf('open');
  open.splice(3, 0, snap[0]); // khối đó nằm giữa đích và mốc
  expect(confirmReply(open, BY_ID, ['9103'], REPLY, 0)).toMatchObject({ ok: false });
});

// ---------------------------------------------------------------------------
// Trình tự bấm / gõ / gửi / đọc lại trên trang giả (snapshot lấy từ fixture theo trạng thái).
// ---------------------------------------------------------------------------
const POST_URL = 'https://www.facebook.com/trang.mau/posts/90000/';

function fakeReplyPage(o: {
  url?: string; afterReply?: State | ReplySnapshotItem[]; afterSend?: State; closed?: ReplySnapshotItem[]; landsOnRead?: number;
  typed?: boolean; sendButton?: boolean; sendRejects?: boolean; onMarkSend?: () => void; markBox?: boolean;
} = {}) {
  const calls: string[] = [];
  const args: Record<string, unknown[]> = {};
  let stage: State | ReplySnapshotItem[] = 'closed';
  let readsAfterSend = -1; // -1 = not sent yet
  const snapshot = () => {
    if (readsAfterSend >= 0) {
      readsAfterSend += 1;
      args.readsAfterSend = [readsAfterSend];
      if (o.landsOnRead && readsAfterSend < o.landsOnRead) return snapshotOf('open');
    }
    if (Array.isArray(stage)) return stage;
    return stage === 'closed' && o.closed ? o.closed : snapshotOf(stage);
  };
  const byName: Record<string, (arg: unknown) => unknown> = {
    readReplySnapshotInPage: () => snapshot(),
    clickLabelInPage: () => false,
    markSeenBoxesInPage: () => 0,
    markReplyButtonInPage: () => true,
    markReplyBoxInPage: () => o.markBox ?? true,
    freePointOnBoxInPage: () => null,
    commentTypedInPage: () => o.typed ?? true,
    markCommentSendButtonInPage: () => { o.onMarkSend?.(); return o.sendButton ?? true; },
  };
  const page = {
    goto: async () => { calls.push('goto'); },
    url: () => o.url ?? POST_URL,
    evaluate: async (fn: { name: string }, arg: unknown) => { (args[fn.name] ??= []).push(arg); return byName[fn.name] ? byName[fn.name](arg) : undefined; },
    mouse: { click: async () => { calls.push('mouse'); } },
    locator: (sel: string) => {
      const target = /data-maihub-target="([^"]+)"/.exec(sel)?.[1];
      const click = async () => {
        calls.push(`click:${target}`);
        if (target === 'reply-open') stage = o.afterReply ?? 'open';
        if (target === 'comment-send') { if (o.sendRejects) throw new Error('ack lost'); stage = o.afterSend ?? 'posted'; readsAfterSend = 0; }
      };
      return { first: () => ({ click }), click, focus: async () => { calls.push('focus'); } };
    },
    keyboard: { type: async (t: string) => { calls.push(`type:${t}`); }, press: async (k: string) => { calls.push(`press:${k}`); } },
  } as unknown as Page;
  return { page, calls, args };
}

const run = (page: Page, target: ReplyTarget, text = REPLY, deps = {}) =>
  runWithFakeTimers(() => postCommentReply(page, { postUrl: POST_URL, target, text }, deps));

describe('postCommentReply', () => {
  test.each([['commentId', BY_ID], ['author + excerpt', BY_AUTHOR]] as [string, ReplyTarget][])('replyFindsUniqueTargetAndVerifies (%s)', async (_l, target) => {
    const f = fakeReplyPage();
    const out = await run(f.page, target, `${REPLY}\nCảm ơn anh`);
    expect(out).toMatchObject({ status: 'posted', sent: true });
    expect(f.calls.filter((c) => c.startsWith('click:'))).toEqual(['click:reply-open', 'click:comment-send']);
    expect(f.calls.filter((c) => /^(type|press):/.test(c))).toEqual([`type:${REPLY}`, 'press:Shift+Enter', 'type:Cảm ơn anh']);
    expect(f.args.markReplyButtonInPage[0]).toMatchObject({ index: 2, label: 'Bình luận dưới tên Khách Thử Hai 2 ngày trước', commentIds: ['Y29tbWVudDo5MDAwMF85MTAy', '9102'] });
    expect(f.args.markReplyBoxInPage[0]).toMatchObject({ index: 3, targetIds: ['Y29tbWVudDo5MDAwMF85MTAy', '9102'], headIds: ['Y29tbWVudDo5MDAwMF85MTAz', '9103'] });
    expect(f.calls).not.toContain('press:Enter');
  });

  test.each([
    ['ambiguous', { author: 'Khách Thử Ba', excerpt: 'Còn hàng không shop' }],
    ['missing', { commentId: '9999' }],
    ['no criteria', { author: 'Khách Thử Hai' }],
  ] as [string, ReplyTarget][])('ambiguousOrMissingTargetSkipsBeforeTyping (%s)', async (label, target) => {
    const f = fakeReplyPage();
    const out = await run(f.page, target);
    expect(out.status).toBe('target_not_found');
    expect(out.sent).toBeFalsy();
    expect(f.calls.filter((c) => /^(click|type|press|mouse|focus)/.test(c))).toEqual([]);
    if (label === 'no criteria') expect(f.calls).not.toContain('goto');
  });

  test('redirected away from the post is post_not_found, nothing clicked', async () => {
    const f = fakeReplyPage({ url: 'https://www.facebook.com/' });
    expect((await run(f.page, BY_ID)).status).toBe('post_not_found');
    expect(f.calls.filter((c) => c.startsWith('click:'))).toEqual([]);
  });

  test('no comment block at all is post_not_found', async () => {
    const f = fakeReplyPage({ closed: snapshotOf('closed').slice(0, 1) });
    expect((await run(f.page, BY_ID)).status).toBe('post_not_found');
  });

  test('no single new composer after "Trả lời": failed, nothing typed', async () => {
    const f = fakeReplyPage({ afterReply: 'closed' });
    const out = await run(f.page, BY_ID);
    expect(out).toMatchObject({ status: 'failed' });
    expect(out.sent).toBeFalsy();
    expect(f.calls.some((c) => c.startsWith('type:'))).toBe(false);
  });

  test('boxAfterNextCommentIsRejectedNotSent', async () => {
    const f = fakeReplyPage({ afterReply: boxAfterNextComment() });
    const out = await run(f.page, BY_ID);
    expect(out.status).toBe('failed');
    expect(out.sent).toBeFalsy();
    expect(f.calls.some((c) => /^(type|press):/.test(c))).toBe(false);
    expect(f.calls).not.toContain('click:comment-send');
  });

  test('read-back polls: reply visible only on the 3rd read still counts as posted', async () => {
    const f = fakeReplyPage({ landsOnRead: 3 });
    expect(await run(f.page, BY_ID)).toMatchObject({ status: 'posted', sent: true });
    expect(f.args.readsAfterSend).toEqual([3]);
  });

  test('read-back gives up after 3 reads', async () => {
    const f = fakeReplyPage({ afterSend: 'open' });
    expect(await run(f.page, BY_ID)).toMatchObject({ status: 'failed', sent: true });
    expect(f.args.readsAfterSend).toEqual([3]);
  });

  test('lastTopLevelTargetIsNotSent', async () => {
    const f = fakeReplyPage();
    const out = await run(f.page, { commentId: '9104' }); // bình luận cuối danh sách
    expect(out.status).toBe('failed');
    expect(out).not.toHaveProperty('sent');
    expect(out.reason).toBe('Bình luận cuối danh sách, không xác định được ranh giới để trả lời an toàn');
    expect(f.calls.filter((c) => /^(click|type|press|mouse|focus)/.test(c))).toEqual([]);
  });

  test('box mark refused in the page (index shifted out of the thread): failed, nothing typed', async () => {
    const f = fakeReplyPage({ markBox: false });
    const out = await run(f.page, BY_ID);
    expect(out.status).toBe('failed');
    expect(out.sent).toBeFalsy();
    expect(f.calls.some((c) => /^(type|press|mouse|focus)/.test(c))).toBe(false);
  });

  test('text not in the box: failed, not sent', async () => {
    const f = fakeReplyPage({ typed: false });
    const out = await run(f.page, BY_ID);
    expect(out.status).toBe('failed');
    expect(out.sent).toBeFalsy();
    expect(f.calls).not.toContain('click:comment-send');
  });

  test('no send button next to the box: failed, not sent, no Enter', async () => {
    const f = fakeReplyPage({ sendButton: false });
    const out = await run(f.page, BY_ID);
    expect(out.sent).toBeFalsy();
    expect(f.calls).not.toContain('press:Enter');
  });

  test('stopping right before the send click: failed, not sent', async () => {
    let stopping = false;
    const f = fakeReplyPage({ onMarkSend: () => { stopping = true; } });
    const out = await run(f.page, BY_ID, REPLY, { getIsStopping: () => stopping });
    expect(out.status).toBe('failed');
    expect(out.sent).toBeFalsy();
    expect(f.calls).not.toContain('click:comment-send');
  });

  test('rejected send click is sent:true and never retried with Enter', async () => {
    const f = fakeReplyPage({ sendRejects: true });
    const out = await run(f.page, BY_ID);
    expect(out).toMatchObject({ status: 'failed', sent: true });
    expect(f.calls.filter((c) => c === 'click:comment-send')).toHaveLength(1);
    expect(f.calls).not.toContain('press:Enter');
  });

  test('reply not seen under the target after sending: failed with sent:true', async () => {
    const f = fakeReplyPage({ afterSend: 'open' });
    expect(await run(f.page, BY_ID)).toMatchObject({ status: 'failed', sent: true });
  });

  test('navigation error before anything: failed, not sent, does not throw', async () => {
    const f = fakeReplyPage();
    (f.page as any).goto = async () => { throw new Error('net down'); };
    const out = await run(f.page, BY_ID);
    expect(out.status).toBe('failed');
    expect(out.sent).toBeFalsy();
  });
});
