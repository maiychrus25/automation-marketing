import { parseBotIp } from '../../services/control/controlConfig';

describe('parseBotIp', () => {
    test('accepts a single IPv4', () => expect(parseBotIp(' 203.0.113.7 ')).toBe('203.0.113.7'));
    test.each(['', '10.0.0.0/8', '1.2.3.4, 5.6.7.8', '::1', 'abc', '1.2.3'])('rejects %p', (v) => {
        expect(() => parseBotIp(v)).toThrow();
    });
    test('rejects non-string', () => expect(() => parseBotIp(undefined)).toThrow());
});
