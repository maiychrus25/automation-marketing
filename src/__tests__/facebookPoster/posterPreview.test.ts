import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import PostPreview from '../../ui/features/facebookPoster/PostPreview';
import ChannelsPanel from '../../ui/features/facebookPoster/ChannelsPanel';

jest.mock('@/lib/localMedia', () => ({ toLocalMediaUrl: (value: string) => value }), { virtual: true });
const preview = (props: Partial<React.ComponentProps<typeof PostPreview>> = {}) => renderToStaticMarkup(React.createElement(PostPreview, {
  names: ['Publisher'], mode: 'group', text: 'Post content', comment: 'First comment', mediaPaths: [], ...props,
}));

describe('Vietnamese poster preview locale', () => {
  it('renders the group destination and first comment without interpreting user HTML', () => {
    const html = preview({ text: '<script>alert(1)</script>', targetName: 'Community' });
    expect(html).toContain('Community');
    expect(html).toContain('First comment');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
  it('renders page identity independently of a group destination', () => {
    const html = preview({ mode: 'page', targetName: 'Community' });
    expect(html).toContain('Trang');
    expect(html).not.toContain('Community');
  });
  it('keeps media order and caps the preview while reporting additional photos', () => {
    const html = preview({ mediaPaths: Array.from({ length: 10 }, (_, i) => `/image-${i}.jpg`) });
    expect((html.match(/<img /g) || [])).toHaveLength(4);
    expect(html.indexOf('/image-0.jpg')).toBeLessThan(html.indexOf('/image-1.jpg'));
    expect(html).toContain('+6');
    expect(preview({ mediaPaths: ['/video.mp4'] })).toContain('<video controls=""');
  });
  it('shows multi-profile scope and preserves long first comments', () => {
    const html = preview({ names: ['First', 'Second'], comment: 'x'.repeat(8000), text: 'a'.repeat(63206) });
    expect(html).toContain('2 profile');
    expect(html).toContain('x'.repeat(8000));
    expect(html).toContain('a'.repeat(63206));
  });
});

describe('provider-neutral channels panel', () => {
  it('renders supplied provider metadata, profile groups and independent selection', () => {
    const html = renderToStaticMarkup(React.createElement(ChannelsPanel, {
      channels: [{ id: 'p1', name: 'A'.repeat(300), group: 'Team', provider: { id: 'test', name: 'Test provider', badge: 't' } }],
      selected: [], onChange: () => {}, onCompose: () => {}, onAdd: () => {}, loading: false, error: '', onRetry: () => {},
    }));
    expect(html).toContain('Test provider');
    expect(html).toContain('Team');
    expect(html).not.toContain('checked=""');
    expect(html).not.toContain('Facebook');
  });
});

describe('poster contrast in desktop and mobile themes', () => {
  const css = readFileSync(path.resolve(__dirname, '../../ui/index.css'), 'utf8');
  const tokens = (source: string) => Object.fromEntries([...source.matchAll(/--poster-([a-z-]+):\s*#([a-f0-9]{6});/g)].map(m => [m[1], m[2]]));
  const light = tokens(css.slice(css.lastIndexOf(':root {'), css.indexOf('}', css.lastIndexOf(':root {'))));
  const start = css.lastIndexOf('html[data-theme="dark"] {');
  const dark = { ...light, ...tokens(css.slice(start, css.indexOf('}', start))) };
  const luminance = (hex: string) => hex.match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
  const contrast = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + .05) / (lo + .05); };
  it.each([['light', light], ['dark', dark]] as const)('%s text, selected view and primary action remain readable', (_theme, colors) => {
    for (const text of ['text', 'muted']) for (const surface of ['surface', 'canvas', 'header', 'facebook', 'comment']) expect(contrast(colors[text], colors[surface])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors['on-primary'], colors.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors['focus-text'], colors['focus-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.highlight, colors.header)).toBeGreaterThanOrEqual(3);
  });
});
