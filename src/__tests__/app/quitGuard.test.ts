import { createQuitGuard } from '../../services/app/quitGuard';
import { UpdateService } from '../../services/update/UpdateService';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}

describe('quit guard', () => {
    it('coalesces pending quit requests and allows cleanup exactly once after confirmed drain', async () => {
        const gate = deferred<boolean>();
        const drain = jest.fn(() => gate.promise);
        const onReady = jest.fn();
        const onBlocked = jest.fn();
        const quit = createQuitGuard({ drain, onReady, onBlocked });
        const first = quit();
        const second = quit();
        expect(onReady).not.toHaveBeenCalled();
        expect(drain).toHaveBeenCalledTimes(1);
        gate.resolve(true);
        expect(await first).toBe(true);
        expect(await second).toBe(true);
        expect(await quit()).toBe(true);
        expect(onReady).toHaveBeenCalledTimes(1);
        expect(onBlocked).not.toHaveBeenCalled();
    });

    it.each(['false', 'reject'])('blocks cleanup and permits a retry after %s drain', async outcome => {
        const drain = jest.fn<Promise<boolean>, []>();
        if (outcome === 'false') drain.mockResolvedValueOnce(false);
        else drain.mockRejectedValueOnce(new Error('not settled'));
        drain.mockResolvedValueOnce(true);
        const onReady = jest.fn();
        const onBlocked = jest.fn();
        const quit = createQuitGuard({ drain, onReady, onBlocked });
        expect(await quit()).toBe(false);
        expect(onReady).not.toHaveBeenCalled();
        expect(onBlocked).toHaveBeenCalledTimes(1);
        expect(await quit()).toBe(true);
        expect(onReady).toHaveBeenCalledTimes(1);
    });
});

