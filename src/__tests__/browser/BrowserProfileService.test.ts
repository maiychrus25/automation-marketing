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
        getProfilesDir: () => profilesDir,
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

    it('closeAll() terminates every browser gracefully and clears state at once', async () => {
        const h = create({ profiles: [makeProfile('a', 5), makeProfile('b')] });
        await h.service.open('a');
        await h.service.open('b');
        h.service.closeAll();
        expect(h.terminated.map((t) => t.force)).toEqual([false, false]);
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
        expect(h.service.isRunning('a')).toBe(false);
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
