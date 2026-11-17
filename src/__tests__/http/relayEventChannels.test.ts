import * as fs from 'fs';
import * as path from 'path';
import { startRelay, RelayHarness } from './relayHarness';
import { FACEBOOK_RELAY_CHANNELS } from '../../services/socket/relayAudience';

describe('Facebook relay channel lists', () => {
  let h: RelayHarness;
  beforeAll(async () => { h = await startRelay({ employees: [], accounts: [] }); });
  afterAll(() => h.close());

  const readPreload = () => fs.readFileSync(path.join(__dirname, '../../../electron/preload.ts'), 'utf8');

  it('every Facebook relay channel is relayed by the boss and forwarded by the employee', async () => {
    const relayChannels: string[] = (await import('../../services/http/HttpRelayService')).default['RELAY_CHANNELS'];
    const forwardChannels: string[] = (await import('../../services/http/HttpClientService')).default['FORWARD_CHANNELS'];
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

  it('typing and presence are never relayed', async () => {
    const relayChannels: string[] = (await import('../../services/http/HttpRelayService')).default['RELAY_CHANNELS'];
    const forwardChannels: string[] = (await import('../../services/http/HttpClientService')).default['FORWARD_CHANNELS'];
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
});
