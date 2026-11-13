import {
    toZaloJpgUrl,
    normalizeZaloPhotoContent,
    normalizeZaloMessageImages,
    isJxlLocalPath,
} from '../../utils/zaloImageUrl';

const JXL = 'https://photo-stal-1.zdn.vn/jxl/abc/123.jxl?jxlstatus=1&x=2';
const JPG = 'https://photo-stal-1.zdn.vn/jpg/abc/123.jpg?x=2';

describe('toZaloJpgUrl', () => {
    it('rewrites a Zalo JXL url to the JPG variant', () => {
        expect(toZaloJpgUrl(JXL)).toBe(JPG);
    });

    it.each([
        'https://photo-stal-1.zdn.vn/jxl/abc/123.jxl?e2esession=1',
        'https://example.com/jxl/a/1.jxl',
        'https://evilzdn.vn/jxl/a/1.jxl',
        'https://zdn.vn.evil.com/jxl/a/1.jxl',
        'https://photo.zdn.vn/jpg/a/1.jpg',
        '',
    ])('keeps %p unchanged', (url) => {
        expect(toZaloJpgUrl(url)).toBe(url);
    });

    it.each([
        ['https://photo.zdn.vn/jxl/a/1.jxl?sig=a%20b~c&jxlstatus=1', 'https://photo.zdn.vn/jpg/a/1.jpg?sig=a%20b~c'],
        ['https://photo.zdn.vn/jxl/a/1.jxl?jxlstatus=1', 'https://photo.zdn.vn/jpg/a/1.jpg'],
        ['https://photo.zdn.vn/jxl/a/1.jxl?jxlstatus=1&x=2', 'https://photo.zdn.vn/jpg/a/1.jpg?x=2'],
        ['https://photo.zdn.vn/jxl/a/1.jxl?x=2&jxlstatus=1&y=3', 'https://photo.zdn.vn/jpg/a/1.jpg?x=2&y=3'],
        ['https://photo.zdn.vn/jxl/a/1.jxl?x=2&jxlstatus=1#frag', 'https://photo.zdn.vn/jpg/a/1.jpg?x=2#frag'],
        ['https://photo.zdn.vn/jxl/a/1.jxl?jxlstatus=1#frag', 'https://photo.zdn.vn/jpg/a/1.jpg#frag'],
        ['https://PHOTO.ZDN.VN/jxl/a/1.jxl', 'https://PHOTO.ZDN.VN/jpg/a/1.jpg'],
        ['https://photo.zdn.vn:8443/jxl/a/1.jxl', 'https://photo.zdn.vn:8443/jpg/a/1.jpg'],
    ])('rewrites %p byte-for-byte', (url, expected) => {
        expect(toZaloJpgUrl(url)).toBe(expected);
    });

    it('keeps the userinfo trick unchanged', () => {
        const url = 'https://zdn.vn@evil.com/jxl/a/1.jxl';
        expect(toZaloJpgUrl(url)).toBe(url);
    });

    it('keeps non-string values', () => {
        expect(toZaloJpgUrl(undefined as any)).toBeUndefined();
        expect(toZaloJpgUrl(5 as any)).toBe(5);
    });
});

describe('normalizeZaloPhotoContent', () => {
    it('rewrites href/thumb/hd on an object', () => {
        const out: any = normalizeZaloPhotoContent({ href: JXL, thumb: JXL, hd: JXL, title: 't' });
        expect(out).toEqual({ href: JPG, thumb: JPG, hd: JPG, title: 't' });
    });

    it('rewrites params given as an escaped JSON string and keeps it a string', () => {
        const params = JSON.stringify({ hd: JXL }).replace(/\//g, '\\/');
        const out: any = normalizeZaloPhotoContent({ params });
        expect(typeof out.params).toBe('string');
        expect(JSON.parse(out.params).hd).toBe(JPG);
    });

    it('rewrites a JSON string content', () => {
        const out = normalizeZaloPhotoContent(JSON.stringify({ href: JXL }));
        expect(JSON.parse(out).href).toBe(JPG);
    });

    it('returns the same reference for malformed JSON mentioning jxl', () => {
        const bad = '{"href": "jxl';
        expect(normalizeZaloPhotoContent(bad)).toBe(bad);
    });

    it('returns the same reference when nothing changes', () => {
        const text = 'chat about jxl files';
        expect(normalizeZaloPhotoContent(text)).toBe(text);
        const arr = [JXL];
        expect(normalizeZaloPhotoContent(arr)).toBe(arr);
        const obj = { href: 'https://example.com/jxl/a/1.jxl' };
        expect(normalizeZaloPhotoContent(obj)).toBe(obj);
    });
});

describe('normalizeZaloMessageImages', () => {
    it('rewrites data.content and data.quote.attach', () => {
        const message: any = { data: { content: { href: JXL }, quote: { attach: JSON.stringify({ thumb: JXL }) } } };
        expect(normalizeZaloMessageImages(message)).toBe(true);
        expect(message.data.content.href).toBe(JPG);
        expect(JSON.parse(message.data.quote.attach).thumb).toBe(JPG);
    });

    it('returns false for messages without JXL images', () => {
        expect(normalizeZaloMessageImages({ data: { content: 'hello' } })).toBe(false);
        expect(normalizeZaloMessageImages({})).toBe(false);
        expect(normalizeZaloMessageImages(null)).toBe(false);
    });
});

describe('isJxlLocalPath', () => {
    it('detects .jxl files case-insensitively', () => {
        expect(isJxlLocalPath('a/b.jxl')).toBe(true);
        expect(isJxlLocalPath('a/b.JXL')).toBe(true);
    });
    it('rejects everything else', () => {
        expect(isJxlLocalPath('a/b.jpg')).toBe(false);
        expect(isJxlLocalPath('')).toBe(false);
        expect(isJxlLocalPath(null)).toBe(false);
    });
});
