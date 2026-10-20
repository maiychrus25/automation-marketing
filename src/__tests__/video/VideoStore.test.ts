import { memoryDb } from '../facebookPoster/helpers';
import { VideoStore } from '../../services/video/VideoStore';
import type { VideoJob } from '../../models/video';

function job(id: string, over: Partial<VideoJob> = {}): VideoJob {
    return { id, remoteId: null, name: id, source: 'app', templateId: null, aspect: '9:16', specJson: '{}', status: 'queued', progress: 0, error: '', filePath: null, thumbPath: null, sizeBytes: null, durationSec: null, createdAt: 1, finishedAt: null, ...over };
}
function store() { const s = new VideoStore(memoryDb()); s.ensureSchema(); return s; }

test('ensureSchema chạy hai lần không lỗi; create/get/update/delete', () => {
    const s = store();
    s.ensureSchema();
    s.create(job('a'));
    expect(s.get('a')).toEqual(job('a'));
    s.update('a', { status: 'done', progress: 1, filePath: '/x.mp4', sizeBytes: 5 });
    expect(s.get('a')).toMatchObject({ status: 'done', progress: 1, filePath: '/x.mp4', sizeBytes: 5 });
    s.delete('a');
    expect(s.get('a')).toBeNull();
});

test('list lọc theo trạng thái, phân trang, mới nhất trước; listActive chỉ lấy việc dở', () => {
    const s = store();
    s.create(job('a', { createdAt: 1, status: 'done' }));
    s.create(job('b', { createdAt: 2, status: 'rendering' }));
    s.create(job('c', { createdAt: 3, status: 'queued' }));
    s.create(job('d', { createdAt: 4, status: 'failed' }));
    expect(s.list().videos.map((v) => v.id)).toEqual(['d', 'c', 'b', 'a']);
    expect(s.list({ limit: 2, offset: 1 })).toMatchObject({ total: 4, videos: [{ id: 'c' }, { id: 'b' }] });
    expect(s.list({ status: 'done' }).total).toBe(1);
    expect(s.listActive().map((v) => v.id)).toEqual(['b', 'c']);
});
