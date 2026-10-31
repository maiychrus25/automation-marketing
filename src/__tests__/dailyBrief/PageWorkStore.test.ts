import { memoryDb } from '../facebookPoster/helpers';
import { DailyBriefStore, BRIEF_STALE_MS, LocalClock } from '../../services/dailyBrief/DailyBriefStore';
import { PageBusinessStore } from '../../services/dailyBrief/PageBusinessStore';
import { PageWorkStore } from '../../services/dailyBrief/PageWorkStore';
import type { PageContext, PageWork, WorkLease } from '../../models/pageOperations';
import type { SqlDatabase } from '../../services/facebookPoster/FacebookPosterStore';

const clock: LocalClock = {
    date: (ms) => new Date(ms).toISOString().slice(0, 10),
    minutes: (ms) => new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes(),
};
const at = (time: string) => Date.parse(`2026-10-${time}Z`);
const now = at('27T08:00:00');
const day = 86400000;
const context: PageContext = { workspaceId: 'workspace-1', dbPath: ':memory:', pageId: 'page-1', profileId: 'profile-1' };
const lease = (work: PageWork): WorkLease => ({ workId: work.id, claimedAt: work.claimedAt! });
const confirmation = { confirmedAt: now - 1, confirmationRef: 'owner-message' };

function setup() {
    const db = memoryDb();
    const briefs = new DailyBriefStore(db, clock);
    briefs.ensureSchema();
    briefs.saveBrief('profile-1', { time: '07:00', draftsPerDay: 1 }, now - 10);
    const business = new PageBusinessStore(db);
    business.ensureSchema();
    business.ensure('page-1', 'profile-1', now - 10);
    business.setEnabled('page-1', true, 0, confirmation);
    const store = new PageWorkStore(db, clock);
    store.ensureSchema();
    return { db, briefs, business, store };
}
function waiting(store: PageWorkStore, time = now) {
    const work = store.claimDue(context, time)!;
    store.beginStep(lease(work), 'video', 'request-1', time);
    store.finishStep(lease(work), 'video', { kind: 'video', id: 'video-1' }, time);
    return store.transition(lease(work), 'waiting', { waitFor: 'video', nextCheckAt: time + 100 }, time);
}
function draft(store: PageWorkStore, work: PageWork, id = 'draft-1', time = now) {
    store.beginStep(lease(work), id, `hash-${id}`, time);
    store.finishStep(lease(work), id, { kind: 'draft', id }, time);
}
function usage(db: SqlDatabase) { return db.query<any>('SELECT * FROM page_work_daily_usage ORDER BY usage_date'); }
function identity(briefs: DailyBriefStore, profileId: string, pageId: string) {
    briefs.upsertIdentity({ profileId, kind: 'page', pageId, pageName: '', category: '', about: '', recentPosts: [],
        learnedAt: now, errorCode: '', error: '' });
}

