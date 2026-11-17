import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-empprofile-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import DatabaseService from '../../services/database/DatabaseService';

describe('employee permissions and browser profile assignment', () => {
  const db = DatabaseService.getInstance();
  let seq = 0;
  const newEmployee = () => {
    const id = `emp-${++seq}`;
    db.createEmployee({ employee_id: id, username: id, password_hash: 'x', display_name: id });
    return id;
  };
  const newProfile = () => {
    const id = `prof-${++seq}`;
    db.createBrowserProfile({ id, name: id, group_id: null, proxy_id: null, fingerprint: {} as any, note: '' });
    return id;
  };
  const perms = (id: string) => Object.fromEntries(db.getEmployeePermissions(id).map((p) => [p.module, p.can_access]));

  beforeAll(async () => { await db.initialize(); });
  afterAll(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('savingPermissionsKeepsKeysTheSaveDoesNotMention', () => {
    const id = newEmployee();
    db.setEmployeePermissions(id, [{ module: 'fb_poster', can_access: 1 }, { module: 'chat', can_access: 0 }]);
    db.setEmployeePermissions(id, [{ module: 'chat', can_access: 1 }]);
    expect(perms(id)).toEqual({ fb_poster: 1, chat: 1 });
    db.setEmployeePermissions(id, [{ module: 'fb_poster', can_access: 0 }]);
    expect(perms(id)).toEqual({ fb_poster: 0, chat: 1 });
  });

  test('assignedProfilesReadBackWithoutDuplicatesOrBlanks', () => {
    const id = newEmployee();
    const [a, b] = [newProfile(), newProfile()];
    db.setEmployeeProfileAccess(id, [a, b, a, '', 5 as any, null as any]);
    expect(db.getEmployeeProfileAccess(id).sort()).toEqual([a, b].sort());
    db.setEmployeeProfileAccess(id, [b]);
    expect(db.getEmployeeProfileAccess(id)).toEqual([b]);
  });

  test('deletingTheEmployeeRemovesItsProfileRows', () => {
    const id = newEmployee();
    db.setEmployeeProfileAccess(id, [newProfile()]);
    db.deleteEmployee(id);
    expect(db.getEmployeeProfileAccess(id)).toEqual([]);
  });

  test('deletingTheProfileRemovesItFromEveryEmployee', () => {
    const [e1, e2] = [newEmployee(), newEmployee()];
    const [gone, kept] = [newProfile(), newProfile()];
    db.setEmployeeProfileAccess(e1, [gone, kept]);
    db.setEmployeeProfileAccess(e2, [gone]);
    db.deleteBrowserProfile(gone);
    expect(db.getEmployeeProfileAccess(e1)).toEqual([kept]);
    expect(db.getEmployeeProfileAccess(e2)).toEqual([]);
  });

  test('aFailingInsertLeavesThePreviousAssignmentIntact', () => {
    const id = newEmployee();
    const [a, b] = [newProfile(), newProfile()];
    db.setEmployeeProfileAccess(id, [a, b]);
    // Câu INSERT của id 'boom' thất bại giữa chừng, sau khi DELETE đã chạy.
    const real = (db as any).runNoSave.bind(db);
    jest.spyOn(db as any, 'runNoSave').mockImplementation((sql: string, params: any[] = []) => {
      if (sql.startsWith('INSERT') && params[1] === 'boom') throw new Error('insert failed');
      return real(sql, params);
    });
    expect(() => db.setEmployeeProfileAccess(id, [newProfile(), 'boom'])).toThrow('insert failed');
    jest.restoreAllMocks();
    expect(db.getEmployeeProfileAccess(id).sort()).toEqual([a, b].sort());
  });
});
