import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Logger from '../../utils/Logger';
import { memoryDb } from '../facebookPoster/helpers';
import { InboxMediaStore } from '../../services/control/InboxMediaStore';
import { RenderClient } from '../../services/video/RenderClient';
import { LOST_CONTACT_MS, VideoService } from '../../services/video/VideoService';
import { VideoStore } from '../../services/video/VideoStore';
import { FakeRenderServer, TEST_KEY } from './helpers';

const server = new FakeRenderServer();
let dir: string;
let clock: number;
let timers: (() => void)[];
let events: { type: string; payload: any }[];
let db: ReturnType<typeof memoryDb>;
let inbox: InboxMediaStore;
let img: string;

beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
    clock = 1_000_000;
    timers = [];
    events = [];
    db = memoryDb();
    new VideoStore(db).ensureSchema();
    inbox = new InboxMediaStore(path.join(dir, 'inbox'));
    img = path.join(dir, 'a.jpg');
    fs.writeFileSync(img, 'jpg');
    server.jobs.clear();
    server.uploads = [];
    server.downloads = [];
    server.failWith = null;
    jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

function makeService(url = server.url): VideoService {
    return new VideoService({
        store: new VideoStore(db), client: () => new RenderClient(url, TEST_KEY), mediaInbox: inbox,
        emit: (type, payload) => events.push({ type, payload }), now: () => clock,
        setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => { timers.pop(); },
        videosDir: path.join(dir, 'videos'),
    });
}
const tplInput = (over: Record<string, unknown> = {}) => ({
    name: 'Video 1', source: 'app' as const, files: [{ path: img, name: 'a.jpg' }],
    template: { id: 'flash-sale', aspect: '9:16', variables: { title: 'Sale', accent: '#ff0000' }, images: ['a.jpg'], musicId: null, ...over },
});
const finished = () => events.filter((e) => e.type === 'videos.finished');

test('render tải lên, lưu dòng queued và phát video:changed', async () => {
    const svc = makeService();
    const job = await svc.render(tplInput());
    expect(job).toMatchObject({ status: 'queued', remoteId: 'remote-1', templateId: 'flash-sale', aspect: '9:16' });
    expect(server.uploads[0].spec.template.id).toBe('flash-sale');
    expect(job.specJson).not.toContain(dir); // không chứa đường dẫn máy
    expect(svc.get(job.id)?.status).toBe('queued');
    expect(events.map((e) => e.type)).toContain('video:changed');
    expect(timers).toHaveLength(1);
});

