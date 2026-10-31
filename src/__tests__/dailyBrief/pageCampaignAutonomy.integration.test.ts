import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import { createCertificate } from '../../services/control/certificate';

// Existing-behavior composition: real IPC registry, HTTPS authorization, SQLite,
// scheduler, posting task and Python consumer. Only external boundaries are fake.
const NOW = Date.parse('2026-10-28T10:00:00Z');
const profiles: Record<string, string> = { alpha: '12345', beta: '54321', duplicate: '12345' };
const external = ['electron', 'xlsx', '../../services/database/DatabaseService', '../../utils/WorkspaceManager', '../../utils/AppModeManager',
    '../../services/control/ControlApiServer', '../../services/control/CertificateStore', '../../services/ai/AIAssistantService',
    '../../../electron/ipc/browserProfileIpc', '../../../electron/ipc/researchIpc', '../../../electron/ipc/videoIpc', '../../../electron/ipc/inboxMedia',
    '../../../electron/ipc/workspaceIpc', '../../services/event/EventBroadcaster', '../../services/file/FileStorageService',
    '../../services/http/HttpConnectionManager', '../../services/http/HttpRelayService', '../../utils/ConnectionManager'];
let cert: Awaited<ReturnType<typeof createCertificate>>;
let dir: string, port: number, time: number, gate: boolean | undefined;
let native: Database.Database, db: any, api: any, ipc: any, options: any;
let briefs: any, business: any, works: any, poster: any, campaigns: any, executions: any, inbox: any, researchStore: any, research: any;
let clicks: number, comments: number, wrongActor: boolean, fallback: boolean, acknowledgement: boolean;
let afterClick: () => void, afterFallback: () => void, navigate: () => Promise<void>;
let failBeforeTransaction: boolean;
let events: Array<{ channel: string; data: unknown }>;

