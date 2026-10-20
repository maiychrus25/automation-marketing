import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RenderClient, RenderError } from '../../services/video/RenderClient';
import { FakeRenderServer, MP3, MP4, TEST_KEY } from './helpers';

const server = new FakeRenderServer();
let dir: string;
beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-')); server.failWith = null; });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const client = () => new RenderClient(server.url, TEST_KEY);
async function code(p: Promise<unknown>): Promise<string> {
    try { await p; } catch (e) { return (e as RenderError).code; }
    return 'no-error';
}

test('health không cần khoá, templates trả mẫu và nhạc', async () => {
    expect((await new RenderClient(server.url, '').health()).ok).toBe(true);
    expect((await client().templates()).templates[0].id).toBe('flash-sale');
});

test('createJob gửi multipart với trường spec và files, trả bảng đổi tên', async () => {
    const img = path.join(dir, 'a.jpg');
    fs.writeFileSync(img, 'jpgdata');
    const created = await client().createJob({ template: { id: 'flash-sale' } }, [{ path: img, name: 'a.jpg' }]);
    expect(created).toMatchObject({ jobId: expect.any(String), status: 'queued', files: { 'a.jpg': 'img1.jpg' } });
    expect(server.uploads.at(-1)).toMatchObject({ spec: { template: { id: 'flash-sale' } }, files: ['a.jpg'] });
});

test('download ghi qua tệp tạm rồi đổi tên', async () => {
    server.jobs.set('d1', { status: 'done', progress: 1 });
    const dest = path.join(dir, 'v.mp4');
    await client().download('d1', 'video', dest);
    expect(fs.readFileSync(dest)).toEqual(MP4);
    expect(fs.readdirSync(dir)).toEqual(['v.mp4']);
});

test('download lỗi không để lại tệp', async () => {
    const dest = path.join(dir, 'v.mp4');
    expect(await code(client().download('missing', 'video', dest))).toBe('not_found');
    expect(fs.readdirSync(dir)).toEqual([]);
});

test('downloadMusic ghi nhạc, mã lạ báo not_found và không để lại tệp', async () => {
    const dest = path.join(dir, 'm1.mp3');
    await client().downloadMusic('m1', dest);
    expect(fs.readFileSync(dest)).toEqual(MP3);
    expect(await code(client().downloadMusic('zzz', path.join(dir, 'z.mp3')))).toBe('not_found');
    expect(fs.readdirSync(dir)).toEqual(['m1.mp3']);
});

test('lỗi được phân loại', async () => {
    expect(await code(new RenderClient('', '').templates())).toBe('unconfigured');
    expect(await code(new RenderClient(server.url, '').templates())).toBe('unconfigured');
    expect(await code(new RenderClient('http://127.0.0.1:1', TEST_KEY).templates())).toBe('unreachable');
    expect(await code(client().job('nope'))).toBe('not_found');
    for (const [status, expected] of [[429, 'limit'], [400, 'invalid'], [413, 'invalid'], [500, 'server'], [503, 'server']] as const) {
        server.failWith = status;
        expect(await code(client().job('x'))).toBe(expected);
    }
});

test('khoá API không bao giờ xuất hiện trong lỗi', async () => {
    const wrong = new RenderClient(server.url, 'sai-khoa');
    const err = (await wrong.templates().catch((e) => e)) as RenderError;
    expect(err.code).toBe('invalid');
    expect(err.message).not.toContain('sai-khoa');
    const unreachable = (await new RenderClient('http://127.0.0.1:1', TEST_KEY).job('x').catch((e) => e)) as RenderError;
    expect(`${unreachable.message}${unreachable.stack}`).not.toContain(TEST_KEY);
});
