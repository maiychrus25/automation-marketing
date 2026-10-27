import { AD_LIMITS, buildAdPayload, type AdAssetResolver } from '../../services/video/adVideoPayload';
import { RenderError } from '../../services/video/RenderClient';

const resolve: AdAssetResolver = ({ kind, value, field }) => {
    if (kind === 'mediaId' && value === 'het-han') throw new RenderError('invalid', 'Có mediaId không tồn tại hoặc đã hết hạn');
    return { path: kind === 'path' ? value : `/inbox/${value}.jpg`, name: `${field}.jpg` };
};
const ok = (over: Record<string, unknown> = {}) => ({
    scenes: [{ type: 'presenter', line: 'Xin chào' }, { type: 'ai', prompt: 'cửa hàng sáng' }],
    presenter: { imageUrl: 'https://x.example/a.jpg' },
    ...over,
});
const build = (params: unknown) => buildAdPayload(params, resolve);
const fails = (params: unknown, re: RegExp) => expect(() => build(params)).toThrow(re);

test('payload đúng đổi sang tên trường của AHV, bỏ trường trống', () => {
    const { payload, uploads } = build({
        language: 'vi',
        scenes: [
            { type: 'presenter', line: 'Chào bạn', setting: 'trước dãy máy chủ' },
            { type: 'ai', prompt: 'bàn làm việc', motion: 'camera tiến vào', voiceover: 'Máy chủ mạnh', duration: 3 },
            { type: 'image', imageMediaId: 'anh-1' },
        ],
        presenter: { imagePath: '/home/u/nguoi-dan.jpg' },
        voice: { name: 'hai_dang', speed: 0.9 },
        music: { prompt: 'nhạc quảng cáo tươi vui' },
        brand: { website: 'example.com', endLine: 'Ghé thăm ngay.' },
    });
    expect(payload).toEqual({
        language: 'vi',
        scenes: [
            { type: 'presenter', line: 'Chào bạn', setting: 'trước dãy máy chủ' },
            { type: 'ai', prompt: 'bàn làm việc', motion: 'camera tiến vào', voiceover: 'Máy chủ mạnh', duration: 3 },
            { type: 'image', image_url: { __adUpload: 0 } },
        ],
        presenter: { image_url: { __adUpload: 1 } },
        voice: { name: 'hai_dang', speed: 0.9 },
        music: { prompt: 'nhạc quảng cáo tươi vui' },
        brand: { website: 'example.com', end_line: 'Ghé thăm ngay.' },
    });
    expect(uploads).toEqual([
        { path: '/inbox/anh-1.jpg', name: 'ảnh của cảnh 3.jpg' },
        { path: '/home/u/nguoi-dan.jpg', name: 'ảnh người dẫn.jpg' },
    ]);
});

test('ngôn ngữ mặc định vi; brand rỗng và music rỗng bị bỏ hẳn', () => {
    const { payload } = build(ok({ brand: {}, music: {}, voice: {} }));
    expect(payload.language).toBe('vi');
    expect(payload).not.toHaveProperty('brand');
    expect(payload).not.toHaveProperty('music');
    expect(payload).not.toHaveProperty('voice');
});

test('số cảnh và loại cảnh', () => {
    fails({ scenes: [{ type: 'ai', prompt: 'x' }] }, /từ 2 đến 10 cảnh/);
    fails({ scenes: new Array(11).fill({ type: 'ai', prompt: 'x' }) }, /từ 2 đến 10 cảnh/);
    fails({ scenes: 'khong-phai-mang' }, /từ 2 đến 10 cảnh/);
    fails(ok({ scenes: [{ type: 'video', prompt: 'x' }, { type: 'ai', prompt: 'y' }] }), /ai, image hoặc presenter/);
    fails(ok({ scenes: [null, { type: 'ai', prompt: 'y' }] }), /cảnh 1 không hợp lệ/);
});

test('trường bắt buộc của từng loại cảnh', () => {
    fails(ok({ scenes: [{ type: 'ai' }, { type: 'ai', prompt: 'y' }] }), /Thiếu mô tả hình của cảnh 1/);
    fails(ok({ scenes: [{ type: 'image' }, { type: 'ai', prompt: 'y' }] }), /cảnh 1: thiếu ảnh/);
    fails(ok({ scenes: [{ type: 'presenter' }, { type: 'ai', prompt: 'y' }] }), /Thiếu lời thoại của cảnh 1/);
    fails({ scenes: [{ type: 'presenter', line: 'a' }, { type: 'ai', prompt: 'y' }] }, /ảnh hoặc mô tả người dẫn/);
});

