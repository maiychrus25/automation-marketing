// Nối dây trong facebookPosterIpc: cổng chiến dịch của scheduler, campaignId từ cột lịch, và gắn chiến dịch qua posterOperations.
import { FacebookPosterStore } from '../../services/facebookPoster/FacebookPosterStore';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { memoryDb } from './helpers';

const mockDb = memoryDb();
const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbp-wiring-'));
let capturedDeps: any = null;
const mockReschedule = jest.fn();
const mockBypass = jest.fn();

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
        reschedule() { mockReschedule(); }
        bypassCampaignGateOnce(id: string) { mockBypass(id); }
        queuedIds() { return []; }
    },
}));
jest.mock('../../services/facebookPoster/LoginCheckScheduler', () => ({
    LoginCheckScheduler: class { start() {} stop() {} reschedule() {} },
    LOGIN_CHECK_SETTING_KEY: 'k', parseLoginCheckConfig: () => ({}), validateLoginCheckConfig: (c: any) => c,
}));
jest.mock('../../services/facebookPoster/PostTrackScheduler', () => ({ PostTrackScheduler: class { start() {} stop() {} } }));
jest.mock('../../services/research/graphqlSession', () => ({ GraphqlSession: class {} }));
jest.mock('../../../electron/ipc/browserProfileIpc', () => ({ getBrowserProfileService: () => ({}), isBrowserEngineInstalled: () => true }));
jest.mock('../../../electron/ipc/researchIpc', () => ({ getResearchStore: () => ({}) }));
jest.mock('../../../electron/ipc/workspaceIpc', () => ({ isWorkspaceSwitchInProgress: () => false }));
jest.mock('../../services/control/controlEvents', () => ({
    emitControlEvent: jest.fn(), hasControlEventSink: () => false, buildRunStarted: jest.fn(), buildRunFinished: jest.fn(), buildScheduleMissed: jest.fn(),
    buildDraftApproved: jest.fn(), buildLoginProblem: jest.fn(), buildCheckFinished: jest.fn(), buildTrackFinished: jest.fn(),
}));

import { startFacebookPosterScheduler, stopFacebookPosterScheduler, posterOperations, campaignOperations, trackingOperations } from '../../../electron/ipc/facebookPosterIpc';

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
        expect(posterOperations.scheduleUpdate({ id: created.id, campaignId: null }).schedule!.campaignId).toBeNull();
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
});
