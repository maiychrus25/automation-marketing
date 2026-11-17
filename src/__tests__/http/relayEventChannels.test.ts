import * as fs from 'fs';
import * as path from 'path';
import { startRelay, RelayHarness } from './relayHarness';
import { FACEBOOK_RELAY_CHANNELS } from '../../services/socket/relayAudience';
import { RELAYED_EVENT_CHANNELS, EMPLOYEE_CONTROL_CHANNELS } from '../../services/socket/relayChannels';

describe('Facebook relay channel lists', () => {
  let h: RelayHarness;
  beforeAll(async () => { h = await startRelay({ employees: [], accounts: [] }); });
  afterAll(() => h.close());

  const readPreload = () => fs.readFileSync(path.join(__dirname, '../../../electron/preload.ts'), 'utf8');

  it('every Facebook relay channel is relayed by the boss and forwarded by the employee', async () => {
    const relayChannels: readonly string[] = (await import('../../services/http/HttpRelayService')).default['RELAY_CHANNELS'];
    const forwardChannels: readonly string[] = (await import('../../services/http/HttpClientService')).default['FORWARD_CHANNELS'];
    for (const channel of FACEBOOK_RELAY_CHANNELS) {
      expect(relayChannels).toContain(channel);
      expect(forwardChannels).toContain(channel);
    }
  });

  it('the Facebook names the renderer listens to are in the preload whitelist', () => {
    const preload = readPreload();
    for (const channel of ['fb:onMessage', 'fb:onReaction', 'fb:onUnsend', 'fb:onEdit', 'fb:onConnectionStatus']) {
      expect(preload).toContain(`'${channel}'`);
    }
  });

  // Các listener này chưa từng chạy: onContactUpdate/onThreadInfoUpdate có thể thêm hội thoại rỗng vào store,
  // onSeen đổi cách hiển thị đã đọc. Muốn bật một tên phải có test cho listener của nó trước.
  it('dormant Facebook listeners stay out of the preload whitelist', () => {
    const preload = readPreload();
    for (const channel of ['fb:onSeen', 'fb:onContactUpdate', 'fb:onThreadInfoUpdate']) {
      expect(preload).not.toContain(`'${channel}'`);
    }
  });

  it('boss and employee lists are built from the shared constants', async () => {
    const relayChannels: readonly string[] = (await import('../../services/http/HttpRelayService')).default['RELAY_CHANNELS'];
    const forwardChannels: readonly string[] = (await import('../../services/http/HttpClientService')).default['FORWARD_CHANNELS'];
    expect(relayChannels).toEqual(RELAYED_EVENT_CHANNELS);
    expect(forwardChannels).toEqual([...RELAYED_EVENT_CHANNELS, ...EMPLOYEE_CONTROL_CHANNELS]);
    expect(forwardChannels).not.toContain('employee:resync');
  });

  it('typing and presence are never relayed', async () => {
    const relayChannels: readonly string[] = (await import('../../services/http/HttpRelayService')).default['RELAY_CHANNELS'];
    const forwardChannels: readonly string[] = (await import('../../services/http/HttpClientService')).default['FORWARD_CHANNELS'];
    for (const channel of ['fb:onTyping', 'fb:onPresence']) {
      expect(FACEBOOK_RELAY_CHANNELS).not.toContain(channel);
      expect(relayChannels).not.toContain(channel);
      expect(forwardChannels).not.toContain(channel);
    }
  });

  it('the employee client hands a Facebook event to the renderer untouched and without Zalo persistence', async () => {
    const client: any = (await import('../../services/http/HttpClientService')).default.getInstance();
    const persist = jest.spyOn(client, 'persistRelayConversationEvent');
    const broadcaster: any = (await import('../../services/event/EventBroadcaster')).default;
    const send = (broadcaster.sendDirect = jest.fn());
    const data = { fbAccountId: 'page-1', message: { body: 'x' } };
    client.handlePushedEvent('fb:onMessage', data);
    expect(send).toHaveBeenCalledWith('fb:onMessage', data);
    // Không nhánh Zalo nào khớp: persistRelayConversationEvent không ghi gì cho kênh fb:*.
    expect(persist).toHaveBeenCalledTimes(1);
    expect(h.db.setContactAlias).not.toHaveBeenCalled();
  });

  describe('Telegram events on the employee machine', () => {
    let originalSend: any;
    let restoreSend: () => void = () => {};
    afterEach(() => restoreSend());
    const load = async () => {
      const client: any = new ((await import('../../services/http/HttpClientService')).default as any)();
      const broadcaster: any = (await import('../../services/event/EventBroadcaster')).default;
      originalSend = broadcaster.sendDirect;
      const send = (broadcaster.sendDirect = jest.fn());
      restoreSend = () => { broadcaster.sendDirect = originalSend; };
      const saveMsg = jest.spyOn(client, 'saveRelayMessageToWorkspaceDb').mockImplementation(() => {});
      const persist = jest.spyOn(client, 'persistRelayConversationEvent');
      return { client, send, saveMsg, persist };
    };
    const tgMessage = { zaloId: 'tg-1', channel: 'telegram_user', message: { channel: 'telegram_user', threadId: 'c1', data: { channel: 'telegram_user' } } };

    it('a Zalo event:message still goes through the local save', async () => {
      const { client, saveMsg } = await load();
      client.handlePushedEvent('event:message', { zaloId: 'z1', message: { threadId: 't', data: {} } });
      expect(saveMsg).toHaveBeenCalledTimes(1);
    });

    it('a Telegram event:message is forwarded as it arrived and never saved', async () => {
      const { client, send, saveMsg, persist } = await load();
      client.handlePushedEvent('event:message', tgMessage);
      expect(saveMsg).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith('event:message', tgMessage);
    });

    it('an event of an account known from the snapshot as Telegram skips every local write', async () => {
      const { client, send, persist } = await load();
      client.handlePushedEvent('relay:initialState', { accountsData: [{ zalo_id: 'tg-9', channel: 'telegram_bot' }, { zalo_id: 'z1', channel: 'zalo' }] });
      for (const channel of ['event:localPath', 'event:groupInfoUpdate', 'event:pinsUpdated', 'event:groupEvent', 'event:telegramSync', 'event:messageEdited', 'db:unreadChanged']) {
        const data = { zaloId: 'tg-9', threadId: 'c1' };
        client.handlePushedEvent(channel, data);
        expect(send).toHaveBeenCalledWith(channel, data);
      }
      expect(persist).not.toHaveBeenCalled();
      client.handlePushedEvent('event:localPath', { zaloId: 'z1' });
      expect(persist).toHaveBeenCalledTimes(1);
    });

    it('account access updates refresh the set and disconnect clears it', async () => {
      const { client, persist } = await load();
      client.handlePushedEvent('relay:accountAccessUpdate', { accountsData: [{ zalo_id: 'tg-7', channel: 'telegram_user' }] });
      client.handlePushedEvent('event:localPath', { zaloId: 'tg-7' });
      expect(persist).not.toHaveBeenCalled();
      client.disconnect();
      client.handlePushedEvent('event:localPath', { zaloId: 'tg-7' });
      expect(persist).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['db:pinnedMessageChanged', { ownerZaloId: 'tg-1', threadId: 'c1' }],
      ['db:localLabelThreadChanged', { ownerZaloId: 'tg-1', threadId: 'c1' }],
      ['crm:noteChanged', { ownerZaloId: 'tg-1', contactId: 'c1' }],
      ['db:contactAliasChanged', { ownerZaloId: 'tg-1', contactId: 'c1', alias: 'a' }],
      ['db:localQuickMessageChanged', { ownerZaloIds: ['z1', 'tg-1'] }],
    ])('%s keyed by another account field is forwarded and reaches no persistence', async (channel, data) => {
      const { client, send, persist } = await load();
      client.handlePushedEvent('relay:initialState', { accountsData: [{ zalo_id: 'tg-1', channel: 'telegram_user' }] });
      client.handlePushedEvent(channel, data);
      expect(send).toHaveBeenCalledWith(channel, data);
      expect(persist).not.toHaveBeenCalled();
      expect(h.db.setContactAlias).not.toHaveBeenCalled();
    });

    it('the same payloads for a Zalo account still persist', async () => {
      const { client, persist } = await load();
      client.handlePushedEvent('relay:initialState', { accountsData: [{ zalo_id: 'tg-1', channel: 'telegram_user' }] });
      for (const channel of ['db:pinnedMessageChanged', 'db:localLabelThreadChanged', 'crm:noteChanged']) {
        client.handlePushedEvent(channel, { ownerZaloId: 'z1', threadId: 'c1' });
      }
      expect(persist).toHaveBeenCalledTimes(3);
    });

    it('relay:messageSentByEmployee of a Telegram account never marks the local database', async () => {
      const { client, send } = await load();
      client.handlePushedEvent('relay:initialState', { accountsData: [{ zalo_id: 'tg-1', channel: 'telegram_user' }] });
      const data = { zaloId: 'tg-1', employee_id: 'e1', msgId: 'm1', threadId: 'c1' };
      client.handlePushedEvent('relay:messageSentByEmployee', data);
      expect(send).toHaveBeenCalledWith('relay:messageSentByEmployee', data);
      expect(h.db.setMessageHandledByEmployeeFlexible).not.toHaveBeenCalled();
    });

    it('an event arriving right after connect() already knows the Telegram accounts', async () => {
      const { client, send, persist } = await load();
      let onEvent: ((c: string, d: any) => void) | undefined;
      jest.spyOn(client, 'httpGet').mockImplementation(async (url: string) => (
        url.endsWith('/api/health') ? { status: 'ok' }
          : { success: true, snapshot: { accountsData: [{ zalo_id: 'tg-1', channel: 'telegram_bot' }] } }));
      jest.spyOn(client, 'httpPost').mockResolvedValue({ success: true });
      jest.spyOn(client, 'startLocalServer').mockResolvedValue(undefined);
      jest.spyOn(client, 'startHeartbeat').mockImplementation(() => {});
      client.socketIOClient.setOnEvent = (cb: any) => { onEvent = cb; };
      client.socketIOClient.connect = jest.fn(() => onEvent!('event:localPath', { zaloId: 'tg-1', msgId: 'm', localPaths: { a: 'b' } }));
      expect((await client.connect('http://boss', 'tok')).success).toBe(true);
      expect(client.socketIOClient.connect).toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith('event:localPath', expect.objectContaining({ zaloId: 'tg-1' }));
      expect(persist).not.toHaveBeenCalled();
      client.disconnect();
    });
  });
  describe('Employee client lifecycle', () => {
    let restoreSend: () => void = () => {};
    afterEach(() => restoreSend());
    const load = async () => {
      const client: any = new ((await import('../../services/http/HttpClientService')).default as any)();
      const broadcaster: any = (await import('../../services/event/EventBroadcaster')).default;
      const original = broadcaster.sendDirect;
      const send = (broadcaster.sendDirect = jest.fn());
      restoreSend = () => { broadcaster.sendDirect = original; };
      return { client, send };
    };
    const flush = () => new Promise((r) => setTimeout(r, 20));

    it('employee:resync carries the workspace of the service that raised it', async () => {
      const { client, send } = await load();
      client.setWorkspaceId('ws-7');
      client.emitResync('gap');
      expect(send).toHaveBeenCalledWith('employee:resync', { reason: 'gap', workspaceId: 'ws-7' });
    });

    describe('system resume', () => {
      const prepare = async (heartbeat: { success: boolean }, failing = 0) => {
        const loaded = await load();
        loaded.client.bossUrl = 'http://boss';
        loaded.client.token = 'tok';
        loaded.client.setWorkspaceId('ws-1');
        loaded.client.consecutiveHeartbeatFailures = failing;
        jest.spyOn(loaded.client, 'httpPost').mockResolvedValue(heartbeat);
        return loaded;
      };
      it('emits system-resume once the heartbeat succeeds', async () => {
        const { client, send } = await prepare({ success: true });
        client.notifySystemResume();
        expect(send).not.toHaveBeenCalled(); // not before the network answered
        await flush();
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith('employee:resync', { reason: 'system-resume', workspaceId: 'ws-1' });
      });
      it('emits nothing while the heartbeat fails', async () => {
        const { client, send } = await prepare({ success: false });
        client.notifySystemResume();
        await flush();
        expect(send).not.toHaveBeenCalled();
      });
      it('a resume that recovers a failing link reports heartbeat-recovered only', async () => {
        const { client, send } = await prepare({ success: true }, 2);
        client.notifySystemResume();
        await flush();
        expect(send.mock.calls.map((c: any[]) => c[1].reason)).toEqual(['heartbeat-recovered']);
      });
    });

    it('a connect() overtaken by disconnect() during the snapshot creates no socket and emits nothing', async () => {
      const { client, send } = await load();
      let release: (v: any) => void = () => {};
      const snapshotPending = new Promise((r) => { release = r; });
      let snapshotAsked = false;
      jest.spyOn(client, 'httpGet').mockImplementation(async (url: string) => {
        if (url.endsWith('/api/health')) return { status: 'ok' };
        snapshotAsked = true;
        return snapshotPending;
      });
      jest.spyOn(client, 'httpPost').mockResolvedValue({ success: true });
      jest.spyOn(client, 'startLocalServer').mockResolvedValue(undefined);
      jest.spyOn(client, 'startHeartbeat').mockImplementation(() => {});
      const socketConnect = (client.socketIOClient.connect = jest.fn());
      const onStatus = jest.fn();
      client.setOnStatusChange?.(onStatus);
      const attempt = client.connect('http://boss', 'tok');
      while (!snapshotAsked) await flush();
      client.disconnect();
      send.mockClear();
      release({ success: true, snapshot: { accountsData: [] } });
      expect(await attempt).toEqual({ success: false, error: 'Disconnected' });
      expect(socketConnect).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      // a later connect() is not confused with the stale one
      jest.spyOn(client, 'httpGet').mockImplementation(async (url: string) => (url.endsWith('/api/health') ? { status: 'ok' } : { success: false }));
      expect((await client.connect('http://boss', 'tok')).success).toBe(true);
      expect(socketConnect).toHaveBeenCalledTimes(1);
      client.disconnect();
    });

    describe('LAN callback server', () => {
      const post = (port: number, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
        const body = JSON.stringify({ channel: 'event:localPath', data: { zaloId: 'z1' } });
        const req = require('http').request(
          { host: '127.0.0.1', port, path: '/event', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } },
          (res: any) => { res.resume(); resolve(res.statusCode); },
        );
        req.on('error', reject);
        req.end(body);
      });
      const getHealth = (port: number) => new Promise<number>((resolve, reject) => {
        require('http').get({ host: '127.0.0.1', port, path: '/health' }, (res: any) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
      });

      it('accepts a push only with the session token of this employee', async () => {
        const { client } = await load();
        client.token = 'session-token';
        const handled = jest.spyOn(client, 'handlePushedEvent').mockImplementation(() => {});
        await client.startLocalServer();
        try {
          const port = client.localPort;
          expect(await post(port, {})).toBe(401);
          expect(await post(port, { 'X-Boss-Token': 'wrong-token!' })).toBe(401);
          expect(await post(port, { 'X-Boss-Token': 'session-token-longer' })).toBe(401);
          expect(handled).not.toHaveBeenCalled();
          expect(await post(port, { 'X-Boss-Token': 'session-token' })).toBe(200);
          expect(handled).toHaveBeenCalledWith('event:localPath', { zaloId: 'z1' });
          expect(await getHealth(port)).toBe(200);
          client.token = '';
          expect(await post(port, { 'X-Boss-Token': '' })).toBe(401);
        } finally {
          client.stopLocalServer();
        }
      });
    });
  });
});
