import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';

// Composition over the real facebookPosterIpc/browserProfileIpc/videoIpc lifecycle, coordinator, workers, profile queue,
// BrowserProfileService, scheduler, side services and SQLite store. Fake: native launch/process, Playwright page,
// render/AI transport, host persona and pacing clock. Stubbed: researchIpc (test-built ResearchService with its own
// openSession over the real queue binding, no-op retireResearchService), WorkspaceManager, AppModeManager and workspaceIpc.
const FAKE_EXE = '/synthetic/maihub-engine';
const COOKIE_VALUE = 'synthetic-cookie-value-never-logged';
const external = ['electron', 'xlsx', 'child_process', '../../services/database/DatabaseService', '../../utils/WorkspaceManager',
    '../../utils/AppModeManager', '../../utils/Logger', '../../services/ai/AIAssistantService', '../../services/event/EventBroadcaster',
    '../../services/browser/BrowserEngineManager', '../../services/browser/sandboxSupport', '../../services/browser/automationLauncher',
    '../../../electron/ipc/researchIpc', '../../services/video/RenderClient', '../../../electron/ipc/inboxMedia', '../../../electron/ipc/workspaceIpc',
    '../../services/browser/fingerprint', '../../services/facebookPoster/humanize', '../../services/video/AhvAdClient'];
const PROFILE_IDS = Array.from({ length: 40 }, (_, i) => `p${String(i + 1).padStart(2, '0')}`);

type FakeContext = EventEmitter & { closed: boolean; profileId: string; pages(): any[]; newPage(): Promise<any>; cookies(): Promise<any[]>; close(): Promise<void> };
let root: string, workspaceId: string, switching: boolean;
let natives: Record<string, Database.Database>, active: { native: Database.Database; file: string };
let facade: any, ipc: any, browserIpc: any, videoIpc: any, researchStore: any, research: any, createResearch: () => any, poster: any, handlers: Map<string, (event: unknown, params?: unknown) => Promise<any>>;
let events: Array<{ channel: string; data: any }>, logs: Array<{ level: string; message: string }>;
let liveNative: Set<string>, maxNativeProfiles: number, launches: string[], contexts: FakeContext[];
let holds: Map<string, { promise: Promise<void>; release: () => void }>, hangClose: Set<string>, closeRequests: string[];
let clicks: Array<{ profileId: string; workspace: string }>, typed: Record<string, string>, afterClick: (profileId: string) => void, acknowledgement: boolean, hangAck: boolean;
let crossWorkspaceEffects: string[], settings: Map<string, string>;
let controlRecorder: any, ControlStoreClass: any, CONTROL_SCHEMA: string, ackUntilClose: boolean;

function hold(profileId: string): () => void {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    holds.set(profileId, { promise, release: () => { holds.delete(profileId); release(); } });
    return holds.get(profileId)!.release;
}
const release = (profileId: string) => holds.get(profileId)?.release();
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
async function until(predicate: () => boolean, label: string, rounds = 400): Promise<void> {
    for (let i = 0; i < rounds; i++) { if (predicate()) return; await tick(1); }
    throw new Error(`Timed out waiting for ${label}`);
}

function openDb(file: string): void {
    if (!natives[file]) natives[file] = new Database(file);
    active = { native: natives[file], file };
    // The daily login sweep (default 07:00 local) is unrelated to these cases; disable it through its real config key.
    if (!settings.has(`${file}:fb_poster_login_check`)) settings.set(`${file}:fb_poster_login_check`, JSON.stringify({ enabled: false, time: '07:00' }));
}
// Fixed instant (a Wednesday, minute-aligned) so fake-clock cases never depend on the wall clock or the host time zone.
const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);
function fakeClock(): void { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); jest.setSystemTime(T0); }
function profile(id: string) {
    return PROFILE_IDS.includes(id) ? { id, name: id.toUpperCase(), group_id: null, proxy_id: null, note: '',
        fingerprint: { seed: 1, hardwareConcurrency: 8, language: 'vi-VN', timezone: 'Asia/Ho_Chi_Minh' },
        last_opened_at: null, created_at: 0, updated_at: 0 } : null;
}
function makeFacade() {
    let dead = false;
    // A crashed process keeps no usable handle; its leftover promises must not reach the restarted connection.
    const conn = () => { if (dead) throw new Error('synthetic crashed process: database handle is gone'); return active.native; };
    return {
        kill: () => { dead = true; },
        exec: (sql: string) => { conn().exec(sql); }, run: (sql: string, p: any[] = []) => { conn().prepare(sql).run(...p); },
        runInsert: (sql: string, p: any[] = []) => Number(conn().prepare(sql).run(...p).lastInsertRowid),
        query: (sql: string, p: any[] = []) => [...conn().prepare(sql).all(...p)],
        queryOne: (sql: string, p: any[] = []) => conn().prepare(sql).get(...p),
        transaction: (fn: () => any) => conn().transaction(fn)(),
        getDbPath: () => active.file, getSetting: (key: string) => settings.get(`${active.file}:${key}`) ?? null,
        setSetting: (key: string, value: string) => { settings.set(`${active.file}:${key}`, value); },
        getBrowserProfileById: profile, getBrowserProfiles: () => PROFILE_IDS.map(profile), getProxyById: () => null, touchBrowserProfileOpened: () => undefined,
    };
}

