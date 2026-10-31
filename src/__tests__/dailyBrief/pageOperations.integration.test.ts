import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { memoryDb } from '../facebookPoster/helpers';
import { createCertificate } from '../../services/control/certificate';

const NOW = Date.parse('2026-10-28T10:00:00Z');
const scratch = os.tmpdir();
const modules = ['electron', 'xlsx', '../../services/database/DatabaseService', '../../utils/WorkspaceManager', '../../utils/AppModeManager',
    '../../services/control/ControlApiServer', '../../services/control/CertificateStore', '../../services/ai/AIAssistantService',
    '../../../electron/ipc/browserProfileIpc', '../../../electron/ipc/researchIpc', '../../../electron/ipc/videoIpc', '../../../electron/ipc/inboxMedia',
    '../../../electron/ipc/workspaceIpc', '../../services/dailyBrief/pageIdentity', '../../services/event/EventBroadcaster',
    '../../services/file/FileStorageService', '../../services/http/HttpConnectionManager', '../../services/http/HttpRelayService', '../../utils/ConnectionManager'];
let cert: Awaited<ReturnType<typeof createCertificate>>;
let dir: string; let api: any; let posterIpc: any; let options: any; let port: number;
let database: any; let activeDb: ReturnType<typeof memoryDb>; let workspace: string; let dbPath: string; let time: number;
let briefs: any; let business: any; let works: any; let poster: any; let videos: any; let researchStore: any; let research: any; let inbox: any;
let openActor: (id: string) => Promise<void>; let opens: string[]; let closes: number; let researchOpens: number; let videoDownloads: number;
let render: jest.Mock; let emit: jest.Mock;
const profiles: Record<string, string> = { alpha: 'page-a', beta: 'page-b', gamma: 'page-c', duplicate: 'page-a' };