/** Executes the complete main/update modules and their real startup registration, with no Electron/OS/network IO. */
async function mainHarness(options: { platform?: string } = {}) {
    const events: string[] = [];
    const handlers = new Map<string, (...args: any[]) => any>();
    const app = new EventEmitter() as any;
    const updater = new EventEmitter() as any;
    const timers = new Map<object, { callback: () => void; ms: number }>();
    const setTimer = (callback: () => void, ms: number) => { const handle = { unref() { return this; } }; timers.set(handle, { callback, ms }); return handle; };
    const clearTimer = (handle: object) => timers.delete(handle);
    let ready!: () => Promise<void>;
    let trayMenu: any[] = [];
    let window: any;
    let paused = false; let nativePaused = false; let workspaceSwitching = false; let busy = false;
    let authorizedQuits = 0;
    let retireFailure = false;
    let cancelFailure = false;
    const responses: number[] = [];
    const dialogs: any[] = [];
    const dialogParents: any[] = [];
    const prompts: Array<(response: number) => void> = [];
    let holdPrompts = false;
    let windowVisible = true, windowMinimized = false;
    let prepare: () => Promise<boolean> = async () => true;
    let drain: () => Promise<boolean> = async () => true;
    let closeNative: () => Promise<boolean> = async () => true;
    const exit = jest.fn();
    const dbClose = jest.fn(() => events.push('db.close'));
    const service: any = new Proxy({
        initialize: async () => {}, start: async () => ({ success: true }),
        stop: () => events.push('unrelated.stop'), setMainWindow: () => {},
        disconnectAll: () => events.push('disconnect'), close: dbClose,
        timers: new Map(), cronJobs: new Map(),
    }, { get: (target, key) => key in target ? target[key] : () => {} });
    const singleton: any = new Proxy({ getInstance: () => service }, { get: (target, key) => key in target ? target[key] : () => {} });
    const genericModule = new Proxy({ __esModule: true, default: singleton }, { get: (target: any, key) => key in target ? target[key] : () => {} });
    const image = { isEmpty: () => true, resize() { return this; } };
    class Window extends EventEmitter {
        webContents = Object.assign(new EventEmitter(), { send: jest.fn(), session: { webRequest: { onHeadersReceived: () => {} } } });
        hide = jest.fn(); show = jest.fn(); focus = jest.fn(); loadURL = jest.fn(); loadFile = jest.fn();
        isDestroyed = () => false; isVisible = () => windowVisible; isMaximized = () => false; isMinimized = () => windowMinimized; restore = jest.fn();
        constructor(..._args: any[]) { super(); window = this; }
    }
    Object.assign(app, {
        commandLine: { appendSwitch: () => {} }, setName: () => {}, setPath: () => {}, getPath: () => '/fake',
        getVersion: () => '26.10.0', setAppUserModelId: () => {}, requestSingleInstanceLock: () => true,
        whenReady: () => ({ then: (callback: () => Promise<void>) => { ready = callback; } }),
        quit: () => {
            events.push('app.quit');
            const event = { prevented: false, preventDefault() { this.prevented = true; } };
            app.emit('before-quit', event);
            if (!event.prevented) { authorizedQuits++; app.emit('will-quit', { preventDefault() {} }); }
        },
        exit, focus: (opts: unknown) => events.push(`app.focus:${JSON.stringify(opts)}`),
    });
    const electron = {
        app, BrowserWindow: Window,
        ipcMain: { on: (name: string, callback: any) => handlers.set(name, callback), handle: (name: string, callback: any) => handlers.set(name, callback), removeAllListeners: (name: string) => handlers.delete(name) },
        Tray: class extends EventEmitter { setToolTip() {} setContextMenu(menu: any[]) { trayMenu = menu; } },
        Menu: { buildFromTemplate: (template: any[]) => template },
        nativeImage: { createEmpty: () => image, createFromPath: () => image },
        protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
        nativeTheme: { shouldUseDarkColors: false }, Notification: { isSupported: () => false },
        dialog: { showErrorBox: (..._args: any[]) => events.push('blocked.message'),
            showMessageBox: async (...args: any[]) => {
                const options = args[args.length - 1]; dialogs.push(options); dialogParents.push(args.length > 1 ? args[0] : null); events.push(`dialog:${options.message}`);
                if (holdPrompts) return new Promise(resolve => prompts.push(response => resolve({ response })));
                return { response: responses.shift() ?? 0 };
            } },
        shell: { openExternal: async () => {} },
    };
    const poster = {
        registerFacebookPosterIpc: () => {}, isFacebookPosterBusy: () => busy,
        isFacebookJobAdmissionPaused: () => paused,
        pauseFacebookJobAdmission: () => { paused = true; events.push('jobs.pause'); },
        resumeFacebookJobAdmission: () => { paused = false; events.push('jobs.resume'); },
        retireFacebookJobGeneration: () => { if (retireFailure) throw new Error('owner changed'); events.push('jobs.retire'); },
        cancelAndWaitFacebookPosterJobs: () => { events.push('jobs.drain'); return drain(); },
        cancelFacebookPosterJobs: () => { if (cancelFailure) throw new Error('cancel failed'); events.push('jobs.cancel'); },
        startFacebookPosterScheduler: () => events.push('scheduler.start'),
        stopFacebookPosterScheduler: () => events.push('scheduler.stop'),
        POSTER_NOT_STOPPED_ERROR: 'Việc Đăng Facebook chưa dừng được. Thử lại sau.',
    };
    const browser = {
        registerBrowserProfileIpc: () => {}, closeAllBrowserProfiles: () => events.push('native.close.unconfirmed'),
        pauseBrowserProfileAdmission: () => { nativePaused = true; events.push('native.pause'); },
        resumeBrowserProfileAdmission: () => { nativePaused = false; events.push('native.resume'); },
        retireBrowserProfileGeneration: () => events.push('native.retire'),
        closeAllBrowserProfilesAndWait: () => { events.push('native.drain'); return closeNative(); },
    };
    const control = {
        registerControlApiIpc: () => {}, syncControlEventSink: () => {}, startControlApi: async () => {},
        restartControlApi: async () => { events.push('control.resume'); },
        stopPagePreparationForWorkspaceSwitch: () => { events.push('protected.drain'); return prepare(); },
        shutdownControlApi: async () => { events.push('control.shutdown'); },
    };
    updater.checkForUpdates = async () => ({ isUpdateAvailable: true });
    updater.downloadUpdate = async () => {};
    updater.quitAndInstall = () => { events.push('installer'); setTimer(() => app.quit(), 0); };
    const cache = new Map<string, any>();
    function load(file: string): any {
        if (cache.has(file)) return cache.get(file);
        const module = { exports: {} }; cache.set(file, module.exports);
        const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
        const requireBoundary = (name: string) => {
            if (name === 'electron') return electron;
            if (name === 'electron-updater') return { autoUpdater: updater };
            if (name === 'path') return path;
            if (name === 'os') return { release: () => '10.0.22621' };
            if (name === 'fs') return { existsSync: () => false };
            if (name === 'inspector') return { url: () => undefined };
            if (name === 'node-cron') return { schedule: () => ({ stop() {} }) };
            if (name.endsWith('/updateIpc')) return load(path.resolve(path.dirname(file), `${name}.ts`));
            if (name.endsWith('/quitGuard')) return { createQuitGuard };
            if (name.endsWith('/UpdateService')) return { UpdateService };
            if (name.endsWith('/facebookPosterIpc')) return poster;
            if (name.endsWith('/browserProfileIpc')) return browser;
            if (name.endsWith('/workspaceIpc')) return { registerWorkspaceIpc: () => {}, isWorkspaceSwitchInProgress: () => workspaceSwitching };
            if (name.endsWith('/controlApiIpc')) return control;
            if (name.endsWith('/legacyDataMigration')) return { migrateLegacyUserData: () => ({ status: 'none' }) };
            if (name.endsWith('/BuildConfig')) return { IS_DEV_BUILD: false, SHOW_DEV_TOOLS: false };
            if (name.endsWith('/windowAppearance')) return { resolveWindowAppearance: () => ({}), windowChromeOptions: () => ({}) };
            return genericModule;
        };
        vm.runInNewContext(source, {
            module, exports: module.exports, require: requireBoundary, __dirname: path.dirname(file),
            process: { platform: options.platform ?? 'win32', env: {}, argv: ['fake-app'], on: () => {}, exit },
            console: { log() {}, warn() {}, error() {} }, Buffer, URL,
            setTimeout: setTimer, clearTimeout: clearTimer, setInterval: setTimer, clearInterval: clearTimer,
            AbortSignal: { timeout: () => ({}) },
            fetch: async () => ({ ok: true, json: async () => ({ tag_name: 'v26.11.0', html_url: 'https://example.invalid/release' }) }),
        }, { filename: file });
        return module.exports;
    }
    load(path.resolve(__dirname, '../../../electron/main.ts'));
    await ready(); events.length = 0;
    return {
        app, events, exit, dbClose, updater, window,
        call: (name: string) => handlers.get(name)!({}),
        trayQuit: () => trayMenu.find(item => item.label === 'Thoát hoàn toàn').click(),
        setPrepare: (fn: typeof prepare) => { prepare = fn; }, setDrain: (fn: typeof drain) => { drain = fn; },
        setNative: (fn: typeof closeNative) => { closeNative = fn; },
        setWorkspaceSwitching: (value: boolean) => { workspaceSwitching = value; },
        setOtherPause: (value: boolean) => { paused = value; nativePaused = value; },
        setBusy: (value: boolean) => { busy = value; },
        setRetireFailure: (value: boolean) => { retireFailure = value; },
        setCancelFailure: (value: boolean) => { cancelFailure = value; },
        respond: (...values: number[]) => { responses.push(...values); }, dialogs, dialogParents,
        holdPrompts: () => { holdPrompts = true; }, answerPrompt: (response: number) => prompts.shift()!(response), pendingPrompts: () => prompts.length,
        setWindow: (state: { visible?: boolean; minimized?: boolean }) => { windowVisible = state.visible ?? windowVisible; windowMinimized = state.minimized ?? windowMinimized; },
        isPaused: () => paused && nativePaused, quits: () => authorizedQuits,
        advance: async (ms: number) => {
            for (const [handle, timer] of [...timers]) if (timer.ms <= ms) { timers.delete(handle); timer.callback(); }
            for (let i = 0; i < 15; i++) await Promise.resolve();
        },
        download: async () => { await handlers.get('update:check')!({}); await handlers.get('update:download')!({}); updater.emit('update-downloaded'); },
    };
}

