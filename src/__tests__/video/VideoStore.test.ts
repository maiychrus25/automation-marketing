import { memoryDb } from '../facebookPoster/helpers';
import { VideoStore } from '../../services/video/VideoStore';
import type { VideoJob } from '../../models/video';

function job(id: string, over: Partial<VideoJob> = {}): VideoJob {
    return { id, remoteId: null, name: id, source: 'app', engine: 'hyperframes', templateId: null, aspect: '9:16', specJson: '{}', status: 'queued', progress: 0, error: '', stepText: '', resultJson: '', filePath: null, thumbPath: null, sizeBytes: null, durationSec: null, createdAt: 1, finishedAt: null, ...over };
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

test('dòng engine ahv_ad giữ được stepText và resultJson', () => {
    const s = store();
    const ad = job('ad', { engine: 'ahv_ad', remoteId: 'job-xyz', stepText: 'H3 3/7', resultJson: '{"warnings":["stt_mismatch"]}' });
    s.create(ad);
    expect(s.get('ad')).toEqual(ad);
    s.update('ad', { stepText: 'Khớp môi 1/2' });
    expect(s.get('ad')!.stepText).toBe('Khớp môi 1/2');
    expect(s.list().videos[0].engine).toBe('ahv_ad');
});

test('DB có bảng cũ (chưa có cột 26.31) thì ensureSchema thêm cột và dòng cũ là hyperframes', () => {
    const db = memoryDb();
    db.exec(`CREATE TABLE video_jobs (
        id TEXT PRIMARY KEY, remote_id TEXT, name TEXT NOT NULL, source TEXT NOT NULL, template_id TEXT,
        aspect TEXT NOT NULL DEFAULT '', spec_json TEXT NOT NULL, status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '', file_path TEXT, thumb_path TEXT, size_bytes INTEGER, duration_sec REAL,
        created_at INTEGER NOT NULL, finished_at INTEGER)`);
    db.run("INSERT INTO video_jobs (id, name, source, spec_json, status, created_at) VALUES ('old', 'cũ', 'app', '{}', 'done', 7)", []);
    const s = new VideoStore(db);
    s.ensureSchema();
    s.ensureSchema();
    expect(s.get('old')).toMatchObject({ id: 'old', engine: 'hyperframes', stepText: '', resultJson: '' });
});