beforeAll(async () => { cert = await createCertificate(); });
beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(scratch, 'page-operations-integration-'));
    time = NOW; workspace = 'workspace'; dbPath = path.join(dir, 'workspace.db'); activeDb = memoryDb();
    opens = []; closes = 0; researchOpens = 0; videoDownloads = 0; render = jest.fn(); emit = jest.fn(); openActor = async () => undefined;
    jest.spyOn(Date, 'now').mockImplementation(() => time);
    const readFile = fs.readFileSync;
    const bridge = readFile(path.join(process.cwd(), 'tools/maihub-bridge/maihub_bridge.py'));
    jest.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => String(file).endsWith('maihub_bridge.py') ? bridge : (readFile as any)(file, ...args)) as any);
    database = { exec: (sql: string) => activeDb.exec(sql), run: (sql: string, p?: unknown[]) => activeDb.run(sql, p),
        runInsert: (sql: string, p?: unknown[]) => activeDb.runInsert(sql, p), query: (sql: string, p?: unknown[]) => activeDb.query(sql, p),
        queryOne: (sql: string, p?: unknown[]) => activeDb.queryOne(sql, p), transaction: (fn: () => unknown) => activeDb.transaction(fn),
        getDbPath: () => dbPath, getSetting: () => JSON.stringify({ enabled: true, port: 47321, allowList: ['127.0.0.1'], protectedWritesEnabled: true }),
        getBrowserProfileById: (id: string) => profiles[id] ? { id } : undefined,
        getBrowserProfiles: () => Object.keys(profiles).map(id => ({ id, name: id })) };
    jest.doMock(modules[0], () => ({ app: { getPath: () => dir, getAppPath: () => process.cwd(), getVersion: () => '1.0' },
        ipcMain: { handle() {} }, safeStorage: {}, dialog: {}, BrowserWindow: { getAllWindows: () => [] } }));
    jest.doMock(modules[1], () => ({}));
    jest.doMock(modules[2], () => ({ __esModule: true, default: { getInstance: () => database } }));
    jest.doMock(modules[3], () => ({ __esModule: true, default: { getInstance: () => ({ getActiveWorkspace: () => ({ id: workspace }) }) } }));
    jest.doMock(modules[4], () => ({ __esModule: true, default: { getInstance: () => ({ isEmployeeMode: () => false }) } }));
    // Keep the real HTTPS server and authority; only choose an ephemeral loopback port.
    jest.doMock(modules[5], () => {
        const actual = jest.requireActual('../../services/control/ControlApiServer');
        return { ...actual, ControlApiServer: class extends actual.ControlApiServer {
            constructor(o: any) { super({ ...o, port: 0, host: '127.0.0.1' }); options = o; }
            async start() { const result = await super.start(); port = result.port; return result; }
        } };
    });
    jest.doMock(modules[6], () => ({ CertificateStore: class { async ensure() { return cert; } }, CertificateKeyUnreadableError: class extends Error {} }));
    jest.doMock(modules[7], () => ({ __esModule: true, default: { getInstance: () => ({ getDefaultAssistant: () => null }) } }));
    const reservations = new Set<string>();
    jest.doMock(modules[8], () => ({ isBrowserEngineInstalled: () => true, getBrowserProfileService: () => ({
        onAvailabilityChanged: () => () => {}, tryReserveAutomation: (profileId: string) => { if (reservations.has(profileId)) return null; reservations.add(profileId); return { profileId }; },
        releaseAutomationReservation: (token: { profileId: string }) => { reservations.delete(token.profileId); }, isRunning: () => false, canReserveAutomation: (id: string) => !reservations.has(id),
        openForAutomation: async (id: string) => {
            opens.push(id); await openActor(id);
            return { context: { once: jest.fn(), pages: () => [{ profileId: id }] }, close: async () => { closes++; } };
        }, getRunningIds: () => [] }) }));
    jest.doMock(modules[9], () => ({ researchOperations: {}, getResearchStore: () => researchStore, getResearchService: () => research,
        isResearchRunning: () => research?.isRunning() ?? false, cancelResearch: () => research?.stop(), retireResearchService: () => {}, cancelAndWaitResearch: async () => true }));
    jest.doMock(modules[10], () => ({ videoOperations: { render, adCreate: render }, getPageWorkVideoOperations: () => ({
        status: ({ videoId }: any) => ({ video: videos.get(videoId) }),
        openFile: async () => { videoDownloads++; return { stream: Readable.from(['VIDEO']), size: 5 }; } }) }));
    jest.doMock(modules[11], () => ({ getInboxMediaStore: () => inbox }));
    jest.doMock(modules[12], () => ({ isWorkspaceSwitchInProgress: () => false }));
    jest.doMock(modules[13], () => ({ readPageIdentity: async (page: any, o: any) => { o.assertCurrent(); return { kind: 'page', pageId: profiles[page.profileId] }; } }));
    jest.doMock(modules[14], () => ({ __esModule: true, default: { emit } }));
    for (const name of modules.slice(15)) jest.doMock(name, () => ({ __esModule: true, default: { getInstance: () => ({}), getAllConnections: () => new Map() } }));
    jest.isolateModules(() => {
        database.exec(require('../../services/control/ControlStore').CONTROL_SCHEMA_SQL);
        poster = new (require('../../services/facebookPoster/FacebookPosterStore').FacebookPosterStore)(database); poster.ensureSchema();
        inbox = new (require('../../services/control/InboxMediaStore').InboxMediaStore)(path.join(dir, 'inbox'));
        videos = new (require('../../services/video/VideoStore').VideoStore)(database); videos.ensureSchema();
        posterIpc = require('../../../electron/ipc/facebookPosterIpc'); api = require('../../../electron/ipc/controlApiIpc');
        briefs = new (require('../../services/dailyBrief/DailyBriefStore').DailyBriefStore)(database);
        business = new (require('../../services/dailyBrief/PageBusinessStore').PageBusinessStore)(database);
        works = new (require('../../services/dailyBrief/PageWorkStore').PageWorkStore)(database); works.ensureSchema();
        researchStore = new (require('../../services/research/ResearchStore').ResearchStore)(database); researchStore.ensureSchema();
        research = new (require('../../services/research/ResearchService').ResearchService)({ store: researchStore, ...posterIpc.getProfileJobBinding(),
            listProfiles: () => database.getBrowserProfiles(), isProfileBusy: () => false, loginStates: () => [], groupMembership: () => ({}),
            readConfig: () => ({ excludedProfileIds: [], perProfileDailyCap: 100 }), observeLogin() {}, emit() {}, now: Date.now, sleep: async () => undefined,
            openSession: async (profile: any) => {
                researchOpens++; expect(research.isRunning()).toBe(true);
                const id = typeof profile === 'string' ? profile : profile.id;
                return { session: { open: async () => undefined,
                    ensureQuery: async () => ({ friendlyName: 'SearchCometResultsPaginatedResultsQuery', docId: 'fake', variables: { args: { text: 'x', filters: [] } } }),
                    call: async () => JSON.stringify({ data: { serpResponse: { results: { edges: [], page_info: { has_next_page: false, end_cursor: null } } } } }) },
                    readIdentity: async () => ({ kind: 'page', pageId: profiles[id] }), close: async () => undefined };
            } });
    });
    await api.restartControlApi();
});
afterEach(async () => {
    await api?.shutdownControlApi();
    modules.forEach(name => jest.dontMock(name)); jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
});
function assertProfileHeld(id = 'alpha') { expect(posterIpc.getProfileJobBinding().isProfileBusy(id)).toBe(true); }
function assertProfilesReleased() { for (const id of Object.keys(profiles)) expect(posterIpc.getProfileJobBinding().isProfileBusy(id)).toBe(false); }
function seed(profileId = 'alpha') {
    const pageId = profiles[profileId];
    briefs.upsertIdentity({ profileId, kind: 'page', pageId, pageName: pageId, category: '', about: '', recentPosts: [], learnedAt: NOW, errorCode: '', error: '' });
    briefs.saveBrief(profileId, { time: '00:00', draftsPerDay: 1 }, NOW);
    if (!business.get(pageId)) { business.ensure(pageId, profileId, NOW); business.setEnabled(pageId, true, 0, { confirmedAt: NOW, confirmationRef: 'fixture-owner' }); }
}
function key(kind = 'page_runner', profileIds = ['alpha']) {
    const assignments = [...new Set(profileIds.map(id => profiles[id]))].map(pageId => ({ pageId, profileIds: profileIds.filter(id => profiles[id] === pageId) }));
    return options.store.createKey(kind, { kind, workspaceId: 'workspace', assignments,
        ...(kind === 'page_receiver' ? { ownerChatId: '1', ownerSenderId: '2' } : {}) });
}
function send(credential: any, route: string, body?: any, verb = 'POST'): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = https.request({ host: '127.0.0.1', port, path: route, method: verb, rejectUnauthorized: false, agent: false,
            headers: { authorization: `Bearer ${credential.key}`, 'content-type': 'application/json' } }, res => {
            const chunks: Buffer[] = []; res.on('data', c => chunks.push(c));
            res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, body: JSON.parse(text) }); });
        });
        req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}