function fakePage(context: FakeContext, workspace: string): any {
    const id = context.profileId;
    const closed = new Promise<never>((_, reject) => context.once('close', () => reject(new Error('Target page, context or browser has been closed'))));
    closed.catch(() => undefined);
    const click = async () => {
        clicks.push({ profileId: id, workspace });
        if (workspace !== workspaceId) crossWorkspaceEffects.push(`${workspace}->${workspaceId}:${id}`);
        afterClick(id);
    };
    return {
        url: () => 'https://www.facebook.com/', content: async () => '<html><body>synthetic</body></html>',
        goto: async () => { const gate = holds.get(id); if (gate) await Promise.race([gate.promise, closed]); if (context.closed) throw new Error('Target closed'); },
        $: async () => null, $$: async () => [], on() {}, off() {}, once() {}, screenshot: async () => Buffer.from(''),
        evaluate: async (fn: { name?: string }) => ['composerIsOpenInPage', 'focusEditorInPage', 'markPublishButtonInPage'].includes(fn?.name ?? ''),
        locator: (selector: string) => ({ first: () => ({ click: selector.includes('publish') ? click : async () => undefined }) }),
        keyboard: { type: async (text: string) => { typed[id] = (typed[id] ?? '') + text; }, press: async () => undefined },
        mouse: { move: async () => undefined, down: async () => undefined, up: async () => undefined, wheel: async () => undefined },
        waitForSelector: async (_selector: string, opts?: { state?: string }) => {
            if (opts?.state === 'hidden' && hangAck) return new Promise<never>(() => undefined);
            if (opts?.state === 'hidden' && ackUntilClose) return closed;
            if (opts?.state === 'hidden' && !acknowledgement) throw new Error('synthetic missing acknowledgement');
            return null;
        },
        waitForTimeout: async () => undefined, waitForFunction: async () => undefined, waitForLoadState: async () => undefined, isClosed: () => context.closed,
    };
}
// Fake native boundary: one launched context per profile directory, tracked against the 30-profile ceiling.
async function launchAutomationBrowser(_exe: string, userDataDir: string): Promise<FakeContext> {
    const profileId = path.basename(userDataDir);
    const workspace = workspaceId;
    if (liveNative.has(profileId)) throw new Error(`double native owner ${profileId}`);
    liveNative.add(profileId); launches.push(profileId); maxNativeProfiles = Math.max(maxNativeProfiles, liveNative.size);
    const context = new EventEmitter() as FakeContext;
    context.profileId = profileId; context.closed = false;
    const page = fakePage(context, workspace);
    context.pages = () => [page]; context.newPage = async () => page;
    context.cookies = async () => [{ name: 'c_user', value: COOKIE_VALUE }];
    context.close = async () => {
        closeRequests.push(profileId);
        if (hangClose.has(profileId)) return new Promise<void>(resolve => context.once('close', () => resolve()));
        exitContext(context);
    };
    contexts.push(context);
    return context;
}
function exitContext(context: FakeContext): void {
    if (context.closed) return;
    context.closed = true; liveNative.delete(context.profileId); context.emit('close');
}
function fakeChild(profileId: string): any {
    const child = new EventEmitter() as any;
    if (liveNative.has(profileId)) throw new Error(`double native owner ${profileId}`);
    liveNative.add(profileId); maxNativeProfiles = Math.max(maxNativeProfiles, liveNative.size);
    child.pid = 1000 + PROFILE_IDS.indexOf(profileId);
    child.kill = () => { setImmediate(() => { if (liveNative.delete(profileId)) child.emit('exit', 0); }); return true; };
    setImmediate(() => child.emit('spawn'));
    return child;
}

function loadRuntime(): void {
    jest.isolateModules(() => {
        poster = new (require('../../services/facebookPoster/FacebookPosterStore').FacebookPosterStore)(facade); poster.ensureSchema();
        researchStore = new (require('../../services/research/ResearchStore').ResearchStore)(facade); researchStore.ensureSchema();
        new (require('../../services/dailyBrief/DailyBriefStore').DailyBriefStore)(facade).ensureSchema();
        ipc = require('../../../electron/ipc/facebookPosterIpc');
        browserIpc = require('../../../electron/ipc/browserProfileIpc');
        videoIpc = require('../../../electron/ipc/videoIpc');
        // Real control event recorder/store over the same singleton facade production binds (it follows the active DB).
        controlRecorder = new (require('../../services/control/ControlEventRecorder').ControlEventRecorder)();
        ({ ControlStore: ControlStoreClass, CONTROL_SCHEMA_SQL: CONTROL_SCHEMA } = require('../../services/control/ControlStore'));
        const ResearchService = require('../../services/research/ResearchService').ResearchService;
        // Lazy, like the production getter: the composition (and its captured clock) is built by the first job, after any fake clock.
        research = null;
        createResearch = () => { const binding = ipc.getProfileJobBinding(); return new ResearchService({ store: researchStore, newId: () => `research-${workspaceId}`, assertCurrent: binding.assertCurrent,
            listProfiles: () => PROFILE_IDS.map(id => ({ id, name: id })), isProfileBusy: binding.isProfileBusy, loginStates: () => [], groupMembership: () => ({}),
            readConfig: () => ({ excludedProfileIds: [], perProfileDailyCap: 100 }), observeLogin() {}, emit() {}, sleep: async () => undefined,
            openSession: async (target: string, guard: () => void, context: any) => {
                const opened = await binding.openForAutomation(target, context); guard();
                const page = opened.context.pages()[0];
                const session = { open: async () => { await page.goto('https://www.facebook.com/'); }, userId: () => '1',
                    ensureQuery: async () => { throw new Error('synthetic provider boundary'); }, call: async () => '',
                    recapture: async () => { throw new Error('synthetic provider boundary'); } };
                return { session, close: opened.close };
            } }); };
    });
}
const researchService = () => (research ??= createResearch());

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-8-bgjobs-'));
    natives = {}; settings = new Map(); workspaceId = 'workspace-a'; switching = false;
    events = []; logs = []; liveNative = new Set(); maxNativeProfiles = 0; launches = []; contexts = [];
    holds = new Map(); hangClose = new Set(); closeRequests = []; clicks = []; typed = {}; afterClick = () => undefined; acknowledgement = true; hangAck = false; ackUntilClose = false; crossWorkspaceEffects = []; handlers = new Map();
    fs.mkdirSync(path.join(root, 'a')); fs.mkdirSync(path.join(root, 'b'));
    openDb(path.join(root, 'a', 'workspace.db'));
    facade = makeFacade();
    const actualChild = jest.requireActual('child_process');
    jest.doMock(external[0], () => ({ app: { getPath: () => root, getAppPath: () => process.cwd(), getVersion: () => '1.0' },
        ipcMain: { handle: (channel: string, fn: any) => { handlers.set(channel, fn); } }, dialog: {},
        safeStorage: { isEncryptionAvailable: () => false }, BrowserWindow: { getAllWindows: () => [] } }));
    jest.doMock(external[1], () => ({}));
    jest.doMock(external[2], () => ({ ...actualChild, spawn: (exe: string, args: string[], opts: any) => exe === FAKE_EXE
        ? fakeChild(path.basename(String(args.find(arg => arg.startsWith('--user-data-dir='))).slice('--user-data-dir='.length)))
        : actualChild.spawn(exe, args, opts) }));
    jest.doMock(external[3], () => ({ __esModule: true, default: { getInstance: () => facade } }));
    jest.doMock(external[4], () => ({ __esModule: true, default: { getInstance: () => ({ getActiveWorkspace: () => ({ id: workspaceId }) }) } }));
    jest.doMock(external[5], () => ({ __esModule: true, default: { getInstance: () => ({ isEmployeeMode: () => false, clearOverride() {} }) } }));
    jest.doMock(external[6], () => ({ __esModule: true, default: {
        error: (message: string) => logs.push({ level: 'error', message }), warn: (message: string) => logs.push({ level: 'warn', message }),
        log: () => undefined, info: () => undefined, debug: () => undefined } }));
    jest.doMock(external[7], () => ({ __esModule: true, default: { getInstance: () => ({ getDefaultAssistant: () => null,
        completeRaw: async () => { throw new Error('No provider call authorized by this fixture'); } }) } }));
    jest.doMock(external[8], () => ({ __esModule: true, default: { emit: (channel: string, data: unknown) => events.push({ channel, data: structuredClone(data) }) } }));
    jest.doMock(external[9], () => ({ BrowserEngineManager: class { getExecutablePath() { return FAKE_EXE; } getStatus() { return { installed: true }; } } }));
    jest.doMock(external[10], () => ({ getSandboxSupport: () => ({ get: async () => 'enabled' }) }));
    jest.doMock(external[11], () => ({ launchAutomationBrowser }));
    jest.doMock(external[12], () => ({ researchOperations: {}, getResearchStore: () => researchStore, getResearchService: () => researchService(),
        isResearchRunning: () => research?.isRunning() ?? false, cancelResearch: () => research?.stop(), retireResearchService: () => undefined,
        cancelAndWaitResearch: async () => { research?.stop(); await research?.whenIdle(); return !research?.isRunning(); } }));
    // Render/ad provider transport is fake; the video IPC/service/store stay real and never touch the profile queue.
    jest.doMock(external[13], () => ({ RenderClient: class { async templates() { return { templates: [{ id: 'synthetic-template' }], music: [] }; } } }));
    jest.doMock(external[18], () => ({ AhvAdClient: class {} }));
    jest.doMock(external[14], () => ({ getInboxMediaStore: () => ({}) }));
    jest.doMock(external[15], () => ({ isWorkspaceSwitchInProgress: () => switching }));
    // The engine supports Windows/Linux hosts only; the synthetic host persona keeps every other launch check real.
    jest.doMock(external[16], () => ({ ...jest.requireActual(external[16]), hostPersona: () => 'linux' }));
    // Fake clock for human pacing only; publish, critical sections and journaling stay real.
    const yieldOnce = () => new Promise<void>(resolve => setImmediate(resolve));
    jest.doMock(external[17], () => ({ delayRandom: yieldOnce, sleepStoppable: yieldOnce,
        humanClick: async (page: any, selector: string) => { const element = await page.waitForSelector(selector, { state: 'visible', timeout: 20000 }); await element.click(); } }));
    loadRuntime();
});

