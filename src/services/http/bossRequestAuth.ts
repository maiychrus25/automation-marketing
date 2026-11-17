/**
 * Decides whether the employee app attaches its session to a request going to the boss machine.
 * Pure on purpose (no Electron): `electron/main.ts` calls it from `onBeforeSendHeaders`,
 * because the renderer builds plain `<img src="{bossUrl}/api/media/...">` URLs and cannot send headers.
 * The token is only ever put in a header, never in a URL.
 */
export function bossAuthHeaderFor(requestUrl: string, workspace: { bossUrl?: string; token?: string } | null): string | null {
    if (!workspace?.bossUrl || !workspace.token) return null;
    try {
        const target = new URL(requestUrl);
        const boss = new URL(workspace.bossUrl);
        if (target.origin !== boss.origin) return null;
        if (!target.pathname.startsWith('/api/media/') && !target.pathname.startsWith('/api/library/')) return null;
        return `Bearer ${workspace.token}`;
    } catch {
        return null;
    }
}
