import * as fs from 'fs';
import * as path from 'path';
import { checkPosterRequest, filterBrowserProfileList, posterActionRef, PosterLookup, MAX_COLLECT_POST_URLS, MAX_PROFILE_IDS } from '../../services/http/posterAccess';
import { profileIdsOfStoredParams } from '../../services/facebookPoster/profileScope';
import { POSTER_CHANNEL_ROUTES } from '../../services/http/employeeChannelRoutes';

const ALLOWED = ['p1', 'p2'];
function lookup(over: Partial<PosterLookup> = {}): PosterLookup {
  return {
    scheduleProfiles: () => null, runProfiles: () => null, campaignProfiles: () => null, leadProfiles: () => null,
    trackedPostUrls: () => [], ...over,
  };
}
const post = (ids: unknown[]) => ({ mode: 'group', text: 't', profiles: ids.map((profileId) => ({ profileId, targets: ['g'] })) });
const ok = (channel: string, params: unknown, l = lookup(), allowed = ALLOWED) => {
  const r = checkPosterRequest(channel, params, allowed, l);
  if (!r.ok) throw new Error(`expected ok, got ${(r as { code: string }).code}`);
  return r.params;
};
const code = (channel: string, params: unknown, l = lookup(), allowed = ALLOWED) => {
  const r = checkPosterRequest(channel, params, allowed, l);
  return r.ok ? 'OK' : (r as { code: string }).code;
};

describe('rule 1: params', () => {
  test('notAPlainObjectIsInvalid', () => {
    for (const p of [[], 'x', 5, true]) expect(code('facebookPoster:active', p)).toBe('PARAMS_INVALID');
  });
  test('missingParamsAreTreatedAsEmpty', () => {
    expect(ok('facebookPoster:active', undefined)._profileScope).toEqual(ALLOWED);
    expect(ok('facebookPoster:active', null)._profileScope).toEqual(ALLOWED);
  });
  test('unknownOrNonProxyChannelFailsClosed', () => {
    for (const c of ['facebookPoster:nope', 'engagement:approve', 'facebookPoster:pickMedia', 'browserProfile:open', 'zalo:sendMessage', 'constructor', '']) {
      expect(code(c, {})).toBe('PARAMS_INVALID');
    }
  });
  test('employeeSuppliedScopeAndFromRelayAreDroppedAndNeverMutated', () => {
    const input = { _profileScope: ['x'], _fromRelay: false, note: 1 };
    const out = ok('facebookPoster:active', input);
    expect(out._profileScope).toEqual(ALLOWED);
    expect(out).not.toHaveProperty('_fromRelay');
    expect(out.note).toBe(1);
    expect(input).toEqual({ _profileScope: ['x'], _fromRelay: false, note: 1 });
    expect(out._profileScope).not.toBe(ALLOWED);
  });
});

describe('empty allowed list', () => {
  test('everyProxyChannelIsForbiddenExceptBrowserProfileList', () => {
    for (const [c, s] of Object.entries(POSTER_CHANNEL_ROUTES)) {
      if (s.route !== 'proxy') continue;
      expect(code(c, {}, lookup(), [])).toBe(c === 'browserProfile:list' ? 'OK' : 'PROFILE_FORBIDDEN');
    }
  });
});

