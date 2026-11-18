const mockHandlers = new Map<string, (e: unknown, arg: any) => Promise<any>>();
jest.mock('electron', () => ({ ipcMain: { handle: (c: string, fn: any) => mockHandlers.set(c, fn) }, BrowserWindow: { getAllWindows: () => [] } }));
const mockSvc = {
  assignProfiles: jest.fn(), getAssignedProfiles: jest.fn(), setPermissions: jest.fn(), getPermissions: jest.fn(),
  updateEmployee: jest.fn(), getEmployeeById: jest.fn(), deleteEmployee: jest.fn(),
  // 'p9' exists only in the employee (pinned) database: the mocked open-workspace database below does not have it.
  runOnEmployeeDb: (fn: any) => fn({ getBrowserProfiles: () => [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p9' }] }, true),
};
const mockRelay = { refreshEmployeeState: jest.fn(), kickEmployee: jest.fn() };
const mockPause = jest.fn();
jest.mock('../../../electron/ipc/facebookPosterIpc', () => ({ pauseEmployeeSchedules: (...a: unknown[]) => mockPause(...a) }));
jest.mock('../../services/employee/EmployeeService', () => ({ __esModule: true, default: { getInstance: () => mockSvc } }));
jest.mock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => ({ getBrowserProfiles: () => [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }], queryOne: () => ({}), run: jest.fn() }) } }));
jest.mock('../../services/http/HttpRelayService', () => ({ __esModule: true, default: { getInstance: () => mockRelay } }));
for (const m of ['../../utils/AppModeManager', '../../services/http/HttpClientService', '../../services/http/HttpConnectionManager', '../../utils/WorkspaceManager']) {
  jest.mock(m, () => ({ __esModule: true, default: { getInstance: () => ({}) } }));
}
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import { registerEmployeeIpc } from '../../../electron/ipc/employeeIpc';

const call = (channel: string, arg: unknown) => mockHandlers.get(channel)!({}, arg);

beforeAll(() => registerEmployeeIpc());
beforeEach(() => { jest.clearAllMocks(); mockPause.mockReturnValue(2); });

describe('employee:assignProfiles', () => {
  test('pausesSchedulesOfTheRemovedProfilesAndReportsTheCount', async () => {
    mockSvc.getAssignedProfiles.mockReturnValue(['p1', 'p2']);
    mockSvc.assignProfiles.mockReturnValue({ success: true });
    expect(await call('employee:assignProfiles', { employeeId: 'e1', profileIds: ['p2'] })).toEqual({ success: true, pausedSchedules: 2 });
    expect(mockPause).toHaveBeenCalledWith('e1', ['p1']);
  });
  test('theSameOrMoreProfilesPauseNothing', async () => {
    mockSvc.getAssignedProfiles.mockReturnValue(['p1']);
    mockSvc.assignProfiles.mockReturnValue({ success: true });
    expect((await call('employee:assignProfiles', { employeeId: 'e1', profileIds: ['p1'] })).pausedSchedules).toBe(0);
    expect((await call('employee:assignProfiles', { employeeId: 'e1', profileIds: ['p1', 'p2'] })).pausedSchedules).toBe(0);
    expect(mockPause).not.toHaveBeenCalled();
  });
  test('aFailedWritePausesNothing', async () => {
    mockSvc.getAssignedProfiles.mockReturnValue(['p1']);
    mockSvc.assignProfiles.mockReturnValue({ success: false, error: 'x' });
    expect(await call('employee:assignProfiles', { employeeId: 'e1', profileIds: [] })).toEqual({ success: false, error: 'x' });
    expect(mockPause).not.toHaveBeenCalled();
  });
});

describe('employee:setPermissions', () => {
  test('removingFbPosterPausesEverySchedule', async () => {
    mockSvc.getPermissions.mockReturnValueOnce({ fb_poster: true }).mockReturnValueOnce({ fb_poster: false });
    mockSvc.setPermissions.mockReturnValue({ success: true });
    expect(await call('employee:setPermissions', { employeeId: 'e1', permissions: [{ module: 'fb_poster', can_access: false }] })).toEqual({ success: true, pausedSchedules: 2 });
    expect(mockPause).toHaveBeenCalledWith('e1');
  });
  test('keepingOrNotMentioningFbPosterPausesNothing', async () => {
    mockSvc.setPermissions.mockReturnValue({ success: true });
    mockSvc.getPermissions.mockReturnValueOnce({ fb_poster: true }).mockReturnValueOnce({ fb_poster: true });
    expect((await call('employee:setPermissions', { employeeId: 'e1', permissions: [{ module: 'fb_poster', can_access: true }] })).pausedSchedules).toBe(0);
    mockSvc.getPermissions.mockReturnValueOnce({ fb_poster: true }).mockReturnValueOnce({ fb_poster: true });
    expect((await call('employee:setPermissions', { employeeId: 'e1', permissions: [{ module: 'chat', can_access: false }] })).pausedSchedules).toBe(0);
    expect(mockPause).not.toHaveBeenCalled();
  });
  test('aFailedWritePausesNothing', async () => {
    mockSvc.getPermissions.mockReturnValue({ fb_poster: true });
    mockSvc.setPermissions.mockReturnValue({ success: false, error: 'x' });
    expect(await call('employee:setPermissions', { employeeId: 'e1', permissions: [{ module: 'fb_poster', can_access: false }] })).toEqual({ success: false, error: 'x' });
    expect(mockPause).not.toHaveBeenCalled();
  });
});

