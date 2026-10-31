const mockOpenExternal = jest.fn(async () => undefined);
jest.mock('electron', () => ({ dialog: {}, ipcMain: { handle: jest.fn() }, shell: { openExternal: (...a: any[]) => (mockOpenExternal as any)(...a) } }));
jest.mock('xlsx', () => ({}));
const mockSearch = jest.fn(() => ({ scanId: 's1' }));
const mockScanGroups = jest.fn(() => ({ scanId: 's2' }));
const mockLearnerRunning = jest.fn(() => false);
const mockResearchRunning = jest.fn(() => false);
const mockResearchIdle = jest.fn(async () => {});
const mockStatus = jest.fn(() => ({ running: true, scanId: 'sx' }));
let mockResearchDeps: any;
const mockGraphqlConstruct = jest.fn();
const mockReadIdentity = jest.fn(async (_page: any, _opts: any) => ({ kind: 'page', pageId: 'page1' }));
const mockOpenAutomation = jest.fn();
const mockDb = { getDbPath: () => '/db', getBrowserProfiles: () => [{ id: 'p1', name: 'P1' }], getSetting: () => null, setSetting: jest.fn() };
jest.mock('../../services/research/ResearchService', () => ({
    ResearchService: class {
        constructor(deps: any) { mockResearchDeps = deps; }
        search = (...a: any[]) => (mockSearch as any)(...a);
        scanGroupFeeds = (...a: any[]) => (mockScanGroups as any)(...a);
        status = () => mockStatus();
        isRunning = () => mockResearchRunning();
        cancel = () => false;
        whenIdle = () => mockResearchIdle();
    },
    MAX_PROFILE_IDS: 50,
}));
jest.mock('../../services/research/ResearchStore', () => ({
    MAX_LIMIT: 500,
    ResearchStore: class { ensureSchema() {} failInterruptedScans() {} pruneOlderThan() {} },
}));
jest.mock('../../services/research/graphqlSession', () => ({ GraphqlSession: class {
    constructor(...args: any[]) { mockGraphqlConstruct(...args); }
} }));
jest.mock('../../services/dailyBrief/pageIdentity', () => ({ readPageIdentity: (...args: any[]) => (mockReadIdentity as any)(...args) }));
jest.mock('../../services/database/DatabaseService', () => ({
    __esModule: true,
    default: { getInstance: () => mockDb },
}));
jest.mock('../../services/event/EventBroadcaster', () => ({ __esModule: true, default: { emit: jest.fn() } }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { error: jest.fn(), log: jest.fn(), warn: jest.fn() } }));
jest.mock('../../services/facebookPoster/FacebookPosterStore', () => ({ FacebookPosterStore: class {} }));
jest.mock('../../services/control/controlEvents', () => ({ buildResearchFinished: jest.fn(), emitControlEvent: jest.fn() }));
jest.mock('../../../electron/ipc/browserProfileIpc', () => ({ getBrowserProfileService: () => ({ isRunning: () => false, openForAutomation: (...args: any[]) => mockOpenAutomation(...args) }) }));
jest.mock('../../../electron/ipc/facebookPosterIpc', () => ({
    assertFacebookJobAdmission: () => {},
    getProfileJobBinding: () => ({ assertCurrent: () => {}, isProfileBusy: () => false,
        openForAutomation: (...args: any[]) => mockOpenAutomation(...args), shouldYield: () => false }),
    getBoundFacebookLoginObserver: () => jest.fn(),
    isFacebookPosterEmployeeBlocked: () => false, isPageLearnerRunning: () => mockLearnerRunning(), listFacebookLoginStates: () => [], listFacebookPosterRunProfileIds: () => [], observeFacebookLogin: jest.fn(),
}));
let switching = false;
jest.mock('../../../electron/ipc/workspaceIpc', () => ({ isWorkspaceSwitchInProgress: () => switching }));

import { INVALID_LINK_ERROR, WORKSPACE_SWITCHING_ERROR, isResearchRunning, researchOperations, getResearchService, cancelAndWaitResearch } from '../../../electron/ipc/researchIpc';

beforeEach(() => { jest.clearAllMocks(); switching = false; mockLearnerRunning.mockReturnValue(false); mockResearchRunning.mockReturnValue(false); });

describe('researchOperations during a workspace switch (M6)', () => {
    it('starts normally when idle', () => {
        expect(researchOperations.search({ source: 'posts', query: 'a' }, 'manual')).toEqual({ scanId: 's1' });
        expect(researchOperations.scanGroupFeeds({}, 'api')).toEqual({ scanId: 's2' });
    });
    it('does not forward renderer ownership controls into either legacy method', () => {
        const controls = { scanId: 'forged', pageId: 'foreign', profileId: 'foreign', assertCurrent: () => {} };
        researchOperations.search({ source: 'posts', query: 'x', ...controls }, 'api');
        researchOperations.scanGroupFeeds(controls, 'api');
        for (const call of [mockSearch.mock.calls[0], mockScanGroups.mock.calls[0]] as unknown[][]) {
            expect(call).toHaveLength(1);
            expect(call[0]).not.toHaveProperty('scanId');
            expect(call[0]).not.toHaveProperty('pageId');
            expect(call[0]).not.toHaveProperty('assertCurrent');
        }
    });
    it('refuses search and scanGroupFeeds with the Vietnamese message', () => {
        switching = true;
        expect(WORKSPACE_SWITCHING_ERROR).toBe('Đang đổi workspace, thử lại sau');
        expect(() => researchOperations.search({ source: 'posts', query: 'a' }, 'api')).toThrow(WORKSPACE_SWITCHING_ERROR);
        expect(() => researchOperations.scanGroupFeeds({}, 'api')).toThrow(WORKSPACE_SWITCHING_ERROR);
        expect(mockSearch).not.toHaveBeenCalled();
        expect(mockScanGroups).not.toHaveBeenCalled();
    });
});

