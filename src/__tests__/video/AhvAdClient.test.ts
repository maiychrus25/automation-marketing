import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AhvAdClient, adStepText } from '../../services/video/AhvAdClient';
import { RenderError } from '../../services/video/RenderClient';
import { AHV_KEY, FakeAhvServer, MP4 } from './helpers';

let server: FakeAhvServer;
let dir: string;
const client = (key = AHV_KEY, base?: string) => new AhvAdClient(base ?? server.url, key);

beforeEach(async () => {
    server = new FakeAhvServer();
    await server.start();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahv-test-'));
});
afterEach(async () => {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
});

const file = (name: string, body = 'xx') => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
const caught = async (fn: () => Promise<unknown>): Promise<RenderError> => {
    try { await fn(); } catch (e) { return e as RenderError; }
    throw new Error('không ném lỗi');
};

test('upload trả link công khai; tệp không đọc được hoặc máy chủ từ chối thì invalid', async () => {
    const url = await client().upload(file('a.jpg'), 'a.jpg');
    expect(url).toContain('/public/uploads/');
    expect(server.uploads[0].filename).toBe('a.jpg');

    expect((await caught(() => client().upload(path.join(dir, 'khong-co.jpg'), 'khong-co.jpg'))).code).toBe('invalid');
    server.failUpload = [400, { ok: false, error: 'File type .exe not allowed' }];
    const err = await caught(() => client().upload(file('b.jpg'), 'b.jpg'));
    expect(err.code).toBe('invalid');
    expect(err.message).toContain('not allowed');
});

test('createJob gửi task ad_video, khoá X-API-Key và webhook; trả jobId + predictTime', async () => {
    const created = await client().createJob({ scenes: [] }, 'https://hook.example/x');
    expect(created).toEqual({ jobId: 'ad-1', predictTime: 780 });
    expect(server.creates[0]).toMatchObject({ key: AHV_KEY, body: { task: 'ad_video', payload: { scenes: [] }, webhook_url: 'https://hook.example/x' } });
    await client().createJob({ scenes: [] });
    expect(server.creates[1].body.webhook_url).toBeUndefined();
});

test('mã lỗi của AHV đổi thành RenderErrorCode đã có, không thêm mã mới', async () => {
    const cases: [number, unknown, string][] = [
        [400, { ok: false, error: { code: 400, reason: 'AD_SCENES', message: 'scenes phải là danh sách 2 đến 10 cảnh' } }, 'invalid'],
        [429, { ok: false, error: { code: 429, reason: 'AD_QUEUE_FULL', message: 'Hàng chờ đã đầy' } }, 'limit'],
        [429, { detail: 'queue full, try again later' }, 'limit'],
        [503, { ok: false, error: { code: 503, reason: 'AD_DISABLED', message: 'Tính năng đang tắt' } }, 'limit'],
        [502, { ok: false, error: { code: 502, reason: 'AD_IMAGE_FAILED', message: 'Tạo ảnh thất bại' } }, 'server'],
        [500, { detail: 'boom' }, 'server'],
    ];
    for (const [status, body, code] of cases) {
        server.failCreate = [status, body];
        expect((await caught(() => client().createJob({}))).code).toBe(code);
    }
    server.failCreate = null;
    expect((await caught(() => client('sai-khoa').createJob({}))).code).toBe('invalid'); // 401
    expect((await caught(() => client().job('khong-co'))).code).toBe('not_found'); // 404
    expect((await caught(() => client(AHV_KEY, 'http://127.0.0.1:1').createJob({}))).code).toBe('unreachable');
    expect((await caught(() => new AhvAdClient('', '').createJob({}))).code).toBe('unconfigured');
    expect((await caught(() => new AhvAdClient(server.url, '').createJob({}))).code).toBe('unconfigured');
});

test('thông báo lỗi không bao giờ chứa khoá API', async () => {
    const err = await caught(() => client('ahv-test-key-WRONG').createJob({}));
    expect(err.message).not.toContain('ahv-test-key-WRONG');
    expect(err.message).toContain('***');
});

test('job đọc được step đủ/thiếu trường, trạng thái lạ không ném', async () => {
    await client().createJob({});
    server.jobs.set('ad-1', { status: 'running', progress: 40, step: { name: 'h3', k: 3, n: 7 } });
    expect(await client().job('ad-1')).toMatchObject({ status: 'running', progress: 40, step: { name: 'h3', k: 3, n: 7 } });
    server.jobs.set('ad-1', { status: 'la-lung', progress: 0, step: { name: 'moi' } as any });
    const view = await client().job('ad-1');
    expect(view.status).toBe('la-lung');
    expect(view.step).toEqual({ name: 'moi' });
    server.jobs.set('ad-1', { status: 'running', progress: 5 });
    expect((await client().job('ad-1')).step).toBeUndefined();
});

test('voices trả danh sách giọng', async () => {
    expect(await client().voices()).toEqual([{ id: 'hai_dang', name: 'Hải Đăng', gender: 'male', region: 'bac' }]);
});

test('download ghi qua .part rồi đổi tên; lỗi giữa chừng không để lại tệp nào', async () => {
    const dest = path.join(dir, 'out.mp4');
    await client().download(`${server.url}/public/ad/x/video.mp4`, dest);
    expect(fs.readFileSync(dest)).toEqual(MP4);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);

    const dest2 = path.join(dir, 'cut.mp4');
    server.cutDownload = true;
    await expect(client().download(`${server.url}/public/ad/x/video.mp4`, dest2)).rejects.toThrow();
    expect(fs.existsSync(dest2)).toBe(false);
    expect(fs.existsSync(`${dest2}.part`)).toBe(false);

    server.cutDownload = false;
    // link kết quả đã quá 7 ngày: tệp tĩnh trả 404 (đường /public của AHV không cần khoá)
    expect((await caught(() => client().download(`${server.url}/public/ad/hethan/video.mp4`, path.join(dir, 'z.mp4')))).code).toBe('not_found');
    expect(fs.existsSync(path.join(dir, 'z.mp4'))).toBe(false);
});

test('adStepText hiện đúng tên bước, chịu được tên lạ và step vắng mặt', () => {
    expect(adStepText({ name: 'giong', k: 2, n: 9 }, 20)).toBe('Đọc lời 2/9');
    expect(adStepText({ name: 'anh', k: 1, n: 4 }, 30)).toBe('Tạo ảnh 1/4');
    expect(adStepText({ name: 'h3', k: 3, n: 7 }, 40)).toBe('H3 3/7');
    expect(adStepText({ name: 'khop_moi', k: 1, n: 2 }, 60)).toBe('Khớp môi 1/2');
    expect(adStepText({ name: 'nhuong_khach' }, 45)).toBe('Nhường máy cho khách khác');
    expect(adStepText({ name: 'buoc_moi', k: 1, n: 3 }, 50)).toBe('buoc_moi 1/3');
    expect(adStepText({ name: 'buoc_moi' }, 50)).toBe('buoc_moi');
    expect(adStepText(undefined, 90)).toBe('Đang dựng video');
    expect(adStepText(undefined, 40)).toBe('');
    expect(adStepText(undefined, 0)).toBe('');
});
