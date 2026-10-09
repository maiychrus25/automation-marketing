/**
 * posterTemplates.ts
 * Catalog template thiệp brand cho Facebook Poster, lưu trong app_settings (JSON) + file đã copy.
 * DI (db + file store) để test không cần Electron.
 */
const KEY = 'fb_poster_templates';

export interface PosterTemplate { id: string; name: string; path: string; }
type Db = { getSetting(k: string): string | null; setSetting(k: string, v: string): void };
type FileStore = { saveBufferSync(name: string, srcPath: string): string };

export function listTemplates(db: Db): PosterTemplate[] {
  try {
    const v = JSON.parse(db.getSetting(KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function addTemplate(db: Db, store: FileStore, name: string, srcPath: string): PosterTemplate {
  const id = `tpl_${Date.now()}`;
  const safeName = (name || 'tpl').replace(/[^\w.-]+/g, '_');
  // Lưu ABSOLUTE path: edit-mode đọc template qua fs.readFileSync; poster cũng dùng path tuyệt đối.
  const abs = store.saveBufferSync(`${id}_${safeName}.img`, srcPath);
  const entry: PosterTemplate = { id, name: name || 'Template', path: abs };
  db.setSetting(KEY, JSON.stringify([...listTemplates(db), entry]));
  return entry;
}

export function removeTemplate(db: Db, id: string): void {
  db.setSetting(KEY, JSON.stringify(listTemplates(db).filter((t) => t.id !== id)));
}
