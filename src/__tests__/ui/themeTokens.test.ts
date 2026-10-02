import * as fs from 'fs';
import * as path from 'path';

// Đọc token trực tiếp từ index.css để test đúng thứ đang chạy trong app.
const ROOT = path.resolve(__dirname, '../../..');
const css = fs.readFileSync(path.join(ROOT, 'src/ui/index.css'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tailwindConfig = require(path.join(ROOT, 'tailwind.config.js'));

type Rgb = [number, number, number];

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Không tìm thấy khối ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

function channels(source: string): Record<string, Rgb> {
  const out: Record<string, Rgb> = {};
  for (const m of source.matchAll(/--rgb-([a-z-]+):\s*(\d+)\s+(\d+)\s+(\d+);/g)) {
    out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return out;
}

const light = channels(block(':root'));
const dark = { ...light, ...channels(block('html[data-theme="dark"]')) };

function luminance([r, g, b]: Rgb): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = ['text-primary', 'text-primary-soft', 'text-secondary-strong', 'text-secondary', 'text-tertiary', 'accent-text'];
const SURFACES = ['bg-deep', 'bg', 'bg-mid', 'surface', 'surface-mid', 'surface-raised', 'control', 'control-hover'];
const WHITE: Rgb = [255, 255, 255];

describe.each([['light', light], ['dark', dark]] as const)('%s theme tokens', (_name, t) => {
  it.each(TEXT.flatMap((text) => SURFACES.map((bg) => [text, bg])))('%s on %s reaches 4.5:1', (text, bg) => {
    expect(contrast(t[text], t[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it.each([['text-primary'], ['text-secondary']])('%s on control-strong reaches 4.5:1', (text) => {
    expect(contrast(t[text], t['control-strong'])).toBeGreaterThanOrEqual(4.5);
  });

  it.each([['accent-fill'], ['accent-fill-hover'], ['accent-fill-pressed']])('white text on %s reaches 4.5:1', (fill) => {
    expect(contrast(WHITE, t[fill])).toBeGreaterThanOrEqual(4.5);
  });

  it('accent reaches 3:1 against every surface (non-text)', () => {
    for (const bg of SURFACES) expect(contrast(t.accent, t[bg])).toBeGreaterThanOrEqual(3);
  });
});

describe('tailwind token mapping', () => {
  const extend = tailwindConfig.theme.extend;
  const referenced = new Set<string>();
  for (const key of ['backgroundColor', 'textColor', 'borderColor', 'placeholderColor', 'ringColor']) {
    for (const shades of Object.values(extend[key] as Record<string, Record<string, string>>)) {
      for (const value of Object.values(shades)) {
        const m = /var\(--rgb-([a-z-]+)\)/.exec(value);
        if (m) referenced.add(m[1]);
      }
    }
  }

  it('references only tokens defined for both themes', () => {
    expect(referenced.size).toBeGreaterThan(10);
    for (const name of referenced) {
      expect(light[name]).toBeDefined();
      expect(dark[name]).toBeDefined();
    }
  });

  it('maps the same gray shade to different roles for background and border', () => {
    expect(extend.backgroundColor.gray['700']).toBe('rgb(var(--rgb-control) / <alpha-value>)');
    expect(extend.borderColor.gray['700']).toBe('rgb(var(--rgb-border) / <alpha-value>)');
    expect(extend.textColor.gray['400']).toBe('rgb(var(--rgb-text-secondary) / <alpha-value>)');
  });
});

describe('light overrides', () => {
  it('no longer override tokenised gray classes', () => {
    expect(css).not.toMatch(/html\[data-theme="light"\] [^,{]*\.(hover\\:)?(bg|text|border|divide|ring|placeholder)-gray-\d/);
  });
});