describe('rule 2: profiles named in the params', () => {
  test('topLevelProfileIdMustBeAllowed', () => {
    expect(code('facebookPoster:listTracking', { profileId: 'p1' })).toBe('OK');
    expect(code('facebookPoster:listTracking', { profileId: 'x' })).toBe('PROFILE_FORBIDDEN');
  });
  test('topLevelProfileIdsMustBeAllowedAndAnArray', () => {
    expect(code('facebookPoster:trackPosts', { profileIds: ['p1', 'p2'] })).toBe('OK');
    expect(code('facebookPoster:trackPosts', { profileIds: ['p1', 'x'] })).toBe('PROFILE_FORBIDDEN');
    expect(code('facebookPoster:trackPosts', { profileIds: 'p1' })).toBe('PARAMS_INVALID');
  });
  test.each([[5], [{}], [['p1']], [' p1'], ['p1 '], ['']])('malformedProfileReference %j is invalid', (v) => {
    expect(code('facebookPoster:listTracking', { profileId: v })).toBe('PARAMS_INVALID');
    expect(code('facebookPoster:listGroups', { profileIds: [v] })).toBe('PARAMS_INVALID');
    expect(code('facebookPoster:start', { kind: 'post', params: post([v]) })).toBe('PARAMS_INVALID');
  });
  test('startPostChecksEveryProfileOfTheTargets', () => {
    expect(code('facebookPoster:start', { kind: 'post', params: post(['p1', 'p2']) })).toBe('OK');
    expect(code('facebookPoster:start', { kind: 'post', params: post(['p1', 'x']) })).toBe('PROFILE_FORBIDDEN');
  });
  test('startWithNoProfilesIsForbiddenForEveryKind', () => {
    expect(code('facebookPoster:start', { kind: 'post', params: post([]) })).toBe('PROFILE_FORBIDDEN');
    expect(code('facebookPoster:start', { kind: 'scan_groups', params: { profileIds: [] } })).toBe('PROFILE_FORBIDDEN');
    expect(code('facebookPoster:start', { kind: 'unknown', params: {} })).toBe('PROFILE_FORBIDDEN');
    expect(code('facebookPoster:start', {})).toBe('PROFILE_FORBIDDEN');
  });
  test('startOtherKinds', () => {
    expect(code('facebookPoster:start', { kind: 'scan_groups', params: { profileIds: ['p1'] } })).toBe('OK');
    expect(code('facebookPoster:start', { kind: 'scan_groups', params: { profileIds: ['x'] } })).toBe('PROFILE_FORBIDDEN');
    expect(code('facebookPoster:start', { kind: 'join', params: { profileId: 'p2', keywords: [] } })).toBe('OK');
    expect(code('facebookPoster:start', { kind: 'join', params: { profileId: 'x' } })).toBe('PROFILE_FORBIDDEN');
    expect(code('facebookPoster:start', { kind: 'collect_comments', params: { profileId: 'p1', postUrls: [] } })).toBe('OK');
    expect(code('facebookPoster:start', { kind: 'collect_comments', params: { profileId: 'x' } })).toBe('PROFILE_FORBIDDEN');
  });
  test('scheduleCreateAndDraftSaveAlwaysReadPostParamsWhateverTheOuterKind', () => {
    for (const c of ['facebookPoster:scheduleCreate', 'facebookPoster:draftSave']) {
      expect(code(c, { kind: 'once', params: post(['p1']) })).toBe('OK');
      expect(code(c, { kind: 'recurring', params: post(['p1', 'x']) })).toBe('PROFILE_FORBIDDEN');
      expect(code(c, { kind: 'once', params: post([]) })).toBe('PROFILE_FORBIDDEN');
      expect(code(c, { kind: 'once', params: { profileIds: ['p1'] } })).toBe('PROFILE_FORBIDDEN');
    }
  });
  test('draftSaveWithoutProfilesIsForbiddenEvenWhenUpdating', () => {
    expect(code('facebookPoster:draftSave', { params: post([]) })).toBe('PROFILE_FORBIDDEN');
    expect(code('facebookPoster:draftSave', { id: 'd1', params: post([]) })).toBe('PROFILE_FORBIDDEN');
  });
});

