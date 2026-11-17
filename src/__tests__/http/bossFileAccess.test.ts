import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkProxyFilePaths, checkServiceAccountPaths, isInside, mediaAccountOf, PROXY_FILE_PATH_FIELDS, safeUploadName, serviceAccountPathsOf } from '../../services/http/bossFileAccess';

describe('safeUploadName', () => {
  test.each([
    ['../../x.png', 'x.png'],
    ['C:\\Users\\a\\b.jpg', 'b.jpg'],
    ['/etc/passwd', 'passwd'],
    ['plain.txt', 'plain.txt'],
  ])('%s -> %s', (raw, out) => expect(safeUploadName(raw)).toBe(out));
  test.each([['..'], ['.'], [''], ['a\0b'], ['a'.repeat(300)], [undefined], [['a']]])('refuses %p', (raw) => {
    expect(safeUploadName(raw)).toBeNull();
  });
});

describe('isInside / mediaAccountOf', () => {
  test('aSiblingSharingThePrefixIsOutside', () => {
    expect(isInside('/m/media', '/m/media-x/a')).toBe(false);
    expect(isInside('/m/media', '/m/media/a')).toBe(true);
    expect(isInside('/m/media', '/m/media')).toBe(true);
  });
  test('accountIsTheFirstFolder', () => {
    expect(mediaAccountOf('/m/media', '/m/media/acc-a/2026/x.png')).toBe('acc-a');
    expect(mediaAccountOf('/m/media', '/m/media/thumb/acc-a/x.png')).toBe('acc-a');
    expect(mediaAccountOf('/m/media', '/m/media-x/acc-a/x.png')).toBeNull();
    expect(mediaAccountOf('/m/media', '/m/media')).toBeNull();
    expect(mediaAccountOf('/m/media', '/etc/passwd')).toBeNull();
  });
});

