import { buildImageRequest, parseImageResponse } from '../../services/ai/aiImage';

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
});
