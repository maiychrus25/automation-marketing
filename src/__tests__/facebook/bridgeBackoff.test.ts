import { e2eeReconnectDelayMs } from '../../services/facebook/facebookBridgeBackoff';

describe('e2eeReconnectDelayMs', () => {
  test('doublesFromTenSecondsAndCapsAtFiveMinutes', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(e2eeReconnectDelayMs))
      .toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
    expect(e2eeReconnectDelayMs(1000)).toBe(300_000);
  });

  test('invalidAttemptFallsBackToBaseDelay', () => {
    for (const bad of [-1, NaN, Infinity, -Infinity, 1.5]) expect(e2eeReconnectDelayMs(bad)).toBe(10_000);
  });
});
