import fs from 'fs';
import os from 'os';
import path from 'path';
import { memoryDb } from '../facebookPoster/helpers';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { DailyBriefStore, type LocalClock } from '../../services/dailyBrief/DailyBriefStore';
import { PageBusinessStore } from '../../services/dailyBrief/PageBusinessStore';
import { PageWorkStore } from '../../services/dailyBrief/PageWorkStore';
import { PageCampaignStore } from '../../services/dailyBrief/PageCampaignStore';
import { PageCampaignExecutionStore } from '../../services/dailyBrief/PageCampaignExecutionStore';
import { createPageCampaignExecutionGuard } from '../../services/dailyBrief/pageCampaignExecution';
import { ControlStore, CONTROL_SCHEMA_SQL } from '../../services/control/ControlStore';
import { createPageOperationMethods, type PageOperationRequest } from '../../services/control/pageOperationMethods';
import { cancelOwnerCampaignSchedules } from '../../services/control/ownerPageRunner';
import { AutonomyLimiter } from '../../services/autonomy/AutonomyLimiter';
import { cancelApiWork } from '../../services/autonomy/cancelApiWork';
import { createAutonomyBudget } from '../../services/autonomy/autonomyBudget';
import { createAutonomyOperations } from '../../services/autonomy/autonomyOperations';
import { computeDueWork } from '../../services/autonomy/autonomyDueWork';
import { LeadReplier } from '../../services/facebookPoster/LeadReplier';
import { approveDraft, saveDraft } from '../../services/facebookPoster/drafts';
import { resolveScheduleMedia } from '../../services/facebookPoster/scheduleMedia';
import { buildMetricsReport } from '../../services/facebookPoster/NotificationScheduler';
import { PAGE_CAMPAIGN_EXECUTION_SCHEMA_SQL } from '../../services/facebookPoster/schema';
import { VIDEO_SCHEMA_SQL } from '../../services/video/VideoStore';

