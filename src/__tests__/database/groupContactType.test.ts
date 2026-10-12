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
});
