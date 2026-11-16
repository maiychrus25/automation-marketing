import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractChangelog, renderReleaseNotes, releaseNotesFor } = require('../../../scripts/release-notes.js');

const SOURCE = `
interface VersionEntry { version: string }
// ghi chú có dấu ] và ' trong chú thích
const CHANGELOG: VersionEntry[] = [
  {
    version: '9.9.1',
    date: '11/2026',
    type: 'minor',
    highlights: ['Điểm nổi bật có dấu ] và "nháy kép"', 'Dòng có \\'nháy đơn\\''],
    changes: [
      { category: 'new', items: ['Tính năng A', 'Tính năng B'] },
      { category: 'fixed', items: ['Sửa lỗi [x]; có dấu chấm phẩy'] },
      { category: 'security', items: [] },
    ],
  },
  { version: '9.9.0', date: '10/2026', type: 'patch', changes: [{ category: 'improved', items: ['Chỉ một dòng'] }] },
];

const TYPE_STYLES = { major: { label: 'Major' } };
`;

describe('release notes from the in-app changelog', () => {
  test('readsEveryEntryOfTheChangelogArray', () => {
    const entries = extractChangelog(SOURCE);
    expect(entries.map((e: any) => e.version)).toEqual(['9.9.1', '9.9.0']);
    expect(entries[0].highlights).toEqual(['Điểm nổi bật có dấu ] và "nháy kép"', "Dòng có 'nháy đơn'"]);
    expect(entries[0].changes[1]).toEqual({ category: 'fixed', items: ['Sửa lỗi [x]; có dấu chấm phẩy'] });
  });

  test('rendersHighlightsThenOneSectionPerCategoryWithTheAppLabels', () => {
    expect(renderReleaseNotes(extractChangelog(SOURCE)[0])).toBe([
      '## MaiHub 9.9.1',
      '',
      '**Điểm nổi bật**',
      '- Điểm nổi bật có dấu ] và "nháy kép"',
      "- Dòng có 'nháy đơn'",
      '',
      '### Tính năng mới',
      '- Tính năng A',
      '- Tính năng B',
      '',
      '### Sửa lỗi',
      '- Sửa lỗi [x]; có dấu chấm phẩy',
      '',
    ].join('\n'));
  });

  test('anEntryWithoutHighlightsStartsWithItsFirstSection', () => {
    expect(renderReleaseNotes(extractChangelog(SOURCE)[1])).toBe('## MaiHub 9.9.0\n\n### Cải thiện\n- Chỉ một dòng\n');
  });

  test('theVersionMayCarryTheTagPrefix', () => {
    expect(releaseNotesFor(SOURCE, 'v9.9.0')).toContain('## MaiHub 9.9.0');
    expect(releaseNotesFor(SOURCE, '9.9.1')).toContain('### Tính năng mới');
  });

  // Phát hành không được hỏng chỉ vì thiếu ghi chú: trả về một dòng nói rõ là chưa có.
  test('aVersionWithoutAnEntryGetsAPlainNoticeInsteadOfAnError', () => {
    expect(releaseNotesFor(SOURCE, 'v1.2.3')).toBe('## MaiHub 1.2.3\n\nPhiên bản này chưa có ghi chú trong Log phiên bản của app.\n');
    expect(releaseNotesFor('no changelog here', 'v1.2.3')).toContain('chưa có ghi chú');
  });

  // Quy trình phát hành: tăng version thì phải thêm mục vào Log phiên bản. Thiếu mục là ghi chú trên GitHub sẽ trống.
  test('theVersionInPackageJsonHasAnEntryInTheRealChangelog', () => {
    const root = path.resolve(__dirname, '../../..');
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const source = fs.readFileSync(path.join(root, 'src/ui/components/settings/ChangelogSettings.tsx'), 'utf8');
    const entries = extractChangelog(source);
    expect(entries.length).toBeGreaterThan(50);
    expect(entries[0].version).toBe(version);
    expect(releaseNotesFor(source, `v${version}`)).not.toContain('chưa có ghi chú');
  });
});
