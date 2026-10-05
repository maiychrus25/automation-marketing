import { orderAccountsWithChildren } from '../../ui/lib/accountTree';

const a = (zalo_id: string, parent_zalo_id: string | null = null) => ({ zalo_id, parent_zalo_id });
const ids = (list: Array<{ zalo_id: string }>) => list.map((x) => x.zalo_id);

describe('orderAccountsWithChildren', () => {
  it('đưa Page con ngay sau tài khoản cha, giữ thứ tự xuất hiện', () => {
    const list = [a('p1'), a('zalo'), a('page2', 'p1'), a('p2'), a('page1', 'p1'), a('page3', 'p2')];
    expect(ids(orderAccountsWithChildren(list))).toEqual(['p1', 'page2', 'page1', 'zalo', 'p2', 'page3']);
  });
  it('Page mồ côi (cha không có trong danh sách) giữ vị trí của nó', () => {
    expect(ids(orderAccountsWithChildren([a('x'), a('orphan', 'missing'), a('y')]))).toEqual(['x', 'orphan', 'y']);
  });
  it('không đổi danh sách không có Page', () => {
    const list = [a('z1'), a('z2'), a('z3')];
    expect(ids(orderAccountsWithChildren(list))).toEqual(['z1', 'z2', 'z3']);
  });
  it('quan hệ vòng hoặc lồng nhiều tầng không làm mất dòng nào', () => {
    const cyc = [a('m', 'n'), a('n', 'm'), a('k')];
    expect(ids(orderAccountsWithChildren(cyc)).sort()).toEqual(['k', 'm', 'n']);
    const deep = [a('root'), a('mid', 'root'), a('leaf', 'mid')];
    expect(ids(orderAccountsWithChildren(deep))).toEqual(['root', 'mid', 'leaf']);
  });
});