// One temp SQLite DB, explicit zone (Asia/Ho_Chi_Minh, UTC+7, no DST) and a fake clock; stores, limiter and guards are real.
// Only the browser/Facebook pieces are fakes (page JSON, comment poster). No Electron, so IPC wiring is covered by the unit tests.
const ZONE = 'Asia/Ho_Chi_Minh';
const parts = (ms: number) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
const clock: LocalClock & { timeZone(): string } = { timeZone: () => ZONE, date: (ms) => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; }, minutes: (ms) => { const p = parts(ms); return Number(p.hour) * 60 + Number(p.minute); } };
const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 3, 2, 58); // 09:58 local; the campaign slot is 10:00 (minute 600)
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function world() {
    const db = memoryDb(); db.exec(CONTROL_SCHEMA_SQL); db.exec(VIDEO_SCHEMA_SQL);
    db.exec('CREATE TABLE browser_profiles (id TEXT PRIMARY KEY)'); db.run("INSERT INTO browser_profiles (id) VALUES ('profile')");
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-autonomy-')); dirs.push(baseDir);
    const scope = { workspaceId: 'workspace', pageId: '12345', profileId: 'profile' };
    let time = T0; let master = true;
    const poster = new FacebookPosterStore(db); poster.ensureSchema();
    const works = new PageWorkStore(db, clock); works.ensureSchema();
    const campaigns = new PageCampaignStore(db); campaigns.ensureSchema();
    const briefs = new DailyBriefStore(db, clock); briefs.ensureSchema(); briefs.saveBrief('profile', { time: '09:00', draftsPerDay: 2 }, T0);
    briefs.upsertIdentity({ ...scope, kind: 'page', pageName: 'Page', category: '', about: '', recentPosts: [], learnedAt: T0, errorCode: '', error: '' });
    const business = new PageBusinessStore(db); business.ensure('12345', 'profile', T0);
    business.setEnabled('12345', true, 0, { confirmedAt: T0, confirmationRef: 'owner' });
    const work = works.claimDue({ ...scope, dbPath: ':memory:' }, T0)!;
    const lease = { workId: work.id, claimedAt: work.claimedAt! };
    const executions = new PageCampaignExecutionStore(db, clock); executions.ensureSchema();
    db.exec(PAGE_CAMPAIGN_EXECUTION_SCHEMA_SQL);
    const control = new ControlStore(db);
    const owner = control.createKey('Owner');
    const limiter = new AutonomyLimiter(db, { now: () => time, clock, protectedWritesEnabled: () => master }); limiter.ensureSchema();
    const events: { type: string; payload: any }[] = [];
    const ops = createAutonomyOperations({
        limiter: () => limiter, dueWork: () => computeDueWork(db, time, clock, { masterOn: master, limiter }), emit: (type, payload) => { events.push({ type, payload }); },
        cancelApiWork: () => cancelApiWork({ store: poster, activeRuns: () => activeRuns, cancelRun: (id) => { cancelled.push(id); return true; }, now: () => time,
            cancelOwnerCampaignSchedules: () => cancelOwnerCampaignSchedules(db, time, clock) }),
        now: () => time, clock, masterOn: () => master, timeZone: () => ZONE,
    });
    const activeRuns: any[] = []; const cancelled: string[] = [];
    const policy = { startsAt: T0, expiresAt: T0 + 7 * DAY, maxPostsPerDay: 1, maxPostsTotal: 7, allowedMinutes: [600], timeZone: ZONE, actions: ['schedulePost', 'updateScheduledPost'] as ('schedulePost' | 'updateScheduledPost')[] };
    const draftDeps = { store: poster, baseDir, now: () => time, newId: () => 'unused', maxSchedules: 200, autonomy: limiter,
        env: { profileExists: () => true, fileExists: fs.existsSync, fileSize: (file: string) => fs.statSync(file).size } };
    const bound: PageOperationRequest = { db, dbPath: ':memory:', workspaceId: 'workspace', assertCurrent() {}, now: () => time, clock, protectedWritesEnabled: () => master,
        work: { draft: draftDeps, media: { resolve: () => [] } } as any, approval: {} as any, waitForEvent: async () => undefined, notify() {} };
    const methods = createPageOperationMethods({ bindRequest: () => bound });
    const ownerCtx = { principal: { kind: 'legacy' as const, keyId: owner.id }, assertCurrent() {} };
    const run = (name: string, params: Record<string, unknown>): Promise<any> => methods.find((m) => m.name === name)!.run(params, ownerCtx);
    const page = () => ({ url: () => 'https://www.facebook.com/', content: async () => {
        const actor = { id: '99999', is_profile_plus: true, delegate_page_id: '12345' };
        const data = { viewer: { actor }, user: { id: '99999', delegate_page: { id: '12345', name: 'Page', viewer: { actor } } } };
        return '<script type="application/json">' + JSON.stringify({ define: [['CurrentUserInitialData', [], { USER_ID: '99999' }]],
            require: [['RelayPrefetchedStreamCache', 'next', [], [null, { __bbox: { result: { data } } }]]] }) + '</script>';
    } } as any);
    /** Proposal -> owner start -> linked draft scheduled for 10:00 through the owner key. */
    const startCampaign = async (beforeSchedule?: () => void) => {
        limiter.setPolicy({ enabled: true }, 'test');
        const saved = campaigns.saveProposal(scope, lease, { name: 'Pilot', goal: 'Engagement', policy }, null, T0);
        const { campaignId, grantId } = await run('pageCampaigns.start', { proposalId: saved.id, expectedRevision: saved.revision });
        const row = saveDraft({ ...draftDeps, newId: () => 'draft' }, { params: { mode: 'page', text: 'Original', variants: ['Second'], comment: 'Xem them', mediaPaths: [],
            profiles: [{ profileId: 'profile', targets: ['https://www.facebook.com/'] }] }, campaignId });
        works.linkResource(work.id, { kind: 'draft', id: row.id });
        beforeSchedule?.();
        await run('pageCampaigns.schedule', { ...lease, input: { draftId: row.id, expectedDraftRevision: row.revision, campaignId, grantId, expectedGrantRevision: 1, runAt: T0 + 2 * MIN, variant: 'B', factIds: [] } });
        return { campaignId, grantId };
    };
    const guard = (campaignId: string) => {
        time = T0 + 2 * MIN;
        const stored = poster.getSchedule('draft')!;
        const payload = { ...stored.params, mediaPaths: resolveScheduleMedia(baseDir, stored.id, (stored.params.mediaPaths ?? []) as string[]), kind: 'post', campaignId } as any;
        if (!poster.getRun('run')) poster.createRun({ id: 'run', kind: 'post', mode: 'page', params: payload, startedAt: time, scheduleId: 'draft', campaignId });
        return createPageCampaignExecutionGuard({ db, clock, baseDir, workspaceId: 'workspace', profileExists: () => true, assertCurrent() {}, now: () => time,
            protectedWritesEnabled: () => master, payload }, 'draft', 'run');
    };
    const used = (action: string) => db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM autonomy_actions WHERE action = ? AND status = 'used'", [action])!.n;
    return { db, poster, limiter, ops, events, executions, campaigns, activeRuns, cancelled, draftDeps, startCampaign, guard, page, used, run,
        advance: (ms: number) => { time += ms; }, setTime: (ms: number) => { time = ms; }, now: () => time };
}

