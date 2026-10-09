import { buildImageRequest, parseImageResponse, runImageGeneration } from '../../services/ai/aiImage';

describe('aiImage', () => {
  it('gen mode (không base): endpoint generations', () => {
    const r = buildImageRequest({ apiKey: 'k', model: 'cx/gpt-5.5-image', prompt: 'p', size: '1024x1536' });
    expect(r.url).toContain('/v1/images/generations');
    expect(r.headers.Authorization).toBe('Bearer k');
    expect(r.body.model).toBe('cx/gpt-5.5-image');
    expect(r.body.prompt).toBe('p');
    expect(r.body.size).toBe('1024x1536');
  });
  it('parse: lấy b64_json → Buffer', () => {
    const b64 = Buffer.from('hello').toString('base64');
    const buf = parseImageResponse({ data: [{ b64_json: b64 }] });
    expect(buf.toString()).toBe('hello');
  });
  it('parse: không có ảnh → throw', () => {
    expect(() => parseImageResponse({ data: [] })).toThrow('no image');
  });

  it('runImageGeneration: gọi post, lưu buffer, trả rel path + size', async () => {
    const b64 = Buffer.from('imgbytes').toString('base64');
    const post = jest.fn(async () => ({ data: { data: [{ b64_json: b64 }] } }));
    const saveBuffer = jest.fn(async () => '/abs/media/fb-poster-ai/a1/gen_1.png');
    const toRelativePath = jest.fn((p: string) => p.replace('/abs/media/', 'media/'));
    const r = await runImageGeneration(
      { getApiKey: () => 'k', model: 'cx/gpt-5.5-image', post, saveBuffer, toRelativePath, bucket: 'fb-poster-ai/a1' },
      { prompt: 'p' },
    );
    expect(r.localPath).toBe('media/fb-poster-ai/a1/gen_1.png');
    expect(r.size).toBe(Buffer.from('imgbytes').length);
    expect((post.mock.calls[0] as any[])[0]).toContain('/v1/images/generations');
    expect((saveBuffer.mock.calls[0] as any[])[0]).toBe('fb-poster-ai/a1');
  });

  it('runImageGeneration: response không có ảnh → throw, không lưu', async () => {
    const post = jest.fn(async () => ({ data: { data: [] } }));
    const saveBuffer = jest.fn();
    await expect(runImageGeneration(
      { getApiKey: () => 'k', model: 'm', post, saveBuffer, toRelativePath: (p: string) => p, bucket: 'b' },
      { prompt: 'p' },
    )).rejects.toThrow('no image');
    expect(saveBuffer).not.toHaveBeenCalled();
  });
});