beforeAll(async () => { cert = await createCertificate(); });
beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-composition-'));
    native = new Database(path.join(dir, 'workspace.db'));
    time = NOW; gate = true; clicks = 0; comments = 0; wrongActor = false; fallback = false; acknowledgement = true;
    afterClick = afterFallback = () => undefined; navigate = async () => undefined; failBeforeTransaction = false; events = [];
    jest.spyOn(Date, 'now').mockImplementation(() => time);
    const readFile = fs.readFileSync;
    const bridgeBytes = readFile(path.join(process.cwd(), 'tools/maihub-bridge/maihub_bridge.py'));
    jest.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => String(file).endsWith('maihub_bridge.py') ? bridgeBytes : (readFile as any)(file, ...args)) as any);
    db = {
        exec: (sql: string) => native.exec(sql), run: (sql: string, p: any[] = []) => { native.prepare(sql).run(...p); },
        runInsert: (sql: string, p: any[] = []) => Number(native.prepare(sql).run(...p).lastInsertRowid),
        query: (sql: string, p: any[] = []) => [...native.prepare(sql).all(...p)],
        queryOne: (sql: string, p: any[] = []) => native.prepare(sql).get(...p),
        transaction: (fn: () => any) => {
            if (failBeforeTransaction) { failBeforeTransaction = false; throw new Database.SqliteError('synthetic failure before transaction', 'SQLITE_IOERR'); }
            return native.transaction(fn)();
        },
        getDbPath: () => path.join(dir, 'workspace.db'),
        getSetting: (name: string) => name.includes('control') ? JSON.stringify({ enabled: true, port: 47321, allowList: ['127.0.0.1'], protectedWritesEnabled: gate }) : undefined,
        getBrowserProfileById: (id: string) => profiles[id] ? { id, name: id } : undefined,
        getBrowserProfiles: () => Object.keys(profiles).map(id => ({ id, name: id })),
    };
    jest.doMock(external[0], () => ({ app: { getPath: () => dir, getAppPath: () => process.cwd(), getVersion: () => '1.0' }, ipcMain: { handle() {} }, safeStorage: {}, dialog: {}, BrowserWindow: { getAllWindows: () => [] } }));
    jest.doMock(external[1], () => ({}));
    jest.doMock(external[2], () => ({ __esModule: true, default: { getInstance: () => db } }));
    jest.doMock(external[3], () => ({ __esModule: true, default: { getInstance: () => ({ getActiveWorkspace: () => ({ id: 'workspace' }) }) } }));
    jest.doMock(external[4], () => ({ __esModule: true, default: { getInstance: () => ({ isEmployeeMode: () => false }) } }));
    jest.doMock(external[5], () => {
        const actual = jest.requireActual('../../services/control/ControlApiServer');
        return { ...actual, ControlApiServer: class extends actual.ControlApiServer {
            constructor(o: any) { super({ ...o, port: 0, host: '127.0.0.1' }); options = o; }
            async start() { const result = await super.start(); port = result.port; return result; }
        } };
    });
    jest.doMock(external[6], () => ({ CertificateStore: class { async ensure() { return cert; } }, CertificateKeyUnreadableError: class extends Error {} }));
    jest.doMock(external[7], () => ({ __esModule: true, default: { getInstance: () => ({ getDefaultAssistant: () => null }) } }));
    jest.doMock(external[8], () => ({ isBrowserEngineInstalled: () => true, getBrowserProfileService: () => ({
        onAvailabilityChanged: () => () => {}, tryReserveAutomation: (profileId: string) => ({ profileId }),
        releaseAutomationReservation: () => {}, isRunning: () => false, canReserveAutomation: () => true,
        openForAutomation: async (id: string) => ({ context: { once: jest.fn(), pages: () => [browser(id)], cookies: async () => [{ name: 'c_user', value: 'synthetic' }] }, close: async () => undefined }), getRunningIds: () => [],
    }) }));
    jest.doMock(external[9], () => ({ researchOperations: {}, getResearchStore: () => researchStore, getResearchService: () => research, isResearchRunning: () => research?.isRunning() ?? false, cancelResearch: () => research?.stop(), retireResearchService: () => {}, cancelAndWaitResearch: async () => true }));
    jest.doMock(external[10], () => ({ videoOperations: {}, getPageWorkVideoOperations: () => ({}) }));
    jest.doMock(external[11], () => ({ getInboxMediaStore: () => inbox }));
    jest.doMock(external[12], () => ({ isWorkspaceSwitchInProgress: () => false }));
    jest.doMock(external[13], () => ({ __esModule: true, default: { emit: (channel: string, data: unknown) => events.push({ channel, data }) } }));
    for (const name of external.slice(14)) jest.doMock(name, () => ({ __esModule: true, default: { getInstance: () => ({}), getAllConnections: () => new Map() } }));
    loadRuntime();
    await api.restartControlApi();
});
function loadRuntime() {
    jest.isolateModules(() => {
        db.exec(require('../../services/control/ControlStore').CONTROL_SCHEMA_SQL);
        poster = new (require('../../services/facebookPoster/FacebookPosterStore').FacebookPosterStore)(db); poster.ensureSchema();
        inbox = new (require('../../services/control/InboxMediaStore').InboxMediaStore)(path.join(dir, 'inbox'));
        new (require('../../services/video/VideoStore').VideoStore)(db).ensureSchema();
        ipc = require('../../../electron/ipc/facebookPosterIpc'); api = require('../../../electron/ipc/controlApiIpc');
        briefs = new (require('../../services/dailyBrief/DailyBriefStore').DailyBriefStore)(db);
        business = new (require('../../services/dailyBrief/PageBusinessStore').PageBusinessStore)(db);
        works = new (require('../../services/dailyBrief/PageWorkStore').PageWorkStore)(db); works.ensureSchema();
        campaigns = new (require('../../services/dailyBrief/PageCampaignStore').PageCampaignStore)(db); campaigns.ensureSchema();
        executions = new (require('../../services/dailyBrief/PageCampaignExecutionStore').PageCampaignExecutionStore)(db); executions.ensureSchema();
        researchStore = new (require('../../services/research/ResearchStore').ResearchStore)(db); researchStore.ensureSchema();
        research = new (require('../../services/research/ResearchService').ResearchService)({ store: researchStore, ...ipc.getProfileJobBinding(),
            listProfiles: () => db.getBrowserProfiles(), isProfileBusy: () => false, loginStates: () => [], groupMembership: () => ({}),
            readConfig: () => ({ excludedProfileIds: [], perProfileDailyCap: 100 }), observeLogin() {}, emit() {}, now: Date.now, sleep: async () => undefined,
            openSession: async () => { throw new Error('No external research session authorized by this fixture'); },
        });
    });
}
async function restart() {
    await api.shutdownControlApi(); native.close(); native = new Database(path.join(dir, 'workspace.db'));
    loadRuntime(); await api.restartControlApi();
}
afterEach(async () => {
    ipc?.stopFacebookPosterScheduler(); await api?.shutdownControlApi();
    jest.useRealTimers(); external.forEach(name => jest.dontMock(name)); jest.restoreAllMocks();
    native?.close(); fs.rmSync(dir, { recursive: true, force: true });
});
function browser(id: string): any {
    const click = async () => { clicks++; afterClick(); };
    return {
        url: () => 'https://www.facebook.com/', content: async () => {
            const pageId = wrongActor ? '99998' : profiles[id];
            const actor = { id: '99999', is_profile_plus: true, delegate_page_id: pageId };
            const data = { viewer: { actor }, user: { id: '99999', delegate_page: { id: pageId, name: 'Page', viewer: { actor } } } };
            return '<script type="application/json">' + JSON.stringify({ define: [['CurrentUserInitialData', [], { USER_ID: '99999' }]], require: [['RelayPrefetchedStreamCache', 'next', [], [null, { __bbox: { result: { data } } }]]] }) + '</script>';
        }, goto: () => navigate(), $: async () => null, on() {}, off() {},
        evaluate: async (fn: { name: string }) => ['composerIsOpenInPage', 'focusEditorInPage'].includes(fn.name) || fn.name === 'markPublishButtonInPage' && !fallback,
        locator: (selector: string) => ({ first: () => ({ click: selector.includes('publish') ? click : async () => undefined }) }), keyboard: { type: async () => undefined, press: async (key: string) => { if (key === 'Enter') comments++; } },
        waitForSelector: async (selector: string, opts?: { state?: string }) => {
            if (opts?.state === 'hidden' && !acknowledgement) throw new Error('synthetic missing acknowledgement');
            if (opts?.state === 'visible' && selector.includes('aria-label="Post"')) { if (fallback) afterFallback(); return { click }; }
            return null;
        },
    };
}
function seed(profileId = 'alpha') {
    const pageId = profiles[profileId];
    briefs.upsertIdentity({ profileId, kind: 'page', pageId, pageName: '', category: '', about: '', recentPosts: [], learnedAt: time, errorCode: '', error: '' });
    briefs.saveBrief(profileId, { time: '00:00', draftsPerDay: 1 }, time);
    if (!business.get(pageId)) { business.ensure(pageId, profileId, time); business.setEnabled(pageId, true, 0, { confirmedAt: time, confirmationRef: 'synthetic-owner' }); }
}
function key(kind = 'page_runner', profileIds = ['alpha']) {
    const assignments = [...new Set(profileIds.map(id => profiles[id]))].map(pageId => ({ pageId, profileIds: profileIds.filter(id => profiles[id] === pageId) }));
    return options.store.createKey(kind, { kind, workspaceId: 'workspace', assignments, ...(kind === 'page_receiver' ? { ownerChatId: '1', ownerSenderId: '2' } : {}) });
}
function call(credential: any, method: string, params = {}, extra = {}): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = https.request({ host: '127.0.0.1', port, path: '/v1/call', method: 'POST', rejectUnauthorized: false, agent: false,
            headers: { authorization: `Bearer ${credential.key}`, 'content-type': 'application/json' } }, res => {
            const chunks: Buffer[] = []; res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
        }); req.on('error', reject); req.end(JSON.stringify({ method, params, ...extra }));
    });
}
async function ok(credential: any, method: string, params = {}, extra = {}) {
    const reply = await call(credential, method, params, extra); expect(reply.body.error).toBeUndefined(); expect(reply.status).toBe(200); return reply.body.result;
}
const lease = (work: any) => ({ workId: work.id, claimedAt: work.claimedAt });
function bridge(credential: any, script: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const child = spawn('python3', ['-I', '-B', '-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('bridge', sys.argv[1])
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
p = json.load(sys.stdin)
b.time.time = lambda: p['now'] / 1000
client = b.MaiHubClient(b.Config(p['url'], p['key'], p['pin']))
state = p['state']
exec(p['script'])
`, path.join(process.cwd(), 'tools/maihub-bridge/maihub_bridge.py')]);
        let out = '', error = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { error += d; });
        child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(error)));
        child.stdin.end(JSON.stringify({ url: `https://127.0.0.1:${port}`, key: credential.key, pin: cert.fingerprintSha256, state: path.join(dir, `receiver-${credential.id}.json`), now: time, script }));
    });
}
async function setupCampaign(profileId = 'alpha') {
    seed(profileId); const runner = key('page_runner', [profileId]), receiver = key('page_receiver', [profileId]);
    const pageId = profiles[profileId], work = (await ok(runner, 'pageWork.claimDue', { pageId })).work;
    const runAt = time + 120000, minute = new Date(runAt).getHours() * 60 + new Date(runAt).getMinutes();
    const proposal = await ok(runner, 'pageCampaigns.propose', { ...lease(work), expectedRevision: null, input: { name: `Local pilot ${profileId}`, goal: 'Engagement', policy: {
        startsAt: time, expiresAt: time + 604800000, maxPostsPerDay: 1, maxPostsTotal: 7, allowedMinutes: [minute],
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, actions: ['schedulePost', 'updateScheduledPost'],
    } } });
    const accepted = await bridge(receiver, `
class Sender:
    def send_once(self, text): return {'chat': {'id': 1}, 'message_id': ${profileId === 'alpha' ? 10 : 30}}
action = {'kind': 'grantCampaign', 'pageId': '${pageId}', 'proposalId': '${proposal.id}', 'expectedProposalRevision': 1}
entry = b.ProtectedWatcher(client, Sender(), state).deliver(['proposal', '${proposal.id}'], '', action)
update = {'update_id': ${profileId === 'alpha' ? 1 : 2}, 'message': {'message_id': ${profileId === 'alpha' ? 11 : 31}, 'chat': {'id': 1}, 'from': {'id': 2}, 'text': 'ok', 'reply_to_message': {'message_id': ${profileId === 'alpha' ? 10 : 30}}}}
print(json.dumps(b.handle_owner_update(client, update, entry['ticket'])))
`);
    const listing = await ok(runner, 'pageCampaigns.list', { pageId });
    const campaignId = listing.campaigns[0].campaignId;
    const current = await ok(runner, 'pageCampaigns.get', { pageId, campaignId });
    expect(accepted.replayed).toBe(false); expect(current.latestDecision).toBeNull();
    const draft = await ok(runner, 'pageWork.saveDraft', { ...lease(work), draftIndex: 0, draft: { text: 'Synthetic composition draft', variants: ['Synthetic alternative'], comment: 'Synthetic first comment', campaignId } });
    const input = { campaignId, grantId: current.grants[0].id, expectedGrantRevision: 1, draftId: draft.draftId, expectedDraftRevision: draft.revision, runAt, variant: 'A', factIds: [] };
    return { runner, receiver, work, proposal, pageId, campaignId, draft, input };
}
async function runScheduler(runAt: number) {
    time = runAt;
    jest.useFakeTimers({ doNotFake: ['Date', 'nextTick', 'setImmediate'] });
    try {
        ipc.startFacebookPosterScheduler();
        for (let i = 0; i < 100; i++) {
            await jest.advanceTimersByTimeAsync(1000);
            if (!ipc.isFacebookPosterBusy() && db.query('SELECT * FROM fb_poster_runs').length) break;
        }
    } finally { ipc.stopFacebookPosterScheduler(); jest.useRealTimers(); }
}