test('ownerCampaignEndToEnd', async () => {
    const w = world();
    const { campaignId } = await w.startCampaign();
    expect(w.executions.get('draft')!.status).toBe('reserved');
    const guard = w.guard(campaignId);
    await guard.beforeEffect(w.page(), 'publish');
    expect(w.executions.get('draft')!.status).toBe('submitting');
    expect(w.used('page_post')).toBe(1);
    // The first comment lands 12 minutes after the slot: outside the publish window, not counted again.
    w.advance(12 * MIN);
    await guard.beforeEffect(w.page(), 'firstComment');
    expect(w.used('page_post')).toBe(1);
    guard.settle('posted', null);
    expect(w.executions.get('draft')!.status).toBe('posted');
    // The report shows one Page post for the period.
    const period = { key: '2026-11-03', label: '03/11', from: T0 - 60 * MIN, to: T0 + DAY };
    const report = buildMetricsReport(w.poster, period, 'daily', () => 'Page', (from, to) => w.limiter.summary(from, to));
    expect(report.autonomy).toMatchObject({ pagePosts: 1, groupPosts: 0, leadReplies: 0, videos: 0 });
    // A second publish of the same day is refused by the per-page cap rather than silently allowed.
    expect(() => w.limiter.check({ action: 'page_post', origin: 'api', profileId: 'profile' })).toThrow(expect.objectContaining({ code: 'LIMIT_REACHED', details: expect.objectContaining({ reason: 'quota' }) }));
});

test('campaignDueClearsOnceNextPostReserved', async () => {
    const w = world();
    expect(w.ops.status().due.campaignSchedules).toBe(0);
    // Started by the owner key with quota left and nothing reserved: the bot should schedule the next post.
    const dueBefore: number[] = [];
    const { campaignId } = await w.startCampaign(() => { dueBefore.push(w.ops.status().due.campaignSchedules); });
    expect(dueBefore).toEqual([1]);
    // The next post is reserved: the app runs it itself, nothing is due for the bot.
    expect(w.executions.get('draft')!.status).toBe('reserved');
    expect(w.ops.status().due.campaignSchedules).toBe(0);
    // Once that post is published and quota remains, the campaign is due again.
    const guard = w.guard(campaignId);
    await guard.beforeEffect(w.page(), 'publish');
    guard.settle('posted', null);
    expect(w.ops.status().due.campaignSchedules).toBe(1);
    // After the grant window ends nothing is due.
    w.setTime(T0 + 8 * DAY);
    expect(w.ops.status().due.campaignSchedules).toBe(0);
});

test('emergencyStopMidRun', async () => {
    const w = world();
    await w.startCampaign();
    // The bot approves a group draft (api schedule) and has one api run in flight next to an operator run.
    const group = saveDraft({ ...w.draftDeps, newId: () => 'group' }, { params: { mode: 'group', text: 'Tuyen Sale', profiles: [{ profileId: 'profile', targets: ['https://www.facebook.com/groups/111111111', 'https://www.facebook.com/groups/222222222'] }] } });
    approveDraft(w.draftDeps, { id: group.id, when: 'now' }, 'api');
    expect(w.poster.getSchedule('group')).toMatchObject({ origin: 'api', enabled: true });
    w.activeRuns.push({ id: 'api-run', origin: 'api' }, { id: 'app-run', origin: 'app' });
    const budget = createAutonomyBudget(w.limiter, { profileId: 'profile', mode: 'group', runId: 'api-run' });
    const first = budget.reserve('https://www.facebook.com/groups/111111111'); budget.commit(first);
    w.events.length = 0;

    expect(w.ops.stop('app')).toEqual({ enabled: false, cancelledRuns: 1, disabledSchedules: 2 });
    expect(w.cancelled).toEqual(['api-run']);
    expect(w.poster.getSchedule('group')).toMatchObject({ enabled: false, nextRunAt: null });
    expect(w.executions.get('draft')!.status).toBe('cancelled');
    expect(w.events.map((e) => e.type)).toEqual(['autonomy.changed', 'autonomy.stopped']);
    // The run stops after the destination it was on: the next one is refused at the budget.
    expect(() => budget.check('https://www.facebook.com/groups/222222222')).toThrow(expect.objectContaining({ code: 'LIMIT_REACHED', details: expect.objectContaining({ reason: 'stopped' }) }));
    expect(w.used('group_post')).toBe(1);
});

