import { EventEmitter } from 'events';

jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
import Logger from '../../utils/Logger';
import {
  DEFAULT_SYNC_PC_NAME,
  attachSyncEventListener,
  extractSyncEvents,
  installMobileSyncApis,
} from '../../services/zalo/mobileSync/zcaMobileSync';

type Call = { url: string; options: any };

/** Giống zca-js 2.1.2: api.custom định nghĩa property không ghi đè được; encodeAES giả để đọc payload. */
function makeApi(responses: Array<(call: Call) => any> = []) {
  const calls: Call[] = [];
  const api: any = {
    zpwServiceMap: { file: ['https://file.test'], profile: ['https://profile.test'] },
    listener: Object.assign(new EventEmitter(), { ws: null as any, cipherKey: null as any }),
  };
  const ctx = { imei: 'imei-1' };
  const utils = {
    encodeAES: (s: string) => s,
    makeURL: (base: string, params?: Record<string, string>) =>
      params ? `${base}?params=${encodeURIComponent(params.params)}` : base,
    request: async (url: string, options: any) => {
      const call = { url, options };
      calls.push(call);
      const next = responses.shift();
      const value = next ? next(call) : null;
      return value && value.raw ? value.raw : { data: value };
    },
    resolve: async (res: any) => {
      if (res.data instanceof Error) throw res.data;
      return res.data;
    },
  };
  api.custom = (name: string, cb: any) => {
    Object.defineProperty(api, name, {
      value: (props: any) => cb({ ctx, utils, props }),
      writable: false, enumerable: false, configurable: false,
    });
  };
  return { api, calls, utils };
}

const payloadOf = (url: string) => JSON.parse(decodeURIComponent(url.split('?params=')[1]));
const fail = () => new Error('boom');

describe('installMobileSyncApis', () => {
  test('throws a clear error without api.custom', () => {
    expect(() => installMobileSyncApis({})).toThrow(/api\.custom/);
  });

  test('installing twice does not throw and returns working functions', async () => {
    const { api, calls } = makeApi();
    const first = installMobileSyncApis(api);
    expect(() => installMobileSyncApis(api)).not.toThrow();
    await first.cancelPullMobile({ public_key: 'k', pc_name: 'Web' });
    expect(calls).toHaveLength(1);
  });

  test('installs only the missing functions when pullMobile already exists', async () => {
    const { api, calls } = makeApi();
    Object.defineProperty(api, 'pullMobile', { value: async () => 'old', writable: false, configurable: false });
    let sync: any;
    expect(() => { sync = installMobileSyncApis(api); }).not.toThrow();
    expect(await sync.pullMobile({})).toBe('old');
    await sync.cancelPullMobile({ public_key: 'k', pc_name: 'Web' });
    await sync.getNoisedIds({ uids: [], gids: [] });
    expect(typeof sync.getNoisedIds).toBe('function');
    expect(calls).toHaveLength(1);
  });

  test('pullMobile calls the file domain with the full parameter set', async () => {
    const { api, calls } = makeApi();
    const sync = installMobileSyncApis(api);
    expect(DEFAULT_SYNC_PC_NAME).toBe('Web');
    await sync.pullMobile({ public_key: 'PK', pc_name: 'Web', from_seq_id: 7, min_seq_id: 3 });
    expect(calls[0].url.startsWith('https://file.test/api/message/pull_mobile_msg?')).toBe(true);
    expect(calls[0].options.method).toBe('GET');
    expect(payloadOf(calls[0].url)).toEqual({
      pc_name: 'Web', public_key: 'PK', from_seq_id: 7, is_retry: 0, min_seq_id: 3, temp_key: '', imei: 'imei-1',
    });
  });

  test('cancelPullMobile calls cancel_pull_mobile_msg', async () => {
    const { api, calls } = makeApi();
    await installMobileSyncApis(api).cancelPullMobile({ public_key: 'PK', pc_name: 'Web' });
    expect(calls[0].url.startsWith('https://file.test/api/message/cancel_pull_mobile_msg?')).toBe(true);
    expect(payloadOf(calls[0].url)).toEqual({ pc_name: 'Web', public_key: 'PK', imei: 'imei-1' });
  });

  test('empty-data responses with error_code 0 are accepted, others reject', async () => {
    const raw = (code: number) => () => ({
      raw: { data: new Error('empty'), clone: () => ({ json: async () => ({ error_code: code }) }) },
    });
    const ok = makeApi([raw(0)]);
    await expect(installMobileSyncApis(ok.api).cancelPullMobile({ public_key: 'k', pc_name: 'Web' })).resolves.toBeNull();
    const bad = makeApi([raw(5)]);
    await expect(installMobileSyncApis(bad.api).cancelPullMobile({ public_key: 'k', pc_name: 'Web' })).rejects.toThrow('empty');
  });

  describe('getNoisedIds', () => {
    test('sends numeric ids to the profile domain and aligns the result', async () => {
      const { api, calls } = makeApi([() => ({ fids: ['111', '0'], gids: ['g222'] })]);
      const res = await installMobileSyncApis(api).getNoisedIds({ uids: ['1', '2', '3'], gids: ['9'] });
      expect(calls[0].url.startsWith('https://profile.test/api/znoise?')).toBe(true);
      expect(payloadOf(calls[0].url)).toEqual({ fids: [1, 2, 3], gids: [9] });
      expect(res).toEqual({ uids: ['111', '', ''], gids: ['222'] });
    });

    test('parses a JSON string response', async () => {
      const { api } = makeApi([() => JSON.stringify({ fids: ['5'] })]);
      const res = await installMobileSyncApis(api).getNoisedIds({ uids: ['1'], gids: [] });
      expect(res).toEqual({ uids: ['5'], gids: [] });
    });

    test('falls back to zwid via POST when the profile host fails', async () => {
      const { api, calls } = makeApi([fail, () => ({ fids: ['7'] })]);
      const res = await installMobileSyncApis(api).getNoisedIds({ uids: ['1'], gids: [] });
      expect(calls[1].url).toBe('https://zwid.api.zalo.me/api/znoise');
      expect(calls[1].options.method).toBe('POST');
      expect(new URLSearchParams(calls[1].options.body).get('params')).toBeTruthy();
      expect(res.uids).toEqual(['7']);
    });

    test('rejects when both hosts fail', async () => {
      const { api } = makeApi([fail, fail]);
      await expect(installMobileSyncApis(api).getNoisedIds({ uids: ['1'], gids: [] })).rejects.toThrow('boom');
    });

    test('encodeAES returning empty rejects without sending a request', async () => {
      const { api, calls, utils } = makeApi();
      utils.encodeAES = () => null as any;
      await expect(installMobileSyncApis(api).getNoisedIds({ uids: ['1'], gids: [] })).rejects.toThrow(/getNoisedIds/);
      expect(calls).toHaveLength(0);
    });

    test('no ids -> no request', async () => {
      const { api, calls } = makeApi();
      expect(await installMobileSyncApis(api).getNoisedIds({ uids: [], gids: [] })).toEqual({ uids: [], gids: [] });
      expect(calls).toHaveLength(0);
    });
  });
});

