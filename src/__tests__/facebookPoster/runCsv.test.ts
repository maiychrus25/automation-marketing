import { buildRunCsv, csvField } from '../../services/facebookPoster/runCsv';

describe('csvField', () => {
  test('prefixes formula-like cells with a quote', () => {
    for (const v of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx']) expect(csvField(v)).toBe(`"'${v}"`);
  });
  test('leaves normal cells alone and doubles inner quotes', () => {
    expect(csvField('Nhóm A')).toBe('"Nhóm A"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('a=b')).toBe('"a=b"');
    expect(csvField(null)).toBe('""');
  });
});

test('buildRunCsv: BOM, CRLF, 9 columns, injection neutralised', () => {
  const csv = buildRunCsv([{
    id: 1, runId: 'r', profileId: 'p', profileName: '=cmd', targetUrl: 'https://www.facebook.com/groups/1/', targetName: 'G',
    outcome: 'posted', error: '', postUrl: null, commentStatus: 'not_requested', identity: '@me', createdAt: 0,
  } as any]);
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  const lines = csv.slice(1).split('\r\n');
  expect(lines).toHaveLength(3);
  expect(lines[0].split('","')).toHaveLength(9);
  expect(lines[1]).toContain(`"'=cmd"`);
  expect(lines[1]).toContain(`"'@me"`);
  expect(lines[1]).toContain('1970-01-01T00:00:00.000Z');
});
