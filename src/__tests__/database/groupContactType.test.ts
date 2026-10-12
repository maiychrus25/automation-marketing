import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maihub-contact-type-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmpDir, quit: jest.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
}));

import DatabaseService from '../../services/database/DatabaseService';

const OWNER = 'owner1';
const GROUP = 'group1';

describe('group contact_type is kept as group', () => {
  const service = DatabaseService.getInstance();
  const contactType = (id: string): string | undefined =>
    service.queryOne<{ contact_type: string }>(
      'SELECT contact_type FROM contacts WHERE owner_zalo_id=? AND contact_id=?', [OWNER, id])?.contact_type;

  beforeAll(async () => { await service.initialize(); });
  afterAll(() => {
    service.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('new group saved by group-info fetch, then a group message, stays group', async () => {
    service.updateContactProfile(OWNER, GROUP, 'Group name', '', '', 'group');
    await service.saveMessage(OWNER, {
      type: 1, threadId: GROUP, isSelf: false,
      data: { msgId: 'm1', uidFrom: 'u1', ts: String(Date.now()), msgType: 'webchat', content: 'hi' },
    });
    expect(contactType(GROUP)).toBe('group');
  });

  test('a group row wrongly saved as user is corrected by an explicit group type', () => {
    service.updateContactProfile(OWNER, 'group2', 'G2', '', '', '');
    expect(contactType('group2')).toBe('user');
    service.updateContactProfile(OWNER, 'group2', 'G2', '', '', 'group');
    expect(contactType('group2')).toBe('group');
  });

  test('an empty contactType does not overwrite an existing type', () => {
    service.updateContactProfile(OWNER, 'group2', 'G2 renamed', '');
    expect(contactType('group2')).toBe('group');
  });

  describe('repairZaloGroupContactTypes', () => {
    const saveMsg = (threadId: string, type: number, msgId: string) =>
      service.saveMessage(OWNER, {
        type, threadId, isSelf: false,
        data: { msgId, uidFrom: 'u1', ts: String(Date.now()), msgType: 'webchat', content: 'hi' },
      });

    test('repairs a zalo group stored as user when it has group messages', async () => {
      service.updateContactProfile(OWNER, 'g3', 'G3', '', '', '');
      await saveMsg('g3', 1, 'rm1');
      service.run(`UPDATE contacts SET contact_type='user' WHERE owner_zalo_id=? AND contact_id='g3'`, [OWNER]);
      expect(contactType('g3')).toBe('user');
      expect(service.repairZaloGroupContactTypes()).toBe(1);
      expect(contactType('g3')).toBe('group');
    });

    test('leaves a 1:1 contact alone', async () => {
      service.updateContactProfile(OWNER, 'u9', 'U9', '', '', '');
      await saveMsg('u9', 0, 'rm2');
      service.repairZaloGroupContactTypes();
      expect(contactType('u9')).toBe('user');
    });

    test('leaves non-zalo channels alone', async () => {
      service.updateContactProfile(OWNER, 'fb1', 'FB1', '', '', '');
      await saveMsg('fb1', 1, 'rm3');
      service.run(`UPDATE contacts SET contact_type='user', channel='facebook' WHERE owner_zalo_id=? AND contact_id='fb1'`, [OWNER]);
      service.repairZaloGroupContactTypes();
      expect(contactType('fb1')).toBe('user');
    });

    test('is idempotent', async () => {
      service.updateContactProfile(OWNER, 'g4', 'G4', '', '', '');
      await saveMsg('g4', 1, 'rm4');
      service.run(`UPDATE contacts SET contact_type='user' WHERE owner_zalo_id=? AND contact_id='g4'`, [OWNER]);
      expect(service.repairZaloGroupContactTypes()).toBe(1);
      expect(service.repairZaloGroupContactTypes()).toBe(0);
    });
  });
});
