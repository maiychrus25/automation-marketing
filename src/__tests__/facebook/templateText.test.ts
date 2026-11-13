import { templateTextFromStoryAttachment, unwrapFacebookRedirect } from '../../services/facebook/facebookTemplateText';

const wrapped = (u: string) => `https://l.facebook.com/l.php?u=${encodeURIComponent(u)}&h=abc`;

describe('unwrapFacebookRedirect', () => {
  test('unwrapsRedirectHosts', () => {
    expect(unwrapFacebookRedirect(wrapped('https://example.com/a'))).toBe('https://example.com/a');
    expect(unwrapFacebookRedirect(`https://lm.facebook.com/l.php?u=${encodeURIComponent('https://example.com/b')}&h=x`)).toBe('https://example.com/b');
    expect(unwrapFacebookRedirect(`/l.php?u=${encodeURIComponent('https://example.com/c')}&h=x`)).toBe('https://example.com/c');
  });
  test('plainHttpUnchanged', () => {
    expect(unwrapFacebookRedirect('https://example.com/x?y=1')).toBe('https://example.com/x?y=1');
    expect(unwrapFacebookRedirect('http://example.com/x')).toBe('http://example.com/x');
  });
  test.each([
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,hi'],
    ['wrappedJavascript', wrapped('javascript:alert(1)')],
    ['empty', ''],
    ['null', null],
    ['number', 42],
    ['object', {}],
    ['malformed', 'http://'],
    ['relativeNoU', '/l.php?h=x'],
    ['embeddedNewline', 'https://a.com/\nFake'],
    ['embeddedSpace', 'https://a.com/ x'],
    ['controlChar', 'https://a.com/\u0007x'],
    ['wrappedWithNewline', wrapped('https://a.com/\nFake')],
  ])('rejects_%s', (_n, raw) => {
    expect(unwrapFacebookRedirect(raw as any)).toBe('');
  });
});

describe('templateTextFromStoryAttachment', () => {
  const card = {
    title_with_entities: { text: 'Tiêu đề mẫu' },
    description: { text: 'Mô tả mẫu' },
    action_links: [{ title: 'Xem ngay', url: wrapped('https://example.com/a') }],
  };

  test('titleDescriptionButton', () => {
    expect(templateTextFromStoryAttachment({ story_attachment: card }))
      .toBe('Tiêu đề mẫu\nMô tả mẫu\n• Xem ngay — https://example.com/a');
  });
  test('acceptsStoryObjectItself', () => {
    expect(templateTextFromStoryAttachment(card)).toBe('Tiêu đề mẫu\nMô tả mẫu\n• Xem ngay — https://example.com/a');
  });
  test('fallbackFieldsAndStringDescription', () => {
    expect(templateTextFromStoryAttachment({ title: 'T', description: 'D' })).toBe('T\nD');
  });
  test('buttonWithoutLinkOrWithBadLink', () => {
    const t = templateTextFromStoryAttachment({ title: 'T', action_links: [
      { title: 'Tên nút' }, { title: 'Xấu', url: 'javascript:alert(1)' }, { url: 'https://example.com/z' },
    ] });
    expect(t).toBe('T\n• Tên nút\n• Xấu');
  });
  test('subattachmentUsedWhenRootEmpty', () => {
    const t = templateTextFromStoryAttachment({ story_attachment: {
      subattachments: [
        { title: 'Thẻ con', description: { text: 'Mô tả con' }, action_links: [{ title: 'Mở', url: 'https://example.com/s' }] },
        { title: 'Thẻ hai' },
      ],
    } });
    expect(t).toBe('Thẻ con\nMô tả con\n• Mở — https://example.com/s');
  });
  test('subattachmentIgnoredWhenRootHasText', () => {
    expect(templateTextFromStoryAttachment({ title: 'Gốc', subattachments: [{ title: 'Con' }] })).toBe('Gốc');
  });
  test('duplicateLinesNotRepeated', () => {
    expect(templateTextFromStoryAttachment({ title: 'Giống', description: 'Giống' })).toBe('Giống');
  });
  test('fieldsCutTo2000AndCrlfNormalized', () => {
    const long = 'a'.repeat(2500);
    expect(templateTextFromStoryAttachment({ title: long })).toBe('a'.repeat(2000));
    expect(templateTextFromStoryAttachment({ title: 'x\r\ny' })).toBe('x\ny');
  });
  test('maxSixButtons', () => {
    const action_links = Array.from({ length: 9 }, (_v, i) => ({ title: `B${i}` }));
    expect(templateTextFromStoryAttachment({ title: 'T', action_links }).split('\n')).toEqual(['T', '• B0', '• B1', '• B2', '• B3', '• B4', '• B5']);
  });
  test('sourceTextOrUrlWhenNothingElse', () => {
    expect(templateTextFromStoryAttachment({ source: { text: 'Nguồn mẫu' } })).toBe('Nguồn mẫu');
    expect(templateTextFromStoryAttachment({ url: wrapped('https://example.com/u') })).toBe('https://example.com/u');
    expect(templateTextFromStoryAttachment({ url: 'javascript:alert(1)' })).toBe('');
  });
  test.each([[null], [undefined], [{}], [''], [42], [{ story_attachment: null }], [{ title: '  ' }]])('nothingReadable_%p', (v) => {
    expect(templateTextFromStoryAttachment(v as any)).toBe('');
  });
});
