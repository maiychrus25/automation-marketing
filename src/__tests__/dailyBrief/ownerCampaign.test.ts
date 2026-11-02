import fs from 'fs';
import os from 'os';
import path from 'path';
import { memoryDb } from '../facebookPoster/helpers';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { DailyBriefStore } from '../../services/dailyBrief/DailyBriefStore';
import { PageBusinessStore } from '../../services/dailyBrief/PageBusinessStore';
import { PageWorkStore } from '../../services/dailyBrief/PageWorkStore';
import { PageCampaignStore } from '../../services/dailyBrief/PageCampaignStore';
import { PageCampaignExecutionStore } from '../../services/dailyBrief/PageCampaignExecutionStore';
import { createPageCampaignOperations } from '../../services/dailyBrief/pageCampaignOperations';
import { createPageCampaignExecutionGuard } from '../../services/dailyBrief/pageCampaignExecution';
import { ControlStore, CONTROL_SCHEMA_SQL } from '../../services/control/ControlStore';
import { createPageOperationMethods, type PageOperationRequest } from '../../services/control/pageOperationMethods';
import { cancelOwnerCampaignSchedules } from '../../services/control/ownerPageRunner';
import { AutonomyLimiter } from '../../services/autonomy/AutonomyLimiter';
import { cancelApiWork } from '../../services/autonomy/cancelApiWork';
import { saveDraft } from '../../services/facebookPoster/drafts';
import { resolveScheduleMedia } from '../../services/facebookPoster/scheduleMedia';

