import { memoryDb } from '../facebookPoster/helpers';
import { PageBusinessStore } from '../../services/dailyBrief/PageBusinessStore';
import { DailyBriefStore } from '../../services/dailyBrief/DailyBriefStore';
import type { PageFactInput } from '../../models/pageOperations';
import type { SqlDatabase } from '../../services/facebookPoster/FacebookPosterStore';

const input = (patch: Partial<PageFactInput> = {}): PageFactInput => ({
    topic: 'service', value: 'Driving lessons', status: 'observed', sourceType: 'page',
    sourceRef: 'page-observation-1', reason: '', observedAt: 100, ...patch,
});
const confirmation = { confirmedAt: 300, confirmationRef: 'owner-message-1' };

function setup(db = memoryDb()) {
    const store = new PageBusinessStore(db);
    store.ensureSchema();
    return { db, store };
}

// Each rejection must preserve the whole record, including revision and provenance.
function rejectsWithoutMutation(store: PageBusinessStore, write: () => unknown, code: string, pageId = 'page-1') {
    const before = store.get(pageId);
    expect(write).toThrow(expect.objectContaining({ code }));
    expect(store.get(pageId)).toEqual(before);
}

describe('PageBusinessStore', () => {
    it('createsGenuineOwnerFactsWithTrustedMetadataAndCas', () => {
        const { store } = setup();
        store.ensure('page-1', null, 100);
        const saved = store.createOwnerFact('page-1', { topic: 'service', value: 'Lessons', reason: '' }, 0, confirmation);
        expect(saved).toMatchObject({ revision: 1, facts: [{ topic: 'service', value: 'Lessons', status: 'confirmed',
            sourceType: 'owner', sourceRef: confirmation.confirmationRef, ...confirmation, observedAt: 300, updatedAt: 300 }] });
        rejectsWithoutMutation(store, () => store.createOwnerFact('page-1', { topic: 'service', value: 'Other', reason: '' }, 0, confirmation), 'CONFLICT');
    });

    it('ownerFactRejectsClosedInputAndLimitsWithoutWriting', () => {
        const { store } = setup();
        store.ensure('page-1', null, 100);
        const fact = { topic: 'service', value: 'Lessons', reason: '' };
        for (const extra of [{ id: 'chosen' }, { sourceType: 'owner' }, { status: 'confirmed' }, { confirmedAt: 10 }, { sourceRef: 'fake' }]) {
            rejectsWithoutMutation(store, () => store.createOwnerFact('page-1', { ...fact, ...extra }, 0, confirmation), 'INVALID_PARAMS');
        }
        for (const [field, limit] of [['value', 2000], ['reason', 1000]] as const) {
            rejectsWithoutMutation(store, () => store.createOwnerFact('page-1', { ...fact, [field]: 'x'.repeat(limit + 1) }, 0, confirmation), 'LIMIT_EXCEEDED');
        }
        rejectsWithoutMutation(store, () => store.createOwnerFact('page-1', fact, 0, { ...confirmation, confirmationRef: 'x'.repeat(501) }), 'LIMIT_EXCEEDED');
        for (let i = 0; i < 100; i++) store.createOwnerFact('page-1', fact, i, confirmation);
        rejectsWithoutMutation(store, () => store.createOwnerFact('page-1', fact, 100, confirmation), 'LIMIT_EXCEEDED');
    });
    it('samePageSharesFactsAcrossProfiles', () => {
        const { store, db } = setup();
        expect(store.get('page-1')).toBeNull();
        expect(store.ensure('page-1', 'profile-1', 100)).toEqual({
            pageId: 'page-1', primaryProfileId: 'profile-1', revision: 0, updatedAt: 100,
            enabled: false, protectedSince: null, facts: [],
        });
        const saved = store.propose('page-1', input(), 0, 200);
        expect(store.ensure('page-1', 'profile-2', 999)).toEqual(saved);
        expect(store.list()).toHaveLength(1);
        expect(store.list()).toEqual([saved]);
        expect(new PageBusinessStore(db).get('page-1')).toEqual(saved);
        expect(() => store.ensureSchema()).not.toThrow();
    });

    it('roundTripsServerAssignedFactsAndUpdatesOnlyUnconfirmedFacts', () => {
        const { store } = setup();
        store.ensure('page-1', null, 100);
        const proposed = store.propose('page-1', input({ status: 'hypothesis', reason: 'Local audience', sourceType: 'research' }), 0, 200);
        const fact = proposed.facts[0];
        expect(fact).toEqual({ ...input({ status: 'hypothesis', reason: 'Local audience', sourceType: 'research' }),
            id: expect.any(String), updatedAt: 200, confirmedAt: null, confirmationRef: null });
        expect(fact.id).not.toBe('');
        const updated = store.propose('page-1', input({ id: fact.id, value: 'Weekend lessons' }), 1, 250);
        expect(updated).toMatchObject({ revision: 2, updatedAt: 250 });
        expect(updated.facts).toEqual([{ ...input(), id: fact.id, value: 'Weekend lessons', updatedAt: 250,
            confirmedAt: null, confirmationRef: null }]);
        rejectsWithoutMutation(store, () => store.propose('page-1', input({ id: 'runner-chosen-id' }), 2, 260), 'NOT_FOUND');
    });

    it('confirmedFactCannotBeOverwritten', () => {
        const { store } = setup();
        store.ensure('page-1', null, 100);
        const proposed = store.propose('page-1', input(), 0, 200);
        const fact = proposed.facts[0];
        const confirmed = store.confirmFact('page-1', fact.id, 1, confirmation);
        expect(confirmed).toMatchObject({ revision: 2, updatedAt: 300 });
        expect(confirmed.facts).toEqual([{ ...fact, status: 'confirmed', ...confirmation, updatedAt: 300 }]);
        rejectsWithoutMutation(store, () => store.propose('page-1', input({ id: fact.id, value: 'Guess' }), 2, 400), 'CONFLICT');
        rejectsWithoutMutation(store, () => store.confirmFact('page-1', fact.id, 2,
            { confirmedAt: 400, confirmationRef: 'another-message' }), 'CONFLICT');
        const replacement = store.propose('page-1', input({ value: 'New observation' }), 2, 400);
        expect(replacement.facts).toHaveLength(2);
        expect(replacement.facts.find((f) => f.id === fact.id)).toEqual(confirmed.facts[0]);
        expect(replacement.facts[1].id).not.toBe(fact.id);
    });

    it('staleRevisionRejectsWithoutMutation', () => {
        const { store, db } = setup();
        store.ensure('page-1', 'profile-1', 100);
        const other = new PageBusinessStore(db);
        const saved = store.propose('page-1', input(), 0, 200);
        rejectsWithoutMutation(store, () => other.propose('page-1', input(), 0, 400), 'CONFLICT');
        rejectsWithoutMutation(store, () => other.confirmFact('page-1', saved.facts[0].id, 0, confirmation), 'CONFLICT');
        rejectsWithoutMutation(store, () => other.setPrimaryProfile('page-1', 'profile-2', 0, confirmation), 'CONFLICT');
        rejectsWithoutMutation(store, () => other.setEnabled('page-1', true, 0, confirmation), 'CONFLICT');
    });

    it('trustedPrimaryAndEnabledChangesPreserveTheFirstProtectionTimestamp', () => {
        const { store } = setup();
        store.ensure('page-1', null, 100);
        expect(store.setPrimaryProfile('page-1', 'profile-1', 0, confirmation)).toMatchObject({
            primaryProfileId: 'profile-1', revision: 1, updatedAt: 300, protectedSince: null,
        });
        expect(store.setEnabled('page-1', true, 1, confirmation)).toMatchObject({ enabled: true, protectedSince: 300, revision: 2 });
        expect(store.setEnabled('page-1', false, 2, { ...confirmation, confirmedAt: 400 }))
            .toMatchObject({ enabled: false, protectedSince: 300, revision: 3, updatedAt: 400 });
        expect(store.setEnabled('page-1', true, 3, { ...confirmation, confirmedAt: 500 }))
            .toMatchObject({ enabled: true, protectedSince: 300, revision: 4 });
    });

    it('protectedPrimaryChangeCannotRaceARunningLegacyBrief', () => {
        const { store, db } = setup();
        store.ensure('page-1', 'profile-1', 100);
        store.setEnabled('page-1', true, 0, confirmation);
        const legacy = new DailyBriefStore(db, { date: () => '2026-10-27', minutes: () => 480 });
        legacy.saveBrief('profile-2', {}, 100);
        legacy.claimDue(100, () => true);
        rejectsWithoutMutation(store, () => store.setPrimaryProfile('page-1', 'profile-2', 1, confirmation), 'CONFLICT');
    });

    it('protectedPrimaryChangesStayProtectedEvenWhenDisabledOrIdentityChanges', () => {
        const { store, db } = setup();
        store.ensure('page-1', 'profile-1', 100);
        store.setEnabled('page-1', true, 0, confirmation);
        store.setEnabled('page-1', false, 1, confirmation);
        store.setPrimaryProfile('page-1', 'profile-2', 2, confirmation);
        const legacy = new DailyBriefStore(db, { date: () => '2026-10-27', minutes: () => 480 });
        legacy.saveBrief('profile-1', {}, 100);
        legacy.saveBrief('profile-2', {}, 100);
        expect(legacy.claimDue(100, () => true)).toEqual([]);
    });

    it('failedMetadataCasRollsBackTheEntireFirstHandoff', () => {
        const { store, db } = setup();
        store.ensure('page-1', 'profile-1', 100);
        const broken: SqlDatabase = { ...db, run(sql, params) {
            if (sql.includes('UPDATE page_business_profiles')) throw new Error('Write failed');
            db.run(sql, params);
        } };
        expect(() => new PageBusinessStore(broken).setEnabled('page-1', true, 0, confirmation)).toThrow('Write failed');
        expect(store.get('page-1')).toMatchObject({ enabled: false, protectedSince: null, revision: 0 });
        const legacy = new DailyBriefStore(db, { date: () => '2026-10-27', minutes: () => 480 });
        legacy.ensureSchema();
        legacy.saveBrief('profile-1', {}, 100);
        expect(legacy.claimDue(100, () => true).map((brief) => brief.profileId)).toEqual(['profile-1']);
    });

    it('limitsRejectWithoutDeletingProfilesAt10And11', () => {
        const { store } = setup();
        for (let i = 0; i < 10; i++) store.ensure(`page-${i}`, null, 100);
        const before = store.list();
        expect(() => store.ensure('page-10', null, 200)).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
        expect(store.list()).toEqual(before);
        expect(store.ensure('page-0', 'other-profile', 300)).toEqual(before.find((b) => b.pageId === 'page-0'));
        expect(store.propose('page-0', input(), 0, 400).facts).toHaveLength(1);
    });

    it('limitsRejectWithoutDeletingFactsAt100And101ButAllowAnExistingFactUpdate', () => {
        const { store } = setup();
        store.ensure('page-1', null, 100);
        for (let i = 0; i < 100; i++) store.propose('page-1', input(), i, 200 + i);
        rejectsWithoutMutation(store, () => store.propose('page-1', input(), 100, 400), 'LIMIT_EXCEEDED');
        const id = store.get('page-1')!.facts[0].id;
        expect(store.propose('page-1', input({ id, value: 'Updated lesson' }), 100, 401).facts).toHaveLength(100);
    });

    it.each([['value', 2000], ['reason', 1000], ['sourceRef', 500]] as const)
    ('limitsRejectWithoutDeletingAtThe%sBoundary(%i)', (field, max) => {
        const { store } = setup();
        store.ensure('page-1', null, 100);
        const saved = store.propose('page-1', input({ [field]: 'x'.repeat(max) }), 0, 200);
        expect(saved.facts[0][field]).toHaveLength(max);
        rejectsWithoutMutation(store, () => store.propose('page-1', input({ [field]: 'x'.repeat(max + 1) }), 1, 300), 'LIMIT_EXCEEDED');
    });

    it.each([
        { status: 'confirmed' }, { sourceType: 'owner' }, { confirmedAt: 300 }, { confirmationRef: 'forged-message' },
        { confirmedAt: null }, { confirmationRef: null }, { updatedAt: 300 }, { extra: true },
    ])('runnerCannotForgeConfirmation(%j)', (forged) => {
        const { store } = setup();
        store.ensure('page-1', null, 100);
        rejectsWithoutMutation(store, () => store.propose('page-1', { ...input(), ...forged } as PageFactInput, 0, 200), 'INVALID_PARAMS');
    });

    it.each([
        { topic: '' }, { value: '' }, { sourceRef: '' }, { reason: null }, { status: 'invalid' },
        { sourceType: 'invalid' }, { observedAt: NaN }, { observedAt: -1 }, { status: 'hypothesis', reason: '' },
    ])('rejectsMalformedFactsWithoutMutation(%j)', (invalid) => {
        const { store } = setup();
        store.ensure('page-1', null, 100);
        rejectsWithoutMutation(store, () => store.propose('page-1', { ...input(), ...invalid } as PageFactInput, 0, 200), 'INVALID_PARAMS');
    });

    it('doesNotCreateProfilesFromProposeOrLegacyPersonAndUnknownIdentities', () => {
        const { store, db } = setup();
        const legacy = new DailyBriefStore(db);
        legacy.ensureSchema();
        for (const kind of ['person', 'unknown'] as const) legacy.upsertIdentity({
            profileId: kind, kind, pageId: '', pageName: '', category: '', about: '', recentPosts: [],
            learnedAt: 100, errorCode: '', error: '',
        });
        expect(() => store.propose('missing', input(), 0, 200)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
        expect(() => store.ensure('', null, 100)).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
        expect(store.list()).toEqual([]);
        expect(legacy.listIdentities()).toHaveLength(2);
    });

    it('keepsFactsAndProfilesIsolatedByPageAndWorkspaceDatabase', () => {
        const { store } = setup();
        store.ensure('page-1', null, 100);
        store.ensure('page-2', null, 100);
        const saved = store.propose('page-1', input(), 0, 200);
        rejectsWithoutMutation(store, () => store.confirmFact('page-2', saved.facts[0].id, 0, confirmation), 'NOT_FOUND', 'page-2');
        expect(store.get('page-1')).toEqual(saved);
        expect(setup().store.list()).toEqual([]);
    });

    it('rejectsInvalidTrustedMetadataAndMutationInputsWithoutWriting', () => {
        const { store } = setup();
        store.ensure('page-1', null, 100);
        for (const metadata of [{ confirmedAt: NaN, confirmationRef: 'ref' }, { confirmedAt: 300, confirmationRef: '' }]) {
            rejectsWithoutMutation(store, () => store.setEnabled('page-1', true, 0, metadata),
                'INVALID_PARAMS');
        }
        rejectsWithoutMutation(store, () => store.setPrimaryProfile('page-1', '', 0, confirmation), 'INVALID_PARAMS');
        rejectsWithoutMutation(store, () => store.setEnabled('page-1', 'yes' as any, 0, confirmation), 'INVALID_PARAMS');
        rejectsWithoutMutation(store, () => store.propose('page-1', input(), NaN, 200), 'INVALID_PARAMS');
        rejectsWithoutMutation(store, () => store.propose('page-1', input(), 0, NaN), 'INVALID_PARAMS');
    });

    it('schemaIsAdditiveAndLeavesLegacyBriefsAndIdentitiesUnchanged', () => {
        const db = memoryDb();
        const legacy = new DailyBriefStore(db);
        legacy.ensureSchema();
        const brief = legacy.saveBrief('profile-1', { notes: 'Keep my brief' }, 100);
        const store = new PageBusinessStore(db);
        store.ensureSchema();
        store.ensure('page-1', 'profile-1', 200);
        store.propose('page-1', input(), 0, 300);
        expect(legacy.listBriefs()).toEqual([brief]);
        expect(legacy.listIdentities()).toEqual([]);
    });

    it.each(['profile-write', 'fact-write', 'commit'] as const)('rollsBackAndThrowsWhenTheDatabaseFailsAt%s', (stage) => {
        const db = memoryDb();
        const store = setup(db).store;
        const before = store.ensure('page-1', null, 100);
        const failing: SqlDatabase = {
            ...db,
            run(sql, params) {
                if ((stage === 'profile-write' && sql.includes('UPDATE page_business_profiles'))
                    || (stage === 'fact-write' && sql.includes('INSERT INTO page_business_facts'))) throw new Error('Write failed');
                db.run(sql, params);
            },
            transaction: (fn) => db.transaction(() => {
                const result = fn();
                if (stage === 'commit') throw new Error('Commit failed');
                return result;
            }),
        };
        expect(() => new PageBusinessStore(failing).propose('page-1', input(), 0, 200)).toThrow(/failed/);
        expect(store.get('page-1')).toEqual(before);
    });

    it('rollsBackIfTheCompareAndSetWritesNothing', () => {
        const db = memoryDb();
        const store = setup(db).store;
        const before = store.ensure('page-1', null, 100);
        const failing: SqlDatabase = { ...db, run(sql, params) {
            if (sql.includes('UPDATE page_business_profiles')) db.run('UPDATE page_business_profiles SET revision = revision WHERE 0');
            else db.run(sql, params);
        } };
        expect(() => new PageBusinessStore(failing).propose('page-1', input(), 0, 200)).toThrow();
        expect(store.get('page-1')).toEqual(before);
    });

    it.each(['changes', 'count', 'facts'] as const)('doesNotReportSuccessWhenDatabaseReadsReturnEmpty(%s)', (stage) => {
        const db = memoryDb();
        const store = setup(db).store;
        store.ensure('page-1', null, 100);
        store.propose('page-1', input(), 0, 200);
        const before = store.get('page-1');
        const failing: SqlDatabase = {
            ...db,
            query: (sql, params) => stage === 'facts' && sql.includes('page_business_facts') ? [] : db.query(sql, params),
            queryOne: (sql, params) => (stage === 'changes' && sql.includes('changes()'))
                || (stage === 'count' && sql.includes('COUNT(*)')) ? undefined : db.queryOne(sql, params),
        };
        expect(() => new PageBusinessStore(failing).propose('page-1', input(), 1, 300)).toThrow();
        expect(store.get('page-1')).toEqual(before);
    });
});