test('giới hạn độ dài chữ theo đúng hằng số của hợp đồng', () => {
    const long = (n: number) => 'x'.repeat(n + 1);
    fails(ok({ scenes: [{ type: 'ai', prompt: long(AD_LIMITS.prompt) }, { type: 'ai', prompt: 'y' }] }), /tối đa 500/);
    fails(ok({ scenes: [{ type: 'ai', prompt: 'a', motion: long(AD_LIMITS.motion) }, { type: 'ai', prompt: 'y' }] }), /tối đa 120/);
    fails(ok({ scenes: [{ type: 'ai', prompt: 'a', voiceover: long(AD_LIMITS.voiceover) }, { type: 'ai', prompt: 'y' }] }), /tối đa 300/);
    fails(ok({ scenes: [{ type: 'presenter', line: long(AD_LIMITS.line) }, { type: 'ai', prompt: 'y' }] }), /tối đa 300/);
    fails(ok({ scenes: [{ type: 'presenter', line: 'a', setting: long(AD_LIMITS.setting) }, { type: 'ai', prompt: 'y' }] }), /tối đa 500/);
    fails(ok({ brand: { website: long(AD_LIMITS.website) } }), /tối đa 100/);
    fails(ok({ brand: { endLine: long(AD_LIMITS.endLine) } }), /tối đa 300/);
    fails(ok({ presenter: { prompt: long(AD_LIMITS.presenterPrompt) } }), /tối đa 500/);
});

test('độ dài cảnh và tốc độ giọng theo khoảng của hợp đồng', () => {
    const scene = (duration: unknown) => ok({ scenes: [{ type: 'ai', prompt: 'a', duration }, { type: 'ai', prompt: 'y' }] });
    fails(scene(1.9), /từ 2 đến 4.3/);
    fails(scene(4.4), /từ 2 đến 4.3/);
    fails(scene('3'), /phải là số/);
    expect((build(scene(4.3)).payload.scenes as any)[0].duration).toBe(4.3);
    fails(ok({ voice: { speed: 0.6 } }), /từ 0.7 đến 1.3/);
    fails(ok({ voice: { speed: 1.4 } }), /từ 0.7 đến 1.3/);
});

test('giọng nhân bản cần đủ cặp đoạn mẫu + lời mẫu, không lẫn với giọng có sẵn', () => {
    fails(ok({ voice: { refAudioUrl: 'https://x.example/m.wav' } }), /phải kèm lời/);
    fails(ok({ voice: { refText: 'xin chào' } }), /chỉ dùng kèm/);
    fails(ok({ voice: { name: 'hai_dang', refAudioUrl: 'https://x.example/m.wav', refText: 'a' } }), /không dùng cả hai/);
    const { payload } = build(ok({ voice: { refAudioMediaId: 'giong-mau', refText: 'Xin chào' } }));
    expect(payload.voice).toEqual({ ref_audio_url: { __adUpload: 0 }, ref_text: 'Xin chào' });
});

test('nhạc: đúng một trong tệp hoặc mô tả', () => {
    fails(ok({ music: { url: 'https://x.example/n.mp3', prompt: 'vui' } }), /không dùng cả hai/);
    expect(build(ok({ music: { url: 'https://x.example/n.mp3' } })).payload.music).toEqual({ url: 'https://x.example/n.mp3' });
    expect(build(ok({ music: { mediaId: 'nhac-1' } })).payload.music).toEqual({ url: { __adUpload: 0 } });
});

test('mỗi chỗ nhận tệp chỉ nhận đúng một nguồn và link phải là http(s)', () => {
    fails(ok({ presenter: { imageUrl: 'https://x.example/a.jpg', imageMediaId: 'b' } }), /chỉ chọn một trong/);
    fails(ok({ presenter: { imageUrl: 'ftp://x.example/a.jpg' } }), /http hoặc https/);
    fails(ok({ presenter: { imageUrl: 'file:///etc/passwd' } }), /http hoặc https/);
    fails(ok({ presenter: { imageUrl: 'https://x.example/a.jpg', prompt: 'nam 30 tuổi' } }), /không dùng cả hai/);
});

test('mediaId hết hạn báo đúng lỗi của hộp thư', () => {
    fails(ok({ scenes: [{ type: 'image', imageMediaId: 'het-han' }, { type: 'ai', prompt: 'y' }] }), /hết hạn/);
});

test('ngôn ngữ chỉ nhận vi hoặc en', () => {
    fails(ok({ language: 'fr' }), /vi hoặc en/);
    expect(build(ok({ language: 'en' })).payload.language).toBe('en');
});

test('lời đọc sẵn của cảnh và câu kết được tải lên', () => {
    const { payload, uploads } = build({
        scenes: [
            { type: 'presenter', line: 'Chào', lineAudioMediaId: 'loi-1' },
            { type: 'ai', prompt: 'x', voiceoverAudioUrl: 'https://x.example/v.wav' },
        ],
        presenter: { imageUrl: 'https://x.example/a.jpg' },
        brand: { endLine: 'Cảm ơn', endLineAudioMediaId: 'loi-ket' },
    });
    expect((payload.scenes as any)[0].line_audio_url).toEqual({ __adUpload: 0 });
    expect((payload.scenes as any)[1].voiceover_audio_url).toBe('https://x.example/v.wav');
    expect((payload.brand as any).end_line_audio_url).toEqual({ __adUpload: 1 });
    expect(uploads).toHaveLength(2);
});
