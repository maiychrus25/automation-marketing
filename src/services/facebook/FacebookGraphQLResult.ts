/**
 * Facebook hay tra HTTP 200 kem noi dung loi: {error}, {errors:[...]}, {data:null}.
 * Phan hoi khong phan tich duoc (HTML, rong) la "khong ro" -> khong coi la that bai.
 */

import Logger from '../../utils/Logger';

export class FacebookOperationError extends Error {
  public operation: string;
  public code: 'api_error' | 'graphql_errors' | 'null_data';

  constructor(operation: string, code: FacebookOperationError['code'], message: string) {
    super(message);
    this.name = 'FacebookOperationError';
    this.operation = operation;
    this.code = code;
  }
}

function tryParse(text: string): any | null {
  try { return JSON.parse(text); } catch { return null; }
}

/** Bo tien to `for (;;);`; neu ca khoi khong phai 1 JSON thi thu dong khong rong dau tien. */
export function parseFacebookResponse(body: unknown): any | null {
  if (body && typeof body === 'object') return body;
  if (typeof body !== 'string') return null;
  const cleaned = body.replace(/^\s*for\s*\(;;\);/, '').trim();
  if (!cleaned) return null;
  const whole = tryParse(cleaned);
  if (whole !== null) return whole;
  const firstLine = cleaned.split(/\r?\n/).map(l => l.trim()).find(Boolean);
  return firstLine ? tryParse(firstLine) : null;
}

const snippet = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v) ?? '').slice(0, 200);

export function assertFacebookMutationSuccess(operation: string, body: unknown): void {
  const payload = parseFacebookResponse(body);
  if (!payload || typeof payload !== 'object') return;

  // Loi di kem data dung duoc = thanh cong mot phan: chi canh bao, tranh bao that bai lam anh thu lai (tao trung).
  const usable = payload.data && typeof payload.data === 'object'
    && Object.values(payload.data).some(v => v !== null && v !== undefined);

  if (payload.error) {
    const msg = payload.errorSummary || payload.errorDescription
      || payload.error.message || payload.error.description || snippet(payload.error);
    if (usable) { Logger.warn(`[FBGraphQL] ${operation} warning: ${String(msg).slice(0, 200)}`); return; }
    throw new FacebookOperationError(operation, 'api_error', `${operation}: ${msg}`);
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    const msg = first?.message || snippet(first);
    if (usable) { Logger.warn(`[FBGraphQL] ${operation} warning: ${String(msg).slice(0, 200)}`); return; }
    throw new FacebookOperationError(operation, 'graphql_errors', `${operation}: ${msg}`);
  }
  if (payload.data === null) {
    throw new FacebookOperationError(operation, 'null_data', `${operation}: data is null`);
  }
}