describe('checkProxyFilePaths', () => {
  const ctx = (realpath: (p: string) => string = (p) => p) => ({ mediaRoots: ['/m/media', '/n/media'], uploadsRoot: '/m/media/_uploads', allowed: ['acc-a'], realpath });
  test('ownAccountAndUploadsPass', () => {
    expect(checkProxyFilePaths({ filePath: '/m/media/acc-a/x.png' }, ctx())).toEqual({ ok: true });
    expect(checkProxyFilePaths({ filePath: '/m/media/_uploads/x.png' }, ctx())).toEqual({ ok: true });
    expect(checkProxyFilePaths({ text: 'hi' }, ctx())).toEqual({ ok: true });
  });
  test('anotherAccountIsRefused', () => {
    expect(checkProxyFilePaths({ videoPath: '/m/media/acc-b/x.mp4' }, ctx())).toEqual({ ok: false, code: 'ACCOUNT_FORBIDDEN' });
    expect(checkProxyFilePaths({ filePath: '/m/media/acc-a/../acc-b/x' }, ctx())).toEqual({ ok: false, code: 'ACCOUNT_FORBIDDEN' });
  });
  test.each([['/etc/passwd'], ['/m/media-x/acc-a/x'], ['relative/x.png'], [''], [5]])('outsideOrOddPathIsRefused: %p', (value) => {
    expect(checkProxyFilePaths({ filePath: value }, ctx())).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
  });
  test('aSymlinkPointingOutsideIsRefused', () => {
    const real = (p: string) => (p === '/m/media/acc-a/link' ? '/etc/passwd' : p);
    expect(checkProxyFilePaths({ filePath: '/m/media/acc-a/link' }, ctx(real))).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
  });
  test('aFileInTheSecondMediaRootNeedsAnAllowedAccountToo', () => {
    expect(checkProxyFilePaths({ filePath: '/n/media/acc-a/x.png' }, ctx())).toEqual({ ok: true });
    expect(checkProxyFilePaths({ filePath: '/n/media/acc-b/x.png' }, ctx())).toEqual({ ok: false, code: 'ACCOUNT_FORBIDDEN' });
  });
  test('nestedPathsAreCheckedAtAnyDepth', () => {
    expect(checkProxyFilePaths({ options: { videoPath: '/etc/hosts' } }, ctx())).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
    expect(checkProxyFilePaths({ options: { thumbPath: '/m/media/acc-b/t.jpg' } }, ctx())).toEqual({ ok: false, code: 'ACCOUNT_FORBIDDEN' });
    expect(checkProxyFilePaths({ a: [{ filePath: '/m/media/acc-a/x.png' }] }, ctx())).toEqual({ ok: true });
    expect(checkProxyFilePaths({ message: { attachments: [{ filePath: '/etc/hosts' }] } }, ctx())).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
    expect(checkProxyFilePaths({ x: { filePaths: ['/m/media/acc-a/x', '/etc/hosts'] } }, ctx())).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
    expect(checkProxyFilePaths({ options: { filePath: { x: 1 } } }, ctx())).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
    expect(checkProxyFilePaths({ options: { filePath: null, videoPath: undefined } }, ctx())).toEqual({ ok: true });
  });
  test('campaignImagesAreFilePathsAtAnyDepth', () => {
    const tm = (images: string[]) => ({ blocks: [{ id: '1', text: 'hi', images }] });
    expect(checkProxyFilePaths({ campaign: { template_message: tm(['/etc/hosts']) } }, ctx())).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
    expect(checkProxyFilePaths({ campaign: { template_message: tm(['/m/media/acc-b/x.png']) } }, ctx())).toEqual({ ok: false, code: 'ACCOUNT_FORBIDDEN' });
    expect(checkProxyFilePaths({ campaign: { template_message: tm(['https://example.com/x.png']) } }, ctx())).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
    expect(checkProxyFilePaths({ campaign: { template_message: tm(['/m/media/acc-a/x.png', '/m/media/_uploads/y.png']) } }, ctx())).toEqual({ ok: true });
    expect(checkProxyFilePaths({ images: ['/etc/hosts'] }, ctx())).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
  });
  test('templateMessageGivenAsJsonTextIsScanned', () => {
    const text = (images: string[]) => JSON.stringify({ blocks: [{ id: '1', text: 'hi', images }] });
    expect(checkProxyFilePaths({ campaign: { template_message: text(['/etc/hosts']) } }, ctx())).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
    expect(checkProxyFilePaths({ campaign: { template_message: text(['/m/media/acc-a/x.png']) } }, ctx())).toEqual({ ok: true });
    // plain text that does not parse is a message, not a template
    expect(checkProxyFilePaths({ campaign: { template_message: 'Xin chao {name}' } }, ctx())).toEqual({ ok: true });
  });
  test('tooDeepNestingDoesNotThrow', () => {
    let deep: any = { filePath: '/etc/hosts' };
    for (let i = 0; i < 20; i++) deep = { n: deep };
    expect(() => checkProxyFilePaths(deep, ctx())).not.toThrow();
  });
  test('aMissingFileIsRefused', () => {
    const real = () => { throw new Error('ENOENT'); };
    expect(checkProxyFilePaths({ filePath: '/m/media/acc-a/x' }, ctx(real))).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
  });
  test('oneBadEntryInFilePathsRefusesAll', () => {
    expect(checkProxyFilePaths({ filePaths: ['/m/media/acc-a/x', '/etc/passwd'] }, ctx())).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
    expect(checkProxyFilePaths({ filePaths: 'x' }, ctx())).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
    expect(checkProxyFilePaths({ filePaths: ['/m/media/acc-a/x'] }, ctx())).toEqual({ ok: true });
  });
  test('aRealSymlinkOutOfTheAccountFolderIsRefused', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bfa-')));
    try {
      fs.mkdirSync(path.join(tmp, 'media', 'acc-a'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'secret.txt'), 's');
      fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(tmp, 'media', 'acc-a', 'l.txt'));
      const res = checkProxyFilePaths({ filePath: path.join(tmp, 'media', 'acc-a', 'l.txt') }, { mediaRoots: [path.join(tmp, 'media')], uploadsRoot: path.join(tmp, 'media', '_uploads'), allowed: ['acc-a'], realpath: fs.realpathSync });
      expect(res).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('file_path of an ERP task attachment', () => {
  const ctx = (erp: boolean) => ({
    mediaRoots: ['/m/media'], uploadsRoot: '/m/media/_uploads', allowed: ['acc-a'], realpath: (p: string) => p,
    allowErpTaskFiles: erp, resolveStored: (p: string) => path.join('/m', p),
  });
  const save = (file_path: string) => ({ attachments: [{ file_name: 'x', file_path }] });
  test('anArbitraryBossPathIsRefused', () => {
    expect(checkProxyFilePaths(save('/etc/hosts'), ctx(true))).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
    expect(checkProxyFilePaths(save('x.png'), ctx(true))).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
  });
  test('anUploadOrAnOwnAccountFilePasses', () => {
    expect(checkProxyFilePaths(save('/m/media/_uploads/x.png'), ctx(false))).toEqual({ ok: true });
    expect(checkProxyFilePaths(save('/m/media/acc-a/2026/x.png'), ctx(false))).toEqual({ ok: true });
  });
  test('anExistingTaskAttachmentPassesOnlyForAnEmployeeWithTheErpModule', () => {
    expect(checkProxyFilePaths(save('/m/media/erp/tasks/t1/a.png'), ctx(true))).toEqual({ ok: true });
    expect(checkProxyFilePaths(save('media/erp/tasks/t1/a.png'), ctx(true))).toEqual({ ok: true }); // stored relative form
    expect(checkProxyFilePaths(save('/m/media/erp/tasks/t1/a.png'), ctx(false))).toEqual({ ok: false, code: 'ACCOUNT_FORBIDDEN' });
  });
  test('theTaskFolderExemptionIsNotAWayOut', () => {
    expect(checkProxyFilePaths(save('media/erp/tasks/../../../../etc/hosts'), ctx(true))).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
    expect(checkProxyFilePaths(save('/m/media/erp/tasks-x/a.png'), ctx(true))).toEqual({ ok: false, code: 'ACCOUNT_FORBIDDEN' });
    expect(checkProxyFilePaths(save('/m/media/erp/other/a.png'), ctx(true))).toEqual({ ok: false, code: 'ACCOUNT_FORBIDDEN' });
    // other path fields never get the exemption
    expect(checkProxyFilePaths({ filePath: '/m/media/erp/tasks/t1/a.png' }, ctx(true))).toEqual({ ok: false, code: 'ACCOUNT_FORBIDDEN' });
  });
});

describe('the path field list matches what the boss handlers read', () => {
  // Names matching /Paths?/ in zaloIpc.ts and proxyHelper.ts that are not a file on disk the boss would open.
  const NOT_FILE_PATH_NAMES = [
    'bossPaths',            // local variable holding the paths returned by the upload, not a param
    'bossPath',             // proxyHelper.ts: field of the upload result, not a param
    'path',                 // proxyHelper.ts: the node 'path' module
    'paths',                // word in a comment ("Boss-resolved paths")
    'resolveAbsolutePath',  // FileStorageService method name
  ];
  test('everyPathParamNameIsListedOrExplainedHere', () => {
    const names = new Set(['zaloIpc.ts', 'proxyHelper.ts'].flatMap((f) =>
      fs.readFileSync(path.join(__dirname, '../../../electron/ipc', f), 'utf8').match(/\b\w*[Pp]aths?\b/g) || []));
    const unknown = [...names].filter((n) => !PROXY_FILE_PATH_FIELDS.includes(n) && n !== 'filePaths' && !NOT_FILE_PATH_NAMES.includes(n));
    expect(unknown).toEqual([]);
  });
});

describe('every employee-side upload site is matched by a boss-side check', () => {
  // call site ("file: name(arguments)") -> what the boss validates for it. A new site fails this test
  // until someone decides how the boss checks the field it uploads.
  const COVERED_SITES: Record<string, string> = {
    'electron/ipc/proxyHelper.ts: uploadEmployeeMedia(filePaths: string[], zaloId?: string': 'definition, no field',
    'electron/ipc/proxyHelper.ts: prepareLocalFilesForProxy(params: any, accountId?: string': 'definition, no field',
    'electron/ipc/proxyHelper.ts: uploadEmployeeMedia([result[field]], accountId': 'PROXY_FILE_PATH_FIELDS (filePath, videoPath, thumbPath, voicePath, avatarPath, mediaPath)',
    'electron/ipc/proxyHelper.ts: uploadEmployeeMedia(result.filePaths, accountId': 'filePaths',
    'electron/ipc/proxyHelper.ts: prepareLocalFilesForProxy(params, params?.accountId': 'fb: proxy channels, same fields as above; boss checks via the proxy route',
    'electron/ipc/zaloIpc.ts: prepareLocalFilesForProxy(params': 'same fields as the sites above',
    'electron/ipc/crmIpc.ts: uploadEmployeeMedia(block.images, zaloId': 'images (template_message.blocks[].images, object or JSON text)',
  };
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  test('theSetOfUploadSitesIsExactlyTheTable', () => {
    const root = path.join(__dirname, '../../..');
    const found: string[] = [];
    for (const file of walk(path.join(root, 'electron')).filter((f) => f.endsWith('.ts'))) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
        for (const m of line.matchAll(/\b(uploadEmployeeMedia|prepareLocalFilesForProxy)\(([^)]*)/g)) found.push(`${path.relative(root, file)}: ${m[1]}(${m[2]}`);
      }
    }
    expect(found.sort()).toEqual(Object.keys(COVERED_SITES).sort());
  });
});

describe('service-account key path of a workflow', () => {
  const wf = (p?: string, nested = false) => ({ id: 'w1', nodes: [{ id: 'n1', config: nested ? { auth: { serviceAccountPath: p } } : { serviceAccountPath: p } }] });
  test('collectsNonEmptyValuesAtAnyDepthAndFromJsonText', () => {
    expect(serviceAccountPathsOf(wf('/k/a.json'))).toEqual(['/k/a.json']);
    expect(serviceAccountPathsOf(wf('/k/a.json', true))).toEqual(['/k/a.json']);
    expect(serviceAccountPathsOf({ id: 'w1', nodes_json: JSON.stringify(wf('/k/a.json').nodes) })).toEqual(['/k/a.json']);
    expect(serviceAccountPathsOf({ nodes: 'not json' })).toEqual([]);
    expect(serviceAccountPathsOf(wf(''))).toEqual([]);
    expect(serviceAccountPathsOf(wf(undefined))).toEqual([]);
  });
  test('aNewWorkflowWithAPathIsRefused', () => {
    expect(checkServiceAccountPaths(wf('/etc/hosts'), null)).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
  });
  test('anUnchangedPathIsAllowedEvenWhenStoredAsJsonText', () => {
    expect(checkServiceAccountPaths(wf('/k/a.json'), wf('/k/a.json'))).toEqual({ ok: true });
    expect(checkServiceAccountPaths(wf('/k/a.json', true), { nodes_json: JSON.stringify(wf('/k/a.json', true).nodes) })).toEqual({ ok: true });
  });
  test('aChangedOrAddedPathIsRefused', () => {
    expect(checkServiceAccountPaths(wf('/etc/hosts'), wf('/k/a.json'))).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
    expect(checkServiceAccountPaths(wf('/k/a.json'), wf(undefined))).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
    expect(checkServiceAccountPaths({ nodes: [...wf('/k/a.json').nodes, ...wf('/etc/hosts').nodes] }, wf('/k/a.json'))).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
  });
  test('aWorkflowNestedPastTheLimitIsRefusedEvenWithTheSamePathStored', () => {
    let deep: any = { serviceAccountPath: '/etc/hosts' };
    for (let i = 0; i < 10; i++) deep = { next: deep };
    expect(checkServiceAccountPaths({ id: 'w1', nodes: [deep] }, null)).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
    expect(checkServiceAccountPaths({ id: 'w1', nodes: [deep] }, { id: 'w1', nodes: [deep] })).toEqual({ ok: false, code: 'PATH_FORBIDDEN' });
  });
  test('aRemovedPathIsAllowed', () => {
    expect(checkServiceAccountPaths(wf(undefined), wf('/k/a.json'))).toEqual({ ok: true });
    expect(checkServiceAccountPaths(wf(''), wf('/k/a.json'))).toEqual({ ok: true });
  });
});
