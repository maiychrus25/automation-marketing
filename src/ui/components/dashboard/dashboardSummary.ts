type DashboardAccount = {
  isOnline?: boolean;
  isConnected?: boolean;
  listenerActive?: boolean;
};

type SearchableDashboardAccount = {
  full_name?: string;
  zalo_id: string;
  phone?: string;
};

type WorkspaceType = 'local' | 'remote' | undefined;

export function getDashboardSummary(
  accounts: DashboardAccount[],
  workspaceType: WorkspaceType,
  employeeMode = false,
) {
  return {
    total: accounts.length,
    online: accounts.filter(account => account.isOnline && account.listenerActive !== false).length,
    attention: accounts.filter(account => !account.isConnected || account.listenerActive === false).length,
    workspaceLabel: workspaceType === 'remote' || employeeMode ? 'Nhân viên' : 'Cục bộ',
  };
}

export function filterDashboardAccounts<T extends SearchableDashboardAccount>(accounts: T[], search: string): T[] {
  const query = search.trim().toLowerCase();
  if (!query) return accounts;

  const phoneQuery = query.replace(/\D/g, '');
  return accounts.filter(account =>
    (account.full_name || '').toLowerCase().includes(query)
    || account.zalo_id.toLowerCase().includes(query)
    || Boolean(phoneQuery && (account.phone || '').replace(/\D/g, '').includes(phoneQuery))
    || (account.phone || '').toLowerCase().includes(query)
  );
}