function frame(cmd: number, body: unknown, version = 1): Buffer {
  const text = typeof body === 'string' ? body : JSON.stringify({ data: JSON.stringify(body), encrypt: 0 });
  return Buffer.concat([Buffer.from([version, cmd & 0xff, cmd >> 8, 0]), Buffer.from(text)]);
}
const control = (content: any) => ({ data: { controls: [{ content }] } });

describe('extractSyncEvents', () => {
  test('reads syncmsgmb controls, parsing string data', () => {
    const events = extractSyncEvents(frame(601, control({
      act_type: 'syncmsgmb', act: 'user_confirm', data: JSON.stringify({ user_action: 1, public_key: 'PK', pc_name: 'Web' }),
    })), null);
    expect(events).toEqual([{ type: 'user_confirm', data: { user_action: 1, public_key: 'PK', pc_name: 'Web' } }]);
  });

  test('object data and other acts pass through', () => {
    const events = extractSyncEvents(frame(601, control({ act_type: 'syncmsgmb', act: 'transfer_error', data: { status: 1 } })), null);
    expect(events).toEqual([{ type: 'transfer_error', data: { status: 1 } }]);
  });

  test('other act_type, other cmd, short frames give [] silently', () => {
    (Logger.warn as jest.Mock).mockClear();
    expect(extractSyncEvents(frame(601, control({ act_type: 'other', act: 'x', data: {} })), null)).toEqual([]);
    expect(extractSyncEvents(frame(504, '{"data": not json'), null)).toEqual([]);
    expect(extractSyncEvents(Buffer.from([1, 89]), null)).toEqual([]);
    expect(Logger.warn).not.toHaveBeenCalled();
  });

  test('corrupt cmd-601 frame returns [] and logs the error name once, never the content', () => {
    (Logger.warn as jest.Mock).mockClear();
    const secret = 'SECRET-FRAME-CONTENT';
    expect(extractSyncEvents(frame(601, `{"data": ${secret}`), null)).toEqual([]);
    expect(Logger.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify((Logger.warn as jest.Mock).mock.calls);
    expect(logged).toContain('SyntaxError');
    expect(logged).not.toContain(secret);
  });
});

describe('attachSyncEventListener', () => {
  const good = frame(601, control({ act_type: 'syncmsgmb', act: 'syncmsg_info', data: { uid: 1 } }));

  test('receives events, rebinds on connected, detaches cleanly, survives bad frames', () => {
    const { api } = makeApi();
    const ws1: any = new EventEmitter();
    api.listener.ws = ws1;
    const got: any[] = [];
    const detach = attachSyncEventListener(api, (e) => got.push(e));

    ws1.emit('message', good);
    expect(got).toHaveLength(1);

    ws1.emit('message', frame(601, '{"data": not json'));
    ws1.emit('message', good);
    expect(got).toHaveLength(2);

    const ws2: any = new EventEmitter();
    api.listener.ws = ws2;
    api.listener.emit('connected');
    expect(ws1.listenerCount('message')).toBe(0);
    ws2.emit('message', good);
    expect(got).toHaveLength(3);

    detach();
    expect(ws2.listenerCount('message')).toBe(0);
    expect(api.listener.listenerCount('connected')).toBe(0);
  });

  test('a throwing handler is logged by name only and the next frame is still delivered', () => {
    (Logger.warn as jest.Mock).mockClear();
    const { api } = makeApi();
    const ws: any = new EventEmitter();
    api.listener.ws = ws;
    const secret = 'SECRET-FRAME-CONTENT';
    const secretFrame = frame(601, control({ act_type: 'syncmsgmb', act: 'syncmsg_info', data: { note: secret } }));
    let calls = 0;
    attachSyncEventListener(api, () => { if (calls++ === 0) throw new Error(secret); });
    ws.emit('message', secretFrame);
    expect(Logger.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify((Logger.warn as jest.Mock).mock.calls);
    expect(logged).toContain('Error');
    expect(logged).not.toContain(secret);
    ws.emit('message', secretFrame);
    expect(calls).toBe(2);
  });

  test('null ws between reconnects is tolerated', () => {
    const { api } = makeApi();
    const detach = attachSyncEventListener(api, () => {});
    api.listener.emit('connected');
    detach();
  });
});
