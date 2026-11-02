import { memoryDb } from '../facebookPoster/helpers';
import { AutonomyLimiter } from '../../services/autonomy/AutonomyLimiter';
import { createAutonomyOperations } from '../../services/autonomy/autonomyOperations';
import { computeDueWork } from '../../services/autonomy/autonomyDueWork';
import { DailyBriefStore, type LocalClock } from '../../services/dailyBrief/DailyBriefStore';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { PAGE_CAMPAIGN_EXECUTION_SCHEMA_SQL } from '../../services/facebookPoster/schema';
import { VIDEO_SCHEMA_SQL } from '../../services/video/VideoStore';

const HOUR = 3_600_000;
// 10:00 UTC on 2026-11-03: outside quiet hours.
const NOW = Date.UTC(2026, 10, 3, 10, 0);
const utcClock: LocalClock = {
    date: (ms) => new Date(ms).toISOString().slice(0, 10),
    minutes: (ms) => new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes(),
};

function setup(over: { cancel?: () => { cancelledRuns: number; disabledSchedules: number } } = {}) {
    const db = memoryDb();
    const h = { now: NOW, master: true };
    const limiter = new AutonomyLimiter(db, { now: () => h.now, clock: utcClock, protectedWritesEnabled: () => h.master });
    limiter.ensureSchema();
    const events: { type: string; payload: any }[] = [];
    const cancelApiWork = jest.fn(over.cancel ?? (() => ({ cancelledRuns: 2, disabledSchedules: 1 })));
    const ops = createAutonomyOperations({
        limiter: () => limiter,
        dueWork: () => computeDueWork(db, h.now, utcClock, { masterOn: h.master, limiter }),
        emit: (type, payload) => { events.push({ type, payload }); },
        cancelApiWork,
        now: () => h.now,
        clock: utcClock,
        masterOn: () => h.master,
        timeZone: () => 'UTC',
    });
    return { db, h, limiter, ops, events, cancelApiWork };
}

