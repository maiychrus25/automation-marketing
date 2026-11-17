import * as http from 'http';
import type { AddressInfo } from 'net';
import { Server as IoServer } from 'socket.io';

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
import SocketIOClient from '../../services/socket/SocketIOClient';

const waitFor = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const settle = () => new Promise((r) => setTimeout(r, 200));
const listen = (server: http.Server, port = 0) => new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
const closeServer = (server: http.Server) => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });

describe('SocketIOClient catch-up against the real boss service', () => {
  let server: http.Server;
  let service: SocketIOService;
  let client: SocketIOClient;
  let resyncs: string[];
  let events: number[];
  let socketStates: boolean[];

  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const publish = (n: number) => service.publish('event:message', { n }, { kind: 'everyone' });
  const newClient = (ackTimeoutMs?: number) => {
    client = new SocketIOClient(ackTimeoutMs);
    client.setOnResync((r) => resyncs.push(r));
    client.setOnEvent((_c, d) => events.push(d.n));
    client.setOnStatusChange((c) => socketStates.push(c));
  };

  beforeEach(async () => {
    resyncs = []; events = []; socketStates = [];
    server = http.createServer();
    service = SocketIOService.getInstance();
    service.attach(server, 100);
    service._getBuffer().reset();
    await listen(server);
  });
  afterEach(async () => {
    client?.disconnect();
    service.stop();
    await closeServer(server);
  });

  it('first connection asks to resync with reason fresh', async () => {
    newClient();
    client.connect(url(), 'emp-a');
    await waitFor(() => resyncs.length > 0);
    expect(resyncs).toEqual(['fresh']);
    expect(socketStates[0]).toBe(true);
  });

  it('reconnecting into the same stream replays the missed events without a resync', async () => {
    newClient();
    client.connect(url(), 'emp-a');
    await waitFor(() => resyncs.length === 1);
    publish(1);
    await waitFor(() => events.length === 1);

    // Drop only the transport: the server stays up, the stream stays the same.
    (client as any).socket.io.engine.close();
    await waitFor(() => socketStates.includes(false));
    publish(2);
    publish(3);
    await waitFor(() => events.length === 3);
    await settle();
    expect(events).toEqual([1, 2, 3]);
    expect(resyncs).toEqual(['fresh']);
  });

  it('a boss restart (new stream) asks to resync with boss-restart', async () => {
    newClient();
    client.connect(url(), 'emp-a');
    await waitFor(() => resyncs.length === 1);
    publish(1);
    await waitFor(() => events.length === 1);

    const port = (server.address() as AddressInfo).port;
    service.stop();
    await closeServer(server);
    server = http.createServer();
    service.attach(server, 100);
    await listen(server, port);

    await waitFor(() => resyncs.length === 2);
    expect(resyncs).toEqual(['fresh', 'boss-restart']);
  });

  it('a client closed before the ack arrives reports no resync, even after the timeout', async () => {
    const silent = http.createServer();
    const io = new IoServer(silent);
    let asked = false;
    io.on('connection', (s) => s.on('catch-up', () => { asked = true; }));
    await listen(silent);
    try {
      newClient(150);
      client.connect(`http://127.0.0.1:${(silent.address() as AddressInfo).port}`, 'emp-a');
      await waitFor(() => asked);
      client.disconnect();
      await new Promise((r) => setTimeout(r, 400));
      expect(resyncs).toEqual([]);
    } finally {
      client.disconnect();
      await new Promise<void>((r) => io.close(() => r()));
      await closeServer(silent);
    }
  });

  it('a boss that never acks is reported catchup-unverified after the timeout', async () => {
    const silent = http.createServer();
    const io = new IoServer(silent);
    io.on('connection', (s) => s.on('catch-up', () => { /* old boss: no ack */ }));
    await listen(silent);
    try {
      newClient(150);
      client.connect(`http://127.0.0.1:${(silent.address() as AddressInfo).port}`, 'emp-a');
      await waitFor(() => resyncs.length > 0);
      expect(resyncs).toEqual(['catchup-unverified']);
    } finally {
      client.disconnect();
      await new Promise<void>((r) => io.close(() => r()));
      await closeServer(silent);
    }
  });
  it('a late real ack on the current socket is adopted without a second resync', async () => {
    const late = http.createServer();
    const io = new IoServer(late);
    const asked: any[] = [];
    let answer: ((a: any) => void) | null = null;
    io.on('connection', (s) => s.on('catch-up', (req, ack) => { asked.push(req); answer = ack; }));
    await listen(late);
    try {
      newClient(100);
      client.connect(`http://127.0.0.1:${(late.address() as AddressInfo).port}`, 'emp-a');
      await waitFor(() => resyncs.length === 1);
      expect(resyncs).toEqual(['catchup-unverified']);
      answer!({ proto: 2, bootId: 'boss-boot', status: 'replayed', lastSeqId: 42 });
      await waitFor(() => client['position'].bootId === 'boss-boot');
      await settle();
      expect(resyncs).toEqual(['catchup-unverified']);
      expect(client['position'].request()).toEqual({ proto: 2, bootId: 'boss-boot', lastSeqId: 42 });
    } finally {
      client.disconnect();
      await new Promise<void>((r) => io.close(() => r()));
      await closeServer(late);
    }
  });

  it('a late ack for a socket that is no longer current stays ignored', async () => {
    const late = http.createServer();
    const io = new IoServer(late);
    let answer: ((a: any) => void) | null = null;
    io.on('connection', (s) => s.on('catch-up', (_req, ack) => { answer = ack; }));
    await listen(late);
    try {
      newClient(100);
      client.connect(`http://127.0.0.1:${(late.address() as AddressInfo).port}`, 'emp-a');
      await waitFor(() => resyncs.length === 1);
      const stale = answer!;
      client.disconnect();
      stale({ proto: 2, bootId: 'boss-boot', status: 'replayed', lastSeqId: 42 });
      await settle();
      expect(client['position'].bootId).toBeNull();
    } finally {
      client.disconnect();
      await new Promise<void>((r) => io.close(() => r()));
      await closeServer(late);
    }
  });

  it('an idle stream: the second reconnect asks for no resync', async () => {
    newClient();
    client.connect(url(), 'emp-a');
    await waitFor(() => resyncs.length === 1); // first connection: fresh
    for (let round = 0; round < 2; round++) {
      const before = socketStates.filter((c) => c).length;
      (client as any).socket.io.engine.close();
      await waitFor(() => socketStates.filter((c) => c).length === before + 1);
      await settle();
    }
    expect(resyncs).toEqual(['fresh']);
    expect(client['position'].bootId).toBe(service._getBuffer().bootId);
  });
});
