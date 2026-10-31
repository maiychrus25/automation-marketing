import { memoryDb } from '../facebookPoster/helpers';
import { FacebookPosterStore, SqlDatabase } from '../../services/facebookPoster/FacebookPosterStore';
import { DailyBriefStore } from '../../services/dailyBrief/DailyBriefStore';
import { PageBusinessStore } from '../../services/dailyBrief/PageBusinessStore';
import { PageWorkStore } from '../../services/dailyBrief/PageWorkStore';
import { PageCampaignStore } from '../../services/dailyBrief/PageCampaignStore';

const now = Date.parse('2026-10-27T08:00:00Z');
const day = 86400000;
const scope = { workspaceId: 'workspace-1', pageId: 'page-1', profileId: 'profile-1' };
const confirmation = { confirmedAt: now, confirmationRef: 'owner-message-1', receiverKeyId: 'receiver-1' };
const input = () => ({ name: 'Lessons', goal: 'Local enquiries', policy: {
    startsAt: now, expiresAt: now + 7 * day, maxPostsPerDay: 1, maxPostsTotal: 7,
    allowedMinutes: [480], timeZone: 'Asia/Ho_Chi_Minh', actions: ['schedulePost' as const, 'updateScheduledPost' as const],
} });
function setup() {
    const db = memoryDb();
    const poster = new FacebookPosterStore(db);
    poster.ensureSchema();
    const clock = { date: (t: number) => new Date(t).toISOString().slice(0, 10), minutes: () => 480 };
    const works = new PageWorkStore(db, clock);
    works.ensureSchema();
    const briefs = new DailyBriefStore(db, clock);
    briefs.saveBrief(scope.profileId, { time: '07:00' }, now);
    const business = new PageBusinessStore(db);
    business.ensure(scope.pageId, scope.profileId, now);
    business.setEnabled(scope.pageId, true, 0, confirmation);
    const work = works.claimDue({ ...scope, dbPath: ':memory:' }, now)!;
    const lease = { workId: work.id, claimedAt: work.claimedAt! };
    const store = new PageCampaignStore(db);
    store.ensureSchema();
    return { db, poster, works, store, lease };
}

