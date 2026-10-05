/**
 * Which IPC channels an employee may run on the boss through the relay (`/api/proxy/action`).
 *
 * Allow-list, fail-closed: a channel that is not listed here is refused, so a new boss-only
 * feature (browser profiles, Facebook poster, relay/employee/workspace admin…) can never be
 * reached by an employee just because nobody remembered to deny it. The boss-side handler's own
 * `isEmployeeMode()` guard does not help here: on the boss that check is false.
 *
 * The list mirrors the channels the employee app sends that the boss actually handles
 * (every `proxyToBoss(...)` and `proxyAction(...)` call site). The employee app also sends 13
 * database writes without the `db:` prefix (`saveStickers`, `upsertGroupMember`, …); the boss has
 * no handler for those names (only `db:<name>`), so they never worked and are not listed here. To let employees use another channel, add it here and to
 * `src/__tests__/http/relayChannelPolicy.test.ts`. Module permissions and account scoping are
 * still checked afterwards in `HttpRelayService.executeProxyAction`.
 */

// Exact channels outside the prefixes below.
const ALLOWED_EXACT = new Set<string>(['login:connect']);

const ALLOWED_PREFIXES = ['zalo:', 'crm:', 'ai:', 'integration:', 'db:'];

export function isEmployeeChannelAllowed(channel: unknown): boolean {
    if (typeof channel !== 'string' || channel.length === 0) return false;
    if (ALLOWED_EXACT.has(channel)) return true;
    return ALLOWED_PREFIXES.some((prefix) => channel.startsWith(prefix) && channel.length > prefix.length);
}
