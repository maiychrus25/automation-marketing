import { notificationDurationMs } from '../../ui/lib/notificationDuration';

describe('notificationDurationMs', () => {
  it('keeps the usual 4 seconds for short messages', () => {
    expect(notificationDurationMs('Đã cập nhật nhân viên')).toBe(4000);
    expect(notificationDurationMs('')).toBe(4000);
  });

  it('gives a long message more time, up to 12 seconds', () => {
    const pause = 'Đã cập nhật nhân viên. Đã tạm dừng 12 lịch đăng của Nguyễn Văn An. Bật lại trong Lịch đăng nếu bạn muốn giữ.';
    expect(notificationDurationMs(pause)).toBeGreaterThanOrEqual(6000);
    expect(notificationDurationMs(pause)).toBeLessThanOrEqual(12000);
    expect(notificationDurationMs('x'.repeat(5000))).toBe(12000);
  });
});