test('kiểm đầu vào với template.json trước khi tải lên', async () => {
    const svc = makeService();
    const bad = async (over: Record<string, unknown>) => svc.render(tplInput(over)).catch((e) => e.message as string);
    expect(await bad({ aspect: '16:9' })).toMatch(/khổ/);
    expect(await bad({ images: [] })).toMatch(/ảnh/);
    expect(await bad({ variables: { title: 'x'.repeat(11) } })).toMatch(/dài quá 10/);
    expect(await bad({ variables: { accent: 'red' } })).toMatch(/#rrggbb/);
    expect(await bad({ variables: { nope: 'x' } })).toMatch(/không có biến/);
    expect(await bad({ id: 'ghost' })).toMatch(/Không có mẫu/);
    expect(server.uploads).toHaveLength(0);
});

test('theo dõi: các trạng thái, xong thì tải video và bìa đúng một lần', async () => {
    const svc = makeService();
    const job = await svc.render(tplInput());
    svc.startPolling();
    server.jobs.set('remote-1', { status: 'rendering', progress: 0.4 });
    await svc.tick();
    expect(svc.get(job.id)).toMatchObject({ status: 'rendering', progress: 0.4 });
    server.jobs.set('remote-1', { status: 'done', progress: 1, durationSec: 12, sizeBytes: 14 });
    await svc.tick();
    await svc.tick();
    const done = svc.get(job.id)!;
    expect(done).toMatchObject({ status: 'done', durationSec: 12, sizeBytes: 14 });
    expect(fs.existsSync(done.filePath!)).toBe(true);
    expect(fs.existsSync(done.thumbPath!)).toBe(true);
    expect(server.downloads).toEqual(['remote-1/video', 'remote-1/thumb']);
    expect(finished()).toHaveLength(1);
    expect(finished()[0].payload).toEqual({ videoId: job.id, name: 'Video 1', ok: true, durationSec: 12, sizeBytes: 14 });
});

test('việc của bot: chép vào hộp thư và gửi mediaId', async () => {
    const svc = makeService();
    await svc.render({ ...tplInput(), source: 'bot' });
    svc.startPolling();
    server.jobs.set('remote-1', { status: 'done', progress: 1, durationSec: 5, sizeBytes: 14 });
    await svc.tick();
    for (let i = 0; i < 100 && finished().length === 0; i++) await new Promise((r) => setTimeout(r, 10)); // adopt chạy bất đồng bộ
    const payload = finished()[0].payload;
    expect(payload.ok).toBe(true);
    expect(inbox.resolve([payload.mediaId])).toHaveLength(1);
});

test('failed và cancelled từ máy chủ được ghi lại kèm sự kiện', async () => {
    const svc = makeService();
    const job = await svc.render(tplInput());
    svc.startPolling();
    server.jobs.set('remote-1', { status: 'failed', progress: 0.5, error: 'Hết thời gian' });
    await svc.tick();
    expect(svc.get(job.id)).toMatchObject({ status: 'failed', error: 'Hết thời gian' });
    expect(finished()[0].payload).toMatchObject({ ok: false, error: 'Hết thời gian' });
    expect(svc.list().total).toBe(1);
});

test('mở lại app: service mới từ store theo dõi tiếp việc dở', async () => {
    const first = makeService();
    const job = await first.render(tplInput());
    first.stop();
    const second = makeService();
    second.startPolling();
    expect(timers.length).toBeGreaterThan(0);
    server.jobs.set('remote-1', { status: 'done', progress: 1, durationSec: 3, sizeBytes: 14 });
    await second.tick();
    expect(second.get(job.id)?.status).toBe('done');
});

test('chỉ đặt bộ đếm khi có việc dở', () => {
    makeService().startPolling();
    expect(timers).toHaveLength(0);
});

test('mất liên lạc quá 30 phút thì failed; trước đó giữ nguyên trạng thái', async () => {
    const live = makeService();
    const job = await live.render(tplInput());
    const lost = makeService('http://127.0.0.1:1');
    lost.startPolling();
    await lost.tick();
    clock += LOST_CONTACT_MS - 1000;
    await lost.tick();
    expect(lost.get(job.id)?.status).toBe('queued');
    clock += 2000;
    await lost.tick();
    expect(lost.get(job.id)).toMatchObject({ status: 'failed', error: 'Mất liên lạc với máy chủ render' });
    expect(finished()[0].payload.ok).toBe(false);
});

test('máy chủ không còn việc (404) thì failed ngay', async () => {
    const svc = makeService();
    const job = await svc.render(tplInput());
    server.jobs.clear();
    svc.startPolling();
    await svc.tick();
    expect(svc.get(job.id)?.status).toBe('failed');
});

test('huỷ việc đang chờ; việc đang chạy chờ máy chủ báo cancelled', async () => {
    const svc = makeService();
    const queued = await svc.render(tplInput());
    await expect(svc.cancel(queued.id)).resolves.toEqual({ cancelled: true });
    expect(svc.get(queued.id)?.status).toBe('cancelled');
    expect(finished()).toHaveLength(1); // huỷ cục bộ phát đúng một videos.finished
    expect(finished()[0].payload).toEqual({ videoId: queued.id, name: 'Video 1', ok: false, error: 'Đã huỷ' });
    expect(events.map((e) => e.type)).toContain('video:changed');

    const running = await svc.render(tplInput());
    server.jobs.set('remote-2', { status: 'rendering', progress: 0.2 });
    await svc.cancel(running.id);
    expect(svc.get(running.id)?.status).toBe('queued'); // chưa đổi cho tới khi poll thấy cancelled
    server.jobs.set('remote-2', { status: 'cancelled', progress: 0.2 });
    svc.startPolling();
    await svc.tick();
    expect(svc.get(running.id)?.status).toBe('cancelled');
    await expect(svc.cancel(running.id)).resolves.toEqual({ cancelled: false });
});

test('xoá video xoá cả tệp và dòng', async () => {
    const svc = makeService();
    const job = await svc.render(tplInput());
    svc.startPolling();
    server.jobs.set('remote-1', { status: 'done', progress: 1, sizeBytes: 14 });
    await svc.tick();
    const { filePath, thumbPath } = svc.get(job.id)!;
    await svc.delete(job.id);
    expect(fs.existsSync(filePath!)).toBe(false);
    expect(fs.existsSync(thumbPath!)).toBe(false);
    expect(svc.get(job.id)).toBeNull();
    expect(server.jobs.has('remote-1')).toBe(false);
});

test('lỗi máy chủ được phân loại; HTML tự viết không cần mẫu', async () => {
    const svc = makeService();
    server.failWith = 429;
    await expect(svc.render({ name: 'h', source: 'bot', html: { html: '<div/>', width: 1080, height: 1920 }, files: [] })).rejects.toMatchObject({ code: 'limit' });
    server.failWith = null;
    const job = await svc.render({ name: 'h', source: 'bot', html: { html: '<div/>', width: 1080, height: 1920 }, files: [] });
    expect(job.templateId).toBeNull();
    await expect(makeService('').render(tplInput())).rejects.toMatchObject({ code: 'unconfigured' });
    await expect(svc.render({ ...tplInput(), name: ' ' })).rejects.toMatchObject({ code: 'invalid' });
});

test('khoá API không xuất hiện trong log, lỗi hay sự kiện', async () => {
    const logs: string[] = [];
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
        jest.spyOn(Logger, level).mockImplementation(((...a: unknown[]) => { logs.push(a.join(' ')); }) as any);
    }
    const svc = makeService();
    const job = await svc.render(tplInput());
    const lost = makeService('http://127.0.0.1:1');
    lost.startPolling();
    await lost.tick();
    clock += LOST_CONTACT_MS + 1;
    await lost.tick();
    const everything = JSON.stringify([logs, events, svc.get(job.id)]);
    expect(everything).not.toContain(TEST_KEY);
});

