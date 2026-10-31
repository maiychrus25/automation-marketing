import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { Readable } from 'stream';
import { memoryDb } from '../facebookPoster/helpers';
import { DailyBriefStore } from '../../services/dailyBrief/DailyBriefStore';
import { PageBusinessStore } from '../../services/dailyBrief/PageBusinessStore';
import { PageWorkStore } from '../../services/dailyBrief/PageWorkStore';
import { PageCampaignStore } from '../../services/dailyBrief/PageCampaignStore';
import { FacebookPosterStore, type SqlDatabase } from '../../services/facebookPoster/FacebookPosterStore';
import { InboxMediaStore } from '../../services/control/InboxMediaStore';
import { createPageWorkOperations, assertPagePreparationIdle } from '../../services/dailyBrief/pageWorkOperations';
import { getDraft, saveDraft } from '../../services/facebookPoster/drafts';
import { ResearchService } from '../../services/research/ResearchService';
import { ResearchStore } from '../../services/research/ResearchStore';
import { createVideoOperations } from '../../services/video/videoOperations';
import type { VideoJob } from '../../models/video';

const dirs: string[] = [];
const now = Date.parse('2026-10-28T10:00:00Z');
const clock = { date: (n: number) => new Date(n).toISOString().slice(0, 10), minutes: () => 600 };
const context = { workspaceId: 'workspace', dbPath: 'test', pageId: 'page', profileId: 'profile' };
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-work-')); dirs.push(dir); return dir; };
afterAll(() => dirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
function openDisk(file: string) {
    const raw = new Database(file);
    const db: SqlDatabase = { exec: sql => { raw.exec(sql); }, run: (sql, p = []) => { raw.prepare(sql).run(...p); },
        runInsert: (sql, p = []) => Number(raw.prepare(sql).run(...p).lastInsertRowid), transaction: fn => raw.transaction(fn)(),
        query: (sql, p = []) => raw.prepare(sql).all(...p) as any, queryOne: (sql, p = []) => raw.prepare(sql).get(...p) as any };
    return { raw, db };
}

function setup(db = memoryDb(), baseDir = temp(), initialize = true) {
    const briefs = new DailyBriefStore(db, clock);
    const workStore = new PageWorkStore(db, clock);
    const poster = new FacebookPosterStore(db);
    if (initialize) {
        workStore.ensureSchema(); poster.ensureSchema();
        briefs.saveBrief('profile', { time: '07:00', draftsPerDay: 2 }, now);
        const business = new PageBusinessStore(db);
        business.ensure('page', 'profile', now);
        business.setEnabled('page', true, 0, { confirmedAt: now, confirmationRef: 'owner' });
    }
    const work = workStore.list(['page'])[0] ?? workStore.claimDue(context, now)!;
    const lease = { workId: work.id, claimedAt: work.claimedAt! };
    let time = now;
    let active = true;
    const inbox = new InboxMediaStore(path.join(baseDir, 'inbox'));
    const draftDeps = { store: poster, baseDir, now: () => time, newId: () => 'unused', maxSchedules: 200,
        env: { profileExists: () => true, fileExists: fs.existsSync, fileSize: (p: string) => fs.statSync(p).size } };
    const actor = jest.fn(async () => undefined);
    const videoJob: VideoJob = { id: 'video', status: 'done', remoteId: 'requested', name: 'Requested video', source: 'app',
        engine: 'ahv_ad', templateId: null, aspect: '', specJson: '', progress: 100, error: '', stepText: '', resultJson: '',
        filePath: null, thumbPath: null, sizeBytes: 5, durationSec: null, createdAt: now, finishedAt: now };
    const video = { status: jest.fn(() => ({ video: videoJob })),
        openFile: jest.fn(async () => ({ stream: Readable.from(['VIDEO']), size: 5 })) };
    const deps = { db, context: () => context, assertCurrent: () => { if (!active) throw new Error('stale'); },
        assertActor: actor, now: () => time, clock, draft: draftDeps, media: inbox, video,
        research: undefined as any, researchStore: undefined as any };
    const ops = createPageWorkOperations(deps);
    return { db, baseDir, workStore, poster, work, lease, inbox, draftDeps, actor, video, deps, ops,
        advance: (n: number) => { time += n; }, revoke: () => { active = false; } };
}

function researchSetup(options: { due?: boolean; wrongActor?: boolean } = {}) {
    const s = setup();
    const researchStore = new ResearchStore(s.db);
    researchStore.ensureSchema();
    const close = jest.fn(async () => undefined);
    const query = jest.fn(async () => ({ friendlyName: 'SearchCometResultsPaginatedResultsQuery', docId: 'd', variables: { args: { text: 'x', filters: [] } } }));
    const open = jest.fn(async () => {
        expect(research.isRunning()).toBe(true);
        expect(s.db.query<any>("SELECT * FROM page_work_resources WHERE resource_kind='research'")).toHaveLength(1);
        return { session: { open: async () => undefined, ensureQuery: query,
            call: async () => JSON.stringify({ data: { serpResponse: { results: { edges: [], page_info: { has_next_page: false, end_cursor: null } } } } }) } as any,
            readIdentity: async () => ({ kind: 'page', pageId: options.wrongActor ? 'other' : 'page' }), close };
    });
    const research = new ResearchService({ store: researchStore, shouldYield: () => !!options.due,
        openSession: open, listProfiles: () => [{ id: 'profile', name: 'profile' }], isProfileBusy: () => false,
        loginStates: () => [], groupMembership: () => ({}), observeLogin: () => undefined,
        readConfig: () => ({ excludedProfileIds: [], perProfileDailyCap: 100 }), emit: () => undefined,
        now: () => now, sleep: async () => undefined });
    const ops = createPageWorkOperations({ ...s.deps, research, researchStore });
    return { ...s, ops, research, researchStore, close, open, query, held: () => research.isRunning() };
}

it.each(['success', 'error', 'revoke'])('readinessTracksActorAwaitAcrossInstancesAndClearsAfter %s', async outcome => {
    const s = setup(); let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    s.actor.mockImplementation(async () => {await gate; if (outcome === 'error') throw new Error('actor failed');});
    const other = createPageWorkOperations(s.deps);
    const running = other.saveDraft(s.lease, 0, {text:'Ready'}).then(value => ({value}), error => ({error}));
    const before = s.workStore.get(s.work.id);
    try {
        expect(() => assertPagePreparationIdle(s.db, s.work.id)).toThrow(expect.objectContaining({code:'CONFLICT'}));
        expect(s.workStore.get(s.work.id)).toEqual(before);
        const separate = setup();
        expect(() => assertPagePreparationIdle(separate.db, s.work.id)).not.toThrow();
        if (outcome === 'revoke') s.revoke();
    } finally { release(); }
    const result = await running;
    expect(result).toHaveProperty(outcome === 'success' ? 'value' : 'error');
    expect(() => assertPagePreparationIdle(s.db, s.work.id)).not.toThrow();
});
it('oneActorCompletionCannotClearAnotherActiveAttempt', async () => {
    const s = setup(); let first!: () => void; let second!: () => void;
    s.actor.mockImplementationOnce(() => new Promise<void>(resolve => {first = resolve;}))
        .mockImplementationOnce(() => new Promise<void>(resolve => {second = resolve;}));
    const one = s.ops.saveDraft(s.lease, 0, {text:'One'});
    const two = createPageWorkOperations(s.deps).saveDraft(s.lease, 1, {text:'Two'});
    first(); await one;
    try { expect(() => assertPagePreparationIdle(s.db, s.work.id)).toThrow(expect.objectContaining({code:'CONFLICT'})); }
    finally {second(); await two;}
    expect(() => assertPagePreparationIdle(s.db, s.work.id)).not.toThrow();
});
it.each(['success', 'error', 'revoke'])('readinessTracksOwnedResearchDrainAndClearsAfter %s', async outcome => {
    const s = researchSetup(); let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const reached = new Promise<void>(resolve => {entered = resolve;});
    s.query.mockImplementation(async () => {entered(); await gate; if (outcome === 'error') throw new Error('query failed');
        return {friendlyName:'SearchCometResultsPaginatedResultsQuery', docId:'d', variables:{args:{text:'x', filters:[]}}};});
    const running = createPageWorkOperations({...s.deps, research:s.research, researchStore:s.researchStore})
        .research(s.lease, {kind:'search', keywords:['test']}).then(value => ({value}), error => ({error}));
    await reached;
    try {
        const before = s.workStore.get(s.work.id);
        expect(() => assertPagePreparationIdle(s.db, s.work.id)).toThrow(expect.objectContaining({code:'CONFLICT'}));
        expect(s.workStore.get(s.work.id)).toEqual(before);
        if (outcome === 'revoke') s.revoke();
    } finally {release(); await running;}
    expect(() => assertPagePreparationIdle(s.db, s.work.id)).not.toThrow();
    expect(s.held()).toBe(false);
});

it('campaignCanSpanWorkButDraftCannot', async () => {
    const s=setup(); const campaigns=new PageCampaignStore(s.db); campaigns.ensureSchema();
    const proposal=campaigns.saveProposal(context,s.lease,{name:'Managed',goal:'Engagement',policy:{startsAt:now,expiresAt:now+7*86400000,
        maxPostsPerDay:1,maxPostsTotal:7,allowedMinutes:[600],timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,actions:['schedulePost']}},null,now);
    const {campaignId}=campaigns.acceptProposal(context,proposal.id,1,{receiverKeyId:'receiver',confirmedAt:now,confirmationRef:'owner'},now);
    const oldDraft=await s.ops.saveDraft(s.lease,0,{text:'Old work',campaignId});
    const before=s.poster.getSchedule(oldDraft.draftId);
    s.workStore.stopPreparation(s.work.id,'cancelled',now);
    s.advance(86400000);
    const next=s.workStore.claimDue(context,now+86400000)!;
    const lease={workId:next.id,claimedAt:next.claimedAt!};
    const saved=await s.ops.saveDraft(lease,0,{text:'Next work',campaignId});
    expect(s.ops.getDraft(next.id,saved.draftId)).toMatchObject({campaignId});
    await expect(s.ops.saveDraft(lease,0,{id:oldDraft.draftId,expectedRevision:oldDraft.revision,text:'Stolen',campaignId})).rejects.toThrow();
    expect(s.poster.getSchedule(oldDraft.draftId)).toEqual(before);
    expect(s.workStore.getResourceOwner({kind:'draft',id:oldDraft.draftId})?.workId).toBe(s.work.id);
    expect(s.workStore.getResourceOwner({kind:'campaign',id:campaignId})).toBeNull();
});

it('variantsRoundTripAndRejectPublicContentRevision', async () => {
    const s = setup();
    const saved = await s.ops.saveDraft(s.lease, 0, {text:'First', variants:['Second', 'Third']} as any);
    expect(s.ops.getDraft(s.work.id, saved.draftId)).toMatchObject({text:'First', variants:['Second', 'Third']});
    await expect(s.ops.saveDraft(s.lease, 1, {text:'Forged', contentRevision:'fake'} as any)).rejects.toMatchObject({code:'INVALID_PARAMS'});
    await expect(s.ops.saveDraft(s.lease, 1, {text:'First', variants:['First']} as any)).rejects.toThrow();
});

it('researchRetainsLocalAdmissionAndClosesItsSession', async () => {
    const s = researchSetup();
    const result = await s.ops.research(s.lease, { kind: 'search', keywords: ['test'] });
    expect(s.researchStore.getScan(result.scanId)?.status).toBe('done');
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(s.close).toHaveBeenCalledTimes(1);
    expect(s.held()).toBe(false);
    expect(await s.ops.research(s.lease, { kind: 'search', keywords: ['test'] })).toEqual(result);
    expect(s.open).toHaveBeenCalledTimes(1);
});

it('dueScheduleWinsBeforeResearchStarts', async () => {
    const s = researchSetup({ due: true });
    await expect(s.ops.research(s.lease, { kind: 'search', keywords: ['test'] })).rejects.toThrow();
    expect(s.researchStore.countScans()).toBe(0);
    expect(s.open).not.toHaveBeenCalled();
    expect(s.workStore.getStep(s.work.id, 'research')).toBeNull();
});

it('changedActorStopsBeforeBrowserActionInResearch', async () => {
    const s = researchSetup({ wrongActor: true });
    await expect(s.ops.research(s.lease, { kind: 'search', keywords: ['test'] })).rejects.toThrow();
    expect(s.query).not.toHaveBeenCalled();
    expect(s.workStore.get(s.work.id)!.status).toBe('needs_review');
    expect(s.held()).toBe(false);
});

it('researchLinkFailureRollsBackRealScanAndDrainsReservation', async () => {
    const s = researchSetup();
    s.db.exec(`CREATE TRIGGER fail_research BEFORE INSERT ON page_work_resources BEGIN SELECT RAISE(ABORT, 'link failed'); END`);
    await expect(s.ops.research(s.lease, { kind: 'search', keywords: ['test'] })).rejects.toMatchObject({ message: 'link failed', code: 'SQLITE_CONSTRAINT_TRIGGER' });
    expect(s.researchStore.countScans()).toBe(0);
    expect(s.workStore.getStep(s.work.id, 'research')).toBeNull();
    expect(s.held()).toBe(false);
    expect(s.open).not.toHaveBeenCalled();
});

it('unrelatedMediaDoesNotSuppressSafeVideoAdoption', async () => {
    const s = setup();
    const image = await s.inbox.save('old.jpg', 'image/jpeg', Readable.from(['IMAGE']));
    s.workStore.linkResource(s.work.id, { kind: 'media', id: image.mediaId });
    const file = path.join(s.baseDir, 'source.mp4'); fs.writeFileSync(file, 'VIDEO');
    const render = jest.fn();
    const actualVideo = createVideoOperations({ service: () => ({ get: () => ({ id: 'video', status: 'done', filePath: file }), render }) } as any);
    const ops = createPageWorkOperations({ ...s.deps, video: actualVideo });
    await ops.attachVideo(s.work.id, 'video');
    await ops.reconcile(s.work.id);
    const rows = s.db.query<any>("SELECT resource_id FROM page_work_resources WHERE resource_kind='media' AND resource_id != ?", [image.mediaId]);
    expect(rows).toHaveLength(1);
    expect(fs.readFileSync(s.inbox.resolve([rows[0].resource_id])[0], 'utf8')).toBe('VIDEO');
    expect(render).not.toHaveBeenCalled();
});

it('cancelDuringAdoptDoesNotLinkOrLeakAttemptMedia', async () => {
    const s = setup();
    await s.ops.attachVideo(s.work.id, 'video');
    const original = s.inbox.save.bind(s.inbox);
    jest.spyOn(s.inbox, 'save').mockImplementation(async (...args) => {
        const saved = await original(...args);
        await s.ops.cancelOwned(s.work.id);
        return saved;
    });
    await expect(s.ops.reconcile(s.work.id)).rejects.toThrow();
    expect(s.db.query<any>("SELECT * FROM page_work_resources WHERE resource_kind='media'")).toHaveLength(0);
    expect(fs.readdirSync(path.join(s.baseDir, 'inbox'))).toEqual([]);
});

it('revocationAfterResearchCommitReleasesReservedSlot', async () => {
    const s = researchSetup();
    const ops = createPageWorkOperations({ ...s.deps, research: s.research, researchStore: s.researchStore,
        assertCurrent: () => { if (s.workStore.get(s.work.id)!.researchId) throw new Error('revoked'); } });
    await expect(ops.research(s.lease, { kind: 'search', keywords: ['test'] })).rejects.toThrow('revoked');
    expect(s.open).not.toHaveBeenCalled();
    expect(s.held()).toBe(false);
});

it('longVideoPollingConsumesNoInvocationAndMissingVideoNeedsReview', async () => {
    const s = setup();
    const job = s.video.status().video;
    s.video.status.mockImplementation(() => ({ video: { ...job, status: 'rendering' } }));
    await s.ops.attachVideo(s.work.id, 'video');
    expect((await s.ops.reconcile(s.work.id)).status).toBe('waiting');
    s.advance(25 * 3600000);
    for (let i = 0; i < 20; i++) expect((await s.ops.reconcile(s.work.id)).status).toBe('waiting');
    expect(s.workStore.get(s.work.id)!.attempts).toBe(1);
    expect(s.actor).not.toHaveBeenCalled();
    s.video.status.mockImplementation(() => { throw new Error('missing'); });
    expect((await s.ops.reconcile(s.work.id)).status).toBe('needs_review');
    expect(s.video.openFile).not.toHaveBeenCalled();
});

it('concurrentCreateAndEditsKeepOneWinnerAndDailyBudget', async () => {
    const s = setup();
    const results = await Promise.all([s.ops.saveDraft(s.lease, 0, { text: 'x' }), s.ops.saveDraft(s.lease, 0, { text: 'x' })]);
    expect(results[0]).toEqual(results[1]);
    const edited = await Promise.allSettled([
        s.ops.saveDraft(s.lease, 0, { id: results[0].draftId, expectedRevision: 1, text: 'a' }),
        s.ops.saveDraft(s.lease, 0, { id: results[0].draftId, expectedRevision: 1, text: 'b' }),
    ]);
    expect(edited.filter(v => v.status === 'fulfilled')).toHaveLength(1);
    expect(s.poster.countSchedules()).toBe(1);
    expect(s.db.queryOne<any>('SELECT drafts_created FROM page_work_daily_usage')!.drafts_created).toBe(1);
});

it('differentNullAndOmittedEditFieldsCannotReplaySameRequest', async () => {
    const s = setup();
    const saved = await s.ops.saveDraft(s.lease, 0, { text: 'x', plannedAt: now + 3600000 });
    await s.ops.saveDraft(s.lease, 0, { id: saved.draftId, expectedRevision: 1, text: 'edited' });
    await expect(s.ops.saveDraft(s.lease, 0, { id: saved.draftId, expectedRevision: 1, text: 'edited', plannedAt: null })).rejects.toThrow();
});

it('foreignCampaignInLegacyStoredParamsRejectsBeforeActor', async () => {
    const s = setup();
    const saved = await s.ops.saveDraft(s.lease, 0, { text: 'x' });
    const draft = s.poster.getSchedule(saved.draftId)!;
    s.poster.updateSchedule(draft.id, { params: { ...draft.params, campaignId: 'foreign' } }, now);
    s.actor.mockClear();
    await expect(s.ops.saveDraft(s.lease, 0, { id: draft.id, expectedRevision: 2, text: 'edited' })).rejects.toThrow();
    expect(s.actor).not.toHaveBeenCalled();
});

it('staleAdoptionCleansOnlyOwnFileWithoutReadingSwitchedDatabase', async () => {
    const s = setup();
    const unrelated = await s.inbox.save('keep.jpg', 'image/jpeg', Readable.from(['KEEP']));
    await s.ops.attachVideo(s.work.id, 'video');
    const save = s.inbox.save.bind(s.inbox);
    jest.spyOn(s.inbox, 'save').mockImplementation(async (...args) => {
        const result = await save(...args);
        s.revoke();
        jest.spyOn(s.db, 'queryOne').mockImplementation(() => { throw new Error('read switched database'); });
        return result;
    });
    await expect(s.ops.reconcile(s.work.id)).rejects.toThrow('stale');
    expect(fs.readdirSync(path.join(s.baseDir, 'inbox'))).toHaveLength(1);
    expect(fs.readFileSync(s.inbox.resolve([unrelated.mediaId])[0], 'utf8')).toBe('KEEP');
});

it('staleLegacyRevisionRejectsWithoutPoisoningNewEditStep', async () => {
    const s = setup();
    const saved = await s.ops.saveDraft(s.lease, 0, { text: 'x' });
    const draft = s.poster.getSchedule(saved.draftId)!;
    saveDraft(s.draftDeps, { id: draft.id, params: { ...draft.params, text: 'desktop edit' } });
    await expect(s.ops.saveDraft(s.lease, 0, { id: draft.id, expectedRevision: 1, text: 'stale' })).rejects.toThrow();
    expect(s.workStore.getStep(s.work.id, 'draft:0:revision:2')).toBeNull();
    expect(await s.ops.saveDraft(s.lease, 0, { id: draft.id, expectedRevision: 2, text: 'current' })).toMatchObject({ revision: 3 });
});

it('researchGroupIdsBecomeTrustedFacebookUrls', async () => {
    const s = researchSetup();
    const reserve = jest.spyOn(s.research, 'reserveGroupFeeds');
    await s.ops.research(s.lease, { kind: 'group_feed', groupIds: ['123'] }).catch(() => undefined);
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ groupUrls: ['https://www.facebook.com/groups/123/'] }), expect.any(Object));
});