const call = (credential: any, method: string, params = {}, extra = {}) => send(credential, '/v1/call', { method, params, ...extra });
async function ok(credential: any, method: string, params = {}, extra = {}) {
    const reply = await call(credential, method, params, extra); expect(reply.body.error).toBeUndefined(); expect(reply.status).toBe(200); return reply.body.result;
}
const claim = async (credential: any, pageId = 'page-a') => (await ok(credential, 'pageWork.claimDue', { pageId })).work;
const lease = (work: any) => ({ workId: work.id, claimedAt: work.claimedAt });
const update = { updateId: 1, messageId: 11, chatId: '1', senderId: '2', replyToMessageId: 10 };
async function ticket(receiver: any, draft: any) {
    const { ticket: prepared } = await ok(receiver, 'pageApprovals.prepare', { action: { kind: 'approveDraft', pageId: 'page-a', draftId: draft.draftId,
        expectedRevision: draft.revision, timing: { when: 'now' } } });
    await ok(receiver, 'pageApprovals.bindMessage', { ticketId: prepared.id, chatId: '1', senderId: '2', messageId: 10 });
    return prepared;
}

// Real Python consumer + pinned HTTPS + runtime authority/SQLite; only transport sender/agent are fake.
function bridgeRun(credential: any, script: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const child = spawn('python3', ['-I', '-B', '-c', `
import importlib.util, json, sys, os
spec = importlib.util.spec_from_file_location('bridge', sys.argv[1])
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
p = json.load(sys.stdin)
b.time.time = lambda: p['now'] / 1000
client = b.MaiHubClient(b.Config(p['url'], p['key'], p['pin']))
state = p['state']
exec(p['script'])
`, path.join(process.cwd(), 'tools/maihub-bridge/maihub_bridge.py')]);
        let out = '', error = '';
        child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { error += data; });
        child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(error)));
        child.stdin.end(JSON.stringify({ url: `https://127.0.0.1:${port}`, key: credential.key, pin: cert.fingerprintSha256,
            state: path.join(dir, 'bridge.json'), now: time, script }));
    });
}
const tickScript = `
ran = []
def agent(prompt, timeout):
    ran.append(1)
    return (0, False)
print(json.dumps(b.protected_brief_tick(client, agent, lambda: p['now'] / 1000, state)))
`;

test('freshPrimaryUsesActualBridgeProposalAndOwnerConfirmationWithoutBusinessSeed', async () => {
    briefs.upsertIdentity({ profileId: 'alpha', kind: 'page', pageId: 'page-a', pageName: '', category: '', about: '', recentPosts: [], learnedAt: NOW, errorCode: '', error: '' });
    briefs.saveBrief('alpha', { time: '00:00', draftsPerDay: 1 }, NOW);
    const receiver = key('page_receiver'); const runner = key();
    expect(business.get('page-a')).toBeNull();
    expect((await call(runner, 'pageApprovals.prepare', { action: { kind: 'setPrimaryProfile', pageId: 'page-a', profileId: 'alpha', expectedRevision: 0 } })).status).toBe(403);
    await ok(receiver, 'pageApprovals.prepare', { action: { kind: 'setPrimaryProfile', pageId: 'page-a', profileId: 'alpha', expectedRevision: 0 } });
    expect(business.get('page-a')).toBeNull();
    const proposed = await bridgeRun(receiver, `
class Sender:
    def send_once(self, text): return {'chat': {'id': 1}, 'message_id': 10}
action = {'kind': 'setPrimaryProfile', 'pageId': 'page-a', 'profileId': 'alpha', 'expectedRevision': 0}
entry = b.ProtectedWatcher(client, Sender(), state).deliver(['first-primary'], '', action)
assert entry['status'] == 'sent'
print(json.dumps(entry['ticket']))
`);
    expect(business.get('page-a')).toBeNull();
    const confirmScript = `
pending = json.load(open(state))['deliveries']['["first-primary"]']['ticket']
update = {'update_id': 1, 'message': {'message_id': 11, 'chat': {'id': 1}, 'from': {'id': 2}, 'text': 'ok', 'reply_to_message': {'message_id': 10}}}
print(json.dumps(b.handle_owner_update(client, update, pending)))
`;
    // Ticket consumption failure must roll back first-row creation as well as revision/primary.
    database.exec("CREATE TRIGGER reject_bootstrap BEFORE UPDATE ON page_owner_approvals WHEN NEW.consumed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'disk failure'); END;");
    expect((await call(receiver, 'pageApprovals.confirm', { ticketId: proposed.id, update })).body.error?.code).toBe('INTERNAL');
    expect(business.get('page-a')).toBeNull(); expect(works.getApproval(proposed.id).consumedAt).toBeNull();
    database.exec('DROP TRIGGER reject_bootstrap');
    expect(await bridgeRun(receiver, confirmScript)).toMatchObject({ resourceId: 'page-a', replayed: false });
    expect(business.get('page-a')).toMatchObject({ primaryProfileId: 'alpha', revision: 1, enabled: false, protectedSince: null });
    expect(await claim(runner)).toBeNull();
    expect((await ok(receiver, 'pageApprovals.confirm', { ticketId: proposed.id, update })).replayed).toBe(true);
    const enabled = (await ok(receiver, 'pageApprovals.prepare', { action: { kind: 'setEnabled', pageId: 'page-a', expectedRevision: 1, enabled: true } })).ticket;
    await ok(receiver, 'pageApprovals.bindMessage', { ticketId: enabled.id, chatId: '1', senderId: '2', messageId: 12 });
    await ok(receiver, 'pageApprovals.confirm', { ticketId: enabled.id, update: { ...update, updateId: 2, messageId: 13, replyToMessageId: 12 } });
    expect(await claim(runner)).toMatchObject({ pageId: 'page-a', attempts: 1 });
});

