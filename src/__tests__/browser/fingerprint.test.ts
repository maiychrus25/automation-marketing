import {
    buildLaunchArgs, generateFingerprint, hostPersona, isValidLanguage, isValidTimezone,
    HARDWARE_CONCURRENCY_CHOICES,
} from '../../services/browser/fingerprint';

describe('generateFingerprint', () => {
    it('produces values inside the allowed ranges with Vietnamese defaults', () => {
        for (let i = 0; i < 200; i++) {
            const fp = generateFingerprint();
            expect(Number.isInteger(fp.seed)).toBe(true);
            expect(fp.seed).toBeGreaterThanOrEqual(1);
            expect(fp.seed).toBeLessThanOrEqual(2147483647);
            expect(HARDWARE_CONCURRENCY_CHOICES).toContain(fp.hardwareConcurrency);
            expect(fp.language).toBe('vi-VN');
            expect(fp.timezone).toBe('Asia/Ho_Chi_Minh');
        }
    });

    it('stays in range at the extremes of the random source', () => {
        expect(generateFingerprint({}, () => 0).seed).toBe(1);
        const top = generateFingerprint({}, () => 0.9999999999);
        expect(top.seed).toBeLessThanOrEqual(2147483647);
        expect(top.hardwareConcurrency).toBe(16);
    });

    it('applies language and timezone overrides', () => {
        const fp = generateFingerprint({ language: 'en-US', timezone: 'America/New_York' });
        expect(fp.language).toBe('en-US');
        expect(fp.timezone).toBe('America/New_York');
    });
});

describe('hostPersona', () => {
    it('maps supported platforms and rejects the rest', () => {
        expect(hostPersona('win32')).toBe('windows');
        expect(hostPersona('linux')).toBe('linux');
        expect(hostPersona('darwin')).toBeNull();
    });
});

describe('validators', () => {
    it('accepts real timezones and rejects junk', () => {
        expect(isValidTimezone('Asia/Ho_Chi_Minh')).toBe(true);
        expect(isValidTimezone('Mars/Olympus')).toBe(false);
        expect(isValidTimezone('')).toBe(false);
    });
    it('accepts BCP-47 style language tags only', () => {
        expect(isValidLanguage('vi-VN')).toBe(true);
        expect(isValidLanguage('en')).toBe(true);
        expect(isValidLanguage('vi-VN --no-sandbox')).toBe(false);
        expect(isValidLanguage('')).toBe(false);
    });
});

describe('buildLaunchArgs', () => {
    const fingerprint = { seed: 1234, hardwareConcurrency: 8, language: 'vi-VN', timezone: 'Asia/Ho_Chi_Minh' };

    it('builds the full flag set without proxy', () => {
        expect(buildLaunchArgs({ userDataDir: '/data/p1', fingerprint, persona: 'linux', proxyPort: null })).toEqual([
            '--user-data-dir=/data/p1',
            '--fingerprint=1234',
            '--fingerprint-platform=linux',
            '--fingerprint-brand=Chrome',
            '--fingerprint-hardware-concurrency=8',
            '--lang=vi-VN',
            '--accept-lang=vi-VN,vi',
            '--timezone=Asia/Ho_Chi_Minh',
            '--no-first-run',
            '--no-default-browser-check',
        ]);
    });

    it('routes through the local forwarder and blocks non-proxied UDP when a proxy is set', () => {
        const args = buildLaunchArgs({ userDataDir: 'C:\\data\\p1', fingerprint, persona: 'windows', proxyPort: 45678 });
        expect(args).toContain('--fingerprint-platform=windows');
        expect(args).toContain('--proxy-server=http://127.0.0.1:45678');
        expect(args).toContain('--disable-non-proxied-udp');
    });

    it('never opens a remote debugging port', () => {
        const args = buildLaunchArgs({ userDataDir: '/d', fingerprint, persona: 'linux', proxyPort: 1 });
        expect(args.some((a) => a.startsWith('--remote-debugging'))).toBe(false);
    });

    it('does not duplicate a language that has no region', () => {
        const args = buildLaunchArgs({ userDataDir: '/d', fingerprint: { ...fingerprint, language: 'en' }, persona: 'linux', proxyPort: null });
        expect(args).toContain('--accept-lang=en');
    });

    it('adds --no-sandbox when noSandbox is set (Ubuntu userns chặn → thiếu cờ này chromium abort "No usable sandbox")', () => {
        const args = buildLaunchArgs({ userDataDir: '/d', fingerprint, persona: 'linux', proxyPort: null, noSandbox: true });
        expect(args).toContain('--no-sandbox');
    });

    it('omits --no-sandbox by default', () => {
        const args = buildLaunchArgs({ userDataDir: '/d', fingerprint, persona: 'linux', proxyPort: null });
        expect(args).not.toContain('--no-sandbox');
    });
});
