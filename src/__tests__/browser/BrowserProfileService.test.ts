import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    BrowserProcess, BrowserProfileService, BrowserProfileServiceDeps, FORCE_KILL_DELAY_MS, MAX_RUNNING_PROFILES,
} from '../../services/browser/BrowserProfileService';
import type { BrowserProfile } from '../../models/browserProfile';
import type { ProxyConfig } from '../../models/proxy';

class FakeChild extends EventEmitter implements BrowserProcess {
    pid = 4242;
    signals: Array<NodeJS.Signals | number | undefined> = [];
    kill(signal?: NodeJS.Signals | number): boolean { this.signals.push(signal); return true; }
}

function makeProfile(id: string, proxyId: number | null = null): BrowserProfile {
    return {
        id, name: `Profile ${id}`, group_id: null, proxy_id: proxyId, note: '',
        fingerprint: { seed: 7, hardwareConcurrency: 8, language: 'vi-VN', timezone: 'Asia/Ho_Chi_Minh' },
        last_opened_at: null, created_at: 0, updated_at: 0,
    };
}

const PROXY: ProxyConfig = { id: 5, name: 'p', type: 'http', host: '10.0.0.1', port: 8080, username: 'u', password: 'p' };

interface Harness {
    service: BrowserProfileService;
    children: FakeChild[];
    spawned: Array<{ executable: string; args: string[] }>;
    forwarders: Array<{ started: boolean; stopped: boolean }>;
    terminated: Array<{ child: BrowserProcess; force: boolean }>;
    touched: string[];
    statuses: string[][];
    profilesDir: string;
}

function makeHarness(options: {
    profiles?: BrowserProfile[];
    proxies?: ProxyConfig[];
    executable?: string | null;
    platform?: NodeJS.Platform;
    spawnFails?: boolean;
    forwarderFails?: boolean;
    useDefaultTerminate?: boolean;
    launchAutomation?: BrowserProfileServiceDeps['launchAutomation'];
    resolveSandbox?: BrowserProfileServiceDeps['resolveSandbox'];
    getProfilesDir?: () => string;
} = {}): Harness {
    const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-test-'));
    const harness: Harness = {
        service: null as any, children: [], spawned: [], forwarders: [], terminated: [], touched: [], statuses: [], profilesDir,
    };
    const profiles = options.profiles || [makeProfile('a'), makeProfile('b')];
    const deps: BrowserProfileServiceDeps = {
        store: {
            getBrowserProfileById: (id) => profiles.find((p) => p.id === id) || null,
            getProxyById: (id) => (options.proxies || [PROXY]).find((p) => p.id === id) || null,
            touchBrowserProfileOpened: (id) => { harness.touched.push(id); },
        },
        getExecutablePath: () => (options.executable === undefined ? '/engine/chrome' : options.executable),
        getProfilesDir: options.getProfilesDir || (() => profilesDir),
        platform: options.platform || 'linux',
        spawnBrowser: (executable, args) => {
            const child = new FakeChild();
            harness.children.push(child);
            harness.spawned.push({ executable, args });
            setImmediate(() => (options.spawnFails ? child.emit('error', new Error('ENOENT')) : child.emit('spawn')));
            return child;
        },
        createForwarder: () => {
            const record = { started: false, stopped: false };
            harness.forwarders.push(record);
            return {
                start: async () => {
                    if (options.forwarderFails) throw new Error('EADDRINUSE');
                    record.started = true;
                    return 34567;
                },
                stop: async () => { record.stopped = true; },
            };
        },
        terminate: options.useDefaultTerminate ? undefined : (child, force) => { harness.terminated.push({ child, force }); },
        onStatusChanged: (ids) => { harness.statuses.push(ids); },
        launchAutomation: options.launchAutomation,
        resolveSandbox: options.resolveSandbox,
    };
    harness.service = new BrowserProfileService(deps);
    return harness;
}

