// Tiện ích kiểm thử cho HttpRelayService: dựng một http.Server gọi thẳng handleHttpRequest,
// với Electron, DB, EmployeeService và các handler đều là bản giả. Import tệp này TRƯỚC khi nạp HttpRelayService.
import * as http from 'http';
import type { AddressInfo } from 'net';
import type { AccountRow } from '../../services/http/employeeAccess';
import type { FbAccountRef } from '../../services/http/accountRows';

// Trạng thái dùng chung cho các bản giả (tên phải bắt đầu bằng "mock" để jest.mock cho phép tham chiếu).
const mockState: {
  employees: Array<{ id: string; assigned: string[]; modules: string[]; profiles?: string[] }>;
  browserProfiles: string[];
  accounts: any[];
  fbAccounts: Array<FbAccountRef & { id: string }>;
  connectedFacebook: Set<string>;
  handlerCalls: string[];
  lastEmployee: any;
  db: Record<string, any>;
  libraryUpload: any;
  ipcHandlers: Map<string, any>;
  mediaRoot: string;
  revoked: Set<string>;
  inactive: Set<string>;
  disconnected: string[];
  published: Array<{ channel: string; data: any; audience: any }>;
  owners: Map<string, unknown>;
  assistants: Map<string, { platform: string; baseUrl: string | null }>;
  savedAssistants: any[];
} = { employees: [], browserProfiles: [], accounts: [], fbAccounts: [], connectedFacebook: new Set<string>(), handlerCalls: [], lastEmployee: undefined, db: {}, libraryUpload: jest.fn(async () => ({ uuid: 'u1', thumb_path: null })), ipcHandlers: new Map(), mediaRoot: '', revoked: new Set(), inactive: new Set(), disconnected: [], published: [], owners: new Map(), assistants: new Map(), savedAssistants: [] };