test('freshPrimaryConflictsOnCreationIdentityChangeAndLimitWithoutEffects', async () => {
    const learn = () => briefs.upsertIdentity({ profileId: 'alpha', kind: 'page', pageId: 'page-a', pageName: '', category: '', about: '', recentPosts: [], learnedAt: NOW, errorCode: '', error: '' });
    learn(); briefs.saveBrief('alpha', { time: '00:00', draftsPerDay: 1 }, NOW);
    const receiver = key('page_receiver'); const action = { kind: 'setPrimaryProfile', pageId: 'page-a', profileId: 'alpha', expectedRevision: 0 };
    expect((await call(key('page_receiver', ['beta']), 'pageApprovals.prepare', { action })).body.error?.code).toBe('FORBIDDEN');
    expect((await call(receiver, 'pageApprovals.prepare', { action: { ...action, profileId: 'beta' } })).body.error?.code).toBe('FORBIDDEN');
    expect((await call(receiver, 'pageApprovals.prepare', { action: { ...action, expectedRevision: 1 } })).body.error?.code).toBe('CONFLICT');
    const prepare = async () => {
        const t = (await ok(receiver, 'pageApprovals.prepare', { action })).ticket;
        await ok(receiver, 'pageApprovals.bindMessage', { ticketId: t.id, chatId: '1', senderId: '2', messageId: 10 }); return t;
    };
    const stale = await prepare();
    briefs.upsertIdentity({ ...briefs.getIdentity('alpha'), learnedAt: NOW + 1 });
    expect((await call(receiver, 'pageApprovals.confirm', { ticketId: stale.id, update })).body.error?.code).toBe('CONFLICT');
    expect(business.get('page-a')).toBeNull(); learn();
    const created = await prepare(); business.ensure('page-a', null, NOW);
    expect((await call(receiver, 'pageApprovals.confirm', { ticketId: created.id, update })).body.error?.code).toBe('CONFLICT');
    expect(business.get('page-a')).toMatchObject({ primaryProfileId: null, revision: 0, enabled: false });
    // Only fixtures for OTHER Pages exercise the global cap; the target is never seeded.
    database.run('DELETE FROM page_business_profiles WHERE page_id = ?', ['page-a']);
    const limited = await prepare();
    for (let i = 0; i < 10; i++) business.ensure(`limit-${i}`, null, NOW);
    expect((await call(receiver, 'pageApprovals.confirm', { ticketId: limited.id, update })).body.error?.code).toBe('LIMIT_EXCEEDED');
    expect(business.get('page-a')).toBeNull(); expect(works.getApproval(limited.id).consumedAt).toBeNull();
    expect(business.list()).toHaveLength(10); expect(briefs.getBrief('alpha').enabled).toBe(true);
    expect(database.query('SELECT * FROM page_work_items')).toEqual([]);
});

