// Nối dây trong facebookPosterIpc: cổng chiến dịch của scheduler, campaignId từ cột lịch, và gắn chiến dịch qua posterOperations.
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { memoryDb } from './helpers';

const mockDb = memoryDb();
const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbp-wiring-'));
let capturedDeps: any = null;
let mockCommentSchedulerDeps: any = null;
let mockServiceDeps: any = null;
let mockServiceInstance: any = null;
const mockReschedule = jest.fn();
const mockBypass = jest.fn();
const mockClearBypass = jest.fn();

jest.mock('electron', () => ({ dialog: {}, ipcMain: { handle: jest.fn() } }));
jest.mock('../../services/database/DatabaseService', () => ({
    __esModule: true,
    default: {
        getInstance: () => ({
            ...mockDb, getDbPath: () => path.join(mockDir, 'db.sqlite'), getBrowserProfileById: () => ({ id: 'p1', name: 'P1' }),
            getBrowserProfiles: () => [], getSetting: () => null, setSetting: jest.fn(),
        }),
    },
}));
jest.mock('../../services/event/EventBroadcaster', () => ({ __esModule: true, default: { emit: jest.fn() } }));
jest.mock('../../utils/AppModeManager', () => ({ __esModule: true, default: { getInstance: () => ({ isEmployeeMode: () => false }) } }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { error: jest.fn(), log: jest.fn(), warn: jest.fn() } }));
jest.mock('../../services/facebookPoster/FacebookPosterScheduler', () => ({
    FacebookPosterScheduler: class {
        constructor(deps: any) { capturedDeps = deps; }
        start() {}
        stop() {}
        onRunFinished() {}
        reschedule() { mockReschedule(); }
        bypassCampaignGateOnce(id: string) { mockBypass(id); }
        clearCampaignGateBypass(id: string) { mockClearBypass(id); }
        queuedIds() { return []; }
    },
}));
jest.mock('../../services/facebookPoster/LoginCheckScheduler', () => ({
    LoginCheckScheduler: class { start() {} stop() {} reschedule() {} },
    LOGIN_CHECK_SETTING_KEY: 'k', parseLoginCheckConfig: () => ({}), validateLoginCheckConfig: (c: any) => c,
}));
jest.mock('../../services/facebookPoster/PostTrackScheduler', () => ({ PostTrackScheduler: class { start() {} stop() {} } }));
jest.mock('../../services/facebookPoster/CommentCollectScheduler', () => ({
    CommentCollectScheduler: class {
        constructor(deps: any) { mockCommentSchedulerDeps = deps; }
        start() {}
        stop() {}
    },
}));
jest.mock('../../services/ai/AIAssistantService', () => ({ __esModule: true, default: { getInstance: () => ({ getDefaultAssistant: () => null, chat: jest.fn() }) } }));
jest.mock('../../services/facebookPoster/FacebookPosterService', () => {
    const actual = jest.requireActual('../../services/facebookPoster/FacebookPosterService');
    return {
        ...actual,
        FacebookPosterService: class extends actual.FacebookPosterService {
            constructor(deps: any) { super(deps); mockServiceDeps = deps; mockServiceInstance = this; }
        },
    };
});
jest.mock('../../services/research/graphqlSession', () => ({ GraphqlSession: class {} }));
jest.mock('../../../electron/ipc/browserProfileIpc', () => ({ getBrowserProfileService: () => ({}), isBrowserEngineInstalled: () => true }));
jest.mock('../../../electron/ipc/researchIpc', () => ({ getResearchStore: () => ({}) }));
jest.mock('../../../electron/ipc/workspaceIpc', () => ({ isWorkspaceSwitchInProgress: () => false }));
jest.mock('../../services/control/controlEvents', () => ({
    emitControlEvent: jest.fn(), hasControlEventSink: () => false, buildRunStarted: jest.fn(), buildRunFinished: jest.fn(), buildScheduleMissed: jest.fn(),
    buildDraftApproved: jest.fn(), buildLoginProblem: jest.fn(), buildCheckFinished: jest.fn(), buildTrackFinished: jest.fn(), buildLeadsFound: jest.fn((p: unknown) => p),
}));

