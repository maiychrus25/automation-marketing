import * as http from 'http';
import type { AddressInfo } from 'net';
import { io as connect, Socket } from 'socket.io-client';

let mockValidation: any = { valid: false };
jest.mock('../../services/employee/EmployeeService', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      validateToken: () => mockValidation,
      getEmployeeById: (id: string) => ({ employee_id: id, display_name: 'Emp', is_active: 1 }),
    }),
  },
}));
jest.mock('../../utils/WorkspaceManager', () => ({ __esModule: true, default: { getInstance: () => ({}) } }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import SocketIOService from '../../services/socket/SocketIOService';

describe('Socket.IO handshake', () => {
  let server: http.Server;
  let client: Socket | undefined;
  let service: SocketIOService;

  beforeEach(async () => {
    server = http.createServer();
    service = SocketIOService.getInstance();
    service.attach(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterEach(async () => {
    client?.close();
    service.stop();
    await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  });

  const attempt = (): Promise<'connected' | 'rejected'> => new Promise((resolve) => {
    const { port } = server.address() as AddressInfo;
    client = connect(`http://127.0.0.1:${port}`, { auth: { token: 't' }, reconnection: false, transports: ['websocket'] });
    client.on('connect', () => resolve('connected'));
    client.on('connect_error', () => resolve('rejected'));
  });

  it('rejects a revoked token even though the employee is active', async () => {
    mockValidation = { valid: false, employee_id: 'emp-1', reason: 'revoked' };
    expect(await attempt()).toBe('rejected');
    expect(service.isOnline('emp-1')).toBe(false);
  });

  it('accepts a valid token', async () => {
    mockValidation = { valid: true, employee_id: 'emp-1' };
    expect(await attempt()).toBe('connected');
    expect(service.isOnline('emp-1')).toBe(true);
  });
});
