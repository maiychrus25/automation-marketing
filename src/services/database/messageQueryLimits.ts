// Bounds for db:getMessages. The cap is 5000 (not 200 like upstream) because the
// Telegram download flow in ChatHeader reloads `limit + 20` messages after a download of up to 5,000.
export const MAX_MESSAGES_PER_REQUEST = 5000;
export const DEFAULT_MESSAGES_PER_REQUEST = 50;

function toFiniteInt(value: unknown): number | null {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? n : null;
}

export function clampMessagesQuery(input: { limit?: unknown; offset?: unknown; before?: unknown }): { limit: number; offset: number; before: number } {
    const limit = toFiniteInt(input.limit);
    const offset = toFiniteInt(input.offset);
    const before = toFiniteInt(input.before);
    return {
        limit: limit === null || limit <= 0 ? DEFAULT_MESSAGES_PER_REQUEST : Math.min(limit, MAX_MESSAGES_PER_REQUEST),
        offset: offset === null || offset < 0 ? 0 : offset,
        before: before === null || before < 0 ? 0 : before,
    };
}
