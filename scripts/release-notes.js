/**
 * release-notes.js - ghi chú phát hành trên GitHub lấy từ "Log phiên bản" của app.
 *
 * Nguồn duy nhất là mảng CHANGELOG trong src/ui/components/settings/ChangelogSettings.tsx: viết một lần, app và
 * trang Releases trên GitHub luôn khớp nhau. Bước phát hành của CI chạy tệp này khi chưa cài node_modules, nên chỉ
 * dùng thư viện có sẵn của Node.
 *
 * Usage: node scripts/release-notes.js <version|tag> [repoRoot]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CHANGELOG_FILE = 'src/ui/components/settings/ChangelogSettings.tsx';
const ARRAY_START = /const CHANGELOG\b[^=]*=\s*\[/;
// Cùng nhãn và thứ tự với CATEGORY_STYLES trong ChangelogSettings.tsx.
const CATEGORY_LABELS = [
  ['new', 'Tính năng mới'],
  ['improved', 'Cải thiện'],
  ['fixed', 'Sửa lỗi'],
  ['removed', 'Đã xóa'],
  ['security', 'Bảo mật'],
];

/** Vị trí dấu `]` đóng mảng mở tại `open`, bỏ qua ngoặc nằm trong chuỗi và chú thích. -1 nếu không khớp. */
function findArrayEnd(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < source.length && source[i] !== ch; i++) if (source[i] === '\\') i++;
    } else if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) return -1;
    } else if (ch === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2);
      if (i < 0) return -1;
      i++;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']' && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/** Các mục của mảng CHANGELOG trong mã nguồn ChangelogSettings.tsx; [] nếu không đọc được. */
function extractChangelog(source) {
  const match = ARRAY_START.exec(String(source));
  if (!match) return [];
  const open = match.index + match[0].length - 1;
  const close = findArrayEnd(source, open);
  if (close < 0) return [];
  try {
    // Mảng chỉ gồm đối tượng, mảng và chuỗi: chạy trong ngữ cảnh trống, không có require hay biến toàn cục.
    const entries = vm.runInNewContext(`(${source.slice(open, close + 1)})`, Object.create(null), { timeout: 2000 });
    return Array.isArray(entries) ? entries.filter((e) => e && typeof e.version === 'string') : [];
  } catch {
    return [];
  }
}

const bullets = (items) => items.filter((item) => typeof item === 'string' && item.trim()).map((item) => `- ${item.trim()}`);

/** Một mục CHANGELOG ở dạng Markdown cho trang Releases. */
function renderReleaseNotes(entry) {
  const lines = [`## MaiHub ${entry.version}`, ''];
  const highlights = bullets(Array.isArray(entry.highlights) ? entry.highlights : []);
  if (highlights.length) lines.push('**Điểm nổi bật**', ...highlights, '');
  const changes = Array.isArray(entry.changes) ? entry.changes : [];
  for (const [category, label] of CATEGORY_LABELS) {
    const items = bullets(changes.filter((c) => c && c.category === category).flatMap((c) => (Array.isArray(c.items) ? c.items : [])));
    if (items.length) lines.push(`### ${label}`, ...items, '');
  }
  return lines.join('\n');
}

/** Ghi chú của một phiên bản (nhận cả dạng tag `v1.2.3`). Không có mục thì trả một dòng báo rõ, không ném lỗi. */
function releaseNotesFor(source, versionOrTag) {
  const version = String(versionOrTag || '').replace(/^v/, '');
  const entry = extractChangelog(source).find((e) => e.version === version);
  return entry ? renderReleaseNotes(entry) : `## MaiHub ${version}\n\nPhiên bản này chưa có ghi chú trong Log phiên bản của app.\n`;
}

module.exports = { extractChangelog, renderReleaseNotes, releaseNotesFor };

if (require.main === module) {
  const [versionOrTag, repoRoot = path.resolve(__dirname, '..')] = process.argv.slice(2);
  if (!versionOrTag) {
    console.error('Usage: node scripts/release-notes.js <version|tag> [repoRoot]');
    process.exit(2);
  }
  let source = '';
  try { source = fs.readFileSync(path.join(repoRoot, CHANGELOG_FILE), 'utf8'); } catch { /* thiếu tệp: in dòng "chưa có ghi chú" */ }
  process.stdout.write(releaseNotesFor(source, versionOrTag));
}
