import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BrowserProfileService, type LaunchAutomation } from '../../services/browser/BrowserProfileService';
import { ProfileJobQueue, type ProfileJobRequest, type ProfileJobPriority } from '../../services/browser/ProfileJobQueue';

function context() {
    const ctx = new EventEmitter() as any;
    ctx.close = async () => { ctx.emit('close'); };
    return ctx;
}

function request(profileId: string, jobId = profileId, priority: ProfileJobPriority = 'interactive'): ProfileJobRequest {
    return { profileId, owner: { workspaceId: 'workspace', generation: 1, jobId }, priority,
        signal: new AbortController().signal, assertCurrent: () => undefined };
}

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('ProfileJobQueue native ownership', () => {
    const dirs: string[] = [];
    const queues: ProfileJobQueue[] = [];
    function setup(launch: LaunchAutomation = async () => context(), options: { deferUntil?: (r: ProfileJobRequest, now: number) => number | null } = {}) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-queue-'));
        dirs.push(dir);
        const profiles = new Set(Array.from({ length: 51 }, (_, i) => `p${i}`));
        const browser = new BrowserProfileService({
            store: {
                getBrowserProfileById: id => profiles.has(id) ? {
                    id, name: `Profile ${id}`, group_id: null, proxy_id: null, note: '',
                    fingerprint: { seed: 1, hardwareConcurrency: 8, language: 'vi-VN', timezone: 'Asia/Ho_Chi_Minh' },
                    last_opened_at: null, created_at: 0, updated_at: 0,
                } : null,
                getProxyById: () => null, touchBrowserProfileOpened: () => undefined,
            },
            getProfilesDir: () => dir, getExecutablePath: () => '/fake/browser', platform: 'linux', launchAutomation: launch,
        });
        const queue = new ProfileJobQueue({ browser, ...options });
        queues.push(queue);
        return { browser, queue, profiles };
    }
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        queues.splice(0).forEach(q => q.retire());
        jest.useRealTimers();
        dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
    });

    it('admits an available profile synchronously and excludes another controller', async () => {
        const { queue } = setup();
        expect(queue.canAcquire('p0')).toBe(true);
        const lease = await queue.acquire(request('p0'));
        expect(queue.canAcquire('p0')).toBe(false);
        lease.release();
        expect(queue.canAcquire('p0')).toBe(true);
    });

    it('keeps ownership between session opens, rejecting manual and legacy automation', async () => {
        const { browser, queue } = setup();
        const lease = await queue.acquire(request('p0'));
        await (await lease.open()).close();
        await expect(browser.open('p0')).rejects.toThrow();
        await expect(browser.openForAutomation('p0')).rejects.toThrow();
        const second = await lease.open();
        lease.release();
        expect(queue.isBusy()).toBe(true);
        await second.close();
        expect(queue.isBusy()).toBe(false);
    });

    it('retains an acquired lease after launch failure and excludes contenders until explicit release', async () => {
        let launches = 0;
        const { browser, queue } = setup(async () => { if (++launches === 1) throw new Error('transient'); return context(); });
        const lease = await queue.acquire(request('p0'));
        await expect(lease.open()).rejects.toThrow('transient');
        expect(queue.canAcquire('p0')).toBe(false);
        await expect(browser.open('p0')).rejects.toThrow();
        let granted = false;
        const contender = queue.acquire(request('p0', 'next')).then(next => { granted = true; return next; });
        await flush(); expect(granted).toBe(false);
        const session = await lease.open(); await session.close();
        expect(granted).toBe(false); lease.release();
        (await contender).release(); expect(launches).toBe(2);
    });

    it('orders scheduled/FIFO before interactive/background without blocking other profiles', async () => {
        const { queue } = setup();
        const holder = await queue.acquire(request('p0'));
        const order: string[] = [];
        const waiting = [request('p0', 'background', 'background'), request('p0', 'scheduled-first', 'scheduled'),
            request('p0', 'interactive'), request('p0', 'scheduled-second', 'scheduled')].map(r =>
            queue.acquire(r).then(lease => { order.push(r.owner.jobId); lease.release(); }));
        const other = await queue.acquire(request('p1'));
        expect(other.profileId).toBe('p1');
        other.release();
        holder.release();
        await Promise.all(waiting);
        expect(order).toEqual(['scheduled-first', 'scheduled-second', 'interactive', 'background']);
    });

    it('serializes 50 contenders and ignores late duplicate releases', async () => {
        let controllers = 0;
        let max = 0;
        const { queue } = setup(async () => {
            controllers++;
            max = Math.max(max, controllers);
            const ctx = context();
            ctx.close = async () => { controllers--; ctx.emit('close'); };
            return ctx;
        });
        await Promise.all(Array.from({ length: 50 }, (_, i) => queue.acquire(request('p0', String(i))).then(async lease => {
            const session = await lease.open();
            await session.close();
            lease.release();
            await flush();
            lease.release();
        })));
        expect(max).toBe(1);
        expect(queue.isBusy()).toBe(false);
    });

    it('counts reserved and running profiles once at the 30 slot boundary', async () => {
        const { browser, queue } = setup();
        const leases = await Promise.all(Array.from({ length: 30 }, (_, i) => queue.acquire(request(`p${i}`))));
        const session = await leases[0].open();
        let granted = false;
        const pending = queue.acquire(request('p30')).then(l => { granted = true; return l; });
        await flush();
        expect(granted).toBe(false);
        expect(browser.getRunningIds()).toEqual(['p0']);
        await session.close();
        expect(granted).toBe(false);
        leases[1].release();
        const next = await pending;
        expect(granted).toBe(true);
        next.release();
        leases.forEach(l => l.release());
    });

    it('times out at exactly 7200000 ms, not on repeated availability events', async () => {
        const { queue } = setup();
        const holder = await queue.acquire(request('p0'));
        let error: any;
        const waiting = queue.acquire(request('p0', 'waiter')).catch(e => { error = e; });
        await jest.advanceTimersByTimeAsync(7199999);
        queue.notifyAvailability();
        expect(error).toBeUndefined();
        await jest.advanceTimersByTimeAsync(1);
        await waiting;
        expect(error.code).toBe('profile_wait_timeout');
        holder.release();
    });

    it('uses the original earlier deadline and a single defer wakeup', async () => {
        const start = Date.now();
        const { queue } = setup(async () => context(), { deferUntil: () => start + 100 });
        const r = request('p0');
        r.deadlineAt = start + 50;
        const result = queue.acquire(r).catch(e => e);
        await jest.advanceTimersByTimeAsync(50);
        expect((await result).code).toBe('profile_wait_timeout');
        const next = queue.acquire(request('p0'));
        await jest.advanceTimersByTimeAsync(50);
        (await next).release();
    });

    it('cancels before grant but does not close an already granted critical session', async () => {
        const { queue } = setup();
        const abort = new AbortController();
        abort.abort();
        await expect(queue.acquire({ ...request('p0'), signal: abort.signal })).rejects.toMatchObject({ code: 'profile_wait_cancelled' });
        const active = new AbortController();
        const lease = await queue.acquire({ ...request('p0'), signal: active.signal });
        const session = await lease.open();
        active.abort();
        expect(queue.isBusy()).toBe(true);
        await session.close();
        lease.release();
        expect(queue.isBusy()).toBe(false);
    });

    it('pause keeps waiters without granting; resume grants them; retire rejects what remains and cannot resume', async () => {
        const { queue } = setup();
        const holder = await queue.acquire(request('p0'));
        let granted: any;
        const waiting = queue.acquire(request('p0', 'kept')).then(lease => { granted = lease; return lease; }, e => e);
        queue.pause();
        holder.release();
        const lateWaiter = queue.acquire(request('p1', 'late')).then(lease => { granted ??= lease; return lease; }, e => e);
        await flush();
        expect(granted).toBeUndefined();
        expect(queue.isBusy()).toBe(true);
        expect(queue.canAcquire('p1')).toBe(false);
        queue.resume();
        expect((await waiting).profileId).toBe('p0');
        const late = await lateWaiter;
        expect(late.profileId).toBe('p1');
        (await waiting).release(); late.release();
        const holder2 = await queue.acquire(request('p2'));
        const remaining = queue.acquire(request('p2', 'remaining')).catch(e => e);
        queue.pause();
        queue.retire();
        expect((await remaining).code).toBe('profile_wait_cancelled');
        holder2.release();
        queue.resume();
        await expect(queue.acquire(request('p1'))).rejects.toMatchObject({ code: 'profile_wait_cancelled' });
    });

    it('a paused waiter keeps its original deadline and is removed by its own abort', async () => {
        const { queue } = setup();
        const holder = await queue.acquire(request('p0'));
        const timed = queue.acquire(request('p0', 'timed')).catch(e => e);
        const abort = new AbortController();
        const aborted = queue.acquire({ ...request('p0', 'aborted'), signal: abort.signal }).catch(e => e);
        queue.pause();
        await jest.advanceTimersByTimeAsync(1000);
        abort.abort();
        expect((await aborted).code).toBe('profile_wait_cancelled');
        await jest.advanceTimersByTimeAsync(7200000 - 1000 - 1);
        queue.notifyAvailability();
        let settled = false; void timed.then(() => { settled = true; });
        await flush(); expect(settled).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        expect((await timed).code).toBe('profile_wait_timeout');
        holder.release();
        expect(await queue.waitUntilIdle(1)).toBe(true);
    });

    it('pumps only check waiters cheaply; the full authority check runs at grant and still refuses a revoked waiter', async () => {
        const { queue, browser } = setup();
        const holder = await queue.acquire(request('p0'));
        let revoked = false;
        const authority = jest.fn(() => { if (revoked) throw new Error('revoked grant'); });
        const waiting = queue.acquire({ ...request('p0', 'autonomy'), assertCurrent: authority }).catch(e => e);
        const callsAfterAdmission = authority.mock.calls.length;
        for (let i = 0; i < 20; i++) queue.notifyAvailability();
        expect(authority.mock.calls.length).toBe(callsAfterAdmission);
        revoked = true;
        const reserve = jest.spyOn(browser, 'openForAutomation');
        holder.release();
        expect((await waiting).message).toBe('revoked grant');
        expect(reserve).not.toHaveBeenCalled();
        expect(browser.canReserveAutomation('p0')).toBe(true);
        expect(queue.isBusy()).toBe(false);
    });

    it('does not recursively emit changed when its observer requests another pump', async () => {
        const { browser } = setup();
        let changes = 0;
        const queue = new ProfileJobQueue({ browser, onChanged: () => {
            changes++;
            if (changes < 5) queue.notifyAvailability();
        } });
        queues.push(queue);
        const lease = await queue.acquire(request('p0'));
        expect(changes).toBe(1);
        lease.release();
    });

    it('does not grant when a synchronous availability callback pauses admission, and keeps the waiter', async () => {
        const { browser, queue } = setup();
        const unsubscribe = browser.onAvailabilityChanged(() => queue.pause());
        const abort = new AbortController();
        let granted = false;
        const pending = queue.acquire({ ...request('p0'), signal: abort.signal }).then(() => { granted = true; }, e => e);
        await flush();
        unsubscribe();
        expect(granted).toBe(false);
        expect(browser.isIdle()).toBe(true);
        expect(queue.isBusy()).toBe(true);
        abort.abort();
        expect((await pending).code).toBe('profile_wait_cancelled');
        expect(queue.isBusy()).toBe(false);
    });

    it('cancels queued aborts and refuses a different generation after resume', async () => {
        const { queue } = setup();
        const holder = await queue.acquire(request('p0'));
        const abort = new AbortController();
        const pending = queue.acquire({ ...request('p0'), signal: abort.signal }).catch(e => e);
        abort.abort();
        expect((await pending).code).toBe('profile_wait_cancelled');
        holder.release();
        queue.pause();
        queue.resume();
        const other = request('p0');
        other.owner.generation = 2;
        await expect(queue.acquire(other)).rejects.toThrow('workspace');
        expect(queue.isBusy()).toBe(false);
    });

    it('rechecks current authority and deleted profiles without masking actual errors', async () => {
        const { queue, profiles } = setup();
        const holder = await queue.acquire(request('p0'));
        const r = request('p0', 'stale');
        let stale = false;
        r.assertCurrent = () => { if (stale) throw new Error('stale generation'); };
        const waiting = queue.acquire(r).catch(e => e);
        stale = true;
        holder.release();
        expect((await waiting).message).toBe('stale generation');
        const other = await queue.acquire(request('p1'));
        const deleted = queue.acquire(request('p1')).catch(e => e);
        profiles.delete('p1');
        other.release();
        expect((await deleted).message).toContain('Không tìm thấy profile');
    });

    it('open releases on launch failure and on successful session close', async () => {
        const { browser, queue } = setup(async () => { throw new Error('launch failed'); });
        await expect(queue.open(request('p0'))).rejects.toThrow('launch failed');
        expect(queue.isBusy()).toBe(false);
        expect(browser.isRunning('p0')).toBe(false);
        const good = setup();
        const session = await good.queue.open(request('p0'));
        await session.close();
        expect(good.queue.isBusy()).toBe(false);
    });

    it('keeps blocked close timeout/rejection busy until confirmed close and permits unrelated work', async () => {
        const ctx = context();
        ctx.close = async () => { throw new Error('cannot close'); };
        const { browser, queue } = setup(async () => ctx);
        const session = await queue.open(request('p0'));
        await session.close();
        expect(queue.isBusy()).toBe(true);
        const idle = browser.waitUntilIdle(1);
        const queueIdle = queue.waitUntilIdle(1);
        await jest.advanceTimersByTimeAsync(1);
        expect(await idle).toBe(false);
        expect(await queueIdle).toBe(false);
        const other = await queue.acquire(request('p1'));
        other.release();
        ctx.emit('close');
        expect(await queue.waitUntilIdle(1)).toBe(true);
    });
});
