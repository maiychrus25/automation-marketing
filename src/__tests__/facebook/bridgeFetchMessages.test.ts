jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
import { FacebookE2EEBridge } from '../../services/facebook/FacebookE2EEBridge';

// Go's fetchMessages params declare threadId as a string: a JSON number fails to unmarshal in the bridge.
describe('FacebookE2EEBridge.fetchMessages', () => {
  const make = () => {
    const bridge = FacebookE2EEBridge.create('/fake/bridge');
    const call = jest.spyOn(bridge, 'call').mockResolvedValue({ threadId: '1', messages: [], hasMoreBefore: false, minTimestampMs: 0 });
    return { bridge, call };
  };

  test('sendsTheThreadIdAsAnExactString', async () => {
    const { bridge, call } = make();
    await bridge.fetchMessages({ threadId: '24512345678901234', beforeTimestampMs: 1_700_000_000_000, beforeMessageId: 'mid.$a' });
    const [method, params, timeout] = call.mock.calls[0];
    expect(method).toBe('fetchMessages');
    expect(typeof params.threadId).toBe('string');
    expect(params).toEqual({ threadId: '24512345678901234', beforeTimestampMs: 1_700_000_000_000, beforeMessageId: 'mid.$a', timeoutMs: 25_000 });
    expect(timeout).toBe(30_000);
  });

  test('stripsTheJidSuffix', async () => {
    const { bridge, call } = make();
    await bridge.fetchMessages({ threadId: '123456@msgr', beforeTimestampMs: 1, beforeMessageId: '' });
    expect(call.mock.calls[0][1].threadId).toBe('123456');
  });
});
