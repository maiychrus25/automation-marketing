import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { startRelay, RelayHarness } from './relayHarness';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { memoryDb } from '../facebookPoster/helpers';
import { POSTER_PROXY_RULES } from '../../services/http/relayChannelPolicy';
import * as policy from '../../services/http/relayChannelPolicy';
import Logger from '../../utils/Logger';
import { RELAY_AUTH_BODY_MAX_BYTES, RELAY_JSON_BODY_MAX_BYTES } from '../../services/http/HttpRelayService';

// The boss runs an employee's poster commands: closed list -> module -> checkPosterRequest -> file paths -> handler with _fromRelay and the scope.
const SECRET = 'SECRET-POST-TEXT';
const params = (...ids: string[]) => JSON.stringify({ mode: 'group', text: SECRET, profiles: ids.map((profileId) => ({ profileId, targets: [] })) });
const post = (...ids: string[]) => ({ mode: 'group', text: SECRET, profiles: ids.map((profileId) => ({ profileId, targets: ['https://www.facebook.com/groups/123456789'] })) });

describe('boss relay: poster commands of an employee', () => {
  let relay: RelayHarness;
  const table = [
    { id: 'poster', assigned: [], modules: ['fb_poster'], profiles: ['p1', 'p2'] },
    { id: 'no-perm', assigned: [], modules: ['chat'], profiles: ['p1'] },
    { id: 'no-profiles', assigned: [], modules: ['fb_poster'], profiles: [] },
    { id: 'poster-acc', assigned: ['acc-x'], modules: ['fb_poster'], profiles: ['p1'] },
    { id: 'chat-acc', assigned: ['acc-x'], modules: ['chat'], profiles: [] },
  ];
  let tmp: string;
  let posterMedia: string;
  const sql = memoryDb();
  const warnings = () => (Logger.warn as jest.Mock).mock.calls.map((c) => String(c[0]));

  const send = async (channel: string, body: any, who = 'poster') => {
    const res = await fetch(relay.url + '/api/proxy/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${relay.tokenFor(who)}` },
      body: JSON.stringify({ channel, params: body }),
    });
    return (await res.json()) as any;
  };

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-poster-')));
    posterMedia = path.join(tmp, 'facebook-poster-media');
    for (const id of ['sched-mine', 'sched-other']) {
      fs.mkdirSync(path.join(posterMedia, id), { recursive: true });
      fs.writeFileSync(path.join(posterMedia, id, '01-a.png'), 'x');
    }
    fs.mkdirSync(path.join(posterMedia, 'sched-mine', 'revision-2-abc'), { recursive: true });
    fs.writeFileSync(path.join(posterMedia, 'sched-mine', 'revision-2-abc', '01-b.png'), 'x');
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'S');
    new FacebookPosterStore(sql).ensureSchema();
    const run = (q: string, p: unknown[] = []) => sql.run(q, p);
    run("INSERT INTO fb_poster_schedules (id, name, kind, params_json, created_at, updated_at) VALUES ('sched-mine', 'm', 'once', ?, 1, 1)", [params('p1')]);
    run("INSERT INTO fb_poster_schedules (id, name, kind, params_json, created_at, updated_at) VALUES ('sched-other', 'o', 'once', ?, 1, 1)", [params('p3')]);
    run("INSERT INTO fb_poster_runs (id, kind, mode, params_json, status, started_at) VALUES ('run-mine', 'post', 'group', ?, 'done', 1), ('run-other', 'post', 'group', ?, 'done', 1)", [params('p1'), params('p3')]);
    run("INSERT INTO fb_poster_campaigns (id, name, created_at, updated_at) VALUES ('c-mine', 'a', 1, 1), ('c-page', 'b', 1, 1)");
    run("INSERT INTO fb_poster_schedules (id, name, kind, params_json, campaign_id, created_at, updated_at) VALUES ('sched-camp', 'c', 'once', ?, 'c-page', 1, 1)", [params('p1')]);
    run("INSERT INTO fb_poster_schedules (id, name, kind, params_json, campaign_id, created_at, updated_at) VALUES ('sched-camp2', 'c', 'once', ?, 'c-mine', 1, 1)", [params('p1')]);
    sql.exec('CREATE TABLE page_campaign_links (campaign_id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT, page_id TEXT, profile_id TEXT, revision INTEGER, managed INTEGER, proposal_id TEXT, created_at INTEGER, deleted_at INTEGER)');
    run("INSERT INTO page_campaign_links VALUES ('c-page', 'w', 'pg', 'p1', 1, 1, 'pr', 1, NULL)");
    run("INSERT INTO fb_poster_runs (id, kind, mode, params_json, status, started_at, schedule_id) VALUES ('run-page', 'post', 'group', ?, 'done', 1, 'sched-camp')", [params('p1')]);
    fs.mkdirSync(path.join(posterMedia, 'sched-camp'), { recursive: true });
    fs.writeFileSync(path.join(posterMedia, 'sched-camp', '01-a.png'), 'x');

    relay = await startRelay({
      employees: table,
      browserProfiles: ['p1', 'p2', 'p3'],
      accounts: [{ zalo_id: 'acc-x', full_name: 'x', avatar_url: '', phone: '', is_business: 0, is_active: 1, channel: 'zalo' } as any],
      mediaRoot: path.join(tmp, 'media'),
    });
    fs.mkdirSync(path.join(tmp, 'media'), { recursive: true });
    relay.db.getDbPath = () => path.join(tmp, 'workspace.db');
    relay.db.query.mockImplementation((q: string, p?: unknown[]) => sql.query(q, p as any[]));
    relay.db.queryOne.mockImplementation((q: string, p?: unknown[]) => sql.queryOne(q, p as any[]));
    relay.db.queryStrict.mockImplementation((q: string, p?: unknown[]) => sql.query(q, p as any[]));
    relay.db.queryOneStrict.mockImplementation((q: string, p?: unknown[]) => sql.queryOne(q, p as any[]));
  });
  afterAll(async () => {
    await relay.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(() => { relay.handlerCalls.length = 0; (Logger.warn as jest.Mock).mockClear(); });

  describe('without the fb_poster permission', () => {
    test.each(Object.keys(POSTER_PROXY_RULES))('refuses %s with MODULE_FORBIDDEN and never runs the handler', async (channel) => {
      const handler = relay.registerIpcHandler(channel);
      const out = await send(channel, { profileId: 'p1', id: 'x', runId: 'x' }, 'no-perm');
      expect(out.success).toBe(false);
      expect(out.error).toContain('fb_poster');
      expect(handler).not.toHaveBeenCalled();
      expect(warnings().some((w) => w.includes('MODULE_FORBIDDEN') && w.includes(channel) && w.includes('no-perm'))).toBe(true);
    });
  });

  describe('channels an employee never reaches', () => {
    test.each(['engagement:approve', 'autonomy:stop', 'facebookPoster:leadExport', 'browserProfile:open', 'proxy:list', 'facebookPoster:takeMissed', 'facebookPoster:pickMedia'])('%s is CHANNEL_NOT_ALLOWED', async (channel) => {
      const handler = relay.registerIpcHandler(channel);
      const out = await send(channel, { profileId: 'p1' });
      expect(out.success).toBe(false);
      expect(handler).not.toHaveBeenCalled();
      expect(warnings().some((w) => w.includes('CHANNEL_NOT_ALLOWED') && w.includes(channel))).toBe(true);
    });
  });

  describe('profiles', () => {
    test('startWithAnUnassignedProfileIsRefusedAndTheHandlerNeverRuns', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:start');
      const out = await send('facebookPoster:start', { kind: 'post', params: post('p3') });
      expect(out).toMatchObject({ success: false, code: 'PROFILE_FORBIDDEN', error: 'Bạn không được dùng hồ sơ này' });
      expect(handler).not.toHaveBeenCalled();
      expect(warnings().some((w) => w.includes('PROFILE_FORBIDDEN') && w.includes('facebookPoster:start') && w.includes('poster'))).toBe(true);
      expect(warnings().join('\n')).not.toContain(SECRET);
    });

    test('theHandlerGetsTheRelayScopeNotTheOneTheEmployeeSent', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:start');
      const out = await send('facebookPoster:start', { kind: 'post', params: post('p1'), _profileScope: ['p3'], _fromRelay: false, auth: { cookies: 'mine' } });
      expect(out.success).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      const received = handler.mock.calls[0][1] as any;
      expect(received._profileScope).toEqual(['p1', 'p2']);
      expect(received._fromRelay).toBe(true);
      expect(received.auth).toBeUndefined();
      expect(received.kind).toBe('post');
    });

    test('anEmployeeWithoutAssignedProfilesGetsPROFILE_FORBIDDEN', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:scheduleList');
      const out = await send('facebookPoster:scheduleList', {}, 'no-profiles');
      expect(out).toMatchObject({ success: false, code: 'PROFILE_FORBIDDEN' });
      expect(handler).not.toHaveBeenCalled();
    });

    test('aMalformedRequestIsPARAMS_INVALID', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:getRun');
      const out = await send('facebookPoster:getRun', {});
      expect(out).toMatchObject({ success: false, code: 'PARAMS_INVALID', error: 'Yêu cầu không hợp lệ' });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('records', () => {
    test('scheduleDeleteOfAnotherProfilesScheduleIsRECORD_FORBIDDEN', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:scheduleDelete');
      expect(await send('facebookPoster:scheduleDelete', { id: 'sched-other' })).toMatchObject({ success: false, code: 'RECORD_FORBIDDEN', error: 'Bạn không có quyền với mục này' });
      expect(handler).not.toHaveBeenCalled();
      expect((await send('facebookPoster:scheduleDelete', { id: 'sched-mine' })).success).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('runsAreCheckedByTheirProfiles', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:getRun');
      expect((await send('facebookPoster:getRun', { runId: 'run-other' })).code).toBe('RECORD_FORBIDDEN');
      expect((await send('facebookPoster:getRun', { runId: 'run-mine' })).success).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('aPageManagedCampaignIsNeverUsableEvenWhenAllItsProfilesAreTheEmployees', async () => {
      for (const channel of ['facebookPoster:campaignGet', 'facebookPoster:campaignUpdate', 'facebookPoster:campaignDelete']) {
        const handler = relay.registerIpcHandler(channel);
        expect(await send(channel, { id: 'c-page', name: 'x' })).toMatchObject({ success: false, code: 'RECORD_FORBIDDEN' });
        expect(handler).not.toHaveBeenCalled();
        expect((await send(channel, { id: 'c-mine', name: 'x' })).success).toBe(true);
        expect(handler).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('browserProfile:list', () => {
    test('returnsOnlyTheAssignedProfilesWithoutTheFingerprint', async () => {
      const handler = relay.registerIpcHandler('browserProfile:list');
      handler.mockResolvedValue({
        success: true,
        profiles: [{ id: 'p1', name: 'One', group_id: 'g1', note: 'n', fingerprint: '{"ua":"x"}', proxy_password: 'pw' }, { id: 'p3', name: 'Three', group_id: 'g3', fingerprint: 'secret' }],
        groups: [{ id: 'g1', name: 'G1', extra: 1 }, { id: 'g3', name: 'G3' }],
        runningIds: ['p1', 'p3'],
      });
      const out = await send('browserProfile:list', {});
      expect(out.profiles).toEqual([{ id: 'p1', name: 'One', group_id: 'g1', note: 'n' }]);
      expect(out.groups).toEqual([{ id: 'g1', name: 'G1' }]);
      expect(out.runningIds).toEqual(['p1']);
      expect(JSON.stringify(out)).not.toMatch(/fingerprint|proxy_password|p3|secret/);
    });

    test('aFailureOfTheHandlerIsPassedOnAsAnError', async () => {
      const handler = relay.registerIpcHandler('browserProfile:list');
      handler.mockResolvedValue({ success: false, error: 'boom' });
      expect(await send('browserProfile:list', {})).toEqual({ success: false, error: 'boom' });
    });

    test('aFailedResultNeverCarriesAFilePathOfTheBossMachine', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:scheduleList');
      handler.mockResolvedValue({ success: false, error: "ENOENT: no such file or directory, open '/Users/Boss User/Library/Application Support/MaiHub/facebook-poster-media/s1/01-anh.png'" });
      const out = await send('facebookPoster:scheduleList', {});
      expect(out.success).toBe(false);
      expect(out.error).toContain('01-anh.png');
      expect(out.error).not.toMatch(/Users|Boss User|Application Support/);
    });
  });

  describe('files', () => {
    test('mediaPathsOutsideTheUploadsFolderArePATH_FORBIDDEN_atTheTopLevelAndInsideParamsParams', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:start');
      const secret = path.join(tmp, 'secret.txt');
      expect(await send('facebookPoster:start', { kind: 'post', params: { ...post('p1'), mediaPaths: [secret] } })).toMatchObject({ success: false, code: 'PATH_FORBIDDEN' });
      expect(await send('facebookPoster:start', { kind: 'post', params: post('p1'), mediaPaths: [secret] })).toMatchObject({ success: false, code: 'PATH_FORBIDDEN' });
      expect(await send('facebookPoster:start', { kind: 'post', params: { ...post('p1'), mediaPath: secret } })).toMatchObject({ success: false, code: 'PATH_FORBIDDEN' });
      expect(handler).not.toHaveBeenCalled();
      expect(warnings().join('\n')).not.toContain(secret);
    });

    test('aFileOfAScheduleInScopeIsAcceptedAndOfAScheduleOutOfScopeIsRefused', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:draftSave');
      const mine = path.join(posterMedia, 'sched-mine', '01-a.png');
      const revision = path.join(posterMedia, 'sched-mine', 'revision-2-abc', '01-b.png');
      const other = path.join(posterMedia, 'sched-other', '01-a.png');
      expect((await send('facebookPoster:draftSave', { id: 'sched-mine', params: { ...post('p1'), mediaPaths: [mine, revision] } })).success).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(await send('facebookPoster:draftSave', { params: { ...post('p1'), mediaPaths: [other] } })).toMatchObject({ success: false, code: 'PATH_FORBIDDEN' });
      expect(await send('facebookPoster:draftSave', { params: { ...post('p1'), mediaPaths: [path.join(posterMedia, 'sched-mine', '..', 'sched-other', '01-a.png')] } })).toMatchObject({ code: 'PATH_FORBIDDEN' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('aFileUploadedByTheEmployeeWithoutAnAccountIsAcceptedForAPosterCommand', async () => {
      const up = await fetch(`${relay.url}/api/media/upload`, {
        method: 'POST', headers: { Authorization: `Bearer ${relay.tokenFor('poster')}`, 'X-Filename': 'photo.png' }, body: Buffer.from('png'),
      });
      const { bossPath } = (await up.json()) as { bossPath: string };
      expect(bossPath).toContain(`${path.sep}_uploads${path.sep}`);
      const handler = relay.registerIpcHandler('facebookPoster:scheduleCreate');
      const out = await send('facebookPoster:scheduleCreate', { kind: 'once', params: { ...post('p1'), mediaPaths: [bossPath] } });
      expect(out.success).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('the closed list enforces the scope', () => {
    test('aRuleWithAScopeTheRelayDoesNotKnowIsRefused', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:active');
      const spy = jest.spyOn(policy, 'employeeChannelRule').mockReturnValue({ modules: [], account: 'none', scope: 'everything' } as any);
      try {
        const out = await send('facebookPoster:active', {});
        expect(out.success).toBe(false);
        expect(handler).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); }
    });

    test('everyPosterChannelRunsThroughTheCheckAndGetsTheScope', async () => {
      const seen: string[] = [];
      for (const channel of Object.keys(POSTER_PROXY_RULES)) {
        const handler = relay.registerIpcHandler(channel);
        if (channel === 'browserProfile:list') handler.mockResolvedValue({ success: true, profiles: [] });
        const body: any = { profileId: 'p1', id: 'sched-mine', runId: 'run-mine', postUrls: undefined, params: post('p1'), kind: 'post' };
        if (channel.endsWith('leadUpdate')) continue; // needs a lead row; covered by the lookup test
        if (channel.endsWith('campaignGet') || channel.endsWith('campaignUpdate') || channel.endsWith('campaignDelete')) body.id = 'c-mine';
        if (channel.endsWith('commentCollect')) continue; // needs tracked post urls; covered by posterAccess.test.ts
        const out = await send(channel, body);
        if (out.success !== true) throw new Error(`${channel} -> ${JSON.stringify(out)}`);
        expect((handler.mock.calls[0][1] as any)._profileScope).toEqual(['p1', 'p2']);
        seen.push(channel);
      }
      expect(seen.length).toBe(Object.keys(POSTER_PROXY_RULES).length - 2);
    });
  });

  describe('fix round 1: the check fails closed', () => {
    const lookupThrows = () => {
      const boom = () => { throw new Error('SQL boom'); };
      relay.db.queryStrict.mockImplementation(boom);
      relay.db.queryOneStrict.mockImplementation(boom);
    };
    const lookupWorks = () => {
      relay.db.queryStrict.mockImplementation((q: string, p?: unknown[]) => sql.query(q, p as any[]));
      relay.db.queryOneStrict.mockImplementation((q: string, p?: unknown[]) => sql.queryOne(q, p as any[]));
    };

    test.each([
      ['facebookPoster:scheduleDelete', { id: 'sched-mine' }],
      ['facebookPoster:getRun', { runId: 'run-mine' }],
      ['facebookPoster:campaignGet', { id: 'c-mine' }],
      ['facebookPoster:leadUpdate', { id: 5, status: 'won' }],
    ])('a lookup that throws refuses %s and the handler never runs', async (channel, body) => {
      const handler = relay.registerIpcHandler(channel);
      lookupThrows();
      try {
        expect(await send(channel, body)).toMatchObject({ success: false, code: 'RECORD_FORBIDDEN' });
        expect(handler).not.toHaveBeenCalled();
        expect(warnings().join('\n')).not.toContain('SQL boom');
      } finally { lookupWorks(); }
    });

    test('scheduleDeleteOfAnUnknownScheduleIsRefused', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:scheduleDelete');
      expect(await send('facebookPoster:scheduleDelete', { id: 'sched-unknown' })).toMatchObject({ success: false, code: 'RECORD_FORBIDDEN' });
      expect(handler).not.toHaveBeenCalled();
    });

    test('cancelOfARunTheDatabaseDoesNotKnowIsRefused', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:cancel');
      expect(await send('facebookPoster:cancel', { runId: 'run-unknown' })).toMatchObject({ success: false, code: 'RECORD_FORBIDDEN' });
      expect(handler).not.toHaveBeenCalled();
      expect((await send('facebookPoster:cancel', { runId: 'run-mine' })).success).toBe(true);
    });

    test.each(Object.keys(POSTER_PROXY_RULES))('relay pinned to another database refuses %s with WORKSPACE_MISMATCH', async (channel) => {
      const handler = relay.registerIpcHandler(channel);
      const service: any = (await import('../../services/http/HttpRelayService')).default.getInstance();
      service.pinnedDbPath = path.join(tmp, 'another-workspace.db');
      try {
        expect(await send(channel, { profileId: 'p1' })).toMatchObject({ success: false, code: 'WORKSPACE_MISMATCH', error: 'Máy Boss đang mở workspace khác. Đăng Facebook từ máy nhân viên tạm thời chưa dùng được.' });
        expect(handler).not.toHaveBeenCalled();
      } finally { service.pinnedDbPath = null; }
    });

    test('aPinnedPathEqualToTheActiveOneIsAllowed', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:active');
      const service: any = (await import('../../services/http/HttpRelayService')).default.getInstance();
      service.pinnedDbPath = `${tmp}${path.sep}.${path.sep}sub${path.sep}..${path.sep}workspace.db`; // same file; a different STRING (path.join would normalise it)
      expect(service.pinnedDbPath).not.toBe(path.join(tmp, 'workspace.db'));
      try {
        expect((await send('facebookPoster:active', {})).success).toBe(true);
        expect(handler).toHaveBeenCalledTimes(1);
      } finally { service.pinnedDbPath = null; }
    });
  });

  describe('fix round 1: Page-managed schedules stay with the boss', () => {
    test.each(['facebookPoster:scheduleUpdate', 'facebookPoster:scheduleDelete', 'facebookPoster:draftGet', 'facebookPoster:draftApprove'])('%s on a schedule of a Page-managed campaign is RECORD_FORBIDDEN', async (channel) => {
      const handler = relay.registerIpcHandler(channel);
      expect(await send(channel, { id: 'sched-camp', when: 'now' })).toMatchObject({ success: false, code: 'RECORD_FORBIDDEN' });
      expect(handler).not.toHaveBeenCalled();
    });

    test('itsMediaFolderIsRefusedByThePathCheck', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:draftSave');
      const file = path.join(posterMedia, 'sched-camp', '01-a.png');
      expect(await send('facebookPoster:draftSave', { params: { ...post('p1'), mediaPaths: [file] } })).toMatchObject({ success: false, code: 'PATH_FORBIDDEN' });
      expect(handler).not.toHaveBeenCalled();
    });

    test('aRunOfItIsRefused', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:getRun');
      expect(await send('facebookPoster:getRun', { runId: 'run-page' })).toMatchObject({ success: false, code: 'RECORD_FORBIDDEN' });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('fix round 1: poster uploads', () => {
    const upload = (who: string, headers: Record<string, string>) => fetch(`${relay.url}/api/media/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${relay.tokenFor(who)}`, 'X-Filename': 'photo.png', ...headers }, body: Buffer.from('png'),
    });
    const mediaRoot = () => path.join(tmp, 'media');

    test('withTheHeaderAndThePermissionTheFileGoesToUploadsEvenForAnEmployeeWithAnAccount', async () => {
      const res = await upload('poster-acc', { 'X-Upload-Area': 'Poster', 'X-Zalo-Id': 'whatever' });
      expect(res.status).toBe(200);
      const { bossPath } = (await res.json()) as { bossPath: string };
      expect(bossPath.startsWith(path.join(mediaRoot(), '_uploads') + path.sep)).toBe(true);
      expect(bossPath).not.toContain('acc-x');
      const handler = relay.registerIpcHandler('facebookPoster:scheduleCreate');
      expect((await send('facebookPoster:scheduleCreate', { kind: 'once', params: { ...post('p1'), mediaPaths: [bossPath] } }, 'poster-acc')).success).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      const rel = path.relative(mediaRoot(), bossPath).split(path.sep).join('/');
      expect((await fetch(`${relay.url}/api/media/${rel}`, { headers: { Authorization: `Bearer ${relay.tokenFor('poster-acc')}` } })).status).toBe(403);
    });

    test('withoutThePermissionItIs403AndNothingIsWritten', async () => {
      const before = fs.existsSync(path.join(mediaRoot(), '_uploads')) ? fs.readdirSync(path.join(mediaRoot(), '_uploads')).length : 0;
      const res = await upload('chat-acc', { 'X-Upload-Area': 'poster' });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ success: false, code: 'MODULE_FORBIDDEN' });
      const after = fs.existsSync(path.join(mediaRoot(), '_uploads')) ? fs.readdirSync(path.join(mediaRoot(), '_uploads')).length : 0;
      expect(after).toBe(before);
    });

    test('withoutTheHeaderAnEmployeeWithAnAccountStillUploadsToTheAccountFolder', async () => {
      const res = await upload('poster-acc', {});
      expect(res.status).toBe(200);
      expect(((await res.json()) as { bossPath: string }).bossPath).toContain(`${path.sep}acc-x${path.sep}`);
    });
  });

  describe('fix round 1: more relay-level cases', () => {
    test('relayKeysNestedInParamsParamsNeverReachTheHandler', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:scheduleCreate');
      await send('facebookPoster:scheduleCreate', { kind: 'once', params: { ...post('p1'), _profileScope: ['p3'], _fromRelay: false } });
      const received = handler.mock.calls[0][1] as any;
      expect(received.params).not.toHaveProperty('_profileScope');
      expect(received.params).not.toHaveProperty('_fromRelay');
      expect(received._profileScope).toEqual(['p1', 'p2']);
    });

    test('aRemovedPermissionOrAssignmentIsRefusedOnTheNextRequest', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:start');
      const me = table.find((e) => e.id === 'poster-acc')!;
      const original = { modules: me.modules, profiles: me.profiles };
      try {
        expect((await send('facebookPoster:start', { kind: 'post', params: post('p1') }, 'poster-acc')).success).toBe(true);
        me.profiles = [];
        expect(await send('facebookPoster:start', { kind: 'post', params: post('p1') }, 'poster-acc')).toMatchObject({ success: false, code: 'PROFILE_FORBIDDEN' });
        me.profiles = original.profiles; me.modules = ['chat'];
        expect(await send('facebookPoster:start', { kind: 'post', params: post('p1') }, 'poster-acc')).toMatchObject({ success: false, code: 'MODULE_FORBIDDEN' });
        expect(handler).toHaveBeenCalledTimes(1);
      } finally { me.modules = original.modules; me.profiles = original.profiles; }
    });

    test('anUnknownScopeIsCHANNEL_NOT_ALLOWED', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:active');
      const spy = jest.spyOn(policy, 'employeeChannelRule').mockReturnValue({ modules: [], account: 'none', scope: 'everything' } as any);
      try {
        await send('facebookPoster:active', {});
        expect(warnings().some((w) => w.includes('CHANNEL_NOT_ALLOWED'))).toBe(true);
        expect(handler).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); }
    });

    test('theModuleRefusalOfAPosterChannelCarriesItsCode', async () => {
      relay.registerIpcHandler('facebookPoster:active');
      expect(await send('facebookPoster:active', {}, 'no-perm')).toMatchObject({ success: false, code: 'MODULE_FORBIDDEN' });
    });
  });

  describe('bounded requests', () => {
    const raw = (body: string, token?: string) => fetch(relay.url + '/api/proxy/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body,
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) as any }));

    test('aBodyOverTheCapAnswers413AndTheHandlerIsNotCalled', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:scheduleList');
      const big = ' '.repeat(RELAY_JSON_BODY_MAX_BYTES + 1024);
      const res = await raw(big, relay.tokenFor('poster')).catch(() => ({ status: 0, body: {} as any }));
      // The server may close the socket while the client is still sending: either the 413 arrives or the connection is cut, never a handler call.
      if (res.status !== 0) expect(res).toEqual({ status: 413, body: { success: false, error: 'Yêu cầu quá lớn', code: 'BODY_TOO_LARGE' } });
      expect(handler).not.toHaveBeenCalled();
    });

    test('theCapCountsBytesNotCharacters', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:scheduleList');
      // 3-byte characters: fewer characters than the cap, more bytes than the cap.
      const body = JSON.stringify({ channel: 'facebookPoster:scheduleList', params: { pad: '€'.repeat(Math.ceil(RELAY_JSON_BODY_MAX_BYTES / 3) + 10) } });
      expect(body.length).toBeLessThan(RELAY_JSON_BODY_MAX_BYTES);
      const res = await raw(body, relay.tokenFor('poster')).catch(() => ({ status: 0, body: {} as any }));
      if (res.status !== 0) expect(res.status).toBe(413);
      expect(handler).not.toHaveBeenCalled();
    });

    test('anUnauthenticatedProxyRequestIs401WithoutReadingTheBody', async () => {
      const impl: any = (await import('../../services/http/HttpRelayService')).default.getInstance();
      const readBody = jest.spyOn(impl, 'readBody');
      try {
        const res = await raw('{"channel":' + ' '.repeat(2 * 1024 * 1024)).catch(() => ({ status: 0, body: {} as any }));
        if (res.status !== 0) expect(res.status).toBe(401);
        expect(readBody).not.toHaveBeenCalled();
      } finally { readBody.mockRestore(); }
    });

    /** Sends only the headers (with a declared length) and waits for the answer: a server that waits for the body never answers. */
    const declare = (urlPath: string, length: number, token?: string) => new Promise<number>((resolve, reject) => {
      const target = new URL(relay.url + urlPath);
      const req = http.request({ host: target.hostname, port: target.port, path: target.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': length, ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
        req.destroy();
      });
      req.on('error', reject);
      req.setTimeout(2000, () => { req.destroy(); resolve(-1); });
      req.flushHeaders();
    });

    test('aDeclaredLengthOverTheCapIsRefusedBeforeAnyByteIsRead', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:scheduleList');
      expect(await declare('/api/proxy/action', RELAY_JSON_BODY_MAX_BYTES + 1, relay.tokenFor('poster'))).toBe(413);
      expect(handler).not.toHaveBeenCalled();
    });

    test('loginAndHeartbeatBodiesAreCappedFarLower', async () => {
      expect(RELAY_AUTH_BODY_MAX_BYTES).toBe(64 * 1024);
      expect(await declare('/api/auth/login', RELAY_AUTH_BODY_MAX_BYTES + 1)).toBe(413);
      expect(await declare('/api/auth/heartbeat', RELAY_AUTH_BODY_MAX_BYTES + 1)).toBe(413);
    });

    test('anErrorWhileAuthenticatingAProxyRequestIsAnsweredNotThrown', async () => {
      const impl: any = (await import('../../services/http/HttpRelayService')).default.getInstance();
      const auth = jest.spyOn(impl, 'authenticateRequest').mockImplementation(() => { throw new Error('boom'); });
      try {
        const res = await raw('{}', relay.tokenFor('poster'));
        expect(res.status).toBe(401);
        expect(JSON.stringify(res.body)).not.toContain('boom');
      } finally { auth.mockRestore(); }
    });

    test('aMediaPathsListOverTheLimitIsRefusedBeforeAnyPathIsLookedUp', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:draftSave');
      const many = Array.from({ length: 11 }, (_, i) => path.join(posterMedia, 'sched-mine', `missing-${i}.png`));
      const refused = await send('facebookPoster:draftSave', { params: { ...post('p1'), mediaPaths: many } });
      expect(refused).toMatchObject({ success: false, code: 'PATH_FORBIDDEN' });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('traceability of poster writes', () => {
    const lines = () => (Logger.log as jest.Mock).mock.calls.map((c) => String(c[0])).filter((l) => l.includes('poster action'));
    beforeEach(() => (Logger.log as jest.Mock).mockClear());

    test('aSuccessfulWriteIsLoggedWithEmployeeChannelAndRefOnly', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:scheduleCreate');
      handler.mockResolvedValue({ success: true, schedule: { id: 'sched-new', name: SECRET } });
      await send('facebookPoster:scheduleCreate', { kind: 'once', params: post('p1') });
      expect(lines()).toEqual(['[HttpRelayService] poster action employee=poster channel=facebookPoster:scheduleCreate ref=sched-new']);
      expect(lines().join('')).not.toContain(SECRET);
    });

    test('theRefComesFromTheCheckedParamsWhenTheyNameARecord', async () => {
      const handler = relay.registerIpcHandler('facebookPoster:scheduleDelete');
      handler.mockResolvedValue({ success: true });
      await send('facebookPoster:scheduleDelete', { id: 'sched-mine' });
      expect(lines()).toEqual(['[HttpRelayService] poster action employee=poster channel=facebookPoster:scheduleDelete ref=sched-mine']);
    });

    test('aReadAndAFailedWriteAreNotLogged', async () => {
      relay.registerIpcHandler('facebookPoster:scheduleList').mockResolvedValue({ success: true, schedules: [] });
      relay.registerIpcHandler('facebookPoster:scheduleDelete').mockResolvedValue({ success: false, error: 'boom' });
      await send('facebookPoster:scheduleList', {});
      await send('facebookPoster:scheduleDelete', { id: 'sched-mine' });
      expect(lines()).toEqual([]);
    });
  });
});
