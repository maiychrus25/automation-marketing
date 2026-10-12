import { PROBE_TIMEOUT_MS, ProbeResult, SandboxProbeDeps, SandboxSupport, probeSandbox, runProcess } from '../../services/browser/sandboxSupport';

const ENGINE = '/opt/engine/chrome';
const USERNS_APPARMOR = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';
const USERNS_CLONE = '/proc/sys/kernel/unprivileged_userns_clone';
const USERNS_MAX = '/proc/sys/user/max_user_namespaces';

type FakeDeps = SandboxProbeDeps & { runs: Array<{ executable: string; args: string[]; timeoutMs: number }>; removed: string[]; made: string[] };

function makeDeps(opts: { platform?: NodeJS.Platform; result?: ProbeResult | Error; results?: ProbeResult[]; sysctl?: Record<string, string> } = {}): FakeDeps {
    const deps: FakeDeps = {
        runs: [], removed: [], made: [],
        platform: opts.platform ?? 'linux',
        run: async (executable, args, timeoutMs) => {
            deps.runs.push({ executable, args, timeoutMs });
            const result = opts.results?.[deps.runs.length - 1] ?? opts.result ?? { code: 0, stderr: '', timedOut: false };
            if (result instanceof Error) throw result;
            return result;
        },
        readSysctl: (p) => (opts.sysctl && p in opts.sysctl ? opts.sysctl[p] : null),
        makeTempDir: (parent) => { const dir = `${parent}/.sandbox-probe-x`; deps.made.push(dir); return dir; },
        removeDir: (dir) => { deps.removed.push(dir); },
    };
    return deps;
}

const TIMED_OUT: ProbeResult = { code: null, stderr: '', timedOut: true };

describe('probeSandbox', () => {
    it.each(['win32', 'darwin'] as NodeJS.Platform[])('returns enabled without probing on %s', async (platform) => {
        const deps = makeDeps({ platform });
        expect(await probeSandbox(ENGINE, deps)).toBe('enabled');
        expect(deps.runs).toHaveLength(0);
        expect(deps.made).toHaveLength(0);
    });

    it('enabled when the probe exits 0, without --no-sandbox', async () => {
        const deps = makeDeps();
        expect(await probeSandbox(ENGINE, deps)).toBe('enabled');
        expect(deps.runs[0].executable).toBe(ENGINE);
        expect(deps.runs[0].timeoutMs).toBe(PROBE_TIMEOUT_MS);
        expect(deps.runs[0].args).toEqual([
            '--headless=new', '--no-first-run', '--no-default-browser-check',
            '--user-data-dir=/opt/engine/.sandbox-probe-x', '--dump-dom', 'about:blank',
        ]);
        expect(deps.runs[0].args).not.toContain('--no-sandbox');
    });

    it('disabled on "No usable sandbox"', async () => {
        const deps = makeDeps({ result: { code: 1, stderr: 'FATAL: No usable sandbox! Update your kernel', timedOut: false } });
        expect(await probeSandbox(ENGINE, deps)).toBe('disabled');
    });

    it.each([
        [{ [USERNS_APPARMOR]: '1' }, 'disabled'],
        [{ [USERNS_CLONE]: '0' }, 'disabled'],
        [{ [USERNS_MAX]: '0' }, 'disabled'],
        [{ [USERNS_APPARMOR]: '0', [USERNS_CLONE]: '1', [USERNS_MAX]: '1000' }, 'enabled'],
        [{}, 'enabled'],
    ])('times out and falls back to sysctl %j -> %s', async (sysctl, expected) => {
        const deps = makeDeps({ result: TIMED_OUT, sysctl });
        expect(await probeSandbox(ENGINE, deps)).toBe(expected);
    });

    it('non-zero exit without the sandbox message falls back to sysctl', async () => {
        const deps = makeDeps({ result: { code: 1, stderr: 'other', timedOut: false }, sysctl: { [USERNS_MAX]: '0' } });
        expect(await probeSandbox(ENGINE, deps)).toBe('disabled');
    });

    it('non-zero first run but zero with --no-sandbox -> disabled, both temp dirs removed', async () => {
        const deps = makeDeps({ results: [
            { code: 1, stderr: 'Running as root without --no-sandbox is not supported', timedOut: false },
            { code: 0, stderr: '', timedOut: false },
        ] });
        expect(await probeSandbox(ENGINE, deps)).toBe('disabled');
        expect(deps.runs).toHaveLength(2);
        expect(deps.runs[0].args).not.toContain('--no-sandbox');
        expect(deps.runs[1].args).toContain('--no-sandbox');
        expect(deps.made).toHaveLength(2);
        expect(deps.removed).toEqual(deps.made);
    });

    it('non-zero both runs -> sysctl decides, both temp dirs removed', async () => {
        const fail: ProbeResult = { code: 1, stderr: 'other', timedOut: false };
        const blocked = makeDeps({ results: [fail, fail], sysctl: { [USERNS_MAX]: '0' } });
        expect(await probeSandbox(ENGINE, blocked)).toBe('disabled');
        expect(blocked.removed).toEqual(blocked.made);
        expect(blocked.made).toHaveLength(2);
        expect(await probeSandbox(ENGINE, makeDeps({ results: [fail, fail] }))).toBe('enabled');
    });

    it('timeout or throwing run never triggers a second run', async () => {
        const timedOut = makeDeps({ result: TIMED_OUT });
        await probeSandbox(ENGINE, timedOut);
        expect(timedOut.runs).toHaveLength(1);
        const thrown = makeDeps({ result: new Error('x') });
        await probeSandbox(ENGINE, thrown);
        expect(thrown.runs).toHaveLength(1);
    });

    it('run throwing falls back to sysctl', async () => {
        expect(await probeSandbox(ENGINE, makeDeps({ result: new Error('spawn fail'), sysctl: { [USERNS_CLONE]: '0' } }))).toBe('disabled');
        expect(await probeSandbox(ENGINE, makeDeps({ result: new Error('spawn fail') }))).toBe('enabled');
    });

    it('always removes the temp dir, even when run throws', async () => {
        const ok = makeDeps();
        await probeSandbox(ENGINE, ok);
        expect(ok.removed).toEqual(ok.made);
        const bad = makeDeps({ result: new Error('boom') });
        await probeSandbox(ENGINE, bad);
        expect(bad.removed).toEqual(bad.made);
        expect(bad.removed).toHaveLength(1);
    });
});