describe('rule 3: records by id', () => {
  const sched = (ids: string[] | null) => lookup({ scheduleProfiles: () => ids });
  test.each(['scheduleUpdate', 'scheduleDelete', 'draftGet', 'draftApprove'])('%s checks the schedule profiles', (name) => {
    const c = `facebookPoster:${name}`;
    expect(code(c, { id: 's1' }, sched(['p1']))).toBe('OK');
    expect(code(c, { id: 's1' }, sched(['p1', 'x']))).toBe('RECORD_FORBIDDEN');
    expect(code(c, { id: 's1' }, sched([]))).toBe('RECORD_FORBIDDEN');
    expect(code(c, { id: 's1' }, sched(null))).toBe(name === 'scheduleDelete' ? 'RECORD_FORBIDDEN' : 'OK');
    expect(code(c, {}, sched(['p1']))).toBe('PARAMS_INVALID');
  });
  test('scheduleUsingTwoProfilesWhenEmployeeHasOneIsForbidden', () => {
    expect(code('facebookPoster:scheduleUpdate', { id: 's1' }, sched(['p1', 'p2']), ['p1'])).toBe('RECORD_FORBIDDEN');
  });
  test('idsArePassedAsStringsAndOnlyStringsOrFiniteNumbersAreAccepted', () => {
    const seen: string[] = [];
    const l = lookup({ scheduleProfiles: (id) => { seen.push(id); return ['p1']; } });
    ok('facebookPoster:draftGet', { id: 7 }, l);
    ok('facebookPoster:draftGet', { id: 's9' }, l);
    expect(seen).toEqual(['7', 's9']);
    for (const bad of [NaN, Infinity, {}, ['s1'], true, null]) expect(code('facebookPoster:draftGet', { id: bad }, l)).toBe('PARAMS_INVALID');
  });
  test('draftSaveChecksAnExistingDraftOnlyWhenIdIsGiven', () => {
    const body = { params: post(['p1']) };
    expect(code('facebookPoster:draftSave', body, sched(['x']))).toBe('OK');
    expect(code('facebookPoster:draftSave', { ...body, id: 'd1' }, sched(['x']))).toBe('RECORD_FORBIDDEN');
    expect(code('facebookPoster:draftSave', { ...body, id: 'd1' }, sched(['p2']))).toBe('OK');
  });
  test('getRunAndCancelCheckTheRun', () => {
    const run = (ids: string[] | null) => lookup({ runProfiles: () => ids });
    for (const c of ['facebookPoster:getRun', 'facebookPoster:cancel']) {
      expect(code(c, { runId: 'r1' }, run(['p1']))).toBe('OK');
      expect(code(c, { runId: 'r1' }, run(['x']))).toBe('RECORD_FORBIDDEN');
      // getRun on an unknown run is harmless (the handler says not found); cancel acts on in-memory state, so it must resolve first.
      expect(code(c, { runId: 'r1' }, run(null))).toBe(c === 'facebookPoster:cancel' ? 'RECORD_FORBIDDEN' : 'OK');
    }
  });
  test('cancelOrGetRunWithoutRunIdIsInvalid', () => {
    expect(code('facebookPoster:cancel', {})).toBe('PARAMS_INVALID');
    expect(code('facebookPoster:getRun', {})).toBe('PARAMS_INVALID');
  });
  test('leadUpdateChecksTheLead', () => {
    const lead = (ids: string[] | null) => lookup({ leadProfiles: () => ids });
    expect(code('facebookPoster:leadUpdate', { id: 1, status: 'new' }, lead(['p1']))).toBe('OK');
    expect(code('facebookPoster:leadUpdate', { id: 1, status: 'new' }, lead(['x']))).toBe('RECORD_FORBIDDEN');
    expect(code('facebookPoster:leadUpdate', { id: 1 }, lead(null))).toBe('OK');
  });
  test('campaignByIdAllowsAnEmptyCampaignAndRefusesOneWithForeignProfiles', () => {
    const camp = (ids: string[] | null) => lookup({ campaignProfiles: () => ids });
    for (const c of ['facebookPoster:campaignGet', 'facebookPoster:campaignUpdate', 'facebookPoster:campaignDelete']) {
      expect(code(c, { id: 'c1' }, camp([]))).toBe('OK');
      expect(code(c, { id: 'c1' }, camp(['p1']))).toBe('OK');
      expect(code(c, { id: 'c1' }, camp(['p1', 'x']))).toBe('RECORD_FORBIDDEN');
      expect(code(c, { id: 'c1' }, camp(null))).toBe('OK');
    }
  });
  test('campaignIdAtTheTopLevelAndInsideThePostParamsIsChecked', () => {
    const camp = lookup({ campaignProfiles: (id) => (id === 'bad' ? ['x'] : ['p1']) });
    expect(code('facebookPoster:scheduleList', { campaignId: 'good' }, camp)).toBe('OK');
    expect(code('facebookPoster:scheduleList', { campaignId: 'bad' }, camp)).toBe('RECORD_FORBIDDEN');
    expect(code('facebookPoster:leadList', { campaignId: 'bad' }, camp)).toBe('RECORD_FORBIDDEN');
    expect(code('facebookPoster:start', { kind: 'post', params: { ...post(['p1']), campaignId: 'bad' } }, camp)).toBe('RECORD_FORBIDDEN');
    expect(code('facebookPoster:start', { kind: 'post', params: { ...post(['p1']), campaignId: 'good' } }, camp)).toBe('OK');
    expect(code('facebookPoster:scheduleCreate', { kind: 'once', campaignId: 'bad', params: post(['p1']) }, camp)).toBe('RECORD_FORBIDDEN');
    expect(code('facebookPoster:draftSave', { params: { ...post(['p1']), campaignId: 'bad' } }, camp)).toBe('RECORD_FORBIDDEN');
    expect(code('facebookPoster:draftApprove', { id: 's1', campaignId: 'bad' }, camp)).toBe('RECORD_FORBIDDEN');
    expect(code('facebookPoster:scheduleList', { campaignId: {} }, camp)).toBe('PARAMS_INVALID');
    expect(code('facebookPoster:scheduleList', { campaignId: null }, camp)).toBe('OK');
  });
  test('scheduleIdFilterGoesThroughScheduleProfiles', () => {
    const s = lookup({ scheduleProfiles: (id) => (id === 'bad' ? ['x'] : ['p1']) });
    for (const c of ['facebookPoster:listTracking', 'facebookPoster:postStats']) {
      expect(code(c, { scheduleId: 'good' }, s)).toBe('OK');
      expect(code(c, { scheduleId: 'bad' }, s)).toBe('RECORD_FORBIDDEN');
      expect(code(c, { scheduleId: [] }, s)).toBe('PARAMS_INVALID');
    }
  });
});

