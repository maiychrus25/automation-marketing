import { memoryDb } from '../facebookPoster/helpers';
import { DailyBriefStore, BRIEF_NOT_RUNNING_ERROR } from '../../services/dailyBrief/DailyBriefStore';
import { BRIEF_NOT_FOUND_ERROR, createBriefOperations } from '../../services/dailyBrief/briefOperations';
import type { PageIdentity } from '../../models/dailyBrief';

const identity = (profileId = 'p1', kind: PageIdentity['kind'] = 'page'): PageIdentity => ({
    profileId, kind, pageId: '123', pageName: 'Trường lái xe', category: '', about: '', recentPosts: [],
    learnedAt: 1, errorCode: '', error: '',
});

function setup() {
    const store = new DailyBriefStore(memoryDb(), {
        date: (ms) => new Date(ms).toISOString().slice(0, 10),
        minutes: (ms) => new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes(),
    });
    store.ensureSchema();
    store.upsertIdentity(identity());
    let now = Date.parse('2026-10-26T07:00:00Z');
    const profileExists = jest.fn((_id: string) => true);
    const emitFinished = jest.fn();
    const ops = createBriefOperations({ store: () => store, now: () => now, profileExists, emitFinished });
    return { store, ops, profileExists, emitFinished, advance: (ms: number) => { now += ms; }, now };
}

