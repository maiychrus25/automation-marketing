import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BrowserProfileService } from '../../services/browser/BrowserProfileService';
import { ProfileJobQueue, type ProfileTaskContext } from '../../services/browser/ProfileJobQueue';
import { FacebookPosterCoordinator } from '../../services/facebookPoster/FacebookPosterCoordinator';
import { FacebookPosterService, BUSY_ERROR } from '../../services/facebookPoster/FacebookPosterService';
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import { LoginChecker } from '../../services/facebookPoster/loginCheck';
import { PostTracker } from '../../services/facebookPoster/PostTracker';
import { CommentCollector } from '../../services/facebookPoster/CommentCollector';
import { PageLearner } from '../../services/dailyBrief/PageLearner';
import { DailyBriefStore } from '../../services/dailyBrief/DailyBriefStore';
import { ResearchService } from '../../services/research/ResearchService';
import { ResearchStore } from '../../services/research/ResearchStore';
import { DEFAULT_RESEARCH_CONFIG } from '../../services/research/researchConfig';
import { DEFAULT_LEAD_CONFIG } from '../../services/facebookPoster/leadRules';
import { memoryDb } from './helpers';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const kinds = ['login', 'track', 'collect', 'learn', 'research'] as const;
type Kind = typeof kinds[number];
function setup(kind: Kind, profileId: string, holdLearn = false) {
    const db = memoryDb();
    const store = new FacebookPosterStore(db); store.ensureSchema();
    const researchStore = new ResearchStore(db); researchStore.ensureSchema();
    const briefStore = new DailyBriefStore(db); briefStore.ensureSchema();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'side-queue-'));
    const opened: string[] = [];
    const jobs: string[] = [];
    const browser = new BrowserProfileService({
        store: {
            getBrowserProfileById: id => ({ id, name: id, group_id: null, proxy_id: null, note: '',
                fingerprint: { seed: 1, hardwareConcurrency: 8, language: 'vi-VN', timezone: 'Asia/Ho_Chi_Minh' },
                last_opened_at: null, created_at: 0, updated_at: 0 }),
            getProxyById: () => null, touchBrowserProfileOpened: () => {},
        },
        getProfilesDir: () => dir, getExecutablePath: () => '/fake/browser', platform: 'linux',
        launchAutomation: async () => {
            const context = new EventEmitter() as any;
            context.pages = () => [{}]; context.cookies = async () => [{ name: 'c_user', value: '1' }];
            context.close = async () => { context.emit('close'); };
            return context;
        },
    });
    const queue = new ProfileJobQueue({ browser });
    let releasePoster!: () => void;
    const gate = new Promise<void>(resolve => { releasePoster = resolve; });
    let worker!: FacebookPosterService;
    const coordinator = new FacebookPosterCoordinator({ store, newId: () => 'poster-run', createWorker: runId => {
        worker = new FacebookPosterService({ store, newId: () => runId, getProfile: id => ({ id, name: id }), emit: () => {},
            acquireProfile: (id, context) => queue.acquire({ ...context, profileId: id, owner: { workspaceId: 'test', generation: 1, jobId: context.jobId } }),
            tasks: { scanGroups: async (deps) => {
                const session = await deps.launch(); opened.push('profile-a');
                try { await gate; return { groups: [], hitScrollLimit: false, scrollRounds: 0, scrollError: null }; } finally { await session.ctx.close(); }
            } },
        });
        return worker;
    } });
    let current = true;
    const assertCurrent = () => { if (!current) throw new Error('revoked'); };
    const open = async (id: string, context: ProfileTaskContext) => {
        jobs.push(context.jobId);
        const session = await queue.open({ ...context, profileId: id, owner: { workspaceId: 'test', generation: 1, jobId: context.jobId },
            assertCurrent: () => { assertCurrent(); context.assertCurrent(); } });
        opened.push(id); return session;
    };
    const now = Date.now();
    store.createTracking({ resultId: 1, runId: 'existing', scheduleId: null, profileId, groupUrl: 'https://www.facebook.com/groups/1/', groupId: '1',
        postId: '9', postUrl: 'https://www.facebook.com/groups/1/posts/9/', postedAt: now, textHead: 'body', linkStatus: 'known', removedSuspected: false,
        lastSeenAt: null, lastCheckedAt: null, checkCount: 0, nextCheckAt: now, statsDone: [], commentsDone: [], nextCommentAt: now } as any);
    const session = { open: async () => {}, userId: () => '1', ensureQuery: async () => { throw new Error('external boundary'); },
        call: async () => '', recapture: async () => { throw new Error('external boundary'); } };
    let releaseLearn!: () => void;
    const learnGate = new Promise<void>(resolve => { releaseLearn = resolve; });
    const createResearch = (id: string) => new ResearchService({ store: researchStore, newId: () => 'side-job', assertCurrent,
        listProfiles: () => [{ id, name: id }], isProfileBusy: target => !queue.canAcquire(target), loginStates: () => [],
        groupMembership: () => ({}), readConfig: () => DEFAULT_RESEARCH_CONFIG, observeLogin: () => {}, emit: () => {},
        openSession: async (target, guard, context) => { const opened = await open(target, context); guard(); return { session, close: opened.close }; } });
    let start: () => unknown;
    let stop: () => void;
    let idle: () => Promise<void>;
    let running: () => boolean;
    if (kind === 'login') {
        const side = new LoginChecker({ store, getProfile: id => ({ id, name: id }), openForAutomation: open,
            onProblem: () => {}, onFinished: () => {}, onProgress: () => {}, onStatesChanged: () => {}, newId: () => 'side-job', classify: async () => 'ok' });
        start = () => side.check([profileId], 'manual'); stop = () => side.stop(); idle = () => side.whenIdle(); running = () => side.isRunning();
    } else if (kind === 'track') {
        const side = new PostTracker({ store, newId: () => 'side-job', observeLogin: () => {}, emit: () => {},
            openSession: async (id, context) => { const opened = await open(id, context); return { session, close: opened.close }; } });
        start = () => side.track(); stop = () => side.stop(); idle = () => side.whenIdle(); running = () => side.isRunning();
    } else if (kind === 'collect') {
        const side = new CommentCollector({ store, newId: () => 'side-job', observeLogin: () => {}, emit: () => {},
            readConfig: () => DEFAULT_LEAD_CONFIG, detector: { process: async () => [] },
            launchFor: async (id, context) => { const opened = await open(id, context); return { ctx: opened.context, page: {} as any, close: opened.close }; },
            collect: async (_params, deps) => { await deps.launch(); return { scanned: 0, failed: 0, added: 0, results: [] }; } });
        start = () => side.collect(); stop = () => side.stop(); idle = () => side.whenIdle(); running = () => side.isRunning();
    } else if (kind === 'learn') {
        const side = new PageLearner({ store: () => briefStore, newId: () => 'side-job', openForAutomation: open,
            shouldYield: () => false, observeLogin: () => {}, onFinished: () => {},
            read: async () => { if (holdLearn) await learnGate; return { kind: 'page', pageId: '10', pageName: 'Page', category: '', about: '', recentPosts: [] }; } });
        start = () => side.learn([profileId], true, assertCurrent); stop = () => side.stop(); idle = () => side.whenIdle(); running = () => side.isRunning();
    } else {
        const side = createResearch(profileId);
        start = () => side.search({ source: 'posts', query: 'test', profileIds: [profileId], origin: 'manual' });
        stop = () => side.stop(); idle = () => side.whenIdle(); running = () => side.isRunning();
    }
    const poster = () => coordinator.start({ kind: 'scan_groups', profileIds: ['profile-a'], concurrency: 1, staggerMinSec: 0, staggerMaxSec: 0 });
    return { coordinator, poster, start, stop, idle, running, opened, jobs, queue, createResearch, releasePoster: () => releasePoster(), revoke: () => { current = false; queue.notifyAvailability(); },
        cleanup: async () => { stop(); releaseLearn(); releasePoster(); await coordinator.whenIdle(); await idle(); queue.retire(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('research progresses on another profile while Page learning retains its own job', async () => {
    const h = setup('learn', 'profile-b', true);
    const research = h.createResearch('profile-a');
    try {
        h.start(); await tick();
        const started = research.search({ source: 'posts', query: 'test', profileIds: ['profile-a'], origin: 'manual' });
        await research.whenIdle();
        expect(started.scanId).toBe('side-job');
        expect(h.opened).toEqual(['profile-b', 'profile-a']);
        expect(h.running()).toBe(true);
    } finally { research.stop(); await research.whenIdle(); await h.cleanup(); }
});

test.each(kinds)('poster + %s advances on another profile with a captured job ID', async kind => {
    const h = setup(kind, 'profile-b');
    try {
        h.poster(); await tick(); h.start(); await tick();
        expect(h.opened).toEqual(['profile-a', 'profile-b']);
        expect(h.jobs).toEqual(['side-job']);
        expect(h.coordinator.current()?.run.id).toBe('poster-run');
    } finally { await h.cleanup(); }
});

test.each(kinds)('poster + %s excludes the same profile and cancellation settles the waiter', async kind => {
    const h = setup(kind, 'profile-a');
    try {
        h.poster(); await tick(); h.start(); await tick();
        expect(h.running()).toBe(true);
        expect(() => h.start()).toThrow(BUSY_ERROR);
        expect(h.opened).toEqual(['profile-a']);
        h.stop(); await tick();
        expect(h.running()).toBe(false);
        expect(h.opened).toEqual(['profile-a']);
    } finally { await h.cleanup(); }
});

test.each(kinds)('%s queued revocation never opens the profile', async kind => {
    const h = setup(kind, 'profile-a');
    try {
        h.poster(); await tick(); h.start(); await tick(); h.revoke(); await tick();
        // Pumps only check waiters cheaply; the revoked authority is refused at grant, before any open.
        expect(h.opened).toEqual(['profile-a']);
        h.releasePoster(); await h.coordinator.whenIdle(); await h.idle();
        expect(h.opened).toEqual(['profile-a']);
        expect(h.running()).toBe(false);
    } finally { await h.cleanup(); }
});
