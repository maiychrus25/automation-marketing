import { parseCommentTime } from '../../services/facebookPoster/commentTime';

const NOW = new Date(2026, 9, 20, 15, 0, 0).getTime(); // 20/10/2026 15:00 giờ máy
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('parseCommentTime', () => {
    it('Vừa xong / Just now trả về đúng thời điểm thu', () => {
        expect(parseCommentTime('Vừa xong', NOW)).toBe(NOW);
        expect(parseCommentTime('Just now', NOW)).toBe(NOW);
    });
    it('phút', () => {
        expect(parseCommentTime('5 phút', NOW)).toBe(NOW - 5 * MIN);
        expect(parseCommentTime('5m', NOW)).toBe(NOW - 5 * MIN);
        expect(parseCommentTime('7 mins', NOW)).toBe(NOW - 7 * MIN);
    });
    it('giờ', () => {
        expect(parseCommentTime('2 giờ', NOW)).toBe(NOW - 2 * HOUR);
        expect(parseCommentTime('2 h', NOW)).toBe(NOW - 2 * HOUR);
        expect(parseCommentTime('2h', NOW)).toBe(NOW - 2 * HOUR);
        expect(parseCommentTime('3 hrs', NOW)).toBe(NOW - 3 * HOUR);
    });
    it('hôm qua, ngày, tuần', () => {
        expect(parseCommentTime('Hôm qua', NOW)).toBe(NOW - DAY);
        expect(parseCommentTime('Yesterday', NOW)).toBe(NOW - DAY);
        expect(parseCommentTime('3 ngày', NOW)).toBe(NOW - 3 * DAY);
        expect(parseCommentTime('3d', NOW)).toBe(NOW - 3 * DAY);
        expect(parseCommentTime('1 tuần', NOW)).toBe(NOW - 7 * DAY);
        expect(parseCommentTime('1w', NOW)).toBe(NOW - 7 * DAY);
    });
    it('ngày cụ thể trong năm hiện tại', () => {
        expect(parseCommentTime('12 tháng 10', NOW)).toBe(new Date(2026, 9, 12).getTime());
        expect(parseCommentTime('October 12', NOW)).toBe(new Date(2026, 9, 12).getTime());
    });
    it('ngày rơi vào tương lai thì lấy năm trước', () => {
        expect(parseCommentTime('25 tháng 12', NOW)).toBe(new Date(2025, 11, 25).getTime());
    });
    it('ngày có năm', () => {
        expect(parseCommentTime('12 tháng 10, 2025', NOW)).toBe(new Date(2025, 9, 12).getTime());
    });
    it('nhãn lạ hoặc rỗng trả null', () => {
        expect(parseCommentTime('', NOW)).toBeNull();
        expect(parseCommentTime('abc', NOW)).toBeNull();
        expect(parseCommentTime('3 tháng', NOW)).toBeNull();
        expect(parseCommentTime('31 tháng 2', NOW)).toBeNull();
    });
});
