import { Reactions } from 'zca-js';

// Workflow cũ lưu 6 lựa chọn cảm xúc dưới dạng số '1'-'6'. Giữ chúng chạy được
// bằng cách quy về giá trị icon mà zca-js/Zalo thực sự nhận.
const ZALO_WORKFLOW_REACTIONS: Record<string, string> = {
    '1': Reactions.LIKE,
    '2': Reactions.HEART,
    '3': Reactions.HAHA,
    '4': Reactions.WOW,
    '5': Reactions.CRY,
    '6': Reactions.ANGRY,
    LIKE: Reactions.LIKE,
    HEART: Reactions.HEART,
    HAHA: Reactions.HAHA,
    WOW: Reactions.WOW,
    CRY: Reactions.CRY,
    ANGRY: Reactions.ANGRY,
};

export function resolveZaloWorkflowReaction(value: unknown): string | null {
    const reaction = String(value ?? '').trim();
    if (!reaction) return null;
    return ZALO_WORKFLOW_REACTIONS[reaction.toUpperCase()]
        || ((Object.values(Reactions) as string[]).includes(reaction) ? reaction : null);
}

export interface ZaloReactionCall {
    reaction: string;
    dest: { data: { msgId: string; cliMsgId: string }; threadId: string; type: 0 | 1 };
}

const hasValue = (v: unknown) => v !== undefined && v !== null && v !== '';

/** Dựng tham số cho api.addReaction(icon, dest) của zca-js. */
export function buildZaloReactionCall(cfg: any, trigger: any, storedMessage?: any): ZaloReactionCall {
    const reaction = resolveZaloWorkflowReaction(cfg?.reactionType ?? 'LIKE');
    if (!reaction) throw new Error('[zalo.addReaction] Reaction không hợp lệ');

    const msgId = String(cfg?.msgId || trigger?.msgId || '').trim();
    const threadId = String(cfg?.threadId || trigger?.threadId || storedMessage?.thread_id || '').trim();
    const rawType = hasValue(cfg?.threadType) ? cfg.threadType
        : hasValue(trigger?.threadType) ? trigger.threadType
        : storedMessage?.thread_type ?? 0;
    const type: 0 | 1 = Number(rawType) === 1 ? 1 : 0;
    const cliMsgId = String(cfg?.clientMsgId || trigger?.cliMsgId || storedMessage?.cli_msg_id || msgId).trim();

    if (!msgId) throw new Error('[zalo.addReaction] Thiếu ID tin nhắn');
    if (!threadId) throw new Error('[zalo.addReaction] Thiếu ID hội thoại');
    if (!cliMsgId) throw new Error('[zalo.addReaction] Thiếu Client Message ID của tin nhắn');

    return { reaction, dest: { data: { msgId, cliMsgId }, threadId, type } };
}