describe('brief operations', () => {
    it('creates defaults, decorates reads with the current pageName, and updates only sent fields', () => {
        const { store, ops } = setup();
        expect(() => ops.save({ profileId: 'p1' })).toThrow(/keywords/);
        const saved = ops.save({ profileId: 'p1', keywords: ['lái xe'] }).brief;
        expect(saved).toMatchObject({ profileId: 'p1', pageName: 'Trường lái xe', keywords: ['lái xe'],
            time: '07:00', draftsPerDay: 1, enabled: true, niche: '', tone: '', notes: '', groupIds: [] });
        ops.save({ profileId: 'p1', notes: 'Bài ngắn', enabled: false, groupIds: [] });
        store.upsertIdentity({ ...identity(), pageName: 'Tên mới' });
        const brief = ops.get({ profileId: 'p1' }).brief;
        expect(brief).toMatchObject({ keywords: ['lái xe'], notes: 'Bài ngắn', enabled: false, pageName: 'Tên mới' });
        expect(ops.list()).toEqual({ briefs: [brief] });
        expect(ops.delete({ profileId: 'p1' })).toEqual({ deleted: true });
        expect(ops.list()).toEqual({ briefs: [] });
    });

    it.each(['person', 'unknown', 'missing'] as const)('rejects save for a %s identity', (kind) => {
        const { store, ops } = setup();
        if (kind !== 'missing') store.upsertIdentity(identity('other', kind));
        expect(() => ops.save({ profileId: 'other', keywords: ['x'] })).toThrow(/không phải Page/);
        expect(store.getBrief('other')).toBeUndefined();
    });

    it('rejects save for a removed profile even with a learned Page identity', () => {
        const { ops, profileExists } = setup();
        profileExists.mockReturnValue(false);
        expect(() => ops.save({ profileId: 'p1', keywords: ['x'] })).toThrow();
    });

    it('rejects row eleven but still permits an update at capacity', () => {
        const { store, ops } = setup();
        for (let i = 0; i < 11; i++) store.upsertIdentity(identity(`p${i}`));
        for (let i = 0; i < 10; i++) ops.save({ profileId: `p${i}`, keywords: ['x'] });
        expect(() => ops.save({ profileId: 'p10', keywords: ['x'] })).toThrow('Tối đa 10 kế hoạch Page');
        expect(ops.save({ profileId: 'p1', notes: 'Updated' }).brief.notes).toBe('Updated');
        expect(store.countBriefs()).toBe(10);
    });

    it.each([
        ['niche', 'x'.repeat(301)], ['tone', 'x'.repeat(501)], ['notes', 'x'.repeat(1001)],
        ['keywords', Array(11).fill('x')], ['keywords', ['x'.repeat(81)]], ['keywords', []],
        ['keywords', [1]], ['keywords', 'x'], ['keywords', ['']],
        ['groupIds', Array(21).fill('g')], ['groupIds', [1]], ['groupIds', 'g'],
        ['draftsPerDay', 0], ['draftsPerDay', 6], ['draftsPerDay', 1.5], ['draftsPerDay', '1'],
        ['time', '7:00'], ['time', '24:00'], ['time', '07:60'], ['time', '07:00\n'], ['time', 700],
        ['enabled', 1], ['niche', null], ['tone', {}], ['notes', 1],
    ])('rejects invalid %s before writing', (field, value) => {
        const { ops, store } = setup();
        expect(() => ops.save({ profileId: 'p1', keywords: ['x'], [field]: value })).toThrow();
        expect(store.countBriefs()).toBe(0);
    });

    it('accepts all field limits and allows clearing optional text and groups', () => {
        const { ops } = setup();
        const patch = { niche: 'n'.repeat(300), tone: 't'.repeat(500), notes: 'n'.repeat(1000),
            keywords: Array(10).fill('k'.repeat(80)), groupIds: Array(20).fill('g'), time: '23:59', draftsPerDay: 5 };
        expect(ops.save({ profileId: 'p1', ...patch }).brief).toMatchObject(patch);
        expect(ops.save({ profileId: 'p1', niche: '', tone: '', notes: '', groupIds: [] }).brief)
            .toMatchObject({ niche: '', tone: '', notes: '', groupIds: [] });
    });

    it('ignores state fields when creating and when editing a running brief', () => {
        const { ops } = setup();
        expect(ops.save({ profileId: 'p1', keywords: ['x'], status: 'running', attempts: 99,
            lastRunDate: '2026-10-26', claimedAt: 1 }).brief).toMatchObject({ status: 'idle', attempts: 0, lastRunDate: null, claimedAt: null });
        const claimed = ops.claimDue().briefs[0];
        const updated = ops.save({ profileId: 'p1', status: 'idle', attempts: 99, attemptDate: 'x',
            claimedAt: 1, claimedDate: 'x', lastRunDate: 'x', updatedAt: 1 }).brief;
        expect(updated).toEqual(claimed);
    });

    it.each(['get', 'delete'] as const)('%s reports an unknown brief', (method) => {
        const { ops } = setup();
        expect(BRIEF_NOT_FOUND_ERROR).toBe('Không tìm thấy kế hoạch Page');
        expect(() => ops[method]({ profileId: 'unknown' })).toThrow(BRIEF_NOT_FOUND_ERROR);
    });

    it.each([undefined, '', 1])('rejects invalid profileId %p', (profileId) => {
        const { ops } = setup();
        for (const method of ['save', 'get', 'delete', 'finish'] as const) {
            expect(() => ops[method]({ profileId, keywords: ['x'], claimedAt: 1, ok: true })).toThrow();
        }
    });

    it('claims only existing Page profiles and includes claim identity and pageName', () => {
        const { store, ops, profileExists, now } = setup();
        for (const id of ['p1', 'removed', 'person', 'unknown', 'unlearned']) store.saveBrief(id, { keywords: ['x'] }, now);
        store.upsertIdentity(identity('removed'));
        store.upsertIdentity(identity('person', 'person'));
        store.upsertIdentity(identity('unknown', 'unknown'));
        profileExists.mockImplementation((id: string) => id !== 'removed');
        expect(ops.claimDue().briefs).toEqual([expect.objectContaining({ profileId: 'p1', pageName: 'Trường lái xe', claimedAt: now })]);
        expect(ops.claimDue()).toEqual({ briefs: [] });
    });

    it('finishes successfully once and emits only the documented payload', () => {
        const { ops, emitFinished, now } = setup();
        ops.save({ profileId: 'p1', keywords: ['x'] });
        ops.claimDue();
        const params = { profileId: 'p1', claimedAt: now, ok: true, draftIds: ['d1'], extra: 1 };
        expect(ops.finish(params).brief).toMatchObject({ status: 'idle', lastRunDate: '2026-10-26' });
        expect(emitFinished).toHaveBeenCalledWith({ profileId: 'p1', pageName: 'Trường lái xe', ok: true, draftIds: ['d1'] });
        expect(() => ops.finish(params)).toThrow(BRIEF_NOT_RUNNING_ERROR);
        expect(emitFinished).toHaveBeenCalledTimes(1);
    });

    it('counts failures, defaults draftIds and truncates error to 500 characters', () => {
        const { ops, emitFinished, now } = setup();
        ops.save({ profileId: 'p1', keywords: ['x'] });
        ops.claimDue();
        expect(ops.finish({ profileId: 'p1', claimedAt: now, ok: false, error: 'e'.repeat(501) }).brief)
            .toMatchObject({ status: 'idle', attempts: 1, lastRunDate: null });
        expect(emitFinished).toHaveBeenCalledWith({ profileId: 'p1', pageName: 'Trường lái xe', ok: false, draftIds: [], error: 'e'.repeat(500), attempts: 1, attemptDate: '2026-10-26' });
    });

    it.each([
        { draftIds: 'd1' }, { draftIds: [1] }, { error: 1 }, { ok: 1 },
        { claimedAt: undefined }, { claimedAt: '1' }, { claimedAt: 1.5 }, { claimedAt: 0 },
    ])('rejects invalid finish params %p without state change or event', (patch) => {
        const { store, ops, emitFinished, now } = setup();
        ops.save({ profileId: 'p1', keywords: ['x'] });
        ops.claimDue();
        const before = store.getBrief('p1');
        expect(() => ops.finish({ profileId: 'p1', claimedAt: now, ok: true, ...patch })).toThrow();
        expect(store.getBrief('p1')).toEqual(before);
        expect(emitFinished).not.toHaveBeenCalled();
    });

    it('rejects a stale completion after reclaim and leaves the new run intact', () => {
        const { store, ops, advance, now, emitFinished } = setup();
        ops.save({ profileId: 'p1', keywords: ['x'] });
        ops.claimDue();
        advance(3600001);
        const reclaimed = ops.claimDue().briefs[0];
        expect(emitFinished).toHaveBeenCalledWith(expect.objectContaining({ ok: false, attempts: 1, attemptDate: '2026-10-26' }));
        emitFinished.mockClear(); // The expired claim emitted; the rejected stale finish must not.
        expect(() => ops.finish({ profileId: 'p1', claimedAt: now, ok: true })).toThrow(BRIEF_NOT_RUNNING_ERROR);
        expect(store.getBrief('p1')?.claimedAt).toBe(reclaimed.claimedAt);
        expect(emitFinished).not.toHaveBeenCalled();
        expect(ops.finish({ profileId: 'p1', claimedAt: reclaimed.claimedAt, ok: true }).brief.status).toBe('idle');
    });

    it('exhausts three failed attempts for ten Pages, then resets on the next day', () => {
        const { store, ops, now, advance, emitFinished } = setup();
        for (let i = 0; i < 10; i++) {
            store.upsertIdentity(identity(`p${i}`));
            ops.save({ profileId: `p${i}`, keywords: ['x'] });
        }
        for (let attempt = 1; attempt <= 3; attempt++) {
            const claimed = ops.claimDue().briefs;
            expect(claimed).toHaveLength(10);
            expect(ops.claimDue().briefs).toHaveLength(0);
            for (const brief of claimed) {
                expect(ops.finish({ profileId: brief.profileId, claimedAt: brief.claimedAt, ok: false }).brief.attempts).toBe(attempt);
            }
            advance(1);
        }
        expect(ops.claimDue().briefs).toHaveLength(0);
        expect(emitFinished).toHaveBeenCalledTimes(30);
        advance(86400000);
        expect(ops.claimDue().briefs).toHaveLength(10);
        for (const brief of store.listBriefs()) expect(brief).toMatchObject({ attempts: 0, status: 'running', claimedAt: now + 86400003 });
    });
});


