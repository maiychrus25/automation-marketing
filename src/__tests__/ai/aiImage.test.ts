import { buildImageRequest, parseImageResponse, runImageGeneration } from '../../services/ai/aiImage';

describe('aiImage', () => {
  it('gen mode (không base): endpoint generations + đủ param contract', () => {
    const r = buildImageRequest({ apiKey: 'k', model: 'cx/gpt-5.5-image', prompt: 'p', size: '1024x1536' });
    expect(r.url).toContain('/v1/images/generations');
    expect(r.headers.Authorization).toBe('Bearer k');
    expect(r.body.model).toBe('cx/gpt-5.5-image');
    expect(r.body.prompt).toBe('p');
    expect(r.body.size).toBe('1024x1536');
    expect(r.body.n).toBe(1);
    expect(r.body.output_format).toBe('jpeg');
    expect(r.body.background).toBe('auto');
    expect(r.body.image).toBeUndefined();
  });
  it('edit mode (có base URL): cùng endpoint generations, field image = URL', () => {
    const r = buildImageRequest({ apiKey: 'k', model: 'm', prompt: 'p', baseImages: ['https://x/a.jpg'] });
    expect(r.url).toContain('/v1/images/generations');
    expect(r.body.image).toBe('https://x/a.jpg');
    expect(r.body.image_detail).toBe('high');
  });
  it('parse: b64_json → buffer', () => {
    const b64 = Buffer.from('hello').toString('base64');
    const r = parseImageResponse({ data: [{ b64_json: b64 }] });
    expect(r.buffer?.toString()).toBe('hello');
  });
  it('parse: chỉ url → trả url', () => {
    expect(parseImageResponse({ data: [{ url: 'https://x/i.jpg' }] })).toEqual({ url: 'https://x/i.jpg' });
  });
  it('parse: không có ảnh → throw', () => {
    expect(() => parseImageResponse({ data: [] })).toThrow('no image');
  });

  it('runImageGeneration: b64 response → lưu buffer, trả rel path + size', async () => {
    const b64 = Buffer.from('imgbytes').toString('base64');
    const post = jest.fn(async () => ({ data: { data: [{ b64_json: b64 }] } }));
    const download = jest.fn();
    const saveBuffer = jest.fn(async () => '/abs/media/fb-poster-ai/a1/gen_1.jpg');
    const toRelativePath = jest.fn((p: string) => p.replace('/abs/media/', 'media/'));
    const r = await runImageGeneration(
      { getApiKey: () => 'k', model: 'cx/gpt-5.5-image', post, download, saveBuffer, toRelativePath, bucket: 'fb-poster-ai/a1' },
      { prompt: 'p' },
    );
    expect(r.localPath).toBe('media/fb-poster-ai/a1/gen_1.jpg');
    expect(r.size).toBe(Buffer.from('imgbytes').length);
    expect((post.mock.calls[0] as any[])[0]).toContain('/v1/images/generations');
    expect(download).not.toHaveBeenCalled();
  });

  it('runImageGeneration: url response → download rồi lưu', async () => {
    const post = jest.fn(async () => ({ data: { data: [{ url: 'https://x/i.jpg' }] } }));
    const download = jest.fn(async () => Buffer.from('downloaded'));
    const saveBuffer = jest.fn(async () => '/abs/media/b/gen.jpg');
    const r = await runImageGeneration(
      { getApiKey: () => 'k', model: 'm', post, download, saveBuffer, toRelativePath: (p: string) => p, bucket: 'b' },
      { prompt: 'p' },
    );
    expect((download.mock.calls[0] as any[])[0]).toBe('https://x/i.jpg');
    expect(r.size).toBe(Buffer.from('downloaded').length);
  });

  it('runImageGeneration: response không có ảnh → throw, không lưu', async () => {
    const post = jest.fn(async () => ({ data: { data: [] } }));
    const saveBuffer = jest.fn();
    await expect(runImageGeneration(
      { getApiKey: () => 'k', model: 'm', post, download: jest.fn(), saveBuffer, toRelativePath: (p: string) => p, bucket: 'b' },
      { prompt: 'p' },
    )).rejects.toThrow('no image');
    expect(saveBuffer).not.toHaveBeenCalled();
  });
});
