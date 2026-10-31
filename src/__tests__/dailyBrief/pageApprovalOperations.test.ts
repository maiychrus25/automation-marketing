import fs from 'fs';
import os from 'os';
import path from 'path';
import { memoryDb } from '../facebookPoster/helpers';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { PageCampaignStore } from '../../services/dailyBrief/PageCampaignStore';
import { PageCampaignExecutionStore } from '../../services/dailyBrief/PageCampaignExecutionStore';
import { PageBusinessStore } from '../../services/dailyBrief/PageBusinessStore';
import { PageWorkStore } from '../../services/dailyBrief/PageWorkStore';
import { DailyBriefStore } from '../../services/dailyBrief/DailyBriefStore';
import { saveDraft, getDraft } from '../../services/facebookPoster/drafts';
import { createPageApprovalOperations } from '../../services/dailyBrief/pageApprovalOperations';
import { createPageWorkOperations } from '../../services/dailyBrief/pageWorkOperations';
import { InboxMediaStore } from '../../services/control/InboxMediaStore';
import type { OwnerAction, ControlPrincipal, OwnerUpdate } from '../../models/pageOperations';

const NOW = Date.parse('2026-10-28T10:00:00Z');
const receiver: Extract<ControlPrincipal, {kind: 'page_receiver'}> = { kind: 'page_receiver', keyId: 'receiver', workspaceId: 'workspace',
    assignments: [{ pageId: 'page', profileIds: ['profile', 'second'] }], ownerChatId: '-9007199254740993', ownerSenderId: '9007199254740995' };
const update: OwnerUpdate = { updateId: 10, messageId: 20, chatId: receiver.ownerChatId, senderId: receiver.ownerSenderId, replyToMessageId: 15 };
const dirs: string[] = [];
afterAll(() => dirs.forEach(dir => fs.rmSync(dir, {recursive: true, force: true})));
function setup() {
    const db = memoryDb();
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-approval-')); dirs.push(baseDir);
    const poster = new FacebookPosterStore(db); poster.ensureSchema();
    const clock = { date: () => '2026-10-28', minutes: () => 600 };
    const workStore = new PageWorkStore(db, clock); workStore.ensureSchema();
    const business = new PageBusinessStore(db);
    const briefs = new DailyBriefStore(db, clock);
    for (const profileId of ['profile', 'second']) briefs.upsertIdentity({ profileId, kind: 'page', pageId: 'page', pageName: 'Page', category: '', about: '', recentPosts: [], learnedAt: NOW, errorCode: '', error: '' });
    briefs.saveBrief('profile', { time: '07:00', draftsPerDay: 2 }, NOW);
    business.ensure('page', 'profile', NOW);
    business.setEnabled('page', true, 0, { confirmedAt: NOW, confirmationRef: 'setup' });
    const work = workStore.claimDue({ workspaceId: 'workspace', pageId: 'page', profileId: 'profile', dbPath: 'test' }, NOW)!;
    let time = NOW; let active = true;
    const draft = { baseDir, maxSchedules: 200, newId: () => 'draft', now: () => time,
        env: { profileExists: () => true, fileExists: fs.existsSync, fileSize: (p: string) => fs.statSync(p).size } };
    const source = path.join(baseDir, 'photo.jpg'); fs.writeFileSync(source, 'original');
    const saved = saveDraft({ ...draft, store: poster }, { params: { mode: 'page', text: 'Hello', mediaPaths: [source], profiles: [{profileId: 'profile', targets: ['https://www.facebook.com/']}] } });
    workStore.linkResource(work.id, {kind: 'draft', id: saved.id});
    const afterCommit = jest.fn();
    const deps = { db, receiver, draft, now: () => time, clock,
        assertCurrent: () => { if (!active) throw new Error('revoked'); },
        inspectResource: () => ({ workspaceId: 'workspace', pageId: 'page', profileId: 'profile', fingerprint: 'real-resource' }), afterCommit };
    const operations = createPageApprovalOperations(deps);
    const action: OwnerAction = { kind: 'approveDraft', pageId: 'page', draftId: saved.id, expectedRevision: saved.revision, timing: { when: 'now' } };
    const prepare = (a: OwnerAction = action) => { const ticket = operations.prepare(a, receiver); operations.bindMessage(ticket.id, update.chatId, update.senderId, update.replyToMessageId); return ticket; };
    return { db, poster, business, briefs, workStore, work, draft, deps, operations, action, prepare, afterCommit,
        advance: (n: number) => {time += n;}, revoke: () => {active = false;} };
}