test.each(['direct', 'fallback'])('owner-confirmed campaign reaches real scheduler and records unconfirmed target without autonomous comment (%s)', async route => {
    fallback = route === 'fallback';
    const s = await setupCampaign();
    await ok(s.runner, 'pageCampaigns.schedule', { ...lease(s.work), input: s.input });
    expect(executions.get(s.draft.draftId).status).toBe('reserved');
    await runScheduler(s.input.runAt);
    expect(clicks).toBe(1); expect(comments).toBe(0);
    expect(executions.get(s.draft.draftId).status).toBe('posted');
    const posts = campaigns.listPublished({ workspaceId: 'workspace', pageId: s.pageId, profileId: 'alpha' }, s.campaignId);
    expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ postId: null, sourceRef: null, reason: 'unconfirmed_post_target' });
    const report = await ok(s.receiver, 'pageCampaigns.report', { pageId: s.pageId, campaignId: s.campaignId });
    expect(report.published).toBe(1); expect(report.totalEngagement).toBeNull();
    expect(report.finance).toEqual({ status: 'unavailable', reason: 'missing_financial_source' });
    expect(JSON.stringify(report)).not.toContain(s.runner.key); expect(JSON.stringify(events)).not.toContain(s.receiver.key);
    await ok(s.runner, 'pageWork.finish', { ...lease(s.work), reason: 'Synthetic posted outcome', evidenceRefs: [] });
    time += 86400000; await restart();
    const next = (await ok(s.runner, 'pageWork.claimDue', { pageId: s.pageId })).work;
    expect(await ok(s.runner, 'pageCampaigns.collect', { ...lease(next), campaignId: s.campaignId })).toEqual({ checked: 1, measured: 0, unavailable: 1 });
    expect(db.query('SELECT * FROM research_scans')).toHaveLength(0);
    expect(campaigns.listMeasurements({ workspaceId: 'workspace', pageId: s.pageId, profileId: 'alpha' }, s.campaignId)[0].reason).toBe('unconfirmed_post_target');
});

