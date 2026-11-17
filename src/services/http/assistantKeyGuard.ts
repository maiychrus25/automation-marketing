/**
 * An employee may save an AI assistant, but must not be able to point the boss's stored key at a host of their choosing:
 * saving with the masked key keeps the stored key, and a later test/chat call would send it to the new base URL.
 * Pure rule (no Electron, no DB): the relay loads the stored assistant and calls it.
 */
export const MASKED_API_KEY = '***';

export interface StoredAssistantHost { platform?: string | null; baseUrl?: string | null }

export type AssistantHostCheck = { ok: true } | { ok: false; code: 'KEY_REQUIRED'; error: string };

const normalizeUrl = (value: unknown): string => (typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '');

export function checkAssistantHostChange(submitted: any, stored: StoredAssistantHost | null | undefined): AssistantHostCheck {
    if (!stored || submitted?.apiKey !== MASKED_API_KEY) return { ok: true }; // a new real key, or nothing stored to keep
    const sameHost = (submitted.platform ?? '') === (stored.platform ?? '') && normalizeUrl(submitted.baseUrl) === normalizeUrl(stored.baseUrl);
    return sameHost ? { ok: true } : { ok: false, code: 'KEY_REQUIRED', error: 'Đổi địa chỉ máy chủ AI thì phải nhập lại khoá API' };
}