describe('BrowserProfileService', () => {
    const harnesses: Harness[] = [];
    const create = (options?: Parameters<typeof makeHarness>[0]) => {
        const harness = makeHarness(options);
        harnesses.push(harness);
        return harness;
    };
    afterEach(() => {
        jest.useRealTimers();
        while (harnesses.length) fs.rmSync(harnesses.pop()!.profilesDir, { recursive: true, force: true });
    });

    it('keeps native ownership until the proxy forwarder has finished closing', async () => {
        let finish!: () => void;
        const stopping = new Promise<void>(resolve => { finish = resolve; });
        const child = new FakeChild();
        const service = new BrowserProfileService({
            store: { getBrowserProfileById: () => makeProfile('a', 5), getProxyById: () => PROXY, touchBrowserProfileOpened: () => {} },
            getExecutablePath: () => '/engine/chrome', getProfilesDir: () => create().profilesDir,
            platform: 'linux', spawnBrowser: () => { setImmediate(() => child.emit('spawn')); return child; },
            createForwarder: () => ({ start: async () => 1234, stop: () => stopping }),
            terminate: () => {},
        });
        await service.open('a');
        service.closeAll();
        child.emit('exit');
        expect(service.isIdle()).toBe(false);
        expect(service.canReserveAutomation('a')).toBe(false);
        finish();
        await new Promise(resolve => setImmediate(resolve));
        expect(service.isIdle()).toBe(true);
    });

    it('retries a rejected automation close without releasing ownership before confirmation', async () => {
        const close = jest.fn().mockRejectedValueOnce(new Error('still open')).mockResolvedValueOnce(undefined);
        const h = create({ launchAutomation: async () => ({ on: () => undefined, close } as any) });
        const token = h.service.tryReserveAutomation('a')!;
        await h.service.openForAutomation('a', token);
        h.service.closeAll();
        await new Promise(resolve => setImmediate(resolve));
        expect(h.service.isIdle()).toBe(false);
        expect(h.service.tryReserveAutomation('a')).toBeNull();
        h.service.closeAll();
        await new Promise(resolve => setImmediate(resolve));
        expect(h.service.isIdle()).toBe(true);
        expect(close).toHaveBeenCalledTimes(2);
    });

    it('opens a profile without proxy: spawns the engine with the profile data dir and marks it running', async () => {
        const h = create();
        await h.service.open('a');
        expect(h.spawned).toHaveLength(1);
        expect(h.spawned[0].executable).toBe('/engine/chrome');
        expect(h.spawned[0].args).toContain(`--user-data-dir=${path.join(h.profilesDir, 'a')}`);
        expect(h.spawned[0].args).toContain('--fingerprint=7');
        expect(h.spawned[0].args.some((a) => a.startsWith('--proxy-server'))).toBe(false);
        expect(fs.existsSync(path.join(h.profilesDir, 'a'))).toBe(true);
        expect(h.forwarders).toHaveLength(0);
        expect(h.service.getRunningIds()).toEqual(['a']);
        expect(h.touched).toEqual(['a']);
        expect(h.statuses).toEqual([['a']]);
    });

    it('passes --no-sandbox only when the sandbox is disabled', async () => {
        const asked: string[] = [];
        const make = (state: 'enabled' | 'disabled') => create({
            platform: 'linux',
            resolveSandbox: async (exe) => { asked.push(exe); return state; },
            launchAutomation: async (_exe, _dir, args) => { launched.push(args); return { on: () => undefined, close: async () => undefined } as any; },
        });
        const launched: string[][] = [];

        const enabled = make('enabled');
        await enabled.service.open('a');
        expect(enabled.spawned[0].args).not.toContain('--no-sandbox');
        await enabled.service.openForAutomation('b');
        expect(launched[0]).not.toContain('--no-sandbox');

        const disabled = make('disabled');
        await disabled.service.open('a');
        expect(disabled.spawned[0].args).toContain('--no-sandbox');
        await disabled.service.openForAutomation('b');
        expect(launched[1]).toContain('--no-sandbox');

        expect(asked).toEqual(['/engine/chrome', '/engine/chrome', '/engine/chrome', '/engine/chrome']);
    });

    it('does not spawn when the profile is closed while the sandbox check is running', async () => {
        let release: (state: 'enabled') => void = () => undefined;
        const h = create({ resolveSandbox: () => new Promise((resolve) => { release = resolve; }) });
        const opening = h.service.open('a');
        h.service.closeAll();
        release('enabled');
        await expect(opening).rejects.toThrow('Đã hủy mở trình duyệt');
        expect(h.spawned).toHaveLength(0);
    });

    it('opens a profile with proxy through a local forwarder', async () => {
        const h = create({ profiles: [makeProfile('a', 5)] });
        await h.service.open('a');
        expect(h.forwarders).toEqual([{ started: true, stopped: false }]);
        expect(h.spawned[0].args).toContain('--proxy-server=http://127.0.0.1:34567');
        expect(h.spawned[0].args).toContain('--disable-non-proxied-udp');
    });

    it('refuses to open a profile whose proxy was deleted instead of going direct', async () => {
        const h = create({ profiles: [makeProfile('a', 99)] });
        await expect(h.service.open('a')).rejects.toThrow('Proxy của profile không còn tồn tại');
        expect(h.spawned).toHaveLength(0);
        expect(h.service.getRunningIds()).toEqual([]);
    });

    it('rejects a second open of the same profile, even while the first is still starting', async () => {
        const h = create({ profiles: [makeProfile('a', 5)] });
        const first = h.service.open('a');
        await expect(h.service.open('a')).rejects.toThrow('Profile đang mở');
        await first;
        await expect(h.service.open('a')).rejects.toThrow('Profile đang mở');
        expect(h.spawned).toHaveLength(1);
    });

    it(`refuses to open more than ${MAX_RUNNING_PROFILES} profiles`, async () => {
        const profiles = Array.from({ length: MAX_RUNNING_PROFILES + 1 }, (_, i) => makeProfile(`p${i}`));
        const h = create({ profiles });
        for (let i = 0; i < MAX_RUNNING_PROFILES; i++) await h.service.open(`p${i}`);
        await expect(h.service.open(`p${MAX_RUNNING_PROFILES}`)).rejects.toThrow('giới hạn 30');
        expect(h.service.getRunningIds()).toHaveLength(MAX_RUNNING_PROFILES);
    });

    it('reports missing engine, unknown profile and unsupported platform', async () => {
        await expect(create({ executable: null }).service.open('a')).rejects.toThrow('Chưa cài trình duyệt');
        await expect(create().service.open('missing')).rejects.toThrow('Không tìm thấy profile');
        await expect(create({ platform: 'darwin' }).service.open('a')).rejects.toThrow('chưa được hỗ trợ');
    });

    it('cleans up the forwarder and the slot when the browser fails to start', async () => {
        const h = create({ profiles: [makeProfile('a', 5)], spawnFails: true });
        await expect(h.service.open('a')).rejects.toThrow('Không mở được trình duyệt: ENOENT');
        expect(h.forwarders).toEqual([{ started: true, stopped: true }]);
        expect(h.service.getRunningIds()).toEqual([]);
        expect(h.touched).toEqual([]);
    });

    it('frees the slot when the forwarder cannot start', async () => {
        const h = create({ profiles: [makeProfile('a', 5)], forwarderFails: true });
        await expect(h.service.open('a')).rejects.toThrow('EADDRINUSE');
        expect(h.spawned).toHaveLength(0);
        expect(h.service.isRunning('a')).toBe(false);
    });

    it('releases the profile and stops the forwarder when the browser window is closed', async () => {
        const h = create({ profiles: [makeProfile('a', 5)] });
        await h.service.open('a');
        h.children[0].emit('exit', 0);
        expect(await h.service.waitUntilIdle(1000)).toBe(true);
        expect(h.service.getRunningIds()).toEqual([]);
        expect(h.forwarders[0].stopped).toBe(true);
        expect(h.statuses).toEqual([['a'], []]);
        await h.service.open('a');
        expect(h.service.getRunningIds()).toEqual(['a']);
    });

    it('close() asks for a graceful exit first and force-kills only if the browser is still alive', async () => {
        const h = create();
        await h.service.open('a');
        jest.useFakeTimers();
        h.service.close('a');
        expect(h.terminated).toEqual([{ child: h.children[0], force: false }]);
        expect(h.service.isRunning('a')).toBe(true);
        jest.advanceTimersByTime(FORCE_KILL_DELAY_MS);
        expect(h.terminated).toEqual([{ child: h.children[0], force: false }, { child: h.children[0], force: true }]);
    });

    it('close() does not force-kill a browser that exited in time', async () => {
        const h = create();
        await h.service.open('a');
        jest.useFakeTimers();
        h.service.close('a');
        h.children[0].emit('exit', 0);
        jest.advanceTimersByTime(FORCE_KILL_DELAY_MS);
        expect(h.terminated).toHaveLength(1);
    });

    it('close() on a profile that is not running does nothing', () => {
        const h = create();
        h.service.close('a');
        expect(h.terminated).toEqual([]);
    });

    it('closeAll() terminates every browser gracefully and retains state until confirmed exit', async () => {
        const h = create({ profiles: [makeProfile('a', 5), makeProfile('b')] });
        await h.service.open('a');
        await h.service.open('b');
        h.service.closeAll();
        expect(h.terminated.map((t) => t.force)).toEqual([false, false]);
        expect(h.service.getRunningIds()).toEqual(['a', 'b']);
        expect(h.forwarders[0].stopped).toBe(false);
        h.children.forEach(child => child.emit('exit', 0));
        expect(await h.service.waitUntilIdle(1000)).toBe(true);
        expect(h.service.getRunningIds()).toEqual([]);
        expect(h.forwarders[0].stopped).toBe(true);
    });

    it('closeAll() while open() waits for the forwarder: open() is cancelled, nothing is spawned or recorded', async () => {
        const h = create({ profiles: [makeProfile('a', 5)] });
        const opening = h.service.open('a');
        h.service.closeAll();
        await expect(opening).rejects.toThrow('Đã hủy mở trình duyệt');
        expect(h.spawned).toHaveLength(0);
        expect(h.forwarders[0].stopped).toBe(true);
        expect(h.service.isRunning('a')).toBe(false);
        expect(h.touched).toEqual([]);
        expect(h.statuses.every((ids) => ids.length === 0)).toBe(true);
    });

    it('closeAll() while the browser is spawning: the browser is force-terminated and open() is cancelled', async () => {
        const h = create({ profiles: [makeProfile('a', 5)] });
        const opening = h.service.open('a');
        await new Promise((resolve) => setImmediate(resolve)); // forwarder started, spawn event still pending
        expect(h.spawned).toHaveLength(1);
        h.service.closeAll();
        await expect(opening).rejects.toThrow('Đã hủy mở trình duyệt');
        expect(h.terminated).toEqual([{ child: h.children[0], force: true }]);
        expect(h.service.isRunning('a')).toBe(true);
        expect(h.forwarders[0].stopped).toBe(false);
        h.children[0].emit('exit', 0);
        expect(await h.service.waitUntilIdle(1000)).toBe(true);
        expect(h.forwarders[0].stopped).toBe(true);
        expect(h.service.isRunning('a')).toBe(false);
        expect(h.touched).toEqual([]);
    });

    it('close() while the browser is starting closes it as soon as it has spawned, then force-kills if it lingers', async () => {
        const h = create();
        jest.useFakeTimers({ doNotFake: ['setImmediate'] });
        const opening = h.service.open('a');
        h.service.close('a');
        expect(h.terminated).toEqual([]);
        await opening;
        expect(h.terminated).toEqual([{ child: h.children[0], force: false }]);
        jest.advanceTimersByTime(FORCE_KILL_DELAY_MS);
        expect(h.terminated).toEqual([{ child: h.children[0], force: false }, { child: h.children[0], force: true }]);
    });

    it('closeAll() force-kills a browser that ignores the graceful exit', async () => {
        const h = create();
        await h.service.open('a');
        jest.useFakeTimers();
        h.service.closeAll();
        expect(h.service.isRunning('a')).toBe(true);
        expect(h.terminated).toEqual([{ child: h.children[0], force: false }]);
        jest.advanceTimersByTime(FORCE_KILL_DELAY_MS);
        expect(h.terminated).toEqual([{ child: h.children[0], force: false }, { child: h.children[0], force: true }]);
    });

    it('closeAll() does not force-kill a browser that exited promptly', async () => {
        const h = create();
        await h.service.open('a');
        jest.useFakeTimers();
        h.service.closeAll();
        h.children[0].emit('exit', 0);
        jest.advanceTimersByTime(FORCE_KILL_DELAY_MS);
        expect(h.terminated).toEqual([{ child: h.children[0], force: false }]);
    });

    it('the default terminator sends SIGINT for a graceful close (SIGTERM drops recent cookies) and SIGKILL to force', async () => {
        const h = create({ useDefaultTerminate: true });
        await h.service.open('a');
        jest.useFakeTimers();
        h.service.close('a');
        expect((h.children[0] as FakeChild).signals).toEqual(['SIGINT']);
        jest.advanceTimersByTime(FORCE_KILL_DELAY_MS);
        expect((h.children[0] as FakeChild).signals).toEqual(['SIGINT', 'SIGKILL']);
    });

    describe('reservation authority', () => {
        it('exposes native reservation authority rather than allowing fabricated tokens', () => {
            const h = create();
            const token = h.service.tryReserveAutomation('a');
            expect(token).not.toBeNull();
            expect(h.service.tryReserveAutomation('a')).toBeNull();
            h.service.releaseAutomationReservation({ profileId: 'a' });
            expect(h.service.canReserveAutomation('a')).toBe(false);
            h.service.releaseAutomationReservation(token!);
            expect(h.service.canReserveAutomation('a')).toBe(true);
        });
    });

    describe('confirmed cleanup', () => {
        it.each(['open', 'openForAutomation'] as const)('%s leaves no pending entry when directory capture fails', async method => {
            const h = create({ getProfilesDir: () => { throw new Error('workspace unavailable'); } });
            await expect(h.service[method]('a')).rejects.toThrow('workspace unavailable');
            expect(h.service.isRunning('a')).toBe(false);
        });

        it('retains a timed-out close and pending release until late successful completion', async () => {
            jest.useFakeTimers();
            let finish!: () => void;
            const ctx = new EventEmitter() as any;
            ctx.close = () => new Promise<void>(resolve => { finish = resolve; });
            const h = create({ launchAutomation: async () => ctx });
            const token = h.service.tryReserveAutomation('a')!;
            const session = await h.service.openForAutomation('a', token);
            h.service.releaseAutomationReservation(token);
            const closing = session.close();
            await jest.advanceTimersByTimeAsync(5000);
            await closing;
            expect(h.service.isRunning('a')).toBe(true);
            expect(h.service.tryReserveAutomation('a')).toBeNull();
            const idle = h.service.waitUntilIdle(1);
            await jest.advanceTimersByTimeAsync(1);
            expect(await idle).toBe(false);
            finish();
            await Promise.resolve();
            expect(await h.service.waitUntilIdle(1)).toBe(true);
            const next = h.service.tryReserveAutomation('a')!;
            h.service.releaseAutomationReservation(token);
            await expect(h.service.openForAutomation('a', token)).rejects.toThrow('không còn hiệu lực');
            expect(h.service.canReserveAutomation('a')).toBe(false);
            h.service.releaseAutomationReservation(next);
        });

        it('tracks cancelled late automation launches until the context confirms close', async () => {
            let launched!: (ctx: any) => void;
            const h = create({ launchAutomation: () => new Promise(resolve => { launched = resolve; }) });
            const opening = h.service.openForAutomation('a');
            await Promise.resolve();
            h.service.closeAll();
            expect(h.service.isRunning('a')).toBe(true);
            const ctx = new EventEmitter() as any;
            ctx.close = async () => { throw new Error('close rejected'); };
            launched(ctx);
            await expect(opening).rejects.toThrow('Đã hủy mở trình duyệt');
            expect(h.service.isRunning('a')).toBe(true);
            ctx.emit('close');
            expect(h.service.isIdle()).toBe(true);
        });

        it('captures the profile directory before waiting for the proxy', async () => {
            let directory = '/workspace/original';
            let start!: (port: number) => void;
            let launchedDir = '';
            const service = new BrowserProfileService({
                store: { getBrowserProfileById: () => makeProfile('a', 5), getProxyById: () => PROXY, touchBrowserProfileOpened: () => undefined },
                getExecutablePath: () => '/fake', getProfilesDir: () => directory, platform: 'linux',
                createForwarder: () => ({ start: () => new Promise(resolve => { start = resolve; }), stop: async () => undefined }),
                launchAutomation: async (_exe, dir) => {
                    launchedDir = dir;
                    return { on: () => undefined, close: async () => undefined } as any;
                },
            });
            const h = create();
            directory = h.profilesDir;
            const opening = service.openForAutomation('a');
            directory = path.join(h.profilesDir, 'different');
            start(1234);
            await (await opening).close();
            expect(launchedDir).toBe(path.join(h.profilesDir, 'a'));
        });
    });

    describe('openForAutomation', () => {
        function fakeContext() {
            const ctx = new EventEmitter() as any;
            ctx.closed = 0;
            ctx.close = async () => { ctx.closed++; ctx.emit('close'); };
            return ctx;
        }
        const flush = () => new Promise((resolve) => setImmediate(resolve));

        it('launches over the pipe with exactly buildLaunchArgs plus --remote-debugging-pipe', async () => {
            const calls: Array<{ exe: string; dir: string; args: string[] }> = [];
            const ctx = fakeContext();
            const h = create({ launchAutomation: async (exe, dir, args) => { calls.push({ exe, dir, args }); return ctx; } });
            const session = await h.service.openForAutomation('a');
            expect(session.context).toBe(ctx);
            expect(calls).toHaveLength(1);
            expect(calls[0].exe).toBe('/engine/chrome');
            expect(calls[0].args[0]).toBe('--remote-debugging-pipe');
            expect(calls[0].args).toContain(`--user-data-dir=${calls[0].dir}`);
            expect(calls[0].args.some((a) => a.startsWith('--remote-debugging-port'))).toBe(false);
            expect(h.service.isRunning('a')).toBe(true);
            expect(h.touched).toEqual(['a']);
            expect(h.spawned).toHaveLength(0);
        });

        it('rejects when the profile is already open by hand', async () => {
            const h = create({ launchAutomation: async () => fakeContext() });
            await h.service.open('a');
            await expect(h.service.openForAutomation('a')).rejects.toThrow('Profile đang mở. Đóng profile trước khi chạy tự động');
        });

        it('manual open is rejected while automation runs', async () => {
            const h = create({ launchAutomation: async () => fakeContext() });
            await h.service.openForAutomation('a');
            await expect(h.service.open('a')).rejects.toThrow('Profile đang mở');
        });

        it('releases on context close', async () => {
            const ctx = fakeContext();
            const h = create({ launchAutomation: async () => ctx });
            await h.service.openForAutomation('a');
            ctx.emit('close');
            expect(h.service.isRunning('a')).toBe(false);
            expect(h.statuses[h.statuses.length - 1]).toEqual([]);
        });

        it('session.close is idempotent and closes the context once', async () => {
            const ctx = fakeContext();
            const h = create({ launchAutomation: async () => ctx });
            const session = await h.service.openForAutomation('a');
            await Promise.all([session.close(), session.close()]);
            expect(ctx.closed).toBe(1);
            expect(h.service.isRunning('a')).toBe(false);
        });

        it('closeAll closes automation sessions', async () => {
            const ctx = fakeContext();
            const h = create({ launchAutomation: async () => ctx });
            await h.service.openForAutomation('a');
            h.service.closeAll();
            expect(h.service.isRunning('a')).toBe(false);
            await flush();
            expect(ctx.closed).toBe(1);
        });

        it('close(id) from the Browser Profiles screen closes an automation session', async () => {
            const ctx = fakeContext();
            const h = create({ launchAutomation: async () => ctx });
            await h.service.openForAutomation('a');
            h.service.close('a');
            await flush();
            expect(ctx.closed).toBe(1);
            expect(h.service.isRunning('a')).toBe(false);
        });

        it('launch failure releases the slot and stops the forwarder', async () => {
            const h = create({ profiles: [makeProfile('a', 5)], launchAutomation: async () => { throw new Error('boom'); } });
            await expect(h.service.openForAutomation('a')).rejects.toThrow('Không mở được trình duyệt: boom');
            expect(h.service.isRunning('a')).toBe(false);
            expect(h.forwarders).toEqual([{ started: true, stopped: true }]);
        });

        it('counts toward MAX_RUNNING_PROFILES', async () => {
            const profiles = Array.from({ length: MAX_RUNNING_PROFILES + 1 }, (_, i) => makeProfile(`p${i}`));
            const h = create({ profiles, launchAutomation: async () => fakeContext() });
            for (let i = 0; i < MAX_RUNNING_PROFILES; i++) await h.service.open(`p${i}`);
            await expect(h.service.openForAutomation(`p${MAX_RUNNING_PROFILES}`))
                .rejects.toThrow('Đã đạt giới hạn 30 profile mở cùng lúc');
            expect(h.service.getRunningIds()).toHaveLength(MAX_RUNNING_PROFILES);
        });
    });
});