test('actualWatcherContinuesAfterPromotionAndRemovalAcrossRestart', async () => {
    seed(); seed('beta'); const runner = key('page_runner', ['alpha', 'beta']); const receiver = key('page_receiver', ['alpha', 'beta']);
    const first = await claim(runner); const saved = await ok(runner, 'pageWork.saveDraft', { ...lease(first), draftIndex: 0, draft: { text: 'Old draft' } });
    await ok(runner, 'pageWork.finish', { ...lease(first), reason: '', evidenceRefs: [] });
    const poll = `
sent = []
class Sender:
    def send_once(self, text):
        sent.append(text)
        return {'chat': {'id': 1}, 'message_id': len(sent)}
b.ProtectedWatcher(client, Sender(), state).poll()
print(json.dumps(sent))
`;
    expect(await bridgeRun(receiver, poll)).toHaveLength(1);
    const prepared = (await ok(receiver, 'pageApprovals.prepare', { action: { kind: 'approveDraft', pageId: 'page-a', draftId: saved.draftId,
        expectedRevision: saved.revision, timing: { when: 'schedule', kind: 'once', runAt: time + 7 * 86400000 } } })).ticket;
    await ok(receiver, 'pageApprovals.bindMessage', { ticketId: prepared.id, chatId: '1', senderId: '2', messageId: 10 });
    await ok(receiver, 'pageApprovals.confirm', { ticketId: prepared.id, update });
    expect((await ok(receiver, 'pageWork.draft', { workId: first.id, draftId: saved.draftId })).draft).toEqual({ id: saved.draftId, status: 'promoted' });
    time += 86400000;
    for (const pageId of ['page-a', 'page-b']) {
        const work = await claim(runner, pageId);
        await ok(runner, 'pageWork.saveDraft', { ...lease(work), draftIndex: 0, draft: { text: `Fresh ${pageId}` } });
        await ok(runner, 'pageWork.finish', { ...lease(work), reason: '', evidenceRefs: [] });
    }
    const fresh = await bridgeRun(receiver, poll); expect(fresh).toHaveLength(2); expect(fresh.join(' ')).toContain('Fresh page-a'); expect(fresh.join(' ')).toContain('Fresh page-b');
    expect(await bridgeRun(receiver, poll)).toEqual([]);
    poster.deleteSchedule(saved.draftId);
    expect((await ok(receiver, 'pageWork.draft', { workId: first.id, draftId: saved.draftId })).draft).toEqual({ id: saved.draftId, status: 'removed' });
    expect(await bridgeRun(receiver, poll)).toEqual([]);
    expect((await call(receiver, 'pageWork.draft', { workId: first.id, draftId: 'unknown' })).body.error?.code).toBe('FORBIDDEN');
});

test('actualProtectedTickReclaimsExpiredLeaseWithoutRuntimeRestart', async () => {
    seed(); const runner = key(); const first = await claim(runner);
    expect(await bridgeRun(runner, tickScript)).toMatchObject({ ran: [] });
    time += 3600000;
    const result = await bridgeRun(runner, tickScript); expect(result.ran).toEqual([first.id]);
    expect(works.get(first.id)).toMatchObject({ attempts: 2, status: 'needs_review' });
    expect(works.get(first.id).claimedAt).toBeGreaterThan(first.claimedAt);
    expect((await call(runner, 'pageWork.saveDraft', { ...lease(first), draftIndex: 0, draft: { text: 'Stale' } })).body.error?.code).toBe('CONFLICT');
});

test('expiredUncertainIntentNeedsReviewAndLiveActorIsNotReclaimed', async () => {
    seed(); const runner = key(); const first = await claim(runner);
    let release!: () => void; let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
    openActor = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); };
    const saving = call(runner, 'pageWork.saveDraft', { ...lease(first), draftIndex: 0, draft: { text: 'Still preparing' } });
    await reached; time += 3600000;
    expect((await ok(runner, 'pageWork.reconcile', { workId: first.id })).work).toMatchObject({ status: 'running', attempts: 1 });
    expect((await call(runner, 'pageWork.claimDue', { pageId: 'page-a' })).body.error?.code).toBe('CONFLICT');
    expect((await bridgeRun(runner, tickScript)).ran).toEqual([]);
    release(); expect((await saving).body.error?.code).toBe('CONFLICT'); assertProfilesReleased();
    expect((await ok(runner, 'pageWork.reconcile', { workId: first.id })).work.status).toBe('pending');
    const second = await claim(runner); works.beginStep(lease(second), 'unknown-effect', 'hash', time);
    time += 3600000;
    expect((await bridgeRun(runner, tickScript)).ran).toEqual([]);
    expect(works.get(first.id)).toMatchObject({ status: 'needs_review', attempts: 2 });
    expect(works.getStep(first.id, 'unknown-effect').status).toBe('uncertain');
    expect(await claim(runner)).toBeNull(); expect(poster.listSchedules()).toEqual([]);
});

test('actualProtectedTickRunsServerAdmittedFourthLifetimeInvocationOnNextDay', async () => {
    seed(); const runner = key(); let work: any;
    for (let i = 0; i < 3; i++) {
        work = await claim(runner); expect(work.attempts).toBe(i + 1);
        await ok(runner, 'pageWork.fail', { ...lease(work), code: 'busy', reason: '' }); time += 60000;
    }
    expect(await claim(runner)).toBeNull();
    expect((await bridgeRun(runner, tickScript)).ran).toEqual([]);
    time += 86400000;
    expect((await bridgeRun(runner, tickScript)).ran).toEqual([work.id]);
    expect(works.get(work.id)).toMatchObject({ attempts: 4, status: 'needs_review' });
    expect(database.query('SELECT attempts FROM page_work_daily_usage ORDER BY usage_date')).toEqual([{ attempts: 3 }, { attempts: 1 }]);
});

