import * as fs from 'fs';
import * as path from 'path';

// Lỗi tìm thấy 16/11/2026: các lần kiểm tra cookie trước khi kết nối (lúc mở app, khi bấm kết nối, khi cập nhật cookie) gọi
// Facebook không qua proxy của tài khoản, rồi kết nối thật lại đi qua proxy: một phiên đăng nhập xuất hiện từ hai địa chỉ
// mạng gần như cùng lúc. Mọi lời gọi tải trang chủ trong tệp IPC phải truyền proxy agent.
describe('cookie checks in facebookIpc go through the account proxy', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../../electron/ipc/facebookIpc.ts'), 'utf8');

  test.each(['initSession', 'fetchFBHomepage', 'checkCookieStateDetailed'])('%s_isNeverCalledWithTheCookieAlone', (fn) => {
    const withAgent = source.match(new RegExp(`\\b${fn}\\(\\w+,\\s*\\S`, 'g')) ?? [];
    const cookieAlone = source.match(new RegExp(`\\b${fn}\\(\\w+\\)`, 'g')) ?? [];
    expect(withAgent.length).toBeGreaterThan(0);
    expect(cookieAlone).toEqual([]);
  });
});
