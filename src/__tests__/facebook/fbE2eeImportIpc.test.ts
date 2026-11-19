const handlers = new Map<string, (...a: any[]) => Promise<any>>();
const showOpenDialog = jest.fn();
jest.mock('electron', () => ({ ipcMain: { handle: (ch: string, fn: any) => handlers.set(ch, fn) }, dialog: { showOpenDialog: (...a: any[]) => showOpenDialog(...a) } }));
jest.mock('../../services/http/HttpConnectionManager', () => ({ __esModule: true, default: { getInstance: () => ({ isConnected: () => true, proxyAction: jest.fn() }) } }));
const logInfo = jest.fn();
const logWarn = jest.fn();
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { error: jest.fn(), log: jest.fn(), warn: (...a: any[]) => logWarn(...a), info: (...a: any[]) => logInfo(...a) } }));
jest.mock('../../utils/WorkspaceManager', () => ({ __esModule: true, default: { getInstance: () => ({ getActiveWorkspace: () => ({ type: 'local' }) }) } }));
jest.mock('../../services/facebook/FacebookHistorySyncService', () => ({ __esModule: true, default: { getInstance: () => ({}) } }));
jest.mock('../../../electron/ipc/facebookIpc', () => ({ resolveInternalId: (id: string) => `internal-${id}`, getFBServiceOrReconnect: jest.fn() }));
jest.mock('../../utils/FacebookConnectionManager', () => ({ __esModule: true, default: { get: jest.fn() } }));
const getFBAccount = jest.fn();
jest.mock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => ({ getFBAccount: (id: string) => getFBAccount(id) }) } }));
const importFile = jest.fn();
jest.mock('../../services/facebook/e2eeExport/FacebookE2eeExportImporter', () => ({
  FacebookE2eeExportImporter: jest.fn().mockImplementation(() => ({ importFile: (p: string) => importFile(p) })),
}));
import { registerFbHistoryIpc } from '../../../electron/ipc/fbHistoryIpc';
import { ExportLimitError } from '../../services/facebook/e2eeExport/exportArchive';

const call = (payload: any) => handlers.get('fb:importE2eeExport')!({}, payload);
const SECRET_PATH = '/Users/alice-example/Secret Name Example/hello-1.zip';
const summary = { chatsInFile: 3, chatsMatched: 2, chatsUnmatched: 1, messagesInFile: 13, imported: 8, alreadyPresent: 4, withoutSenderId: 1, mediaImported: 1, mediaSkipped: 1, malformedSkipped: 1 };

beforeAll(() => registerFbHistoryIpc());
beforeEach(() => {
  jest.clearAllMocks();
  getFBAccount.mockReturnValue({ id: 'internal-1', facebook_id: '1', parent_facebook_id: null });
  showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [SECRET_PATH] });
  importFile.mockResolvedValue(summary);
});

describe('fb:importE2eeExport', () => {
  it('imports the chosen file and returns counts only', async () => {
    expect(await call({ accountId: '1' })).toEqual({ success: true, summary });
    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ properties: ['openFile'], filters: [{ name: 'ZIP', extensions: ['zip'] }] }));
    expect(importFile).toHaveBeenCalledWith(SECRET_PATH);
  });

  it('refuses a relayed call without opening a dialog', async () => {
    expect(await call({ accountId: '1', _fromRelay: true })).toMatchObject({ success: false, code: 'BOSS_ONLY' });
    expect(showOpenDialog).not.toHaveBeenCalled();
    expect(importFile).not.toHaveBeenCalled();
  });

  it('ignores a path supplied by the renderer', async () => {
    await call({ accountId: '1', filePath: '/etc/passwd', path: '/etc/passwd' });
    expect(importFile).toHaveBeenCalledWith(SECRET_PATH);
  });

  it.each(['', 'a/b', '../x', undefined])('rejects bad account id %p', async (accountId) => {
    expect(await call({ accountId })).toMatchObject({ success: false });
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it('refuses a Facebook Page account and an unknown account', async () => {
    getFBAccount.mockReturnValue({ id: 'internal-1', facebook_id: '1', parent_facebook_id: '77' });
    expect(await call({ accountId: '1' })).toMatchObject({ success: false, error: 'PAGE_ACCOUNT' });
    getFBAccount.mockReturnValue(undefined);
    expect(await call({ accountId: '1' })).toMatchObject({ success: false });
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it('returns canceled when the dialog is dismissed', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await call({ accountId: '1' })).toEqual({ success: true, canceled: true });
    expect(importFile).not.toHaveBeenCalled();
  });

  it('refuses a second import for the same account while one runs, then allows again', async () => {
    let release!: (v: any) => void;
    importFile.mockReturnValueOnce(new Promise(r => { release = r; }));
    const first = call({ accountId: '1' });
    await new Promise(r => setImmediate(r));
    expect(await call({ accountId: '1' })).toMatchObject({ success: false, error: 'IMPORT_IN_PROGRESS' });
    release(summary);
    expect(await first).toMatchObject({ success: true });
    expect(await call({ accountId: '1' })).toMatchObject({ success: true });
  });

  it('maps limit errors and other failures to codes without leaking details', async () => {
    importFile.mockRejectedValueOnce(new ExportLimitError('Secret Name Example too big'));
    expect(await call({ accountId: '1' })).toEqual({ success: false, code: 'LIMIT', error: 'FILE_TOO_LARGE' });
    importFile.mockRejectedValueOnce(new Error(`bad entry ${SECRET_PATH}`));
    expect(await call({ accountId: '1' })).toEqual({ success: false, code: 'FAILED', error: 'IMPORT_FAILED' });
    importFile.mockRejectedValueOnce(Object.assign(new Error('entry Secret Name Example.json'), { code: 'EACCES' }));
    await call({ accountId: '1' });
    expect(String(logWarn.mock.calls[logWarn.mock.calls.length - 1][0])).toMatch(/failed: FAILED EACCES$/);
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain('Secret Name Example');
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain('alice-example');
  });

  it('logs exactly one info line with counts and none of the fixture names, texts or paths', async () => {
    await call({ accountId: '1' });
    expect(logInfo).toHaveBeenCalledTimes(1);
    const line = String(logInfo.mock.calls[0][0]);
    for (const [k, v] of Object.entries(summary)) expect(line).toContain(`${k}=${v}`);
    for (const secret of ['Secret Name Example', 'alice-example', 'hello-1', '.zip', 'internal-1']) expect(line).not.toContain(secret);
  });
});
