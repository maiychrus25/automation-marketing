import { startRelay, RelayHarness } from './relayHarness';

const login = (h: RelayHarness, username: string, password: string) =>
  fetch(`${h.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
const boot = (h: RelayHarness, token: string) => fetch(`${h.url}/api/boot`, { headers: { Authorization: `Bearer ${token}` } });

describe('relay login throttle and token revocation', () => {
  let h: RelayHarness;
  beforeEach(async () => {
    h = await startRelay({ employees: [{ id: 'emp-1', assigned: ['acc-a'], modules: ['chat'] }, { id: 'emp-2', assigned: [], modules: [] }], accounts: [] });
  });
  afterEach(async () => { await h.close(); });

  it('answers 429 on the 6th attempt even with the right password, across letter case', async () => {
    for (let i = 0; i < 5; i++) expect((await login(h, i % 2 ? 'USER-EMP-1' : 'user-emp-1', 'bad')).status).toBe(401);
    const locked = await login(h, 'user-emp-1', 'good');
    expect(locked.status).toBe(429);
    expect(await locked.json()).toEqual({ success: false, error: 'Đăng nhập sai quá nhiều lần. Hãy thử lại sau 15 phút.' });
    expect((await login(h, 'user-emp-2', 'good')).status).toBe(200);
  });

  it('a successful login resets the failure counter', async () => {
    for (let i = 0; i < 4; i++) await login(h, 'user-emp-1', 'bad');
    expect((await login(h, 'user-emp-1', 'good')).status).toBe(200);
    for (let i = 0; i < 4; i++) await login(h, 'user-emp-1', 'bad');
    expect((await login(h, 'user-emp-1', 'good')).status).toBe(200);
  });

  it('refuses the token of a kicked employee and disconnects the sockets', async () => {
    const token = h.tokenFor('emp-1');
    expect((await boot(h, token)).status).not.toBe(401);
    const { default: HttpRelayService } = await import('../../services/http/HttpRelayService');
    HttpRelayService.getInstance().kickEmployee('emp-1');
    expect((await boot(h, token)).status).toBe(401);
    expect(h.disconnected).toContain('emp-1');
    // a fresh login works again
    expect((await login(h, 'user-emp-1', 'good')).status).toBe(200);
    expect((await boot(h, h.tokenFor('emp-1'))).status).not.toBe(401);
  });

  it('refuses a registered employee who was disabled afterwards', async () => {
    const token = h.tokenFor('emp-1');
    expect((await login(h, 'user-emp-1', 'good')).status).toBe(200); // now registered in relay memory
    expect((await boot(h, token)).status).not.toBe(401);
    h.setInactive('emp-1');
    expect((await boot(h, token)).status).toBe(401);
  });
});