describe('employee:update', () => {
  test('deactivatingPausesEverySchedule', async () => {
    mockSvc.getEmployeeById.mockReturnValue({ is_active: 1 });
    mockSvc.updateEmployee.mockReturnValue({ success: true });
    expect(await call('employee:update', { employeeId: 'e1', updates: { is_active: 0 } })).toEqual({ success: true, pausedSchedules: 2 });
    expect(mockPause).toHaveBeenCalledWith('e1');
  });
  test('otherUpdatesAndAlreadyInactivePauseNothing', async () => {
    mockSvc.updateEmployee.mockReturnValue({ success: true });
    mockSvc.getEmployeeById.mockReturnValue({ is_active: 1 });
    expect((await call('employee:update', { employeeId: 'e1', updates: { display_name: 'A' } })).pausedSchedules).toBe(0);
    mockSvc.getEmployeeById.mockReturnValue({ is_active: 0 });
    expect((await call('employee:update', { employeeId: 'e1', updates: { is_active: 0 } })).pausedSchedules).toBe(0);
    expect(mockPause).not.toHaveBeenCalled();
  });
  test('aFailedUpdatePausesNothing', async () => {
    mockSvc.getEmployeeById.mockReturnValue({ is_active: 1 });
    mockSvc.updateEmployee.mockReturnValue({ success: false, error: 'x' });
    expect(await call('employee:update', { employeeId: 'e1', updates: { is_active: 0 } })).toEqual({ success: false, error: 'x' });
    expect(mockPause).not.toHaveBeenCalled();
  });
});

describe('employee:delete', () => {
  test('aSuccessfulDeletePausesEverySchedule', async () => {
    mockSvc.deleteEmployee.mockReturnValue({ success: true });
    expect(await call('employee:delete', { employeeId: 'e1' })).toEqual({ success: true, pausedSchedules: 2 });
    expect(mockPause).toHaveBeenCalledWith('e1');
  });
  test('aFailedDeletePausesNothing', async () => {
    mockSvc.deleteEmployee.mockReturnValue({ success: false, error: 'x' });
    expect(await call('employee:delete', { employeeId: 'e1' })).toEqual({ success: false, error: 'x' });
    expect(mockPause).not.toHaveBeenCalled();
  });
});

describe('the pause runs before the notifications', () => {
  test('aThrowingKickDoesNotSkipThePause', async () => {
    mockSvc.getEmployeeById.mockReturnValue({ is_active: 1 });
    mockSvc.updateEmployee.mockReturnValue({ success: true });
    mockRelay.kickEmployee.mockImplementationOnce(() => { throw new Error('kick failed'); });
    expect(await call('employee:update', { employeeId: 'e1', updates: { is_active: 0 } })).toEqual({ success: true, pausedSchedules: 2 });
    expect(mockPause).toHaveBeenCalledWith('e1');
  });
  test('aThrowingKickAfterDeleteStillReportsTheCommittedWrite', async () => {
    mockSvc.deleteEmployee.mockReturnValue({ success: true });
    mockRelay.kickEmployee.mockImplementationOnce(() => { throw new Error('kick failed'); });
    expect(await call('employee:delete', { employeeId: 'e1' })).toEqual({ success: true, pausedSchedules: 2 });
  });
  test('profilesAreValidatedAgainstTheEmployeeDatabase', async () => {
    mockSvc.getAssignedProfiles.mockReturnValue([]);
    mockSvc.assignProfiles.mockReturnValue({ success: true });
    expect(await call('employee:assignProfiles', { employeeId: 'e1', profileIds: ['p9'] })).toMatchObject({ success: true });
    expect(mockSvc.assignProfiles).toHaveBeenCalledWith('e1', ['p9']);
  });
  test('aThrowingRefreshDoesNotSkipThePause', async () => {
    mockSvc.getAssignedProfiles.mockReturnValue(['p1']);
    mockSvc.assignProfiles.mockReturnValue({ success: true });
    mockRelay.refreshEmployeeState.mockImplementationOnce(() => { throw new Error('refresh failed'); });
    expect(await call('employee:assignProfiles', { employeeId: 'e1', profileIds: [] })).toEqual({ success: true, pausedSchedules: 2 });
    expect(mockPause).toHaveBeenCalledWith('e1', ['p1']);
  });
});