describe('rule 5: defaults replace "every profile"', () => {
  test.each(['checkLogins', 'trackPosts', 'listGroups'])('%s without profileIds uses the allowed profiles', (name) => {
    const c = `facebookPoster:${name}`;
    expect(ok(c, {}).profileIds).toEqual(ALLOWED);
    expect(ok(c, { profileIds: [] }).profileIds).toEqual(ALLOWED);
    expect(ok(c, { profileIds: ['p2'] }).profileIds).toEqual(['p2']);
    expect(ok(c, {}).profileIds).not.toBe(ALLOWED);
  });
  test('commentCollectKeepsOnlyTrackedUrlsOfTheAllowedProfiles', () => {
    const l = lookup({ trackedPostUrls: (ids) => (ids.join() === 'p1,p2' ? ['u1', 'u2'] : []) });
    expect(ok('facebookPoster:commentCollect', { postUrls: ['u1', 'evil'] }, l).postUrls).toEqual(['u1']);
    expect(ok('facebookPoster:commentCollect', {}, l).postUrls).toEqual(['u1', 'u2']);
    expect(code('facebookPoster:commentCollect', { postUrls: ['evil'] }, l)).toBe('PARAMS_INVALID');
    expect(code('facebookPoster:commentCollect', { postUrls: [] }, l)).toBe('PARAMS_INVALID');
    expect(code('facebookPoster:commentCollect', { postUrls: 'u1' }, l)).toBe('PARAMS_INVALID');
    expect(code('facebookPoster:commentCollect', {}, lookup())).toBe('PARAMS_INVALID');
  });
});