describe('PageCampaignStore', () => {
    it('latestDecisionUsesScopedCreatedAtAndStableIdWithoutWorkOrReplayFields', () => {
        const {store,db,lease}=setup();
        const proposal=store.saveProposal(scope,lease,input(),null,now);
        const accepted=store.acceptProposal(scope,proposal.id,1,confirmation,now);
        expect(typeof (store as any).getLatestDecision).toBe('function');
        expect((store as any).getLatestDecision(scope,accepted.campaignId)).toBeNull();
        const decision={id:'z-old',campaignId:accepted.campaignId,grantId:accepted.grantId,grantRevision:1,
            kind:'keep' as const,before:null,after:null,observationRefs:[],sampleSizes:{},coverage:{},reason:'insufficient_evidence',createdAt:now};
        for(const [id,createdAt] of [['z-old',now],['b-new',now+1],['a-new',now+1]] as const)
            store.saveDecision(scope,lease.workId,id,{decision:{...decision,id,createdAt},scheduleId:null,
                stateHash:'internal-state',requestHash:'internal-request',executionRevision:null,action:'schedulePost'});
        db.run('DELETE FROM page_work_items');
        const view=(store as any).getLatestDecision(scope,accepted.campaignId);
        expect(view).toEqual({...decision,id:'b-new',createdAt:now+1});
        expect(JSON.stringify(view)).not.toMatch(/stateHash|requestHash|executionRevision|internal-/);
        for(const other of [{...scope,workspaceId:'other'},{...scope,pageId:'other'},{...scope,profileId:'other'}])
            expect(()=>(store as any).getLatestDecision(other,accepted.campaignId)).toThrow(expect.objectContaining({code:'FORBIDDEN'}));
        // A row in another scope must not win even if its timestamp is later.
        db.run('INSERT INTO page_campaign_decisions VALUES (?,?,?,?,?,?,?,?)', ['foreign','foreign',scope.pageId,scope.profileId,
            accepted.campaignId,'other-work','other-step',JSON.stringify({decision:{...decision,id:'foreign',createdAt:now+100}})]);
        expect((store as any).getLatestDecision(scope,accepted.campaignId)).toEqual(view);
    });

    it('proposalDoesNotCreateRunnableCampaign', () => {
        const { store, poster, lease } = setup();
        const proposal = store.saveProposal(scope, lease, input(), null, now);
        expect(proposal).toMatchObject({ ...scope, workId: lease.workId, revision: 1, status: 'pending', input: input() });
        expect(store.getProposal(proposal.id)).toEqual(proposal);
        expect(store.listProposals(scope)).toEqual([proposal]);
        expect(poster.listCampaigns()).toHaveLength(0);
        expect(poster.countSchedules()).toBe(0);
        expect(store.list(scope)).toEqual([]);
    });

    it('updatesOnePendingProposalPerWorkWithCas', () => {
        const { store, lease } = setup();
        const first = store.saveProposal(scope, lease, input(), null, now);
        expect(() => store.saveProposal(scope, lease, input(), null, now)).toThrow();
        const saved = store.saveProposal(scope, lease, { ...input(), goal: 'Updated' }, 1, now + 1);
        expect(saved).toMatchObject({ id: first.id, revision: 2, input: { goal: 'Updated' } });
        expect(store.listProposals(scope)).toEqual([saved]);
        expect(() => store.acceptProposal(scope, first.id, 1, confirmation, now)).toThrow();
    });

    it.each(['fb_poster_campaigns', 'page_campaign_links', 'page_campaign_grants', 'page_campaign_proposals', 'commit'])
    ('acceptIsAtomicAndReplayStable(%s)', stage => {
        const { store, poster, db, lease } = setup();
        const proposal = store.saveProposal(scope, lease, input(), null, now);
        const broken: SqlDatabase = { ...db, run(sql, params) {
            if (sql.includes(stage)) throw new Error('Injected write failure');
            db.run(sql, params);
        }, transaction: fn => db.transaction(() => {
            const result = fn();
            if (stage === 'commit') throw new Error('Injected commit failure');
            return result;
        }) };
        expect(() => new PageCampaignStore(broken).acceptProposal(scope, proposal.id, 1, confirmation, now)).toThrow(/Injected/);
        expect(poster.listCampaigns()).toEqual([]);
        expect(store.list(scope)).toEqual([]);
        expect(db.query('SELECT * FROM page_campaign_grants')).toEqual([]);
        expect(store.getProposal(proposal.id)).toEqual(proposal);
        const accepted = store.acceptProposal(scope, proposal.id, 1, confirmation, now);
        expect(new PageCampaignStore(db).acceptProposal(scope, proposal.id, 1, confirmation, now + 1)).toEqual(accepted);
        expect(poster.listCampaigns()).toHaveLength(1);
        expect(store.listGrants(accepted.campaignId)).toHaveLength(1);
        expect(store.getGrant(accepted.grantId)).toMatchObject({ ...scope, revision: 1, campaignRevision: 1,
            status: 'active', policy: input().policy, ...confirmation });
        expect(() => store.acceptProposal(scope, proposal.id, 1, { ...confirmation, confirmationRef: 'different' }, now)).toThrow();
        expect(poster.countSchedules()).toBe(0);
    });

    it('crossWorkReferenceDoesNotTransferOwner', () => {
        const { store, works, lease } = setup();
        const proposal = store.saveProposal(scope, lease, input(), null, now);
        const result = store.acceptProposal(scope, proposal.id, 1, confirmation, now);
        const ref = { kind: 'campaign' as const, id: result.campaignId };
        works.linkResource(lease.workId, ref);
        const originalOwner = works.getResourceOwner(ref);
        works.transition(lease, 'cancelled', {}, now);
        const next = works.claimDue({ ...scope, dbPath: ':memory:' }, now + day)!;
        expect(next.id).not.toBe(lease.workId);
        expect(store.list(scope).map(link => link.campaignId)).toEqual([result.campaignId]);
        expect(store.listProposals(scope).map(p => p.id)).toEqual([proposal.id]);
        expect(works.getResourceOwner(ref)).toEqual(originalOwner);
        for (const other of [{ ...scope, pageId: 'other' }, { ...scope, workspaceId: 'other' }, { ...scope, profileId: 'other' }]) {
            expect(store.list(other)).toEqual([]);
            expect(store.listProposals(other)).toEqual([]);
            expect(() => store.acceptProposal(other, proposal.id, 1, confirmation, now)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
            expect(() => store.revokeGrant(other, result.grantId, 1, now)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
        }
    });

    it('pruneDoesNotRemoveCampaignOrGrant', () => {
        const { store, works, poster, lease, db } = setup();
        const proposal = store.saveProposal(scope, lease, input(), null, now);
        const result = store.acceptProposal(scope, proposal.id, 1, confirmation, now);
        works.transition(lease, 'cancelled', {}, now);
        expect(works.prune(now + 30 * day)).toBe(1);
        expect(store.getLink(result.campaignId)).not.toBeNull();
        expect(poster.getCampaign(result.campaignId)).not.toBeNull();
        expect(store.getGrant(result.grantId)).toMatchObject(confirmation);
        expect(store.acceptProposal(scope, proposal.id, 1, confirmation, now + 31 * day)).toEqual(result);
        db.run('UPDATE page_campaign_links SET deleted_at = ? WHERE campaign_id = ?', [now, result.campaignId]);
        // Replaying history is not issuing another grant, even after tombstoning.
        expect(store.acceptProposal(scope, proposal.id, 1, confirmation, now + 31 * day)).toEqual(result);
        const next = works.claimDue({ ...scope, dbPath: ':memory:' }, now + 31 * day)!;
        expect(() => store.saveProposal(scope, { workId: next.id, claimedAt: next.claimedAt! },
            { ...input(), campaignId: result.campaignId, expectedCampaignRevision: 1 }, null, now + 31 * day)).toThrow();
        expect(store.listGrants(result.campaignId)).toHaveLength(1);
    });

    it('renewalRequiresManagedRevisionAndRevokesPreviousAuthority', () => {
        const { store, lease, poster } = setup();
        const first = store.saveProposal(scope, lease, input(), null, now);
        const accepted = store.acceptProposal(scope, first.id, 1, confirmation, now);
        const renewal = { ...input(), campaignId: accepted.campaignId, expectedCampaignRevision: 1 };
        const proposed = store.saveProposal(scope, lease, renewal, null, now);
        const renewed = store.acceptProposal(scope, proposed.id, 1, { ...confirmation, confirmationRef: 'renewal' }, now);
        expect(renewed.campaignId).toBe(accepted.campaignId);
        expect(renewed.grantId).not.toBe(accepted.grantId);
        expect(store.getLink(accepted.campaignId)).toMatchObject({ revision: 2 });
        expect(store.getGrant(accepted.grantId)).toMatchObject({ status: 'revoked', revision: 2 });
        expect(store.getGrant(renewed.grantId)).toMatchObject({ status: 'active', campaignRevision: 2 });
        expect(poster.listCampaigns()).toHaveLength(1);
        expect(() => store.saveProposal(scope, lease, renewal, null, now)).toThrow();
        store.revokeGrant(scope, renewed.grantId, 1, now);
        expect(store.getGrant(renewed.grantId)).toMatchObject({ status: 'revoked', revision: 2 });
        expect(() => store.revokeGrant(scope, renewed.grantId, 1, now)).toThrow();
    });

    it.each(['count', 'rows', 'changes', 'campaign-read'])('staleRevisionAndSilentDatabaseFailure(%s)', stage => {
        const { store, db, lease, poster } = setup();
        const saved = store.saveProposal(scope, lease, input(), null, now);
        expect(() => store.saveProposal(scope, lease, input(), 0, now)).toThrow();
        const broken: SqlDatabase = { ...db,
            query: (sql, params) => stage === 'rows' && sql.includes('page_campaign_proposals') ? [] : db.query(sql, params),
            queryOne: (sql, params) => (stage === 'count' && sql.includes('COUNT(*)'))
                || (stage === 'changes' && sql.includes('changes()'))
                || (stage === 'campaign-read' && sql.startsWith('SELECT * FROM fb_poster_campaigns'))
                ? undefined : db.queryOne(sql, params),
        };
        expect(() => new PageCampaignStore(broken).acceptProposal(scope, saved.id, 1, confirmation, now)).toThrow();
        expect(store.getProposal(saved.id)).toEqual(saved);
        expect(poster.listCampaigns()).toEqual([]);
        expect(store.list(scope)).toEqual([]);
    });

    it.each([
        { name: '' }, { name: 'x'.repeat(101) }, { goal: 'x'.repeat(1001) }, { campaignId: 'legacy' },
        { expectedCampaignRevision: 1 }, { id: 'chosen' }, { status: 'accepted' }, { goal: undefined },
    ])('rejectsMalformedProposal(%j)', patch => {
        const { store, lease } = setup();
        expect(() => store.saveProposal(scope, lease, { ...input(), ...patch }, null, now)).toThrow();
        expect(store.listProposals(scope)).toEqual([]);
    });

    it.each([
        { startsAt: -1 }, { expiresAt: now }, { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
        { maxPostsPerDay: 0 }, { maxPostsTotal: 1.5 }, { allowedMinutes: [] }, { allowedMinutes: [480, 480] },
        { allowedMinutes: [1440] }, { allowedMinutes: Array(1) }, { timeZone: 'Invalid/Zone' },
        { actions: ['owner'] }, { actions: Array(1) }, { actions: [] }, { extra: true },
    ])('rejectsMalformedPolicy(%j)', patch => {
        const { store, lease } = setup();
        expect(() => store.saveProposal(scope, lease, { ...input(), policy: { ...input().policy, ...patch } } as any, null, now)).toThrow();
        expect(store.listProposals(scope)).toEqual([]);
    });

    it('schemaIsExplicitAdditiveAndDoesNotTouchLegacyCampaigns', () => {
        const db = memoryDb();
        const poster = new FacebookPosterStore(db);
        poster.ensureSchema();
        poster.createCampaign({ id: 'legacy', name: 'Legacy', goal: '', status: 'paused', startAt: null, endAt: null, createdAt: now, updatedAt: now });
        const before = poster.listCampaigns();
        const store = new PageCampaignStore(db);
        expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'page_campaign_%'")).toEqual([]);
        store.ensureSchema();
        store.ensureSchema();
        expect(poster.listCampaigns()).toEqual(before);
        expect(store.getLink('legacy')).toBeNull();
        expect(store.getGrant('missing')).toBeNull();
        expect(store.getProposal('missing')).toBeNull();
        expect(store.list(scope)).toEqual([]);
    });

    it('cannotAdoptLegacyOrAcceptStaleTombstonedOrExpiredRenewals', () => {
        const { store, lease, poster, db } = setup();
        poster.createCampaign({ id: 'legacy', name: 'Legacy', goal: '', status: 'active', startAt: null, endAt: null, createdAt: now, updatedAt: now });
        expect(() => store.saveProposal(scope, lease, { ...input(), campaignId: 'legacy', expectedCampaignRevision: 1 }, null, now))
            .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
        const first = store.saveProposal(scope, lease, input(), null, now);
        const accepted = store.acceptProposal(scope, first.id, 1, confirmation, now);
        const proposal = store.saveProposal(scope, lease, { ...input(), campaignId: accepted.campaignId, expectedCampaignRevision: 1 }, null, now);
        db.run('UPDATE page_campaign_links SET deleted_at = ? WHERE campaign_id = ?', [now, accepted.campaignId]);
        expect(() => store.acceptProposal(scope, proposal.id, 1, confirmation, now)).toThrow();
        db.run('UPDATE page_campaign_links SET deleted_at = NULL, revision = 2 WHERE campaign_id = ?', [accepted.campaignId]);
        expect(() => store.acceptProposal(scope, proposal.id, 1, confirmation, now)).toThrow();
        db.run('UPDATE page_campaign_links SET revision = 1 WHERE campaign_id = ?', [accepted.campaignId]);
        expect(() => store.acceptProposal(scope, proposal.id, 1, confirmation, now + 7 * day)).toThrow();
        expect(store.listGrants(accepted.campaignId)).toHaveLength(1);
        expect(store.getProposal(proposal.id)).toEqual(proposal);
    });

    it('renewalRollbackKeepsPreviousGrantCampaignAndLink', () => {
        const { store, lease, poster, db } = setup();
        const first = store.saveProposal(scope, lease, input(), null, now);
        const accepted = store.acceptProposal(scope, first.id, 1, confirmation, now);
        const proposal = store.saveProposal(scope, lease, { ...input(), goal: 'Renewed', campaignId: accepted.campaignId, expectedCampaignRevision: 1 }, null, now);
        const before = { link: store.getLink(accepted.campaignId), grant: store.getGrant(accepted.grantId), campaign: poster.getCampaign(accepted.campaignId) };
        const broken: SqlDatabase = { ...db, run(sql, params) {
            if (sql.includes('INSERT INTO page_campaign_grants')) throw new Error('Injected grant failure');
            db.run(sql, params);
        } };
        expect(() => new PageCampaignStore(broken).acceptProposal(scope, proposal.id, 1, confirmation, now)).toThrow('Injected grant failure');
        expect(store.getLink(accepted.campaignId)).toEqual(before.link);
        expect(store.getGrant(accepted.grantId)).toEqual(before.grant);
        expect(poster.getCampaign(accepted.campaignId)).toEqual(before.campaign);
        expect(store.getProposal(proposal.id)).toEqual(proposal);
    });

    it('zeroChangeCasRollsBackAndSilentListReadsNeverLookEmpty', () => {
        const { store, lease, db } = setup();
        const saved = store.saveProposal(scope, lease, input(), null, now);
        const broken: SqlDatabase = { ...db, run(sql, params) {
            if (sql.includes('UPDATE page_campaign_proposals')) db.run('UPDATE page_campaign_proposals SET revision = revision WHERE 0');
            else db.run(sql, params);
        } };
        expect(() => new PageCampaignStore(broken).saveProposal(scope, lease, { ...input(), goal: 'Changed' }, 1, now)).toThrow();
        expect(store.getProposal(saved.id)).toEqual(saved);
        const result = store.acceptProposal(scope, saved.id, 1, confirmation, now);
        for (const table of ['page_campaign_links', 'page_campaign_proposals', 'page_campaign_grants']) {
            const silent: SqlDatabase = { ...db, query: (sql, params) => sql.includes(table) ? [] : db.query(sql, params) };
            const failing = new PageCampaignStore(silent);
            const read = table === 'page_campaign_links' ? () => failing.list(scope)
                : table === 'page_campaign_proposals' ? () => failing.listProposals(scope) : () => failing.listGrants(result.campaignId);
            expect(read).toThrow(expect.objectContaining({ code: 'INTERNAL' }));
        }
    });

    it('acceptRevalidatesNamesAndPreservesExplicitOwnerPolicyWithoutExpansion', () => {
        const { store, lease, poster } = setup();
        const custom = { ...input(), policy: { ...input().policy, expiresAt: now + 2 * day, maxPostsTotal: 2, allowedMinutes: [0, 1439] } };
        const proposal = store.saveProposal(scope, lease, custom, null, now);
        poster.createCampaign({ id: 'legacy', name: 'LESSONS', goal: '', status: 'active', startAt: null, endAt: null, createdAt: now, updatedAt: now });
        expect(() => store.acceptProposal(scope, proposal.id, 1, confirmation, now)).toThrow();
        poster.deleteCampaign('legacy');
        const result = store.acceptProposal(scope, proposal.id, 1, confirmation, now);
        expect(store.getGrant(result.grantId)?.policy).toEqual(custom.policy);
        expect(store.acceptProposal(scope, proposal.id, 1, confirmation, now + day)).toEqual(result);
        expect(() => store.acceptProposal(scope, proposal.id, 2, confirmation, now)).toThrow();
    });

    it('rejectsForeignAndExpiredLeasesWithoutWriting', () => {
        const { store, lease } = setup();
        expect(() => store.saveProposal({ ...scope, pageId: 'other' }, lease, input(), null, now)).toThrow();
        expect(() => store.saveProposal(scope, lease, input(), null, now + 3600000)).toThrow();
        expect(store.listProposals(scope)).toEqual([]);
    });
});