// Catches scope widening and the erroneous multiplication of a Page budget by profiles.
test('two Pages reserve independently while a duplicate profile cannot borrow campaign authority', async () => {
    const a = await setupCampaign(), b = await setupCampaign('beta'); seed('duplicate');
    await ok(a.runner, 'pageCampaigns.schedule', { ...lease(a.work), input: a.input });
    await ok(b.runner, 'pageCampaigns.schedule', { ...lease(b.work), input: b.input });
    expect(db.query('SELECT * FROM page_campaign_executions')).toHaveLength(2);
    const duplicate = key('page_runner', ['duplicate']);
    expect((await call(duplicate, 'pageCampaigns.get', { pageId: a.pageId, campaignId: a.campaignId })).body.error.code).toBe('FORBIDDEN');
    expect((await call(b.runner, 'pageCampaigns.schedule', { ...lease(a.work), input: a.input })).body.error.code).toBe('FORBIDDEN');
    expect((await ok(key('page_runner', ['alpha', 'duplicate']), 'pageWork.claimDue', { pageId: a.pageId })).work).toBeNull();
    const projection = await ok(a.receiver, 'pageWork.events', { after: 0, timeoutSec: 0 });
    expect(JSON.stringify(projection)).toContain(a.campaignId); expect(JSON.stringify(projection)).not.toContain(b.campaignId);
    expect(JSON.stringify(projection)).not.toMatch(/receiverKeyId|confirmationRef|authorityFingerprint/);
    expect(clicks).toBe(0);
});

// Catches a concurrent worker multiplying a Page budget or inheriting autonomous first-comment authority.
test('two Page campaigns due together run as concurrent managed workers without multiplying quota or commenting', async () => {
    const a = await setupCampaign(), b = await setupCampaign('beta');
    await ok(a.runner, 'pageCampaigns.schedule', { ...lease(a.work), input: a.input });
    await ok(b.runner, 'pageCampaigns.schedule', { ...lease(b.work), input: b.input });
    expect(a.input.runAt).toBe(b.input.runAt);
    const liveAtClick: number[] = [];
    afterClick = () => { liveAtClick.push(ipc.posterOperations.active().runs.length); };
    await runScheduler(a.input.runAt);
    expect(clicks).toBe(2); expect(comments).toBe(0);
    expect(Math.max(...liveAtClick)).toBe(2);
    const runs = db.query('SELECT schedule_id, status FROM fb_poster_runs ORDER BY schedule_id');
    expect(runs).toEqual([a.draft.draftId, b.draft.draftId].sort().map(id => ({ schedule_id: id, status: 'done' })));
    for (const s of [a, b]) {
        const pageQuotaUsed = db.query("SELECT * FROM page_campaign_executions WHERE campaign_id=? AND status='posted'", [s.campaignId]).length;
        expect(pageQuotaUsed).toBe(1);
        expect(campaigns.listPublished({ workspaceId: 'workspace', pageId: s.pageId, profileId: s === a ? 'alpha' : 'beta' }, s.campaignId)).toHaveLength(1);
    }
    expect(db.query("SELECT profile_id FROM fb_poster_results WHERE outcome='posted' ORDER BY profile_id")).toEqual([{ profile_id: 'alpha' }, { profile_id: 'beta' }]);
});

// Catches a concurrent owner run on the same Page being hidden from the campaign's daily limit.
test('same-Page owner and campaign schedules due together publish exactly once within the daily limit', async () => {
    const s = await setupCampaign();
    await ok(s.runner, 'pageCampaigns.schedule', { ...lease(s.work), input: s.input });
    ipc.posterOperations.scheduleCreate({ kind: 'once', runAt: s.input.runAt, params: {
        mode: 'page', text: 'Synthetic owner post', mediaPaths: [], profiles: [{ profileId: 'alpha', targets: ['https://www.facebook.com/'] }],
    } });
    const liveAtClick: number[] = [];
    afterClick = () => { liveAtClick.push(ipc.posterOperations.active().runs.length); };
    await runScheduler(s.input.runAt);
    expect(clicks).toBe(1); expect(comments).toBe(0); expect(liveAtClick).toEqual([2]);
    expect(executions.get(s.draft.draftId).status).not.toBe('posted');
    expect(db.query("SELECT r.outcome FROM fb_poster_results r JOIN fb_poster_runs u ON u.id=r.run_id ORDER BY u.campaign_id IS NULL")).toEqual([{ outcome: 'failed' }, { outcome: 'posted' }]);
    const campaignRun = db.query('SELECT id FROM fb_poster_runs WHERE campaign_id IS NOT NULL')[0].id;
    expect(events.some(e => e.channel === 'facebookPoster:log' && (e.data as any).runId === campaignRun
        && String((e.data as any).message).includes('Đã hết hạn mức Page trong ngày'))).toBe(true);
});

// Spec row "Hai profile cùng Page": two profiles identifying as one Page must share its daily limit under concurrency.
test('two profiles of the same Page due together publish only the shared daily limit', async () => {
    const s = await setupCampaign(); seed('duplicate');
    await ok(s.runner, 'pageCampaigns.schedule', { ...lease(s.work), input: s.input });
    ipc.posterOperations.scheduleCreate({ kind: 'once', runAt: s.input.runAt, params: {
        mode: 'page', text: 'Synthetic duplicate-profile owner post', mediaPaths: [], profiles: [{ profileId: 'duplicate', targets: ['https://www.facebook.com/'] }],
    } });
    const liveAtClick: number[] = [];
    afterClick = () => { liveAtClick.push(ipc.posterOperations.active().runs.length); };
    await runScheduler(s.input.runAt);
    const pageQuotaUsed = clicks, expectedSharedQuota = 1;
    expect(pageQuotaUsed).toBe(expectedSharedQuota); expect(comments).toBe(0); expect(liveAtClick).toEqual([2]);
    expect(db.query("SELECT r.profile_id, r.outcome FROM fb_poster_results r ORDER BY r.profile_id")).toEqual([
        { profile_id: 'alpha', outcome: 'failed' }, { profile_id: 'duplicate', outcome: 'posted' }]);
    expect(executions.get(s.draft.draftId).status).not.toBe('posted');
    const campaignRun = db.query('SELECT id FROM fb_poster_runs WHERE campaign_id IS NOT NULL')[0].id;
    expect(events.some(e => e.channel === 'facebookPoster:log' && (e.data as any).runId === campaignRun
        && String((e.data as any).message).includes('Đã hết hạn mức Page trong ngày'))).toBe(true);
});