test('delete không xoá tệp nằm ngoài thư mục video', async () => {
    const svc = makeService();
    const job = await svc.render(tplInput());
    const outside = path.join(dir, 'precious.txt');
    fs.writeFileSync(outside, 'keep');
    const store = new VideoStore(db);
    store.update(job.id, { filePath: outside, thumbPath: path.join(dir, 'videos', '..', 'precious.txt') });
    await svc.delete(job.id);
    expect(fs.existsSync(outside)).toBe(true);
    expect(svc.get(job.id)).toBeNull();
});

test('delete trong lúc tick đang chạy: không tạo lại tệp, không phát videos.finished', async () => {
    const svc = makeService();
    const job = await svc.render(tplInput());
    svc.startPolling();
    server.jobs.set('remote-1', { status: 'done', progress: 1, sizeBytes: 14 });
    const ticking = svc.tick(); // bắt đầu hỏi máy chủ
    await svc.delete(job.id); // xoá trước khi tick kịp tải
    await ticking;
    expect(svc.get(job.id)).toBeNull();
    expect(finished()).toHaveLength(0);
    const videosDir = path.join(dir, 'videos');
    expect(fs.existsSync(videosDir) ? fs.readdirSync(videosDir) : []).toEqual([]);
});

test('huỷ trong lúc tick thấy done: không ghi đè trạng thái đã huỷ, không phát hai lần', async () => {
    const svc = makeService();
    const job = await svc.render(tplInput());
    svc.startPolling();
    server.jobs.set('remote-1', { status: 'done', progress: 1, sizeBytes: 14 });
    const ticking = svc.tick();
    await svc.cancel(job.id).catch(() => undefined);
    await ticking;
    const status = svc.get(job.id)!.status;
    expect(status).toBe('cancelled'); // DELETE trên việc vừa xong xoá việc phía máy chủ: coi như đã huỷ
    expect(finished()).toHaveLength(1);
});

test('musicPreview tải một lần vào music-cache rồi dùng lại; mã lạ bị từ chối', async () => {
    const svc = makeService();
    const [a, b] = await Promise.all([svc.musicPreview('m1'), svc.musicPreview('m1')]);
    expect(a).toBe(path.join(dir, 'videos', 'music-cache', 'm1.mp3'));
    expect(b).toBe(a);
    expect(fs.readFileSync(a, 'utf8')).toBe('fake-mp3');
    await svc.musicPreview('m1');
    expect(server.downloads.filter((d) => d === '/v1/music/m1')).toHaveLength(1);
    await expect(svc.musicPreview('../x')).rejects.toMatchObject({ code: 'not_found' });
    expect(fs.readdirSync(path.join(dir, 'videos', 'music-cache'))).toEqual(['m1.mp3']);
});
