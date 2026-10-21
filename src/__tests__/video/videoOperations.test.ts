import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { createVideoOperations, routeVideoEvent, type VideoOperationsDeps } from '../../services/video/videoOperations';
import { RenderError } from '../../services/video/RenderClient';
import type { VideoJob } from '../../models/video';

let dir: string;
let img1: string;
let img2: string;
let music: string;

const job = (over: Partial<VideoJob> = {}): VideoJob => ({
    id: 'v1', remoteId: 'r1', name: 'Video', source: 'bot', templateId: 'flash-sale', aspect: '9:16', specJson: '{}',
    status: 'done', progress: 1, error: '', filePath: path.join(dir, 'out.mp4'), thumbPath: path.join(dir, 'out.jpg'),
    sizeBytes: 10, durationSec: 20, createdAt: 1, finishedAt: 2, ...over,
});

function setup(over: Partial<VideoOperationsDeps> = {}) {
    const service = {
        templates: jest.fn(async () => ({ templates: [{ id: 'flash-sale' }], music: [] })),
        render: jest.fn(async (_input: any) => job({ status: 'queued' })),
        get: jest.fn((id: string): VideoJob | null => (id === 'v1' ? job() : null)),
        list: jest.fn((_opts: any) => ({ videos: [job()], total: 1 })),
        musicPreview: jest.fn(async (id: string) => path.join(dir, `${id}.mp3`)),
        cancel: jest.fn(async (_id: string) => ({ cancelled: true })),
        delete: jest.fn(async (_id: string) => undefined),
    };
    const store = { value: { url: 'https://r.example', apiKey: 'abcd1234' } };
    const deps: VideoOperationsDeps = {
        service: () => service as any,
        loadSettings: () => store.value,
        saveSettings: jest.fn((input: any) => { store.value = { url: input.url, apiKey: input.apiKey || store.value.apiKey }; return store.value; }),
        client: () => ({
            health: async () => ({ ok: true, version: '1.2', hyperframes: '0.8.181', queue: { length: 0 } }),
            templates: async () => ({ templates: [{ id: 'a' }, { id: 'b' }], music: [] }),
        }) as any,
        resolveMedia: jest.fn((ids: string[]) => ids.map((id) => (id === 'song' ? music : path.join(dir, `${id}.jpg`)))),
        pickSavePath: jest.fn(async (_name: string) => path.join(dir, 'saved.mp4')),
        ...over,
    };
    return { ops: createVideoOperations(deps), service, deps };
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-'));
    img1 = path.join(dir, 'm1.jpg');
    img2 = path.join(dir, 'm2.png');
    music = path.join(dir, 'song.mp3');
    for (const f of [img1, img2, music, path.join(dir, 'm2.jpg'), path.join(dir, 'out.mp4')]) fs.writeFileSync(f, 'x');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('settings', () => {
    test('settingsGet chỉ lộ 4 ký tự cuối của khoá', () => {
        const { ops } = setup();
        expect(ops.settingsGet()).toEqual({ url: 'https://r.example', apiKeyHint: '••••1234', configured: true });
        expect(JSON.stringify(ops.settingsGet())).not.toContain('abcd');
    });
    test('settingsGet báo chưa cấu hình khi thiếu khoá hoặc địa chỉ', () => {
        const { ops } = setup({ loadSettings: () => ({ url: '', apiKey: '' }) });
        expect(ops.settingsGet()).toEqual({ url: '', apiKeyHint: '', configured: false });
    });
    test('settingsSet lưu rồi trả cùng dạng với settingsGet', () => {
        const { ops, deps } = setup();
        expect(ops.settingsSet({ url: 'https://new.example', apiKey: 'zzzz9999' })).toEqual({ url: 'https://new.example', apiKeyHint: '••••9999', configured: true });
        expect(deps.saveSettings).toHaveBeenCalledWith({ url: 'https://new.example', apiKey: 'zzzz9999' });
    });
    test('settingsSet từ chối url không phải chuỗi và khoá không phải chuỗi', () => {
        const { ops } = setup();
        expect(() => ops.settingsSet({ url: 5 })).toThrow('Địa chỉ máy chủ render không hợp lệ');
        expect(() => ops.settingsSet({ url: 'https://x', apiKey: 5 })).toThrow('Khoá API không hợp lệ');
    });
    test('testConnection gọi health rồi templates', async () => {
        const { ops } = setup();
        expect(await ops.testConnection()).toEqual({ version: '1.2', templateCount: 2 });
    });
});

describe('render', () => {
    const base = { name: ' Flash ', templateId: 'flash-sale', aspect: '9:16', variables: { title: 'Sale' } };

    test('bot: imageIds và musicMediaId được đổi sang đường dẫn, tên tệp gửi lên đặt lại theo thứ tự', async () => {
        const { ops, service, deps } = setup();
        const res = await ops.render({ ...base, imageIds: ['m1', 'm2'], musicMediaId: 'song', fps: 24, quality: 'high' }, 'bot');
        expect(res).toEqual({ videoId: 'v1', status: 'queued' });
        expect(deps.resolveMedia).toHaveBeenCalledWith(['m1', 'm2']);
        expect(deps.resolveMedia).toHaveBeenCalledWith(['song']);
        const input = service.render.mock.calls[0][0];
        expect(input).toMatchObject({
            name: 'Flash', source: 'bot', fps: 24, quality: 'high',
            template: { id: 'flash-sale', aspect: '9:16', variables: { title: 'Sale' }, images: ['image1.jpg', 'image2.jpg'], musicFile: 'music.mp3' },
        });
        expect(input.files.map((f: any) => f.name)).toEqual(['image1.jpg', 'image2.jpg', 'music.mp3']);
    });

    test('app: imagePaths và musicPath là đường dẫn tệp, source = app', async () => {
        const { ops, service, deps } = setup();
        await ops.render({ ...base, imagePaths: [img1, img2], musicPath: music }, 'app');
        expect(deps.resolveMedia).not.toHaveBeenCalled();
        const input = service.render.mock.calls[0][0];
        expect(input.source).toBe('app');
        expect(input.template.images).toEqual(['image1.jpg', 'image2.png']);
        expect(input.template.musicFile).toBe('music.mp3');
        expect(input.files[0]).toEqual({ path: img1, name: 'image1.jpg' });
    });

    test('musicId có sẵn đi thẳng vào template; musicId và tệp nhạc cùng lúc bị từ chối', async () => {
        const { ops, service } = setup();
        await ops.render({ ...base, imageIds: ['m1'], musicId: 'calm' }, 'bot');
        expect(service.render.mock.calls[0][0].template.musicId).toBe('calm');
        await expect(ops.render({ ...base, imageIds: ['m1'], musicId: 'calm', musicMediaId: 'song' }, 'bot')).rejects.toThrow('Chỉ chọn một');
    });

    test('musicMediaId phải là nhạc (mp3/m4a/wav), ảnh hoặc video bị từ chối', async () => {
        const { ops, service } = setup();
        await expect(ops.render({ ...base, imageIds: ['m1'], musicMediaId: 'm2' }, 'bot')).rejects.toThrow('Tệp nhạc phải là');
        await expect(ops.render({ ...base, imagePaths: [img1], musicPath: path.join(dir, 'out.mp4') }, 'app')).rejects.toThrow('Tệp nhạc phải là');
        expect(service.render).not.toHaveBeenCalled();
    });

    test('chế độ HTML: assetIds thành asset<n>.<đuôi>, width/height thành số nguyên', async () => {
        const { ops, service } = setup();
        await ops.render({ name: 'H', html: '<div/>', width: 1080, height: 1920, assetIds: ['m1', 'm2'] }, 'bot');
        const input = service.render.mock.calls[0][0];
        expect(input.html).toEqual({ html: '<div/>', width: 1080, height: 1920 });
        expect(input.template).toBeUndefined();
        expect(input.files.map((f: any) => f.name)).toEqual(['asset1.jpg', 'asset2.jpg']);
    });

    test.each([
        ['thiếu tên', { ...base, name: '', imageIds: ['m1'] }, 'Tên video'],
        ['tên quá 100 ký tự', { ...base, name: 'x'.repeat(101), imageIds: ['m1'] }, 'Tên video'],
        ['tên không phải chuỗi', { ...base, name: 5, imageIds: ['m1'] }, 'Tên video'],
        ['vừa mẫu vừa HTML', { ...base, imageIds: ['m1'], html: '<p/>', width: 1, height: 1 }, 'đúng một'],
        ['không mẫu không HTML', { name: 'x' }, 'đúng một'],
        ['thiếu aspect', { name: 'x', templateId: 'flash-sale', imageIds: ['m1'] }, 'aspect'],
        ['variables không phải đối tượng', { ...base, variables: [1], imageIds: ['m1'] }, 'variables'],
        ['imageIds không phải mảng', { ...base, imageIds: 'm1' }, 'imageIds'],
        ['imageIds rỗng', { ...base, imageIds: [] }, 'imageIds'],
        ['quá 20 ảnh', { ...base, imageIds: Array.from({ length: 21 }, (_, i) => `i${i}`) }, 'imageIds'],
        ['phần tử imageIds không phải chuỗi', { ...base, imageIds: [5] }, 'imageIds'],
        ['fps lạ', { ...base, imageIds: ['m1'], fps: 60 }, 'fps'],
        ['quality lạ', { ...base, imageIds: ['m1'], quality: 'ultra' }, 'quality'],
        ['html không phải chuỗi', { name: 'x', html: 5, width: 1, height: 1 }, 'html'],
        ['width không phải số nguyên', { name: 'x', html: '<p/>', width: 1.5, height: 1 }, 'width'],
        ['assetIds quá 20', { name: 'x', html: '<p/>', width: 1, height: 1, assetIds: Array.from({ length: 21 }, (_, i) => `a${i}`) }, 'assetIds'],
    ])('bot từ chối: %s', async (_label, params, fragment) => {
        const { ops, service } = setup();
        await expect(ops.render(params, 'bot')).rejects.toThrow(fragment);
        expect(service.render).not.toHaveBeenCalled();
    });

    test('bot: mediaId không tồn tại trên đĩa bị từ chối trước khi gọi máy chủ', async () => {
        const { ops, service } = setup();
        await expect(ops.render({ ...base, imageIds: ['ghost'] }, 'bot')).rejects.toThrow('không tồn tại hoặc đã hết hạn');
        expect(service.render).not.toHaveBeenCalled();
    });

    test('app: đường dẫn tương đối hoặc tệp không tồn tại bị từ chối', async () => {
        const { ops } = setup();
        await expect(ops.render({ ...base, imagePaths: ['rel/a.jpg'] }, 'app')).rejects.toThrow('imagePaths');
        await expect(ops.render({ ...base, imagePaths: [path.join(dir, 'nope.jpg')] }, 'app')).rejects.toThrow('Không đọc được tệp');
    });

    test('lỗi của VideoService (ví dụ chưa cấu hình) đi qua nguyên vẹn', async () => {
        const { ops, service } = setup();
        service.render.mockRejectedValueOnce(new RenderError('unconfigured', 'Chưa cấu hình máy chủ render video'));
        await expect(ops.render({ ...base, imageIds: ['m1'] }, 'bot')).rejects.toMatchObject({ code: 'unconfigured' });
    });
});

describe('status, list, cancel, delete', () => {
    test('status bot bỏ đường dẫn máy; app giữ đủ', () => {
        const { ops } = setup();
        const bot = ops.status({ videoId: 'v1' }, 'bot').video as any;
        expect(bot).not.toHaveProperty('filePath');
        expect(bot).not.toHaveProperty('thumbPath');
        expect(bot).not.toHaveProperty('specJson');
        expect(bot).toMatchObject({ id: 'v1', status: 'done', name: 'Video' });
        expect(ops.status({ videoId: 'v1' }, 'app').video).toHaveProperty('filePath');
    });
    test('status: thiếu videoId -> lỗi tham số; không có -> not_found', () => {
        const { ops } = setup();
        expect(() => ops.status({}, 'bot')).toThrow('videoId');
        expect(() => ops.status({ videoId: 'zzz' }, 'bot')).toThrow(RenderError);
        try { ops.status({ videoId: 'zzz' }, 'bot'); } catch (e: any) { expect(e.code).toBe('not_found'); }
    });
    test('list kiểm tra status/limit/offset và bỏ đường dẫn cho bot', () => {
        const { ops, service } = setup();
        const res = ops.list({ status: 'done', limit: 10, offset: 2 }, 'bot');
        expect(service.list).toHaveBeenCalledWith({ status: 'done', limit: 10, offset: 2 });
        expect(res.total).toBe(1);
        expect(res.videos[0]).not.toHaveProperty('filePath');
        expect(() => ops.list({ status: 'weird' }, 'bot')).toThrow('status');
        expect(() => ops.list({ limit: 0 }, 'bot')).toThrow('limit');
        expect(() => ops.list({ limit: 101 }, 'bot')).toThrow('limit');
        expect(() => ops.list({ offset: -1 }, 'bot')).toThrow('offset');
    });
    test('cancel và delete cần videoId', async () => {
        const { ops, service } = setup();
        expect(await ops.cancel({ videoId: 'v1' })).toEqual({ cancelled: true });
        expect(service.cancel).toHaveBeenCalledWith('v1');
        await expect(ops.cancel({})).rejects.toThrow('videoId');
        await ops.delete({ videoId: 'v1' });
        expect(service.delete).toHaveBeenCalledWith('v1');
        await expect(ops.delete({ videoId: '' })).rejects.toThrow('videoId');
    });
});

describe('musicPreview', () => {
    test('trả đường dẫn nhạc đã tải', async () => {
        const { ops, service } = setup();
        expect(await ops.musicPreview({ musicId: 'm1' })).toEqual({ path: path.join(dir, 'm1.mp3') });
        expect(service.musicPreview).toHaveBeenCalledWith('m1');
    });
    test('thiếu musicId bị từ chối', async () => {
        const { ops } = setup();
        await expect(ops.musicPreview({})).rejects.toMatchObject({ code: 'invalid' });
        await expect(ops.musicPreview({ musicId: 5 })).rejects.toMatchObject({ code: 'invalid' });
    });
});

describe('exportFile', () => {
    test('chép tệp MP4 tới nơi người dùng chọn', async () => {
        const { ops, deps } = setup();
        const res = await ops.exportFile({ videoId: 'v1' });
        expect(res).toEqual({ saved: true, path: path.join(dir, 'saved.mp4') });
        expect(fs.readFileSync(path.join(dir, 'saved.mp4'), 'utf8')).toBe('x');
        expect(deps.pickSavePath).toHaveBeenCalledWith('Video.mp4');
    });
    test('người dùng đóng hộp thoại -> saved false', async () => {
        const { ops } = setup({ pickSavePath: async () => null });
        expect(await ops.exportFile({ videoId: 'v1' })).toEqual({ saved: false });
    });
    test('video chưa xong hoặc mất tệp bị từ chối', async () => {
        const { ops, service } = setup();
        service.get.mockReturnValueOnce(job({ status: 'rendering', filePath: null }));
        await expect(ops.exportFile({ videoId: 'v1' })).rejects.toThrow('chưa render xong');
        service.get.mockReturnValueOnce(job({ filePath: path.join(dir, 'gone.mp4') }));
        await expect(ops.exportFile({ videoId: 'v1' })).rejects.toThrow('không còn');
        await expect(ops.exportFile({ videoId: 'zzz' })).rejects.toMatchObject({ code: 'not_found' });
    });
});

describe('routeVideoEvent', () => {
    test('video:changed đi tới renderer, videos.finished đi tới Control API với đúng trường', () => {
        const broadcast = jest.fn();
        const emitControl = jest.fn();
        routeVideoEvent({ broadcast, emitControl }, 'video:changed');
        expect(broadcast).toHaveBeenCalledWith('video:changed');
        expect(emitControl).not.toHaveBeenCalled();
        routeVideoEvent({ broadcast, emitControl }, 'videos.finished', { videoId: 'v1', name: 'N', ok: true, durationSec: 20, sizeBytes: 5, mediaId: 'm', extra: 1 });
        expect(emitControl).toHaveBeenCalledWith('videos.finished', { videoId: 'v1', name: 'N', ok: true, durationSec: 20, sizeBytes: 5, mediaId: 'm' });
        expect(broadcast).toHaveBeenCalledTimes(1);
    });
});

describe('openFile', () => {
    const read = async (stream: Readable) => { const parts: Buffer[] = []; for await (const c of stream) parts.push(c as Buffer); return Buffer.concat(parts); };
    const failure = async (p: Promise<unknown>) => p.then(() => null, (e) => e);

    test('trả luồng và kích thước đúng cho video và ảnh bìa', async () => {
        fs.writeFileSync(path.join(dir, 'out.mp4'), 'video-bytes');
        fs.writeFileSync(path.join(dir, 'out.jpg'), 'jpg');
        const { ops } = setup();
        const video = await ops.openFile({ videoId: 'v1' });
        expect(video.size).toBe(11);
        expect((await read(video.stream)).toString()).toBe('video-bytes');
        const thumb = await ops.openFile({ videoId: 'v1', kind: 'thumb' });
        expect(thumb.size).toBe(3);
        expect((await read(thumb.stream)).toString()).toBe('jpg');
    });

    test('kind sai là lỗi invalid; thiếu videoId là lỗi invalid', async () => {
        const { ops } = setup();
        expect(await failure(ops.openFile({ videoId: 'v1', kind: 'audio' }))).toMatchObject({ code: 'invalid' });
        expect(await failure(ops.openFile({}))).toMatchObject({ code: 'invalid' });
    });

    test('id lạ, chưa xong, thiếu ảnh bìa, tệp mất đều là not_found', async () => {
        const { ops, service } = setup();
        expect(await failure(ops.openFile({ videoId: 'zzz' }))).toMatchObject({ code: 'not_found' });
        service.get.mockReturnValueOnce(job({ status: 'rendering' }));
        expect(await failure(ops.openFile({ videoId: 'v1' }))).toMatchObject({ code: 'not_found' });
        service.get.mockReturnValueOnce(job({ thumbPath: null }));
        expect(await failure(ops.openFile({ videoId: 'v1', kind: 'thumb' }))).toMatchObject({ code: 'not_found' });
        const missing = await failure(ops.openFile({ videoId: 'v1', kind: 'thumb' })); // out.jpg chưa tạo
        expect(missing).toBeInstanceOf(RenderError);
        expect(missing).toMatchObject({ code: 'not_found' });
        expect(missing.message).not.toContain(dir);
    });

    test('thư mục không phải tệp thường là not_found', async () => {
        const { ops, service } = setup();
        service.get.mockReturnValueOnce(job({ filePath: dir }));
        expect(await failure(ops.openFile({ videoId: 'v1' }))).toMatchObject({ code: 'not_found' });
    });

    (process.platform === 'win32' ? test.skip : test)('từ chối đường dẫn là symlink', async () => {
        const real = path.join(dir, 'real.mp4');
        fs.writeFileSync(real, 'x');
        const link = path.join(dir, 'link.mp4');
        fs.symlinkSync(real, link);
        const { ops, service } = setup();
        service.get.mockReturnValueOnce(job({ filePath: link }));
        expect(await failure(ops.openFile({ videoId: 'v1' }))).toMatchObject({ code: 'not_found' });
    });
});
