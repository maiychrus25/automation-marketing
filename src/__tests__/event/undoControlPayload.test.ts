import { getUndoControlPayload } from '../../services/event/undoControlPayload';

describe('getUndoControlPayload', () => {
    it('detects an object content with deleteMsg', () => {
        expect(getUndoControlPayload({ threadId: 't1', data: { content: { globalMsgId: 'g1', deleteMsg: 1 } } }))
            .toEqual({ msgId: 'g1', threadId: 't1' });
    });

    it('detects JSON string content and falls back to data.idTo', () => {
        expect(getUndoControlPayload({ data: { idTo: 't2', content: '{"cliMsgId":"c9","srcId":"x"}' } }))
            .toEqual({ msgId: 'c9', threadId: 't2' });
    });

    it('ignores a JSON chat message', () => {
        expect(getUndoControlPayload({ threadId: 't1', data: { content: '{"deleteMsg":true,"text":"hi"}' } })).toBeNull();
    });

    it('requires an undo signature', () => {
        expect(getUndoControlPayload({ threadId: 't1', data: { content: { globalMsgId: 'g1' } } })).toBeNull();
    });

    it('returns null for arrays, null and non-JSON strings', () => {
        expect(getUndoControlPayload({ data: { content: [{ globalMsgId: 'g1', deleteMsg: 1 }] } })).toBeNull();
        expect(getUndoControlPayload(null)).toBeNull();
        expect(getUndoControlPayload({ data: { content: 'hello' } })).toBeNull();
    });

    it('reads message.content as a candidate', () => {
        expect(getUndoControlPayload({ threadId: 't3', content: { cliMsgId: 'c1', deleteMsg: 1 } }))
            .toEqual({ msgId: 'c1', threadId: 't3' });
    });

    it('accepts destId alone as the signature', () => {
        expect(getUndoControlPayload({ threadId: 't1', data: { content: { globalMsgId: 'g2', destId: 'd' } } }))
            .toEqual({ msgId: 'g2', threadId: 't1' });
    });

    it('falls back to data.threadId', () => {
        expect(getUndoControlPayload({ data: { threadId: 't4', content: { globalMsgId: 'g3', deleteMsg: 1 } } }))
            .toEqual({ msgId: 'g3', threadId: 't4' });
    });
});
