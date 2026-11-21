import fs from 'fs';
import path from 'path';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../', rel), 'utf8');

describe('main window hardening', () => {
  test('theMainWindowRunsSandboxed', () => {
    const src = read('electron/main.ts');
    const start = src.indexOf('mainWindow = new BrowserWindow(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('show: false', start);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toMatch(/sandbox:\s*true/);
    expect(block).toMatch(/contextIsolation:\s*true/);
    expect(block).toMatch(/nodeIntegration:\s*false/);
  });

  test('thePreloadOnlyRequiresElectron', () => {
    const src = read('electron/preload.ts');
    const imports = [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((m) => m !== 'electron')).toEqual([]);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/__dirname|__filename/);
  });
});
