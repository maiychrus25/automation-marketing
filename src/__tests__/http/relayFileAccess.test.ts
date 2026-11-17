import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { startRelay, RelayHarness } from './relayHarness';

// POST /api/command/erp/tasks calls the service directly (no recording handler): a fake that counts the saves.
const mockCreateTask = jest.fn(() => ({ id: 't-new' }));
jest.mock('../../services/erp/ErpTaskService', () => ({ __esModule: true, default: { getInstance: () => ({ createTask: mockCreateTask }) } }));

const ACCOUNTS: any[] = ['acc-a', 'acc-b'].map((id) => ({
  zalo_id: id, full_name: id, avatar_url: '', phone: '', is_business: 0, is_active: 1, channel: 'zalo', parent_zalo_id: null, cookies: 'S', imei: 'I', user_agent: 'UA',
}));
const ALL_MODULES = ['chat', 'crm'];

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

describe('boss file access through the relay', () => {
  let relay: RelayHarness;
  let tmp: string;
  let mediaRoot: string;

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-files-')));
    mediaRoot = path.join(tmp, 'media');
    fs.mkdirSync(path.join(mediaRoot, 'acc-a', '2026-01-01'), { recursive: true });
    fs.mkdirSync(path.join(mediaRoot, 'acc-b', '2026-01-01'), { recursive: true });
    fs.writeFileSync(path.join(mediaRoot, 'acc-a', '2026-01-01', 'a.png'), 'AAA');
    fs.writeFileSync(path.join(mediaRoot, 'acc-b', '2026-01-01', 'b.png'), 'BBB');
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'SECRET');
    fs.mkdirSync(path.join(mediaRoot, 'erp', 'tasks', 't1'), { recursive: true });
    fs.writeFileSync(path.join(mediaRoot, 'erp', 'tasks', 't1', 'doc.txt'), 'TASKDOC');
    fs.mkdirSync(path.join(mediaRoot, 'erp', 'other'), { recursive: true });
    fs.writeFileSync(path.join(mediaRoot, 'erp', 'other', 'x.txt'), 'NOTTASK');
    fs.mkdirSync(path.join(mediaRoot, '_uploads'), { recursive: true });
    fs.writeFileSync(path.join(mediaRoot, '_uploads', 'fresh.txt'), 'FRESH');
    relay = await startRelay({
      employees: [
        { id: 'emp-a', assigned: ['acc-a'], modules: ALL_MODULES },
        { id: 'emp-b', assigned: ['acc-b'], modules: ALL_MODULES },
        { id: 'emp-none', assigned: [], modules: ALL_MODULES },
        { id: 'emp-wf', assigned: ['acc-a'], modules: [...ALL_MODULES, 'workflow'] },
        { id: 'emp-two', assigned: ['acc-a', 'acc-b'], modules: ALL_MODULES },
        { id: 'emp-erp', assigned: ['acc-a'], modules: [...ALL_MODULES, 'erp'] },
      ],
      accounts: ACCOUNTS,
      mediaRoot,
    });
  });
  afterAll(async () => {
    await relay.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const upload = (emp: string | null, headers: Record<string, string>) =>
    fetch(`${relay.url}/api/media/upload`, {
      method: 'POST',
      headers: { ...(emp ? { Authorization: `Bearer ${relay.tokenFor(emp)}` } : {}), ...headers },
      body: Buffer.from('hello'),
    });
  const get = (url: string, emp: string | null) =>
    fetch(`${relay.url}${url}`, { headers: emp ? { Authorization: `Bearer ${relay.tokenFor(emp)}` } : {} });

  describe('upload', () => {
    test('aTraversalNameIsReducedToItsBaseNameInsideTheAccountFolder', async () => {
      const res = await upload('emp-a', { 'X-Filename': '../../evil.txt', 'X-Zalo-Id': 'acc-a' });
      expect(res.status).toBe(200);
      const { bossPath } = (await res.json()) as any;
      expect(path.basename(bossPath)).toBe('evil.txt');
      expect(bossPath.startsWith(path.join(mediaRoot, 'acc-a') + path.sep)).toBe(true);
      expect(fs.existsSync(path.join(tmp, 'evil.txt'))).toBe(false);
      expect(fs.existsSync(path.join(mediaRoot, 'evil.txt'))).toBe(false);
    });

    test('aBackslashPathKeepsOnlyTheFileName', async () => {
      const res = await upload('emp-a', { 'X-Filename': '..\\..\\win.txt', 'X-Zalo-Id': 'acc-a' });
      expect(res.status).toBe(200);
      expect(path.basename(((await res.json()) as any).bossPath)).toBe('win.txt');
    });

    test('noAccountIdHeaderUsesTheFirstAccountFolder', async () => {
      const res = await upload('emp-a', { 'X-Filename': '../../up.txt' });
      expect(res.status).toBe(200);
      expect(path.dirname(((await res.json()) as any).bossPath).startsWith(path.join(mediaRoot, 'acc-a'))).toBe(true);
    });

    test('anEmployeeWithoutAccountsWritesToUploadsWithACleanName', async () => {
      const res = await upload('emp-none', { 'X-Filename': '../../u.txt' });
      expect(res.status).toBe(200);
      const { bossPath } = (await res.json()) as any;
      expect(bossPath).toBe(path.join(mediaRoot, '_uploads', 'u.txt'));
    });

    test.each([
      ['a foreign account', 'acc-b'],
      ['a traversal id', '../x'],
      ['a comma list', 'acc-a,acc-b'],
    ])('refusesAndWritesNothing: %s', async (_n, id) => {
      const before = listFiles(tmp).length;
      const res = await upload('emp-a', { 'X-Filename': 'x.txt', 'X-Zalo-Id': id });
      expect(res.status).toBe(403);
      expect(listFiles(tmp).length).toBe(before);
      expect(fs.existsSync(path.join(tmp, 'x'))).toBe(false);
    });

    test('anEmptyOrListAccountIdHeaderOfAnEmployeeWithNoAccountsIsRefused', async () => {
      const before = listFiles(tmp).length;
      expect((await upload('emp-none', { 'X-Filename': 'x.txt', 'X-Zalo-Id': '' })).status).toBe(403);
      expect((await upload('emp-none', { 'X-Filename': 'x.txt', 'X-Zalo-Id': 'acc-a,acc-b' })).status).toBe(403);
      expect(listFiles(tmp).length).toBe(before);
    });

    test.each([['..'], ['.']])('anUnusableNameIs400AndWritesNothing: %s', async (name) => {
      const before = listFiles(tmp).length;
      const res = await upload('emp-a', { 'X-Filename': name, 'X-Zalo-Id': 'acc-a' });
      expect(res.status).toBe(400);
      expect(listFiles(tmp).length).toBe(before);
    });

    test('aSymlinkAtTheTargetIsRefusedAndNothingOutsideIsTouched', async () => {
      const dir = path.join(mediaRoot, 'acc-b', '2026-01-01');
      fs.writeFileSync(path.join(tmp, 'victim.txt'), 'ORIGINAL');
      fs.symlinkSync(path.join(tmp, 'victim.txt'), path.join(dir, 'sym.txt'));
      const res = await upload('emp-b', { 'X-Filename': 'sym.txt', 'X-Zalo-Id': 'acc-b' });
      expect(res.status).toBe(403);
      expect(fs.readFileSync(path.join(tmp, 'victim.txt'), 'utf8')).toBe('ORIGINAL');
    });

    test('noTokenIs401', async () => {
      const res = await upload(null, { 'X-Filename': 'x.txt', 'X-Zalo-Id': 'acc-a' });
      expect(res.status).toBe(401);
    });
  });

  describe('media and library serving', () => {
    test('noTokenIs401', async () => {
      expect((await get('/api/media/acc-a/2026-01-01/a.png', null)).status).toBe(401);
      expect((await get('/api/library/file/abc-123', null)).status).toBe(401);
      expect((await get('/api/library/thumb/abc-123', null)).status).toBe(401);
    });
    test('anEmployeeWhoMayNotUseTheAccountIs403', async () => {
      expect((await get('/api/media/acc-a/2026-01-01/a.png', 'emp-b')).status).toBe(403);
      expect((await get('/api/media/acc-a/2026-01-01/a.png', 'emp-none')).status).toBe(403);
    });
    test('theRightEmployeeGetsTheFile', async () => {
      const res = await get('/api/media/acc-a/2026-01-01/a.png', 'emp-a');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('AAA');
    });
    test('thumbAndAvatarUrlsAreCheckedByTheirAccount', async () => {
      fs.mkdirSync(path.join(mediaRoot, 'avatar', 'acc-a'), { recursive: true });
      fs.writeFileSync(path.join(mediaRoot, 'avatar', 'acc-a', 'p.png'), 'AV');
      expect((await get('/api/media/avatar/acc-a/p.png', 'emp-a')).status).toBe(200);
      expect((await get('/api/media/avatar/acc-a/p.png', 'emp-b')).status).toBe(403);
    });
    test('dotDotCannotReachAnotherAccountOrAFileOutside', async () => {
      // fetch() would normalise the dots away, so send the raw request line.
      const raw = (urlPath: string) => new Promise<number>((resolve, reject) => {
        const { port } = new URL(relay.url);
        http.request({ host: '127.0.0.1', port, path: urlPath, headers: { Authorization: `Bearer ${relay.tokenFor('emp-a')}` } }, (r) => { r.resume(); resolve(r.statusCode || 0); }).on('error', reject).end();
      });
      expect(await raw('/api/media/acc-a/../acc-b/2026-01-01/b.png')).toBe(403);
      expect(await raw('/api/media/acc-a/../../secret.txt')).toBe(403);
    });
    test('aSymlinkOutOfTheMediaRootIsRefused', async () => {
      fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(mediaRoot, 'acc-a', 'link.txt'));
      expect((await get('/api/media/acc-a/link.txt', 'emp-a')).status).toBe(403);
    });
    test('aTaskAttachmentIsServedOnlyToAnEmployeeWithTheErpModule', async () => {
      expect((await get('/api/media/erp/tasks/t1/doc.txt', null)).status).toBe(401);
      expect((await get('/api/media/erp/tasks/t1/doc.txt', 'emp-a')).status).toBe(403);
      expect((await get('/api/media/erp/tasks/t1/doc.txt', 'emp-none')).status).toBe(403);
      const res = await get('/api/media/erp/tasks/t1/doc.txt', 'emp-erp');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('TASKDOC');
    });
    test('theErpExemptionStaysInsideErpTasksAndTheMediaRoot', async () => {
      expect((await get('/api/media/erp/other/x.txt', 'emp-erp')).status).toBe(403);
      const raw = (urlPath: string) => new Promise<number>((resolve, reject) => {
        const { port } = new URL(relay.url);
        http.request({ host: '127.0.0.1', port, path: urlPath, headers: { Authorization: `Bearer ${relay.tokenFor('emp-erp')}` } }, (r) => { r.resume(); resolve(r.statusCode || 0); }).on('error', reject).end();
      });
      expect(await raw('/api/media/erp/tasks/../../../secret.txt')).toBe(403);
      expect(await raw('/api/media/erp/tasks/../../acc-b/2026-01-01/b.png')).toBe(403);
    });
    test('theExternalRouteNeverServesAFile', async () => {
      const target = encodeURIComponent(path.join(mediaRoot, 'acc-b', '2026-01-01', 'b.png'));
      expect((await get(`/api/media/external/${target}`, null)).status).toBe(401);
      const res = await get(`/api/media/external/${target}`, 'emp-two');
      expect([403, 404]).toContain(res.status);
      expect(await res.text()).not.toContain('BBB');
    });
  });

  describe('file paths in proxied commands', () => {
    const proxy = async (emp: string, channel: string, params: unknown) => {
      const res = await fetch(`${relay.url}/api/proxy/action`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${relay.tokenFor(emp)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, params }),
      });
      return (await res.json()) as any;
    };
    test.each([
      ['a system file', () => '/etc/hosts'],
      ['another account file', () => path.join(mediaRoot, 'acc-b', '2026-01-01', 'b.png')],
      ['a traversal out of the account folder', () => path.join(mediaRoot, 'acc-a', '..', '..', 'secret.txt')],
    ])('isRefusedAndTheHandlerDoesNotRun: %s', async (_n, filePath) => {
      const handler = relay.registerIpcHandler('zalo:sendFile');
      const body = await proxy('emp-a', 'zalo:sendFile', { zaloId: 'acc-a', threadId: 't', filePath: filePath() });
      expect(body.success).toBe(false);
      expect(handler).not.toHaveBeenCalled();
    });
    test('anOwnAccountFileStillWorks', async () => {
      const handler = relay.registerIpcHandler('zalo:sendFile');
      const body = await proxy('emp-a', 'zalo:sendFile', { zaloId: 'acc-a', threadId: 't', filePath: path.join(mediaRoot, 'acc-a', '2026-01-01', 'a.png') });
      expect(body.success).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
    });
    test('aNestedVideoPathIsRefusedAndTheHandlerDoesNotRun', async () => {
      const handler = relay.registerIpcHandler('zalo:sendVideo');
      const body = await proxy('emp-a', 'zalo:sendVideo', { zaloId: 'acc-a', threadId: 't', options: { videoPath: '/etc/hosts' } });
      expect(body.success).toBe(false);
      expect(handler).not.toHaveBeenCalled();
    });
    const template = (images: string[]) => ({ blocks: [{ id: 'b1', text: 'hi', images }] });
    test('aCampaignWithAForeignImagePathIsRefusedOnTheProxyAndNothingRuns', async () => {
      const handler = relay.registerIpcHandler('crm:saveCampaign');
      const body = await proxy('emp-a', 'crm:saveCampaign', { zaloId: 'acc-a', campaign: { name: 'c', template_message: template(['/etc/hosts']) } });
      expect(body.success).toBe(false);
      expect(handler).not.toHaveBeenCalled();
      const asText = await proxy('emp-a', 'crm:saveCampaign', { zaloId: 'acc-a', campaign: { name: 'c', template_message: JSON.stringify(template(['/etc/hosts'])) } });
      expect(asText.success).toBe(false);
      expect(handler).not.toHaveBeenCalled();
    });
    test('aCampaignWithAnOwnImagePathIsNotRefused', async () => {
      const handler = relay.registerIpcHandler('crm:saveCampaign');
      const own = path.join(mediaRoot, 'acc-a', '2026-01-01', 'a.png');
      const body = await proxy('emp-a', 'crm:saveCampaign', { zaloId: 'acc-a', campaign: { name: 'c', template_message: template([own]) } });
      expect(body.success).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
    });
    const command = (emp: string, pathname: string, body: unknown) =>
      fetch(`${relay.url}${pathname}`, { method: 'POST', headers: { Authorization: `Bearer ${relay.tokenFor(emp)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    test('postCommandCampaignsRefusesAForeignImagePathBeforeSaving', async () => {
      relay.db.saveCRMCampaign.mockClear();
      const res = await command('emp-a', '/api/command/crm/campaigns', { zaloId: 'acc-a', campaign: { name: 'c', template_message: JSON.stringify(template(['/etc/hosts'])) } });
      expect(res.status).toBe(403);
      expect(((await res.json()) as any).code).toBe('PATH_FORBIDDEN');
      expect(relay.db.saveCRMCampaign).not.toHaveBeenCalled();
      const other = await command('emp-a', '/api/command/crm/campaigns', { zaloId: 'acc-a', campaign: { name: 'c', template_message: template([path.join(mediaRoot, 'acc-b', '2026-01-01', 'b.png')]) } });
      expect(other.status).toBe(403);
      expect(((await other.json()) as any).code).toBe('ACCOUNT_FORBIDDEN');
      expect(relay.db.saveCRMCampaign).not.toHaveBeenCalled();
    });
    test('postCommandCampaignsAcceptsAnOwnImagePath', async () => {
      relay.db.saveCRMCampaign.mockClear();
      const own = path.join(mediaRoot, 'acc-a', '2026-01-01', 'a.png');
      const res = await command('emp-a', '/api/command/crm/campaigns', { zaloId: 'acc-a', campaign: { name: 'c', template_message: template([own]) } });
      expect(res.status).toBe(200);
      expect(relay.db.saveCRMCampaign).toHaveBeenCalledTimes(1);
    });
    describe('ERP task attachments (file_path)', () => {
      const save = (emp: string, file_path: string) => command(emp, '/api/command/erp/tasks', { title: 't', attachments: [{ file_name: 'f', file_path }] });
      const taskCalls = () => mockCreateTask.mock.calls;
      test('aBossPathOutsideTheAllowedFoldersIsRefusedAndNothingIsSaved', async () => {
        const before = taskCalls().length;
        for (const bad of ['/etc/hosts', path.join(tmp, 'secret.txt'), 'doc.txt', path.join(mediaRoot, 'acc-b', '2026-01-01', 'b.png')]) {
          const res = await save('emp-erp', bad);
          expect([bad, res.status]).toEqual([bad, 403]);
        }
        expect(((await (await save('emp-erp', '/etc/hosts')).json()) as any).code).toBe('PATH_FORBIDDEN');
        expect(taskCalls().length).toBe(before);
      });
      test('aFileTheEmployeeJustUploadedIsAccepted', async () => {
        const before = taskCalls().length;
        expect((await save('emp-erp', path.join(mediaRoot, '_uploads', 'fresh.txt'))).status).toBe(200);
        expect(taskCalls().length).toBe(before + 1);
      });
      test('anExistingTaskAttachmentIsAcceptedOnlyWithTheErpModule', async () => {
        const existing = path.join(mediaRoot, 'erp', 'tasks', 't1', 'doc.txt');
        const before = taskCalls().length;
        expect((await save('emp-erp', existing)).status).toBe(200);
        expect(taskCalls().length).toBe(before + 1);
        // emp-a has no erp module: refused by the module check first, and nothing runs either way
        expect((await save('emp-a', existing)).status).toBe(403);
        expect(taskCalls().length).toBe(before + 1);
      });
      test('aFilePathInAProxiedCommandIsCheckedToo', async () => {
        const handler = relay.registerIpcHandler('crm:saveNote');
        const body = await proxy('emp-a', 'crm:saveNote', { zaloId: 'acc-a', attachments: [{ file_path: '/etc/hosts' }] });
        expect(body.success).toBe(false);
        expect(handler).not.toHaveBeenCalled();
      });
    });
    describe('workflow service-account key path', () => {
      const workflow = (extra: object = {}) => ({ id: 'w1', name: 'w', nodes: [{ id: 'n1', type: 'x', config: { ...extra } }], edges: [] });
      beforeEach(() => { relay.db.saveWorkflow.mockClear(); relay.db.getWorkflowById.mockReset(); });
      test('aNewWorkflowWithAPathIsRefusedAndNotSaved', async () => {
        relay.db.getWorkflowById.mockReturnValue(null);
        const res = await command('emp-wf', '/api/command/workflows', { workflow: workflow({ serviceAccountPath: '/etc/hosts' }) });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ success: false, error: 'Chỉ máy Boss đặt được tệp khoá dịch vụ cho workflow', code: 'PATH_FORBIDDEN' });
        expect(relay.db.saveWorkflow).not.toHaveBeenCalled();
      });
      test('aChangedPathIsRefused', async () => {
        relay.db.getWorkflowById.mockReturnValue({ id: 'w1', nodes_json: JSON.stringify(workflow({ serviceAccountPath: '/k/a.json' }).nodes) });
        const res = await command('emp-wf', '/api/command/workflows', { workflow: workflow({ serviceAccountPath: '/etc/hosts' }) });
        expect(res.status).toBe(403);
        expect(relay.db.saveWorkflow).not.toHaveBeenCalled();
      });
      test('keepingTheStoredPathStillSaves', async () => {
        relay.db.getWorkflowById.mockReturnValue({ id: 'w1', nodes_json: JSON.stringify(workflow({ serviceAccountPath: '/k/a.json' }).nodes) });
        const res = await command('emp-wf', '/api/command/workflows', { workflow: workflow({ serviceAccountPath: '/k/a.json' }) });
        expect(res.status).toBe(200);
        expect(relay.db.saveWorkflow).toHaveBeenCalledTimes(1);
      });
      test('aWorkflowWithoutAPathSaves', async () => {
        relay.db.getWorkflowById.mockReturnValue(null);
        const res = await command('emp-wf', '/api/command/workflows', { workflow: workflow() });
        expect(res.status).toBe(200);
      });
    });
    test('oneBadEntryInFilePathsRefusesTheCommand', async () => {
      const handler = relay.registerIpcHandler('zalo:sendImages');
      const body = await proxy('emp-a', 'zalo:sendImages', { zaloId: 'acc-a', threadId: 't', filePaths: [path.join(mediaRoot, 'acc-a', '2026-01-01', 'a.png'), '/etc/hosts'] });
      expect(body.success).toBe(false);
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
