// Phần dùng chung để đọc bảng tin nhóm: Nghiên cứu (quét nhóm) và Theo dõi bài đều gọi vào đây.
import type { ResearchErrorCode } from '../../models/research';
import {
    ResearchError, buildGroupFeedVariables, type CapturedQuery, type GraphqlSession,
} from './graphqlSession';
import type { ParseResult } from './parsers';

export const GROUP_FEED_QUERY_NAME = 'GroupsCometFeedRegularStoriesPaginationQuery';
const PROFILE_ERRORS: ResearchErrorCode[] = ['logged_out', 'checkpoint', 'rate_limited'];

/** Phần của GraphqlSession mà việc đọc bảng tin nhóm dùng (để test thay bằng bản giả). */
export type GroupFeedSession = Pick<GraphqlSession, 'ensureQuery' | 'call' | 'recapture'>;

/** Mã hoặc tên rút gọn của nhóm trong link; rỗng nếu không phải link nhóm. */
export function groupKey(url: string): string {
    const m = /\/groups\/([^/?#\s]+)/.exec(url);
    return m ? decodeURIComponent(m[1]) : '';
}

export const groupFeedTriggerUrl = (key: string): string =>
    `https://www.facebook.com/groups/${key}/?sorting_setting=CHRONOLOGICAL`;

export interface PreparedGroupFeed {
    unresolved: false;
    query: CapturedQuery;
    groupId: string;
    buildVars(query: CapturedQuery, cursor: string | null): Record<string, any>;
    recapture(): Promise<CapturedQuery>;
}

/**
 * `no_query`: không bắt được truy vấn bảng tin của nhóm; `no_id`: link rút gọn mà truy vấn không có id số.
 * Hai trường hợp khác nhau vì Nghiên cứu đếm chúng khác nhau.
 */
export interface UnresolvedGroupFeed { unresolved: true; reason: 'no_query' | 'no_id' }

/** Type guard (tsconfig không bật strict nên không tự thu hẹp theo `unresolved`). */
export const isUnresolved = (p: PreparedGroupFeed | UnresolvedGroupFeed): p is UnresolvedGroupFeed => p.unresolved === true;

/**
 * Lấy truy vấn bảng tin của một nhóm. Link rút gọn bắt truy vấn mới từ chính trang nhóm (cần id thật);
 * link có mã số dùng mẫu đã lưu và chỉ đổi id. Lỗi khác `query_changed` được ném tiếp.
 */
export async function prepareGroupFeed(
    gql: Pick<GraphqlSession, 'ensureQuery' | 'recapture'>, url: string, count: number,
): Promise<PreparedGroupFeed | UnresolvedGroupFeed> {
    const key = groupKey(url);
    const numeric = /^\d+$/.test(key);
    const triggerUrl = groupFeedTriggerUrl(key);
    let query: CapturedQuery;
    try {
        query = await gql.ensureQuery('group_feed', GROUP_FEED_QUERY_NAME, triggerUrl, !numeric);
    } catch (e) {
        if (e instanceof ResearchError && e.code === 'query_changed') return { unresolved: true, reason: 'no_query' };
        throw e;
    }
    // Link rút gọn: id thật nằm trong truy vấn bắt từ chính trang nhóm; không có id số thì không đọc được.
    const idKey = ['id', 'groupID'].find((k) => k in query.variables);
    const groupId = numeric ? key : String(idKey ? query.variables[idKey] : '');
    if (!/^\d+$/.test(groupId)) return { unresolved: true, reason: 'no_id' };
    return {
        unresolved: false,
        query,
        groupId,
        buildVars: (q, cursor) => {
            const vars = buildGroupFeedVariables(q.variables, { cursor, count });
            // Mẫu có thể bắt từ một nhóm khác: chỉ đổi id khi link có mã số.
            if (numeric) for (const k of ['id', 'groupID']) if (k in vars) vars[k] = key;
            return vars;
        },
        recapture: () => gql.recapture('group_feed', GROUP_FEED_QUERY_NAME, triggerUrl),
    };
}

/** Gọi một trang; doc_id hỏng thì bắt lại đúng một lần rồi gọi lại. */
export async function fetchGraphqlPage(
    gql: Pick<GraphqlSession, 'call'>, state: { query: CapturedQuery; recapture(): Promise<CapturedQuery> },
    buildVars: (query: CapturedQuery, cursor: string | null) => Record<string, any>,
    parse: (text: string) => ParseResult, cursor: string | null,
): Promise<{ res: ParseResult; text: string }> {
    let text = await gql.call(state.query, buildVars(state.query, cursor));
    let res = parse(text);
    if (res.errorCode === 'query_changed') {
        state.query = await state.recapture();
        text = await gql.call(state.query, buildVars(state.query, cursor));
        res = parse(text);
        if (res.errorCode === 'query_changed') throw new ResearchError('query_changed', 'Truy vấn vẫn hỏng sau khi bắt lại.');
    }
    if (res.errorCode && PROFILE_ERRORS.includes(res.errorCode)) {
        throw new ResearchError(res.errorCode, `Facebook báo ${res.errorCode}.`);
    }
    return { res, text };
}
