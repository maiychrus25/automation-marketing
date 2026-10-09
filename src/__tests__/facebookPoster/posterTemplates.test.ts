import { listTemplates, addTemplate, removeTemplate } from '../../services/facebookPoster/posterTemplates';

function fakeDb() { const store: any = {}; return { getSetting: (k: string) => store[k] ?? null, setSetting: (k: string, v: string) => { store[k] = v; } }; }
const fakeFs = { saveBufferSync: (name: string, _src: string) => `/abs/media/tpl/${name}` } as any;

describe('posterTemplates', () => {
  it('rỗng ban đầu', () => { expect(listTemplates(fakeDb())).toEqual([]); });
  it('getSetting trả JSON hỏng → rỗng (không crash)', () => {
    const db = fakeDb(); db.setSetting('fb_poster_templates', 'not-json');
    expect(listTemplates(db)).toEqual([]);
  });
  it('add → list có 1, remove → rỗng', () => {
    const db = fakeDb();
    const e = addTemplate(db, fakeFs, 'Tuyển dụng', '/src/a.jpg');
    expect(e.name).toBe('Tuyển dụng');
    expect(e.path.startsWith('/abs/media/tpl/')).toBe(true); // tuyệt đối để fs.readFileSync đọc được khi edit
    expect(listTemplates(db)).toHaveLength(1);
    removeTemplate(db, e.id);
    expect(listTemplates(db)).toEqual([]);
  });
});
