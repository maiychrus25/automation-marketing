import type { BrowserFingerprint } from '../../models/browserProfile';

export const HARDWARE_CONCURRENCY_CHOICES = [4, 8, 12, 16];
export const DEFAULT_LANGUAGE = 'vi-VN';
export const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';
const MAX_SEED = 2147483647;

export type Persona = 'windows' | 'linux';

/** The persona always matches the host OS: the spike showed host fonts leak when they differ. */
export function hostPersona(platform: NodeJS.Platform): Persona | null {
    if (platform === 'win32') return 'windows';
    if (platform === 'linux') return 'linux';
    return null;
}

export function isValidTimezone(timezone: string): boolean {
    if (!timezone || typeof timezone !== 'string') return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
        return true;
    } catch {
        return false;
    }
}

export function isValidLanguage(language: string): boolean {
    return typeof language === 'string' && /^[a-z]{2,3}(-[A-Z]{2})?$/.test(language);
}

export function generateFingerprint(
    overrides: Partial<Pick<BrowserFingerprint, 'language' | 'timezone'>> = {},
    random: () => number = Math.random,
): BrowserFingerprint {
    return {
        seed: 1 + Math.floor(random() * (MAX_SEED - 1)),
        hardwareConcurrency: HARDWARE_CONCURRENCY_CHOICES[Math.floor(random() * HARDWARE_CONCURRENCY_CHOICES.length)],
        language: overrides.language || DEFAULT_LANGUAGE,
        timezone: overrides.timezone || DEFAULT_TIMEZONE,
    };
}

export interface LaunchOptions {
    userDataDir: string;
    fingerprint: BrowserFingerprint;
    persona: Persona;
    /** Port of the local ProxyForwarder, or null when the profile has no proxy. */
    proxyPort: number | null;
    /**
     * Tắt sandbox của Chromium. Cần trên Linux đã chặn unprivileged user
     * namespaces (Ubuntu 23.10+/AppArmor): không có cờ này chromium abort ngay
     * với "FATAL: No usable sandbox" nên profile không mở được. Host quyết định
     * (persona có thể bị giả lập nên không dùng để suy ra OS thật).
     */
    noSandbox?: boolean;
}

export function buildLaunchArgs(options: LaunchOptions): string[] {
    const { userDataDir, fingerprint, persona, proxyPort } = options;
    const baseLanguage = fingerprint.language.split('-')[0];
    const acceptLanguage = baseLanguage === fingerprint.language ? fingerprint.language : `${fingerprint.language},${baseLanguage}`;
    const args = [
        `--user-data-dir=${userDataDir}`,
        `--fingerprint=${fingerprint.seed}`,
        `--fingerprint-platform=${persona}`,
        '--fingerprint-brand=Chrome',
        `--fingerprint-hardware-concurrency=${fingerprint.hardwareConcurrency}`,
        `--lang=${fingerprint.language}`,
        `--accept-lang=${acceptLanguage}`,
        `--timezone=${fingerprint.timezone}`,
        '--no-first-run',
        '--no-default-browser-check',
    ];
    if (options.noSandbox) args.push('--no-sandbox');
    if (proxyPort !== null) {
        args.push(`--proxy-server=http://127.0.0.1:${proxyPort}`, '--disable-non-proxied-udp');
    }
    return args;
}
