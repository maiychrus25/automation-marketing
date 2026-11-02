import type { FbPosterMode } from '../../models/facebookPoster';
import { normalizeTarget } from '../facebookPoster/targets';
import type { AutonomyBudget } from '../facebookPoster/types';
import type { AutonomyLimiter } from './AutonomyLimiter';

/** Budget of one profile's api-origin post run: every target is reserved against the daily caps before the Post click. */
export function createAutonomyBudget(
    limiter: Pick<AutonomyLimiter, 'check' | 'reserve' | 'commit' | 'release'>,
    ctx: { profileId: string; mode: FbPosterMode; runId: string },
): AutonomyBudget {
    const request = (targetUrl: string) => {
        let targetKey = targetUrl;
        try { targetKey = normalizeTarget(targetUrl).url; } catch { /* keep the raw URL as the key */ }
        return { action: ctx.mode === 'page' ? 'page_post' as const : 'group_post' as const, origin: 'api' as const, profileId: ctx.profileId, targetKey, ref: ctx.runId };
    };
    return {
        check: (targetUrl) => { limiter.check(request(targetUrl)); },
        reserve(targetUrl) {
            const id = limiter.reserve(request(targetUrl));
            // Only an app-origin request can come back null, and this budget is always api.
            if (id === null) throw new Error('Không giữ được lượt đăng của bộ giới hạn');
            return id;
        },
        commit: (id) => { limiter.commit(id); },
        release: (id) => { limiter.release(id); },
    };
}
