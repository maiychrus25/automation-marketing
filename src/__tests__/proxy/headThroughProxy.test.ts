import { isProxyProbeOk } from '../../utils/ProxyHelper';

describe('isProxyProbeOk', () => {
  // Lỗi thật 16/11/2026: máy chủ proxy từ chối mọi kết nối bằng mã 403, và thư viện proxy đưa mã đó về như phản hồi của
  // trang đích. Coi "có phản hồi" là thành công làm nút Test báo proxy hỏng là "OK" và app cho gán nó cho tài khoản.
  test.each([403, 407, 429, 500, 502, 0])('status_%i_isNotAWorkingProxy', (status) => {
    expect(isProxyProbeOk(status)).toBe(false);
  });

  test.each([200, 204, 301, 302])('status_%i_isAWorkingProxy', (status) => {
    expect(isProxyProbeOk(status)).toBe(true);
  });
});