describe('native workspace generation facade', () => {
    const flush = () => new Promise(resolve => setImmediate(resolve));
    function deferred<T>() {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>(r => { resolve = r; });
        return { promise, resolve };
    }
    let dir: string;
    let workspace: string;
    let ipc: typeof import('../../../electron/ipc/browserProfileIpc');
    let handlers: Map<string, (...args: any[]) => Promise<any>>;
    let contexts: any[];
    let writes: string[];
    let reads: string[];
    let events: unknown[];
    let launches: string[];
    let launch: (directory: string) => Promise<any>;
    const mockedModules = [
        'electron', 'child_process', '../../services/database/DatabaseService', '../../services/browser/BrowserEngineManager',
        '../../services/browser/sandboxSupport', '../../services/browser/automationLauncher', '../../services/browser/fingerprint', '../../services/browser/ProxyForwarder',
        '../../services/event/EventBroadcaster', '../../utils/AppModeManager', '../../utils/Logger',
    ];
    function context() {
        const ctx: any = new EventEmitter();
        ctx.close = jest.fn(async () => { ctx.emit('close'); });
        contexts.push(ctx);
        return ctx;
    }
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-5-native-'));
        workspace = 'A'; handlers = new Map(); contexts = []; writes = []; reads = []; events = []; launches = [];
        // One deliberately mutable facade models DatabaseService.switchToWorkspaceDb.
        const database = {
            getDbPath: () => path.join(dir, workspace, 'workspace.db'),
            getBrowserProfileById: (id: string) => { reads.push(workspace); return makeProfile(id, 5); },
            getProxyById: () => { reads.push(workspace); return PROXY; },
            touchBrowserProfileOpened: (id: string) => { writes.push(`${workspace}:${id}`); },
        };
        launch = async () => context();
        jest.doMock('../../services/browser/fingerprint', () => {
            const actual = jest.requireActual('../../services/browser/fingerprint');
            return { ...actual, hostPersona: () => actual.hostPersona('linux') };
        });
        jest.doMock('child_process', () => ({ spawn: () => {
            const child = new FakeChild(); setImmediate(() => child.emit('spawn')); return child;
        } }));
        jest.doMock('electron', () => ({ app: { getPath: () => dir }, ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn) } }));
        jest.doMock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => database } }));
        jest.doMock('../../services/browser/BrowserEngineManager', () => ({ BrowserEngineManager: class { getExecutablePath() { return '/engine/chrome'; } } }));
        jest.doMock('../../services/browser/ProxyForwarder', () => ({ ProxyForwarder: class {
            async start() { return 1234; }
            async stop() {}
        } }));
        jest.doMock('../../services/browser/sandboxSupport', () => ({ getSandboxSupport: () => ({ get: async () => 'enabled' }) }));
        jest.doMock('../../services/browser/automationLauncher', () => ({ launchAutomationBrowser: async (_exe: string, directory: string) => {
            launches.push(directory); return launch(directory);
        } }));
        jest.doMock('../../services/event/EventBroadcaster', () => ({ __esModule: true, default: { emit: (...args: unknown[]) => events.push(args) } }));
        jest.doMock('../../utils/AppModeManager', () => ({ __esModule: true, default: { getInstance: () => ({ isEmployeeMode: () => false }) } }));
        jest.doMock('../../utils/Logger', () => ({ __esModule: true, default: { error: () => {}, warn: () => {} } }));
        jest.isolateModules(() => { ipc = require('../../../electron/ipc/browserProfileIpc'); });
        ipc.registerBrowserProfileIpc();
    });
    afterEach(() => {
        jest.useRealTimers();
        for (const ctx of contexts) ctx.emit('close');
        for (const name of mockedModules) jest.dontMock(name);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('pauses manual IPC and automation admission synchronously while a pending native launch settles', async () => {
        const native = ipc.getBrowserProfileService();
        const gate = deferred<any>(); launch = () => gate.promise;
        const opening = native.openForAutomation('a');
        await flush();
        const drain = ipc.closeAllBrowserProfilesAndWait(1000);
        expect(await handlers.get('browserProfile:open')!({}, { id: 'b' })).toMatchObject({ success: false });
        await expect(native.openForAutomation('b')).rejects.toThrow();
        expect(native.tryReserveAutomation('b')).toBeNull();
        expect(() => ipc.retireBrowserProfileGeneration()).toThrow();
        gate.resolve(context());
        await expect(opening).rejects.toThrow('Đã hủy mở trình duyệt');
        expect(await drain).toBe(true);
        expect(writes).toEqual([]);
        expect(launches).toEqual([path.join(dir, 'A', 'browser-profiles', 'a')]);
    });

    it('allows a captured pending launch to settle while paused without admitting another owner', async () => {
        const native = ipc.getBrowserProfileService();
        const gate = deferred<any>(); launch = () => gate.promise;
        const opening = native.openForAutomation('a');
        await flush();
        ipc.pauseBrowserProfileAdmission();
        expect(native.canReserveAutomation('b')).toBe(false);
        gate.resolve(context());
        const session = await opening;
        expect(writes).toEqual(['A:a']);
        expect(events).toHaveLength(1);
        await session.close();
        expect(await native.waitUntilIdle(1000)).toBe(true);
        ipc.resumeBrowserProfileAdmission();
        expect(native.canReserveAutomation('b')).toBe(true);
    });

    it('suppresses a pending launch write/status if the mutable facade was incorrectly retargeted and refuses a replacement until retirement', async () => {
        const native = ipc.getBrowserProfileService();
        const gate = deferred<any>(); launch = () => gate.promise;
        const opening = native.openForAutomation('a');
        await flush();
        workspace = 'B';
        expect(() => ipc.getBrowserProfileService()).toThrow();
        expect(() => ipc.retireBrowserProfileGeneration()).toThrow();
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            gate.resolve(context());
            const session = await opening;
            expect(writes).toEqual([]); expect(events).toEqual([]);
            expect(reads.every(value => value === 'A')).toBe(true);
            expect(launches).toEqual([path.join(dir, 'A', 'browser-profiles', 'a')]);
            await session.close();
            expect(await native.waitUntilIdle(1000)).toBe(true);
            ipc.retireBrowserProfileGeneration();
            ipc.resumeBrowserProfileAdmission();
            expect(ipc.getBrowserProfileService()).not.toBe(native);
        } finally { warn.mockRestore(); }
    });

    it('retains the same generation across false drain and resumes only when explicitly requested', async () => {
        const native = ipc.getBrowserProfileService();
        const close = deferred<void>();
        const ctx = context(); ctx.close = () => close.promise;
        launch = async () => ctx;
        await native.openForAutomation('a');
        jest.useFakeTimers();
        const drain = ipc.closeAllBrowserProfilesAndWait(20);
        await jest.advanceTimersByTimeAsync(20);
        expect(await drain).toBe(false);
        expect(ipc.getBrowserProfileService()).toBe(native);
        expect(native.canReserveAutomation('b')).toBe(false);
        ipc.resumeBrowserProfileAdmission();
        const reservation = native.tryReserveAutomation('b');
        expect(reservation).not.toBeNull();
        native.releaseAutomationReservation(reservation!);
        const retry = ipc.closeAllBrowserProfilesAndWait(20);
        close.resolve();
        expect(await retry).toBe(true);
        expect(writes).toEqual(['A:a']);
    });

    it('permanently retires old references through A-B-A and ignores old close events and tokens', async () => {
        const first = ipc.getBrowserProfileService();
        const oldToken = first.tryReserveAutomation('a')!;
        const oldSession = await first.openForAutomation('a', oldToken);
        const oldContext = oldSession.context as any;
        expect(await ipc.closeAllBrowserProfilesAndWait(1000)).toBe(true);
        ipc.retireBrowserProfileGeneration();
        workspace = 'B'; ipc.resumeBrowserProfileAdmission();
        const second = ipc.getBrowserProfileService();
        expect(second).not.toBe(first);
        expect(await ipc.closeAllBrowserProfilesAndWait(1000)).toBe(true);
        ipc.retireBrowserProfileGeneration();
        workspace = 'A'; ipc.resumeBrowserProfileAdmission();
        const reopened = ipc.getBrowserProfileService();
        const newToken = reopened.tryReserveAutomation('a')!;
        await reopened.openForAutomation('a', newToken);
        writes.length = 0; reads.length = 0; events.length = 0;
        await expect(first.open('b')).rejects.toThrow();
        await expect(first.openForAutomation('b')).rejects.toThrow();
        expect(first.tryReserveAutomation('b')).toBeNull();
        expect(() => first.getProfileDir('b')).toThrow();
        first.releaseAutomationReservation(oldToken);
        oldContext.emit('close'); await oldSession.close();
        expect(reopened.isRunning('a')).toBe(true);
        expect(reopened.canReserveAutomation('a')).toBe(false);
        expect(writes).toEqual([]); expect(reads).toEqual([]); expect(events).toEqual([]);
        expect(await ipc.closeAllBrowserProfilesAndWait(1000)).toBe(true);
    });
});