describe('researchOperations.status (M9)', () => {
    it('reflects the service (service is created by the earlier start calls)', () => {
        getResearchService();
        expect(researchOperations.status()).toEqual({ running: true, scanId: 'sx' });
    });
});

describe('researchOperations.openLink (M5)', () => {
    it('opens a facebook https link using the normalised href', async () => {
        await researchOperations.openLink({ url: 'https://m.facebook.com/groups/1/' });
        expect(mockOpenExternal).toHaveBeenCalledWith('https://m.facebook.com/groups/1/');
    });
    it.each(['javascript:alert(1)', 'file:///etc/passwd', 'http://www.facebook.com/x', 'https://evil.test/', 'https://www.facebook.com.evil.test/', '', undefined])(
        'refuses %s without opening', async (url) => {
            await expect(researchOperations.openLink({ url })).rejects.toThrow(INVALID_LINK_ERROR);
            expect(mockOpenExternal).not.toHaveBeenCalled();
        });
});

describe('research helper guard wiring', () => {
    it('passes the captured Node-side guard into both helpers on the actual opened page', async () => {
        getResearchService();
        const page = {}; const close = jest.fn(async () => {});
        mockOpenAutomation.mockResolvedValue({ context: { pages: () => [page] }, close });
        let current = true; const error = new Error('revoked'); const guard = () => { if (!current) throw error; };
        const context = { jobId: 'scan', signal: new AbortController().signal, priority: 'interactive', assertCurrent: guard };
        const opened = await mockResearchDeps.openSession('p1', guard, context);
        expect(mockOpenAutomation).toHaveBeenCalledWith('p1', context);
        expect(mockGraphqlConstruct.mock.calls[0][0]).toBe(page);
        expect(mockGraphqlConstruct.mock.calls[0][2]).toEqual({ assertCurrent: guard });
        await expect(opened.readIdentity()).resolves.toEqual({ kind: 'page', pageId: 'page1' });
        expect(mockReadIdentity).toHaveBeenCalledWith(page, { assertCurrent: guard });
        current = false;
        expect(() => mockGraphqlConstruct.mock.calls[0][1].saveQuery('x')).toThrow(error);
        await expect(opened.readIdentity()).rejects.toBe(error);
        expect(mockReadIdentity).toHaveBeenCalledTimes(1);
        await opened.close(); expect(close).toHaveBeenCalledTimes(1);
    });
    it('closes startup session after revocation without creating a page or constructing GraphQL', async () => {
        getResearchService(); let current = true; const error = new Error('revoked');
        const close = jest.fn(async () => {}); const newPage = jest.fn();
        mockOpenAutomation.mockImplementation(async () => { current = false; return { context: { pages: () => [], newPage }, close }; });
        await expect(mockResearchDeps.openSession('p1', () => { if (!current) throw error; })).rejects.toBe(error);
        expect(close).toHaveBeenCalledTimes(1); expect(newPage).not.toHaveBeenCalled();
        expect(mockGraphqlConstruct).not.toHaveBeenCalled();
    });
});

describe('research service workspace lifecycle', () => {
    it('retains the captured research binding and returns false when cleanup rejects despite an idle flag', async () => {
        const previous = getResearchService();
        mockResearchRunning.mockReturnValue(true);
        mockResearchIdle.mockImplementationOnce(async () => { mockResearchRunning.mockReturnValue(false); throw new Error('cleanup failed'); });
        expect(await cancelAndWaitResearch()).toBe(false);
        expect(getResearchService()).toBe(previous);
    });
    it('returns false rather than rejecting when cancellation throws', async () => {
        const previous = getResearchService();
        mockResearchRunning.mockReturnValue(true);
        const cancel = jest.spyOn(previous, 'cancel').mockImplementationOnce(() => { throw new Error('cancel failed'); });
        try { expect(await cancelAndWaitResearch()).toBe(false); }
        finally { cancel.mockRestore(); mockResearchRunning.mockReturnValue(false); }
    });
    it('drops a drained binding even when a workspace switch is later aborted', async () => {
        const previous = getResearchService();
        expect(await cancelAndWaitResearch()).toBe(true);
        expect(getResearchService()).not.toBe(previous);
    });
});

describe('research/learner independent admission', () => {
    it('forwards search and group feeds while learning; research owns its local limit', () => {
        mockLearnerRunning.mockReturnValue(true);
        expect(researchOperations.search({ source: 'posts', query: 'x' }, 'api')).toEqual({ scanId: 's1' });
        expect(researchOperations.scanGroupFeeds({}, 'api')).toEqual({ scanId: 's2' });
        expect(mockSearch).toHaveBeenCalledTimes(1);
        expect(mockScanGroups).toHaveBeenCalledTimes(1);
    });
    it('exports the actual service running state for the synchronous learner gate', () => {
        getResearchService();
        expect(isResearchRunning()).toBe(false);
        mockResearchRunning.mockReturnValue(true);
        expect(isResearchRunning()).toBe(true);
    });
});
