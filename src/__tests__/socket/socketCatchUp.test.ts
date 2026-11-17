import * as http from 'http';
import type { AddressInfo } from 'net';
import { io as connect, Socket } from 'socket.io-client';

jest.mock('../../services/employee/EmployeeService', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      validateToken: (token: string) => ({ valid: true, employee_id: token }),
      getEmployeeById: (id: string) => ({ employee_id: id, display_name: 'Emp', is_active: 1 }),
    }),
  },
}));
jest.mock('../../utils/WorkspaceManager', () => ({ __esModule: true, default: { getInstance: () => ({}) } }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import SocketIOService from '../../services/socket/SocketIOService';

describe('Socket.IO audience delivery and catch-up', () => {
  let server: http.Server;
  let service: SocketIOService;
  let clients: Socket[] = [];
  const allowed: Record<string, string[]> = { 'emp-a': ['acc-a'], 'emp-none': [] };
  const modules: Record<string, string[]> = {};

  beforeEach(async () => {
    server = http.createServer();
    service = SocketIOService.getInstance();
    service.attach(server);
    service._getBuffer().reset();
    service.setAllowedAccountsResolver((id) => allowed[id] || []);
    service.setModulePermissionResolver((id, mod) => (modules[id] || []).includes(mod));
    for (const k of Object.keys(modules)) delete modules[k];
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterEach(async () => {
    clients.forEach((c) => c.close());
    clients = [];
    service.stop();
    await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  });

  const join = (employeeId: string): Promise<{ socket: Socket; got: any[] }> => new Promise((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const socket = connect(`http://127.0.0.1:${port}`, { auth: { token: employeeId }, reconnection: false, transports: ['websocket'] });
    clients.push(socket);
    const got: any[] = [];
    socket.on('event', (e) => got.push(e));
    socket.on('connect', () => resolve({ socket, got }));
    socket.on('connect_error', reject);
  });
  const settle = () => new Promise((r) => setTimeout(r, 150));

  it('replays only events of accounts the employee may use', async () => {
    service.publish('event:message', { zaloId: 'acc-a', n: 1 }, { kind: 'accounts', ids: ['acc-a'] });
    service.publish('event:message', { zaloId: 'acc-b', n: 2 }, { kind: 'accounts', ids: ['acc-b'] });
    service.publish('crm:campaignChanged', { n: 3 }, { kind: 'nobody' });
    expect(service._getBuffer().size).toBe(3);

    const { socket, got } = await join('emp-a');
    socket.emit('catch-up', { lastSeqId: 0 });
    await settle();
    expect(got.map((e) => e.data.n)).toEqual([1]);
  });

  it('does not deliver live events of other accounts', async () => {
    const { got } = await join('emp-a');
    service.publish('event:message', { n: 1 }, { kind: 'accounts', ids: ['acc-a'] });
    service.publish('event:message', { n: 2 }, { kind: 'accounts', ids: ['acc-b'] });
    service.publish('event:message', { n: 3 }, { kind: 'nobody' });
    service.publish('library:itemAdded', { n: 4 }, { kind: 'everyone' });
    await settle();
    expect(got.map((e) => e.data.n)).toEqual([1, 4]);
  });

  it('an employee with no usable account receives no account event, live or replayed', async () => {
    service.publish('event:message', { n: 1 }, { kind: 'accounts', ids: ['acc-a'] });
    const { socket, got } = await join('emp-none');
    service.publish('event:message', { n: 2 }, { kind: 'accounts', ids: ['acc-a'] });
    socket.emit('catch-up', { lastSeqId: 0 });
    await settle();
    expect(got).toEqual([]);
  });

  it('emitToEmployee reaches only that employee, live and on catch-up', async () => {
    const a = await join('emp-a');
    const n = await join('emp-none');
    service.emitToEmployee('emp-a', 'erp:event:notification', { n: 1 });
    await settle();
    expect(a.got.map((e) => e.data.n)).toEqual([1]);
    expect(n.got).toEqual([]);
    n.socket.emit('catch-up', { lastSeqId: 0 });
    await settle();
    expect(n.got).toEqual([]);
  });

  it('module events are decided at delivery time: live, and again on catch-up', async () => {
    modules['emp-a'] = ['integration'];
    const first = await join('emp-a');
    service.publish('integration:payment', { n: 1 }, { kind: 'module', module: 'integration' });
    await settle();
    expect(first.got.map((e) => e.data.n)).toEqual([1]);
    first.socket.close();

    modules['emp-a'] = []; // module revoked after the event was buffered
    modules['emp-none'] = ['integration']; // granted after the publish
    const e = await join('emp-a');
    e.socket.emit('catch-up', { lastSeqId: 0 });
    const f = await join('emp-none');
    f.socket.emit('catch-up', { lastSeqId: 0 });
    await settle();
    expect(e.got).toEqual([]);
    expect(f.got.map((x) => x.data.n)).toEqual([1]);
  });

  it('an employee without the module does not receive a newly published module event', async () => {
    const { got } = await join('emp-a');
    service.publish('workflow:executed', { n: 1 }, { kind: 'module', module: 'workflow' });
    await settle();
    expect(got).toEqual([]);
  });
});