it('failedMediaJournalReadNeverTriggersAnotherAdoption', async () => {
    const s = setup();
    await s.ops.attachVideo(s.work.id, 'video'); await s.ops.reconcile(s.work.id);
    const query = s.db.query.bind(s.db);
    jest.spyOn(s.db, 'query').mockImplementation((sql, params) => sql.includes('page_work_steps') && sql.includes("resource_kind = 'media'") ? [] : query(sql, params));
    await expect(s.ops.reconcile(s.work.id)).rejects.toThrow();
    expect(s.video.openFile).toHaveBeenCalledTimes(1);
});

it.each([
    ['comment', { comment: 'x'.repeat(8001) }], ['text', { text: 'x'.repeat(63207) }],
    ['name', { name: 'x'.repeat(101) }], ['plannedAt', { plannedAt: now - 1 }],
] as const)('invalidDraftPreflightAllowsCorrectedRetryAtSameIndex %s', async (_field, invalid) => {
    const s = setup();
    const copy = jest.spyOn(fs, 'copyFileSync');
    try {
        await expect(s.ops.saveDraft(s.lease, 0, { text: 'valid', ...invalid })).rejects.toThrow();
        expect(s.workStore.getStep(s.work.id, 'draft:0')).toBeNull();
        expect(s.poster.countSchedules()).toBe(0);
        expect(copy).not.toHaveBeenCalled();
        const saved = await s.ops.saveDraft(s.lease, 0, { text: 'valid', comment: 'corrected' });
        expect(saved.revision).toBe(1);
        expect((await s.ops.reconcile(s.work.id)).status).toBe('running');
    } finally { copy.mockRestore(); }
});

