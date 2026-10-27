const mockOpenExternal = jest.fn(async () => undefined);
jest.mock('electron', () => ({ dialog: {}, ipcMain: { handle: jest.fn() }, shell: { openExternal: (...a: any[]) => (mockOpenExternal as any)(...a) } }));
jest.mock('xlsx', () => ({}));
const mockSearch = jest.fn(() => ({ scanId: 's1' }));
const mockScanGroups = jest.fn(() => ({ scanId: 's2' }));
const mockLearnerRunning = jest.fn(() => false);
const mockResearchRunning = jest.fn(() => false);
const mockStatus = jest.fn(() => ({ running: true, scanId: 'sx' }));
jest.mock('../../services/research/ResearchService', () => ({
    ResearchService: class {
        search = (...a: any[]) => (mockSearch as any)(...a);
        scanGroupFeeds = (...a: any[]) => (mockScanGroups as any)(...a);
        status = () => mockStatus();
        isRunning = () => mockResearchRunning();
        cancel = () => false;
    },
    MAX_PROFILE_IDS: 50,
}));
jest.mock('../../services/research/ResearchStore', () => ({
    MAX_LIMIT: 500,
    ResearchStore: class { ensureSchema() {} failInterruptedScans() {} pruneOlderThan() {} },
}));
jest.mock('../../services/research/graphqlSession', () => ({ GraphqlSession: class {} }));
jest.mock('../../services/database/DatabaseService', () => ({
    __esModule: true,
    default: { getInstance: () => ({ getDbPath: () => '/db', getBrowserProfiles: () => [{ id: 'p1', name: 'P1' }], getSetting: () => null, setSetting: jest.fn() }) },
}));
jest.mock('../../services/event/EventBroadcaster', () => ({ __esModule: true, default: { emit: jest.fn() } }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { error: jest.fn(), log: jest.fn(), warn: jest.fn() } }));
jest.mock('../../services/facebookPoster/FacebookPosterStore', () => ({ FacebookPosterStore: class {} }));
jest.mock('../../services/control/controlEvents', () => ({ buildResearchFinished: jest.fn(), emitControlEvent: jest.fn() }));
jest.mock('../../../electron/ipc/browserProfileIpc', () => ({ getBrowserProfileService: () => ({ isRunning: () => false }) }));
jest.mock('../../../electron/ipc/facebookPosterIpc', () => ({
    isFacebookPosterEmployeeBlocked: () => false, isPageLearnerRunning: () => mockLearnerRunning(), listFacebookLoginStates: () => [], listFacebookPosterRunProfileIds: () => [], observeFacebookLogin: jest.fn(),
}));
let switching = false;
jest.mock('../../../electron/ipc/workspaceIpc', () => ({ isWorkspaceSwitchInProgress: () => switching }));

import { INVALID_LINK_ERROR, WORKSPACE_SWITCHING_ERROR, isResearchRunning, researchOperations } from '../../../electron/ipc/researchIpc';

beforeEach(() => { jest.clearAllMocks(); switching = false; mockLearnerRunning.mockReturnValue(false); mockResearchRunning.mockReturnValue(false); });

describe('researchOperations during a workspace switch (M6)', () => {
    it('starts normally when idle', () => {
        expect(researchOperations.search({ source: 'posts', query: 'a' }, 'manual')).toEqual({ scanId: 's1' });
        expect(researchOperations.scanGroupFeeds({}, 'api')).toEqual({ scanId: 's2' });
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

describe('research/learner mutual exclusion', () => {
    it('rejects search and group feeds synchronously while learning, before touching the research service', () => {
        mockLearnerRunning.mockReturnValue(true);
        const busy = require('../../services/facebookPoster/FacebookPosterService').BUSY_ERROR;
        expect(() => researchOperations.search({ source: 'posts', query: 'x' }, 'api')).toThrow(busy);
        expect(() => researchOperations.scanGroupFeeds({}, 'api')).toThrow(busy);
        expect(mockSearch).not.toHaveBeenCalled();
        expect(mockScanGroups).not.toHaveBeenCalled();
    });
    it('exports the actual service running state for the synchronous learner gate', () => {
        expect(isResearchRunning()).toBe(false);
        mockResearchRunning.mockReturnValue(true);
        expect(isResearchRunning()).toBe(true);
    });
});
