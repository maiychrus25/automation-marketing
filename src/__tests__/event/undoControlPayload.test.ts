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
});