it('validatedDraftSnapshotDoesNotRevalidateTimeAfterIntent', async () => {
    const s = setup();
    s.deps.draft.now = () => s.workStore.getStep(s.work.id, 'draft:0') ? now + 10000 : now;
    expect(await s.ops.saveDraft(s.lease, 0, { text: 'valid', plannedAt: now + 65000 })).toMatchObject({ revision: 1 });
    expect(s.poster.countSchedules()).toBe(1);
});

it('scheduleLimitRejectionDoesNotReserveDraftIndex', async () => {
    const s = setup();
    s.deps.draft.maxSchedules = 0;
    await expect(s.ops.saveDraft(s.lease, 0, { text: 'valid' })).rejects.toThrow();
    expect(s.workStore.getStep(s.work.id, 'draft:0')).toBeNull();
    s.deps.draft.maxSchedules = 200;
    expect(await s.ops.saveDraft(s.lease, 0, { text: 'corrected' })).toMatchObject({ revision: 1 });
});

it('copyFailureKeepsDurableIntentAndNeverRetriesUnknownEffect', async () => {
    const s = setup();
    const saved = await s.inbox.save('image.jpg', 'image/jpeg', Readable.from(['IMAGE']));
    s.workStore.linkResource(s.work.id, { kind: 'media', id: saved.mediaId });
    const input = { text: 'valid', mediaIds: [saved.mediaId] };
    const copy = jest.spyOn(fs, 'copyFileSync').mockImplementation(() => {
        expect(s.workStore.getStep(s.work.id, 'draft:0')?.status).toBe('intent');
        throw new Error('copy interrupted');
    });
    try { await expect(s.ops.saveDraft(s.lease, 0, input)).rejects.toThrow('copy interrupted'); }
    finally { copy.mockRestore(); }
    expect(s.workStore.getStep(s.work.id, 'draft:0')?.status).toBe('intent');
    await expect(s.ops.saveDraft(s.lease, 0, input)).rejects.toMatchObject({ code: 'NEEDS_REVIEW' });
    expect(s.workStore.get(s.work.id)!.status).toBe('needs_review');
    expect(s.poster.countSchedules()).toBe(0);
});

