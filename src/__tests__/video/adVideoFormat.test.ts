import {
    adVideoRequest, emptyAdForm, emptyScene, engineLabel, validateAdVideoForm, warningLabel,
    type AdVideoFormValues,
} from '../../ui/features/facebookPoster/adVideoFormat';

const filled = (over: Partial<AdVideoFormValues> = {}): AdVideoFormValues => ({
    ...emptyAdForm(),
    name: 'Quảng cáo tháng 10',
    scenes: [
        { ...emptyScene('presenter'), line: 'Xin chào các bạn' },
        { ...emptyScene('ai'), prompt: 'cửa hàng sáng sủa', motion: 'camera tiến vào', voiceover: 'Thiết kế tối giản', duration: '3' },
    ],
    presenterMode: 'image', presenterImagePath: '/home/u/nguoi-dan.jpg',
    ...over,
});

test('form rỗng báo thiếu tên và thiếu nội dung từng cảnh', () => {
    const errors = validateAdVideoForm(emptyAdForm());
    expect(errors.name).toMatch(/Nhập tên/);
    expect(errors['scene:0:line']).toMatch(/lời thoại/);
    expect(errors['scene:1:prompt']).toMatch(/mô tả hình/);
    expect(errors.presenter).toMatch(/ảnh người dẫn/);
});

test('form đủ thì không còn lỗi', () => {
    expect(validateAdVideoForm(filled())).toEqual({});
});

test('số cảnh trong khoảng 2–10', () => {
    expect(validateAdVideoForm(filled({ scenes: [{ ...emptyScene('ai'), prompt: 'x' }] })).scenes).toMatch(/ít nhất 2/);
    expect(validateAdVideoForm(filled({ scenes: new Array(11).fill({ ...emptyScene('ai'), prompt: 'x' }) })).scenes).toMatch(/Tối đa 10/);
});

test('cảnh ảnh phải chọn ảnh; độ dài và tốc độ giọng theo khoảng', () => {
    const scenes = (over: Partial<ReturnType<typeof emptyScene>>) => [
        { ...emptyScene('image'), ...over },
        { ...emptyScene('ai'), prompt: 'x' },
    ];
    expect(validateAdVideoForm(filled({ scenes: scenes({}) }))['scene:0:image']).toMatch(/Chọn ảnh/);
    expect(validateAdVideoForm(filled({ scenes: scenes({ imagePath: '/a.jpg', duration: '1.9' }) }))['scene:0:duration']).toMatch(/2 đến 4.3/);
    expect(validateAdVideoForm(filled({ scenes: scenes({ imagePath: '/a.jpg', duration: '4.4' }) }))['scene:0:duration']).toMatch(/2 đến 4.3/);
    expect(validateAdVideoForm(filled({ scenes: scenes({ imagePath: '/a.jpg', duration: 'abc' }) }))['scene:0:duration']).toBeTruthy();
    expect(validateAdVideoForm(filled({ scenes: scenes({ imagePath: '/a.jpg', duration: '' }) }))['scene:0:duration']).toBeUndefined();
    expect(validateAdVideoForm(filled({ voiceSpeed: '1.4' })).voice).toMatch(/0.7 đến 1.3/);
    expect(validateAdVideoForm(filled({ voiceSpeed: '' })).voice).toBeUndefined();
});

test('giới hạn độ dài chữ và người dẫn theo mô tả', () => {
    const long = (n: number) => 'x'.repeat(n);
    expect(validateAdVideoForm(filled({ name: long(101) })).name).toMatch(/tối đa 100/);
    expect(validateAdVideoForm(filled({ presenterMode: 'prompt', presenterPrompt: '' })).presenter).toMatch(/Nhập mô tả/);
    expect(validateAdVideoForm(filled({ presenterMode: 'prompt', presenterPrompt: long(501) })).presenter).toMatch(/tối đa 500/);
    expect(validateAdVideoForm(filled({ brandWebsite: long(101) })).brand).toMatch(/tối đa 100/);
    expect(validateAdVideoForm(filled({ brandEndLine: long(301) })).brand).toMatch(/tối đa 300/);
    const scene = [{ ...emptyScene('ai'), prompt: long(501) }, { ...emptyScene('ai'), prompt: 'x' }];
    expect(validateAdVideoForm(filled({ scenes: scene }))['scene:0:prompt']).toMatch(/tối đa 500/);
});

test('nhạc: chọn tệp hoặc mô tả thì phải điền', () => {
    expect(validateAdVideoForm(filled({ musicMode: 'file' })).music).toMatch(/Chọn tệp nhạc/);
    expect(validateAdVideoForm(filled({ musicMode: 'prompt' })).music).toMatch(/Nhập mô tả nhạc/);
    expect(validateAdVideoForm(filled({ musicMode: 'file', musicPath: '/n.mp3' })).music).toBeUndefined();
    expect(validateAdVideoForm(filled({ musicMode: 'none' })).music).toBeUndefined();
});

test('adVideoRequest dựng tham số gọn, bỏ ô trống', () => {
    expect(adVideoRequest(filled())).toEqual({
        name: 'Quảng cáo tháng 10',
        language: 'vi',
        scenes: [
            { type: 'presenter', line: 'Xin chào các bạn' },
            { type: 'ai', prompt: 'cửa hàng sáng sủa', motion: 'camera tiến vào', voiceover: 'Thiết kế tối giản', duration: 3 },
        ],
        presenter: { imagePath: '/home/u/nguoi-dan.jpg' },
        voice: { speed: 0.9 },
    });
});

test('adVideoRequest giữ nhạc, thương hiệu, giọng và cảnh ảnh', () => {
    const request = adVideoRequest(filled({
        language: 'en',
        scenes: [{ ...emptyScene('image'), imagePath: '/a.jpg' }, { ...emptyScene('presenter'), line: 'Hello', setting: 'server room' }],
        presenterMode: 'prompt', presenterPrompt: 'nam 30 tuổi, áo vest',
        voiceName: 'hai_dang', voiceSpeed: '1.1',
        musicMode: 'prompt', musicPrompt: 'nhạc vui',
        brandLogoPath: '/logo.png', brandWebsite: 'example.com', brandEndLine: 'Cảm ơn bạn.',
    }));
    expect(request).toEqual({
        name: 'Quảng cáo tháng 10', language: 'en',
        scenes: [{ type: 'image', imagePath: '/a.jpg' }, { type: 'presenter', line: 'Hello', setting: 'server room' }],
        presenter: { prompt: 'nam 30 tuổi, áo vest' },
        voice: { name: 'hai_dang', speed: 1.1 },
        music: { prompt: 'nhạc vui' },
        brand: { logoPath: '/logo.png', website: 'example.com', endLine: 'Cảm ơn bạn.' },
    });
    const noPresenter = adVideoRequest(filled({ scenes: [{ ...emptyScene('ai'), prompt: 'a' }, { ...emptyScene('ai'), prompt: 'b' }] }));
    expect(noPresenter).not.toHaveProperty('presenter');
    expect(adVideoRequest(filled({ musicMode: 'file', musicPath: '/n.mp3' })).music).toEqual({ path: '/n.mp3' });
});

test('nhãn engine và cảnh báo có chữ tiếng Việt, giá trị lạ giữ nguyên', () => {
    expect(engineLabel('hyperframes')).toBe('Mẫu HyperFrames');
    expect(engineLabel('ahv_ad')).toBe('Quảng cáo AI');
    expect(engineLabel('engine_moi')).toBe('engine_moi');
    expect(warningLabel('stt_mismatch')).toMatch(/nghe lại/);
    expect(warningLabel('ma_la')).toBe('ma_la');
});
