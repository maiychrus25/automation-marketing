import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-fb-unread-create-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));

jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
import DatabaseService from '../../services/database/DatabaseService';

const ACC = 'acc-unread-create';
const OWNER = 'fb-owner-unread';

describe('saveFBThreads unread_count applies on first insert only', () => {
  const db = DatabaseService.getInstance();
  const row = (id: string) => ({ id, account_id: ACC, name: 'N', type: 'user', unread_count: 0, participant_count: 2 });
  const counts = (id: string) => ({
    thread: db.queryOne<any>('SELECT unread_count FROM fb_threads WHERE id=? AND account_id=?', [id, ACC])!.unread_count,
    contact: db.queryOne<any>("SELECT unread_count FROM contacts WHERE owner_zalo_id=? AND contact_id=? AND channel='facebook'", [OWNER, id])!.unread_count,
  });

  beforeAll(async () => {
    await db.initialize();
    db.saveFBAccount({ id: ACC, facebook_id: OWNER, name: 'Owner', avatar_url: '', cookie_encrypted: '', session_data: '', status: 'connected' });
  });
  afterAll(() => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('newRowGetsFacebookNumber', () => {
    db.saveFBThreads(ACC, [{ ...row('t-new'), unread_count: 5 }]);
    expect(counts('t-new')).toEqual({ thread: 5, contact: 5 });
  });

  test('existingRowKeepsLocalNumber', () => {
    db.saveFBThreads(ACC, [{ ...row('t-old'), unread_count: 1 }]);
    db.saveFBThreads(ACC, [{ ...row('t-old'), unread_count: 7 }]);
    expect(counts('t-old')).toEqual({ thread: 1, contact: 1 });
  });
});