// Catches a retirement drain that stops only the most recent managed worker.
test('campaign execution retirement drains two concurrent managed workers before either publishes', async () => {
    const a = await setupCampaign(), b = await setupCampaign('beta');
    await ok(a.runner, 'pageCampaigns.schedule', { ...lease(a.work), input: a.input });
    await ok(b.runner, 'pageCampaigns.schedule', { ...lease(b.work), input: b.input });
    const held: Array<() => void> = [];
    navigate = () => new Promise<void>(resolve => held.push(resolve));
    time = a.input.runAt;
    jest.useFakeTimers({ doNotFake: ['Date', 'nextTick', 'setImmediate'] });
    try {
        ipc.startFacebookPosterScheduler();
        for (let i = 0; i < 20 && ipc.posterOperations.active().runs.length < 2; i++) await jest.advanceTimersByTimeAsync(1000);
        expect(ipc.posterOperations.active().runs).toHaveLength(2);
        const stopping = ipc.stopPageCampaignExecution();
        navigate = async () => undefined; held.splice(0).forEach(resolve => resolve());
        let stopped: boolean | undefined;
        void stopping.then((value: boolean) => { stopped = value; });
        for (let i = 0; i < 100 && stopped === undefined; i++) await jest.advanceTimersByTimeAsync(1000);
        expect(stopped).toBe(true);
    } finally { ipc.stopFacebookPosterScheduler(); jest.useRealTimers(); }
    expect(clicks).toBe(0); expect(comments).toBe(0);
    expect(ipc.isFacebookPosterBusy()).toBe(false);
    expect(db.query('SELECT status FROM fb_poster_runs')).toEqual([{ status: 'cancelled' }, { status: 'cancelled' }]);
    expect(db.query("SELECT * FROM page_campaign_executions WHERE status='posted'")).toHaveLength(0);
});

// Catches promotion outside its transaction and duplicate quota reservations.
test('50 distinct contenders share one Page slot with atomic loser rollback', async () => {
    const s = await setupCampaign();
    const { saveDraft } = require('../../services/facebookPoster/drafts');
    const inputs = Array.from({ length: 50 }, (_, index) => {
        const row = saveDraft({ baseDir: dir, store: poster, maxSchedules: 200, newId: () => `contender-${index}`, now: () => time,
            env: { profileExists: () => true, fileExists: fs.existsSync, fileSize: (p: string) => fs.statSync(p).size } },
        { campaignId: s.campaignId, params: { mode: 'page', text: `Synthetic contender ${index}`, mediaPaths: [], profiles: [{ profileId: 'alpha', targets: ['https://www.facebook.com/'] }] } });
        // Synthetic pre-existing owned drafts isolate reservation contention from the separate daily draft-creation cap.
        db.run('INSERT INTO page_work_resources (resource_kind,resource_id,workspace_id,page_id,work_id) VALUES (?,?,?,?,?)', ['draft', row.id, 'workspace', s.pageId, s.work.id]);
        return { ...s.input, draftId: row.id, expectedDraftRevision: row.revision };
    });
    // The Jest seed reverses launch ordering between the two prescribed rounds.
    if (jest.getSeed() === 3707) inputs.reverse();
    const replies = await Promise.all(inputs.map(input => call(s.runner, 'pageCampaigns.schedule', { ...lease(s.work), input })));
    expect(replies.filter(r => !r.body.error)).toHaveLength(1);
    expect(replies.filter(r => r.body.error?.code === 'LIMIT_EXCEEDED')).toHaveLength(49);
    expect(db.query('SELECT * FROM page_campaign_executions')).toHaveLength(1);
    expect(db.query('SELECT * FROM fb_poster_schedules WHERE draft=0')).toHaveLength(1);
    expect(db.query("SELECT * FROM control_events WHERE type='pageCampaigns.scheduleChanged'")).toHaveLength(1);
    expect(clicks).toBe(0);
});

// Catches cache-only idempotence, repeated cancellation events and cancellation quota leaks.
test('100 schedule replays and 100 cancellations survive runtime restart without duplicated rows', async () => {
    const s = await setupCampaign(); const params = { ...lease(s.work), input: s.input };
    const first = await ok(s.runner, 'pageCampaigns.schedule', params);
    for (let i = 0; i < 100; i++) {
        if (i % 25 === 0) time += 61000;
        expect(await ok(s.runner, 'pageCampaigns.schedule', params)).toEqual(first);
    }
    for (let i = 0; i < 100; i++) {
        if (i % 25 === 0) time += 61000;
        await ok(s.runner, 'pageCampaigns.cancelSchedule', { ...lease(s.work), scheduleId: first.scheduleId, expectedExecutionRevision: 1 });
    }
    expect(db.query('SELECT * FROM page_campaign_executions')).toHaveLength(1);
    await restart();
    expect((await call(s.runner, 'pageCampaigns.schedule', params)).body.error.code).toBe('CONFLICT');
    expect(executions.get(first.scheduleId)).toMatchObject({ status: 'cancelled', revision: 2 });
    expect(db.query("SELECT * FROM control_events WHERE type='pageCampaigns.scheduleChanged'")).toHaveLength(2);
    expect(poster.getSchedule(first.scheduleId)).toMatchObject({ enabled: false, nextRunAt: null });
}, 30000); // 200 HTTPS round trips: ~3.8 s locally, over Jest's 5 s default on slower CI runners.