function campaignSetup() {
    const s = setup(); const campaigns = new PageCampaignStore(s.db); campaigns.ensureSchema();
    const input = { name: 'Pilot', goal: 'Engagement', policy: { startsAt: NOW, expiresAt: NOW + 7 * 86400000,
        maxPostsPerDay: 1, maxPostsTotal: 7, allowedMinutes: [600], timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        actions: ['schedulePost' as const] } };
    const lease = {workId:s.work.id, claimedAt:s.work.claimedAt!};
    const proposal = campaigns.saveProposal(s.work, lease, input, null, NOW);
    const action = {kind:'grantCampaign', pageId:'page', proposalId:proposal.id, expectedProposalRevision:proposal.revision} as any;
    return {...s, campaigns, input, lease, proposal, campaignAction:action};
}
it('ownerConfirmationCreatesCampaignAndConsumesTicketTogether', async () => {
    const s = campaignSetup(); const ticket = s.prepare(s.campaignAction);
    const result = await s.operations.confirm(ticket.id, update, receiver);
    const links = s.campaigns.list(s.work); expect(links).toHaveLength(1);
    expect(s.campaigns.listGrants(links[0].campaignId)).toHaveLength(1);
    expect(s.workStore.getApproval(ticket.id)).toMatchObject({consumedAt:NOW, resourceId:result.resourceId});
    expect(await s.operations.confirm(ticket.id, update, receiver)).toEqual({...result, replayed:true});
    expect(s.campaigns.listGrants(links[0].campaignId)).toHaveLength(1);
    expect(s.workStore.getResourceOwner({kind:'campaign', id:links[0].campaignId})).toBeNull();
});
it('proposalRevisionIsIndependentOfBusinessRevisionAndRenewalCreatesANewGrant', async () => {
    const s = campaignSetup();
    s.business.createOwnerFact('page', {topic:'service', value:'Known', reason:''}, 1, {confirmedAt:NOW, confirmationRef:'basis'});
    const first = s.prepare(s.campaignAction); await s.operations.confirm(first.id, update, receiver);
    const link = s.campaigns.list(s.work)[0]; const oldGrant = s.campaigns.listGrants(link.campaignId)[0];
    const proposal = s.campaigns.saveProposal(s.work, s.lease, {...s.input, campaignId:link.campaignId, expectedCampaignRevision:1}, null, NOW);
    const renewal = s.prepare({kind:'grantCampaign', pageId:'page', proposalId:proposal.id, expectedProposalRevision:1} as any);
    await s.operations.confirm(renewal.id, {...update, updateId:11, messageId:21}, receiver);
    expect(s.campaigns.getGrant(oldGrant.id)).toMatchObject({revision:2, status:'revoked'});
    const grants = s.campaigns.listGrants(link.campaignId); expect(grants).toHaveLength(2);
    expect(grants.find(g => g.id !== oldGrant.id)).toMatchObject({status:'active', campaignRevision:2});
    expect(s.campaigns.list(s.work)).toHaveLength(1);
});
it('renewalEmitsOnlyChangedGrantsNotUnchangedHistory', async () => {
    const s = campaignSetup();
    await s.operations.confirm(s.prepare(s.campaignAction).id, update, receiver);
    const link = s.campaigns.list(s.work)[0];
    for (let revision = 1; revision <= 2; revision++) {
        const proposal = s.campaigns.saveProposal(s.work, s.lease, {...s.input, campaignId:link.campaignId, expectedCampaignRevision:revision}, null, NOW);
        const before = s.db.queryOne<any>('SELECT MAX(seq) AS n FROM control_events')!.n;
        const previous = s.campaigns.listGrants(link.campaignId);
        const ticket = s.prepare({kind:'grantCampaign', pageId:'page', proposalId:proposal.id, expectedProposalRevision:1});
        await s.operations.confirm(ticket.id, {...update, updateId:10 + revision, messageId:20 + revision}, receiver);
        const events = s.db.query<any>("SELECT payload FROM control_events WHERE seq > ? AND type = 'pageCampaigns.grantChanged'", [before]);
        expect(events).toHaveLength(2);
        for (const historical of previous.filter(g => g.status === 'revoked'))
            expect(JSON.stringify(events)).not.toContain(historical.id);
    }
});

