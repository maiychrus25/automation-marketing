import * as http from 'http';
import type { AddressInfo } from 'net';
import { io as connect, Socket } from 'socket.io-client';
import { startRelay, RelayHarness } from './relayHarness';
import { canReceiveRelayEvent } from '../../services/socket/relayAudience';

const account = (id: string): any => ({ zalo_id: id, full_name: id, avatar_url: '', phone: '', is_business: 0, is_active: 1, channel: 'facebook' });

describe('Facebook Page events reach only the employees who may use the Page', () => {
  let h: RelayHarness;
  let relay: any;
  const reaches = (emp: string) => {
    const { audience } = h.published[h.published.length - 1];
    return canReceiveRelayEvent(audience, emp, relay.allowedAccountsFor(emp));
  };

  beforeEach(async () => {
    h = await startRelay({
      employees: [
        { id: 'emp-1', assigned: ['page-1'], modules: ['chat'] },
        { id: 'emp-2', assigned: ['page-2'], modules: ['chat'] },
        { id: 'emp-3', assigned: ['fb-personal'], modules: ['chat'] },
      ],
      accounts: [account('page-1'), account('page-2'), account('fb-personal')],
      fbAccounts: [
        { id: 'uuid-personal', facebook_id: 'fb-personal', parent_facebook_id: null },
        { id: 'uuid-page-1', facebook_id: 'page-1', parent_facebook_id: 'fb-personal' },
        { id: 'uuid-page-2', facebook_id: 'page-2', parent_facebook_id: 'fb-personal' },
      ],
    });
    relay = (await import('../../services/http/HttpRelayService')).default.getInstance();
    relay.running = true;
  });
  afterEach(async () => { relay.running = false; await h.close(); });

  it('a Page message goes to the employee of that Page only', () => {
    relay.relayEventToEmployees('fb:onMessage', { fbAccountId: 'page-1', message: { body: 'x' } });
    expect([reaches('emp-1'), reaches('emp-2'), reaches('emp-3')]).toEqual([true, false, false]);
  });

  it('an event of a personal Facebook account reaches nobody, even when it is assigned', () => {
    relay.relayEventToEmployees('fb:onMessage', { fbAccountId: 'fb-personal', message: { body: 'x' } });
    expect([reaches('emp-1'), reaches('emp-2'), reaches('emp-3')]).toEqual([false, false, false]);
  });

  it('an event without fbAccountId reaches nobody', () => {
    relay.relayEventToEmployees('fb:onReaction', { reaction: 'x' });
    expect([reaches('emp-1'), reaches('emp-2'), reaches('emp-3')]).toEqual([false, false, false]);
  });

  it('a late-joining employee catches up on the events of its own Page only', async () => {
    const SocketIOService = jest.requireActual('../../services/socket/SocketIOService').default;
    const server = http.createServer();
    const service = SocketIOService.getInstance();
    service.attach(server);
    service._getBuffer().reset();
    service.setAllowedAccountsResolver((id: string) => relay.allowedAccountsFor(id));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    let socket: Socket | undefined;
    try {
      const { classifyRelayEvent } = await import('../../services/socket/relayAudience');
      for (const fbAccountId of ['page-1', 'page-2', 'fb-personal']) {
        const data = { fbAccountId, message: { body: fbAccountId } };
        service.publish('fb:onMessage', data, classifyRelayEvent('fb:onMessage', data));
      }
      const got: any[] = [];
      const { port } = server.address() as AddressInfo;
      socket = connect(`http://127.0.0.1:${port}`, { auth: { token: 'tok-emp-1' }, reconnection: false, transports: ['websocket'] });
      socket.on('event', (e) => got.push(e));
      await new Promise<void>((resolve, reject) => { socket!.on('connect', () => resolve()); socket!.on('connect_error', reject); });
      socket.emit('catch-up', { lastSeqId: 0 });
      await new Promise((r) => setTimeout(r, 200));
      expect(got.map((e) => e.data.fbAccountId)).toEqual(['page-1']);
    } finally {
      socket?.close();
      service.stop();
      await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
    }
  });
});