jest.mock('electron', () => ({
  app: { getPath: () => '/tmp', quit: jest.fn() }, ipcMain: { handle: jest.fn(), _invokeHandlers: mockState.ipcHandlers }, BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false }, dialog: {},
}));
// Sổ handler IPC của zaloIpc để rỗng: lệnh proxy rơi vào ipcMain._invokeHandlers (bản giả của kiểm thử).
jest.mock('../../../electron/ipc/zaloIpc', () => ({ ipcHandlerRegistry: new Map() }));
// uuid là gói ESM mà Jest không nạp được; các handler thật được dùng ở đây không cần tới nó.
jest.mock('uuid', () => ({ v4: () => 'id' }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock('../../services/event/EventBroadcaster', () => ({ __esModule: true, default: { emit: jest.fn(), on: jest.fn(), off: jest.fn() } }));
jest.mock('../../utils/ConnectionManager', () => ({ __esModule: true, default: { isConnected: () => false, getAllConnections: () => new Map() } }));
// Kết nối Facebook khoá theo id nội bộ của fb_accounts; mockState.connectedFacebook liệt kê facebook_id đang nối.
jest.mock('../../utils/FacebookConnectionManager', () => ({ __esModule: true, default: { get: (uuid: string) => {
  const row = mockState.fbAccounts.find((fb) => fb.id === uuid);
  return row && mockState.connectedFacebook.has(String(row.facebook_id)) ? { isConnected: () => true } : null;
} } }));
jest.mock('../../services/tunnel/TunnelService', () => ({ __esModule: true, default: { getInstance: () => ({}) } }));
jest.mock('../../services/socket/SocketIOService', () => ({ __esModule: true, default: { getInstance: () => ({ attach: jest.fn(), disconnectEmployee: (id: string) => { mockState.disconnected.push(id); }, setAllowedAccountsResolver: jest.fn(), setModulePermissionResolver: jest.fn(), setAllowedProfilesResolver: jest.fn(), publish: (channel: string, data: any, audience: any) => { mockState.published.push({ channel, data, audience }); } }) } }));
jest.mock('../../services/ai/AIAssistantService', () => ({ __esModule: true, default: { getInstance: () => ({ chat: async () => ({}), getSuggestions: async () => [], getAssistant: (id: string) => mockState.assistants.get(id) ?? null, saveAssistant: (a: any) => { mockState.savedAssistants.push(a); return a.id || 'new'; } }) } }));
jest.mock('../../services/library/LibraryService', () => {
  return { __esModule: true, default: { getInstance: () => ({ upload: mockState.libraryUpload }) } };
});
// Media root of the boss: '' unless a test passes `mediaRoot` (a real temp folder); saveBuffer then writes for real.
jest.mock('../../services/file/FileStorageService', () => {
  const fs = jest.requireActual('fs');
  const path = jest.requireActual('path');
  const getAccountDir = (id: string) => {
    const dir = path.join(mockState.mediaRoot, id, '2026-01-01');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  return {
    __esModule: true,
    default: {
      getBaseDir: () => mockState.mediaRoot,
      getAccountDir,
      resolveAbsolutePath: (p: string) => p,
      saveBuffer: async (id: string, buf: Buffer, name: string) => {
        const target = path.join(getAccountDir(id), name);
        fs.writeFileSync(target, buf);
        return target;
      },
    },
  };
});
// The real WorkspaceManager reads the user's config; the relay then falls back to FileStorageService.getBaseDir().
jest.mock('../../utils/WorkspaceManager', () => ({ __esModule: true, default: { getInstance: () => ({ getWorkspaceById: () => null }) } }));

jest.mock('../../services/database/DatabaseService', () => {
  // Mọi phương thức không khai báo đều là jest.fn() trả undefined.
  const ownerLookup = (sql: string, params?: unknown[]) => {
    const match = /^SELECT \w+ AS owner FROM (\w+) WHERE \w+ = \?$/.exec(sql);
    const key = match ? `${match[1]}:${String(params?.[0])}` : '';
    return match && mockState.owners.has(key) ? { owner: mockState.owners.get(key) } : undefined;
  };
  const explicit: Record<string, any> = {
    getDbPath: () => '/tmp/relay-test.db',
    getAccounts: () => mockState.accounts.filter((a) => a.is_active === 1), // the real query: WHERE is_active = 1
    getFBAccounts: () => mockState.fbAccounts,
    getBrowserProfiles: () => mockState.browserProfiles.map((id) => ({ id })),
    getBrowserProfileIds: () => [...mockState.browserProfiles],
    getFBAccountByFacebookId: (facebookId: string) => mockState.fbAccounts.find((fb) => fb.facebook_id === facebookId),
    getSetting: jest.fn(() => null),
    getLocalLabels: jest.fn(() => []),
    getAllLocalQuickMessages: jest.fn(() => []),
    setSetting: jest.fn(),
    query: jest.fn(() => []),
    // Strict reads (access decisions): same shape as query/queryOne; a test that needs rows implements them.
    queryStrict: jest.fn(() => []),
    // Ownership lookups go through the strict reader: answer them from the same fake as queryOne.
    queryOneStrict: jest.fn((sql: string, params?: unknown[]) => ownerLookup(sql, params)),
    withDbPath: (_path: string, fn: () => any) => fn(),
    // Ownership lookups of recordOwnership.ts ("SELECT <col> AS owner FROM <table> WHERE <col> = ?"): answered from mockState.owners.
    queryOne: jest.fn((sql: string, params?: unknown[]) => ownerLookup(sql, params)),
    run: jest.fn(),
    withDbPathAsync: async (_path: string, fn: () => any) => fn(),
  };
  const db = new Proxy(explicit, { get: (target, prop: string) => (prop in target ? target[prop] : (target[prop] = jest.fn())) });
  mockState.db = db;
  return { __esModule: true, default: { getInstance: () => db } };
});

jest.mock('../../services/employee/EmployeeService', () => {
  const row = (id: string) => mockState.employees.find((e) => e.id === id);
  const service = {
    pinToCurrentDb: jest.fn(),
    validateToken: (token: string) => {
      const id = token.startsWith('tok-') ? token.slice(4) : '';
      if (!row(id)) return { valid: false, reason: 'invalid' };
      if (mockState.revoked.has(id)) return { valid: false, reason: 'revoked', employee_id: id };
      if (mockState.inactive.has(id)) return { valid: false, reason: 'inactive', employee_id: id };
      return { valid: true, employee_id: id, username: `user-${id}` };
    },
    // Đăng nhập giả: mật khẩu "good" thành công, mọi mật khẩu khác thất bại.
    authenticate: async (username: string, password: string) => {
      const id = username.toLowerCase().replace(/^user-/, '');
      const e = row(id);
      if (!e || password !== 'good') return { success: false, error: 'Mật khẩu không đúng' };
      mockState.revoked.delete(id);
      return { success: true, token: `tok-${id}`, employee: toEmployee(e) };
    },
    revokeEmployeeTokens: (id: string) => { mockState.revoked.add(id); },
    getAssignedAccounts: (id: string) => row(id)?.assigned ?? [],
    getAssignedProfiles: (id: string) => row(id)?.profiles ?? [],
    hasPermission: (id: string, module: string) => !!row(id)?.modules.includes(module),
    getEmployeeById: (id: string) => {
      const e = row(id);
      return e ? toEmployee(e) : null;
    },
    getEmployees: () => mockState.employees.map(toEmployee),
  };
  function toEmployee(e: { id: string; assigned: string[]; modules: string[] }) {
    return {
      employee_id: e.id, username: `user-${e.id}`, password_hash: 'hash', display_name: `Name ${e.id}`, avatar_url: '', role: 'employee',
      is_active: 1, assigned_accounts: e.assigned, permissions: e.modules.map((module) => ({ module, can_access: true })),
    };
  }
  return { __esModule: true, default: { getInstance: () => service } };
});

// Handler giả: ghi tên, trả { success: true, data: {} }. getIntegrations dùng bản thật để kiểm tra việc bỏ thông tin xác thực.
const REAL_REST_HANDLERS = new Set(['getBoot', 'getIntegrations', 'getAllQuickMessagesHandler', 'getLabels', 'getConversations', 'getMessages', 'getConversationsUpdates', 'getConversationById', 'getMessagesAround', 'getFileMessages', 'getMediaMessages', 'getMessageById', 'searchMessages', 'getMessagesByTypeHandler']);
const mockRecordingProxy = (realModule: () => any, realNames: ReadonlySet<string>) =>
  new Proxy({}, {
    get: (_t, name: string) => (...args: any[]) => {
      mockState.handlerCalls.push(name);
      mockState.lastEmployee = args[0];
      const res = args[1];
      if (realNames.has(name)) return realModule()[name](...args);
      if (res && typeof res.writeHead === 'function') { // handler tệp ghi thẳng vào response
        mockState.lastEmployee = args[2];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return undefined;
      }
      return { success: true, data: {} };
    },
  });
jest.mock('../../services/http/handlers/RestApiHandlers', () => ({
  __esModule: true,
  handlers: mockRecordingProxy(() => jest.requireActual('../../services/http/handlers/RestApiHandlers').handlers, REAL_REST_HANDLERS),
}));
jest.mock('../../services/http/handlers/LibraryHandler', () => ({
  __esModule: true,
  libraryHandlers: mockRecordingProxy(() => jest.requireActual('../../services/http/handlers/LibraryHandler').libraryHandlers, new Set(['handleUpload', 'handleUploadJson'])),
}));

export interface RelayOptions {
  employees: Array<{ id: string; assigned: string[]; modules: string[]; profiles?: string[] }>;
  /** Ids of the rows of `browser_profiles` that exist on the boss machine. */
  browserProfiles?: string[];
  /** Rows of the `accounts` table: it has no parent_zalo_id column (a Page's parent lives in `fbAccounts`). */
  accounts: AccountRow[];
  /** Rows of `fb_accounts` (id is the internal UUID); a Page is an `accounts` row plus an fb_accounts row with parent_facebook_id. */
  fbAccounts?: Array<FbAccountRef & { id: string }>;
  /** facebook_id values that currently hold a live Facebook connection. */
  connectedFacebook?: string[];
  /** Real folder used as the boss media root (default: none). */
  mediaRoot?: string;
}

export interface RelayHarness {
  url: string;
  /** Same relay, but handed straight to handleRestApi: reaches routes the public dispatcher (handleHttpRequest) does not forward, e.g. DELETE/PATCH under /api/library. */
  restApiUrl: string;
  tokenFor(id: string): string;
  /** Marks the employee as disabled (validateToken then reports 'inactive'). */
  setInactive(id: string): void;
  /** Replaces the browser profiles assigned to an employee in the fake store. */
  setProfiles(id: string, profiles: string[]): void;
  /** Employee ids whose sockets were disconnected through SocketIOService.disconnectEmployee. */
  disconnected: string[];
  /** Events handed to SocketIOService.publish by the relay. */
  published: Array<{ channel: string; data: any; audience: any }>;
  handlerCalls: string[];
  lastEmployeeArg(): any;
  db: any;
  libraryUpload: any;
  /** Stored owner of a record for the ownership lookup: a table, an id, and the owner column value (account id, "a,b", ''). A record never set is "not found". */
  setOwner(table: string, id: string | number, owner: unknown): void;
  /** Registers a fake boss IPC handler for `channel` (ipcMain._invokeHandlers); returns its jest.fn. */
  registerIpcHandler(channel: string): jest.Mock;
  /** Stored AI assistant (platform + base URL) the relay compares a keep-the-key save against; saves that reach the service land in `savedAssistants`. */
  setAssistant(id: string, host: { platform: string; baseUrl: string | null }): void;
  savedAssistants: any[];
  close(): Promise<void>;
}

export async function startRelay(opts: RelayOptions): Promise<RelayHarness> {
  mockState.employees = opts.employees;
  mockState.browserProfiles = opts.browserProfiles ?? [];
  mockState.accounts = opts.accounts;
  mockState.fbAccounts = opts.fbAccounts ?? [];
  mockState.connectedFacebook = new Set(opts.connectedFacebook ?? []);
  mockState.mediaRoot = opts.mediaRoot ?? '';
  mockState.handlerCalls.length = 0;
  mockState.revoked.clear();
  mockState.inactive.clear();
  mockState.disconnected.length = 0;
  mockState.published.length = 0;
  mockState.owners.clear();
  mockState.assistants.clear();
  mockState.savedAssistants.length = 0;
  mockState.lastEmployee = undefined;
  Object.values(mockState.db).forEach((fn: any) => fn?.mockClear?.());
  mockState.libraryUpload?.mockClear();
  mockState.ipcHandlers.clear();

  const { default: HttpRelayService } = await import('../../services/http/HttpRelayService');
  const relay: any = HttpRelayService.getInstance();
  relay.employees.clear();
  relay.loginThrottle = new (jest.requireActual('../../services/employee/employeeTokenPolicy').LoginThrottle)();
  relay.invalidateAllowedAccounts?.();

  const server = http.createServer((req, res) => relay.handleHttpRequest(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const restApiServer = http.createServer((req, res) => relay.handleRestApi(req, res));
  await new Promise<void>((resolve) => restApiServer.listen(0, '127.0.0.1', resolve));
  const restApiPort = (restApiServer.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    restApiUrl: `http://127.0.0.1:${restApiPort}`,
    tokenFor: (id) => `tok-${id}`,
    setInactive: (id) => { mockState.inactive.add(id); },
    setProfiles: (id, profiles) => { const e = mockState.employees.find((x) => x.id === id); if (e) e.profiles = profiles; },
    disconnected: mockState.disconnected,
    published: mockState.published,
    handlerCalls: mockState.handlerCalls,
    lastEmployeeArg: () => mockState.lastEmployee,
    db: mockState.db,
    libraryUpload: mockState.libraryUpload,
    setOwner: (table, id, owner) => { mockState.owners.set(`${table}:${id}`, owner); },
    setAssistant: (id, host) => { mockState.assistants.set(id, host); },
    savedAssistants: mockState.savedAssistants,
    registerIpcHandler: (channel) => {
      const fn = jest.fn(async () => ({ success: true }));
      mockState.ipcHandlers.set(channel, fn);
      return fn;
    },
    close: () => Promise.all([server, restApiServer].map((s) => new Promise<void>((resolve) => { s.closeAllConnections?.(); s.close(() => resolve()); }))).then(() => undefined),
  };
}