it('campaignTicketFailureRollsBackGrantAndLink', async () => {
    const s = campaignSetup(); const ticket = s.prepare(s.campaignAction);
    s.db.exec("CREATE TRIGGER reject_campaign_ticket BEFORE UPDATE ON page_owner_approvals WHEN NEW.consumed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'ticket failure'); END;");
    await expect(s.operations.confirm(ticket.id, update, receiver)).rejects.toMatchObject({message:'ticket failure', code:'SQLITE_CONSTRAINT_TRIGGER'});
    expect(s.campaigns.list(s.work)).toEqual([]); expect(s.poster.listCampaigns()).toEqual([]);
    expect(s.campaigns.getProposal(s.proposal.id)?.status).toBe('pending');
    expect(s.workStore.getApproval(ticket.id)?.consumedAt).toBeNull();
});
it.each(['proposal', 'business', 'identity', 'sender', 'reply'] as const)('changedProposalOrWrongSenderRejects(%s)', async change => {
    const s = campaignSetup(); const ticket = s.prepare(s.campaignAction);
    if (change === 'proposal') s.campaigns.saveProposal(s.work, s.lease, {...s.input, policy:{...s.input.policy, maxPostsTotal:8, allowedMinutes:[480]}}, 1, NOW);
    if (change === 'business') s.business.createOwnerFact('page', {topic:'service', value:'Changed', reason:''}, 1, {confirmedAt:NOW, confirmationRef:'changed'});
    if (change === 'identity') s.briefs.upsertIdentity({...s.briefs.getIdentity('profile')!, pageId:'other'});
    await expect(s.operations.confirm(ticket.id, {...update, ...(change === 'sender' ? {senderId:'123'} : change === 'reply' ? {replyToMessageId:99} : {})}, receiver)).rejects.toBeDefined();
    expect(s.campaigns.list(s.work)).toEqual([]);
});
it('revokedGrantCannotBeResurrectedAndOwnerScheduleIsUntouched', async () => {
    const s = campaignSetup(); const ticket = s.prepare(s.campaignAction);
    await s.operations.confirm(ticket.id, update, receiver);
    const link = s.campaigns.list(s.work)[0]; const grant = s.campaigns.listGrants(link.campaignId)[0];
    const approval = s.prepare({...s.action, timing:{when:'schedule', kind:'once', runAt:NOW + 120000}});
    await s.operations.confirm(approval.id, {...update, updateId:12, messageId:22}, receiver);
    const ownerSchedule = s.poster.getSchedule('draft');
    expect(ownerSchedule).toMatchObject({id:'draft', draft:false, enabled:true, runAt:NOW + 120000, nextRunAt:NOW + 120000});
    const revoke = s.prepare({kind:'revokeCampaignGrant', pageId:'page', grantId:grant.id, expectedGrantRevision:1} as any);
    await s.operations.confirm(revoke.id, {...update, updateId:11, messageId:21}, receiver);
    expect(s.campaigns.getGrant(grant.id)).toMatchObject({status:'revoked', revision:2});
    await s.operations.confirm(ticket.id, update, receiver);
    expect(s.campaigns.getGrant(grant.id)?.status).toBe('revoked');
    expect(s.poster.getSchedule('draft')).toEqual(ownerSchedule);
});
it.each(['revoke','renew'] as const)('revokedWorkCannotBeReclaimedAndReservedAuthorityIsCancelled(%s)', async mode => {
    const s=campaignSetup(); await s.operations.confirm(s.prepare(s.campaignAction).id,update,receiver);
    const link=s.campaigns.list(s.work)[0]; const grant=s.campaigns.listGrants(link.campaignId)[0];
    const executions=new PageCampaignExecutionStore(s.db,s.deps.clock); executions.ensureSchema();
    s.poster.updateAutonomySchedule('draft',{draft:false,enabled:true,runAt:NOW+120000,nextRunAt:NOW+120000,campaignId:link.campaignId},NOW,1);
    executions.reserve({workspaceId:'workspace',pageId:'page',profileId:'profile',workId:s.work.id,scheduleId:'draft',campaignId:link.campaignId,grantId:grant.id,grantRevision:1,
        runnerKeyId:'runner',authorityFingerprint:'hash',selection:{variant:'A',contentRevision:'content',factIds:[]},plannedDate:'2026-10-28',actualDate:null,
        status:'reserved',runId:null,resultId:null,revision:1},NOW);
    let action:OwnerAction={kind:'revokeCampaignGrant',pageId:'page',grantId:grant.id,expectedGrantRevision:1};
    if(mode==='renew') {
        const proposal=s.campaigns.saveProposal(s.work,s.lease,{...s.input,campaignId:link.campaignId,expectedCampaignRevision:1},null,NOW);
        action={kind:'grantCampaign',pageId:'page',proposalId:proposal.id,expectedProposalRevision:1};
    }
    await s.operations.confirm(s.prepare(action).id,{...update,updateId:11,messageId:21},receiver);
    expect(executions.get('draft')).toMatchObject({status:'cancelled',revision:2});
    expect(s.poster.getSchedule('draft')).toMatchObject({authorityKind:'autonomy',enabled:false,nextRunAt:null});
    expect(s.workStore.get(s.work.id)?.status).toBe('cancelled');
    const reclaimedCampaignWork=s.workStore.claimDue({...s.work,dbPath:'test'},NOW+1);
    expect(reclaimedCampaignWork).toBeNull();
    // Independent proposal/research authority and the Page switch remain intact.
    expect(s.business.get('page')?.enabled).toBe(true);
    expect(s.operations.prepare({kind:'confirmFact',pageId:'page',expectedRevision:1,fact:{topic:'service',value:'Confirmed independently',reason:''}},receiver)).toBeDefined();
});
it('missingExecutionJournalCannotBeTreatedAsZeroReservationDuringRevoke',async()=>{
    const s=campaignSetup(); await s.operations.confirm(s.prepare(s.campaignAction).id,update,receiver);
    const link=s.campaigns.list(s.work)[0]; const grant=s.campaigns.listGrants(link.campaignId)[0];
    s.poster.updateAutonomySchedule('draft',{draft:false,enabled:true,campaignId:link.campaignId,runAt:NOW+120000,nextRunAt:NOW+120000},NOW,1);
    const ticket=s.prepare({kind:'revokeCampaignGrant',pageId:'page',grantId:grant.id,expectedGrantRevision:1});
    await expect(s.operations.confirm(ticket.id,{...update,updateId:11,messageId:21},receiver)).rejects.toMatchObject({code:'INTERNAL'});
    expect(s.campaigns.getGrant(grant.id)).toMatchObject({status:'active',revision:1});
    expect(s.workStore.getApproval(ticket.id)?.consumedAt).toBeNull();
});
it('revokingGrantWithoutCampaignWorkDoesNotCancelIndependentPhaseAPreparation',async()=>{
    const s=campaignSetup(); await s.operations.confirm(s.prepare(s.campaignAction).id,update,receiver);
    const link=s.campaigns.list(s.work)[0]; const grant=s.campaigns.listGrants(link.campaignId)[0];
    const revoke=s.prepare({kind:'revokeCampaignGrant',pageId:'page',grantId:grant.id,expectedGrantRevision:1});
    await s.operations.confirm(revoke.id,{...update,updateId:11,messageId:21},receiver);
    expect(s.workStore.get(s.work.id)?.status).toBe('running');
    expect(s.workStore.assertLease(s.lease,NOW)).toMatchObject({id:s.work.id});
});

