import { EventEmitter } from 'events';
import { UpdateService, type UpdateState, type ReleaseInfo } from '../../services/update/UpdateService';

const RELEASE: ReleaseInfo = {
    tag_name: 'v26.11.0',
    html_url: 'https://github.com/maiychrus25/automation-marketing/releases/tag/v26.11.0',
    body: 'Dòng 1\nDòng 2\nDòng 3\nDòng 4',
};

function fakeUpdater() {
    const ee = new EventEmitter() as any;
    ee.calls = [] as string[];
    ee.checkForUpdates = async () => { ee.calls.push('check'); return { isUpdateAvailable: true }; };
    ee.downloadUpdate = async () => { ee.calls.push('download'); };
    ee.quitAndInstall = (silent: boolean, run: boolean) => { ee.calls.push(`install:${silent}:${run}`); };
    return ee;
}

function make(over: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
    const states: UpdateState[] = [];
    const opened: string[] = [];
    const updater = fakeUpdater();
    const service = new UpdateService({
        currentVersion: '26.10.0',
        canInstall: true,
        fetchLatestRelease: async () => RELEASE,
        updater,
        isBusy: () => false,
        openExternal: (url) => { opened.push(url); },
        emit: (s) => { states.push(s); },
        ...over,
    });
    return { service, states, opened, updater };
}

describe('UpdateService.check', () => {
    test('có bản mới hơn thì chuyển sang available với phiên bản, ghi chú và link', async () => {
        const { service, states } = make();
        const state = await service.check();
        expect(state).toEqual({
            status: 'available', version: '26.11.0', notes: 'Dòng 1\nDòng 2\nDòng 3', url: RELEASE.html_url, canInstall: true,
        });
        expect(states[states.length - 1]).toEqual(state);
    });

    test('bản trên GitHub bằng bản đang chạy thì về idle', async () => {
        const { service } = make({ currentVersion: '26.11.0' });
        expect((await service.check()).status).toBe('idle');
    });

    test('lỗi mạng hoặc kho trả 404 thì về idle, không hiện lỗi cho người dùng', async () => {
        const logs: string[] = [];
        const { service } = make({ fetchLatestRelease: async () => { throw new Error('HTTP 404'); }, log: (m) => logs.push(m) });
        expect((await service.check()).status).toBe('idle');
        expect(logs.join(' ')).toMatch(/HTTP 404/);
    });

    test('bản nháp hoặc pre-release thì bỏ qua', async () => {
        const { service } = make({ fetchLatestRelease: async () => ({ ...RELEASE, prerelease: true }) });
        expect((await service.check()).status).toBe('idle');
    });

    test('đang tải hoặc đã tải xong thì kiểm tra lại không làm mất trạng thái', async () => {
        const { service, updater } = make();
        await service.check();
        await service.download();
        updater.emit('update-downloaded', { version: '26.11.0' });
        expect((await service.check()).status).toBe('downloaded');
    });
});

describe('UpdateService periodic re-check', () => {
    test('kiểm tra lại khi đang có bản mới: không phát trạng thái trung gian làm thẻ chớp tắt', async () => {
        const { service, states } = make();
        await service.check();
        const before = states.length;
        await service.check();
        expect(states.slice(before).every((s) => s.status === 'available')).toBe(true);
    });

    test('kiểm tra lại mà lỗi mạng thì giữ nguyên bản mới đã biết', async () => {
        let fail = false;
        const { service } = make({ fetchLatestRelease: async () => { if (fail) throw new Error('rate limit'); return RELEASE; } });
        await service.check();
        fail = true;
        expect((await service.check()).status).toBe('available');
        expect((await service.download()).success).toBe(true);
    });

    test('kiểm tra lại mà lỗi mạng khi đang ở trạng thái lỗi thì giữ trạng thái lỗi để còn bấm Thử lại', async () => {
        let fail = false;
        const { service, updater } = make({ fetchLatestRelease: async () => { if (fail) throw new Error('offline'); return RELEASE; } });
        updater.downloadUpdate = async () => { throw new Error('ECONNRESET'); };
        await service.check();
        await service.download();
        fail = true;
        expect((await service.check()).status).toBe('error');
    });

    test('hai lần kiểm tra chồng nhau thì chỉ gọi GitHub một lần', async () => {
        let calls = 0;
        let release!: () => void;
        const { service } = make({ fetchLatestRelease: () => { calls++; return new Promise((r) => { release = () => r(RELEASE); }); } });
        const first = service.check();
        const second = service.check();
        release();
        await Promise.all([first, second]);
        expect(calls).toBe(1);
    });
});

describe('UpdateService notes', () => {
    test('ghi chú tự sinh của GitHub: bỏ tiêu đề Markdown, dòng Full Changelog và dấu đầu dòng', async () => {
        const body = "## What's Changed\r\n* feat: Đăng Facebook by @a in https://x/pull/6\r\n- fix: lỗi nhỏ\r\n\r\n**Full Changelog**: https://x/compare/a...b";
        const { service } = make({ fetchLatestRelease: async () => ({ ...RELEASE, body }) });
        const state = await service.check();
        expect(state).toMatchObject({ status: 'available', notes: 'feat: Đăng Facebook by @a in https://x/pull/6\nfix: lỗi nhỏ' });
    });
});