describe('autonomyOperations', () => {
    it('stopDisablesAndCancelsAndEmits', () => {
        const { ops, limiter, events, cancelApiWork } = setup();
        ops.resume('app');
        events.length = 0;
        expect(ops.stop('app')).toMatchObject({ enabled: false, cancelledRuns: 2, disabledSchedules: 1 });
        expect(limiter.policy().enabled).toBe(false);
        expect(cancelApiWork).toHaveBeenCalledTimes(1);
        expect(events.map((e) => e.type)).toEqual(['autonomy.changed', 'autonomy.stopped']);
        expect(events[1].payload).toEqual({ actor: 'app', cancelledRuns: 2, disabledSchedules: 1 });
        expect(events[0].payload.changes).toEqual([expect.objectContaining({ field: 'enabled', before: true, after: false })]);
    });

    it('stopEmitsStoppedEvenIfCancelThrows', () => {
        const { ops, limiter, events } = setup({ cancel: () => { throw new Error('boom'); } });
        ops.resume('app');
        events.length = 0;
        expect(ops.stop('app')).toEqual({ enabled: false, cancelledRuns: 0, disabledSchedules: 0 });
        expect(limiter.policy().enabled).toBe(false);
        expect(events.map((e) => e.type)).toEqual(['autonomy.changed', 'autonomy.stopped']);
        expect(events[1].payload).toEqual({ actor: 'app', cancelledRuns: 0, disabledSchedules: 0 });
    });

    it('disablingViaSetConfigActsAsEmergencyStop', () => {
        const { ops, limiter, events, cancelApiWork } = setup();
        ops.resume('app');
        events.length = 0;
        ops.setConfig({ enabled: false, groupPostsPerDay: 2 }, 'bot-key');
        expect(limiter.policy().enabled).toBe(false);
        expect(cancelApiWork).toHaveBeenCalledTimes(1);
        expect(events.map((e) => e.type)).toEqual(['autonomy.changed', 'autonomy.stopped']);
        expect(events[1].payload).toEqual({ actor: 'bot-key', cancelledRuns: 2, disabledSchedules: 1 });
        // Already off, or a change that leaves enabled alone: no second stop.
        ops.setConfig({ enabled: false }, 'bot-key');
        ops.setConfig({ groupPostsPerDay: 1 }, 'app');
        expect(cancelApiWork).toHaveBeenCalledTimes(1);
        expect(events.map((e) => e.type)).toEqual(['autonomy.changed', 'autonomy.stopped', 'autonomy.changed']);

        // A cancel failure still turns autonomy off and reports the stop.
        const failing = setup({ cancel: () => { throw new Error('boom'); } });
        failing.ops.resume('app');
        failing.events.length = 0;
        expect(() => failing.ops.setConfig({ enabled: false }, 'app')).not.toThrow();
        expect(failing.limiter.policy().enabled).toBe(false);
        expect(failing.events.map((e) => e.type)).toEqual(['autonomy.changed', 'autonomy.stopped']);
        expect(failing.events[1].payload).toEqual({ actor: 'app', cancelledRuns: 0, disabledSchedules: 0 });
    });

    it('resumeProfileEmitsChangedOnlyWhenItResumes', () => {
        const { ops, limiter, events } = setup();
        expect(ops.resumeProfile('p1', 'bot-key')).toEqual({ resumed: false });
        expect(events).toEqual([]);
        limiter.pauseProfile('p1', 'checkpoint');
        expect(ops.resumeProfile('p1', 'bot-key')).toEqual({ resumed: true });
        expect(events).toEqual([{ type: 'autonomy.changed', payload: {
            actor: 'bot-key', profileId: 'p1', changes: [{ at: NOW, field: 'profileResumed', before: 'checkpoint', after: 'resumed' }],
        } }]);
    });

    it('recordAgentRunReportsTheCommitResult', () => {
        const { ops, db } = setup();
        ops.resume('app');
        expect(ops.recordAgentRun({ outcome: 'ok' })).toMatchObject({ recorded: true });
        expect(db.queryOne<{ status: string }>("SELECT status FROM autonomy_actions WHERE action = 'agent_run'")!.status).toBe('used');
    });

    it('setConfigEmitsChangedOnlyWhenSomethingChanged', () => {
        const { ops, events } = setup();
        ops.setConfig({ groupPostsPerDay: 2 }, 'bot-key');
        expect(events.map((e) => e.type)).toEqual(['autonomy.changed']);
        expect(events[0].payload).toMatchObject({ actor: 'bot-key', changes: [{ field: 'groupPostsPerDay', before: 3, after: 2 }] });
        ops.setConfig({ groupPostsPerDay: 2 }, 'bot-key');
        expect(events).toHaveLength(1);
    });

    it('setConfigRejectsUnknownKey', () => {
        const { ops, events } = setup();
        expect(() => ops.setConfig({ nope: 1 }, 'app')).toThrow();
        expect(() => ops.setConfig({ videosPerDay: -1 }, 'app')).toThrow();
        expect(events).toEqual([]);
    });

    it('resumeProfileClearsPause', () => {
        const { ops, limiter } = setup();
        limiter.pauseProfile('p1', 'checkpoint');
        expect(ops.status().pausedProfiles.map((p) => p.profileId)).toEqual(['p1']);
        expect(ops.resumeProfile('p1', 'app')).toEqual({ resumed: true });
        expect(ops.status().pausedProfiles).toEqual([]);
        expect(ops.resumeProfile('p1', 'app')).toEqual({ resumed: false });
    });

    it('recordAgentRunStopsAtTwelve', () => {
        const { ops, limiter } = setup();
        limiter.setPolicy({ enabled: true }, 'app');
        for (let i = 0; i < 12; i++) expect(ops.recordAgentRun({ outcome: 'ok' })).toMatchObject({ recorded: true });
        let err: any;
        try { ops.recordAgentRun({ outcome: 'error' }); } catch (e) { err = e; }
        expect(err).toMatchObject({ code: 'LIMIT_REACHED', details: { reason: 'quota' } });
        expect(() => ops.recordAgentRun({ outcome: 'bogus' as any })).toThrow();
    });

    it('statusReportsRemainingAndDue', () => {
        const { ops, limiter, db, h } = setup();
        const briefs = new DailyBriefStore(db, utcClock);
        briefs.ensureSchema();
        briefs.saveBrief('p1', { time: '08:00' }, NOW);
        briefs.saveBrief('p2', { time: '23:00' }, NOW);
        db.exec(PAGE_CAMPAIGN_EXECUTION_SCHEMA_SQL);
        new FacebookPosterStore(db).ensureSchema();
        db.exec(VIDEO_SCHEMA_SQL);
        db.run("INSERT INTO video_jobs (id, name, source, spec_json, status, created_at) VALUES ('v1','a','s','{}','rendering',?)", [NOW]);
        db.run("INSERT INTO video_jobs (id, name, source, spec_json, status, created_at) VALUES ('v2','b','s','{}','done',?)", [NOW]);
        db.run("INSERT INTO fb_poster_schedules (id,name,kind,params_json,enabled,next_run_at,created_at,updated_at) VALUES ('s1','n','once','{}',1,?,?,?)", [NOW + 2 * HOUR, NOW, NOW]);
        db.run("INSERT INTO fb_poster_schedules (id,name,kind,params_json,enabled,next_run_at,created_at,updated_at) VALUES ('s2','n','once','{}',1,?,?,?)", [NOW + 30 * HOUR, NOW, NOW]);
        for (const s of ['s1', 's2']) {
            db.run("INSERT INTO page_campaign_executions (schedule_id,workspace_id,page_id,profile_id,work_id,campaign_id,grant_id,planned_date,status,revision,execution_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                [s, 'w', 'pg', 'p1', 'wk', 'c', 'g', '2026-11-03', 'reserved', 1, '{}']);
        }
        limiter.setPolicy({ enabled: true }, 'app');
        limiter.reserve({ action: 'page_post', origin: 'api', profileId: 'p1' });
        limiter.reserve({ action: 'video', origin: 'app' });
        const status = ops.status();
        expect(status).toMatchObject({ enabled: true, masterOn: true, quietNow: false, now: h.now, timeZone: 'UTC' });
        expect(status.policy.leadRepliesPerDay).toBe(10);
        expect(status.usage.workspace.videos).toBe(1);
        expect(status.remaining.videos).toBe(1);
        expect(status.remaining.agentRuns).toBe(12);
        expect(status.remaining.profiles.p1).toEqual({ pagePosts: 0, groupPosts: 3, leadReplies: 10, facebookActions: 11 });
        expect(status.remaining.profileDefault).toEqual({ pagePosts: 1, groupPosts: 3, leadReplies: 10, facebookActions: 12 });
        // Reserved executions are run by the app itself, so they are not the bot's due work.
        expect(status.due).toEqual({ briefs: 1, campaignSchedules: 0, commentPosts: 0, unrepliedLeads: 0, videosPending: 1 });
    });

    it('loginProblemPausesProfileOnce', () => {
        const { ops, events } = setup();
        const problem = { profileId: 'p1', profileName: 'Page A', state: 'checkpoint' as const };
        ops.pauseOnLoginProblem(problem);
        ops.pauseOnLoginProblem(problem);
        expect(events).toEqual([{ type: 'autonomy.paused', payload: { profileId: 'p1', profileName: 'Page A', reason: 'checkpoint' } }]);
        ops.pauseOnLoginProblem({ profileId: 'p2', profileName: 'B', state: 'ok' as const });
        expect(events).toHaveLength(1);
    });
});

const gateFor = (db: ReturnType<typeof memoryDb>, masterOn = true) => {
    const limiter = new AutonomyLimiter(db, { now: () => NOW, clock: utcClock, protectedWritesEnabled: () => masterOn });
    limiter.ensureSchema();
    limiter.setPolicy({ enabled: true }, 'test');
    return { masterOn, limiter };
};

function leadDb() {
    const db = memoryDb();
    new DailyBriefStore(db, utcClock).ensureSchema();
    new FacebookPosterStore(db).ensureSchema();
    db.exec(PAGE_CAMPAIGN_EXECUTION_SCHEMA_SQL);
    db.exec(VIDEO_SCHEMA_SQL);
    const results: Record<string, number> = {};
    for (const profile of ['p1', 'p2']) {
        db.run("INSERT INTO fb_poster_runs (id, kind, mode, params_json, status, started_at) VALUES (?,'post','group','{}','done',1)", [`r-${profile}`]);
        results[profile] = db.runInsert("INSERT INTO fb_poster_results (run_id, profile_id, profile_name, target_url, outcome, created_at) VALUES (?,?,'P','u','posted',1)", [`r-${profile}`, profile]);
    }
    const lead = (key: string, over: { profile?: string; resultRef?: number | null; status?: string; author?: string; post?: string } = {}) => db.runInsert(
        "INSERT INTO fb_poster_leads (comment_key, post_url, result_id, profile_id, author_id, status, detected_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)",
        [key, over.post ?? 'https://x/p', over.resultRef === undefined ? results[over.profile ?? 'p1'] : over.resultRef, over.profile ?? 'p1', over.author ?? '', over.status ?? 'new']);
    const reply = (leadId: number, status: string, author = '', post = 'u') =>
        db.run("INSERT INTO fb_poster_lead_replies (lead_id, profile_id, post_url, author_id, text, status, created_at) VALUES (?, 'p1', ?, ?, 't', ?, 1)", [leadId, post, author, status]);
    return { db, lead, reply };
}

describe('computeDueWork', () => {
    it('returnsZeroWhenReplyTableIsAbsent', () => {
        const db = memoryDb();
        new DailyBriefStore(db, utcClock).ensureSchema();
        new FacebookPosterStore(db).ensureSchema();
        db.exec(PAGE_CAMPAIGN_EXECUTION_SCHEMA_SQL);
        db.exec(VIDEO_SCHEMA_SQL);
        expect(computeDueWork(db, NOW, utcClock, gateFor(db))).toEqual({ briefs: 0, campaignSchedules: 0, commentPosts: 0, unrepliedLeads: 0, videosPending: 0 });
    });

    it('unrepliedLeadsExcludesHandledAndBlocked', () => {
        const { db, lead, reply } = leadDb();
        lead('open');
        reply(lead('posted'), 'posted');
        reply(lead('failed'), 'failed');
        reply(lead('skipped'), 'skipped'); // handled once: not proposed again automatically
        lead('not-app-post', { resultRef: null });
        lead('ignored', { status: 'ignored' });
        // Same author under the same post already has a live reply through another lead row.
        reply(lead('first-of-author', { author: 'a1' }), 'queued', 'a1', 'https://x/p');
        lead('second-of-author', { author: 'a1' });
        // An author id that is empty never blocks other leads.
        reply(lead('anon-1'), 'skipped', '', 'https://x/p');
        lead('anon-2');
        expect(computeDueWork(db, NOW, utcClock, gateFor(db)).unrepliedLeads).toBe(2); // open + anon-2
    });

    it('unrepliedLeadsZeroWhenCapSpentPausedOrMasterOff', () => {
        const { db, lead } = leadDb();
        lead('a'); lead('b', { profile: 'p2' });
        const gate = gateFor(db);
        expect(computeDueWork(db, NOW, utcClock, gate).unrepliedLeads).toBe(2);
        gate.limiter.pauseProfile('p2', 'checkpoint');
        expect(computeDueWork(db, NOW, utcClock, gate).unrepliedLeads).toBe(1);
        gate.limiter.setPolicy({ leadRepliesPerDay: 1 }, 'test');
        gate.limiter.commit(gate.limiter.reserve({ action: 'lead_reply', origin: 'api', profileId: 'p1' })!);
        expect(computeDueWork(db, NOW, utcClock, gate).unrepliedLeads).toBe(0);
        gate.limiter.resumeProfile('p2');
        expect(computeDueWork(db, NOW, utcClock, gate).unrepliedLeads).toBe(1);
        expect(computeDueWork(db, NOW, utcClock, { ...gate, masterOn: false }).unrepliedLeads).toBe(0);
    });
});