afterEach(async () => {
    try {
        // Real timers first: a drain under a frozen fake clock would wait out its grace windows.
        jest.useRealTimers();
        for (const id of [...holds.keys()]) release(id);
        hangClose.clear();
        for (const context of contexts) exitContext(context);
        try { ipc?.stopFacebookPosterScheduler(); } catch { /* retired generation */ }
        try { await ipc?.cancelAndWaitFacebookPosterJobs(); } catch { /* retired generation */ }
        expect(JSON.stringify([logs, events])).not.toContain(COOKIE_VALUE);
    } finally {
        external.forEach(name => jest.dontMock(name));
        jest.restoreAllMocks();
        for (const native of Object.values(natives)) native.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

const pagePost = (profileIds: string[], text = 'Synthetic background post') => ({ kind: 'post', params: {
    mode: 'page', text, mediaPaths: [], minDelaySec: 0, maxDelaySec: 0, concurrency: Math.min(10, profileIds.length), staggerMinSec: 0, staggerMaxSec: 0,
    profiles: profileIds.map(profileId => ({ profileId, targets: ['https://www.facebook.com/'] })) } });
const runs = () => poster.listRuns({ limit: 500, offset: 0 }).runs as Array<{ id: string; status: string }>;
const running = () => runs().filter(run => run.status === 'running');
const activeIds = () => ipc.posterOperations.active().runs.map((x: any) => x.run.id) as string[];
const resultsOf = (runId: string) => poster.getRun(runId)!.results as Array<{ profileId: string; outcome: string; errorCode: string; error: string }>;

test('two independent poster runs progress on different profiles and finish without mixing results', async () => {
    hold('p01'); hold('p02');
    const a = ipc.posterOperations.start(pagePost(['p01'], 'Post A')).runId;
    const b = ipc.posterOperations.start(pagePost(['p02'], 'Post B')).runId;
    await until(() => launches.includes('p01') && launches.includes('p02'), 'both launches');
    expect(running().map(run => run.id).sort()).toEqual([a, b].sort());
    expect(running().length).toBeLessThanOrEqual(2);
    release('p02');
    await until(() => poster.getRun(b)?.run.status !== 'running', 'run B finished');
    expect(poster.getRun(a)!.run.status).toBe('running');
    release('p01');
    await until(() => poster.getRun(a)?.run.status !== 'running', 'run A finished');
    expect(resultsOf(a).map(r => r.profileId)).toEqual(['p01']);
    expect(resultsOf(b).map(r => r.profileId)).toEqual(['p02']);
    expect(typed).toEqual({ p01: 'Post A', p02: 'Post B' });
    expect(clicks.map(c => c.profileId).sort()).toEqual(['p01', 'p02']);
});

const BUSY = 'Đang có việc chạy';
const job = (jobId: string) => ({ jobId, signal: new AbortController().signal, priority: 'interactive' as const, assertCurrent: () => undefined });
const browser = () => browserIpc.getBrowserProfileService();
const finished = (runId: string) => () => !!poster.getRun(runId) && poster.getRun(runId).run.status !== 'running';
const idle = () => !ipc.isFacebookPosterBusy();
function seedTracking(profileId: string, index: number): string {
    const now = Date.now(), postUrl = `https://www.facebook.com/groups/${index}/posts/${index}9/`;
    poster.createTracking({ resultId: index, runId: `seed-${index}`, scheduleId: null, profileId, groupUrl: `https://www.facebook.com/groups/${index}/`, groupId: String(index),
        postId: `${index}9`, postUrl, postedAt: now, textHead: 'synthetic', linkStatus: 'known', removedSuspected: false, lastSeenAt: null, lastCheckedAt: null,
        checkCount: 0, nextCheckAt: now, statsDone: [], commentsDone: [], nextCommentAt: now });
    return postUrl;
}

test('two live poster runs coexist with every side service on other profiles, each keeping its own one-job limit', async () => {
    for (const id of ['p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07']) hold(id);
    seedTracking('p05', 5); const collectUrl = seedTracking('p06', 6);
    const a = ipc.posterOperations.start(pagePost(['p01'], 'Post A')).runId;
    const b = ipc.posterOperations.start(pagePost(['p02'], 'Post B')).runId;
    const side = {
        login: () => ipc.checkFacebookLogins(['p03'], 'manual'),
        learn: () => ipc.learnPages(['p04'], true),
        track: () => ipc.trackingOperations.track({ profileIds: ['p05'] }),
        collect: () => ipc.leadOperations.collect({ postUrls: [collectUrl] }),
        research: () => researchService().search({ source: 'posts', query: 'synthetic', profileIds: ['p07'], origin: 'manual' }),
    };
    for (const start of Object.values(side)) start();
    await until(() => ['p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07'].every(id => launches.includes(id)), 'all seven sessions');
    expect(running().map(run => run.id).sort()).toEqual([a, b].sort());
    for (const start of Object.values(side)) expect(start).toThrow(BUSY);
    expect(() => ipc.posterOperations.start(pagePost(['p08']))).toThrow(BUSY);
    expect(runs()).toHaveLength(2);
    expect(maxNativeProfiles).toBe(7);
    for (const id of ['p03', 'p04', 'p05', 'p06', 'p07']) release(id);
    await until(() => !researchService().isRunning() && !ipc.isPageLearnerRunning(), 'side jobs settle');
    expect(running()).toHaveLength(2);
    release('p01'); release('p02');
    await until(idle, 'composition idle');
    expect(resultsOf(a).map(r => [r.profileId, r.outcome])).toEqual([['p01', 'posted']]);
    expect(resultsOf(b).map(r => [r.profileId, r.outcome])).toEqual([['p02', 'posted']]);
});

test('a side job on the profile held by a poster waits, then reuses it only after the poster session closed', async () => {
    hold('p01');
    const a = ipc.posterOperations.start(pagePost(['p01'])).runId;
    await until(() => launches.includes('p01'), 'poster launch');
    ipc.checkFacebookLogins(['p01'], 'manual');
    await tick(20);
    expect(launches).toEqual(['p01']);
    release('p01');
    await until(() => launches.length === 2, 'login check launch');
    // The fake native boundary throws on a second live owner, so this launch proves the poster session had closed.
    expect(launches).toEqual(['p01', 'p01']); expect(contexts[0].closed).toBe(true);
    await until(finished(a), 'poster run settles');
    await until(idle, 'composition idle');
    expect(maxNativeProfiles).toBe(1);
});

test('50 competing starts and 50 cancels on one profile admit two runs, open one browser and leak no waiter', async () => {
    hold('p01');
    const accepted: string[] = [], rejected: string[] = [];
    for (let i = 0; i < 50; i++) {
        try { accepted.push(ipc.posterOperations.start(pagePost(['p01'], `Contender ${i}`)).runId); }
        catch (error) { rejected.push((error as Error).message); }
    }
    expect(accepted).toHaveLength(2); expect(rejected).toEqual(Array(48).fill(BUSY));
    expect(runs()).toHaveLength(2);
    const [a, b] = accepted;
    await until(() => launches.includes('p01'), 'first owner launch');
    const waiting = ipc.posterOperations.active().runs.find((x: any) => x.run.id === b).progress.profiles[0];
    expect(waiting).toMatchObject({ state: 'waiting', waitingReason: 'Đang chờ profile khả dụng' });
    const outcomes: string[] = [];
    for (let i = 0; i < 50; i++) {
        const params = [undefined, { runId: `missing-${i}` }, { runId: b }, { runId: '' }, { runId: 7 }][i % 5];
        try { outcomes.push(`ok:${ipc.posterOperations.cancel(params).cancelled}`); }
        catch (error) { outcomes.push(`error:${(error as any).code ?? (error as Error).message}`); }
    }
    expect(outcomes.filter(x => x === 'error:CONFLICT')).toHaveLength(10);
    expect(outcomes.filter(x => x === 'error:NOT_FOUND')).toHaveLength(10);
    expect(outcomes.filter(x => x === 'ok:true')).toHaveLength(10);
    expect(outcomes.filter(x => x === 'error:Mã lượt không hợp lệ')).toHaveLength(20);
    await until(finished(b), 'cancelled waiter settles');
    expect(poster.getRun(b).run.status).toBe('cancelled');
    expect(ipc.posterOperations.cancel({ runId: b })).toEqual({ cancelled: false });
    expect(activeIds()).toEqual([a]);
    release('p01');
    await until(idle, 'composition idle');
    expect(poster.getRun(a).run.status).toBe('done');
    expect(launches).toEqual(['p01']); expect(maxNativeProfiles).toBe(1);
    expect(clicks).toHaveLength(1); expect(typed).toEqual({ p01: 'Contender 0' });
    expect(runs()).toHaveLength(2);
});

test('30 mixed manual and automation profiles never open a 31st; freeing one wakes the queued side job', async () => {
    const automation = PROFILE_IDS.slice(20, 30);
    automation.forEach(hold);
    ipc.posterOperations.start(pagePost(automation.slice(0, 5)));
    ipc.posterOperations.start(pagePost(automation.slice(5)));
    for (const id of PROFILE_IDS.slice(0, 20)) await browser().open(id);
    await until(() => liveNative.size === 30, 'thirty live profiles');
    await expect(browser().open('p31')).rejects.toThrow('Đã đạt giới hạn 30 profile mở cùng lúc');
    ipc.checkFacebookLogins(['p31'], 'manual');
    await tick(20);
    expect(launches).not.toContain('p31'); expect(liveNative.size).toBe(30);
    browser().close('p01');
    await until(() => launches.includes('p31'), 'freed capacity wakes p31');
    expect(maxNativeProfiles).toBeLessThanOrEqual(30); expect(maxNativeProfiles).toBe(30);
    automation.forEach(release);
    await until(idle, 'composition idle');
    expect(running()).toHaveLength(0);
});

test('100+ interleaved events from two runs stay keyed to their own run ID, progress and result rows', async () => {
    const plan: Record<string, string[]> = {};
    const a = ipc.posterOperations.start(pagePost(PROFILE_IDS.slice(0, 7), 'Run A')).runId; plan[a] = PROFILE_IDS.slice(0, 7);
    const b = ipc.posterOperations.start(pagePost(PROFILE_IDS.slice(7, 14), 'Run B')).runId; plan[b] = PROFILE_IDS.slice(7, 14);
    await until(idle, 'both runs finished');
    const keyed = events.filter(e => e.channel.startsWith('facebookPoster:') && e.data?.runId);
    expect(keyed.length).toBeGreaterThanOrEqual(100);
    let switches = 0;
    keyed.forEach((e, i) => { if (i && e.data.runId !== keyed[i - 1].data.runId) switches++; });
    expect(switches).toBeGreaterThan(2);
    for (const runId of [a, b]) {
        const own = keyed.filter(e => e.data.runId === runId);
        expect(own.filter(e => e.channel === 'facebookPoster:runFinished')).toEqual([{ channel: 'facebookPoster:runFinished', data: { runId, status: 'done' } }]);
        expect(own[own.length - 1].channel).toBe('facebookPoster:runFinished');
        for (const e of own.filter(x => x.channel === 'facebookPoster:log')) expect(plan[runId]).toContain(e.data.profileId);
        const done = own.filter(e => e.channel === 'facebookPoster:progress').map(e => e.data.done);
        expect(done).toEqual([...done].sort((x, y) => x - y));
        for (const e of own.filter(x => x.channel === 'facebookPoster:progress')) expect(e.data.profiles.map((p: any) => p.profileId)).toEqual(plan[runId]);
        expect(resultsOf(runId).map(r => r.profileId).sort()).toEqual(plan[runId]);
    }
    expect(typed).toEqual({
        ...Object.fromEntries(plan[a].map(id => [id, 'Run A'])), ...Object.fromEntries(plan[b].map(id => [id, 'Run B'])) });
});

test('a stale owner token or native close callback cannot release or close the newer owner', async () => {
    const binding = ipc.getProfileJobBinding();
    const first = await binding.openForAutomation('p01', job('old-owner'));
    const oldContext = contexts[0];
    await first.close();
    const second = await binding.openForAutomation('p01', job('new-owner'));
    await first.close();
    oldContext.emit('close');
    expect(liveNative.has('p01')).toBe(true); expect(binding.isProfileBusy('p01')).toBe(true);
    let third: any;
    const pending = binding.openForAutomation('p01', job('third-owner')).then((session: any) => { third = session; });
    await tick(20);
    expect(third).toBeUndefined(); expect(launches).toEqual(['p01', 'p01']);
    await second.close(); await pending;
    expect(launches).toEqual(['p01', 'p01', 'p01']); expect(maxNativeProfiles).toBe(1);
    await third.close();
    await until(idle, 'queue idle');
});

test('an unconfirmed browser close keeps that profile and its run slot owned while an independent profile keeps working', async () => {
    fakeClock();
    hangClose.add('p01');
    const a = ipc.posterOperations.start(pagePost(['p01'])).runId;
    await until(() => closeRequests.includes('p01'), 'p01 close requested');
    await jest.advanceTimersByTimeAsync(60000);
    await tick(20);
    expect(poster.getRun(a).run.status).toBe('running');
    expect(resultsOf(a).map(r => r.outcome)).toEqual(['posted']);
    const binding = ipc.getProfileJobBinding();
    expect(liveNative.has('p01')).toBe(true); expect(binding.isProfileBusy('p01')).toBe(true);
    const c = ipc.posterOperations.start(pagePost(['p02'], 'Independent')).runId;
    await until(finished(c), 'independent run');
    expect(poster.getRun(c).run.status).toBe('done');
    const b = ipc.posterOperations.start(pagePost(['p01'], 'Waits for p01')).runId;
    await tick(20);
    expect(launches).toEqual(['p01', 'p02']); expect(finished(b)()).toBe(false);
    hangClose.delete('p01'); exitContext(contexts[0]);
    await until(() => finished(a)() && finished(b)(), 'confirmed exit settles A and wakes B');
    expect(poster.getRun(b).run.status).toBe('done');
    expect(launches).toEqual(['p01', 'p02', 'p01']); expect(maxNativeProfiles).toBe(2);
    expect(clicks.map(x => x.profileId)).toEqual(['p01', 'p02', 'p01']);
});

test('caller mutation after start cannot change run A while composer save, schedules and video views stay outside the browser lock', async () => {
    hold('p01'); hold('p02');
    const input = pagePost(['p01'], 'Original A') as any;
    const a = ipc.posterOperations.start(input).runId;
    ipc.posterOperations.start(pagePost(['p02'], 'Original B'));
    input.params.text = 'Mutated'; input.params.profiles[0].profileId = 'p03'; input.params.profiles.push({ profileId: 'p04', targets: ['https://www.facebook.com/'] });
    await until(() => launches.length === 2, 'two sessions');
    expect(() => ipc.posterOperations.start(pagePost(['p05']))).toThrow(BUSY);
    const draft = ipc.posterOperations.draftSave({ params: { mode: 'page', text: 'Draft B', mediaPaths: [], profiles: [{ profileId: 'p01', targets: ['https://www.facebook.com/'] }] } }).schedule;
    expect(draft).toMatchObject({ draft: true, enabled: false });
    expect(ipc.posterOperations.draftGet({ id: draft.id })).toBeTruthy();
    expect(ipc.posterOperations.scheduleList({}).schedules.map((s: any) => s.id)).toEqual([draft.id]);
    expect(ipc.posterOperations.listRuns({}).runs).toHaveLength(2);
    await expect(videoIpc.videoOperations.templates()).resolves.toMatchObject({ templates: [{ id: 'synthetic-template' }] });
    expect(videoIpc.videoOperations.list({}, 'app')).toEqual({ total: 0, videos: [] });
    expect(launches).toEqual(['p01', 'p02']);
    release('p01'); release('p02');
    await until(idle, 'composition idle');
    expect(typed).toEqual({ p01: 'Original A', p02: 'Original B' });
    expect(poster.getRun(a).run.params).toMatchObject({ text: 'Original A', profiles: [{ profileId: 'p01', targets: ['https://www.facebook.com/'] }] });
    expect(poster.getSchedule(draft.id).params.text).toBe('Draft B');
});

test('IPC registry keeps zero/one current envelopes and refuses an ambiguous cancel across two runs', async () => {
    ipc.registerFacebookPosterIpc();
    const call = (channel: string, params?: unknown) => handlers.get(channel)!({}, params);
    expect(await call('facebookPoster:active')).toEqual({ success: true, runs: [] });
    expect(await call('facebookPoster:current')).toEqual({ success: true, run: null, progress: null });
    expect(await call('facebookPoster:cancel')).toEqual({ success: true, cancelled: true });
    fakeClock();
    hold('p01'); hold('p02');
    const a = (await call('facebookPoster:start', pagePost(['p01']))).runId;
    expect((await call('facebookPoster:current')).run.id).toBe(a);
    jest.setSystemTime(Date.now() + 1000); // b starts strictly later, so startedAt alone orders the list
    expect((await call('facebookPoster:active')).runs.map((x: any) => x.run.id)).toEqual([a]);
    const b = (await call('facebookPoster:start', pagePost(['p02']))).runId;
    expect((await call('facebookPoster:start', pagePost(['p03'])))).toEqual({ success: false, error: BUSY });
    expect((await call('facebookPoster:active')).runs.map((x: any) => x.run.id)).toEqual([a, b]);
    expect((await call('facebookPoster:current')).run.id).toBe(a);
    expect(await call('facebookPoster:cancel')).toEqual({ success: false, error: 'Chọn lượt cần dừng' });
    expect(await call('facebookPoster:cancel', { runId: 'missing' })).toEqual({ success: false, error: 'Không tìm thấy lượt' });
    expect(await call('facebookPoster:cancel', { runId: b })).toEqual({ success: true, cancelled: true });
    await until(finished(b), 'run B cancelled');
    expect(await call('facebookPoster:cancel', { runId: b })).toEqual({ success: true, cancelled: false });
    expect(poster.getRun(a).run.status).toBe('running');
    release('p01');
    await until(idle, 'composition idle');
    expect(poster.getRun(a).run.status).toBe('done'); expect(poster.getRun(b).run.status).toBe('cancelled');
});

test('runs started in the same millisecond are listed and chosen as current by runId', async () => {
    fakeClock();
    hold('p01'); hold('p02');
    const a = ipc.posterOperations.start(pagePost(['p01'])).runId;
    const b = ipc.posterOperations.start(pagePost(['p02'])).runId;
    const byId = [a, b].sort();
    expect(ipc.posterOperations.active().runs.map((x: any) => x.run.startedAt)).toEqual([Date.now(), Date.now()]);
    expect(activeIds()).toEqual(byId);
    expect(ipc.posterOperations.current().run.id).toBe(byId[0]);
    release('p01'); release('p02');
    await until(idle, 'composition idle');
});

describe('scheduler with profile availability', () => {
    beforeEach(() => { fakeClock(); });
    const once = (profileIds: string[], name: string) => ipc.posterOperations.scheduleCreate({ kind: 'once', name, runAt: Date.now() + 60000, params: pagePost(profileIds, name).params }).schedule.id;
    const scheduleRuns = (id: string) => facade.query('SELECT status, error FROM fb_poster_runs WHERE schedule_id = ? ORDER BY started_at', [id]);

    test('schedule Y on a free profile runs while X stays queued for its busy profile, then X runs after release', async () => {
        await browser().open('p01');
        const x = once(['p01'], 'X'), y = once(['p02'], 'Y');
        ipc.startFacebookPosterScheduler();
        await jest.advanceTimersByTimeAsync(61000);
        await until(() => scheduleRuns(y).length === 1 && scheduleRuns(y)[0].status === 'done', 'Y finished');
        expect(scheduleRuns(x)).toEqual([]);
        expect(ipc.posterOperations.scheduleList({}).queuedIds).toEqual([x]);
        browser().close('p01');
        await until(() => scheduleRuns(x).some((r: any) => r.status === 'done'), 'X runs after release');
        expect(scheduleRuns(x)).toEqual([{ status: 'done', error: '' }]);
        expect(launches).toEqual(['p02', 'p01']);
    });

    test('X keeps its occurrence deadline: missed after two hours without a run or launch', async () => {
        await browser().open('p01');
        const x = once(['p01'], 'X');
        ipc.startFacebookPosterScheduler();
        await jest.advanceTimersByTimeAsync(61000);
        expect(ipc.posterOperations.scheduleList({}).queuedIds).toEqual([x]);
        await jest.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
        await tick(5);
        expect(scheduleRuns(x)).toEqual([{ status: 'missed', error: 'Chờ quá 2 giờ vì đang có việc khác' }]);
        expect(launches).toEqual([]);
    });

    test('a started partial schedule waits for its busy profile only until the original occurrence deadline', async () => {
        await browser().open('p01');
        const x = once(['p01', 'p02'], 'X');
        ipc.startFacebookPosterScheduler();
        await jest.advanceTimersByTimeAsync(61000);
        await until(() => launches.includes('p02') && clicks.length === 1, 'p02 posted');
        const runId = facade.queryOne('SELECT id FROM fb_poster_runs WHERE schedule_id = ?', [x]).id;
        expect(poster.getRun(runId).run.status).toBe('running');
        await jest.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
        await until(finished(runId), 'deadline settles the waiter');
        expect(resultsOf(runId).map(r => [r.profileId, r.outcome, r.errorCode]).sort()).toEqual([['p01', 'failed', 'profile_wait_timeout'], ['p02', 'posted', '']]);
        expect(launches).toEqual(['p02']);
    });
});

test('a workspace identity change during a profile wait rejects the waiter before any launch', async () => {
    await browser().open('p01');
    const a = ipc.posterOperations.start(pagePost(['p01'])).runId;
    await tick(10);
    workspaceId = 'workspace-revoked';
    browser().close('p01');
    await until(finished(a), 'revoked waiter settles');
    expect(launches).toEqual([]); expect(clicks).toEqual([]);
    expect(resultsOf(a).map(r => [r.outcome, r.error])).toEqual([['failed', 'Đang đổi workspace, thử lại sau']]);
    workspaceId = 'workspace-a';
});

async function switchWorkspace(dirName: string, id: string): Promise<boolean> {
    switching = true;
    // Same order as workspaceIpc: the scheduler keeps its queue during the drain and is stopped by retirement.
    browserIpc.pauseBrowserProfileAdmission(); ipc.pauseFacebookJobAdmission();
    expect(() => ipc.posterOperations.start(pagePost(['p09']))).toThrow('Đang đổi workspace, thử lại sau');
    expect(() => ipc.checkFacebookLogins(['p09'], 'manual')).toThrow('Đang đổi workspace, thử lại sau');
    const drained = await ipc.cancelAndWaitFacebookPosterJobs() && await browserIpc.closeAllBrowserProfilesAndWait(45000);
    if (drained) {
        ipc.retireFacebookJobGeneration(); browserIpc.retireBrowserProfileGeneration();
        openDb(path.join(root, dirName, 'workspace.db')); workspaceId = id;
        poster.ensureSchema(); researchStore.ensureSchema();
    }
    switching = false;
    ipc.resumeFacebookJobAdmission(); browserIpc.resumeBrowserProfileAdmission();
    return drained;
}

test('A→B→A switch drains live jobs, keeps run IDs per workspace and never writes A effects into B', async () => {
    hold('p01');
    const ra = ipc.posterOperations.start(pagePost(['p01'], 'In A')).runId;
    await until(() => launches.length === 1, 'A launch');
    expect(await switchWorkspace('b', 'workspace-b')).toBe(true);
    release('p01');
    expect(() => ipc.posterOperations.cancel({ runId: ra })).toThrow('Không tìm thấy lượt');
    expect(() => ipc.posterOperations.getRun({ runId: ra })).toThrow('Không tìm thấy lần chạy');
    const rb = ipc.posterOperations.start(pagePost(['p01'], 'In B')).runId;
    await until(idle, 'B run finished');
    expect(await switchWorkspace('a', 'workspace-a')).toBe(true);
    expect(() => ipc.posterOperations.cancel({ runId: rb })).toThrow('Không tìm thấy lượt');
    expect(ipc.posterOperations.cancel({ runId: ra })).toEqual({ cancelled: false });
    const rowsOf = (dir: string) => natives[path.join(root, dir, 'workspace.db')].prepare('SELECT id, status FROM fb_poster_runs').all();
    expect(rowsOf('a')).toEqual([{ id: ra, status: 'cancelled' }]);
    expect(rowsOf('b')).toEqual([{ id: rb, status: 'done' }]);
    expect(clicks).toEqual([{ profileId: 'p01', workspace: 'workspace-b' }]);
    expect(crossWorkspaceEffects).toEqual([]);
    // The drain settled ra while the switch was in progress: its finish reached A's UI exactly once, never B's.
    expect(events.filter(e => e.data?.runId === ra && e.channel === 'facebookPoster:runFinished')).toEqual([{ channel: 'facebookPoster:runFinished', data: { runId: ra, status: 'cancelled' } }]);
    const rc = ipc.posterOperations.start(pagePost(['p01'], 'Back in A')).runId;
    await until(idle, 'A again');
    expect(rowsOf('a')).toEqual(expect.arrayContaining([{ id: rc, status: 'done' }]));
    expect(rowsOf('b')).toHaveLength(1);
});

test('a run settled by the switch drain records run.finished in A control_events and reaches the UI; nothing reaches B', async () => {
    const files = { a: path.join(root, 'a', 'workspace.db'), b: path.join(root, 'b', 'workspace.db') };
    natives[files.b] = new Database(files.b);
    for (const file of Object.values(files)) natives[file].exec(CONTROL_SCHEMA);
    controlRecorder.sync(true, false, () => new ControlStoreClass(facade));
    const controlRows = (file: string) => natives[file].prepare('SELECT type, payload FROM control_events ORDER BY seq').all()
        .map((row: any) => [row.type, JSON.parse(row.payload).runId, JSON.parse(row.payload).status ?? null]);
    try {
        hold('p01');
        const ra = ipc.posterOperations.start(pagePost(['p01'], 'Settles in drain')).runId;
        await until(() => launches.length === 1, 'A launch');
        // The drain returns only after ra settled and retirement follows it, so anything recorded for ra was emitted mid-switch.
        expect(await switchWorkspace('b', 'workspace-b')).toBe(true);
        expect(events.filter(e => e.channel === 'facebookPoster:runFinished')).toEqual([{ channel: 'facebookPoster:runFinished', data: { runId: ra, status: 'cancelled' } }]);
        expect(controlRows(files.a)).toEqual([['run.started', ra, null], ['run.finished', ra, 'cancelled']]);
        expect(controlRows(files.b)).toEqual([]);
        const rb = ipc.posterOperations.start(pagePost(['p02'], 'In B')).runId;
        await until(idle, 'B run finished');
        expect(controlRows(files.b)).toEqual([['run.started', rb, null], ['run.finished', rb, 'done']]);
        expect(controlRows(files.a)).toHaveLength(2);
    } finally { controlRecorder.deactivate(); }
});

test('a refused switch keeps a waiting plan and a queued schedule; both run after the profile frees', async () => {
    fakeClock();
    await browser().open('p01');
    const waiting = ipc.posterOperations.start(pagePost(['p01'], 'Waits through refusal')).runId;
    const x = ipc.posterOperations.scheduleCreate({ kind: 'once', name: 'X', runAt: Date.now() + 60000, params: pagePost(['p01'], 'Queued X').params }).schedule.id;
    ipc.startFacebookPosterScheduler();
    await jest.advanceTimersByTimeAsync(61000);
    expect(ipc.posterOperations.scheduleList({}).queuedIds).toEqual([x]);
    // workspaceIpc order up to a refusal (protected or research drain not stopped): pause admission, nothing of the poster is cancelled.
    switching = true;
    browserIpc.pauseBrowserProfileAdmission(); ipc.pauseFacebookJobAdmission();
    await tick(5);
    switching = false;
    ipc.resumeFacebookJobAdmission(); browserIpc.resumeBrowserProfileAdmission(); ipc.startFacebookPosterScheduler();
    await tick(5);
    expect(poster.getRun(waiting).run.status).toBe('running');
    expect(ipc.posterOperations.active().runs.find((r: any) => r.run.id === waiting).progress.profiles[0].state).toBe('waiting');
    expect(ipc.posterOperations.scheduleList({}).queuedIds).toEqual([x]);
    expect(facade.query("SELECT status FROM fb_poster_runs WHERE schedule_id = ?", [x])).toEqual([]);
    browser().close('p01');
    await until(() => facade.query("SELECT status FROM fb_poster_runs WHERE schedule_id = ? AND status = 'done'", [x]).length === 1 && finished(waiting)(), 'both run');
    expect(poster.getRun(waiting).run.status).toBe('done');
    expect(resultsOf(waiting).map(r => [r.profileId, r.outcome])).toEqual([['p01', 'posted']]);
    expect(facade.query('SELECT status, error FROM fb_poster_runs WHERE schedule_id = ?', [x])).toEqual([{ status: 'done', error: '' }]);
    expect(launches).toEqual(['p01', 'p01']);
});

test('a plan that begins its profile acquisition during a later-refused drain waits, then runs after the real resume order', async () => {
    fakeClock();
    hold('p01');
    const params = { ...pagePost(['p01', 'p02'], 'Second plan starts mid-drain').params, staggerMinSec: 60, staggerMaxSec: 60 };
    const run = ipc.posterOperations.start({ kind: 'post', params }).runId;
    await until(() => launches.includes('p01'), 'first plan launched');
    switching = true;
    browserIpc.pauseBrowserProfileAdmission(); ipc.pauseFacebookJobAdmission();
    await jest.advanceTimersByTimeAsync(61000); await tick(10);
    expect(ipc.posterOperations.active().runs[0].progress.profiles.find((p: any) => p.profileId === 'p02').state).toBe('waiting');
    // switchWorkspace's refusal path resumes while the switch flag is still set; the handler clears it and resumes again.
    ipc.resumeFacebookJobAdmission(); browserIpc.resumeBrowserProfileAdmission(); ipc.startFacebookPosterScheduler();
    await tick(10);
    switching = false;
    ipc.resumeFacebookJobAdmission(); browserIpc.resumeBrowserProfileAdmission();
    release('p01');
    await until(finished(run), 'run settles');
    expect(resultsOf(run).map(r => [r.profileId, r.outcome, r.error]).sort()).toEqual([['p01', 'posted', ''], ['p02', 'posted', '']]);
    expect(launches).toEqual(['p01', 'p02']);
});

test('a worker that stops only at the force close does not make the first drain fail', async () => {
    fakeClock();
    ackUntilClose = true;
    const a = ipc.posterOperations.start(pagePost(['p01'], 'Critical until force close')).runId;
    await until(() => clicks.length === 1, 'post submitted');
    let drained: boolean | undefined;
    const drain = ipc.cancelAndWaitFacebookPosterJobs().then((value: boolean) => { drained = value; });
    await jest.advanceTimersByTimeAsync(45000);
    await until(() => finished(a)(), 'force close settles the worker');
    await jest.advanceTimersByTimeAsync(10000);
    await until(() => drained !== undefined, 'drain settles');
    await drain;
    expect(drained).toBe(true);
    expect(resultsOf(a).map(r => r.errorCode)).toEqual(['uncertain_after_submit']);
    expect(liveNative.size).toBe(0);
    ipc.resumeFacebookJobAdmission();
});

function crashAndRestart(clearTimers: boolean): void {
    // The process, its timers, browsers, DB handle and pending promises vanish without any drain or settlement.
    // clearAllTimers also rewinds the fake clock to its install time; keep the crash instant.
    if (clearTimers) { const at = Date.now(); jest.clearAllTimers(); jest.setSystemTime(at); }
    contexts.length = 0; holds.clear(); liveNative.clear(); facade.kill();
    const file = active.file; natives[file].close(); delete natives[file];
    openDb(file); facade = makeFacade(); hangAck = false; loadRuntime();
}

test('manual runs interrupted before and after submit are failed on restart and never restarted', async () => {
    fakeClock();
    hangAck = true; hold('p02');
    await browser().open('p03');
    const a = ipc.posterOperations.start(pagePost(['p01'], 'After submit')).runId;
    const b = ipc.posterOperations.start(pagePost(['p02', 'p03'], 'Before submit')).runId;
    await until(() => clicks.length === 1 && launches.includes('p02'), 'A submitted, B navigating');
    crashAndRestart(true);
    expect(ipc.posterOperations.listRuns({}).runs.map((r: any) => [r.id, r.status]).sort()).toEqual([[a, 'failed'], [b, 'failed']].sort());
    ipc.startFacebookPosterScheduler();
    await jest.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    await tick(10);
    expect(clicks).toHaveLength(1);
    expect(launches).toEqual(['p01', 'p02']);
    expect(runs()).toHaveLength(2); expect(activeIds()).toEqual([]);
});


test.each(['once', 'recurring'] as const)('an owner %s occurrence interrupted after submit is never re-fired after restart', async kind => {
    fakeClock();
    const occurrence = Date.now() + 2 * 60000, local = new Date(occurrence);
    const timing = kind === 'once' ? { runAt: occurrence }
        : { days: [0, 1, 2, 3, 4, 5, 6], time: `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}` };
    const id = ipc.posterOperations.scheduleCreate({ kind, name: kind, ...timing, params: pagePost(['p01'], `Owner ${kind}`).params }).schedule.id;
    hangAck = true; // the Post click happened; its acknowledgement never arrives before the crash
    ipc.startFacebookPosterScheduler();
    await jest.advanceTimersByTimeAsync(2 * 60000 + 1000);
    await until(() => clicks.length === 1, 'occurrence submitted');
    const runId = facade.queryOne('SELECT id FROM fb_poster_runs WHERE schedule_id = ?', [id]).id;
    expect(poster.getRun(runId).run.status).toBe('running');
    crashAndRestart(true);
    ipc.startFacebookPosterScheduler();
    await jest.advanceTimersByTimeAsync(3 * 60 * 60 * 1000); // far past the occurrence, its 60 s grace and the 2 h queue wait
    await tick(10);
    const replayedUncertainPublishes = clicks.length - 1;
    expect(replayedUncertainPublishes).toBe(0);
    expect(launches).toEqual(['p01']);
    expect(facade.query('SELECT id, status, error FROM fb_poster_runs WHERE schedule_id = ?', [id])).toEqual([
        { id: runId, status: 'failed', error: 'App đóng khi việc đang chạy. Đích đang đăng dở (nếu có) cần kiểm tra trên Facebook.' }]);
    expect(resultsOf(runId)).toEqual([]);
    const schedule = poster.getSchedule(id);
    expect(schedule.lastRunId).toBe(runId);
    if (kind === 'once') expect(schedule.nextRunAt).toBeNull();
    else expect(schedule.nextRunAt).toBe(occurrence + 24 * 60 * 60 * 1000);
});
