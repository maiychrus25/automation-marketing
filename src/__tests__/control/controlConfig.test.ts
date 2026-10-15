import type { NetworkInterfaceInfo } from 'os';
import { ControlConfigError, buildInstallCommand, buildPairingCode, detectPublicIpv4, parseStoredConfig, validateConfigInput, validatePublicHost } from '../../services/control/controlConfig';

const nic = (address: string, internal = false): NetworkInterfaceInfo =>
  ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '', cidr: null } as NetworkInterfaceInfo);

describe('detectPublicIpv4', () => {
  test.each(['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.5', '100.64.0.1', '100.127.1.1', '169.254.1.1', '127.0.0.1'])('skips %s', (ip) => {
    expect(detectPublicIpv4({ eth0: [nic(ip)] })).toBeNull();
  });
  test('skips internal and returns the first public address', () => {
    expect(detectPublicIpv4({ lo: [nic('8.8.8.8', true)], eth0: [nic('192.168.1.5')], eth1: [nic('203.0.113.7')] })).toBe('203.0.113.7');
  });
  test('172.32 and 100.128 are public', () => {
    expect(detectPublicIpv4({ a: [nic('172.32.0.1')] })).toBe('172.32.0.1');
    expect(detectPublicIpv4({ a: [nic('100.128.0.1')] })).toBe('100.128.0.1');
  });
  test('ignores IPv6 and undefined lists', () => {
    expect(detectPublicIpv4({ a: [{ ...nic('::1'), family: 'IPv6' } as NetworkInterfaceInfo], b: undefined })).toBeNull();
  });
});

describe('validatePublicHost', () => {
  test('accepts IPv4 and domains', () => {
    expect(validatePublicHost('203.0.113.7')).toBe('203.0.113.7');
    expect(validatePublicHost(' Example.COM ')).toBe('example.com');
  });
  test.each(['', 'a b', 'ex_ample.com', 'http://x.com', 'x.com:8080', 'a'.repeat(254)])('rejects %j', (h) => {
    expect(() => validatePublicHost(h)).toThrow(ControlConfigError);
  });
});

describe('pairing code and install command', () => {
  test('code decodes back to the JSON', () => {
    const code = buildPairingCode({ url: 'https://1.2.3.4:47321', fingerprint: 'ab12', ticket: 'T'.repeat(43), name: 'bot ơ' });
    expect(code.startsWith('mhp1.')).toBe(true);
    expect(code).not.toMatch(/[=+/']/);
    expect(JSON.parse(Buffer.from(code.slice(5), 'base64url').toString('utf8'))).toEqual({ u: 'https://1.2.3.4:47321', f: 'ab12', t: 'T'.repeat(43), n: 'bot ơ' });
  });
  test('install command matches spec 2.4', () => {
    expect(buildInstallCommand({ host: '1.2.3.4', port: 47321, sha256: 'abc', code: 'mhp1.xyz' })).toBe(
      "curl -fsSk https://1.2.3.4:47321/v1/bridge.py -o /root/maihub_bridge.py && echo \"abc  /root/maihub_bridge.py\" | sha256sum -c - && python3 -I /root/maihub_bridge.py pair 'mhp1.xyz' --install");
  });
});

describe('publicHost in config', () => {
  test('old stored JSON without publicHost parses to null', () => {
    const c = parseStoredConfig(JSON.stringify({ enabled: true, port: 47321, allowList: ['1.2.3.4'] }));
    expect(c.publicHost).toBeNull();
    expect(c.enabled).toBe(true);
  });
  test('stored publicHost is kept; invalid becomes null', () => {
    expect(parseStoredConfig(JSON.stringify({ port: 47321, allowList: [], publicHost: 'example.com' })).publicHost).toBe('example.com');
    expect(parseStoredConfig(JSON.stringify({ port: 47321, allowList: [], publicHost: 'bad host' })).publicHost).toBeNull();
    expect(parseStoredConfig(null).publicHost).toBeNull();
  });
  test('validateConfigInput: absent/empty -> null, otherwise validated', () => {
    expect(validateConfigInput({ port: 47321, allowList: '' }).publicHost).toBeNull();
    expect(validateConfigInput({ port: 47321, allowList: '', publicHost: '  ' }).publicHost).toBeNull();
    expect(validateConfigInput({ port: 47321, allowList: '', publicHost: '203.0.113.7' }).publicHost).toBe('203.0.113.7');
    expect(() => validateConfigInput({ port: 47321, allowList: '', publicHost: 'bad host' })).toThrow(ControlConfigError);
  });
});