// Catches accepting stale authority before any effect, rather than merely hiding it in reports.
test.each(['revoked-runner', 'revoked-receiver', 'revoked-grant', 'corrupt-runner', 'expired', 'gate', 'default-gate', 'wrong-actor'])('scheduler denies %s authority before publish', async fault => {
    const s = await setupCampaign(); await ok(s.runner, 'pageCampaigns.schedule', { ...lease(s.work), input: s.input });
    if (fault === 'revoked-runner') options.store.revokeKey(s.runner.id);
    if (fault === 'revoked-receiver') options.store.revokeKey(s.receiver.id);
    if (fault === 'revoked-grant') campaigns.revokeGrant({ workspaceId: 'workspace', pageId: s.pageId, profileId: 'alpha' }, s.input.grantId, 1, time);
    if (fault === 'corrupt-runner') db.run('UPDATE control_keys SET policy_json=? WHERE id=?', ['{broken', s.runner.id]);
    if (fault === 'expired') {
        const grant = campaigns.getGrant(s.input.grantId);
        db.run('UPDATE page_campaign_grants SET policy_json=? WHERE id=?', [JSON.stringify({ ...grant.policy, expiresAt: s.input.runAt }), grant.id]);
    }
    if (fault === 'gate' || fault === 'default-gate') { gate = fault === 'gate' ? false : undefined; await api.restartControlApi(); }
    if (fault === 'wrong-actor') wrongActor = true;
    await runScheduler(s.input.runAt);
    expect(clicks).toBe(0); expect(comments).toBe(0);
    expect(db.query('SELECT * FROM page_campaign_published')).toHaveLength(0);
    expect(executions.get(s.draft.draftId).status).not.toBe('posted');
});

test.each(['before-transaction', 'before-promotion', 'after-reservation'])('transaction fault %s leaves draft and quota untouched', async fault => {
    const s = await setupCampaign();
    const trigger = fault === 'before-promotion'
        ? "BEFORE UPDATE ON fb_poster_schedules WHEN NEW.draft=0"
        : "BEFORE INSERT ON control_events WHEN NEW.type='pageCampaigns.scheduleChanged'";
    if (fault === 'before-transaction') failBeforeTransaction = true;
    else db.exec(`CREATE TRIGGER reject_composition ${trigger} BEGIN SELECT RAISE(ABORT,'synthetic transaction fault'); END`);
    expect((await call(s.runner, 'pageCampaigns.schedule', { ...lease(s.work), input: s.input })).body.error.code).toBe('INTERNAL');
    expect(poster.getSchedule(s.draft.draftId)).toMatchObject({ draft: true, enabled: false });
    expect(db.query('SELECT * FROM page_campaign_executions')).toHaveLength(0);
    if (fault !== 'before-transaction') db.exec('DROP TRIGGER reject_composition');
    await ok(s.runner, 'pageCampaigns.schedule', { ...lease(s.work), input: s.input });
    expect(db.query('SELECT * FROM page_campaign_executions')).toHaveLength(1);
});

test('lost response after transaction commit preserves one reservation and one effect across restart', async () => {
    const s = await setupCampaign(); const params = { ...lease(s.work), input: s.input };
    await new Promise<void>((resolve, reject) => {
        const request = https.request({ host: '127.0.0.1', port, path: '/v1/call', method: 'POST', rejectUnauthorized: false, agent: false,
            headers: { authorization: `Bearer ${s.runner.key}`, 'content-type': 'application/json' } }, response => {
            // Discard the committed response at the transport boundary; the caller has no result body.
            response.destroy(); resolve();
        });
        request.on('error', reject); request.end(JSON.stringify({ method: 'pageCampaigns.schedule', params }));
    });
    expect(executions.get(s.draft.draftId).status).toBe('reserved');
    await restart();
    expect((await call(s.runner, 'pageCampaigns.schedule', params)).body.error.code).toBe('CONFLICT');
    await runScheduler(s.input.runAt);
    expect(clicks).toBe(1); expect(db.query('SELECT * FROM page_campaign_executions')).toHaveLength(1);
    expect(db.query("SELECT * FROM control_events WHERE type='pageCampaigns.scheduleChanged'")).toHaveLength(1);
});

test.each(['after-submit', 'missing-ack', 'before-result-write'])('publish fault %s never blindly resends after restart', async fault => {
    const s = await setupCampaign(); await ok(s.runner, 'pageCampaigns.schedule', { ...lease(s.work), input: s.input });
    if (fault === 'after-submit') { acknowledgement = false; afterClick = () => { throw new Error('synthetic submit interruption'); }; }
    if (fault === 'missing-ack') acknowledgement = false;
    if (fault === 'before-result-write') db.exec("CREATE TRIGGER reject_result BEFORE INSERT ON fb_poster_results BEGIN SELECT RAISE(ABORT,'synthetic result failure'); END");
    await runScheduler(s.input.runAt); expect(clicks).toBe(1); expect(comments).toBe(0);
    await restart();
    await runScheduler(s.input.runAt + 1000);
    expect(clicks).toBe(1); expect(db.query('SELECT * FROM page_campaign_executions')).toHaveLength(1);
    expect(executions.get(s.draft.draftId).status).toBe('uncertain');
});

test('revocation during fallback await prevents the guarded final publish click', async () => {
    const s = await setupCampaign(); await ok(s.runner, 'pageCampaigns.schedule', { ...lease(s.work), input: s.input });
    fallback = true; afterFallback = () => options.store.revokeKey(s.receiver.id);
    await runScheduler(s.input.runAt);
    expect(clicks).toBe(0); expect(comments).toBe(0);
});