describe('PageWorkStore', () => {
    it('reservesIdentityAndReplaysOriginalRevisionAfterLaterEdits', () => {
        const { store, db } = setup();
        const work = store.claimDue(context, now)!;
        const token = lease(work);
        const resource = { kind: 'draft' as const, id: 'stable-draft' };
        expect(store.beginStep(token, 'draft:0', 'hash', now, resource)).toMatchObject({ status: 'intent', resourceId: resource.id });
        expect(() => store.beginStep(token, 'draft:0', 'hash', now, { ...resource, id: 'wrong' })).toThrow();
        expect(() => store.finishStep(token, 'draft:0', { ...resource, id: 'wrong' }, now, 1)).toThrow();
        store.finishStep(token, 'draft:0', resource, now, 1);
        store.beginStep(token, 'draft:0:revision:2', 'edit', now, resource);
        store.finishStep(token, 'draft:0:revision:2', resource, now, 2);
        const restarted = new PageWorkStore(db, clock);
        expect(restarted.getStep(work.id, 'draft:0')).toMatchObject({ resourceId: resource.id, resultRevision: 1 });
        expect(() => restarted.finishStep(token, 'draft:0', resource, now, 2)).toThrow();
        expect(restarted.get(work.id)!.draftIds).toEqual([resource.id]);
    });

    it('atomicCommitRollsBackResultAndResourceWithSameConnection', () => {
        const { store } = setup();
        const work = store.claimDue(context, now)!;
        const token = lease(work);
        store.beginStep(token, 'draft:0', 'hash', now);
        expect(() => store.transaction(() => {
            store.assertLease(token, now);
            store.finishStep(token, 'draft:0', { kind: 'draft', id: 'draft' }, now, 1);
            throw new Error('DB write failure');
        })).toThrow('DB write failure');
        expect(store.getStep(work.id, 'draft:0')).toMatchObject({ status: 'intent', resultRevision: null });
        expect(store.get(work.id)!.draftIds).toEqual([]);
        expect(store.getResourceOwner({ kind: 'draft', id: 'draft' })).toBeNull();
        expect(() => store.assertLease(token, now + BRIEF_STALE_MS)).toThrow();
    });

    it('legacyStepNeverInventsRevisionAndCannotBackfillOnReplay', () => {
        const { store } = setup();
        const work = store.claimDue(context, now)!;
        const token = lease(work);
        store.beginStep(token, 'draft:0', 'hash', now);
        store.finishStep(token, 'draft:0', { kind: 'draft', id: 'draft' }, now);
        expect(store.getStep(work.id, 'draft:0')!.resultRevision).toBeNull();
        expect(() => store.finishStep(token, 'draft:0', { kind: 'draft', id: 'draft' }, now, 1)).toThrow();
    });
    it('twoClaimsHaveOneWinner', () => {
        const { store, db } = setup();
        const claims = [store.claimDue(context, now), new PageWorkStore(db, clock).claimDue(context, now)];
        expect(claims.filter(Boolean)).toHaveLength(1);
        expect(claims[0]).toMatchObject({ workspaceId: 'workspace-1', pageId: 'page-1', profileId: 'profile-1',
            briefDate: '2026-10-27', status: 'running', attempts: 1 });
        expect(store.list(['page-1'])).toEqual([claims[0]]);
        expect(store.list([])).toEqual([]);
        expect(store.list(['other'])).toEqual([]);
        expect(() => store.ensureSchema()).not.toThrow();
    });

    it.each([0, -100])('staleCompletionCannotFinishNewLease(clock delta %i)', (delta) => {
        const { store } = setup();
        const first = store.claimDue(context, now)!;
        store.transition(lease(first), 'pending', {}, now);
        const second = store.claimDue(context, now + delta)!;
        expect(second.claimedAt).toBe(first.claimedAt! + 1);
        expect(() => store.transition(lease(first), 'failed', {}, now)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
        expect(() => store.beginStep(lease(first), 'research', 'hash', now)).toThrow();
        expect(store.get(first.id)).toEqual(second);
        expect(store.claimDue(context, now + delta + BRIEF_STALE_MS - 1)).toBeNull();
        expect(store.claimDue(context, now + delta + BRIEF_STALE_MS)!.attempts).toBe(3);
    });

    it('pollingDoesNotSpendAttempts', () => {
        const { store, db } = setup();
        const before = waiting(store);
        const budget = usage(db);
        for (let i = 0; i < 100; i++) {
            store.reconcileVideo(before.id, 'video-1', 'running', now + i);
            expect(store.claimDue(context, now + i)).toBeNull();
        }
        expect(store.get(before.id)!.attempts).toBe(before.attempts);
        expect(usage(db)).toEqual(budget);
        expect(() => store.reconcileVideo(before.id, 'wrong', 'completed', now)).toThrow();
        expect(store.reconcileVideo(before.id, 'video-1', 'completed', now + 100)).toMatchObject({ status: 'pending', attempts: 1 });
        expect(store.claimDue(context, now + 100)!.attempts).toBe(2);
    });

    it('fourthAgentInvocationIsRejected', () => {
        const { store, db } = setup();
        for (let i = 1; i <= 3; i++) {
            const work = store.claimDue(context, now + i)!;
            expect(work.attempts).toBe(i);
            store.beginStep(lease(work), `step-${i}`, `hash-${i}`, now + i);
            store.finishStep(lease(work), `step-${i}`, { kind: 'media', id: `media-${i}` }, now + i);
            store.transition(lease(work), 'pending', {}, now + i);
        }
        expect(store.claimDue(context, now + 4)).toBeNull();
        expect(usage(db)[0].attempts).toBe(3);
        const tomorrow = store.claimDue(context, now + day)!;
        expect(tomorrow).toMatchObject({ briefDate: '2026-10-27', attempts: 4 });
        expect(usage(db)[1].attempts).toBe(1);
    });

    it('waitingAcrossMidnightBlocksNewWork', () => {
        const { store } = setup();
        const before = waiting(store);
        expect(store.claimDue(context, now + day)).toBeNull();
        expect(store.list(['page-1'])).toEqual([before]);
        store.reconcileVideo(before.id, 'video-1', 'completed', now + day);
        expect(store.claimDue(context, now + day)).toMatchObject({ id: before.id, briefDate: '2026-10-27', attempts: 2 });
    });

    it('needsReviewBlocksNextBrief', () => {
        const { store } = setup();
        const work = waiting(store);
        expect(store.reconcileVideo(work.id, 'video-1', 'failed', now)).toMatchObject({ status: 'needs_review', attempts: 1 });
        expect(store.claimDue(context, now + day)).toBeNull();
        expect(store.prune(now + 40 * day)).toBe(0);
    });

    it('completedDraftDoesNotHoldLease', () => {
        const { store, db } = setup();
        const work = store.claimDue(context, now)!;
        draft(store, work);
        expect(store.transition(lease(work), 'completed', {}, now)).toMatchObject({ status: 'completed', draftIds: ['draft-1'] });
        expect(store.claimDue(context, now)).toBeNull();
        expect(store.claimDue(context, now + day)).toMatchObject({ briefDate: '2026-10-28', attempts: 1 });
        expect(usage(db)[0]).toMatchObject({ drafts_created: 1, completed: 1 });
    });

    it('completedCarryoverDoesNotCreateAnotherDailyBrief', () => {
        const { store, db, briefs } = setup();
        briefs.saveBrief('profile-1', { draftsPerDay: 2 }, now);
        const work = waiting(store);
        store.reconcileVideo(work.id, 'video-1', 'completed', now + day);
        const resumed = store.claimDue(context, now + day)!;
        draft(store, resumed, 'draft-1', now + day);
        store.transition(lease(resumed), 'completed', {}, now + day);
        expect(store.claimDue(context, now + day)).toBeNull();
        expect(usage(db)[1]).toMatchObject({ usage_date: '2026-10-28', attempts: 1, drafts_created: 1, completed: 1 });
    });

    it('prunePreservesActiveWorkAndResources', () => {
        const { store } = setup();
        const completed = store.claimDue(context, now)!;
        draft(store, completed);
        store.transition(lease(completed), 'completed', {}, now);
        const active = store.claimDue(context, now + day)!;
        expect(store.prune(now + 30 * day - 1)).toBe(0);
        expect(store.prune(now + 30 * day)).toBe(1);
        expect(store.get(completed.id)).toBeNull();
        expect(store.get(active.id)).toEqual(active);
        expect(store.getResourceOwner({ kind: 'draft', id: 'draft-1' })).toEqual({ workspaceId: 'workspace-1', pageId: 'page-1', workId: completed.id });
        expect(store.getResourceOwner({ kind: 'draft', id: 'missing' })).toBeNull();
    });

    it.each(['pending', 'running', 'waiting', 'needs_review'] as const)('pruneNeverDeletesUnfinishedWork(%s)', (status) => {
        const { store } = setup();
        let work = status === 'waiting' ? waiting(store) : store.claimDue(context, now)!;
        if (status !== 'running' && status !== 'waiting') work = store.transition(lease(work), status, {}, now);
        expect(store.prune(now + 40 * day)).toBe(0);
        expect(store.get(work.id)).toEqual(work);
    });

    it.each(['failed', 'cancelled'] as const)('pruneExpiresOtherTerminalJournalsWithoutDeletingLinkedResults(%s)', (status) => {
        const { store, db } = setup();
        const work = store.claimDue(context, now)!;
        store.beginStep(lease(work), 'research', 'hash', now);
        store.finishStep(lease(work), 'research', { kind: 'research', id: 'research-1' }, now);
        store.transition(lease(work), status, {}, now);
        expect(store.prune(now + 30 * day)).toBe(1);
        expect(store.get(work.id)).toBeNull();
        expect(db.query('SELECT * FROM page_work_steps')).toEqual([]);
        expect(store.getResourceOwner({ kind: 'research', id: 'research-1' })!.workId).toBe(work.id);
    });

    it('retryAfterCacheTtlFindsTheOriginalDraftWithoutSpendingDraftBudget', () => {
        const { store, db } = setup();
        const work = store.claimDue(context, now)!;
        const intent = store.beginStep(lease(work), 'draft', 'hash', now);
        expect(intent).toEqual({ workId: work.id, stepKey: 'draft', requestHash: 'hash', status: 'intent', resourceKind: null, resourceId: null });
        store.finishStep(lease(work), 'draft', { kind: 'draft', id: 'draft-1' }, now);
        store.transition(lease(work), 'pending', {}, now);
        const resumed = store.claimDue(context, now + day)!;
        expect(store.beginStep(lease(resumed), 'draft', 'hash', now + day)).toMatchObject({ status: 'succeeded', resourceKind: 'draft', resourceId: 'draft-1' });
        store.finishStep(lease(resumed), 'draft', { kind: 'draft', id: 'draft-1' }, now + day);
        expect(usage(db).map((u) => u.drafts_created)).toEqual([1, 0]);
        expect(store.get(work.id)!.draftIds).toEqual(['draft-1']);
    });

    it('hashAndLeaseMismatchNeverChangeStepOrResource', () => {
        const { store } = setup();
        const work = store.claimDue(context, now)!;
        const step = store.beginStep(lease(work), 'draft', 'hash', now);
        expect(() => store.beginStep(lease(work), 'draft', 'different', now)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
        expect(store.beginStep(lease(work), 'draft', 'hash', now)).toEqual(step);
        expect(() => store.finishStep({ workId: work.id, claimedAt: now - 1 }, 'draft', { kind: 'draft', id: 'x' }, now)).toThrow();
        expect(store.getResourceOwner({ kind: 'draft', id: 'x' })).toBeNull();
        store.finishStep(lease(work), 'draft', { kind: 'draft', id: 'draft-1' }, now);
        expect(() => store.finishStep(lease(work), 'draft', { kind: 'draft', id: 'different' }, now)).toThrow();
    });

    it('expiredUnknownSideEffectRequiresReviewInsteadOfBlindRetry', () => {
        const { store, db } = setup();
        const work = store.claimDue(context, now)!;
        store.beginStep(lease(work), 'draft', 'hash', now);
        expect(store.claimDue(context, now + BRIEF_STALE_MS)).toBeNull();
        expect(store.get(work.id)).toMatchObject({ status: 'needs_review', attempts: 1 });
        expect(db.queryOne<any>('SELECT status FROM page_work_steps WHERE work_id = ?', [work.id])!.status).toBe('uncertain');
        expect(usage(db)[0].attempts).toBe(1);
    });

    it.each(['disabledBusiness', 'disabledBrief', 'tooEarly', 'wrongPrimary', 'wrongWorkspace', 'lastRunToday', 'terminalToday'] as const)
    ('respectsBriefAndContextEligibility(%s)', (variant) => {
        const { store, business, briefs, db } = setup();
        if (variant === 'disabledBusiness') business.setEnabled('page-1', false, 1, confirmation);
        if (variant === 'disabledBrief') briefs.saveBrief('profile-1', { enabled: false }, now);
        if (variant === 'tooEarly') briefs.saveBrief('profile-1', { time: '09:00' }, now);
        if (variant === 'lastRunToday') db.run('UPDATE daily_briefs SET last_run_date = ? WHERE profile_id = ?', ['2026-10-27', 'profile-1']);
        if (variant === 'terminalToday') {
            const work = store.claimDue(context, now)!;
            store.transition(lease(work), 'cancelled', {}, now);
        }
        if (variant === 'wrongWorkspace') {
            const work = store.claimDue(context, now)!;
            store.transition(lease(work), 'pending', {}, now);
        }
        expect(store.claimDue({ ...context, ...(variant === 'wrongPrimary' ? { profileId: 'other' } : {}),
            ...(variant === 'wrongWorkspace' ? { workspaceId: 'other' } : {}) }, now)).toBeNull();
    });

    it('primaryChangeDoesNotRebindExistingWorkAndTrustedInvalidationRevokesTheLease', () => {
        const { store, business, briefs } = setup();
        const work = store.claimDue(context, now)!;
        briefs.saveBrief('profile-2', {}, now);
        business.setPrimaryProfile('page-1', 'profile-2', 1, confirmation);
        expect(store.claimDue({ ...context, profileId: 'profile-2' }, now + BRIEF_STALE_MS)).toBeNull();
        expect(() => store.beginStep(lease(work), 'draft', 'hash', now)).toThrow();
        expect(store.invalidateLease(work.id, now)).toMatchObject({ status: 'needs_review', profileId: 'profile-1' });
        expect(() => store.transition(lease(work), 'failed', {}, now)).toThrow();
    });

    it('terminalTransitionsPreserveResultsAndEvidenceAndRequireADraftForCompletion', () => {
        const { store } = setup();
        const work = store.claimDue(context, now)!;
        expect(() => store.transition(lease(work), 'completed', {}, now)).toThrow();
        expect(() => store.transition(lease(work), 'waiting', { waitFor: 'video' }, now)).toThrow();
        draft(store, work);
        store.transition(lease(work), 'pending', { evidenceRefs: ['source-1'] }, now);
        const resumed = store.claimDue(context, now)!;
        const completed = store.transition(lease(resumed), 'completed', { evidenceRefs: [] }, now);
        expect(completed.evidenceRefs).toEqual(['source-1']);
        expect(completed.draftIds).toEqual(['draft-1']);
        expect(() => store.transition(lease(resumed), 'pending', {}, now)).toThrow();
    });

    it('pendingBackoffIsPreservedAndRespectedWithoutSpendingAnAttempt', () => {
        const { store, db } = setup();
        const work = store.claimDue(context, now)!;
        expect(store.transition(lease(work), 'pending', { nextCheckAt: now + 100 }, now).nextCheckAt).toBe(now + 100);
        expect(store.claimDue(context, now + 99)).toBeNull();
        expect(usage(db)[0].attempts).toBe(1);
        expect(store.claimDue(context, now + 100)!.attempts).toBe(2);
    });

    it('primarySwitchCannotResetThePageInvocationBudget', () => {
        const { store, briefs, business } = setup();
        for (let i = 0; i < 3; i++) {
            const work = store.claimDue(context, now)!;
            store.transition(lease(work), 'pending', {}, now);
        }
        briefs.saveBrief('profile-2', {}, now);
        business.setPrimaryProfile('page-1', 'profile-2', 1, confirmation);
        business.setPrimaryProfile('page-1', 'profile-1', 2, confirmation);
        expect(store.claimDue(context, now)).toBeNull();
    });

    it.each(['usageWrite', 'noClaimWrite', 'emptyWorkRows'] as const)('claimFailureIsAtomic(%s)', (stage) => {
        const { store, db } = setup();
        const broken: SqlDatabase = { ...db,
            run(sql, params) {
                if (stage === 'usageWrite' && sql.includes('INSERT INTO page_work_daily_usage')) throw new Error('Usage failed');
                if (stage === 'noClaimWrite' && sql.includes('UPDATE page_work_items')) db.run('UPDATE page_work_items SET attempts = attempts WHERE 0');
                else db.run(sql, params);
            },
            query: (sql, params) => stage === 'emptyWorkRows' && sql.includes('SELECT * FROM page_work_items') ? [] : db.query(sql, params),
        };
        expect(() => new PageWorkStore(broken, clock).claimDue(context, now)).toThrow();
        expect(store.list(['page-1'])).toEqual([]);
        expect(usage(db)).toEqual([]);
    });

    it('expiredLeaseCannotWriteWithoutAReclaim', () => {
        const { store } = setup();
        const work = store.claimDue(context, now)!;
        expect(() => store.beginStep(lease(work), 'draft', 'hash', now + BRIEF_STALE_MS)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
        expect(store.get(work.id)).toEqual(work);
    });

    it('resourceOwnershipCannotBeReboundAcrossPagesOrWorkspaces', () => {
        const { store, business, briefs } = setup();
        const work = store.claimDue(context, now)!;
        store.beginStep(lease(work), 'research', 'hash', now);
        store.finishStep(lease(work), 'research', { kind: 'research', id: 'research-1' }, now);
        business.ensure('page-2', 'profile-2', now);
        business.setEnabled('page-2', true, 0, confirmation);
        briefs.saveBrief('profile-2', {}, now);
        const other = store.claimDue({ ...context, pageId: 'page-2', profileId: 'profile-2', workspaceId: 'workspace-2' }, now)!;
        expect(() => store.linkResource(other.id, { kind: 'research', id: 'research-1' })).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
        expect(store.get(other.id)!.researchId).toBeNull();
        expect(store.getResourceOwner({ kind: 'research', id: 'research-1' })).toMatchObject({ workId: work.id, pageId: 'page-1', workspaceId: 'workspace-1' });
    });

    it.each([
        { waitFor: 'other' }, { nextCheckAt: -1 }, { reason: 5 }, { evidenceRefs: [''] },
        { lastError: false }, { draftIds: [] },
    ])('malformedTransitionNeverChangesTheWork(%j)', (patch) => {
        const { store } = setup();
        const work = store.claimDue(context, now)!;
        expect(() => store.transition(lease(work), 'pending', patch as any, now)).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
        expect(store.get(work.id)).toEqual(work);
    });

    it('unfinishedIntentsCannotBeReleasedForBlindRetryOrMarkedCompleted', () => {
        const { store } = setup();
        const work = store.claimDue(context, now)!;
        store.beginStep(lease(work), 'research', 'hash', now);
        expect(() => store.transition(lease(work), 'pending', {}, now)).toThrow(expect.objectContaining({ code: 'NEEDS_REVIEW' }));
        expect(() => store.beginStep(lease(work), 'another', 'hash-2', now)).toThrow(expect.objectContaining({ code: 'NEEDS_REVIEW' }));
        expect(store.transition(lease(work), 'needs_review', { reason: 'Cần đối soát' }, now).status).toBe('needs_review');
    });

    it('draftBudgetRejectsExtraCreatesButAllowsRetryAndTrustedLinksAreScoped', () => {
        const { store, db } = setup();
        const work = store.claimDue(context, now)!;
        draft(store, work);
        store.beginStep(lease(work), 'extra', 'hash-extra', now);
        expect(() => store.finishStep(lease(work), 'extra', { kind: 'draft', id: 'extra' }, now)).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
        expect(store.getResourceOwner({ kind: 'draft', id: 'extra' })).toBeNull();
        const wall = jest.spyOn(Date, 'now').mockReturnValue(now);
        try {
            store.linkResource(work.id, { kind: 'draft', id: 'draft-1' });
            store.linkResource(work.id, { kind: 'research', id: 'research-1' });
        } finally { wall.mockRestore(); }
        expect(store.get(work.id)).toMatchObject({ researchId: 'research-1', draftIds: ['draft-1'] });
        expect(usage(db)[0].drafts_created).toBe(1);
        expect(() => store.linkResource('missing', { kind: 'draft', id: 'draft-1' })).toThrow();
    });

    it.each(['claimWrite', 'stepWrite', 'resourceWrite', 'commit', 'changesRead', 'workRead'] as const)
    ('databaseFailuresRollBackWithoutFalseSuccess(%s)', (stage) => {
        const { store, db } = setup();
        const work = store.claimDue(context, now)!;
        store.beginStep(lease(work), 'draft', 'hash', now);
        const before = store.get(work.id);
        const budget = usage(db);
        const broken: SqlDatabase = { ...db,
            run(sql, params) {
                if ((stage === 'claimWrite' && sql.includes('UPDATE page_work_items'))
                    || (stage === 'stepWrite' && sql.includes('UPDATE page_work_steps'))
                    || (stage === 'resourceWrite' && sql.includes('INSERT INTO page_work_resources'))) throw new Error('Write failed');
                db.run(sql, params);
            },
            queryOne: (sql, params) => (stage === 'changesRead' && sql.includes('changes()'))
                || (stage === 'workRead' && sql.includes('COUNT(*)')) ? undefined : db.queryOne(sql, params),
            transaction: (fn) => db.transaction(() => { const result = fn(); if (stage === 'commit') throw new Error('Commit failed'); return result; }),
        };
        expect(() => new PageWorkStore(broken, clock).finishStep(lease(work), 'draft', { kind: 'draft', id: 'draft-1' }, now)).toThrow();
        expect(store.get(work.id)).toEqual(before);
        expect(usage(db)).toEqual(budget);
        expect(store.getResourceOwner({ kind: 'draft', id: 'draft-1' })).toBeNull();
    });
});

describe('protected handoff and legacy compatibility', () => {
    it('legacyWorksBeforeProtectedSchemaAndKeepsFailureCountSemantics', () => {
        const db = memoryDb();
        const legacy = new DailyBriefStore(db, clock);
        legacy.ensureSchema();
        legacy.saveBrief('legacy', {}, now);
        const claim = legacy.claimDue(now, () => true)[0];
        expect(claim.attempts).toBe(0);
        expect(legacy.finishBrief('legacy', false, now + 1, claim.claimedAt!).attempts).toBe(1);
        new PageWorkStore(db, clock).ensureSchema();
        expect(legacy.claimDue(now + 2, () => true)[0].attempts).toBe(1);
    });

    it('firstEnableRequiresAllAssociatedLegacyBriefsIdleAndRollsBack', () => {
        const db = memoryDb();
        const briefs = new DailyBriefStore(db, clock); briefs.ensureSchema();
        briefs.saveBrief('profile-1', {}, now);
        briefs.saveBrief('profile-2', {}, now);
        identity(briefs, 'profile-2', 'page-1');
        const legacyClaim = briefs.claimDue(now, () => true, 'profile-2')[0];
        const business = new PageBusinessStore(db); business.ensureSchema();
        const before = business.ensure('page-1', 'profile-1', now);
        expect(() => business.setEnabled('page-1', true, 0, confirmation)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
        expect(business.get('page-1')).toEqual(before);
        briefs.finishBrief('profile-2', false, now, legacyClaim.claimedAt!);
        business.setEnabled('page-1', true, 0, confirmation);
        expect(briefs.claimDue(now + BRIEF_STALE_MS, () => true)).toEqual([]);
    });

    it('protectionSurvivesDisableIdentityChangesAndLateLearnedAliases', () => {
        const { business, briefs } = setup();
        business.setEnabled('page-1', false, 1, confirmation);
        identity(briefs, 'profile-1', 'different-page');
        briefs.saveBrief('late-alias', {}, now);
        identity(briefs, 'late-alias', 'page-1');
        briefs.saveBrief('unrelated', {}, now);
        const claims = briefs.claimDue(now, () => true);
        expect(claims.map((b) => b.profileId)).toEqual(['unrelated']);
        expect(briefs.getBrief('profile-1')!.enabled).toBe(true);
        expect(briefs.getBrief('late-alias')!.enabled).toBe(true);
    });
});