import { startFacebookPosterScheduler, stopFacebookPosterScheduler, posterOperations, campaignOperations, trackingOperations, leadOperations, isFacebookPosterBusy } from '../../../electron/ipc/facebookPosterIpc';

const NOW = Date.now();
const schedule = (campaignId: string | null, params: Record<string, unknown> = {}) => ({
    id: 's1', name: 's1', kind: 'once' as const, params, runAt: NOW, days: [], time: '', enabled: true, draft: false,
    campaignId, nextRunAt: NOW, lastRunId: null, createdAt: NOW, updatedAt: NOW,
});

beforeAll(() => {
    new FacebookPosterStore(mockDb).ensureSchema();
    startFacebookPosterScheduler();
});
afterAll(() => { stopFacebookPosterScheduler(); fs.rmSync(mockDir, { recursive: true, force: true }); });

describe('facebookPosterIpc wiring', () => {
    test('campaignBlock: không chiến dịch / chiến dịch mất không chặn; tạm dừng và lưu trữ chặn', () => {
        const { campaign } = campaignOperations.create({ name: 'Tết' });
        expect(capturedDeps.campaignBlock(schedule(null), NOW)).toBeNull();
        expect(capturedDeps.campaignBlock(schedule('missing'), NOW)).toBeNull();
        expect(capturedDeps.campaignBlock(schedule(campaign.id), NOW)).toBeNull();
        campaignOperations.update({ id: campaign.id, status: 'paused' });
        expect(capturedDeps.campaignBlock(schedule(campaign.id), NOW)).toBe('Chiến dịch đang tạm dừng');
        campaignOperations.update({ id: campaign.id, status: 'archived' });
        expect(capturedDeps.campaignBlock(schedule(campaign.id), NOW)).toBe('Chiến dịch đã lưu trữ');
    });

    test('campaign operations gọi reschedule của scheduler', () => {
        mockReschedule.mockClear();
        campaignOperations.create({ name: 'Khác' });
        expect(mockReschedule).toHaveBeenCalledTimes(1);
    });

    test('resolveParams lấy campaignId từ cột lịch, bỏ qua giá trị trong params_json', () => {
        const base = { mode: 'group', text: 'Xin chào', mediaPaths: [], profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/123456789'] }] };
        expect(capturedDeps.resolveParams(schedule('c9', { ...base, campaignId: 'other' })).campaignId).toBe('c9');
        expect(capturedDeps.resolveParams(schedule(null, { ...base, campaignId: 'other' })).campaignId).toBeNull();
    });

    test('scheduleCreate / scheduleUpdate / scheduleList gắn chiến dịch và từ chối chiến dịch lạ hoặc lưu trữ', () => {
        const active = campaignOperations.create({ name: 'Đang chạy' }).campaign;
        const archived = campaignOperations.create({ name: 'Cũ' }).campaign;
        campaignOperations.update({ id: archived.id, status: 'archived' });
        const body = { kind: 'recurring', days: [1], time: '09:30', params: { mode: 'group', text: 'Bài', profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/123456789'] }] } };
        expect(() => posterOperations.scheduleCreate({ ...body, campaignId: 'nope' })).toThrow('Không tìm thấy chiến dịch');
        expect(() => posterOperations.scheduleCreate({ ...body, campaignId: archived.id })).toThrow('Chiến dịch đã lưu trữ');
        const created = posterOperations.scheduleCreate({ ...body, campaignId: active.id }).schedule!;
        expect(created.campaignId).toBe(active.id);
        expect(() => posterOperations.scheduleUpdate({ id: created.id, campaignId: archived.id })).toThrow('Chiến dịch đã lưu trữ');
        expect(posterOperations.scheduleList({ campaignId: active.id }).schedules.map((s) => s.id)).toEqual([created.id]);
        expect(posterOperations.scheduleList({ campaignId: '' }).schedules).toEqual([]);
        mockClearBypass.mockClear();
        expect(posterOperations.scheduleUpdate({ id: created.id, campaignId: null }).schedule!.campaignId).toBeNull();
        posterOperations.scheduleUpdate({ id: created.id, name: 'Đổi tên' });
        expect(mockClearBypass).not.toHaveBeenCalled(); // đổi tên / chiến dịch giữ "Đăng ngay" đang chờ
        posterOperations.scheduleUpdate({ id: created.id, time: '10:45' });
        expect(mockClearBypass).toHaveBeenCalledWith(created.id);
        expect(() => posterOperations.scheduleList({ campaignId: 5 })).toThrow('campaignId không hợp lệ');
    });

    test('draftApprove "now" cho lượt đó bỏ qua kiểm chiến dịch; hẹn giờ thì không', () => {
        const params = { mode: 'group', text: 'Bài nháp', profiles: [{ profileId: 'p1', targets: ['https://www.facebook.com/groups/123456789'] }] };
        const now = posterOperations.draftSave({ params }).schedule;
        mockBypass.mockClear();
        posterOperations.draftApprove({ id: now.id, when: 'now' });
        expect(mockBypass).toHaveBeenCalledWith(now.id);
        const later = posterOperations.draftSave({ params }).schedule;
        mockBypass.mockClear();
        posterOperations.draftApprove({ id: later.id, when: 'scheduled', kind: 'once', runAt: NOW + 3_600_000 });
        expect(mockBypass).not.toHaveBeenCalled();
    });

    test('trackingOperations.list / stats nhận và kiểm campaignId, scheduleId, groupBy mới', () => {
        expect(trackingOperations.stats({ groupBy: 'campaign' }).rows).toEqual([]);
        expect(trackingOperations.stats({ groupBy: 'variant', campaignId: '', scheduleId: 's1' }).rows).toEqual([]);
        expect(trackingOperations.list({ campaignId: '', scheduleId: 's1' }).total).toBe(0);
        expect(() => trackingOperations.stats({ groupBy: 'campaign', campaignId: 3 })).toThrow('campaignId không hợp lệ');
        expect(() => trackingOperations.stats({ groupBy: 'campaign', scheduleId: '' })).toThrow('scheduleId không hợp lệ');
        expect(() => trackingOperations.list({ scheduleId: '' })).toThrow('scheduleId không hợp lệ');
        expect(() => trackingOperations.list({ campaignId: 3 })).toThrow('campaignId không hợp lệ');
    });

    test('trackingOperations.groupScores / bestTimes trả đúng hình dạng và kiểm tham số; stats nhận hour / weekday', () => {
        expect(trackingOperations.groupScores({})).toEqual({ groups: [] });
        expect(trackingOperations.groupScores({ campaignId: '' })).toEqual({ groups: [] });
        expect(trackingOperations.bestTimes({})).toEqual({ hours: [], weekdays: [], insufficient: true });
        expect(trackingOperations.bestTimes({ groupUrl: 'https://facebook.com/groups/1', campaignId: 'c1' }).insufficient).toBe(true);
        expect(trackingOperations.stats({ groupBy: 'hour' }).rows).toEqual([]);
        expect(trackingOperations.stats({ groupBy: 'weekday' }).rows).toEqual([]);
        expect(() => trackingOperations.groupScores({ campaignId: 3 })).toThrow('campaignId không hợp lệ');
        expect(() => trackingOperations.groupScores({ from: 10, to: 5 })).toThrow('Khoảng thời gian không hợp lệ');
        expect(() => trackingOperations.bestTimes({ groupUrl: '' })).toThrow('groupUrl không hợp lệ');
        expect(() => trackingOperations.bestTimes({ campaignId: 3 })).toThrow('campaignId không hợp lệ');
        expect(() => trackingOperations.stats({ groupBy: 'minute' })).toThrow('groupBy phải là');
    });

    test('leadOperations.list / update kiểm status, note, id và cập nhật khách', () => {
        const now = Date.now();
        const created = new FacebookPosterStore(mockDb).createLeads([{
            commentKey: 'k-ops', postUrl: 'https://www.facebook.com/groups/1/posts/9/', resultId: null, groupUrl: '', campaignId: null, variant: '',
            profileId: 'p1', authorId: 'a', authorName: 'An', authorUrl: '', text: 'giá bao nhiêu', commentedAtMs: null, matched: ['giá'],
            aiIntent: null, aiScore: null, aiReason: null, status: 'new', note: '', detectedAt: now, updatedAt: now,
        }]);
        const id = created[0].id;
        expect(leadOperations.list({ status: 'new' }).leads.map((l) => l.id)).toContain(id);
        expect(() => leadOperations.list({ status: 'done' })).toThrow('status phải là');
        expect(() => leadOperations.list({ from: 'x' })).toThrow('from không hợp lệ');
        expect(() => leadOperations.list({ search: 5 })).toThrow('search phải là');
        expect(() => leadOperations.update({ id: 0, status: 'won' })).toThrow('id khách không hợp lệ');
        expect(() => leadOperations.update({ id })).toThrow('Cần status hoặc note');
        expect(() => leadOperations.update({ id, status: 'lost' })).toThrow('status phải là');
        expect(() => leadOperations.update({ id, note: 'x'.repeat(1001) })).toThrow('note phải là');
        expect(() => leadOperations.update({ id, note: 5 })).toThrow('note phải là');
        expect(() => leadOperations.update({ id: 99999, status: 'won' })).toThrow('Không tìm thấy khách');
        expect(leadOperations.update({ id, status: 'contacted', note: 'x'.repeat(1000) }).lead.status).toBe('contacted');
        expect(leadOperations.list({ status: 'new' }).leads.map((l) => l.id)).not.toContain(id);
    });

    test('leadOperations.setConfig kiểm cấu hình; getConfig trả mặc định khi chưa lưu', () => {
        expect(leadOperations.getConfig().config.collectAtMinutes).toEqual([120, 1440, 4320]);
        expect(() => leadOperations.setConfig({ ...leadOperations.getConfig().config, aiMinScore: 101 })).toThrow();
        expect(() => leadOperations.setConfig({ ...leadOperations.getConfig().config, collectAtMinutes: [60, 30] })).toThrow('tăng dần');
        expect(leadOperations.setConfig(leadOperations.getConfig().config).config.aiMinScore).toBe(60);
    });

    test('leadOperations.collect kiểm postUrls; comments kiểm và lọc since', () => {
        expect(() => leadOperations.collect({ postUrls: [] })).toThrow('postUrls phải là');
        expect(() => leadOperations.collect({ postUrls: [5] })).toThrow('postUrls phải là');
        expect(() => leadOperations.collect({ postUrls: Array.from({ length: 51 }, (_, i) => `https://x/${i}`) })).toThrow('postUrls phải là');
        expect(() => leadOperations.comments({ since: 'x' })).toThrow('since không hợp lệ');
        expect(() => leadOperations.comments({ postUrl: '' })).toThrow('postUrl không hợp lệ');
        const s = new FacebookPosterStore(mockDb);
        s.saveComments('p1', [{ postUrl: 'https://x/since', authorId: 'a', authorName: 'A', authorUrl: '', text: 'cũ', commentedAt: '' }], 100);
        s.saveComments('p1', [{ postUrl: 'https://x/since', authorId: 'b', authorName: 'B', authorUrl: '', text: 'mới', commentedAt: '' }], 900);
        expect(leadOperations.comments({ postUrl: 'https://x/since', since: 500 }).comments.map((c) => c.text)).toEqual(['mới']);
    });

    test('lượt thu bình luận thủ công (collect_comments) chuyển bình luận mới cho bộ lọc khách (auto = false)', async () => {
        posterOperations.current(); // dựng service
        const text = 'cho mình hỏi giá sản phẩm này';
        await mockServiceDeps.onCommentsSaved([{
            key: 'manual-k1', profileId: 'p1', postUrl: 'https://x/manual', authorId: 'a1', authorName: 'Lan', authorUrl: '', text,
            commentedAt: '', commentedAtMs: null, collectedAt: Date.now(),
        }]);
        expect(leadOperations.list({ search: 'hỏi giá' }).leads.map((l) => l.commentKey)).toEqual(['manual-k1']);
        // Thu lại cùng bình luận không tạo khách trùng
        await mockServiceDeps.onCommentsSaved([{
            key: 'manual-k1', profileId: 'p1', postUrl: 'https://x/manual', authorId: 'a1', authorName: 'Lan', authorUrl: '', text,
            commentedAt: '', commentedAtMs: null, collectedAt: Date.now(),
        }]);
        expect(leadOperations.list({ search: 'hỏi giá' }).total).toBe(1);
        mockServiceDeps.emit('facebookPoster:runFinished', { runId: 'none', status: 'completed' }); // đóng lượt: xả khách đã gom
    });

    test('khách mới phát sự kiện control leads.found đúng một lần cho cả lượt (khi lượt kết thúc), không phát lại cho bình luận cũ', async () => {
        posterOperations.current();
        const emit = require('../../services/control/controlEvents').emitControlEvent as jest.Mock;
        emit.mockClear();
        const mk = (n: number) => ({
            key: `ctl-k${n}`, profileId: 'p1', postUrl: `https://x/ctl${n}`, authorId: `a${n}`, authorName: `Hoa ${n}`, authorUrl: '', text: 'ib mình báo giá nhé',
            commentedAt: '', commentedAtMs: null, collectedAt: Date.now(),
        });
        const leadCalls = () => emit.mock.calls.filter((c) => c[0] === 'leads.found');
        await mockServiceDeps.onCommentsSaved([mk(1)]);
        await mockServiceDeps.onCommentsSaved([mk(2)]); // bài thứ hai của cùng lượt
        expect(leadCalls()).toHaveLength(0); // chưa phát trước khi lượt kết thúc
        mockServiceDeps.emit('facebookPoster:runFinished', { runId: 'none', status: 'completed' });
        expect(leadCalls()).toHaveLength(1);
        expect(leadCalls()[0][1]).toMatchObject({ count: 2, auto: false });
        // Lượt sau: bình luận cũ không tạo khách mới nên không phát
        await mockServiceDeps.onCommentsSaved([mk(1)]);
        mockServiceDeps.emit('facebookPoster:runFinished', { runId: 'none', status: 'completed' });
        expect(leadCalls()).toHaveLength(1);
    });

    test('bộ hẹn giờ thu bình luận nhận isBusy gồm khe việc chung; runCollect thu với auto = true', async () => {
        expect(mockCommentSchedulerDeps.isBusy()).toBe(false);
        mockServiceInstance.acquireExclusive();
        expect(mockCommentSchedulerDeps.isBusy()).toBe(true);
        expect(isFacebookPosterBusy()).toBe(true);
        mockServiceInstance.releaseExclusive();
        expect(mockCommentSchedulerDeps.isBusy()).toBe(false);
        mockCommentSchedulerDeps.runCollect([]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const status = leadOperations.collectStatus();
        expect(status.running).toBe(false);
        expect(status.last).toMatchObject({ auto: true, posts: 0, cancelled: false });
        expect(leadOperations.collectCancel()).toEqual({ cancelled: false });
        expect(leadOperations.collect({}).posts).toBe(0); // thu tay không có bài đến hạn
    });

    test('store() xoá khách quá 180 ngày cùng chỗ xoá theo dõi khi gặp DB lần đầu', () => {
        jest.isolateModules(() => {
            const { FacebookPosterStore: IsolatedStore } = require('../../services/facebookPoster/FacebookPosterStore');
            const spy = jest.spyOn(IsolatedStore.prototype, 'pruneLeadsOlderThan');
            const isolated = require('../../../electron/ipc/facebookPosterIpc');
            isolated.leadOperations.list();
            isolated.leadOperations.list();
            expect(spy).toHaveBeenCalledTimes(1);
            const cutoff = spy.mock.calls[0][0] as number;
            expect(Math.abs(Date.now() - cutoff - 180 * 24 * 60 * 60 * 1000)).toBeLessThan(60_000);
        });
    });
});