test('seven daily work leases survive reopened SQLite without transferring campaign ownership', async () => {
    const s = await setupCampaign(); const owner = works.getResourceOwner({ kind: 'campaign', id: s.campaignId });
    let work = s.work, draft = s.draft;
    const offsets: number[] = [];
    for (let day = 0; day < 7; day++) {
        if (day) {
            const local = new Date(NOW); local.setDate(local.getDate() + day); time = local.getTime();
            await restart();
            work = (await ok(s.runner, 'pageWork.claimDue', { pageId: s.pageId })).work;
            expect(work).not.toBeNull(); expect(work.id).not.toBe(s.work.id);
            draft = await ok(s.runner, 'pageWork.saveDraft', { ...lease(work), draftIndex: 0, draft: { text: `Day ${day}`, campaignId: s.campaignId } });
            expect((await call(s.runner, 'pageWork.saveDraft', { ...lease(s.work), draftIndex: 0, draft: { text: 'Stale' } })).body.error.code).toBe('CONFLICT');
        }
        offsets.push(new Date(time).getTimezoneOffset());
        const runAt = time + 120000;
        await ok(s.runner, 'pageCampaigns.schedule', { ...lease(work), input: { ...s.input, draftId: draft.draftId, expectedDraftRevision: draft.revision, runAt } });
        await runScheduler(runAt);
        expect(clicks).toBe(day + 1);
        await ok(s.runner, 'pageWork.finish', { ...lease(work), reason: 'Synthetic daily preparation', evidenceRefs: [] });
        expect(works.getResourceOwner({ kind: 'campaign', id: s.campaignId })).toEqual(owner);
        expect((await ok(s.runner, 'pageCampaigns.get', { pageId: s.pageId, campaignId: s.campaignId })).campaign.profileId).toBe('alpha');
    }
    expect(db.query('SELECT * FROM page_work_items')).toHaveLength(7);
    expect(db.query('SELECT * FROM fb_poster_schedules')).toHaveLength(7);
    expect(db.query('SELECT * FROM page_campaign_grants')).toHaveLength(1);
    expect(db.query("SELECT * FROM page_campaign_executions WHERE status='posted'")).toHaveLength(7);
    if (process.env.TZ === 'America/New_York') expect(offsets).toEqual([240, 240, 240, 240, 300, 300, 300]);
});

test('expired one-hour lease cannot promote a previously saved campaign draft', async () => {
    const s = await setupCampaign(); time += 3600001;
    expect((await call(s.runner, 'pageCampaigns.schedule', { ...lease(s.work), input: s.input })).body.error.code).toBe('CONFLICT');
    expect(db.query('SELECT * FROM page_campaign_executions')).toHaveLength(0); expect(clicks).toBe(0);
});

test('simulated runtime zone change rejects the old grant without changing its quota zone', async () => {
    const s = await setupCampaign(), original = Intl.DateTimeFormat.prototype.resolvedOptions;
    const zone = original.call(new Intl.DateTimeFormat()).timeZone;
    jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function(this: Intl.DateTimeFormat) {
        return { ...original.call(this), timeZone: zone === 'UTC' ? 'Pacific/Honolulu' : 'UTC' };
    });
    expect((await call(s.runner, 'pageCampaigns.schedule', { ...lease(s.work), input: s.input })).body.error.code).toBe('CONFLICT');
    expect(campaigns.getGrant(s.input.grantId).policy.timeZone).toBe(zone);
    expect(db.query('SELECT * FROM page_campaign_executions')).toHaveLength(0);
});

test('revocation after fallback submit cannot authorize first comment or erase posted outcome', async () => {
    const s = await setupCampaign(); await ok(s.runner, 'pageCampaigns.schedule', { ...lease(s.work), input: s.input });
    fallback = true; afterClick = () => options.store.revokeKey(s.receiver.id);
    await runScheduler(s.input.runAt);
    expect(clicks).toBe(1); expect(comments).toBe(0);
    expect(executions.get(s.draft.draftId).status).toBe('posted');
    expect(db.query("SELECT * FROM fb_poster_results WHERE outcome='posted'")).toHaveLength(1);
});

// Owner schedules retain the existing path even when protected autonomy is off.
test('manual owner schedule still publishes with protected writes disabled', async () => {
    seed(); gate = false; await api.restartControlApi();
    ipc.posterOperations.scheduleCreate({ kind: 'once', runAt: time + 120000, params: {
        mode: 'page', text: 'Synthetic owner post', mediaPaths: [], profiles: [{ profileId: 'alpha', targets: ['https://www.facebook.com/'] }],
    } });
    await runScheduler(time + 120000);
    expect(clicks).toBe(1); expect(db.query('SELECT * FROM page_campaign_executions')).toHaveLength(0);
    expect(db.query("SELECT * FROM fb_poster_results WHERE outcome='posted'")).toHaveLength(1);
});

test('pinned Python public poll consumes mixed projected campaign and work hints across restart', async () => {
    const s = await setupCampaign();
    const projection = await ok(s.receiver, 'pageWork.events', { after: 0, timeoutSec: 0 });
    const campaignHints = projection.events.filter((event: any) => event.type.startsWith('pageCampaigns.'));
    expect(campaignHints.map((event: any) => event.type)).toEqual(expect.arrayContaining(['pageCampaigns.proposalChanged', 'pageCampaigns.grantChanged']));
    for (const event of campaignHints) expect(event).not.toHaveProperty('workId');
    expect(projection.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'pageWork.draftSaved', workId: s.work.id })]));
    const poll = `
texts = []
class Sender:
    def send_once(self, text):
        texts.append(text)
        return {'chat': {'id': 1}, 'message_id': 20}
cursor = b.ProtectedWatcher(client, Sender(), state).poll()
with open(state) as handle:
    saved = json.load(handle)
print(json.dumps({'texts': texts, 'cursor': cursor, 'savedCursor': saved['cursor']}))
`;
    const first = await bridge(s.receiver, poll);
    expect(first.cursor).toBe(projection.nextCursor); expect(first.savedCursor).toBe(first.cursor);
    expect(first.texts).toHaveLength(2);
    expect(first.texts.join('\n')).toContain('Synthetic composition draft');
    expect(first.texts.join('\n')).toContain(s.campaignId);
    expect(await bridge(s.receiver, poll)).toEqual({ texts: [], cursor: first.cursor, savedCursor: first.cursor });
    await ok(s.runner, 'pageWork.saveDraft', { ...lease(s.work), draftIndex: 0, draft: {
        id: s.draft.draftId, expectedRevision: s.draft.revision, text: 'Continued public poll draft', campaignId: s.campaignId,
    } });
    const continued = await bridge(s.receiver, poll);
    expect(continued.cursor).toBeGreaterThan(first.cursor); expect(continued.savedCursor).toBe(continued.cursor);
    expect(continued.texts).toHaveLength(1); expect(continued.texts[0]).toContain('Continued public poll draft');
    expect(db.query('SELECT * FROM page_campaign_executions')).toHaveLength(0); expect(clicks).toBe(0);
});