const flushMain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

describe('registered main and update lifecycle', () => {
    it.each(['renderer', 'tray', 'OS', 'window-all-closed', 'will-quit'])('%s quit cannot close DB or force-exit while jobs/native cleanup are pending', async entry => {
        const h = await mainHarness(); const jobs = deferred<boolean>(); const native = deferred<boolean>();
        h.setDrain(() => jobs.promise); h.setNative(() => native.promise);
        const request = () => entry === 'renderer' ? h.call('window:quit') : entry === 'tray' ? h.trayQuit() : entry === 'OS' ? h.app.quit() : entry === 'will-quit' ? h.app.emit('will-quit', { preventDefault() {} }) : h.app.emit('window-all-closed');
        request(); request(); await flushMain();
        expect(h.isPaused()).toBe(true); expect(h.dbClose).not.toHaveBeenCalled();
        expect(h.events.filter(e => e === 'jobs.drain')).toHaveLength(1);
        await h.advance(5000); expect(h.exit).not.toHaveBeenCalled(); expect(h.quits()).toBe(0);
        jobs.resolve(true); await flushMain(); expect(h.dbClose).not.toHaveBeenCalled();
        native.resolve(true); await flushMain();
        expect(h.quits()).toBe(1); expect(h.dbClose).toHaveBeenCalledTimes(1);
        expect(h.events.indexOf('jobs.drain')).toBeLessThan(h.events.indexOf('native.drain'));
        expect(h.events.indexOf('native.retire')).toBeLessThan(h.events.indexOf('db.close'));
    });

    it('retirement refusal cannot fall through to DB close and a later quit retries the gate', async () => {
        const h = await mainHarness(); h.setRetireFailure(true);
        h.app.quit(); await flushMain();
        expect(h.dbClose).not.toHaveBeenCalled(); expect(h.quits()).toBe(0); expect(h.isPaused()).toBe(false);
        h.setRetireFailure(false); h.app.quit(); await flushMain();
        expect(h.dbClose).toHaveBeenCalledTimes(1); expect(h.quits()).toBe(1);
        expect(h.events.filter(e => e === 'jobs.drain')).toHaveLength(2);
    });

    it('custom window close remains hide-to-tray and does not acquire a quit transition', async () => {
        const h = await mainHarness(); h.call('window:close');
        expect(h.window.hide).toHaveBeenCalledTimes(1); expect(h.events).not.toContain('jobs.pause'); expect(h.dbClose).not.toHaveBeenCalled();
    });

    it.each(['protected', 'jobs', 'native'].flatMap(stage => ['false', 'reject'].map(outcome => [stage, outcome])))('owned %s drain %s resumes only jobs/native and permits quit retry', async (stage, outcome) => {
        const h = await mainHarness();
        const failure = () => outcome === 'false' ? Promise.resolve(false) : Promise.reject(new Error('blocked'));
        if (stage === 'protected') h.setPrepare(failure);
        else if (stage === 'jobs') h.setDrain(failure);
        else h.setNative(failure);
        h.app.quit(); await flushMain();
        expect(h.quits()).toBe(0); expect(h.dbClose).not.toHaveBeenCalled(); expect(h.isPaused()).toBe(false);
        expect(h.events).toContain('scheduler.start'); expect(h.events).not.toContain('unrelated.stop');
        h.setPrepare(async () => true); h.setDrain(async () => true); h.setNative(async () => true);
        h.app.quit(); await flushMain();
        expect(h.quits()).toBe(1); expect(h.dbClose).toHaveBeenCalledTimes(1);
    });

    it.each(['workspace', 'other-pause'])('quit/update cannot resume a competing %s transition', async competing => {
        const h = await mainHarness(); await h.download();
        if (competing === 'workspace') h.setWorkspaceSwitching(true); else h.setOtherPause(true);
        h.app.quit(); await flushMain();
        expect((await h.call('update:install')).success).toBe(false);
        expect(h.events).not.toContain('jobs.resume'); expect(h.events).not.toContain('native.resume');
        expect(h.events).not.toContain('installer'); expect(h.dbClose).not.toHaveBeenCalled();
    });

    it('update validates state/busy before pausing and transfers confirmed readiness into its own ensuing quit', async () => {
        const h = await mainHarness();
        expect((await h.call('update:install')).success).toBe(false); expect(h.events).not.toContain('jobs.pause');
        await h.download(); h.setBusy(true);
        expect((await h.call('update:install')).success).toBe(false); expect(h.events).not.toContain('jobs.pause');
        h.setBusy(false); const native = deferred<boolean>(); h.setNative(() => native.promise);
        const first = h.call('update:install'); const second = h.call('update:install'); await flushMain();
        expect(h.events).not.toContain('installer'); expect(h.events).not.toContain('app.quit'); expect(h.dbClose).not.toHaveBeenCalled();
        h.app.quit(); await flushMain(); expect(h.dbClose).not.toHaveBeenCalled();
        native.resolve(true); expect(await first).toEqual({ success: true }); expect(await second).toEqual({ success: true });
        expect(h.events.filter(e => e === 'installer')).toHaveLength(1);
        expect(h.dbClose).not.toHaveBeenCalled();
        await h.advance(0);
        expect(h.quits()).toBe(1); expect(h.dbClose).toHaveBeenCalledTimes(1);
        expect(h.events.filter(e => e === 'jobs.drain')).toHaveLength(1);
        h.updater.emit('error', new Error('late installer error after shutdown'));
        await flushMain();
        expect(h.events).not.toContain('jobs.resume'); expect(h.dbClose).toHaveBeenCalledTimes(1);
    });

    it.each(['false', 'reject'])('update native preparation %s never invokes installer and permits owned retry', async outcome => {
        const h = await mainHarness(); await h.download();
        h.setNative(() => outcome === 'false' ? Promise.resolve(false) : Promise.reject(new Error('native unsettled')));
        expect((await h.call('update:install')).success).toBe(false);
        expect(h.events).not.toContain('installer'); expect(h.dbClose).not.toHaveBeenCalled(); expect(h.isPaused()).toBe(false);
        h.setNative(async () => true);
        expect(await h.call('update:install')).toEqual({ success: true });
        await h.advance(0); expect(h.quits()).toBe(1);
    });

    it('a blocked update drain reports only the update error; a blocked quit still shows the quit dialog', async () => {
        const h = await mainHarness(); await h.download();
        h.setDrain(async () => false);
        expect(await h.call('update:install')).toEqual({ success: false, error: 'Công việc chưa dừng an toàn. Thử lại sau.' });
        expect(h.events).not.toContain('blocked.message'); expect(h.events).not.toContain('installer');
        expect(h.dialogs).toEqual([]);
        h.app.quit(); await flushMain();
        expect(h.dialogs.map(d => d.title)).toEqual(['Chưa thể thoát']); expect(h.quits()).toBe(0); expect(h.exit).not.toHaveBeenCalled();
    });

    describe('blocked quit offers an explicit force quit', () => {
        const blocked = async () => { const h = await mainHarness(); h.setDrain(async () => false); return h; };
        const FORCE_MESSAGE = 'Thoát ngay khi công việc chưa dừng?';
        it('offers "Để sau" and "Thoát ngay"; "Để sau" keeps the app running with admission and scheduler resumed', async () => {
            const h = await blocked(); h.respond(0);
            h.app.quit(); await flushMain();
            expect(h.dialogs).toHaveLength(1);
            expect(h.dialogs[0]).toMatchObject({ type: 'warning', title: 'Chưa thể thoát', message: 'Công việc hoặc trình duyệt chưa dừng an toàn.',
                buttons: ['Để sau', 'Thoát ngay'], defaultId: 0, cancelId: 0 });
            expect(h.dialogs[0].detail).toContain('Thử lại sau');
            expect(h.exit).not.toHaveBeenCalled(); expect(h.isPaused()).toBe(false); expect(h.events).toContain('scheduler.start');
            expect(h.events).not.toContain('jobs.cancel'); expect(h.dbClose).not.toHaveBeenCalled();
        });
        it('"Thoát ngay" asks for confirmation; "Huỷ" does nothing', async () => {
            const h = await blocked(); h.respond(1, 0);
            h.app.quit(); await flushMain();
            expect(h.dialogs).toHaveLength(2);
            expect(h.dialogs[1]).toMatchObject({ type: 'warning', message: FORCE_MESSAGE, buttons: ['Huỷ', 'Thoát ngay'], defaultId: 0, cancelId: 0 });
            expect(h.dialogs[1].detail).toMatch(/gián đoạn/); expect(h.dialogs[1].detail).toMatch(/không gửi lại|không đăng lại/);
            expect(h.exit).not.toHaveBeenCalled(); expect(h.events).not.toContain('jobs.cancel'); expect(h.dbClose).not.toHaveBeenCalled();
            expect(h.isPaused()).toBe(false);
        });
        it('confirmed force quit cancels without waiting, requests browser close, closes the DB once and exits 0 without retiring or re-draining', async () => {
            const h = await blocked(); h.respond(1, 1);
            h.app.quit(); await flushMain();
            expect(h.exit).toHaveBeenCalledTimes(1); expect(h.exit).toHaveBeenCalledWith(0);
            expect(h.isPaused()).toBe(true);
            for (const e of ['jobs.cancel', 'native.close.unconfirmed', 'scheduler.stop', 'db.close']) expect(h.events).toContain(e);
            expect(h.dbClose).toHaveBeenCalledTimes(1);
            expect(h.events.filter(e => e === 'jobs.drain')).toHaveLength(1);
            expect(h.events).not.toContain('jobs.retire'); expect(h.events).not.toContain('native.retire'); expect(h.quits()).toBe(0);
            expect(h.events.indexOf('jobs.cancel')).toBeLessThan(h.events.indexOf('db.close'));
            expect(h.events.indexOf('native.close.unconfirmed')).toBeLessThan(h.events.indexOf('db.close'));
        });
        it('a second blocked quit or confirmation after force quit cannot exit twice', async () => {
            const h = await blocked(); h.respond(1, 1, 1, 1);
            h.app.quit(); await flushMain();
            h.app.quit(); await flushMain();
            h.call('window:quit'); await flushMain();
            expect(h.exit).toHaveBeenCalledTimes(1); expect(h.dbClose).toHaveBeenCalledTimes(1);
            expect(h.dialogs.filter(d => d.message === FORCE_MESSAGE)).toHaveLength(1);
        });
        it('a throwing step still reaches exit', async () => {
            const h = await blocked(); h.setCancelFailure(true); h.respond(1, 1);
            h.app.quit(); await flushMain();
            expect(h.exit).toHaveBeenCalledTimes(1); expect(h.exit).toHaveBeenCalledWith(0); expect(h.dbClose).toHaveBeenCalledTimes(1);
            expect(h.events).toContain('native.close.unconfirmed');
        });
        it.each([
            ['visible', { visible: true, minimized: false }, true],
            ['hidden in the tray', { visible: false, minimized: false }, false],
            ['minimized', { visible: true, minimized: true }, false],
        ] as const)('parents both dialogs only to a shown window (%s)', async (_label, state, parented) => {
            const h = await blocked(); h.setWindow(state); h.respond(1, 0);
            h.app.quit(); await flushMain();
            expect(h.dialogs).toHaveLength(2);
            expect(h.dialogParents.map(p => p === h.window)).toEqual([parented, parented]);
            expect(h.dialogParents.every(p => p === null)).toBe(!parented);
        });
        it('on macOS an unparented prompt first focuses the app', async () => {
            const h = await mainHarness({ platform: 'darwin' }); h.setDrain(async () => false); h.setWindow({ visible: false }); h.respond(1, 0);
            h.app.quit(); await flushMain();
            expect(h.dialogParents).toEqual([null, null]);
            expect(h.events.filter(e => e === 'app.focus:{"steal":true}')).toHaveLength(2);
            expect(h.events.indexOf('app.focus:{"steal":true}')).toBeLessThan(h.events.indexOf('dialog:Công việc hoặc trình duyệt chưa dừng an toàn.'));
        });
        it('a second blocked quit while the prompt is open opens no second prompt; after "Để sau" a later blocked quit prompts again', async () => {
            const h = await blocked(); h.holdPrompts();
            h.app.quit(); await flushMain();
            h.app.quit(); await flushMain();
            h.call('window:quit'); await flushMain();
            expect(h.dialogs).toHaveLength(1); expect(h.events.filter(e => e === 'jobs.drain').length).toBeGreaterThanOrEqual(2);
            h.answerPrompt(0); await flushMain();
            expect(h.exit).not.toHaveBeenCalled();
            h.app.quit(); await flushMain();
            expect(h.dialogs).toHaveLength(2); expect(h.pendingPrompts()).toBe(1);
            h.answerPrompt(0); await flushMain();
            expect(h.exit).not.toHaveBeenCalled();
        });
        it('a blocked update shows no dialog and never force-exits', async () => {
            const h = await mainHarness(); await h.download(); h.setDrain(async () => false); h.respond(1, 1);
            expect((await h.call('update:install')).success).toBe(false); await flushMain();
            expect(h.dialogs).toEqual([]); expect(h.exit).not.toHaveBeenCalled(); expect(h.events).not.toContain('jobs.cancel');
        });
    });

    it('an update competing with a pending quit neither installs nor resumes the quit pause', async () => {
        const h = await mainHarness(); await h.download();
        const jobs = deferred<boolean>(); h.setDrain(() => jobs.promise);
        h.app.quit(); await flushMain();
        expect((await h.call('update:install')).success).toBe(false);
        expect(h.isPaused()).toBe(true); expect(h.events).not.toContain('jobs.resume'); expect(h.events).not.toContain('installer');
        jobs.resolve(true); await flushMain(); expect(h.quits()).toBe(1);
    });

    it.each([[0, 1, 2], [2, 0, 1], [1, 2, 0]])('deterministic multi-owner stress order %j retains DB through every partial settlement', async (first, second, third) => {
        const h = await mainHarness(); await h.download();
        const owners = [deferred<boolean>(), deferred<boolean>(), deferred<boolean>()]; // two workers and one side waiter
        const native = deferred<boolean>();
        h.setDrain(() => Promise.all(owners.map(owner => owner.promise)).then(values => values.every(Boolean)));
        h.setNative(() => native.promise);
        h.call('window:quit'); h.trayQuit(); h.app.quit(); await flushMain();
        expect((await h.call('update:install')).success).toBe(false);
        for (const index of [first, second]) {
            owners[index].resolve(true); await flushMain();
            expect(h.events).not.toContain('native.drain'); expect(h.dbClose).not.toHaveBeenCalled();
        }
        const close = { prevented: false, preventDefault() { this.prevented = true; } };
        h.window.emit('close', close); expect(close.prevented).toBe(true);
        owners[third].resolve(true); await flushMain();
        expect(h.events).toContain('native.drain'); expect(h.dbClose).not.toHaveBeenCalled();
        await h.advance(5000); expect(h.exit).not.toHaveBeenCalled();
        native.resolve(true); await flushMain();
        expect(h.events.filter(e => e === 'jobs.drain')).toHaveLength(1);
        expect(h.quits()).toBe(1); expect(h.dbClose).toHaveBeenCalledTimes(1);
    });

    it('failed installer releases its owned pause/readiness and a later quit must drain again', async () => {
        const h = await mainHarness(); await h.download();
        h.updater.quitAndInstall = () => { throw new Error('installer failed'); };
        expect((await h.call('update:install')).success).toBe(false);
        expect(h.isPaused()).toBe(false); expect(h.dbClose).not.toHaveBeenCalled();
        const jobs = deferred<boolean>(); h.setDrain(() => jobs.promise);
        h.app.quit(); await flushMain(); expect(h.dbClose).not.toHaveBeenCalled();
        jobs.resolve(true); await flushMain(); expect(h.quits()).toBe(1);
    });
});