test('actualProtectedTickContinuesVideoBeyondDailyBudgetAndOneDay', async () => {
    seed(); const runner = key(); let work: any;
    for (let i = 0; i < 2; i++) {
        work = await claim(runner);
        await ok(runner, 'pageWork.fail', { ...lease(work), code: 'busy', reason: '' }); time += 60000;
    }
    work = await claim(runner); expect(work.attempts).toBe(3);
    videos.create({ id: 'carryover-video', remoteId: 'external-job', name: 'Requested', source: 'app', engine: 'ahv_ad', templateId: null,
        aspect: '', specJson: '{}', status: 'rendering', progress: 0, error: '', stepText: '', resultJson: '', filePath: null, thumbPath: null,
        sizeBytes: null, durationSec: null, createdAt: time, finishedAt: null });
    await posterIpc.createBoundPageWorkOperations(() => ({ workspaceId: 'workspace', dbPath, pageId: 'page-a', profileId: 'alpha' }), () => {}).attachVideo(work.id, 'carryover-video');
    await ok(runner, 'pageWork.waitVideo', { ...lease(work), videoId: 'carryover-video' });
    expect((await bridgeRun(runner, tickScript)).ran).toEqual([]);
    time += 2 * 86400000;
    expect((await bridgeRun(runner, tickScript)).ran).toEqual([]);
    expect(works.get(work.id)).toMatchObject({ status: 'waiting', attempts: 3 });
    videos.update('carryover-video', { status: 'done', finishedAt: time });
    expect((await bridgeRun(runner, tickScript)).ran).toEqual([work.id]);
    expect(works.get(work.id)).toMatchObject({ status: 'needs_review', attempts: 4 });
    expect(videoDownloads).toBe(1); expect(render).not.toHaveBeenCalled();
    expect((await bridgeRun(runner, tickScript)).ran).toEqual([]); expect(videoDownloads).toBe(1);
});

test('threePagesRemainIsolatedThroughDraftCompletion', async () => {
    for (const id of ['alpha', 'beta', 'gamma']) seed(id);
    openActor = async id => assertProfileHeld(id);
    const drafts: any[] = [];
    for (const id of ['alpha', 'beta', 'gamma']) {
        const runner = key('page_runner', [id]); const work = await claim(runner, profiles[id]);
        const scan = await ok(runner, 'pageWork.research', { ...lease(work), input: { kind: 'search', keywords: [id] } });
        expect(researchStore.getScan(scan.scanId)).toMatchObject({ status: 'done', profileIds: [id] });
        const fact = { topic: 'service', value: id, status: 'observed', sourceType: 'page', sourceRef: `page:${id}:${NOW}`, reason: '', observedAt: NOW };
        await ok(runner, 'pageBusiness.propose', { ...lease(work), expectedRevision: 1, fact });
        const saved = await ok(runner, 'pageWork.saveDraft', { ...lease(work), draftIndex: 0, draft: { text: `Draft ${id}` } }); drafts.push(saved);
        expect(await ok(runner, 'pageWork.saveDraft', { ...lease(work), draftIndex: 0, draft: { text: `Draft ${id}` } })).toEqual(saved);
        expect((await ok(runner, 'pageWork.finish', { ...lease(work), reason: '', evidenceRefs: [fact.sourceRef] })).work.status).toBe('completed');
        expect(poster.getSchedule(saved.draftId)).toMatchObject({ draft: true, enabled: false, params: { text: `Draft ${id}`, profiles: [{ profileId: id }] } });
        expect(works.getResourceOwner({ kind: 'draft', id: saved.draftId })).toMatchObject({ workId: work.id, pageId: profiles[id] });
        expect(business.get(profiles[id]).facts).toMatchObject([{ value: id }]);
        expect((await call(key(), 'pageWork.draft', { workId: work.id, draftId: saved.draftId })).body.error?.code).toBe(id === 'alpha' ? undefined : 'FORBIDDEN');
        if (id !== 'alpha') {
            const foreign = key(); const beforeOpens = opens.length;
            expect((await call(foreign, 'pageBusiness.get', { pageId: profiles[id] })).body.error?.code).toBe('FORBIDDEN');
            expect((await call(foreign, 'pageWork.researchResult', { workId: work.id, scanId: scan.scanId })).body.error?.code).toBe('FORBIDDEN');
            expect((await call(foreign, 'pageWork.saveDraft', { ...lease(work), draftIndex: 0, draft: { text: 'Cross-page overwrite' } })).body.error?.code).toBe('FORBIDDEN');
            expect(opens).toHaveLength(beforeOpens);
            expect(poster.getSchedule(saved.draftId).params.text).toBe(`Draft ${id}`);
        }
        assertProfilesReleased();
    }
    expect(new Set(drafts.map(draft => draft.draftId)).size).toBe(3);
    expect(database.query('SELECT * FROM page_work_items WHERE status = ?', ['completed'])).toHaveLength(3);
    expect(database.query('SELECT * FROM fb_poster_schedules')).toHaveLength(3);
    expect(database.query('SELECT * FROM page_business_facts')).toHaveLength(3);
    expect(database.query('SELECT * FROM page_work_resources')).toHaveLength(6);
    expect(opens).toEqual(['alpha', 'beta', 'gamma']); expect(closes).toBe(3); expect(researchOpens).toBe(3); expect(render).not.toHaveBeenCalled();
});