describe('rule 6 and channels without profile or record', () => {
  test.each(['campaignList', 'campaignCreate', 'listRuns', 'listComments', 'listPostedUrls', 'leadList', 'listLeadReplies', 'postStats', 'groupScores',
    'bestTimes', 'pageMetrics', 'active', 'getLoginStates', 'getTrackConfig', 'setTrackConfig', 'leadConfigGet', 'leadConfigSet', 'trackStatus',
    'trackCancel', 'commentCollectStatus', 'commentCollectCancel'])('%s passes with the scope attached', (name) => {
    const out = ok(`facebookPoster:${name}`, { days: 7, _profileScope: ['x'] });
    expect(out).toEqual({ days: 7, _profileScope: ALLOWED });
  });
  test('browserProfileListPasses', () => {
    expect(ok('browserProfile:list', {})._profileScope).toEqual(ALLOWED);
  });
});

describe('filterBrowserProfileList', () => {
  const result = {
    success: true,
    secretKey: 'boss',
    profiles: [
      { id: 'p1', name: 'A', group_id: 3, proxy_id: 9, fingerprint: { ua: 'x' }, note: 'n', last_opened_at: 1, created_at: 2, updated_at: 3 },
      { id: 'zz', name: 'B', group_id: 4, proxy_id: null, fingerprint: {}, note: '', last_opened_at: null, created_at: 2, updated_at: 3 },
    ],
    groups: [{ id: 3, name: 'G', color: 'red', sort_order: 0, created_at: 1 }, { id: 4, name: 'Other', color: 'blue', sort_order: 1, created_at: 1 }],
    runningIds: ['p1', 'zz'],
  };
  test('keepsAllowedProfilesWithFourFieldsOnly', () => {
    const out = filterBrowserProfileList(result, ALLOWED) as typeof result;
    expect(out.profiles).toEqual([{ id: 'p1', name: 'A', group_id: 3, note: 'n' }]);
    expect(out.runningIds).toEqual(['p1']);
    expect(out.success).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/fingerprint|proxy_id/);
  });
  test('onlyGroupsOfAllowedProfilesRemainWithIdAndNameOnly', () => {
    const out = filterBrowserProfileList(result, ALLOWED) as typeof result;
    expect(out.groups).toEqual([{ id: 3, name: 'G' }]);
    expect(JSON.stringify(out)).not.toMatch(/Other|color|sort_order/);
  });
  test('unknownTopLevelKeysAreNotForwarded', () => {
    expect(Object.keys(filterBrowserProfileList(result, ALLOWED) as object).sort()).toEqual(['groups', 'profiles', 'runningIds', 'success']);
    expect(Object.keys(filterBrowserProfileList({ ...result, success: undefined }, ALLOWED) as object)).not.toContain('success');
  });
  test('doesNotMutateAndFailsClosedOnBadShapes', () => {
    filterBrowserProfileList(result, ALLOWED);
    expect(result.profiles).toHaveLength(2);
    expect(filterBrowserProfileList(null, ALLOWED)).toEqual({ profiles: [], groups: [], runningIds: [] });
    expect(filterBrowserProfileList({ profiles: 'x' }, ALLOWED)).toEqual({ profiles: [], groups: [], runningIds: [] });
    expect((filterBrowserProfileList(result, []) as typeof result).profiles).toEqual([]);
  });
});

