import { groupAssignableAccounts, assignableAccountIds } from '../../ui/lib/employeeAssignableAccounts';

const accounts = [
  { zalo_id: 'fb-personal', channel: 'facebook', parent_zalo_id: null },
  { zalo_id: 'tg-bot', channel: 'telegram_bot' },
  { zalo_id: 'page-1', channel: 'facebook', parent_zalo_id: 'fb-personal' },
  { zalo_id: 'acc-a', channel: 'zalo' },
  { zalo_id: 'tg-user', channel: 'telegram_user' },
  { zalo_id: 'old-zalo' },
  { zalo_id: 'odd', channel: 'something_new' },
];

describe('employeeAssignableAccounts', () => {
  it('groups accounts in the fixed order with labels', () => {
    const groups = groupAssignableAccounts(accounts);
    expect(groups.map((g) => g.key)).toEqual(['zalo', 'facebook_page', 'telegram', 'facebook_personal']);
    expect(groups.map((g) => g.label)).toEqual(['Zalo', 'Page Facebook', 'Telegram', 'Facebook cá nhân']);
    expect(groups[1].accounts.map((a) => a.zalo_id)).toEqual(['page-1']);
    expect(groups[3].accounts.map((a) => a.zalo_id)).toEqual(['fb-personal']);
  });

  it('puts both telegram kinds in telegram', () => {
    const tg = groupAssignableAccounts(accounts).find((g) => g.key === 'telegram')!;
    expect(tg.accounts.map((a) => a.zalo_id)).toEqual(['tg-bot', 'tg-user']);
  });

  it('puts unknown or missing channel in zalo', () => {
    const zalo = groupAssignableAccounts(accounts).find((g) => g.key === 'zalo')!;
    expect(zalo.accounts.map((a) => a.zalo_id)).toEqual(['acc-a', 'old-zalo', 'odd']);
    expect(zalo.assignable).toBe(true);
  });

  it('locks personal facebook with a note and drops empty groups', () => {
    const groups = groupAssignableAccounts(accounts);
    const personal = groups[3];
    expect(personal.assignable).toBe(false);
    expect(personal.note).toBe('Chưa mở cho nhân viên');
    expect(groupAssignableAccounts([{ zalo_id: 'acc-a' }]).map((g) => g.key)).toEqual(['zalo']);
  });

  it('assignableAccountIds excludes personal facebook', () => {
    const ids = assignableAccountIds(accounts);
    expect(ids).not.toContain('fb-personal');
    expect(ids.sort()).toEqual(['acc-a', 'odd', 'old-zalo', 'page-1', 'tg-bot', 'tg-user']);
  });
});