it.each(['open', 'save'])('overlappingIndependentOperationsKeepLiveAdoptionAt %s', async (pauseAt) => {
    const s = setup();
    await s.ops.attachVideo(s.work.id, 'video');
    let release!: () => void; let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const save = s.inbox.save.bind(s.inbox);
    const saveSpy = jest.spyOn(s.inbox, 'save').mockImplementation(async (...args) => {
        if (pauseAt === 'save') { reached(); await gate; }
        return save(...args);
    });
    s.video.openFile.mockImplementation(async () => {
        if (pauseAt === 'open') { reached(); await gate; }
        return { stream: Readable.from(['VIDEO']), size: 5 };
    });
    const ownGuard = jest.fn(() => undefined);
    const second = createPageWorkOperations({ ...s.deps, assertCurrent: ownGuard });
    const first = s.ops.reconcile(s.work.id).then(value => ({ value }), error => ({ error }));
    await entered;
    let duplicate;
    try {
        expect(() => assertPagePreparationIdle(s.db, s.work.id)).toThrow(expect.objectContaining({code:'CONFLICT'}));
        duplicate = await second.reconcile(s.work.id);
    }
    finally { release(); }
    const result = await first;
    saveSpy.mockRestore();
    expect(() => assertPagePreparationIdle(s.db, s.work.id)).not.toThrow();
    expect(duplicate!.status).toBe('running');
    expect(result).toHaveProperty('value.status', 'running');
    expect(ownGuard).toHaveBeenCalled();
    expect(s.workStore.get(s.work.id)!.status).toBe('running');
    expect(s.workStore.getVideoMediaIds(s.work.id, 'video')).toHaveLength(1);
    await second.reconcile(s.work.id);
    expect(s.video.openFile).toHaveBeenCalledTimes(1);
});

