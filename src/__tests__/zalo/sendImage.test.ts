import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ThreadType } from 'zca-js';
import ZaloService from '../../services/zalo/ZaloService';

function makeService() {
    const service: any = new ZaloService({ cookies: 'c', imei: 'i', userAgent: 'u' } as any);
    service.api = {};
    service.sendMessage = jest.fn().mockResolvedValue({ ok: true });
    return service;
}

describe('ZaloService.sendImage', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sendimage-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('rejects a missing file', async () => {
        const service = makeService();
        await expect(service.sendImage(path.join(dir, 'nope.png'), 'g1', ThreadType.Group))
            .rejects.toThrow('Không tìm thấy tệp ảnh để gửi');
        expect(service.sendMessage).not.toHaveBeenCalled();
    });

    it('rejects an empty thread id', async () => {
        const file = path.join(dir, 'a.png');
        fs.writeFileSync(file, 'x');
        await expect(makeService().sendImage(file, '', ThreadType.Group))
            .rejects.toThrow('Thiếu hội thoại nhận ảnh');
    });

    it('sends a GIF as an attachment path', async () => {
        const file = path.join(dir, 'a.gif');
        fs.writeFileSync(file, 'GIF89a');
        const service = makeService();
        await service.sendImage(file, 'g1', 1 as any, 'cap');
        const [content, threadId, type] = service.sendMessage.mock.calls[0];
        expect(content.attachments).toEqual([file]);
        expect(content.msg).toBe('cap');
        expect(threadId).toBe('g1');
        expect(type).toBe(ThreadType.Group);
    });

    it('keeps group thread type for non-GIF images', async () => {
        const file = path.join(dir, 'a.png');
        fs.writeFileSync(file, 'notreallypng');
        const service = makeService();
        await service.sendImage(file, 'g1', 1 as any);
        expect(service.sendMessage.mock.calls[0][2]).toBe(ThreadType.Group);
        expect(service.sendMessage.mock.calls[0][0].attachments[0].filename).toBe('a.png');
    });

    it('sendImages rejects when one file is missing', async () => {
        const file = path.join(dir, 'a.png');
        fs.writeFileSync(file, 'x');
        await expect(makeService().sendImages([file, path.join(dir, 'gone.png')], 'g1', 1 as any))
            .rejects.toThrow('Không tìm thấy một trong các tệp ảnh để gửi');
    });
});