describe('UpdateService.download', () => {
    test('nền tảng tự cài được: kiểm tra rồi tải qua electron-updater, có tiến độ, xong thì downloaded', async () => {
        const { service, states, updater } = make();
        await service.check();
        const res = await service.download();
        expect(res).toEqual({ success: true });
        expect(updater.calls).toEqual(['check', 'download']);
        expect(service.getState()).toEqual({ status: 'downloading', version: '26.11.0', percent: 0 });
        updater.emit('download-progress', { percent: 42.6 });
        expect(service.getState()).toEqual({ status: 'downloading', version: '26.11.0', percent: 43 });
        updater.emit('update-downloaded', { version: '26.11.0' });
        expect(states[states.length - 1]).toEqual({ status: 'downloaded', version: '26.11.0' });
    });

    test('nền tảng không tự cài được: mở trang phát hành, không gọi electron-updater', async () => {
        const { service, opened, updater } = make({ canInstall: false });
        await service.check();
        expect((service.getState() as any).canInstall).toBe(false);
        expect(await service.download()).toEqual({ success: true });
        expect(opened).toEqual([RELEASE.html_url]);
        expect(updater.calls).toEqual([]);
    });

    test('tải lỗi thì chuyển sang error có thông báo, thử lại được', async () => {
        const { service, updater } = make();
        updater.downloadUpdate = async () => { throw new Error('ECONNRESET'); };
        await service.check();
        const res = await service.download();
        expect(res.success).toBe(false);
        expect(service.getState()).toEqual({ status: 'error', message: 'Không tải được bản cập nhật: ECONNRESET', version: '26.11.0' });
        updater.downloadUpdate = async () => { updater.calls.push('download'); };
        expect((await service.download()).success).toBe(true);
    });

    test('lỗi dài nhiều dòng (header HTTP, stack) thì thẻ chỉ hiện dòng đầu, tối đa 160 ký tự; log giữ bản đầy đủ', async () => {
        const logs: string[] = [];
        const { service, updater } = make({ log: (m) => logs.push(m) });
        const longLine = 'Cannot find latest-linux.yml in the latest release artifacts (https://github.com/x/releases/download/v26.10.0/latest-linux.yml): HttpError: 404';
        updater.downloadUpdate = async () => { throw new Error(longLine + '\nHeaders: {\n  "server": "github.com"\n}\n    at createHttpError (x.js:21:12)'); };
        await service.check();
        await service.download();
        const state = service.getState() as { status: string; message: string };
        expect(state.status).toBe('error');
        expect(state.message.startsWith('Không tải được bản cập nhật: Cannot find latest-linux.yml')).toBe(true);
        expect(state.message).not.toMatch(/Headers|createHttpError/);
        expect(state.message.length).toBeLessThanOrEqual('Không tải được bản cập nhật: '.length + 160);
        expect(logs.join('\n')).toMatch(/createHttpError/);
    });

    test('bản phát hành thiếu tệp mô tả hoặc lệch phiên bản (checkForUpdates không thấy bản mới) thì báo lỗi rõ, không tải', async () => {
        const { service, updater } = make();
        updater.checkForUpdates = async () => { updater.calls.push('check'); return { isUpdateAvailable: false }; };
        await service.check();
        const res = await service.download();
        expect(res.success).toBe(false);
        expect(service.getState()).toMatchObject({ status: 'error', message: expect.stringMatching(/không có bản 26\.11\.0 để tải tự động/) });
        expect(updater.calls).toEqual(['check']);
    });

    test('sự kiện error của electron-updater khi đang tải cũng chuyển sang error', async () => {
        const { service, updater } = make();
        await service.check();
        await service.download();
        updater.emit('error', new Error('sha512 checksum mismatch'));
        expect(service.getState()).toMatchObject({ status: 'error', version: '26.11.0' });
    });

    test('chưa có bản mới thì không tải', async () => {
        const { service, updater } = make({ currentVersion: '26.11.0' });
        await service.check();
        expect(await service.download()).toEqual({ success: false, error: 'Không có bản mới để tải' });
        expect(updater.calls).toEqual([]);
    });

    test('bấm tải hai lần khi đang tải thì không tải trùng', async () => {
        const { service, updater } = make();
        await service.check();
        await service.download();
        expect(await service.download()).toEqual({ success: false, error: 'Đang tải bản cập nhật' });
        expect(updater.calls).toEqual(['check', 'download']);
    });
});

describe('UpdateService.install', () => {
    async function downloaded(over = {}) {
        const ctx = make(over);
        await ctx.service.check();
        await ctx.service.download();
        ctx.updater.emit('update-downloaded', { version: '26.11.0' });
        return ctx;
    }

    test('đã tải xong thì khởi động lại để cài, mở lại app sau khi cài', async () => {
        const { service, updater } = await downloaded();
        expect(service.install()).toEqual({ success: true });
        expect(updater.calls).toContain('install:false:true');
    });

    test('đang có việc Đăng Facebook thì từ chối, không khởi động lại', async () => {
        const { service, updater } = await downloaded({ isBusy: () => true });
        expect(service.install()).toEqual({
            success: false, error: 'Đang có việc Đăng Facebook chạy. Đợi xong hoặc huỷ rồi khởi động lại.',
        });
        expect(updater.calls.some((c: string) => c.startsWith('install'))).toBe(false);
    });

    test('chưa tải xong thì không cài', async () => {
        const { service, updater } = make();
        await service.check();
        expect(service.install()).toEqual({ success: false, error: 'Chưa tải xong bản cập nhật' });
        expect(updater.calls).toEqual([]);
    });
});