const now = Date.parse('2026-10-28T10:00:00Z');
const DAY = 86_400_000;
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dirs: string[] = [];
afterAll(() => dirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

function setup() {
    const db = memoryDb(); db.exec(CONTROL_SCHEMA_SQL);
    db.exec('CREATE TABLE browser_profiles (id TEXT PRIMARY KEY)'); db.run("INSERT INTO browser_profiles (id) VALUES ('profile')");
    const clock = { date: (n: number) => new Date(n).toISOString().slice(0, 10), minutes: () => 600 };
    const scope = { workspaceId: 'workspace', pageId: '12345', profileId: 'profile' };
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-campaign-')); dirs.push(baseDir);
    const poster = new FacebookPosterStore(db); poster.ensureSchema();
    const works = new PageWorkStore(db, clock); works.ensureSchema();
    const campaigns = new PageCampaignStore(db); campaigns.ensureSchema();
    const briefs = new DailyBriefStore(db, clock); briefs.ensureSchema(); briefs.saveBrief('profile', { time: '10:00', draftsPerDay: 2 }, now);
    briefs.upsertIdentity({ ...scope, kind: 'page', pageName: 'Page', category: '', about: '', recentPosts: [], learnedAt: now, errorCode: '', error: '' });
    const business = new PageBusinessStore(db); business.ensure('12345', 'profile', now);
    business.setEnabled('12345', true, 0, { confirmedAt: now, confirmationRef: 'owner' });
    const work = works.claimDue({ ...scope, dbPath: ':memory:' }, now)!;
    const lease = { workId: work.id, claimedAt: work.claimedAt! };
    const executions = new PageCampaignExecutionStore(db, clock); executions.ensureSchema();
    const control = new ControlStore(db);
    const owner = control.createKey('Owner');
    let time = now; let gate = true;
    const limiter = new AutonomyLimiter(db, { now: () => time, clock, protectedWritesEnabled: () => gate }); limiter.ensureSchema();
    const basePolicy = { startsAt: now, expiresAt: now + 7 * DAY, maxPostsPerDay: 1, maxPostsTotal: 7, allowedMinutes: [600], timeZone, actions: ['schedulePost', 'updateScheduledPost'] as ('schedulePost' | 'updateScheduledPost')[] };
    let proposalRevision: number | null = null;
    const propose = (policy: Partial<typeof basePolicy> = {}) => {
        const saved = campaigns.saveProposal(scope, lease, { name: 'Pilot', goal: 'Engagement', policy: { ...basePolicy, ...policy } }, proposalRevision, now);
        proposalRevision = saved.revision; return saved;
    };
    const draftDeps = { baseDir, now: () => time, newId: () => 'unused', maxSchedules: 200,
        env: { profileExists: () => true, fileExists: fs.existsSync, fileSize: (file: string) => fs.statSync(file).size } };
    const bound: PageOperationRequest = { db, dbPath: ':memory:', workspaceId: 'workspace', assertCurrent() {}, now: () => time, clock,
        protectedWritesEnabled: () => gate, work: { draft: draftDeps, media: { resolve: () => [] } } as any, approval: {} as any,
        waitForEvent: async () => undefined, notify() {} };
    const methods = createPageOperationMethods({ bindRequest: () => bound });
    const ownerCtx = { principal: { kind: 'legacy' as const, keyId: owner.id }, assertCurrent() {} };
    const run = (name: string, params: Record<string, unknown>): Promise<any> => methods.find(m => m.name === name)!.run(params, ownerCtx);
    /** A linked page draft for this work, scheduled through the owner key's runner path. */
    const scheduleDraft = async (campaignId: string, grantId: string) => {
        const row = saveDraft({ ...draftDeps, store: poster, newId: () => 'draft' }, { params: { mode: 'page', text: 'Original', variants: ['Second'], comment: '', mediaPaths: [],
            profiles: [{ profileId: 'profile', targets: ['https://www.facebook.com/'] }] }, campaignId });
        works.linkResource(work.id, { kind: 'draft', id: row.id });
        return run('pageCampaigns.schedule', { ...lease, input: { draftId: row.id, expectedDraftRevision: row.revision, campaignId, grantId, expectedGrantRevision: 1,
            runAt: now + 120000, variant: 'B', factIds: [] } });
    };
    const page = () => ({ url: () => 'https://www.facebook.com/', content: async () => {
        const actor = { id: '99999', is_profile_plus: true, delegate_page_id: '12345' };
        const data = { viewer: { actor }, user: { id: '99999', delegate_page: { id: '12345', name: 'Page', viewer: { actor } } } };
        return '<script type="application/json">' + JSON.stringify({ define: [['CurrentUserInitialData', [], { USER_ID: '99999' }]],
            require: [['RelayPrefetchedStreamCache', 'next', [], [null, { __bbox: { result: { data } } }]]] }) + '</script>';
    } } as any);
    const guard = (campaignId: string) => {
        time = now + 120000;
        const stored = poster.getSchedule('draft')!;
        const payload = { ...stored.params, mediaPaths: resolveScheduleMedia(baseDir, stored.id, (stored.params.mediaPaths ?? []) as string[]), kind: 'post', campaignId } as any;
        if (!poster.getRun('run')) poster.createRun({ id: 'run', kind: 'post', mode: 'page', params: payload, startedAt: time, scheduleId: 'draft', campaignId });
        return createPageCampaignExecutionGuard({ db, clock, baseDir, workspaceId: 'workspace', profileExists: () => true, assertCurrent() {}, now: () => time,
            protectedWritesEnabled: () => gate, payload }, 'draft', 'run');
    };
    const actions = () => db.query<{ action: string; status: string; origin: string; profile_id: string; ref: string; reason: string }>(
        'SELECT action, status, origin, profile_id, ref, reason FROM autonomy_actions ORDER BY id');
    return { db, scope, poster, works, campaigns, executions, control, owner, limiter, lease, work, clock, draftDeps, propose, run, scheduleDraft, page, guard, actions,
        enable: () => limiter.setPolicy({ enabled: true }, 'test'), gateOff: () => { gate = false; }, advance: (ms: number) => { time += ms; } };
}

test('startCreatesCampaignAndGrantFromProposal', async () => {
    const s = setup(); s.enable();
    const proposal = s.propose();
    const result = await s.run('pageCampaigns.start', { proposalId: proposal.id, expectedRevision: 1 });
    expect(result).toEqual({ campaignId: expect.any(String), grantId: expect.any(String) });
    expect(s.campaigns.getGrant(result.grantId)).toMatchObject({ ...s.scope, campaignId: result.campaignId, status: 'active', receiverKeyId: s.owner.id,
        confirmationRef: `owner:${proposal.id}:1`, confirmedAt: now, policy: proposal.input.policy });
    expect(s.campaigns.getLink(result.campaignId)).toMatchObject({ ...s.scope, deletedAt: null, proposalId: proposal.id });
    expect(s.campaigns.getProposal(proposal.id)!.status).toBe('accepted');
    expect(s.control.listEventsAfter(0, 50).map(e => e.type)).toContain('pageCampaigns.grantChanged');
});

test('startRejectsPolicyAboveCaps', async () => {
    const s = setup(); s.enable();
    for (const policy of [{ maxPostsPerDay: 2 }, { maxPostsTotal: 8 }, { expiresAt: now + 8 * DAY }, { allowedMinutes: [21 * 60] }]) {
        const proposal = s.propose(policy);
        await expect(s.run('pageCampaigns.start', { proposalId: proposal.id, expectedRevision: proposal.revision })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        expect(s.campaigns.getProposal(proposal.id)!.status).toBe('pending');
    }
    const fixed = s.propose();
    await expect(s.run('pageCampaigns.start', { proposalId: fixed.id, expectedRevision: fixed.revision })).resolves.toMatchObject({ grantId: expect.any(String) });
});

test('startRequiresMasterAndEnabled', async () => {
    const s = setup(); const proposal = s.propose();
    const start = () => s.run('pageCampaigns.start', { proposalId: proposal.id, expectedRevision: 1 });
    await expect(start()).rejects.toMatchObject({ code: 'LIMIT_REACHED', details: { reason: 'stopped' } });
    s.enable(); s.gateOff();
    await expect(start()).rejects.toMatchObject({ code: 'LIMIT_REACHED', details: { reason: 'master_off' } });
    expect(s.campaigns.list(s.scope)).toEqual([]);
    expect(s.campaigns.getProposal(proposal.id)!.status).toBe('pending');
});

test('startIsIdempotent', async () => {
    const s = setup(); s.enable(); const proposal = s.propose();
    const first = await s.run('pageCampaigns.start', { proposalId: proposal.id, expectedRevision: 1 });
    s.advance(60000);
    const again = await s.run('pageCampaigns.start', { proposalId: proposal.id, expectedRevision: 1 });
    expect(again).toEqual(first);
    expect(s.campaigns.listGrants(first.campaignId)).toHaveLength(1);
    expect(s.campaigns.list(s.scope)).toHaveLength(1);
});

test('stopRevokesGrantsAndCancelsReservedSchedules', async () => {
    const s = setup(); s.enable(); const proposal = s.propose();
    const { campaignId, grantId } = await s.run('pageCampaigns.start', { proposalId: proposal.id, expectedRevision: 1 });
    await expect(s.scheduleDraft(campaignId, grantId)).resolves.toEqual({ scheduleId: 'draft', revision: 1 });
    expect(s.executions.get('draft')!.status).toBe('reserved');
    await expect(s.run('pageCampaigns.stop', { campaignId })).resolves.toEqual({ revokedGrants: 1, cancelledSchedules: 1 });
    expect(s.executions.get('draft')!.status).toBe('cancelled');
    expect(s.poster.getSchedule('draft')).toMatchObject({ enabled: false, nextRunAt: null });
    expect(s.campaigns.getGrant(grantId)!.status).toBe('revoked');
    expect(s.campaigns.getLink(campaignId)).toMatchObject({ deletedAt: null });
    expect(s.control.listEventsAfter(0, 50).filter(e => e.type === 'pageCampaigns.scheduleChanged').map(e => e.payload))
        .toContainEqual(expect.objectContaining({ campaignId, scheduleId: 'draft', status: 'cancelled' }));
    await expect(s.run('pageCampaigns.stop', { campaignId })).resolves.toEqual({ revokedGrants: 0, cancelledSchedules: 0 });
    await expect(s.run('pageCampaigns.stop', { campaignId: 'missing' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('ownerGrantPublishReservesPagePostAndRespectsQuietHours', async () => {
    const s = setup(); s.enable(); const proposal = s.propose();
    const { campaignId, grantId } = await s.run('pageCampaigns.start', { proposalId: proposal.id, expectedRevision: 1 });
    await s.scheduleDraft(campaignId, grantId);
    s.limiter.setPolicy({ quietStart: '10:00', quietEnd: '11:00' }, 'test');
    await expect(s.guard(campaignId).beforeEffect(s.page(), 'publish')).rejects.toMatchObject({ code: 'LIMIT_REACHED', details: { reason: 'quiet_hours' } });
    expect(s.executions.get('draft')!.status).toBe('reserved');
    expect(s.actions().filter(a => a.status !== 'blocked')).toEqual([]);
    s.limiter.setPolicy({ quietStart: '22:00', quietEnd: '07:00' }, 'test');
    await s.guard(campaignId).beforeEffect(s.page(), 'publish');
    expect(s.executions.get('draft')!.status).toBe('submitting');
    expect(s.actions().filter(a => a.status !== 'blocked')).toEqual([{ action: 'page_post', status: 'used', origin: 'api', profile_id: 'profile', ref: 'draft', reason: '' }]);
});

test('emergencyStopCancelsOwnerReservedExecutions', async () => {
    const s = setup(); s.enable(); const proposal = s.propose();
    const { campaignId, grantId } = await s.run('pageCampaigns.start', { proposalId: proposal.id, expectedRevision: 1 });
    await s.scheduleDraft(campaignId, grantId);
    const result = cancelApiWork({ store: s.poster, activeRuns: () => [], cancelRun: () => false, now: () => now,
        cancelOwnerCampaignSchedules: () => cancelOwnerCampaignSchedules(s.db, now, s.clock) });
    expect(result).toEqual({ cancelledRuns: 0, disabledSchedules: 1 });
    expect(s.executions.get('draft')!.status).toBe('cancelled');
    expect(s.poster.getSchedule('draft')!.enabled).toBe(false);
    expect(s.campaigns.getGrant(grantId)!.status).toBe('active');
});

test('scopedGrantCampaignIgnoresAutonomyPolicy', async () => {
    const s = setup();
    const assignments = [{ pageId: '12345', profileIds: ['profile'] }];
    const runner = s.control.createKey('Runner', { kind: 'page_runner', workspaceId: 'workspace', assignments });
    const receiver = s.control.createKey('Receiver', { kind: 'page_receiver', workspaceId: 'workspace', assignments, ownerChatId: '1', ownerSenderId: '2' });
    const proposal = s.propose();
    const { campaignId, grantId } = s.campaigns.acceptProposal(s.scope, proposal.id, 1, { receiverKeyId: receiver.id, confirmedAt: now, confirmationRef: 'telegram:1:2:3:4' }, now);
    const row = saveDraft({ ...s.draftDeps, store: s.poster, newId: () => 'draft' }, { params: { mode: 'page', text: 'Original', variants: ['Second'], comment: '', mediaPaths: [],
        profiles: [{ profileId: 'profile', targets: ['https://www.facebook.com/'] }] }, campaignId });
    s.works.linkResource(s.work.id, { kind: 'draft', id: row.id });
    await createPageCampaignOperations({ db: s.db, clock: s.clock, principal: { kind: 'page_runner', keyId: runner.id, workspaceId: 'workspace', assignments },
        context: () => ({ ...s.scope, dbPath: ':memory:' }), now: () => now, assertCurrent() {}, protectedWritesEnabled: () => true,
        draft: s.draftDeps, media: { resolve: () => [] } })
        .schedule(s.lease, { draftId: row.id, expectedDraftRevision: row.revision, campaignId, grantId, expectedGrantRevision: 1, runAt: now + 120000, variant: 'B', factIds: [] });
    // Autonomy off and inside quiet hours: neither applies to a receiver-confirmed grant.
    s.limiter.setPolicy({ quietStart: '10:00', quietEnd: '11:00' }, 'test');
    expect(cancelOwnerCampaignSchedules(s.db, now, s.clock)).toBe(0);
    expect(s.executions.get('draft')!.status).toBe('reserved');
    await s.guard(campaignId).beforeEffect(s.page(), 'publish');
    expect(s.executions.get('draft')!.status).toBe('submitting');
    expect(s.actions()).toEqual([]);
});