describe('fix round 1', () => {
  test('ownProtoKeysAreDroppedAtTopLevelAndInsidePostParams', () => {
    const input = JSON.parse(`{"__proto__":{"x":1},"constructor":1,"prototype":2,"kind":"post","params":{"__proto__":{"y":1},"constructor":1,"prototype":2,"profiles":[{"profileId":"p1"}]}}`);
    const out = ok('facebookPoster:start', input);
    for (const o of [out, out.params as object]) {
      for (const k of ['__proto__', 'constructor', 'prototype']) expect(Object.prototype.hasOwnProperty.call(o, k)).toBe(false);
    }
    expect((out.params as { profiles: unknown[] }).profiles).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(input, '__proto__')).toBe(true);
  });
  test('cancelWithoutRunIdIsInvalid', () => expect(code('facebookPoster:cancel', {})).toBe('PARAMS_INVALID'));
  test('capsMirrorTheHandlerConstants', () => {
    const root = path.join(__dirname, '../../..');
    const ipc = fs.readFileSync(path.join(root, 'electron/ipc/facebookPosterIpc.ts'), 'utf8');
    const research = fs.readFileSync(path.join(root, 'src/services/research/ResearchService.ts'), 'utf8');
    expect(Number(/const MAX_COLLECT_POST_URLS = (\d+);/.exec(ipc)?.[1])).toBe(MAX_COLLECT_POST_URLS);
    expect(Number(/export const MAX_PROFILE_IDS = (\d+);/.exec(research)?.[1])).toBe(MAX_PROFILE_IDS);
    expect([MAX_COLLECT_POST_URLS, MAX_PROFILE_IDS]).toEqual([50, 50]);
  });
  test('commentCollectFillIsCappedNewestFirstAndAnOversizedGivenListIsInvalid', () => {
    const many = Array.from({ length: 80 }, (_, i) => `u${i}`);
    const l = lookup({ trackedPostUrls: () => many });
    expect(ok('facebookPoster:commentCollect', {}, l).postUrls).toEqual(many.slice(0, 50));
    expect(ok('facebookPoster:commentCollect', { postUrls: many.slice(0, 50) }, l).postUrls).toHaveLength(50);
    expect(code('facebookPoster:commentCollect', { postUrls: many.slice(0, 51) }, l)).toBe('PARAMS_INVALID');
  });
  test('profileIdsDefaultIsCappedAtFifty', () => {
    const lots = Array.from({ length: 70 }, (_, i) => `q${i}`);
    for (const n of ['checkLogins', 'trackPosts', 'listGroups']) {
      expect(ok(`facebookPoster:${n}`, {}, lookup(), lots).profileIds).toEqual(lots.slice(0, 50));
    }
  });
  test('duplicatesArePinned', () => {
    expect(profileIdsOfStoredParams({ profiles: [{ profileId: 'a' }, { profileId: 'a' }], profileIds: ['a'], profileId: 'a' })).toEqual(['a']);
  });
  test('profilesAsObjectAndParamsAsJsonStringAreRefused', () => {
    expect(code('facebookPoster:start', { kind: 'post', params: { profiles: { profileId: 'p1' } } })).toBe('PROFILE_FORBIDDEN');
    expect(code('facebookPoster:start', { kind: 'post', params: JSON.stringify(post(['p1'])) })).toBe('PROFILE_FORBIDDEN');
    expect(code('facebookPoster:scheduleCreate', { kind: 'once', params: JSON.stringify(post(['p1'])) })).toBe('PROFILE_FORBIDDEN');
    expect(code('facebookPoster:draftSave', { params: JSON.stringify(post(['p1'])) })).toBe('PROFILE_FORBIDDEN');
  });
  test('draftSaveIdUndefinedIsNewAndNullIsInvalid', () => {
    expect(code('facebookPoster:draftSave', { id: undefined, params: post(['p1']) })).toBe('OK');
    expect(code('facebookPoster:draftSave', { id: null, params: post(['p1']) })).toBe('PARAMS_INVALID');
  });
  test('pageIdPassesThroughUnchanged', () => {
    expect(ok('facebookPoster:pageMetrics', { pageId: 'pg1', days: 7 })).toEqual({ pageId: 'pg1', days: 7, _profileScope: ALLOWED });
  });
});

