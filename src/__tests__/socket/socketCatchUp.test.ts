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
import EventBuffer from '../../services/socket/EventBuffer';
import type { RelayAudience } from '../../services/socket/relayAudience';

describe('Socket.IO audience delivery and catch-up', () => {
  let server: http.Server;
  let service: SocketIOService;
  let clients: Socket[] = [];
  const allowed: Record<string, string[]> = { 'emp-a': ['acc-a'], 'emp-none': [] };
  const modules: Record<string, string[]> = {};
  const profiles: Record<string, string[]> = {};

  beforeEach(async () => {
    server = http.createServer();
    service = SocketIOService.getInstance();
    service.attach(server, 100);
    service._getBuffer().reset();
    service.setAllowedAccountsResolver((id) => allowed[id] || []);
    service.setModulePermissionResolver((id, mod) => (modules[id] || []).includes(mod));
    service.setAllowedProfilesResolver((id) => profiles[id] || []);
    for (const k of Object.keys(modules)) delete modules[k];
    for (const k of Object.keys(profiles)) delete profiles[k];
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterEach(async () => {
    clients.forEach((c) => c.close());
    clients = [];
    service.stop();
    await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  });

  /** Connects without sending catch-up: the server only starts live delivery after catch-up (or the fallback delay). */
  const joinRaw = (employeeId: string): Promise<{ socket: Socket; got: any[] }> => new Promise((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const socket = connect(`http://127.0.0.1:${port}`, { auth: { token: employeeId }, reconnection: false, transports: ['websocket'] });
    clients.push(socket);
    const got: any[] = [];
    socket.on('event', (e) => got.push(e));
    socket.on('connect', () => resolve({ socket, got }));
    socket.on('connect_error', reject);
  });
  /** Connects and completes a fresh catch-up (nothing replayed) so the socket receives live events. */
  const join = async (employeeId: string) => {
    const c = await joinRaw(employeeId);
    await new Promise((r) => c.socket.emit('catch-up', { proto: 2, lastSeqId: 0 }, r));
    return c;
  };
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

  it('event:userPresence of a Telegram account is delivered live but never buffered', async () => {
    const { got } = await join('emp-a');
    service.publish('event:userPresence', { zaloId: 'acc-a', channel: 'telegram_user', userId: 'u' }, { kind: 'accounts', ids: ['acc-a'] });
    await settle();
    expect(got.map((e) => e.channel)).toEqual(['event:userPresence']);
    expect(got[0].seqId).toBeUndefined();
    expect(service._getBuffer().size).toBe(0);
  });

  it.each(['event:telegramEntityHydrated', 'event:groupMemberAvatar'])('%s is delivered live but never buffered', async (channel) => {
    const { got } = await join('emp-a');
    service.publish(channel, { zaloId: 'acc-a', channel: 'telegram_user' }, { kind: 'accounts', ids: ['acc-a'] });
    await settle();
    expect(got.map((e) => e.channel)).toEqual([channel]);
    expect(got[0].seqId).toBeUndefined();
    expect(service._getBuffer().size).toBe(0);
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

  it('profile events: live only to an employee who has every profile; a poster log is ephemeral (never buffered)', async () => {
    profiles['emp-a'] = ['p1'];
    const { got } = await join('emp-a');
    const none = await join('emp-none');
    service.publish('facebookPoster:log', { n: 1 }, { kind: 'profiles', ids: ['p1'] });
    service.publish('facebookPoster:progress', { n: 2 }, { kind: 'profiles', ids: ['p1', 'p2'] });
    service.publish('facebookPoster:progress', { n: 3 }, { kind: 'profiles', ids: [] });
    await settle();
    expect(got.map((e) => e.data.n)).toEqual([1]);
    expect(got[0].seqId).toBeUndefined();
    expect(none.got).toEqual([]);
    expect(service._getBuffer().size).toBe(0);
  });

  it('replays a buffered profile event only while the profile is still assigned (an employee unassigned while disconnected gets nothing)', async () => {
    service.publish('facebookPoster:log', { n: 1 }, { kind: 'profiles', ids: ['p1'] }); // ephemeral: never buffered
    // The buffer only takes non-ephemeral channels: a profiles audience on another channel stands in for a replayable one.
    service.publish('test:profileScoped', { n: 2 }, { kind: 'profiles', ids: ['p1'] });
    profiles['emp-a'] = ['p1'];
    const kept = await join('emp-a');
    kept.socket.emit('catch-up', { lastSeqId: 0 });
    await settle();
    expect(kept.got.map((e) => e.data.n)).toEqual([2]);
    kept.socket.close();

    profiles['emp-a'] = []; // unassigned (or fb_poster revoked) while disconnected
    const dropped = await join('emp-a');
    dropped.socket.emit('catch-up', { lastSeqId: 0 });
    await settle();
    expect(dropped.got).toEqual([]);
  });

  it('a profile event without a resolver for the employee reaches nobody', async () => {
    service.setAllowedProfilesResolver(() => { throw new Error('boom'); });
    const { got } = await join('emp-a');
    service.publish('test:profileScoped', { n: 1 }, { kind: 'profiles', ids: ['p1'] });
    await settle();
    expect(got).toEqual([]);
  });

  describe('catch-up protocol 2', () => {
    const ask = (socket: Socket, req: object): Promise<any> => new Promise((r) => socket.emit('catch-up', req, r));
    const bootId = () => service._getBuffer().bootId;

    it('replays exactly the missing part and acks replayed', async () => {
      service.publish('event:message', { n: 1 }, { kind: 'accounts', ids: ['acc-a'] });
      service.publish('event:message', { n: 2 }, { kind: 'accounts', ids: ['acc-a'] });
      service.publish('event:message', { n: 3 }, { kind: 'accounts', ids: ['acc-a'] });
      const first = service._getBuffer().oldestSeqId()!;
      const { socket, got } = await join('emp-a');
      const ack = await ask(socket, { proto: 2, bootId: bootId(), lastSeqId: first });
      await settle();
      expect(got.map((e) => e.data.n)).toEqual([2, 3]);
      expect(got.every((e) => e.bootId === bootId())).toBe(true);
      expect(ack).toMatchObject({ proto: 2, bootId: bootId(), status: 'replayed', lastSeqId: first + 2 });
    });

    it('a different bootId is answered reset boss-restart and replays nothing', async () => {
      service.publish('event:message', { n: 1 }, { kind: 'accounts', ids: ['acc-a'] });
      const { socket, got } = await join('emp-a');
      const ack = await ask(socket, { proto: 2, bootId: 'older-boot', lastSeqId: 999999999999999 });
      await settle();
      expect(ack).toMatchObject({ status: 'reset', reason: 'boss-restart', bootId: bootId() });
      expect(got).toEqual([]);
    });

    it('a fresh connection is answered reset fresh and receives nothing', async () => {
      service.publish('event:message', { n: 1 }, { kind: 'accounts', ids: ['acc-a'] });
      const { socket, got } = await join('emp-a');
      const ack = await ask(socket, { proto: 2, lastSeqId: 0 });
      await settle();
      expect(ack).toMatchObject({ status: 'reset', reason: 'fresh' });
      expect(got).toEqual([]);
    });

    it('a request without proto still replays the filtered buffer', async () => {
      service.publish('event:message', { n: 1 }, { kind: 'accounts', ids: ['acc-a'] });
      service.publish('event:message', { n: 2 }, { kind: 'accounts', ids: ['acc-b'] });
      const { socket, got } = await join('emp-a');
      socket.emit('catch-up', { lastSeqId: 0 });
      await settle();
      expect(got.map((e) => e.data.n)).toEqual([1]);
    });

    it('typing is delivered live but never replayed', async () => {
      const { socket, got } = await join('emp-a');
      service.publish('event:typing', { zaloId: 'acc-a', n: 1 }, { kind: 'accounts', ids: ['acc-a'] });
      service.publish('event:message', { n: 2 }, { kind: 'accounts', ids: ['acc-a'] });
      await settle();
      expect(got.map((e) => e.data.n)).toEqual([1, 2]);
      expect(service._getBuffer().size).toBe(1);
      got.length = 0;
      socket.emit('catch-up', { lastSeqId: 0 });
      await settle();
      expect(got.map((e) => e.data.n)).toEqual([2]);
    });

    it('an account withdrawn between connections is not replayed', async () => {
      service.publish('event:message', { n: 1 }, { kind: 'accounts', ids: ['acc-a'] });
      const first = service._getBuffer().oldestSeqId()!;
      const { socket, got } = await join('emp-a');
      const saved = allowed['emp-a'];
      allowed['emp-a'] = [];
      try {
        const ack = await ask(socket, { proto: 2, bootId: bootId(), lastSeqId: first - 1 });
        await settle();
        expect(ack.status).toBe('replayed');
        expect(got).toEqual([]);
      } finally {
        allowed['emp-a'] = saved;
      }
    });

    it('a fresh start gives a new bootId and larger sequence numbers', async () => {
      service.publish('event:message', { n: 1 }, { kind: 'nobody' });
      const oldBoot = bootId();
      const oldSeq = service._getBuffer().newestSeqId()!;
      service._getBuffer().reset();
      expect(bootId()).not.toBe(oldBoot);
      service.publish('event:message', { n: 2 }, { kind: 'nobody' });
      expect(service._getBuffer().newestSeqId()!).toBeGreaterThan(oldSeq);
    });

    it('live typing envelope has bootId and no seqId property', async () => {
      const { got } = await join('emp-a');
      service.publish('event:typing', { zaloId: 'acc-a', n: 1 }, { kind: 'accounts', ids: ['acc-a'] });
      await settle();
      expect(got).toHaveLength(1);
      expect(got[0].bootId).toBe(bootId());
      expect(Object.prototype.hasOwnProperty.call(got[0], 'seqId')).toBe(false);
    });

    it('a position older than the oldest event is answered reset gap with nothing sent', async () => {
      for (let n = 1; n <= 3; n++) service.publish('event:message', { n }, { kind: 'accounts', ids: ['acc-a'] });
      const { socket, got } = await join('emp-a');
      const ack = await ask(socket, { proto: 2, bootId: bootId(), lastSeqId: service._getBuffer().oldestSeqId()! - 2 });
      await settle();
      expect(ack).toMatchObject({ status: 'reset', reason: 'gap' });
      expect(got).toEqual([]);
    });

    it('more than 500 missed events is answered reset gap with nothing sent', async () => {
      for (let n = 1; n <= 502; n++) service.publish('event:message', { n }, { kind: 'accounts', ids: ['acc-a'] });
      const { socket, got } = await join('emp-a');
      const ack = await ask(socket, { proto: 2, bootId: bootId(), lastSeqId: service._getBuffer().oldestSeqId()! });
      await settle();
      expect(ack).toMatchObject({ status: 'reset', reason: 'gap' });
      expect(got).toEqual([]);
    });

    it('after stop and attach a connected employee asking with the old stream gets reset boss-restart', async () => {
      service.publish('event:message', { n: 1 }, { kind: 'accounts', ids: ['acc-a'] });
      const oldBoot = bootId();
      const oldSeq = service._getBuffer().newestSeqId()!;
      service.stop();
      await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
      server = http.createServer();
      service.attach(server, 100);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const { socket, got } = await joinRaw('emp-a');
      const ack = await ask(socket, { proto: 2, bootId: oldBoot, lastSeqId: oldSeq });
      await settle();
      expect(bootId()).not.toBe(oldBoot);
      expect(ack).toMatchObject({ status: 'reset', reason: 'boss-restart', bootId: bootId() });
      expect(got).toEqual([]);
    });

    it('an event published before the delayed catch-up arrives is delivered exactly once', async () => {
      service.publish('event:message', { n: 1 }, { kind: 'accounts', ids: ['acc-a'] });
      const known = service._getBuffer().newestSeqId()!;
      const { socket, got } = await joinRaw('emp-a');
      service.publish('event:message', { n: 2 }, { kind: 'accounts', ids: ['acc-a'] });
      await new Promise((r) => setTimeout(r, 30)); // still inside the fallback window
      const ack = await ask(socket, { proto: 2, bootId: bootId(), lastSeqId: known });
      service.publish('event:message', { n: 3 }, { kind: 'accounts', ids: ['acc-a'] });
      await settle();
      expect(ack.status).toBe('replayed');
      expect(got.map((e) => e.data.n)).toEqual([2, 3]);
    });

    it('a client that never sends catch-up starts receiving live events after the fallback delay', async () => {
      const { got } = await joinRaw('emp-a');
      service.publish('event:message', { n: 1 }, { kind: 'accounts', ids: ['acc-a'] });
      await new Promise((r) => setTimeout(r, 30));
      expect(got).toEqual([]);
      await new Promise((r) => setTimeout(r, 150));
      service.publish('event:message', { n: 2 }, { kind: 'accounts', ids: ['acc-a'] });
      await settle();
      expect(got.map((e) => e.data.n)).toEqual([2]);
    });

    it('online tracking starts at connection, before catch-up', async () => {
      const { socket } = await joinRaw('emp-a');
      expect(service.isOnline('emp-a')).toBe(true);
      expect(service.getOnlineCount()).toBe(1);
      service.disconnectEmployee('emp-a');
      await settle();
      expect(socket.connected).toBe(false);
      expect(service.isOnline('emp-a')).toBe(false);
    });

    it('counts only the events this employee may receive against the replay cap', async () => {
      const other: RelayAudience = { kind: 'accounts', ids: ['acc-b'] };
      for (let n = 1; n <= 600; n++) {
        const mine = n === 100 || n === 300 || n === 599;
        service.publish('event:message', { n }, mine ? { kind: 'accounts', ids: ['acc-a'] } : other);
      }
      const { socket, got } = await join('emp-a');
      const ack = await ask(socket, { proto: 2, bootId: bootId(), lastSeqId: service._getBuffer().oldestSeqId()! - 1 });
      await settle();
      expect(ack.status).toBe('replayed');
      expect(got.map((e) => e.data.n)).toEqual([100, 300, 599]);
    });

    it('501 visible events are still a gap and nothing is replayed', async () => {
      for (let n = 1; n <= 501; n++) service.publish('event:message', { n }, { kind: 'accounts', ids: ['acc-a'] });
      for (let n = 0; n < 50; n++) service.publish('event:message', { n }, { kind: 'accounts', ids: ['acc-b'] });
      const { socket, got } = await join('emp-a');
      const ack = await ask(socket, { proto: 2, bootId: bootId(), lastSeqId: service._getBuffer().oldestSeqId()! - 1 });
      await settle();
      expect(ack).toMatchObject({ status: 'reset', reason: 'gap' });
      expect(got).toEqual([]);
    });

    it('lastSeqId 0 with the current bootId on an idle stream is replayed with a null position', async () => {
      const { socket, got } = await join('emp-a');
      const ack = await ask(socket, { proto: 2, bootId: bootId(), lastSeqId: 0 });
      expect(ack).toMatchObject({ status: 'replayed', bootId: bootId(), lastSeqId: null });
      expect(got).toEqual([]);
    });

    it('lastSeqId 0 with the current bootId replays what the stream still holds', async () => {
      service.publish('event:message', { n: 1 }, { kind: 'accounts', ids: ['acc-a'] });
      service.publish('event:message', { n: 2 }, { kind: 'accounts', ids: ['acc-b'] });
      const { socket, got } = await join('emp-a');
      const ack = await ask(socket, { proto: 2, bootId: bootId(), lastSeqId: 0 });
      await settle();
      expect(ack.status).toBe('replayed');
      expect(got.map((e) => e.data.n)).toEqual([1]);
    });

    it('lastSeqId 0 with the current bootId after an eviction is a gap', async () => {
      EventBuffer.setMaxSize(100);
      try {
        for (let n = 1; n <= 101; n++) service.publish('event:message', { n }, { kind: 'accounts', ids: ['acc-a'] });
        const { socket, got } = await join('emp-a');
        const ack = await ask(socket, { proto: 2, bootId: bootId(), lastSeqId: 0 });
        await settle();
        expect(ack).toMatchObject({ status: 'reset', reason: 'gap' });
        expect(got).toEqual([]);
      } finally {
        EventBuffer.setMaxSize(5000);
      }
    });

    it('a catch-up arriving after the fallback join does not replay events already delivered live', async () => {
      service.publish('event:message', { n: 0 }, { kind: 'accounts', ids: ['acc-a'] });
      const known = service._getBuffer().newestSeqId()!;
      const { socket, got } = await joinRaw('emp-a');
      await new Promise((r) => setTimeout(r, 250)); // fallback (100 ms) has joined the live room
      service.publish('event:message', { n: 1 }, { kind: 'accounts', ids: ['acc-a'] });
      await settle();
      const ack = await ask(socket, { proto: 2, bootId: bootId(), lastSeqId: known });
      await settle();
      expect(ack.status).toBe('replayed');
      expect(got.map((e) => e.data.n)).toEqual([1]);
    });

    it('a legacy catch-up arriving after the fallback join does not replay live events either', async () => {
      const { socket, got } = await joinRaw('emp-a');
      await new Promise((r) => setTimeout(r, 250));
      service.publish('event:message', { n: 1 }, { kind: 'accounts', ids: ['acc-a'] });
      await settle();
      socket.emit('catch-up', { lastSeqId: 0 });
      await settle();
      expect(got.map((e) => e.data.n)).toEqual([1]);
    });

    it('a legacy catch-up does not replay an account withdrawn while disconnected', async () => {
      service.publish('event:message', { n: 1 }, { kind: 'accounts', ids: ['acc-a'] });
      const { socket, got } = await join('emp-a');
      allowed['emp-a'] = [];
      try {
        socket.emit('catch-up', { lastSeqId: 0 });
        await settle();
        expect(got).toEqual([]);
      } finally {
        allowed['emp-a'] = ['acc-a'];
      }
    });

    it('two sockets of one employee: closing one keeps the employee online; disconnectEmployee closes both', async () => {
      const one = await joinRaw('emp-a'); // neither has joined the emp: room yet
      const two = await joinRaw('emp-a');
      expect(service.getOnlineCount()).toBe(1);
      one.socket.close();
      await settle();
      expect(service.isOnline('emp-a')).toBe(true);
      const three = await joinRaw('emp-a');
      service.disconnectEmployee('emp-a');
      await settle();
      expect(two.socket.connected).toBe(false);
      expect(three.socket.connected).toBe(false);
      expect(service.isOnline('emp-a')).toBe(false);
    });
  });
});