it('runnerCannotPrepareOrConfirmOwnerAction', async () => {
    const s = setup(); const ticket = s.prepare();
    const runner: ControlPrincipal = {kind: 'page_runner', keyId: 'runner', workspaceId: 'workspace', assignments: receiver.assignments};
    expect(() => s.operations.prepare(s.action, runner)).toThrow(expect.objectContaining({code: 'FORBIDDEN'}));
    await expect(s.operations.confirm(ticket.id, update, runner)).rejects.toMatchObject({code: 'FORBIDDEN'});
    expect(s.poster.getSchedule('draft')?.draft).toBe(true);
});
it.each(['text', 'file', 'target', 'timing'] as const)('changedDraftInvalidatesApproval(%s)', async change => {
    const s = setup(); const ticket = s.prepare(); const row = s.poster.getSchedule('draft')!;
    if (change === 'file') fs.writeFileSync(getDraft({...s.draft, store: s.poster}, 'draft').media[0].path, 'replaced');
    else s.poster.updateSchedule('draft', change === 'timing' ? {runAt: NOW + 120000} : {params: {...row.params, [change === 'text' ? 'text' : 'profiles']: change === 'text' ? 'Changed' : [{profileId: 'second', targets: ['https://www.facebook.com/']}]}}, NOW);
    const before = s.poster.getSchedule('draft');
    await expect(s.operations.confirm(ticket.id, update, receiver)).rejects.toMatchObject({code: 'CONFLICT'});
    expect(s.poster.getSchedule('draft')).toEqual(before); expect(s.afterCommit).not.toHaveBeenCalled();
});
it.each([{chatId: '123'}, {senderId: '123'}, {replyToMessageId: 99}, {updateId: Number.MAX_SAFE_INTEGER + 1}, {messageId: 0}])('wrongChatSenderReplyOrExpiredTicketRejects(%j)', async patch => {
    const s = setup(); const ticket = s.prepare();
    await expect(s.operations.confirm(ticket.id, {...update, ...patch}, receiver)).rejects.toMatchObject({code: 'FORBIDDEN'});
    expect(s.poster.getSchedule('draft')?.draft).toBe(true);
});
it('expiredTicketRejectsAndCannotBeRebound', async () => {
    const s = setup(); const ticket = s.prepare(); s.advance(900000);
    await expect(s.operations.confirm(ticket.id, update, receiver)).rejects.toMatchObject({code: 'CONFLICT'});
    expect(() => s.operations.bindMessage(ticket.id, update.chatId, update.senderId, 16)).toThrow();
});
it('replayedUpdateHasOneResult', async () => {
    const s = setup(); const ticket = s.prepare();
    const result = await s.operations.confirm(ticket.id, update, receiver);
    expect(result).toEqual({resourceId: 'draft', replayed: false});
    const saved = s.poster.getSchedule('draft');
    expect(saved).toMatchObject({draft: false, enabled: true, nextRunAt: NOW});
    expect(await createPageApprovalOperations(s.deps).confirm(ticket.id, update, receiver)).toEqual({...result, replayed: true});
    expect(s.poster.getSchedule('draft')).toEqual(saved); expect(s.afterCommit).toHaveBeenCalledTimes(1);
    expect(s.afterCommit).toHaveBeenCalledWith({resourceId:'draft', action:'approveDraft', when:'now'});
    await expect(s.operations.confirm(ticket.id, {...update, messageId: 21}, receiver)).rejects.toMatchObject({code: 'CONFLICT'});
});
it('ambiguousOkHasNoTicket', async () => {
    const s = setup();
    await expect(s.operations.confirm('ok', update, receiver)).rejects.toMatchObject({code: 'FORBIDDEN'});
    expect(() => s.operations.prepare({kind: 'call', method: 'approveDraft', pageId: 'page'} as any, receiver)).toThrow();
    expect(s.poster.getSchedule('draft')?.draft).toBe(true);
});
it('confirmationPreservesObservationSource', async () => {
    const s = setup();
    const proposed = s.business.propose('page', {topic:'service', value:'Lessons', reason:'', status:'observed', sourceType:'research', sourceRef:'scan-1', observedAt:NOW}, 1, NOW);
    const fact = proposed.facts[0];
    const ticket = s.prepare({kind:'confirmFact', pageId:'page', expectedRevision:2, factId:fact.id});
    await s.operations.confirm(ticket.id, update, receiver);
    expect(s.business.get('page')?.facts[0]).toMatchObject({...fact, status:'confirmed', confirmedAt:NOW, confirmationRef:expect.any(String)});
});
it('duplicateOwnerFactUpdateCreatesAtMostOneFact', async () => {
    const s = setup(); const action: OwnerAction = {kind:'confirmFact', pageId:'page', expectedRevision:1, fact:{topic:'service', value:'Lessons', reason:''}};
    const first = s.prepare(action); const second = s.prepare(action);
    await s.operations.confirm(first.id, update, receiver);
    await expect(s.operations.confirm(second.id, update, receiver)).rejects.toMatchObject({code:'CONFLICT'});
    expect(await s.operations.confirm(first.id, update, receiver)).toMatchObject({replayed:true});
    expect(s.business.get('page')?.facts).toHaveLength(1);
    expect(s.business.get('page')?.facts[0]).toMatchObject({sourceType:'owner', status:'confirmed', sourceRef:expect.stringContaining(update.chatId)});
});
it('unsafeScheduledTimestampRejectsBeforeCreatingTicket', () => {
    const s = setup();
    expect(() => s.prepare({...s.action, timing:{when:'schedule', kind:'once', runAt:1e100}})).toThrow(expect.objectContaining({code:'INVALID_PARAMS'}));
    expect(s.db.query<any>('SELECT * FROM page_owner_approvals')).toEqual([]);
});
it('scheduleConfirmationRechecksMinimumLeadAndNowKeepsValidation', async () => {
    const s = setup(); const ticket = s.prepare({...s.action, timing:{when:'schedule', kind:'once', runAt:NOW + 65000}});
    s.advance(6000);
    await expect(s.operations.confirm(ticket.id, update, receiver)).rejects.toThrow('ít nhất 1 phút');
    expect(s.poster.getSchedule('draft')).toMatchObject({draft:true, enabled:false, nextRunAt:null});
    const immediate = s.prepare();
    s.draft.env.profileExists = () => false;
    await expect(s.operations.confirm(immediate.id, update, receiver)).rejects.toThrow('Không tìm thấy profile');
    expect(s.poster.getSchedule('draft')?.draft).toBe(true);
});
it('foreignPageIdentityAndChangedResourceEvidenceFailClosed', async () => {
    const s = setup(); const ticket = s.prepare();
    s.briefs.upsertIdentity({profileId:'profile', kind:'page', pageId:'other', pageName:'Other', category:'', about:'', recentPosts:[], learnedAt:NOW, errorCode:'', error:''});
    await expect(s.operations.confirm(ticket.id, update, receiver)).rejects.toMatchObject({code:'FORBIDDEN'});
    const link = s.prepare({kind:'linkResource', pageId:'page', workId:s.work.id, resource:{kind:'video', id:'existing'}});
    s.deps.inspectResource = () => ({workspaceId:'workspace', pageId:'page', profileId:'profile', fingerprint:'changed'});
    await expect(s.operations.confirm(link.id, update, receiver)).rejects.toMatchObject({code:'CONFLICT'});
    expect(s.workStore.getResourceOwner({kind:'video', id:'existing'})).toBeNull();
});
it('staleFactTicketCannotWriteAndReturnedTicketCannotAlterStoredAction', async () => {
    const s = setup();
    const ticket = s.prepare({kind:'confirmFact', pageId:'page', expectedRevision:1, fact:{topic:'service', value:'Lessons', reason:''}});
    ticket.action = {kind:'setEnabled', pageId:'page', expectedRevision:1, enabled:false};
    await s.operations.confirm(ticket.id, update, receiver);
    expect(s.business.get('page')).toMatchObject({enabled:true, facts:[{value:'Lessons'}]});
    const second = s.prepare({kind:'confirmFact', pageId:'page', expectedRevision:2, fact:{topic:'service', value:'More', reason:''}});
    s.business.createOwnerFact('page', {topic:'service', value:'Concurrent', reason:''}, 2, {confirmedAt:NOW, confirmationRef:'other'});
    const before = s.business.get('page');
    await expect(s.operations.confirm(second.id, {...update, updateId:11, messageId:21}, receiver)).rejects.toMatchObject({code:'CONFLICT'});
    expect(s.business.get('page')).toEqual(before);
});
it('postCommitFailureDoesNotUndoOrRepeatPromotionAndApprovalDoesNotFinishWork', async () => {
    const s = setup(); const ticket = s.prepare(); s.afterCommit.mockImplementation(() => {throw new Error('lost hint');});
    await expect(s.operations.confirm(ticket.id, update, receiver)).resolves.toMatchObject({resourceId:'draft', replayed:false});
    expect(s.workStore.get(s.work.id)?.status).toBe('running');
    await expect(s.operations.confirm(ticket.id, update, receiver)).resolves.toMatchObject({replayed:true});
    expect(s.afterCommit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(s.workStore.get(s.work.id))).not.toContain(ticket.id);
    expect(JSON.stringify(s.workStore.get(s.work.id))).not.toContain(update.senderId);
});
it('legacyAndDesktopApprovalStillWork', () => {
    const s = setup();
    const {approveDraft} = jest.requireActual('../../services/facebookPoster/drafts');
    expect(approveDraft({...s.draft, store:s.poster}, {id:'draft', when:'now'})).toMatchObject({enabled:true, draft:false});
});
it('rollbackConsumesNeitherTicketNorDraftAndEffectsRunAfterCommit', async () => {
    const s = setup(); const ticket = s.prepare();
    s.db.exec("CREATE TRIGGER reject_ticket BEFORE UPDATE ON page_owner_approvals WHEN NEW.consumed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'ticket failure'); END;");
    await expect(s.operations.confirm(ticket.id, update, receiver)).rejects.toMatchObject({message:'ticket failure'});
    expect(s.poster.getSchedule('draft')?.draft).toBe(true); expect(s.afterCommit).not.toHaveBeenCalled();
    s.db.exec('DROP TRIGGER reject_ticket');
    s.afterCommit.mockImplementation(() => { expect(s.db.queryOne<any>('SELECT consumed_at FROM page_owner_approvals WHERE id = ?', [ticket.id])?.consumed_at).toBe(NOW); });
    await s.operations.confirm(ticket.id, update, receiver);
});
it('revokedOrForeignReceiverCannotReadReplay', async () => {
    const s = setup(); const ticket = s.prepare(); await s.operations.confirm(ticket.id, update, receiver);
    await expect(s.operations.confirm(ticket.id, update, {...receiver, keyId:'other'})).rejects.toMatchObject({code:'FORBIDDEN'});
    s.revoke(); await expect(s.operations.confirm(ticket.id, update, receiver)).rejects.toThrow('revoked');
});
it('primaryChangeAndDisableInvalidateLeaseWithoutMovingWorkOrApprovedSchedule', async () => {
    const s = setup();
    s.poster.createSchedule({...s.poster.getSchedule('draft')!, id:'independent', draft:false, enabled:true, nextRunAt:NOW});
    const independent = s.poster.getSchedule('independent');
    const ticket = s.prepare({kind:'setPrimaryProfile', pageId:'page', profileId:'second', expectedRevision:1});
    await s.operations.confirm(ticket.id, update, receiver);
    expect(s.business.get('page')?.primaryProfileId).toBe('second');
    expect(s.workStore.get(s.work.id)).toMatchObject({profileId:'profile', status:'needs_review'});
    expect(() => s.workStore.assertLease({workId:s.work.id, claimedAt:s.work.claimedAt!}, NOW)).toThrow();
    const disable = s.prepare({kind:'setEnabled', pageId:'page', enabled:false, expectedRevision:2});
    await s.operations.confirm(disable.id, {...update, updateId:11, messageId:21}, receiver);
    expect(s.business.get('page')?.enabled).toBe(false);
    expect(s.poster.getSchedule('independent')).toEqual(independent);
});
it.each(['disable', 'primary', 'cancel'] as const)('realActorReadinessRejectsWithoutMutationThenAllowsOwnerAction(%s)', async kind => {
    const s = setup(); let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const prep = createPageWorkOperations({db:s.db, context:() => ({workspaceId:'workspace', dbPath:'test', pageId:'page', profileId:'profile'}),
        now:s.deps.now, assertCurrent:s.deps.assertCurrent, clock:s.deps.clock, draft:s.draft,
        assertActor:async () => {await gate; throw new Error('actor unavailable');},
        research:undefined as any, researchStore:undefined as any, video:undefined as any, media:new InboxMediaStore(path.join(s.draft.baseDir,'inbox'))});
    const ticket = s.prepare(kind === 'disable' ? {kind:'setEnabled', pageId:'page', enabled:false, expectedRevision:1}
        : kind === 'primary' ? {kind:'setPrimaryProfile', pageId:'page', profileId:'second', expectedRevision:1}
        : {kind:'resolveWork', pageId:'page', workId:s.work.id, resolution:'cancel'});
    const running = prep.saveDraft({workId:s.work.id, claimedAt:s.work.claimedAt!}, 1, {text:'Pending'}).catch(error => error);
    const before = {business:s.business.get('page'), work:s.workStore.get(s.work.id), ticket:s.workStore.getApproval(ticket.id)};
    try {
        await expect(s.operations.confirm(ticket.id, update, receiver)).rejects.toMatchObject({code:'CONFLICT'});
        expect({business:s.business.get('page'), work:s.workStore.get(s.work.id), ticket:s.workStore.getApproval(ticket.id)}).toEqual(before);
    } finally {release(); await running;}
    await expect(s.operations.confirm(ticket.id, update, receiver)).resolves.toMatchObject({replayed:false});
    expect(s.workStore.get(s.work.id)?.status).toBe(kind === 'cancel' ? 'cancelled' : 'needs_review');
});
it('unlearnedPrimaryFailsClosed', () => {
    const s = setup();
    expect(() => s.operations.prepare({kind:'setPrimaryProfile', pageId:'page', profileId:'missing', expectedRevision:1}, receiver)).toThrow();
});
it('resolveWorkNeverRetriesUnknownEffectButAllowsCancel', async () => {
    const s = setup(); s.workStore.beginStep({workId:s.work.id, claimedAt:s.work.claimedAt!}, 'unknown', 'hash', NOW);
    s.workStore.stopPreparation(s.work.id, 'needs_review', NOW);
    expect(() => s.prepare({kind:'resolveWork', pageId:'page', workId:s.work.id, resolution:'resume'})).toThrow();
    const ticket = s.prepare({kind:'resolveWork', pageId:'page', workId:s.work.id, resolution:'cancel'});
    await s.operations.confirm(ticket.id, update, receiver);
    expect(s.workStore.get(s.work.id)?.status).toBe('cancelled');
    expect(s.workStore.getStep(s.work.id,'unknown')?.status).toBe('uncertain');
});
it('resolveClearWorkAndLinkResourceUseTrustedEvidence', async () => {
    const s = setup(); s.workStore.stopPreparation(s.work.id, 'needs_review', NOW);
    const ticket = s.prepare({kind:'resolveWork', pageId:'page', workId:s.work.id, resolution:'resume'});
    await s.operations.confirm(ticket.id, update, receiver);
    expect(s.workStore.get(s.work.id)?.status).toBe('pending');
    const link = s.prepare({kind:'linkResource', pageId:'page', workId:s.work.id, resource:{kind:'video', id:'existing'}});
    await s.operations.confirm(link.id, {...update, updateId:11, messageId:21}, receiver);
    expect(s.workStore.getResourceOwner({kind:'video', id:'existing'})).toMatchObject({workId:s.work.id, pageId:'page'});
});
