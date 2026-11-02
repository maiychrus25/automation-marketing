import type { FbPosterRun } from '../../models/facebookPoster';
import type { FacebookPosterStore } from '../facebookPoster/FacebookPosterStore';

export interface CancelApiWorkDeps {
    store: Pick<FacebookPosterStore, 'listSchedules' | 'updateSchedule'>;
    activeRuns(): FbPosterRun[];
    cancelRun(runId: string): boolean;
    now(): number;
    /** Cancels reserved Page-campaign executions confirmed by the owner key; returns how many. */
    cancelOwnerCampaignSchedules?(): number;
    /** Wakes `pageWork.events` long-polls: the cancel writes `pageCampaigns.scheduleChanged` rows straight to the store. */
    wakeEventWaiters?(): void;
}

/**
 * Stop switch: cancels the live runs the bot approved and turns off the schedules it approved.
 * The operator's own runs and schedules (origin 'app') are never touched.
 * Campaign schedules (authority 'autonomy') are not touched by the loop below: their reserved executions confirmed by the owner key
 * are cancelled through `cancelOwnerCampaignSchedules`; receiver-confirmed campaigns keep running.
 */
export function cancelApiWork(deps: CancelApiWorkDeps): { cancelledRuns: number; disabledSchedules: number } {
    // Schedules first so nothing new starts while runs are being cancelled; one failure must not skip the rest.
    let disabledSchedules = 0;
    for (const schedule of deps.store.listSchedules()) {
        if (schedule.origin !== 'api' || !schedule.enabled || schedule.authorityKind === 'autonomy') continue;
        try {
            deps.store.updateSchedule(schedule.id, { enabled: false, nextRunAt: null }, deps.now());
            disabledSchedules += 1;
        } catch { /* counted only when actually disabled */ }
    }
    try {
        const cancelled = deps.cancelOwnerCampaignSchedules?.() ?? 0;
        disabledSchedules += cancelled;
        if (cancelled) deps.wakeEventWaiters?.();
    } catch { /* best-effort wake; runs below must still be cancelled */ }
    let cancelledRuns = 0;
    for (const run of deps.activeRuns()) {
        if (run.origin !== 'api') continue;
        try { if (deps.cancelRun(run.id)) cancelledRuns += 1; } catch { /* keep cancelling the others */ }
    }
    return { cancelledRuns, disabledSchedules };
}