it('archivedOwnedCampaignRejectionLeavesIndexAvailable', async () => {
    const s = setup();
    s.poster.createCampaign({ id: 'campaign', name: 'Owned', goal: '', status: 'archived', startAt: null, endAt: null, createdAt: now, updatedAt: now });
    s.workStore.linkResource(s.work.id, { kind: 'campaign', id: 'campaign' });
    await expect(s.ops.saveDraft(s.lease, 0, { text: 'valid', campaignId: 'campaign' })).rejects.toThrow();
    expect(s.workStore.getStep(s.work.id, 'draft:0')).toBeNull();
    expect(await s.ops.saveDraft(s.lease, 0, { text: 'valid', campaignId: null })).toMatchObject({ revision: 1 });
});

it.each(['cancel', 'revoke', 'error'])('sharedAdoptionTrackingClearsAfter %s', async (outcome) => {
    const s = setup();
    await s.ops.attachVideo(s.work.id, 'video');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stream = Readable.from(['VIDEO']);
    s.video.openFile.mockImplementation(async () => {
        await gate;
        if (outcome === 'error') throw new Error('file gone');
        return { stream, size: 5 };
    });
    const first = s.ops.reconcile(s.work.id).then(value => ({ value }), error => ({ error }));
    let readerAllowed = true;
    const ownGuard = jest.fn(() => { if (!readerAllowed) throw new Error('reader revoked'); });
    const second = createPageWorkOperations({ ...s.deps, assertCurrent: ownGuard });
    readerAllowed = false;
    await expect(second.reconcile(s.work.id)).rejects.toThrow('reader revoked');
    expect(s.workStore.getStep(s.work.id, s.workStore.get(s.work.id)!.step!)!.status).toBe('intent');
    readerAllowed = true;
    expect((await second.reconcile(s.work.id)).status).toBe('running');
    if (outcome === 'cancel') await second.cancelOwned(s.work.id);
    if (outcome === 'revoke') s.revoke();
    release();
    const result = await first;
    if (outcome === 'error') expect(result).toHaveProperty('value.status', 'needs_review');
    else expect(result).toHaveProperty('error');
    expect((await second.reconcile(s.work.id)).status).toBe(outcome === 'cancel' ? 'cancelled' : 'needs_review');
    expect(s.workStore.getVideoMediaIds(s.work.id, 'video')).toHaveLength(0);
    expect(s.video.openFile).toHaveBeenCalledTimes(1);
    expect(() => assertPagePreparationIdle(s.db, s.work.id)).not.toThrow();
    if (outcome !== 'error') expect(stream.destroyed).toBe(true);
});

