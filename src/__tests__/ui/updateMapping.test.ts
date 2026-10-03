import { toStorePatch } from '../../ui/store/updateMapping';

const AVAILABLE = { status: 'available' as const, version: '26.11.0', notes: 'Ghi chú', url: 'https://x/v26.11.0', canInstall: true };

describe('toStorePatch', () => {
    test('có bản mới thì tự mở thông báo, kèm phiên bản, ghi chú, link và khả năng tự cài', () => {
        expect(toStorePatch(AVAILABLE, null)).toEqual({
            status: 'available', updateInfo: { version: '26.11.0', releaseNotes: 'Ghi chú' },
            canInstall: true, releaseUrl: 'https://x/v26.11.0', progress: null, error: null, showPopup: true,
        });
    });

    test('bản người dùng đã bấm Để sau thì không tự mở lại, nhưng vẫn giữ dữ liệu cho chấm báo ở Sidebar', () => {
        const patch = toStorePatch(AVAILABLE, '26.11.0');
        expect(patch.showPopup).toBe(false);
        expect(patch.updateInfo).toEqual({ version: '26.11.0', releaseNotes: 'Ghi chú' });
    });

    test('bản mới hơn bản đã bấm Để sau thì mở lại', () => {
        expect(toStorePatch(AVAILABLE, '26.10.5').showPopup).toBe(true);
    });

    test('idle và checking thì xoá thông tin bản mới và đóng thông báo', () => {
        for (const s of [{ status: 'idle' as const }, { status: 'checking' as const }]) {
            expect(toStorePatch(s, null)).toEqual({ status: 'idle', updateInfo: null, progress: null, error: null, showPopup: false });
        }
    });

    test('đang tải: tiến độ theo phần trăm, thông báo mở', () => {
        expect(toStorePatch({ status: 'downloading', version: '26.11.0', percent: 43 }, null)).toMatchObject({
            status: 'downloading', updateInfo: { version: '26.11.0' }, progress: { percent: 43 }, error: null, showPopup: true,
        });
    });

    test('đã tải xong: mở thông báo để người dùng khởi động lại', () => {
        expect(toStorePatch({ status: 'downloaded', version: '26.11.0' }, '26.11.0')).toMatchObject({
            status: 'downloaded', updateInfo: { version: '26.11.0' }, progress: null, showPopup: true,
        });
    });

    test('lỗi: hiện thông báo lỗi, giữ phiên bản nếu có', () => {
        expect(toStorePatch({ status: 'error', message: 'Không tải được bản cập nhật: x', version: '26.11.0' }, null)).toMatchObject({
            status: 'error', error: { message: 'Không tải được bản cập nhật: x' }, updateInfo: { version: '26.11.0' }, showPopup: true,
        });
        expect(toStorePatch({ status: 'error', message: 'm', version: null }, null).updateInfo).toBeNull();
    });
});