test('duplicateProfilesShareMemoryButRunOneBrief', async () => {
    seed(); seed('duplicate'); const runner = key('page_runner', ['alpha', 'duplicate']);
    const results = await Promise.all([claim(runner), claim(runner)]);
    expect(results.filter(Boolean)).toHaveLength(1); const work = results.find(Boolean);
    expect(work.profileId).toBe('alpha');
    const fact = { topic: 'service', value: 'Shared memory', status: 'hypothesis', sourceType: 'page', sourceRef: `page:alpha:${NOW}`, reason: 'Needs owner confirmation', observedAt: NOW };
    await ok(runner, 'pageBusiness.propose', { ...lease(work), expectedRevision: 1, fact });
    expect((await ok(key('page_runner', ['duplicate']), 'pageBusiness.get', { pageId: 'page-a' })).business.facts).toMatchObject([{ value: 'Shared memory' }]);
    expect(await claim(key('page_runner', ['duplicate']))).toBeNull();
    expect(database.query('SELECT * FROM page_business_profiles')).toHaveLength(1);
    expect(database.query('SELECT * FROM page_business_facts')).toHaveLength(1);
    expect(database.query('SELECT * FROM page_work_items')).toHaveLength(1);
    expect(database.query('SELECT * FROM page_work_daily_usage')).toMatchObject([{ attempts: 1 }]);
    expect(briefs.listBriefs()).toHaveLength(2); expect(opens).toEqual([]); assertProfilesReleased();
});

test('videoOutlivesAgentAndResumesOnce', async () => {
    seed(); const runner = key(); const work = await claim(runner);
    videos.create({ id: 'requested-video', remoteId: 'external-job', name: 'Requested', source: 'app', engine: 'ahv_ad', templateId: null,
        aspect: '', specJson: '{}', status: 'rendering', progress: 0, error: '', stepText: '', resultJson: '', filePath: null, thumbPath: null,
        sizeBytes: null, durationSec: null, createdAt: NOW, finishedAt: null });
    // Trusted customer-request seam: runner can only wait for an already linked video.
    await posterIpc.createBoundPageWorkOperations(() => ({ workspaceId: 'workspace', dbPath, pageId: 'page-a', profileId: 'alpha' }), () => {}).attachVideo(work.id, 'requested-video');
    await ok(runner, 'pageWork.waitVideo', { ...lease(work), videoId: 'requested-video' });
    time += 161 * 60000; await api.restartControlApi();
    for (let i = 0; i < 3; i++) expect((await ok(runner, 'pageWork.reconcile', { workId: work.id })).work).toMatchObject({ status: 'waiting', attempts: 1 });
    expect(videoDownloads).toBe(0); expect(opens).toEqual([]); assertProfilesReleased();
    videos.update('requested-video', { status: 'done', finishedAt: time });
    expect((await ok(runner, 'pageWork.reconcile', { workId: work.id })).work.status).toBe('pending');
    const resumed = await claim(runner); expect(resumed).toMatchObject({ id: work.id, attempts: 2 }); expect(resumed.claimedAt).toBeGreaterThan(work.claimedAt);
    await ok(runner, 'pageWork.reconcile', { workId: work.id });
    const media = database.query("SELECT resource_id FROM page_work_resources WHERE resource_kind = 'media'"); expect(media).toHaveLength(1);
    const saved = await ok(runner, 'pageWork.saveDraft', { ...lease(resumed), draftIndex: 0, draft: { text: 'Video ready', mediaIds: [media[0].resource_id] } });
    await ok(runner, 'pageWork.finish', { ...lease(resumed), reason: '', evidenceRefs: [] });
    await api.restartControlApi(); await ok(runner, 'pageWork.reconcile', { workId: work.id });
    expect(await claim(runner)).toBeNull(); expect(videoDownloads).toBe(1); expect(render).not.toHaveBeenCalled();
    expect(database.query('SELECT * FROM video_jobs')).toHaveLength(1); expect(poster.getSchedule(saved.draftId)).toMatchObject({ draft: true, enabled: false });
    expect(database.query('SELECT * FROM fb_poster_schedules')).toHaveLength(1); expect(opens).toEqual(['alpha']); expect(closes).toBe(1); assertProfilesReleased();
});

test('runnerCannotApproveViaAnyRoute', async () => {
    seed(); const runner = key(); const receiver = key('page_receiver'); const work = await claim(runner);
    const saved = await ok(runner, 'pageWork.saveDraft', { ...lease(work), draftIndex: 0, draft: { text: 'Unapproved' } });
    const prepared = await ticket(receiver, saved); const before = poster.getSchedule(saved.draftId);
    for (const [method, params] of [
        ['pageApprovals.prepare', { action: prepared.action }], ['pageApprovals.bindMessage', { ticketId: prepared.id, chatId: '1', senderId: '2', messageId: 10 }],
        ['pageApprovals.confirm', { ticketId: prepared.id, update }], ['drafts.approve', { id: saved.draftId, when: 'now' }],
        ['schedules.update', { id: saved.draftId, enabled: true }], ['schedules.delete', { id: saved.draftId }], ['videos.render', {}], ['videos.adCreate', {}],
    ] as [string, any][]) {
        const reply = await call(runner, method, params, { confirm: true, idempotencyKey: `denied-${method}` });
        expect(reply).toMatchObject({ status: 403, body: { error: { code: 'FORBIDDEN' } } });
    }
    expect((await send(runner, '/v1/media', {})).status).toBe(403);
    expect((await send(runner, '/v1/pair', { ticket: 'not-issued' })).status).toBe(401);
    const described = (await send(runner, '/v1/describe', undefined, 'GET')).body.result.methods;
    expect(described).toContainEqual(expect.objectContaining({ name: 'pageWork.saveDraft' }));
    for (const name of ['drafts.approve', 'schedules.update', 'pageApprovals.confirm', 'videos.render'])
        expect(described).not.toContainEqual(expect.objectContaining({ name }));
    expect(poster.getSchedule(saved.draftId)).toEqual(before); expect(works.getApproval(prepared.id).consumedAt).toBeNull();
    expect(database.query('SELECT * FROM fb_poster_schedules')).toHaveLength(1); expect(database.query('SELECT * FROM control_keys')).toHaveLength(2);
    expect(database.query('SELECT * FROM control_idempotency')).toEqual([]); expect(render).not.toHaveBeenCalled();
    expect(opens).toEqual(['alpha']); expect(closes).toBe(1); assertProfilesReleased();
});