describe('the two internal keys inside params.params (draftSave stores every key of the post params)', () => {
  test('areDroppedFromTheInnerParamsAndTheInputIsNotMutated', () => {
    const inner = { ...post(['p1']), _profileScope: ['p9'], _fromRelay: true };
    const out = ok('facebookPoster:draftSave', { params: inner }) as { params: Record<string, unknown> };
    expect(out.params).not.toHaveProperty('_profileScope');
    expect(out.params).not.toHaveProperty('_fromRelay');
    expect(out.params.text).toBe('t');
    expect(inner).toHaveProperty('_profileScope');
    const created = ok('facebookPoster:scheduleCreate', { kind: 'once', params: { ...post(['p1']), _profileScope: ['p9'] } }) as { params: Record<string, unknown> };
    expect(created.params).not.toHaveProperty('_profileScope');
  });
});

describe('scheduleDelete of a schedule the database does not know', () => {
  test('isRefusedBecauseTheHandlerWouldStillRemoveAMediaFolderNamedByTheId', () => {
    const l = (ids: string[] | null) => lookup({ scheduleProfiles: () => ids });
    expect(code('facebookPoster:scheduleDelete', { id: 's1' }, l(null))).toBe('RECORD_FORBIDDEN');
    expect(code('facebookPoster:scheduleDelete', { id: 's1' }, l(['p1']))).toBe('OK');
    expect(code('facebookPoster:scheduleUpdate', { id: 's1' }, l(null))).toBe('OK'); // the other schedule channels keep "not found" to the handler
  });
});

describe('request size caps (refused before any lookup)', () => {
  const many = Array.from({ length: 201 }, (_, i) => `p${i}`);
  const spyLookup = () => {
    const calls: string[] = [];
    const l = lookup({
      scheduleProfiles: () => { calls.push('schedule'); return null; }, runProfiles: () => { calls.push('run'); return null; },
      campaignProfiles: () => { calls.push('campaign'); return null; }, trackedPostUrls: () => { calls.push('tracked'); return []; },
    });
    return { l, calls };
  };
  test('moreThan200ProfileReferencesInTotalIsInvalid', () => {
    const { l, calls } = spyLookup();
    expect(code('facebookPoster:listRuns', { profileIds: many }, l, many)).toBe('PARAMS_INVALID');
    expect(code('facebookPoster:start', { kind: 'post', params: post(many) }, l, many)).toBe('PARAMS_INVALID');
    expect(code('facebookPoster:listRuns', { profileId: 'p0', profileIds: many.slice(0, 200) }, l, many)).toBe('PARAMS_INVALID'); // 201 in total
    expect(calls).toEqual([]);
  });
  test('exactly200ReferencesIsStillChecked', () => {
    expect(code('facebookPoster:listRuns', { profileIds: many.slice(0, 200) }, lookup(), many)).toBe('OK');
  });
  test('aPostUrlsArrayLongerThanTheCapIsInvalidBeforeAnyLookup', () => {
    const { l, calls } = spyLookup();
    const urls = Array.from({ length: MAX_COLLECT_POST_URLS + 1 }, (_, i) => `https://www.facebook.com/p/${i}`);
    expect(code('facebookPoster:commentCollect', { postUrls: urls }, l)).toBe('PARAMS_INVALID');
    expect(calls).toEqual([]);
  });
});

describe('posterActionRef', () => {
  test('prefersTheCheckedParamsThenTheResultAndNeverFreeText', () => {
    expect(posterActionRef({ id: 's1' }, {})).toBe('s1');
    expect(posterActionRef({ runId: 'r1' }, {})).toBe('r1');
    expect(posterActionRef({}, { schedule: { id: 's2', name: 'secret text' } })).toBe('s2');
    expect(posterActionRef({}, { campaign: { id: 'c3' } })).toBe('c3');
    expect(posterActionRef({}, { runId: 'r4' })).toBe('r4');
    expect(posterActionRef({ id: 7 }, {})).toBe('7');
  });
  test('missingOrUnsafeValuesGiveADash', () => {
    expect(posterActionRef({}, {})).toBe('-');
    expect(posterActionRef(undefined, undefined)).toBe('-');
    expect(posterActionRef({ id: 'a b\nforged line' }, {})).toBe('-');
    expect(posterActionRef({ id: 'x'.repeat(200) }, {})).toBe('-');
  });
});