test('checkpointPausesThenResume', async () => {
    const w = world();
    const { campaignId } = await w.startCampaign();
    expect(w.ops.pauseOnLoginProblem({ profileId: 'profile', profileName: 'P', state: 'checkpoint' })).toBe(true);
    expect(w.ops.pauseOnLoginProblem({ profileId: 'profile', profileName: 'P', state: 'checkpoint' })).toBe(false);
    expect(w.events.filter((e) => e.type === 'autonomy.paused')).toEqual([{ type: 'autonomy.paused', payload: expect.objectContaining({ profileId: 'profile', reason: 'checkpoint' }) }]);
    await expect(w.guard(campaignId).beforeEffect(w.page(), 'publish')).rejects.toMatchObject({ code: 'LIMIT_REACHED', details: { reason: 'profile_paused' } });
    expect(w.executions.get('draft')!.status).toBe('reserved');
    expect(w.used('page_post')).toBe(0);
    // The operator's own action on that profile is never limited.
    expect(() => w.limiter.check({ action: 'page_post', origin: 'app', profileId: 'profile' })).not.toThrow();
    expect(w.ops.status().pausedProfiles).toHaveLength(1);
    expect(w.ops.resumeProfile('profile', 'app')).toEqual({ resumed: true });
    await w.guard(campaignId).beforeEffect(w.page(), 'publish');
    expect(w.executions.get('draft')!.status).toBe('submitting');
    expect(w.used('page_post')).toBe(1);
});

test('leadReplyAndVideoShareDailyLedger', async () => {
    const w = world();
    w.limiter.setPolicy({ enabled: true, leadRepliesPerDay: 1, videosPerDay: 2 }, 'test');
    let seq = 0;
    const seedLead = () => {
        seq += 1;
        w.db.run("INSERT INTO fb_poster_runs (id, kind, mode, params_json, status, started_at) VALUES (?, 'post', 'group', ?, 'done', 1)", [`r${seq}`, JSON.stringify({ kind: 'post', text: 'Bai goc' })]);
        const resultId = w.db.runInsert("INSERT INTO fb_poster_results (run_id, profile_id, profile_name, target_url, outcome, post_url, created_at) VALUES (?, 'profile', 'P', 'https://www.facebook.com/groups/g1/', 'posted', 'https://www.facebook.com/groups/g1/posts/1', 1)", [`r${seq}`]);
        return w.db.runInsert(`INSERT INTO fb_poster_leads (comment_key, post_url, result_id, variant, profile_id, author_id, author_name, text, detected_at, updated_at)
            VALUES (?, 'https://www.facebook.com/groups/g1/posts/1', ?, '', 'profile', ?, 'Khach', 'gia bao nhieu', 1, 1)`, [`k${seq}`, resultId, `a${seq}`]);
    };
    const replier = new LeadReplier({ store: w.poster, limiter: w.limiter, now: w.now, emit: () => {},
        openSession: async () => ({ page: {} as any, close: async () => {} }), postComment: async () => ({ status: 'posted', reason: '' }) });
    replier.enqueue({ leadId: seedLead(), text: 'Chao anh' });
    await replier.whenIdle();
    const midnight = w.now() + (1440 - clock.minutes(w.now())) * MIN;
    // The per-profile reply cap is reached; the retry hint is the next local midnight.
    expect(() => replier.enqueue({ leadId: seedLead(), text: 'Chao chi' })).toThrow(expect.objectContaining({ code: 'LIMIT_REACHED', details: { reason: 'quota', retryAt: midnight } }));
    // The same ledger carries videos: the operator's video takes the last slot the bot cannot use.
    expect(w.limiter.reserve({ action: 'video', origin: 'api' })).not.toBeNull();
    expect(() => w.limiter.check({ action: 'video', origin: 'api' })).toThrow(expect.objectContaining({ code: 'LIMIT_REACHED' }));
    expect(w.limiter.reserve({ action: 'video', origin: 'app' })).not.toBeNull();
    const status = w.ops.status();
    expect(status.usage.profiles.profile).toMatchObject({ leadReplies: 1, facebookActions: 1 });
    expect(status.usage.workspace.videos).toBe(2);
    expect(status.remaining.videos).toBe(0);
    // A new local day reopens everything.
    w.setTime(midnight + 8 * 60 * MIN); // 08:00, after quiet hours
    expect(() => w.limiter.check({ action: 'lead_reply', origin: 'api', profileId: 'profile' })).not.toThrow();
    expect(w.ops.status().usage.workspace.videos).toBe(0);
});