test('trustedApprovalRequiresCurrentRevision', async () => {
    seed(); const runner = key(); const receiver = key('page_receiver'); const work = await claim(runner);
    const saved = await ok(runner, 'pageWork.saveDraft', { ...lease(work), draftIndex: 0, draft: { text: 'First' } });
    const stale = await ticket(receiver, saved);
    const edited = await ok(runner, 'pageWork.saveDraft', { ...lease(work), draftIndex: 0, draft: { id: saved.draftId, expectedRevision: 1, text: 'Current' } });
    expect((await call(receiver, 'pageApprovals.confirm', { ticketId: stale.id, update })).body.error?.code).toBe('CONFLICT');
    expect(poster.getSchedule(saved.draftId)).toMatchObject({ draft: true, enabled: false, revision: 2 }); expect(works.getApproval(stale.id).consumedAt).toBeNull();
    const current = await ticket(receiver, edited);
    const badUpdate = { ...update, senderId: '3' };
    expect((await call(receiver, 'pageApprovals.confirm', { ticketId: current.id, update: badUpdate })).body.error?.code).toBe('FORBIDDEN');
    // A failed durable ticket write must roll back draft promotion on the same SQLite connection.
    database.exec("CREATE TRIGGER reject_approval BEFORE UPDATE ON page_owner_approvals WHEN NEW.consumed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'disk failure'); END;");
    expect((await call(receiver, 'pageApprovals.confirm', { ticketId: current.id, update })).body.error?.code).toBe('INTERNAL');
    expect(poster.getSchedule(saved.draftId)).toMatchObject({ draft: true, enabled: false }); expect(works.getApproval(current.id).consumedAt).toBeNull();
    database.exec('DROP TRIGGER reject_approval');
    const approvalEventsBefore = database.query("SELECT * FROM control_events WHERE type = 'draft.approved'").length;
    const hintsBefore = emit.mock.calls.length;
    const result = await ok(receiver, 'pageApprovals.confirm', { ticketId: current.id, update }); expect(result.replayed).toBe(false);
    const approved = poster.getSchedule(saved.draftId); expect(approved).toMatchObject({ draft: false, enabled: true, params: { text: 'Current' } });
    expect((await ok(receiver, 'pageApprovals.confirm', { ticketId: current.id, update })).replayed).toBe(true);
    expect(poster.getSchedule(saved.draftId)).toEqual(approved); expect(database.query('SELECT * FROM page_owner_approvals WHERE consumed_at IS NOT NULL')).toHaveLength(1);
    expect(database.query("SELECT * FROM control_events WHERE type = 'draft.approved'")).toHaveLength(approvalEventsBefore + 1);
    expect(emit.mock.calls.length).toBe(hintsBefore + 1);
    expect(works.get(work.id).status).toBe('running'); expect(database.query('SELECT * FROM fb_poster_schedules')).toHaveLength(1); assertProfilesReleased();
});

test('restartAndRevocationStopStaleWrites', async () => {
    seed(); const runner = key(); const work = await claim(runner);
    let release!: () => void; let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
    openActor = async () => { assertProfileHeld(); entered(); await new Promise<void>(resolve => { release = resolve; }); };
    const pending = call(runner, 'pageWork.saveDraft', { ...lease(work), draftIndex: 0, draft: { text: 'Never saved' } }, { idempotencyKey: 'late-draft' });
    await reached; options.store.revokeKey(runner.id); release();
    expect((await pending).body.error?.code).toBe('FORBIDDEN'); assertProfilesReleased();
    expect(database.query('SELECT * FROM fb_poster_schedules')).toEqual([]); expect(works.get(work.id).draftIds).toEqual([]);
    expect(database.query('SELECT * FROM control_idempotency')).toEqual([]); expect(closes).toBe(1);
    await api.restartControlApi();
    expect(works.get(work.id)).toMatchObject({ status: 'needs_review', attempts: 1 });
    expect((await call(runner, 'pageWork.saveDraft', { ...lease(work), draftIndex: 0, draft: { text: 'Old credential' } })).status).toBe(401);
    const replacement = key(); expect(await claim(replacement)).toBeNull();
    expect((await call(replacement, 'pageWork.saveDraft', { ...lease(work), draftIndex: 0, draft: { text: 'Old lease' } })).body.error?.code).toBe('CONFLICT');
    expect(database.query('SELECT * FROM fb_poster_schedules')).toEqual([]); expect(database.query('SELECT * FROM page_work_items')).toHaveLength(1);
    expect(database.query('SELECT * FROM page_work_resources')).toEqual([]); expect(opens).toEqual(['alpha']); expect(render).not.toHaveBeenCalled(); assertProfilesReleased();
});
