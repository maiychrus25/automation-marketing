/**
 * Some Zalo clients surface an undo control payload on the ordinary
 * `message`/`old_messages` stream as well as the dedicated `undo` stream.
 * It is metadata, never a chat message, and must not be persisted as a
 * JSON text bubble. Pure function: no electron or DB imports.
 */
export function getUndoControlPayload(message: any): { msgId: string; threadId: string } | null {
    const data = message?.data || message || {};
    const candidates = [data?.content, message?.content, data];

    for (const rawCandidate of candidates) {
        let payload = rawCandidate;
        if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch { continue; }
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;

        const msgId = payload.globalMsgId || payload.cliMsgId || '';
        const hasUndoSignature = !!msgId && (
            Object.prototype.hasOwnProperty.call(payload, 'deleteMsg') ||
            Object.prototype.hasOwnProperty.call(payload, 'srcId') ||
            Object.prototype.hasOwnProperty.call(payload, 'destId')
        );
        if (!hasUndoSignature) continue;

        // `srcId` can be an internal sender object, not a conversation ID.
        // Prefer the listener-normalized threadId and only use explicit
        // thread fields as fallbacks.
        return {
            msgId: String(msgId),
            threadId: String(message?.threadId || data?.threadId || data?.idTo || ''),
        };
    }
    return null;
}