describe('probeSandbox resilience', () => {
    it('makeTempDir throwing falls back to sysctl and removes nothing', async () => {
        const deps = makeDeps({ sysctl: { [USERNS_MAX]: '0' } });
        deps.makeTempDir = () => { throw new Error('EACCES'); };
        expect(await probeSandbox(ENGINE, deps)).toBe('disabled');
        expect(deps.runs).toHaveLength(0);
        expect(deps.removed).toHaveLength(0);
    });
});

describe('runProcess', () => {
    it('captures exit code and stderr', async () => {
        const result = await runProcess(process.execPath, ['-e', "process.stderr.write('No usable sandbox'); process.exit(3)"], 5000);
        expect(result.code).toBe(3);
        expect(result.timedOut).toBe(false);
        expect(result.stderr).toContain('No usable sandbox');
    });

    it('times out quickly and kills the process', async () => {
        const started = Date.now();
        const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], 300);
        expect(result).toEqual({ code: null, stderr: '', timedOut: true });
        expect(Date.now() - started).toBeLessThan(1500);
    });

    it('rejects for a missing executable', async () => {
        await expect(runProcess('/nonexistent/engine-binary', [], 1000)).rejects.toThrow();
    });
});

describe('SandboxSupport', () => {
    it('does not cache a rejected probe', async () => {
        const deps = makeDeps();
        let calls = 0;
        deps.makeTempDir = () => { calls++; return '/x'; };
        deps.platform = 'linux';
        let fail = true;
        deps.readSysctl = () => { if (fail) throw new Error('boom'); return null; };
        deps.run = async () => ({ code: 1, stderr: '', timedOut: false });
        const support = new SandboxSupport(deps);
        await expect(support.get(ENGINE)).rejects.toThrow('boom');
        fail = false;
        expect(await support.get(ENGINE)).toBe('enabled');
        expect(calls).toBe(4); // two temp dirs per probe (plain + --no-sandbox)
    });

    it('caches per engine path', async () => {
        const deps = makeDeps();
        const support = new SandboxSupport(deps);
        const [a, b] = await Promise.all([support.get(ENGINE), support.get(ENGINE)]);
        expect([a, b]).toEqual(['enabled', 'enabled']);
        await support.get(ENGINE);
        expect(deps.runs).toHaveLength(1);
        await support.get('/other/chrome');
        expect(deps.runs).toHaveLength(2);
    });

    it('recheck probes again', async () => {
        const deps = makeDeps();
        const support = new SandboxSupport(deps);
        await support.get(ENGINE);
        await support.recheck(ENGINE);
        expect(deps.runs).toHaveLength(2);
        await support.get(ENGINE);
        expect(deps.runs).toHaveLength(2);
    });
});
