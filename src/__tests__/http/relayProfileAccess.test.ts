import { startRelay, RelayHarness } from './relayHarness';

describe('boss relay: browser profiles an employee may use', () => {
  let relay: RelayHarness;
  const snapshotOf = async (id: string) => {
    const res = await fetch(relay.url + '/api/sync/snapshot', { headers: { Authorization: `Bearer ${relay.tokenFor(id)}` } });
    return (await res.json() as any).snapshot;
  };

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    relay = await startRelay({
      employees: [
        { id: 'poster', assigned: [], modules: ['fb_poster'], profiles: ['p1', 'p2', 'deleted'] },
        { id: 'no-perm', assigned: [], modules: ['chat'], profiles: ['p1'] },
      ],
      browserProfiles: ['p1', 'p2', 'p3'],
      accounts: [],
    });
  });
  afterAll(() => relay.close());

  const allowed = async (id: string) => (await import('../../services/http/HttpRelayService')).default.getInstance().allowedProfilesFor(id);

  test('dropsProfilesThatNoLongerExist', async () => {
    expect(await allowed('poster')).toEqual(['p1', 'p2']);
  });

  test('isEmptyWithoutTheFbPosterPermission', async () => {
    expect(await allowed('no-perm')).toEqual([]);
  });

  test('theSnapshotCarriesTheSameList', async () => {
    expect((await snapshotOf('poster')).assigned_profiles).toEqual(['p1', 'p2']);
    expect((await snapshotOf('no-perm')).assigned_profiles).toEqual([]);
  });

  describe('relay:permissionUpdate', () => {
    const pushed = async (id: string, reason: string) => {
      await snapshotOf(id); // an authenticated call registers the employee in the relay
      const relayService: any = (await import('../../services/http/HttpRelayService')).default.getInstance();
      const spy = jest.spyOn(relayService, 'pushViaSSE').mockReturnValue(true);
      relayService.refreshEmployeeState(id, reason);
      const calls = spy.mock.calls.filter((c: any[]) => c[1] === 'relay:permissionUpdate');
      spy.mockRestore();
      return calls.map((c: any[]) => c[2]);
    };

    test('carriesTheAllowedProfilesOnAProfileAssignment', async () => {
      const payloads = await pushed('poster', 'profiles-assigned');
      expect(payloads).toHaveLength(1);
      expect(payloads[0].assigned_profiles).toEqual(['p1', 'p2']);
      expect(payloads[0].permissions).toBeDefined();
    });

    test('isEmptyWithoutTheFbPosterPermission', async () => {
      const payloads = await pushed('no-perm', 'permissions-updated');
      expect(payloads[0].assigned_profiles).toEqual([]);
    });

    test('otherRefreshesDoNotSendIt', async () => {
      expect(await pushed('poster', 'accounts-assigned')).toEqual([]);
    });
  });
});
