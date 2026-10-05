import { buildThreadUrl, classifyFile, isSendableThreadId } from '../../services/facebook/pageSendHelpers';

describe('pageSendHelpers', () => {
  it('buildThreadUrl chèn asset + thread vào template', () => {
    const u = buildThreadUrl('1254744041053955', '100032442095141');
    expect(u).toContain('asset_id=1254744041053955');
    expect(u).toContain('100032442095141');
  });

  it('buildThreadUrl encode ký tự đặc biệt trong thread', () => {
    const u = buildThreadUrl('999', 'user:100032442095141');
    expect(u).toContain('user%3A100032442095141');
  });

  it('classifyFile phân loại theo đuôi, không phân biệt hoa thường', () => {
    expect(classifyFile('/a/b.PNG')).toBe('image');
    expect(classifyFile('/a/b.jpeg')).toBe('image');
    expect(classifyFile('/a/b.mp4')).toBe('video');
    expect(classifyFile('/a/b.m4a')).toBe('audio');
    expect(classifyFile('/a/b.pdf')).toBe('file');
  });

  it('classifyFile mặc định file khi không có đuôi nhận dạng', () => {
    expect(classifyFile('/a/b')).toBe('file');
    expect(classifyFile('/a/b.xyz')).toBe('file');
  });

  it('isSendableThreadId chỉ chấp nhận id toàn số', () => {
    expect(isSendableThreadId('100032442095141')).toBe(true);
    expect(isSendableThreadId('')).toBe(false);
    expect(isSendableThreadId('user:100032442095141')).toBe(false);
    expect(isSendableThreadId('abc')).toBe(false);
    expect(isSendableThreadId(undefined as any)).toBe(false);
  });
});
