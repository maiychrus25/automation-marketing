const mockHandlers = new Map<string, (e: unknown, arg: any) => Promise<any>>();
jest.mock('electron', () => ({ ipcMain: { handle: (c: string, fn: any) => mockHandlers.set(c, fn) }, BrowserWindow: { getAllWindows: () => [] } }));
const mockSvc = { assignProfiles: jest.fn(), getAssignedProfiles: jest.fn(), runOnEmployeeDb: (fn: any) => fn({ getBrowserProfiles: () => [{ id: 'p1' }, { id: 'p2' }] }, true) };
jest.mock('../../../electron/ipc/facebookPosterIpc', () => ({ pauseEmployeeSchedules: () => 0 }));
const mockRelay = { refreshEmployeeState: jest.fn() };
jest.mock('../../services/employee/EmployeeService', () => ({ __esModule: true, default: { getInstance: () => mockSvc } }));
jest.mock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => ({ getBrowserProfiles: () => [{ id: 'p1' }, { id: 'p2' }] }) } }));
jest.mock('../../services/http/HttpRelayService', () => ({ __esModule: true, default: { getInstance: () => mockRelay } }));
for (const m of ['../../utils/AppModeManager', '../../services/http/HttpClientService', '../../services/http/HttpConnectionManager', '../../utils/WorkspaceManager']) {
  jest.mock(m, () => ({ __esModule: true, default: { getInstance: () => ({}) } }));
}
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import { registerEmployeeIpc } from '../../../electron/ipc/employeeIpc';

describe('employee:assignProfiles handler', () => {
  beforeAll(() => registerEmployeeIpc());
  beforeEach(() => jest.clearAllMocks());
  const assign = (profileIds: unknown) => mockHandlers.get('employee:assignProfiles')!({}, { employeeId: 'e1', profileIds });

  test('aNonArrayFailsAndNothingIsSavedOrPushed', async () => {
    expect((await assign('p1')).success).toBe(false);
    expect(mockSvc.assignProfiles).not.toHaveBeenCalled();
    expect(mockRelay.refreshEmployeeState).not.toHaveBeenCalled();
  });

  test('dropsNonStringsAndUnknownIdsThenPushes', async () => {
    mockSvc.getAssignedProfiles.mockReturnValue([]);
    mockSvc.assignProfiles.mockReturnValue({ success: true });
    expect(await assign(['p1', 7, 'gone'])).toEqual({ success: true, pausedSchedules: 0 });
    expect(mockSvc.assignProfiles).toHaveBeenCalledWith('e1', ['p1']);
    expect(mockRelay.refreshEmployeeState).toHaveBeenCalledWith('e1', 'profiles-assigned');
  });

  test('aFailedSaveIsReturnedWithoutAPush', async () => {
    mockSvc.assignProfiles.mockReturnValue({ success: false, error: 'x' });
    expect(await assign(['p1'])).toEqual({ success: false, error: 'x' });
    expect(mockRelay.refreshEmployeeState).not.toHaveBeenCalled();
  });
});