test('pinned Python receiver persists uncertain send across process restart without resending', async () => {
    const s = await setupCampaign();
    const script = `
sent = []
class Sender:
    def send_once(self, text):
        sent.append(1)
        raise TimeoutError('synthetic acknowledgement loss')
b.ProtectedWatcher(client, Sender(), state)._poll_campaigns({'workspaceId': 'workspace', 'assignments': [{'pageId': '${s.pageId}', 'profileIds': ['alpha']}]})
statuses = [v['status'] for v in json.load(open(state))['deliveries'].values()]
print(json.dumps({'sends': len(sent), 'uncertain': statuses.count('uncertain')}))
`;
    expect(await bridge(s.receiver, script)).toEqual({ sends: 1, uncertain: 1 });
    expect(await bridge(s.receiver, script)).toEqual({ sends: 0, uncertain: 1 });
    expect(db.query('SELECT * FROM page_campaign_executions')).toHaveLength(0);
});

// Explicit synthetic provenance: this is NOT proof supplied by the production publisher.
test('synthetic confirmed observations drive one-factor optimization and pinned Python latest-only report dedup', async () => {
    const s = await setupCampaign();
    await ok(s.runner, 'pageCampaigns.schedule', { ...lease(s.work), input: s.input });
    const row = poster.getSchedule(s.draft.draftId), execution = executions.get(row.id);
    const scope = { workspaceId: 'workspace', pageId: s.pageId, profileId: 'alpha' };
    for (let i = 1; i <= 10; i++) {
        const variant = i <= 5 ? 'A' : 'B', score = i <= 5 ? 1 : 10;
        const publishedAt = NOW - 96 * 3600000, observedAt = NOW - 24 * 3600000;
        const sourceRef = `synthetic-confirmed-${i}`, postUrl = `https://www.facebook.com/${s.pageId}/posts/${i}`;
        const post = { ...scope, resultId: i, campaignId: s.campaignId, runId: `synthetic-${i}`, scheduleId: `historical-${i}`,
            runnerKeyId: s.runner.id, grantId: s.input.grantId, selection: { variant, contentRevision: execution.selection.contentRevision, factIds: [] }, publishedAt,
            comparison: { format: 'text', minute: new Date(s.input.runAt).getHours() * 60 + new Date(s.input.runAt).getMinutes() },
            postId: String(i), postUrl, sourceRef: 'synthetic-publish-proof', reason: '' };
        db.run('INSERT INTO page_campaign_published VALUES (?,?,?,?,?,?)', [i, 'workspace', s.pageId, 'alpha', s.campaignId, JSON.stringify(post)]);
        campaigns.reserveMeasurement(scope, s.campaignId, i, 4320, sourceRef);
        researchStore.createScan({ id: sourceRef, source: 'posts', query: postUrl, params: { query: postUrl, profileIds: ['alpha'] }, profileIds: ['alpha'], origin: 'api', startedAt: observedAt });
        researchStore.addItems(sourceRef, [{ kind: 'post', fbId: String(i), url: postUrl, authorKind: 'page', authorId: s.pageId, reactions: score, comments: 0, shares: 0 }], 'alpha', observedAt);
        researchStore.finishScan(sourceRef, 'done', '', '', {}, observedAt);
        campaigns.recordObservation({ resultId: i, postId: String(i), postUrl, pageId: s.pageId, campaignId: s.campaignId, publishedAt, observedAt,
            milestoneMinutes: 4320, sourceRef, status: 'measured', reason: '', reactions: score, comments: 0, shares: 0 });
    }
    const adjustment = await ok(s.runner, 'pageCampaigns.optimize', { ...lease(s.work), campaignId: s.campaignId, draftId: row.id,
        expectedDraftRevision: row.revision, grantId: s.input.grantId, expectedGrantRevision: 1 });
    expect(adjustment.decision).toMatchObject({ kind: 'variant', before: 'A', after: 'B', sampleSizes: { 'variant:A': 5, 'variant:B': 5 } });
    expect(executions.get(row.id).selection.variant).toBe('B'); expect(poster.getSchedule(row.id).runAt).toBe(row.runAt);
    const report = await ok(s.receiver, 'pageCampaigns.report', { pageId: s.pageId, campaignId: s.campaignId });
    expect(report).toMatchObject({ published: 10, measured: 10, totalEngagement: 55, coverage: 1, finance: { status: 'unavailable' } });
    const poll = `
sent = []
class Sender:
    def send_once(self, text):
        sent.append(text)
        return {'chat': {'id': 1}, 'message_id': 20}
b.ProtectedWatcher(client, Sender(), state)._poll_campaigns({'workspaceId': 'workspace', 'assignments': [{'pageId': '${s.pageId}', 'profileIds': ['alpha']}]})
print(json.dumps(sent))
`;
    const sent = await bridge(s.receiver, poll); expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(adjustment.decision.id); expect(sent[0].length).toBeLessThanOrEqual(4096);
    expect(await bridge(s.receiver, poll)).toEqual([]);
    db.run('DELETE FROM research_items');
    const read = await ok(s.receiver, 'pageCampaigns.get', { pageId: s.pageId, campaignId: s.campaignId });
    expect(read.latestDecision).toMatchObject({ evidenceAvailable: false, decision: { id: adjustment.decision.id } });
    expect(JSON.stringify(read)).not.toMatch(/receiverKeyId|confirmationRef|authorityFingerprint/);
});