it('liveAdoptionMarkerDoesNotAuthorizeForeignWorkspaceOrCoverAnotherDatabaseIntent', async () => {
    const s = setup(); await s.ops.attachVideo(s.work.id, 'video');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    s.video.openFile.mockImplementation(async () => { await gate; return { stream: Readable.from(['VIDEO']), size: 5 }; });
    const first = s.ops.reconcile(s.work.id);
    try {
        const foreign = createPageWorkOperations({ ...s.deps, context: () => ({ ...context, workspaceId: 'foreign' }) });
        await expect(foreign.reconcile(s.work.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        const other = setup();
        other.db.run('UPDATE page_work_items SET id = ? WHERE id = ?', [s.work.id, other.work.id]);
        await other.ops.attachVideo(s.work.id, 'video');
        other.workStore.beginMediaAdoption(s.work.id, 'video', s.workStore.get(s.work.id)!.step!, now);
        expect((await other.ops.reconcile(s.work.id)).status).toBe('needs_review');
        expect(other.video.openFile).not.toHaveBeenCalled();
        expect(s.workStore.get(s.work.id)!.status).toBe('running');
    } finally { release(); await first; }
    expect(s.workStore.getVideoMediaIds(s.work.id, 'video')).toHaveLength(1);
});

it('foreignNestedIdsRejectWithoutSaving', async () => {
    const s = setup();
    for (const input of [{ text: 'x', campaignId: 'foreign' }, { text: 'x', mediaIds: ['foreign'] },
        { text: 'x', id: 'foreign', expectedRevision: 1 }, { text: 'x', params: {} }, { text: 'x', mediaIds: null }, { text: 'x', mediaPaths: ['/private'] }]) {
        await expect(s.ops.saveDraft(s.lease, 0, input as any)).rejects.toThrow();
    }
    expect(s.poster.countSchedules()).toBe(0);
    expect(s.actor).not.toHaveBeenCalled();
});

it('savedDraftSurvivesLostResponseAndCacheExpiry', async () => {
    const s = setup();
    const saved = await s.ops.saveDraft(s.lease, 0, { text: 'first' });
    const edited = await s.ops.saveDraft(s.lease, 0, { id: saved.draftId, expectedRevision: 1, text: 'second' });
    expect(edited.revision).toBe(2);
    s.workStore.transition(s.lease, 'completed', {}, now);
    s.advance(25 * 3600000);
    const restarted = createPageWorkOperations(s.deps);
    expect(await restarted.saveDraft(s.lease, 0, { text: 'first' })).toEqual(saved);
    expect(await restarted.saveDraft(s.lease, 0, { id: saved.draftId, expectedRevision: 1, text: 'second' })).toEqual(edited);
    expect(s.poster.countSchedules()).toBe(1);
    expect(restarted.getDraft(s.work.id, saved.draftId)).toMatchObject({ text: 'second', revision: 2 });
    expect(JSON.stringify(restarted.getDraft(s.work.id, saved.draftId))).not.toContain(s.baseDir);
    await expect(restarted.saveDraft(s.lease, 0, { text: 'different' })).rejects.toThrow();
});

it('changedActorStopsBeforeBrowserAction', async () => {
    const s = setup();
    s.actor.mockImplementation(async () => { throw new Error('wrong actor'); });
    await expect(s.ops.saveDraft(s.lease, 0, { text: 'x' })).rejects.toThrow('wrong actor');
    expect(s.poster.countSchedules()).toBe(0);
});

it('staleContextAfterAwaitCannotSave', async () => {
    const s = setup();
    s.actor.mockImplementation(async () => { s.revoke(); });
    await expect(s.ops.saveDraft(s.lease, 0, { text: 'x' })).rejects.toThrow('stale');
    expect(s.poster.countSchedules()).toBe(0);
});

it('realFinishFailureRollsBackPosterRowAndPreservesOldBytes', async () => {
    const s = setup();
    const media = await s.inbox.save('image.jpg', 'image/jpeg', Readable.from(['OLD']));
    s.workStore.linkResource(s.work.id, { kind: 'media', id: media.mediaId });
    const saved = await s.ops.saveDraft(s.lease, 0, { text: 'x', mediaIds: [media.mediaId] });
    const oldPath = getDraft(s.draftDeps, saved.draftId).media[0].path;
    s.db.exec(`CREATE TRIGGER fail_finish BEFORE UPDATE ON page_work_steps WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'finish failed'); END`);
    await expect(s.ops.saveDraft(s.lease, 0, { id: saved.draftId, expectedRevision: 1, text: 'new' })).rejects.toMatchObject({ message: 'finish failed', code: 'SQLITE_CONSTRAINT_TRIGGER' });
    expect(s.poster.getSchedule(saved.draftId)).toMatchObject({ revision: 1, params: { text: 'x' } });
    expect(fs.readFileSync(oldPath, 'utf8')).toBe('OLD');
});

it('legacyProtectedEditFailurePreservesOldRevisionBytes', async () => {
    const s = setup();
    const media = await s.inbox.save('image.jpg', 'image/jpeg', Readable.from(['OLD']));
    s.workStore.linkResource(s.work.id, { kind: 'media', id: media.mediaId });
    const saved = await s.ops.saveDraft(s.lease, 0, { text: 'x', mediaIds: [media.mediaId] });
    const oldPath = getDraft(s.draftDeps, saved.draftId).media[0].path;
    s.db.exec(`CREATE TRIGGER fail_edit BEFORE UPDATE ON fb_poster_schedules BEGIN SELECT RAISE(ABORT, 'edit failed'); END`);
    expect(() => saveDraft(s.draftDeps, { id: saved.draftId, params: { mode: 'page', text: 'new', mediaPaths: [] } })).toThrow('edit failed');
    expect(fs.readFileSync(oldPath, 'utf8')).toBe('OLD');
    expect(s.poster.getSchedule(saved.draftId)!.revision).toBe(1);
});

it('missingLinkedDraftStopsForReviewWithoutRecreatingIt', async () => {
    const s = setup();
    const saved = await s.ops.saveDraft(s.lease, 0, { text: 'x' });
    s.db.run('DELETE FROM fb_poster_schedules WHERE id = ?', [saved.draftId]);
    expect((await s.ops.reconcile(s.work.id)).status).toBe('needs_review');
    expect(s.poster.countSchedules()).toBe(0);
});

it('expiredMediaSaveDoesNotBlockVideoReadoption', async () => {
    const s = setup();
    await s.ops.attachVideo(s.work.id, 'video');
    await s.ops.reconcile(s.work.id);
    const oldId = s.workStore.getVideoMediaIds(s.work.id, 'video')[0];
    s.inbox.cleanup(Date.now() + 25 * 3600000);
    await expect(s.ops.saveDraft(s.lease, 0, { text: 'x', mediaIds: [oldId] })).rejects.toThrow();
    expect(s.workStore.getStep(s.work.id, 'draft:0')).toBeNull();
    expect((await s.ops.reconcile(s.work.id)).status).not.toBe('needs_review');
    expect(s.video.openFile).toHaveBeenCalledTimes(2);
});

it('unknownSideEffectStopsForReview', async () => {
    const s = setup();
    s.workStore.beginStep(s.lease, 'draft:0', 'unknown', now, { kind: 'draft', id: 'missing' });
    expect((await s.ops.reconcile(s.work.id)).status).toBe('needs_review');
    expect(s.poster.countSchedules()).toBe(0);
});

it('finishedVideoReacquiresExpiredMediaWithoutRendering', async () => {
    const s = setup();
    await s.ops.attachVideo(s.work.id, 'video');
    await s.ops.reconcile(s.work.id);
    const first = s.db.query<any>("SELECT resource_id FROM page_work_resources WHERE resource_kind='media' ORDER BY rowid");
    expect(first).toHaveLength(1);
    s.inbox.cleanup(Date.now() + 25 * 3600000);
    await s.ops.reconcile(s.work.id);
    const rows = s.db.query<any>("SELECT resource_id FROM page_work_resources WHERE resource_kind='media' ORDER BY rowid");
    expect(rows).toHaveLength(2);
    expect(s.inbox.resolve([rows[1].resource_id])).toHaveLength(1);
    expect(s.video.openFile).toHaveBeenCalledTimes(2);
    expect(s.workStore.get(s.work.id)!.evidenceRefs).toContain(`media:${rows[1].resource_id}`);
    expect(s.workStore.get(s.work.id)!.attempts).toBe(1);
});

it('cancelDoesNotCancelIndependentApprovedSchedule', async () => {
    const s = setup();
    s.poster.createSchedule({ id: 'approved', name: 'independent', kind: 'once', params: {}, runAt: now,
        days: [], time: '', enabled: true, nextRunAt: now, createdAt: now, draft: false });
    await s.ops.attachVideo(s.work.id, 'video');
    await s.ops.cancelOwned(s.work.id);
    expect(s.workStore.get(s.work.id)!.status).toBe('cancelled');
    expect(s.poster.getSchedule('approved')).toMatchObject({ enabled: true, draft: false, nextRunAt: now });
});

it.each(['before-intent', 'intent', 'resource-unlinked', 'linked-lost-reply', 'media-intent'] as const)('diskCrashWindow %s neverDuplicatesAnEffect', async (window) => {
    const dir = temp(); const file = path.join(dir, 'crash.sqlite');
    let disk = openDisk(file);
    const first = setup(disk.db, dir);
    let saved: { draftId: string; revision: number } | undefined;
    if (window === 'linked-lost-reply') {
        saved = await first.ops.saveDraft(first.lease, 0, { text: 'durable' });
        first.workStore.transition(first.lease, 'completed', {}, now);
    } else if (window === 'media-intent') {
        await first.ops.attachVideo(first.work.id, 'video');
        first.workStore.beginMediaAdoption(first.work.id, 'video', 'media-crash', now);
    } else if (window !== 'before-intent') {
        first.workStore.beginStep(first.lease, 'draft:0', 'unknown', now, { kind: 'draft', id: 'reserved' });
        if (window === 'resource-unlinked') first.poster.createSchedule({ id: 'reserved', name: 'unknown', kind: 'once', params: {},
            runAt: null, days: [], time: '', enabled: false, nextRunAt: null, createdAt: now, draft: true });
    }
    disk.raw.close(); disk = openDisk(file);
    try {
        const second = setup(disk.db, dir, false);
        if (saved) {
            second.advance(25 * 3600000);
            expect(await second.ops.saveDraft(first.lease, 0, { text: 'durable' })).toEqual(saved);
        } else if (window === 'before-intent') await second.ops.saveDraft(first.lease, 0, { text: 'durable' });
        else expect((await second.ops.reconcile(first.work.id)).status).toBe('needs_review');
        expect(second.poster.countSchedules()).toBe(['intent', 'media-intent'].includes(window) ? 0 : 1);
        expect(second.video.openFile).not.toHaveBeenCalled();
    } finally { disk.raw.close(); }
});

it('productionFactoryBindsWorkspaceAndLiveActorToProfileQueue', async () => {
    const mocked = [
        'electron', 'xlsx', '../../services/database/DatabaseService', '../../services/event/EventBroadcaster',
        '../../utils/AppModeManager', '../../utils/Logger', '../../services/ai/AIAssistantService',
        '../../../electron/ipc/browserProfileIpc', '../../../electron/ipc/researchIpc', '../../../electron/ipc/videoIpc',
        '../../../electron/ipc/dailyBriefIpc', '../../../electron/ipc/workspaceIpc', '../../../electron/ipc/inboxMedia',
        '../../services/facebookPoster/FacebookPosterService', '../../services/facebookPoster/FacebookPosterStore',
        '../../services/dailyBrief/PageWorkStore', '../../services/dailyBrief/pageWorkOperations', '../../services/dailyBrief/pageIdentity',
        '../../utils/WorkspaceManager',
    ];
    let dbPath = '/workspace/database.sqlite';
    const boundDb = { ...memoryDb(), getDbPath: () => dbPath, getBrowserProfileById: () => ({ id: 'profile' }) };
    new FacebookPosterStore(boundDb).ensureSchema();
    const acquire = jest.fn(); const release = jest.fn(); const close = jest.fn(async () => undefined);
    const page = {}; const read = jest.fn(async (_page: unknown, opts: { assertCurrent(): void }) => { opts.assertCurrent(); return { kind: 'page', pageId: 'page' }; });
    const open = jest.fn(async () => ({ context: { once: jest.fn(), pages: () => [page] }, close }));
    let deps: any;
    try {
        jest.doMock('electron', () => ({ dialog: {}, ipcMain: {} })); jest.doMock('xlsx', () => ({}));
        jest.doMock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => boundDb } }));
        jest.doMock('../../utils/WorkspaceManager', () => ({ __esModule: true, default: { getInstance: () => ({getActiveWorkspace:()=>({id:'workspace'})}) } }));
        jest.doMock('../../services/event/EventBroadcaster', () => ({ __esModule: true, default: { emit: jest.fn() } }));
        jest.doMock('../../utils/AppModeManager', () => ({ __esModule: true, default: { getInstance: () => ({ isEmployeeMode: () => false }) } }));
        jest.doMock('../../utils/Logger', () => ({ __esModule: true, default: { warn: jest.fn() } }));
        jest.doMock('../../services/ai/AIAssistantService', () => ({ __esModule: true, default: {} }));
        jest.doMock('../../../electron/ipc/browserProfileIpc', () => ({ getBrowserProfileService: () => ({ openForAutomation: open,
            onAvailabilityChanged: () => () => {}, tryReserveAutomation: (profileId: string) => { acquire(); return { profileId }; },
            releaseAutomationReservation: release, isRunning: () => false, canReserveAutomation: () => true,
        }) }));
        jest.doMock('../../../electron/ipc/researchIpc', () => ({ getResearchService: () => ({}), getResearchStore: () => ({}) }));
        jest.doMock('../../../electron/ipc/videoIpc', () => ({ getPageWorkVideoOperations: () => ({}) }));
        jest.doMock('../../../electron/ipc/dailyBriefIpc', () => ({}));
        jest.doMock('../../../electron/ipc/workspaceIpc', () => ({ isWorkspaceSwitchInProgress: () => false }));
        jest.doMock('../../../electron/ipc/inboxMedia', () => ({ getInboxMediaStore: () => ({}) }));
        jest.doMock('../../services/facebookPoster/FacebookPosterService', () => ({ FacebookPosterService: class {
            acquireExclusive = acquire; releaseExclusive = release;
        } }));
        jest.doMock('../../services/facebookPoster/FacebookPosterStore', () => ({ FacebookPosterStore: class {
            failInterruptedRuns() {} pruneTrackingOlderThan() {} pruneLeadsOlderThan() {}
            listSchedules() { return []; }
            nextScheduledAt() { return null; }
        } }));
        jest.doMock('../../services/dailyBrief/PageWorkStore', () => ({ PageWorkStore: class { ensureSchema() {} } }));
        jest.doMock('../../services/dailyBrief/pageWorkOperations', () => ({ createPageWorkOperations: (value: any) => { deps = value; return value; } }));
        jest.doMock('../../services/dailyBrief/pageIdentity', () => ({ readPageIdentity: read }));
        jest.isolateModules(() => {
            const ipc = require('../../../electron/ipc/facebookPosterIpc');
            ipc.createBoundPageWorkOperations(() => ({ ...context, dbPath }), () => undefined);
        });
        const guard = jest.fn();
        await deps.assertActor(context, guard);
        expect(acquire).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledWith(page, { assertCurrent: guard }); expect(close).toHaveBeenCalledTimes(1);
        expect(deps.db).toBe(boundDb);
        dbPath = '/other/database.sqlite'; expect(() => deps.assertCurrent()).toThrow();
        dbPath = '/workspace/database.sqlite'; expect(() => deps.assertCurrent()).toThrow();
    } finally { mocked.forEach(name => jest.dontMock(name)); jest.resetModules(); }
});

it('diskReopenPreservesOriginalResultAndUncertainIntent', async () => {
    const dir = temp();
    const file = path.join(dir, 'workspace.sqlite');
    let disk = openDisk(file);
    const first = setup(disk.db, dir);
    const saved = await first.ops.saveDraft(first.lease, 0, { text: 'durable' });
    first.workStore.beginStep(first.lease, 'draft:1', 'crashed', now, { kind: 'draft', id: 'reserved' });
    disk.raw.close();
    disk = openDisk(file);
    try {
        const second = setup(disk.db, dir, false);
        second.advance(25 * 3600000);
        expect(await second.ops.saveDraft(first.lease, 0, { text: 'durable' })).toEqual(saved);
        expect((await second.ops.reconcile(first.work.id)).status).toBe('needs_review');
        expect(second.poster.countSchedules()).toBe(1);
    } finally { disk.raw.close(); }
});
