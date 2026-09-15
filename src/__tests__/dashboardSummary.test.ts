import { filterDashboardAccounts, getDashboardSummary } from '../ui/components/dashboard/dashboardSummary';

describe('getDashboardSummary', () => {
  it('counts online and attention accounts without overlapping connection states', () => {
    expect(getDashboardSummary([
      { isOnline: true, isConnected: true, listenerActive: true },
      { isOnline: false, isConnected: true, listenerActive: true },
      { isOnline: false, isConnected: true, listenerActive: false },
      { isOnline: false, isConnected: false },
    ], 'local', false)).toEqual({
      total: 4,
      online: 1,
      attention: 2,
      workspaceLabel: 'Cục bộ',
    });
  });

  it('labels employee workspaces from persisted or active mode', () => {
    expect(getDashboardSummary([], 'remote', false).workspaceLabel).toBe('Nhân viên');
    expect(getDashboardSummary([], 'local', true).workspaceLabel).toBe('Nhân viên');
  });

  it('does not treat an empty numeric query as a phone match', () => {
    const accounts = [
      { full_name: 'Tư vấn tuyển sinh', zalo_id: '0901000001', phone: '0901000001' },
      { full_name: 'AHV Facebook', zalo_id: 'facebook-page' },
    ];

    expect(filterDashboardAccounts(accounts, 'AHV Facebook')).toEqual([accounts[1]]);
    expect(filterDashboardAccounts(accounts, '0901')).toEqual([accounts[0]]);
  });
});
