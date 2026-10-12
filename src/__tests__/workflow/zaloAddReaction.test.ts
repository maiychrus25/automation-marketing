import { Reactions } from 'zca-js';
import { buildZaloReactionCall } from '../../services/workflow/zaloReaction';

describe('buildZaloReactionCall', () => {
    const trigger = { msgId: 'm1', cliMsgId: 'c1', threadId: 'g1', threadType: 1 };

    it('legacy numeric reaction still works', () => {
        expect(buildZaloReactionCall({ reactionType: '1' }, trigger)).toEqual({
            reaction: Reactions.LIKE,
            dest: { data: { msgId: 'm1', cliMsgId: 'c1' }, threadId: 'g1', type: 1 },
        });
    });

    it('falls back to cli_msg_id and thread info of the stored message', () => {
        const call = buildZaloReactionCall(
            { reactionType: 'HEART' },
            { msgId: 'm1' },
            { thread_id: 'u9', thread_type: 0, cli_msg_id: 'stored-c' },
        );
        expect(call.dest).toEqual({ data: { msgId: 'm1', cliMsgId: 'stored-c' }, threadId: 'u9', type: 0 });
    });

    it('cfg overrides trigger', () => {
        const call = buildZaloReactionCall(
            { msgId: 'x', clientMsgId: 'y', threadId: 't', threadType: 0 }, trigger);
        expect(call.dest).toEqual({ data: { msgId: 'x', cliMsgId: 'y' }, threadId: 't', type: 0 });
    });

    it('throws when the thread id is missing everywhere', () => {
        expect(() => buildZaloReactionCall({}, { msgId: 'm1' }))
            .toThrow('[zalo.addReaction] Thiếu ID hội thoại');
    });

    it('throws when the message id is missing', () => {
        expect(() => buildZaloReactionCall({}, { threadId: 't' }))
            .toThrow('[zalo.addReaction] Thiếu ID tin nhắn');
    });

    it('throws on an invalid reaction', () => {
        expect(() => buildZaloReactionCall({ reactionType: 'xyz' }, trigger))
            .toThrow('[zalo.addReaction] Reaction không hợp lệ');
    });
});