test('filtered claims leave other Pages idle and validate the optional profileId', () => {
    const { store, ops, now } = setup();
    for (const id of ['p1', 'p2']) { store.upsertIdentity(identity(id)); ops.save({ profileId: id, keywords: ['x'] }); }
    for (const value of ['', ' ', null, 1]) expect(() => ops.claimDue({ profileId: value })).toThrow(/profileId/);
    expect(ops.claimDue({ profileId: 'p1' }).briefs.map((b) => b.profileId)).toEqual(['p1']);
    expect(store.getBrief('p2')).toMatchObject({ status: 'idle', claimedAt: null });
    expect(ops.claimDue().briefs).toEqual([expect.objectContaining({ profileId: 'p2', claimedAt: now })]);
});

test('expired terminal failures emit a completion snapshot once even without a new claim', () => {
    const { ops, emitFinished, advance } = setup();
    ops.save({ profileId: 'p1', keywords: ['x'] });
    ops.claimDue();
    for (let attempt = 1; attempt <= 3; attempt++) {
        advance(3600000);
        const claims = ops.claimDue().briefs;
        expect(claims).toHaveLength(attempt < 3 ? 1 : 0);
        expect(emitFinished).toHaveBeenLastCalledWith(expect.objectContaining({ profileId: 'p1', ok: false,
            draftIds: [], attempts: attempt, attemptDate: '2026-10-26' }));
    }
    ops.claimDue();
    expect(emitFinished).toHaveBeenCalledTimes(3);
});
