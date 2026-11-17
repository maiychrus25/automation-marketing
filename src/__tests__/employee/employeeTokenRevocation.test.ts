import * as jwt from 'jsonwebtoken';

// Cơ sở dữ liệu giả trong bộ nhớ: chỉ những phương thức mà EmployeeService gọi.
const mockSettings = new Map<string, string>();
const mockEmployees = new Map<string, any>();
const mockDb: any = {
  getDbPath: () => '/tmp/employee-token-test.db',
  withDbPath: (_p: string, fn: () => any) => fn(),
  getSetting: (k: string) => (mockSettings.has(k) ? mockSettings.get(k) : null),
  setSetting: (k: string, v: string) => { mockSettings.set(k, v); },
  getEmployeeByUsername: (u: string) => [...mockEmployees.values()].find((e) => e.username === u),
  getEmployeeById: (id: string) => mockEmployees.get(id),
  createEmployee: (e: any) => { mockEmployees.set(e.employee_id, { ...e, is_active: 1 }); },
  updateEmployee: (id: string, u: any) => { Object.assign(mockEmployees.get(id), u); },
  deleteEmployee: (id: string) => { mockEmployees.delete(id); },
  updateEmployeeLastLogin: jest.fn(),
  setEmployeePermissions: jest.fn(),
  getEmployeePermissions: () => [],
  getEmployeeAccountAccess: () => [],
};
jest.mock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => mockDb } }));
let mockUuid = 0;
jest.mock('uuid', () => ({ v4: () => `id-${++mockUuid}` }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

function loadService(): any {
  let svc: any;
  jest.isolateModules(() => { svc = require('../../services/employee/EmployeeService').default.getInstance(); });
  return svc;
}

async function setup() {
  const svc = loadService();
  const created = await svc.createEmployee({ username: 'emp1', password: 'pass-1234', display_name: 'Emp One' });
  return { svc, id: created.employee.employee_id as string };
}

describe('employee token revocation', () => {
  beforeEach(() => { mockSettings.clear(); mockEmployees.clear(); mockUuid = 0; jest.restoreAllMocks(); });

  it('accepts a fresh login token', async () => {
    const { svc, id } = await setup();
    const login = await svc.authenticate('emp1', 'pass-1234');
    expect(svc.validateToken(login.token)).toMatchObject({ valid: true, employee_id: id });
  });

  it('password change revokes old token; a login in the same millisecond works', async () => {
    const { svc, id } = await setup();
    const login = await svc.authenticate('emp1', 'pass-1234');
    jest.spyOn(Date, 'now').mockReturnValue(Number(JSON.parse(Buffer.from(login.token.split('.')[1], 'base64').toString()).ts));
    svc.updateEmployee(id, { password: 'new-pass-1' });
    expect(svc.validateToken(login.token)).toMatchObject({ valid: false, reason: 'revoked' });
    const again = await svc.authenticate('emp1', 'new-pass-1');
    expect(svc.validateToken(again.token)).toMatchObject({ valid: true });
    expect(svc.validateToken(login.token).valid).toBe(false);
  });

  it('keeps issue marks monotonic when the clock moves backwards', async () => {
    const { svc, id } = await setup();
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1000);
    const a = await svc.authenticate('emp1', 'pass-1234');
    now.mockReturnValue(900);
    const b = await svc.authenticate('emp1', 'pass-1234');
    svc.revokeEmployeeTokens(id);
    expect(svc.validateToken(a.token)).toMatchObject({ valid: false, reason: 'revoked' });
    expect(svc.validateToken(b.token)).toMatchObject({ valid: false, reason: 'revoked' });
    const c = await svc.authenticate('emp1', 'pass-1234');
    expect(svc.validateToken(c.token).valid).toBe(true);
  });

  it('disabling gives inactive, deleting gives unavailable', async () => {
    const { svc, id } = await setup();
    const login = await svc.authenticate('emp1', 'pass-1234');
    svc.updateEmployee(id, { is_active: 0 });
    expect(svc.validateToken(login.token)).toMatchObject({ valid: false, reason: 'inactive' });
    svc.deleteEmployee(id);
    expect(svc.validateToken(login.token)).toMatchObject({ valid: false, reason: 'unavailable' });
  });

  it('refuses alg none and non HS256 tokens', async () => {
    const { svc, id } = await setup();
    const secret = mockSettings.get('employee_jwt_secret')!;
    const claims = { employee_id: id, username: 'emp1', role: 'employee', ts: Date.now() + 10 };
    const none = jwt.sign(claims, '', { algorithm: 'none' } as any);
    const hs384 = jwt.sign(claims, secret, { algorithm: 'HS384' });
    expect(svc.validateToken(none)).toMatchObject({ valid: false, reason: 'invalid' });
    expect(svc.validateToken(hs384)).toMatchObject({ valid: false, reason: 'invalid' });
    expect(svc.validateToken(jwt.sign(claims, secret, { algorithm: 'HS256' })).valid).toBe(true);
  });

  it('rotates a legacy key exactly once', () => {
    mockSettings.set('employee_jwt_secret', 'legacy-secret');
    const legacy = jwt.sign({ employee_id: 'e1', ts: Date.now() }, 'legacy-secret');
    const svc = loadService();
    const rotated = mockSettings.get('employee_jwt_secret');
    expect(rotated).not.toBe('legacy-secret');
    expect(mockSettings.get('employee_jwt_secret_version')).toBe('2');
    expect(svc.validateToken(legacy)).toMatchObject({ valid: false, reason: 'invalid' });
    loadService();
    expect(mockSettings.get('employee_jwt_secret')).toBe(rotated);
  });
});

describe('employee update validates like create', () => {
  beforeEach(() => { mockSettings.clear(); mockEmployees.clear(); mockUuid = 0; jest.restoreAllMocks(); });

  it('refuses an empty display name and a password shorter than 4 characters, and writes nothing', async () => {
    const { svc, id } = await setup();
    const before = { ...mockEmployees.get(id) };
    expect(svc.updateEmployee(id, { display_name: '   ' })).toEqual({ success: false, error: 'Tên hiển thị không được để trống' });
    expect(svc.updateEmployee(id, { display_name: 'Tên mới', password: 'abc' })).toEqual({ success: false, error: 'Mật khẩu phải có ít nhất 4 ký tự' });
    expect(mockEmployees.get(id)).toEqual(before);
  });

  it('still accepts an update without a name or with an empty password (password unchanged)', async () => {
    const { svc, id } = await setup();
    const hash = mockEmployees.get(id).password_hash;
    expect(svc.updateEmployee(id, { is_active: 0 })).toMatchObject({ success: true });
    expect(svc.updateEmployee(id, { display_name: ' Tên mới ', password: '' })).toMatchObject({ success: true });
    expect(mockEmployees.get(id)).toMatchObject({ display_name: 'Tên mới', password_hash: hash });
  });
});
